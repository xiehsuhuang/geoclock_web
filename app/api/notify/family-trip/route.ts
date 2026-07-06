import { NextResponse } from "next/server";
import webpush from "web-push";
import { supabase } from "@/lib/supabaseClient";

export const runtime = "nodejs";

type Payload = {
  share_code?: string;
  type?: "trip_started" | "trip_ended";
};

type FamilyConnectionRow = {
  user_a_code: string;
  user_b_code: string;
  user_a_permissions: Record<string, boolean> | null;
  user_b_permissions: Record<string, boolean> | null;
};

type SubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_code: string | null;
};

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。", sent: 0, failed: 0, skippedCooldown: 0 }, { status: 503 });
  }
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return NextResponse.json({ ok: false, error: "VAPID 環境變數未設定。", sent: 0, failed: 0, skippedCooldown: 0 }, { status: 503 });
  }

  const payload = (await request.json()) as Payload;
  const shareCode = payload.share_code?.trim();
  const type = payload.type;
  if (!shareCode || (type !== "trip_started" && type !== "trip_ended")) {
    return NextResponse.json({ ok: false, error: "缺少 share_code 或 type。", sent: 0, failed: 0, skippedCooldown: 0 }, { status: 400 });
  }

  const { data: trip, error: tripError } = await supabase
    .from("trips")
    .select("id, share_code, owner_code, ended_at, status")
    .eq("share_code", shareCode)
    .maybeSingle();
  if (tripError || !trip) {
    return NextResponse.json({ ok: false, error: tripError?.message ?? "找不到行程。", sent: 0, failed: 0, skippedCooldown: 0 }, { status: 404 });
  }

  const viewerCodes = await getNotificationViewerCodes(trip.owner_code);
  if (viewerCodes.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, failed: 0, skippedCooldown: 0 });
  }

  const { data: subscriptions } = await supabase
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth,user_code")
    .in("user_code", viewerCodes);

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  let sent = 0;
  let failed = 0;
  let skippedCooldown = 0;
  const errors: string[] = [];
  const notificationPayload = JSON.stringify({
    title: type === "trip_started" ? "GeoClock 行程已開始" : "GeoClock 行程已結束",
    body: type === "trip_started" ? "對方已開啟家人共享，你可以查看 GeoClock 行程。" : "對方已結束這趟行程。",
    type,
    owner_code: trip.owner_code,
    share_code: trip.share_code,
    url: `/share/${trip.share_code}`,
    tag: `geoclock-${trip.id}-${type}`
  });

  for (const subscription of (subscriptions ?? []) as SubscriptionRow[]) {
    const recipientCode = subscription.user_code;
    const hasSent = await hasTripLifecycleEvent(trip.share_code, type, recipientCode, subscription.endpoint);
    if (hasSent) {
      skippedCooldown += 1;
      continue;
    }

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
      sent += 1;
      await insertEvent(trip.id, trip.share_code, type, recipientCode, subscription.endpoint, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Push 發送失敗。";
      failed += 1;
      errors.push(message);
      await insertEvent(trip.id, trip.share_code, type, recipientCode, subscription.endpoint, false, message);
    }
  }

  return NextResponse.json({ ok: true, sent, failed, skippedCooldown, errors });
}

async function hasTripLifecycleEvent(shareCode: string, type: "trip_started" | "trip_ended", recipientCode: string | null, endpoint: string) {
  if (!supabase) {
    return false;
  }

  let query = supabase
    .from("notification_events")
    .select("id")
    .eq("share_code", shareCode)
    .eq("event_type", type)
    .eq("recipient_role", "viewer");

  if (recipientCode) {
    query = query.eq("recipient_code", recipientCode);
  } else {
    query = query.eq("endpoint", endpoint);
  }

  const { data } = await query.limit(1).maybeSingle();
  return Boolean(data?.id);
}

async function insertEvent(
  tripId: string,
  shareCode: string,
  type: "trip_started" | "trip_ended",
  recipientCode: string | null,
  endpoint: string,
  success: boolean,
  error?: string
) {
  if (!supabase) {
    return;
  }

  await supabase.from("notification_events").insert({
    trip_id: tripId,
    share_code: shareCode,
    event_type: type,
    recipient_role: "viewer",
    recipient_code: recipientCode,
    endpoint,
    success,
    error: error ?? null
  });
}

async function getNotificationViewerCodes(ownerCode: string) {
  if (!supabase) {
    return [];
  }

  const { data } = await supabase
    .from("family_connections")
    .select("user_a_code,user_b_code,user_a_permissions,user_b_permissions")
    .or(`user_a_code.eq.${ownerCode},user_b_code.eq.${ownerCode}`)
    .eq("status", "confirmed");

  return ((data ?? []) as FamilyConnectionRow[])
    .filter((connection) => {
      const ownerPermissions = connection.user_a_code === ownerCode ? connection.user_a_permissions : connection.user_b_permissions;
      return ownerPermissions?.can_receive_notifications === true;
    })
    .map((connection) => (connection.user_a_code === ownerCode ? connection.user_b_code : connection.user_a_code));
}
