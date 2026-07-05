import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

type PushSubscriptionPayload = {
  userCode?: string;
  shareCode?: string;
  role?: "owner" | "viewer";
  subscription?: {
    endpoint?: string;
    keys?: {
      p256dh?: string;
      auth?: string;
    };
  };
};

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ message: "尚未設定 Supabase，無法儲存通知訂閱。" }, { status: 503 });
  }

  const payload = (await request.json()) as PushSubscriptionPayload;
  const userCode = payload.userCode?.trim();
  const shareCode = payload.shareCode?.trim();
  const role = payload.role === "viewer" ? "viewer" : "owner";
  const endpoint = payload.subscription?.endpoint;
  const p256dh = payload.subscription?.keys?.p256dh;
  const auth = payload.subscription?.keys?.auth;

  if ((!userCode && !shareCode) || !endpoint || !p256dh || !auth) {
    return NextResponse.json({ message: "通知訂閱資料不完整。" }, { status: 400 });
  }

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_code: userCode ?? null,
      share_code: shareCode ?? null,
      role,
      endpoint,
      p256dh,
      auth,
      user_agent: request.headers.get("user-agent"),
      updated_at: new Date().toISOString()
    },
    { onConflict: "endpoint" }
  );

  if (error) {
    return NextResponse.json({ message: "通知訂閱儲存失敗，請確認 Supabase SQL 已建立。" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
