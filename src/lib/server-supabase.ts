import { BRAND_VIEWS, BRAND_VARIATION_VIEWS, VARIATION_COLUMN } from "@/lib/config";

export type Brand = keyof typeof BRAND_VIEWS;

export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export function requireServerConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
}

export function getTablesForBrand(brand: string) {
  const key = (brand || "PAN").toUpperCase() as Brand;
  const viewName = BRAND_VIEWS[key] || BRAND_VIEWS.PAN;
  const variationView = BRAND_VARIATION_VIEWS[key] || BRAND_VARIATION_VIEWS.PAN;
  return {
    viewTable: viewName.includes(".") ? viewName.split(".")[1] : viewName,
    variationTable: variationView.includes(".") ? variationView.split(".")[1] : variationView,
  };
}

export function parseCount(header: string | null): number {
  if (!header) return 0;
  const parts = header.split("/");
  if (parts.length !== 2) return 0;
  const total = Number(parts[1]);
  return Number.isNaN(total) ? 0 : total;
}

export function encodeIlike(value: string) {
  return `${value}%`;
}

export function buildInFilter(values: string[]): string {
  const escaped = values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`);
  return `in.(${escaped.join(",")})`;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function supabaseRestGet(path: string, searchParams?: URLSearchParams) {
  const url = `${SUPABASE_URL}/rest/v1/${path}${searchParams ? `?${searchParams.toString()}` : ""}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "count=exact",
    },
    cache: "no-store",
  });

  const raw = await res.text();
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (!res.ok) throw new Error(raw);
      throw new Error("Unexpected non-JSON response from API");
    }
  }

  if (!res.ok) {
    const message = typeof data === "object" && data && "message" in data
      ? String((data as { message?: unknown }).message || res.statusText)
      : raw || res.statusText;
    throw new Error(message);
  }

  return { data, count: parseCount(res.headers.get("content-range")) };
}

export async function callUpdateProductImages(params: {
  variationSku: string;
  bucket: string;
  path: string;
  brand: string;
}) {
  const fnRes = await fetch(`${SUPABASE_URL}/functions/v1/update_product_images`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      variation_sku: params.variationSku,
      paths: [params.path],
      bucket: params.bucket,
      brand: params.brand,
    }),
  });

  if (!fnRes.ok) {
    const body = await fnRes.text().catch(() => "");
    throw new Error(body || "Edge Function returned a non-2xx status code");
  }
}

export function sortMasterRows(rows: Record<string, unknown>[]) {
  return rows.sort((a, b) => {
    const av = String(a[VARIATION_COLUMN] ?? "");
    const bv = String(b[VARIATION_COLUMN] ?? "");
    if (av !== bv) return av < bv ? -1 : 1;
    const ai = String(a.ITEM_SKU ?? "");
    const bi = String(b.ITEM_SKU ?? "");
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}
