import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

type MuteTripPayload = {
  share_code?: string;
  role?: "owner" | "viewer";
  user_code?: string;
  endpoint?: string;
  event_type?: string;
};

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。" }, { status: 503 });
  }

  const payload = (await request.json()) as MuteTripPayload;
  const shareCode = payload.share_code?.trim();
  const role = payload.role;
  const eventType = payload.event_type?.trim() || "all";
  const userCode = payload.user_code?.trim() || null;
  const endpoint = payload.endpoint?.trim() || null;

  if (!shareCode || (role !== "owner" && role !== "viewer")) {
    return NextResponse.json({ ok: false, error: "缺少 share_code 或 role。" }, { status: 400 });
  }
  if (role === "owner" && !userCode) {
    return NextResponse.json({ ok: false, error: "owner 停止通知需要 user_code。" }, { status: 400 });
  }
  if (role === "viewer" && !endpoint && !userCode) {
    return NextResponse.json({ ok: false, error: "viewer 停止通知需要 endpoint 或 user_code。" }, { status: 400 });
  }

  const query = supabase
    .from("trip_notification_mutes")
    .select("id")
    .eq("share_code", shareCode)
    .eq("role", role)
    .eq("event_type", eventType);
  const { data: existing, error: findError } =
    role === "owner"
      ? await query.eq("user_code", userCode).maybeSingle()
      : endpoint
        ? await query.eq("endpoint", endpoint).maybeSingle()
        : await query.eq("user_code", userCode).maybeSingle();

  if (findError) {
    return NextResponse.json({ ok: false, error: findError.message }, { status: 500 });
  }

  if (existing?.id) {
    const { error } = await supabase
      .from("trip_notification_mutes")
      .update({ muted: true })
      .eq("id", existing.id);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, muted: true });
  }

  const { error } = await supabase.from("trip_notification_mutes").insert({
    share_code: shareCode,
    role,
    user_code: userCode,
    endpoint,
    event_type: eventType,
    muted: true
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, muted: true });
}
