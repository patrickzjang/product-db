import { NextResponse } from "next/server";
import { BUCKET, SKU_COLUMN } from "@/lib/config";
import { isAuthenticated } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
  callUpdateProductImages,
  getTablesForBrand,
  requireServerConfig,
  supabaseRestGet,
} from "@/lib/server-supabase";

export async function POST(req: Request) {
  try {
    if (!isAuthenticated(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const ip = getClientIp(req);
    if (!checkRateLimit(`upload:${ip}`, 20, 60_000)) {
      return NextResponse.json({ error: "Too many upload requests. Please wait 1 minute." }, { status: 429 });
    }

    requireServerConfig();
    const form = await req.formData();
    const file = form.get("file");
    const sku = String(form.get("sku") || "").trim();
    const brand = String(form.get("brand") || "PAN").toUpperCase();

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    if (!sku) {
      return NextResponse.json({ error: "Missing SKU" }, { status: 400 });
    }
    const lower = file.name.toLowerCase();
    const isJpg = file.type === "image/jpeg" || lower.endsWith(".jpg") || lower.endsWith(".jpeg");
    if (!isJpg) {
      return NextResponse.json({ error: "Only JPG allowed" }, { status: 400 });
    }
    if (file.size > 2 * 1024 * 1024) {
      return NextResponse.json({ error: "Over 2MB" }, { status: 400 });
    }
    const idx = file.name.lastIndexOf("_");
    const baseSku = idx === -1 ? "" : file.name.slice(0, idx).trim();
    if (!baseSku || baseSku !== sku) {
      return NextResponse.json({ error: "Name must match SKU_*.jpg" }, { status: 400 });
    }

    const { viewTable } = getTablesForBrand(brand);
    const checkParams = new URLSearchParams();
    checkParams.set("select", SKU_COLUMN);
    checkParams.set(SKU_COLUMN, `eq.${sku}`);
    checkParams.set("limit", "1");
    const { data: checkRows } = await supabaseRestGet(viewTable, checkParams);
    if (!Array.isArray(checkRows) || checkRows.length === 0) {
      return NextResponse.json({ error: `SKU not found (${sku})` }, { status: 404 });
    }

    const path = `${brand}/${sku}/${file.name}`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": file.type || "image/jpeg",
        "x-upsert": "true",
      },
      body: file,
    });

    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => "");
      return NextResponse.json({ error: body || uploadRes.statusText }, { status: 400 });
    }

    await callUpdateProductImages({
      variationSku: sku,
      bucket: BUCKET,
      path,
      brand,
    });

    return NextResponse.json({ ok: true, path });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
