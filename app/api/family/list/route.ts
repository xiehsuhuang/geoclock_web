import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。", connections: [] }, { status: 503 });
  }

  const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();
  if (!code) {
    return NextResponse.json({ ok: false, error: "缺少 code。", connections: [] }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("family_connections")
    .select("*")
    .or(`user_a_code.eq.${code},user_b_code.eq.${code}`)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message, connections: [] }, { status: 500 });
  }

  return NextResponse.json({ ok: true, connections: data ?? [] });
}
