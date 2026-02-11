import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { isAuthenticated } from "@/lib/auth";
import { isMaintenanceMode } from "@/lib/maintenance";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { BRAND_VIEWS } from "@/lib/config";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, requireServerConfig } from "@/lib/server-supabase";

const FILE_RE = /^MASTER_(PAN|ARENA|DAYBREAK|HEELCARE)_(\d{6})\.(csv|xlsx|xls)$/i;
const MASTER_UPLOAD_BUCKET = process.env.MASTER_UPLOAD_BUCKET || "master-upload-files";
const REQUIRED_HEADERS = [
  "BRAND",
  "GROUP",
  "PARENTS_SKU",
  "VARIATION_SKU",
  "ITEM_SKU",
  "DESCRIPTION",
  "BARCODE",
  "PRICELIST",
  "CBV",
  "VAT",
  "COST",
  "YEAR",
  "MONTH",
] as const;

type Row = Record<string, string | null>;
type Header = (typeof REQUIRED_HEADERS)[number];

function parseDateKey(ddmmyy: string) {
  const dd = Number(ddmmyy.slice(0, 2));
  const mm = Number(ddmmyy.slice(2, 4));
  const yy = Number(ddmmyy.slice(4, 6));
  if (!dd || !mm) return null;
  const yyyy = 2000 + yy;
  return `${String(yyyy).padStart(4, "0")}${String(mm).padStart(2, "0")}${String(dd).padStart(2, "0")}`;
}

function normalizeHeader(h: string) {
  const raw = h.replace(/^\uFEFF/, "").trim().toUpperCase();
  if (raw === "BEFORE VAT") return "CBV";
  return raw;
}

function toVal(v: unknown) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s;
}

function normalizeNumeric(v: string | null) {
  if (v === null) return null;
  return v.replace(/,/g, "");
}

async function extractRowsFromFile(file: File, brand: string) {
  const buf = Buffer.from(await file.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) throw new Error("Workbook has no sheets");
  const sheet = wb.Sheets[firstSheet];
  const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (!data.length) throw new Error("No data rows found");

  const first = data[0];
  const headerMap = new Map<string, string>();
  for (const k of Object.keys(first)) {
    headerMap.set(normalizeHeader(k), k);
  }
  const missing = REQUIRED_HEADERS.filter((h) => !headerMap.has(h));
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}`);

  const rows: Row[] = [];
  for (const raw of data) {
    const row: Row = {};
    for (const h of REQUIRED_HEADERS) {
      const source = headerMap.get(h)!;
      row[h] = toVal(raw[source]);
    }
    if (!row.BRAND) row.BRAND = brand;
    row.PRICELIST = normalizeNumeric(row.PRICELIST);
    row.CBV = normalizeNumeric(row.CBV);
    row.VAT = normalizeNumeric(row.VAT);
    row.COST = normalizeNumeric(row.COST);
    row.YEAR = normalizeNumeric(row.YEAR);
    row.MONTH = normalizeNumeric(row.MONTH);
    if (!row.ITEM_SKU || !row.VARIATION_SKU) continue;
    rows.push(row);
  }
  return rows;
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isMissingImportStateTableError(message: string) {
  const m = message.toLowerCase();
  return m.includes("master_import_state") && (m.includes("schema cache") || m.includes("could not find the table"));
}

function parseMissingColumn(message: string): Header | null {
  const direct = message.match(/column\s+[A-Za-z0-9_."-]+\.(\w+)\s+does not exist/i);
  const schemaCache = message.match(/Could not find the ['"](\w+)['"] column/i);
  const col = (direct?.[1] || schemaCache?.[1] || "").toUpperCase();
  return (REQUIRED_HEADERS as readonly string[]).includes(col) ? (col as Header) : null;
}

async function resolveWritableHeaders(supabase: any, viewTable: string) {
  const headers: Header[] = [...REQUIRED_HEADERS];
  while (true) {
    const selectCols = ["ITEM_SKU", ...headers.filter((h) => h !== "ITEM_SKU")];
    const { error } = await supabase
      .schema("public")
      .from(viewTable)
      .select(selectCols.join(","))
      .limit(1);

    if (!error) return headers;

    const missing = parseMissingColumn(error.message);
    if (!missing || missing === "ITEM_SKU") {
      throw new Error(error.message);
    }
    const idx = headers.indexOf(missing);
    if (idx === -1) {
      throw new Error(error.message);
    }
    headers.splice(idx, 1);
  }
}

function projectRowByHeaders(row: Row, headers: Header[]) {
  const out: Record<string, string | null> = {};
  for (const h of headers) {
    out[h] = row[h];
  }
  return out;
}

function changedColumnsByHeaders(existing: Record<string, unknown>, incoming: Row, headers: Header[]) {
  const patch: Record<string, unknown> = {};
  for (const h of headers) {
    if (h === "ITEM_SKU") continue;
    const a = existing[h];
    const b = incoming[h];
    const av = a === null || a === undefined || a === "" ? null : String(a);
    const bv = b === null || b === undefined || b === "" ? null : String(b);
    if (av !== bv) patch[h] = b;
  }
  return patch;
}

function sanitizeFilename(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function createMasterUploadBucket() {
  const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: MASTER_UPLOAD_BUCKET,
      name: MASTER_UPLOAD_BUCKET,
      public: false,
      file_size_limit: 52428800,
      allowed_mime_types: [
        "text/csv",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    if (!body.toLowerCase().includes("already")) {
      throw new Error(body || "Failed to create master upload bucket");
    }
  }
}

async function archiveUploadedFile(file: File, brand: string, dateKey: string) {
  const safe = sanitizeFilename(file.name);
  const storagePath = `${brand}/${dateKey}/${Date.now()}_${safe}`;
  const upload = async () =>
    fetch(`${SUPABASE_URL}/storage/v1/object/${MASTER_UPLOAD_BUCKET}/${storagePath}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "false",
      },
      body: file,
    });

  let res = await upload();
  if (res.ok) return { bucket: MASTER_UPLOAD_BUCKET, path: storagePath };

  const body = await res.text().catch(() => "");
  const msg = body.toLowerCase();
  const missingBucket =
    msg.includes("bucket not found") ||
    msg.includes("not found") ||
    msg.includes("does not exist");
  if (!missingBucket) {
    throw new Error(body || "Failed to archive uploaded file");
  }

  await createMasterUploadBucket();
  res = await upload();
  if (!res.ok) {
    const retryBody = await res.text().catch(() => "");
    throw new Error(retryBody || "Failed to archive uploaded file after bucket creation");
  }
  return { bucket: MASTER_UPLOAD_BUCKET, path: storagePath };
}

export async function POST(req: Request) {
  try {
    if (isMaintenanceMode()) {
      return NextResponse.json({ error: "Maintenance mode: master update is temporarily disabled." }, { status: 503 });
    }
    if (!isAuthenticated(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const ip = getClientIp(req);
    if (!checkRateLimit(`master-upload:${ip}`, 10, 60_000)) {
      return NextResponse.json({ error: "Too many requests. Try again in 1 minute." }, { status: 429 });
    }
    requireServerConfig();

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }

    const m = file.name.match(FILE_RE);
    if (!m) {
      return NextResponse.json({ error: "Filename must be MASTER_<BRAND>_DDMMYY.(csv|xlsx|xls)" }, { status: 400 });
    }

    const brand = m[1].toUpperCase();
    const dateKey = parseDateKey(m[2]);
    if (!dateKey) return NextResponse.json({ error: "Invalid date in filename" }, { status: 400 });
    const archive = await archiveUploadedFile(file, brand, dateKey);

    const tableView = BRAND_VIEWS[brand as keyof typeof BRAND_VIEWS];
    const viewTable = tableView.includes(".") ? tableView.split(".")[1] : tableView;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    let stateWarning: string | null = null;
    const { data: prevState, error: stateErr } = await supabase
      .from("master_import_state")
      .select("date_key,file_name")
      .eq("brand", brand)
      .maybeSingle();
    if (stateErr) {
      if (isMissingImportStateTableError(stateErr.message)) {
        stateWarning = "master_import_state table not found; version-skip check disabled for now.";
      } else {
        throw new Error(stateErr.message);
      }
    }
    if (prevState?.date_key && String(prevState.date_key) >= dateKey) {
      return NextResponse.json({
        ok: true,
        status: "skipped",
        brand,
        file: file.name,
        archive_bucket: archive.bucket,
        archive_path: archive.path,
        state_warning: stateWarning,
        reason: `File date ${dateKey} is not newer than last imported ${prevState.date_key}`,
      });
    }

    const writableHeaders = await resolveWritableHeaders(supabase, viewTable);
    const rows = await extractRowsFromFile(file, brand);
    const itemSkus = rows.map((r) => String(r.ITEM_SKU));
    const existing = new Map<string, Record<string, unknown>>();
    const selectCols = ["ITEM_SKU", ...writableHeaders.filter((h) => h !== "ITEM_SKU")];
    for (const skus of chunk(itemSkus, 500)) {
      const { data, error } = await supabase
        .schema("public")
        .from(viewTable)
        .select(selectCols.join(","))
        .in("ITEM_SKU", skus);
      if (error) throw new Error(error.message);
      for (const r of (data || []) as unknown[]) {
        if (!r || typeof r !== "object") continue;
        const rowObj = r as Record<string, unknown>;
        const key = rowObj.ITEM_SKU;
        if (key !== null && key !== undefined && key !== "") {
          existing.set(String(key), rowObj);
        }
      }
    }

    const toInsert: Row[] = [];
    const toUpdate: Array<{ itemSku: string; patch: Record<string, unknown> }> = [];
    let unchanged = 0;
    for (const row of rows) {
      const key = String(row.ITEM_SKU);
      const old = existing.get(key);
      if (!old) {
        toInsert.push(row);
      } else {
        const patch = changedColumnsByHeaders(old, row, writableHeaders);
        if (Object.keys(patch).length) toUpdate.push({ itemSku: key, patch });
        else unchanged += 1;
      }
    }

    for (const part of chunk(toInsert, 500)) {
      const projected = part.map((r) => projectRowByHeaders(r, writableHeaders));
      const { error } = await supabase.schema("public").from(viewTable).insert(projected);
      if (error) throw new Error(error.message);
    }
    for (const op of toUpdate) {
      const { error } = await supabase
        .schema("public")
        .from(viewTable)
        .update(op.patch)
        .eq("ITEM_SKU", op.itemSku);
      if (error) throw new Error(error.message);
    }

    const summary = {
      brand,
      file: file.name,
      status: "imported",
      total: rows.length,
      inserted: toInsert.length,
      updated: toUpdate.length,
      unchanged,
      dateKey,
      archive_bucket: archive.bucket,
      archive_path: archive.path,
    };

    const { error: upsertErr } = await supabase.from("master_import_state").upsert(
      {
        brand,
        date_key: dateKey,
        file_name: file.name,
        imported_at: new Date().toISOString(),
        row_count: rows.length,
        inserted: toInsert.length,
        updated: toUpdate.length,
        unchanged,
      },
      { onConflict: "brand" }
    );
    if (upsertErr) {
      if (isMissingImportStateTableError(upsertErr.message)) {
        stateWarning = stateWarning || "master_import_state table not found; import state was not saved.";
      } else {
        throw new Error(upsertErr.message);
      }
    }

    return NextResponse.json({ ok: true, ...summary, state_warning: stateWarning });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
