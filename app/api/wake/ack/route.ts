import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ message: "尚未設定 Supabase，無法回應呼叫。" }, { status: 503 });
  }

  const payload = (await request.json()) as {
    wakeRequestId?: string;
    userCode?: string;
  };

  let query = supabase
    .from("wake_requests")
    .update({
      status: "acknowledged",
      acknowledged_at: new Date().toISOString()
    })
    .eq("status", "active");

  if (payload.wakeRequestId) {
    query = query.eq("id", payload.wakeRequestId);
  } else if (payload.userCode) {
    query = query.eq("to_owner_code", payload.userCode);
  } else {
    return NextResponse.json({ message: "缺少呼叫資料。" }, { status: 400 });
  }

  const { error } = await query;
  if (error) {
    return NextResponse.json({ message: "回應呼叫失敗。" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, status: "acknowledged" });
}
