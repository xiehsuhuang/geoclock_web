import { NextResponse } from "next/server";
import webpush from "web-push";
import { supabase } from "@/lib/supabaseClient";

export const runtime = "nodejs";

type WakeRequestPayload = {
  shareCode?: string;
  wakeRequestId?: string;
  fromViewerCode?: string;
};

type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ message: "尚未設定 Supabase，無法送出呼叫。" }, { status: 503 });
  }
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return NextResponse.json({ message: "尚未設定 Web Push VAPID keys。" }, { status: 503 });
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const payload = (await request.json()) as WakeRequestPayload;
  const shareCode = payload.shareCode?.trim();
  if (!shareCode) {
    return NextResponse.json({ message: "缺少分享代碼。" }, { status: 400 });
  }

  const { data: trip, error: tripError } = await supabase
    .from("trips")
    .select("id, share_code, owner_code")
    .eq("share_code", shareCode)
    .maybeSingle();

  if (tripError || !trip) {
    return NextResponse.json({ message: "找不到這趟共享行程，可能已結束或連結錯誤。" }, { status: 404 });
  }

  let wakeRequestId = payload.wakeRequestId;
  if (wakeRequestId) {
    const { data: existing } = await supabase.from("wake_requests").select("status").eq("id", wakeRequestId).maybeSingle();
    if (existing?.status !== "active") {
      return NextResponse.json({ id: wakeRequestId, status: existing?.status ?? "stopped" });
    }
  } else {
    const { data: created, error: createError } = await supabase
      .from("wake_requests")
      .insert({
        trip_id: trip.id,
        share_code: trip.share_code,
        from_viewer_code: payload.fromViewerCode ?? null,
        to_owner_code: trip.owner_code,
        status: "active",
        message: "有人提醒你快到了，請確認是否醒著"
      })
      .select("id")
      .single();

    if (createError || !created) {
      return NextResponse.json({ message: "呼叫建立失敗，請稍後再試。" }, { status: 500 });
    }
    wakeRequestId = created.id;
  }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_code", trip.owner_code)
    .eq("role", "owner");

  if (subscriptionError) {
    return NextResponse.json({ id: wakeRequestId, message: "讀取通知訂閱失敗。" }, { status: 500 });
  }

  const notificationPayload = JSON.stringify({
    title: "GeoClock 呼叫提醒",
    body: "有人提醒你快到了，請確認是否醒著",
    url: "/",
    tag: `geoclock-wake-${wakeRequestId}`
  });

  const sends = ((subscriptions ?? []) as PushSubscriptionRow[]).map((subscription) =>
    webpush
      .sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth
          }
        },
        notificationPayload
      )
      .catch(() => undefined)
  );

  await Promise.all(sends);
  return NextResponse.json({ id: wakeRequestId, status: "active", sent: sends.length });
}
