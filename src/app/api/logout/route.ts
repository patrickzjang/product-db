import { NextResponse } from "next/server";
import { getAuthCookieName } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: getAuthCookieName(),
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
