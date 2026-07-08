import { NextResponse } from "next/server";
import webpush from "web-push";
import { buildTripEndedNotification, buildTripStartedNotification } from "@/lib/notificationText";
import { supabase } from "@/lib/supabaseClient";
import { isTripActive } from "@/lib/tripStatus";

export const runtime = "nodejs";

type Payload = {
  share_code?: string;
  type?: "trip_started" | "trip_ended";
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
    .select("id, share_code, owner_code, destination_name, destination_address, ended_at, status, expires_at")
    .eq("share_code", shareCode)
    .maybeSingle();
  if (tripError || !trip) {
    return NextResponse.json({ ok: false, error: tripError?.message ?? "找不到行程。", sent: 0, failed: 0, skippedCooldown: 0 }, { status: 404 });
  }
  if (type !== "trip_ended" && !isTripActive(trip)) {
    return NextResponse.json({ ok: true, sent: 0, failed: 0, skippedCooldown: 0, skippedReason: "trip_not_active" });
  }

  const viewerCodes = await getNotificationViewerCodes(trip.share_code);
  if (viewerCodes.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, failed: 0, skippedCooldown: 0 });
  }

  const { data: subscriptions } = await supabase
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth,user_code")
    .in("user_code", viewerCodes);
  const subscriptionRows = (subscriptions ?? []) as SubscriptionRow[];
  const subscribedCodes = new Set(subscriptionRows.map((subscription) => subscription.user_code).filter(Boolean));

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  let sent = 0;
  let failed = 0;
  let skippedCooldown = 0;
  const errors: string[] = [];
  const content = type === "trip_started" ? buildTripStartedNotification(trip) : buildTripEndedNotification(trip);
  const notificationPayload = JSON.stringify({
    ...content,
    type,
    owner_code: trip.owner_code,
    share_code: trip.share_code,
    url: `/share/${trip.share_code}`,
    tag: `geoclock-${trip.id}-${type}`
  });

  for (const viewerCode of viewerCodes) {
    if (!subscribedCodes.has(viewerCode)) {
      const hasLoggedMissingSubscription = await hasTripLifecycleEvent(trip.share_code, type, viewerCode, null);
      if (hasLoggedMissingSubscription) {
        skippedCooldown += 1;
        continue;
      }
      failed += 1;
      const message = "家人尚未啟用通知。";
      errors.push(`${viewerCode}: ${message}`);
      await insertEvent(trip.id, trip.share_code, type, viewerCode, null, false, message);
    }
  }

  for (const subscription of subscriptionRows) {
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

async function hasTripLifecycleEvent(shareCode: string, type: "trip_started" | "trip_ended", recipientCode: string | null, endpoint: string | null) {
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
  endpoint: string | null,
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

async function getNotificationViewerCodes(shareCode: string) {
  if (!supabase) {
    return [];
  }

  const { data: selectedRecipients } = await supabase
    .from("trip_recipients")
    .select("recipient_code")
    .eq("share_code", shareCode)
    .eq("can_receive_notifications", true);
  const recipientCodes = ((selectedRecipients ?? []) as { recipient_code: string }[]).map((row) => row.recipient_code);
  return Array.from(new Set(recipientCodes));
}
