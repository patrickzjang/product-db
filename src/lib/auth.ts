import { createHash } from "crypto";

const AUTH_COOKIE = "jst_auth";
const MASTER_USERNAME = process.env.MASTER_USERNAME || "";
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || "";
const TOKEN = createHash("sha256")
  .update(`${MASTER_USERNAME}:${MASTER_PASSWORD}:v1`)
  .digest("hex");

function parseCookies(raw: string | null): Record<string, string> {
  if (!raw) return {};
  return raw.split(";").reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return acc;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

export function isValidLogin(username: string, password: string): boolean {
  return username === MASTER_USERNAME && password === MASTER_PASSWORD;
}

export function getAuthCookieName() {
  return AUTH_COOKIE;
}

export function getAuthCookieValue() {
  return TOKEN;
}

export function isAuthenticated(req: Request): boolean {
  const cookies = parseCookies(req.headers.get("cookie"));
  return cookies[AUTH_COOKIE] === TOKEN;
}
