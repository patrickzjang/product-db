import { NextResponse } from "next/server";
import { VARIATION_COLUMN } from "@/lib/config";
import { isAuthenticated } from "@/lib/auth";
import { isMaintenanceMode } from "@/lib/maintenance";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  buildInFilter,
  chunkArray,
  encodeIlike,
  getTablesForBrand,
  requireServerConfig,
  sortMasterRows,
  supabaseRestGet,
} from "@/lib/server-supabase";

type SearchPayload = {
  brand?: string;
  query?: string;
  pageSize?: number;
  currentPage?: number;
};

export async function POST(req: Request) {
  try {
    if (isMaintenanceMode()) {
      return NextResponse.json({ error: "Maintenance mode: search is temporarily disabled." }, { status: 503 });
    }
    if (!isAuthenticated(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const ip = getClientIp(req);
    if (!checkRateLimit(`search:${ip}`, 120, 60_000)) {
      return NextResponse.json({ error: "Too many search requests. Please slow down." }, { status: 429 });
    }

    requireServerConfig();
    const body = (await req.json().catch(() => ({}))) as SearchPayload;
    const brand = String(body.brand || "PAN");
    const query = String(body.query || "").trim();
    const pageSize = Math.max(1, Math.min(1000, Number(body.pageSize) || 100));
    const currentPage = Math.max(1, Number(body.currentPage) || 1);
    const from = (currentPage - 1) * pageSize;

    const { variationTable, viewTable } = getTablesForBrand(brand);

    const vParams = new URLSearchParams();
    vParams.set("select", VARIATION_COLUMN);
    vParams.set("order", `${VARIATION_COLUMN}.asc`);
    vParams.set("limit", String(pageSize));
    vParams.set("offset", String(from));
    if (query) {
      vParams.set(VARIATION_COLUMN, `ilike.${encodeIlike(query)}`);
    }

    const { data: variations, count: total } = await supabaseRestGet(variationTable, vParams, { count: "planned" });
    const variationList = Array.isArray(variations)
      ? variations.map((r) => r?.[VARIATION_COLUMN]).filter(Boolean).map(String)
      : [];

    if (variationList.length === 0) {
      const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
      return NextResponse.json({ rows: [], total: total || 0, pageCount, shown: 0 });
    }

    const chunks = chunkArray(variationList, 250);
    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const pParams = new URLSearchParams();
        pParams.set("select", "*");
        pParams.set(VARIATION_COLUMN, buildInFilter(chunk));
        pParams.set("order", `${VARIATION_COLUMN}.asc`);
        const { data } = await supabaseRestGet(viewTable, pParams, { count: "none" });
        return Array.isArray(data) ? data : [];
      })
    );

    const rows = sortMasterRows(chunkResults.flat());
    const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
    return NextResponse.json({
      rows,
      total: total || 0,
      pageCount,
      shown: new Set(rows.map((r) => String(r[VARIATION_COLUMN]))).size,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
