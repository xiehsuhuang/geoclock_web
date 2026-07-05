import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(request: Request) {
  if (!supabase) {
    return NextResponse.json({ message: "尚未設定 Supabase。" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ message: "缺少呼叫 ID。" }, { status: 400 });
  }

  const { data, error } = await supabase.from("wake_requests").select("id, status, acknowledged_at, stopped_at").eq("id", id).maybeSingle();
  if (error || !data) {
    return NextResponse.json({ message: "找不到呼叫紀錄。" }, { status: 404 });
  }

  return NextResponse.json(data);
}
