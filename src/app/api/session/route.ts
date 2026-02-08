import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

export async function GET(req: Request) {
  return NextResponse.json({ authenticated: isAuthenticated(req) });
}
