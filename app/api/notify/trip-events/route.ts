import { NextResponse } from "next/server";
import webpush from "web-push";
import {
  buildArrivedNotification,
  buildAutoExtendedNotification,
  buildMaybeArrivedNotification,
  buildNearDestinationNotification
} from "@/lib/notificationText";
import { supabase } from "@/lib/supabaseClient";
import { isTripEnded, shouldAutoExtendTrip } from "@/lib/tripStatus";

export const runtime = "nodejs";

type NotifyTripEventsPayload = {
  tripId?: string;
  shareCode?: string;
  eventType?: NotificationEventType;
};

type TripEventRow = {
  id: string;
  share_code: string;
  owner_code: string;
  destination_name: string | null;
  destination_address: string | null;
  alert_radius_m: number | null;
  arrival_radius_m: number | null;
  status: string | null;
  distance_m: number | null;
  last_location_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  expires_at: string | null;
  owner_display_name?: string | null;
  arrived_at?: string | null;
};

type PushSubscriptionRow = {
  role: "owner" | "viewer" | string | null;
  user_code: string | null;
  share_code?: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type NotificationEventType = "near_destination" | "arrived" | "location_lost" | "maybe_arrived" | "auto_extended";

type Recipient = {
  role: "owner" | "viewer";
  code: string | null;
  endpoint: string;
  subscription: PushSubscriptionRow;
};

const LOCATION_LOST_THRESHOLD_MS = 60_000;
const MAX_ACTIVE_TRIP_AGE_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS: Record<NotificationEventType, number | null> = {
  near_destination: 5 * 60 * 1000,
  arrived: null,
  location_lost: 10 * 60 * 1000,
  maybe_arrived: 30 * 60 * 1000,
  auto_extended: 30 * 60 * 1000
};

export async function POST(request: Request) {
  const result = {
    ok: true,
    checkedEvents: [] as NotificationEventType[],
    sentCount: 0,
    skippedCooldownCount: 0,
    skippedMutedCount: 0,
    skippedEndedCount: 0,
    failedCount: 0,
    errors: [] as string[],
    debug: {} as Record<string, unknown>
  };

  if (!supabase) {
    return NextResponse.json({ ...result, ok: false, errors: ["Supabase 環境變數未設定。"] }, { status: 503 });
  }

  const payload = (await request.json()) as NotifyTripEventsPayload;
  const tripId = payload.tripId?.trim();
  const shareCode = payload.shareCode?.trim();
  if (!tripId && !shareCode) {
    return NextResponse.json({ ...result, ok: false, errors: ["缺少 tripId 或 shareCode。"] }, { status: 400 });
  }

  const query = supabase
    .from("trips")
    .select(
      "id, share_code, owner_code, destination_name, destination_address, alert_radius_m, arrival_radius_m, status, distance_m, last_location_at, started_at, ended_at, expires_at"
    );
  const { data: tripData, error: tripError } = tripId
    ? await query.eq("id", tripId).maybeSingle()
    : await query.eq("share_code", shareCode).maybeSingle();

  if (tripError || !tripData) {
    return NextResponse.json(
      { ...result, ok: false, errors: [tripError?.message ?? `找不到行程：${tripId ?? shareCode}`] },
      { status: 404 }
    );
  }

  const forcedEvent = isNotificationEventType(payload.eventType) ? payload.eventType : null;
  const trip = tripData as TripEventRow;
  trip.owner_display_name = await getUserDisplayName(trip.owner_code);
  if (!trip.arrived_at && forcedEvent === "arrived") {
    trip.arrived_at = new Date().toISOString();
  }
  if (isTripEnded(trip)) {
    return NextResponse.json({ ...result, skippedReason: "trip_ended", skippedEndedCount: 1 });
  }
  if (shouldAutoExtendTrip(trip)) {
    return NextResponse.json({ ...result, skippedReason: "trip_needs_auto_extend", skippedEndedCount: 1 });
  }

  const targetEvents = forcedEvent ? [forcedEvent] : getTargetEvents(trip);
  result.checkedEvents = targetEvents;
  if (targetEvents.length === 0) {
    return NextResponse.json(result);
  }

  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return NextResponse.json({ ...result, ok: false, errors: ["VAPID 環境變數未設定。"] }, { status: 503 });
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  result.debug = {
    shareCode: trip.share_code,
    targetEventCount: targetEvents.length,
    distanceMeters: trip.distance_m,
    alertRadiusMeters: trip.alert_radius_m ?? 500,
    arrivalRadiusMeters: trip.arrival_radius_m ?? 100,
    lastLocationAt: trip.last_location_at
  };

  for (const eventType of targetEvents) {
    const recipients = await getRecipients(trip, eventType);
    if (recipients.length === 0 && (eventType === "maybe_arrived" || eventType === "auto_extended")) {
      await insertSyntheticOwnerNotificationRecord(trip, eventType, "owner_subscription_missing");
      result.failedCount += 1;
      result.errors.push("owner_subscription_missing");
      continue;
    }
    for (const recipient of recipients) {
      const muted = await isMuted(trip.share_code, recipient);
      if (muted) {
        result.skippedMutedCount += 1;
        continue;
      }

      const inCooldown = await isInCooldown(trip.share_code, eventType, recipient);
      if (inCooldown) {
        result.skippedCooldownCount += 1;
        continue;
      }

      const payloadText = JSON.stringify({
        ...getNotificationContent(recipient.role, eventType, trip),
        url: recipient.role === "owner" ? "/" : `/share/${trip.share_code}`,
        tag: `geoclock-${trip.id}-${recipient.role}-${eventType}`,
        renotify: false
      });

      try {
        await webpush.sendNotification(
          {
            endpoint: recipient.subscription.endpoint,
            keys: {
              p256dh: recipient.subscription.p256dh,
              auth: recipient.subscription.auth
            }
          },
          payloadText
        );
        result.sentCount += 1;
        await insertNotificationRecord(trip, eventType, recipient, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Push 發送失敗。";
        result.failedCount += 1;
        result.errors.push(message);
        await insertNotificationRecord(trip, eventType, recipient, false, message);
      }
    }
  }

  return NextResponse.json(result);
}

function getTargetEvents(trip: TripEventRow): NotificationEventType[] {
  const now = Date.now();
  const startedAt = trip.started_at ? new Date(trip.started_at).getTime() : null;
  if (!startedAt || Number.isNaN(startedAt) || now - startedAt > MAX_ACTIVE_TRIP_AGE_MS) {
    return [];
  }
  if (shouldAutoExtendTrip(trip, now)) {
    return [];
  }

  const events: NotificationEventType[] = [];
  const alertRadiusMeters = trip.alert_radius_m ?? 500;
  const arrivalRadiusMeters = trip.arrival_radius_m ?? 100;
  if (typeof trip.distance_m === "number" && trip.distance_m <= alertRadiusMeters) {
    events.push("near_destination");
  }
  if (trip.last_location_at) {
    const lastLocationAt = new Date(trip.last_location_at).getTime();
    if (!Number.isNaN(lastLocationAt) && now - lastLocationAt > LOCATION_LOST_THRESHOLD_MS) {
      events.push("location_lost");
    }
  }

  return events;
}

async function getRecipients(trip: TripEventRow, eventType: NotificationEventType): Promise<Recipient[]> {
  if (!supabase) {
    return [];
  }

  const { data: subscriptions, error } = await supabase
    .from("push_subscriptions")
    .select("role, user_code, share_code, endpoint, p256dh, auth")
    .or(`user_code.eq.${trip.owner_code},share_code.eq.${trip.share_code}`);
  if (error) {
    return [];
  }

  const baseRecipients = ((subscriptions ?? []) as PushSubscriptionRow[])
    .filter(
      (subscription) =>
        subscription.user_code === trip.owner_code &&
        subscription.role !== "viewer" &&
        subscription.endpoint &&
        subscription.p256dh &&
        subscription.auth
    )
    .map((subscription) => ({
      role: "owner" as const,
      code: trip.owner_code,
      endpoint: subscription.endpoint,
      subscription
    })) satisfies Recipient[];

  const selectedRecipients = await getTripSelectedRecipients(trip.share_code);
  const allRecipients = dedupeRecipients([...baseRecipients, ...selectedRecipients]);
  if (eventType === "maybe_arrived" || eventType === "auto_extended") {
    return allRecipients.filter((recipient) => recipient.role === "owner");
  }
  return allRecipients;
}

async function getTripSelectedRecipients(shareCode: string): Promise<Recipient[]> {
  if (!supabase) {
    return [];
  }

  const { data: recipients } = await supabase
    .from("trip_recipients")
    .select("recipient_code")
    .eq("share_code", shareCode)
    .eq("can_receive_notifications", true);
  const codes = ((recipients ?? []) as { recipient_code: string }[]).map((row) => row.recipient_code);
  if (codes.length === 0) {
    return [];
  }

  const { data: subscriptions } = await supabase
    .from("push_subscriptions")
    .select("role, user_code, share_code, endpoint, p256dh, auth")
    .in("user_code", codes);

  return ((subscriptions ?? []) as PushSubscriptionRow[])
    .filter((subscription) => subscription.endpoint && subscription.p256dh && subscription.auth)
    .map((subscription) => ({
      role: "viewer",
      code: subscription.user_code,
      endpoint: subscription.endpoint,
      subscription: {
        ...subscription,
        role: "viewer"
      }
    }));
}

function dedupeRecipients(rows: Recipient[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.endpoint)) {
      return false;
    }
    seen.add(row.endpoint);
    return true;
  });
}

async function isMuted(shareCode: string, recipient: Recipient) {
  if (!supabase) {
    return false;
  }

  let query = supabase
    .from("trip_notification_mutes")
    .select("muted")
    .eq("share_code", shareCode)
    .eq("role", recipient.role)
    .eq("event_type", "all")
    .eq("muted", true);

  if (recipient.role === "owner") {
    if (!recipient.code) {
      return false;
    }
    query = query.eq("user_code", recipient.code);
  } else if (recipient.endpoint) {
    query = query.eq("endpoint", recipient.endpoint);
  } else if (recipient.code) {
    query = query.eq("user_code", recipient.code);
  }

  const { data } = await query.limit(1).maybeSingle();
  return Boolean(data?.muted);
}

async function isInCooldown(shareCode: string, eventType: NotificationEventType, recipient: Recipient) {
  if (!supabase) {
    return false;
  }

  let query = supabase
    .from("notification_events")
    .select("id")
    .eq("share_code", shareCode)
    .eq("event_type", eventType)
    .eq("recipient_role", recipient.role);

  if (recipient.code) {
    query = query.eq("recipient_code", recipient.code);
  } else {
    query = query.eq("endpoint", recipient.endpoint);
  }

  const cooldown = COOLDOWN_MS[eventType];
  if (cooldown !== null) {
    query = query.gte("sent_at", new Date(Date.now() - cooldown).toISOString());
  }

  const { data } = await query.order("sent_at", { ascending: false }).limit(1).maybeSingle();
  return Boolean(data?.id);
}

async function insertNotificationRecord(
  trip: TripEventRow,
  eventType: NotificationEventType,
  recipient: Recipient,
  success: boolean,
  error?: string
) {
  if (!supabase) {
    return;
  }

  await supabase.from("notification_events").insert({
    trip_id: trip.id,
    share_code: trip.share_code,
    event_type: eventType,
    recipient_role: recipient.role,
    recipient_code: recipient.code,
    endpoint: recipient.endpoint,
    success,
    error: error ?? null
  });
}

async function insertSyntheticOwnerNotificationRecord(trip: TripEventRow, eventType: NotificationEventType, error: string) {
  if (!supabase) {
    return;
  }

  await supabase.from("notification_events").insert({
    trip_id: trip.id,
    share_code: trip.share_code,
    event_type: eventType,
    recipient_role: "owner",
    recipient_code: trip.owner_code,
    endpoint: null,
    success: false,
    error
  });
}

function getNotificationContent(role: "owner" | "viewer", eventType: NotificationEventType, trip: TripEventRow) {
  const ownerName = trip.owner_code || "對方";
  const distanceText = typeof trip.distance_m === "number" ? `距離約 ${Math.max(0, Math.round(trip.distance_m))} m。` : "";

  if (eventType === "near_destination") {
    return buildNearDestinationNotification(trip, role);
  }
  if (eventType === "arrived") {
    return buildArrivedNotification(trip, role);
  }
  if (eventType === "maybe_arrived") {
    return buildMaybeArrivedNotification(trip);
  }
  if (eventType === "auto_extended") {
    return buildAutoExtendedNotification(trip);
  }
  if (eventType === "location_lost") {
    return {
      title: "GeoClock 位置更新暫停",
      body: `${ownerName} 的位置已經一段時間沒有更新，請打開頁面確認。`
    };
  }
  return {
    title: "GeoClock 到站提醒",
    body: `${ownerName} 快到目的地了，${distanceText}`
  };
}

async function getUserDisplayName(userCode: string) {
  if (!supabase) {
    return null;
  }
  const { data } = await supabase.from("users").select("display_name").eq("user_code", userCode).maybeSingle();
  return (data as { display_name?: string | null } | null)?.display_name ?? null;
}

function isNotificationEventType(eventType: unknown): eventType is NotificationEventType {
  return (
    eventType === "near_destination" ||
    eventType === "arrived" ||
    eventType === "location_lost" ||
    eventType === "maybe_arrived" ||
    eventType === "auto_extended"
  );
}
