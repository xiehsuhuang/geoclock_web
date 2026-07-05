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

type WakeDiagnostics = {
  ownerSubscriptions: number;
  pushSuccess: number;
  pushFailed: number;
  errors: string[];
};

export async function POST(request: Request) {
  const emptyDiagnostics: WakeDiagnostics = {
    ownerSubscriptions: 0,
    pushSuccess: 0,
    pushFailed: 0,
    errors: []
  };

  if (!supabase) {
    return NextResponse.json({ message: "Supabase 環境變數未設定。", diagnostics: emptyDiagnostics }, { status: 503 });
  }
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return NextResponse.json({ message: "VAPID 環境變數未設定。", diagnostics: emptyDiagnostics }, { status: 503 });
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const payload = (await request.json()) as WakeRequestPayload;
  const shareCode = payload.shareCode?.trim();
  if (!shareCode) {
    return NextResponse.json({ message: "缺少行程代碼。", diagnostics: emptyDiagnostics }, { status: 400 });
  }

  const { data: trip, error: tripError } = await supabase
    .from("trips")
    .select("id, share_code, owner_code")
    .eq("share_code", shareCode)
    .maybeSingle();

  if (tripError || !trip) {
    return NextResponse.json({ message: `找不到行程代碼：${shareCode}。`, diagnostics: emptyDiagnostics }, { status: 404 });
  }

  let wakeRequestId = payload.wakeRequestId;
  if (wakeRequestId) {
    const { data: existing } = await supabase.from("wake_requests").select("status").eq("id", wakeRequestId).maybeSingle();
    if (existing?.status !== "active") {
      return NextResponse.json({ id: wakeRequestId, status: existing?.status ?? "stopped", diagnostics: emptyDiagnostics });
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
      return NextResponse.json(
        { message: `呼叫建立失敗：${createError?.message ?? "請稍後再試。"}`, diagnostics: emptyDiagnostics },
        { status: 500 }
      );
    }
    wakeRequestId = created.id;
  }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_code", trip.owner_code)
    .eq("role", "owner");

  if (subscriptionError) {
    return NextResponse.json(
      { id: wakeRequestId, message: `讀取通知訂閱失敗：${subscriptionError.message}`, diagnostics: emptyDiagnostics },
      { status: 500 }
    );
  }

  const ownerSubscriptions = ((subscriptions ?? []) as PushSubscriptionRow[]).length;
  if (ownerSubscriptions === 0) {
    return NextResponse.json(
      {
        id: wakeRequestId,
        status: "active",
        message: "對方尚未啟用通知，無法呼叫。",
        diagnostics: {
          ownerSubscriptions: 0,
          pushSuccess: 0,
          pushFailed: 0,
          errors: ["對方尚未啟用通知"]
        }
      },
      { status: 409 }
    );
  }

  const notificationPayload = JSON.stringify({
    title: "GeoClock 呼叫提醒",
    body: "有人提醒你快到了，請確認是否醒著",
    url: "/",
    tag: `geoclock-wake-${wakeRequestId}`
  });

  const diagnostics: WakeDiagnostics = {
    ownerSubscriptions,
    pushSuccess: 0,
    pushFailed: 0,
    errors: []
  };

  const sends = ((subscriptions ?? []) as PushSubscriptionRow[]).map(async (subscription) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth
          }
        },
        notificationPayload
      );
      diagnostics.pushSuccess += 1;
    } catch (error) {
      diagnostics.pushFailed += 1;
      diagnostics.errors.push(error instanceof Error ? error.message : "Push 發送失敗");
    }
  });

  await Promise.all(sends);
  return NextResponse.json({
    id: wakeRequestId,
    status: "active",
    message: diagnostics.pushSuccess > 0 ? "呼叫已送出。" : "呼叫未送出，請查看診斷。",
    diagnostics
  });
}
