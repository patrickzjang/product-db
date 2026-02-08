import { NextResponse } from "next/server";
import { getAuthCookieName, getAuthCookieValue, isValidLogin } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const ip = getClientIp(req);
  if (!checkRateLimit(`login:${ip}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many login attempts. Try again in 1 minute." }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const username = String(body?.username || "");
  const password = String(body?.password || "");

  if (!isValidLogin(username, password)) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: getAuthCookieName(),
    value: getAuthCookieValue(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return res;
}
