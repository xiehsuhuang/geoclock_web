import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。", muted: false }, { status: 503 });
  }

  const url = new URL(request.url);
  const shareCode = url.searchParams.get("share_code")?.trim();
  const role = url.searchParams.get("role")?.trim();
  const userCode = url.searchParams.get("user_code")?.trim();
  const endpoint = url.searchParams.get("endpoint")?.trim();
  const eventType = url.searchParams.get("event_type")?.trim() || "all";

  if (!shareCode || (role !== "owner" && role !== "viewer")) {
    return NextResponse.json({ ok: false, error: "缺少 share_code 或 role。", muted: false }, { status: 400 });
  }

  let query = supabase
    .from("trip_notification_mutes")
    .select("muted")
    .eq("share_code", shareCode)
    .eq("role", role)
    .eq("event_type", eventType)
    .eq("muted", true);

  if (role === "owner") {
    if (!userCode) {
      return NextResponse.json({ ok: true, muted: false });
    }
    query = query.eq("user_code", userCode);
  } else if (endpoint) {
    query = query.eq("endpoint", endpoint);
  } else if (userCode) {
    query = query.eq("user_code", userCode);
  } else {
    return NextResponse.json({ ok: true, muted: false });
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message, muted: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true, muted: Boolean(data?.muted) });
}
