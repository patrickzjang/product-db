export const SKU_COLUMN = "VARIATION_SKU";
export const VARIATION_COLUMN = "VARIATION_SKU";

export const BUCKET = "product-images";
export const MAX_BYTES = 2 * 1024 * 1024;

export const BRAND_VIEWS = {
  PAN: "public.master_pan_public",
  ARENA: "public.master_arena_public",
  DAYBREAK: "public.master_daybreak_public",
  HEELCARE: "public.master_heelcare_public",
} as const;

export const BRAND_VARIATION_VIEWS = {
  PAN: "public.master_pan_variations",
  ARENA: "public.master_arena_variations",
  DAYBREAK: "public.master_daybreak_variations",
  HEELCARE: "public.master_heelcare_variations",
} as const;
