import { NextResponse } from "next/server";
import webpush from "web-push";
import { supabase } from "@/lib/supabaseClient";

export const runtime = "nodejs";

type NotifyTripEventsPayload = {
  tripId?: string;
  shareCode?: string;
};

type TripEventRow = {
  id: string;
  share_code: string;
  owner_code: string;
  destination_name: string | null;
  alert_radius_m: number | null;
  arrival_radius_m: number | null;
  status: string | null;
  distance_m: number | null;
  last_location_at: string | null;
  started_at: string | null;
  ended_at: string | null;
};

type PushSubscriptionRow = {
  role: "owner" | "viewer" | string | null;
  user_code: string | null;
  share_code?: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type FamilyConnectionRow = {
  user_a_code: string;
  user_b_code: string;
  user_a_permissions: Record<string, boolean> | null;
  user_b_permissions: Record<string, boolean> | null;
};

type NotificationEventType = "near_destination" | "arrived" | "location_lost";

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
  location_lost: 10 * 60 * 1000
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
      "id, share_code, owner_code, destination_name, alert_radius_m, arrival_radius_m, status, distance_m, last_location_at, started_at, ended_at"
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

  const trip = tripData as TripEventRow;
  if (trip.ended_at || trip.status === "ended") {
    return NextResponse.json({ ...result, skippedReason: "trip_ended", skippedEndedCount: 1 });
  }

  const targetEvents = getTargetEvents(trip);
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

  const recipients = await getRecipients(trip);
  result.debug = {
    shareCode: trip.share_code,
    recipientCount: recipients.length,
    distanceMeters: trip.distance_m,
    alertRadiusMeters: trip.alert_radius_m ?? 500,
    arrivalRadiusMeters: trip.arrival_radius_m ?? 100,
    lastLocationAt: trip.last_location_at
  };

  for (const eventType of targetEvents) {
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

  const events: NotificationEventType[] = [];
  const alertRadiusMeters = trip.alert_radius_m ?? 500;
  const arrivalRadiusMeters = trip.arrival_radius_m ?? 100;
  if (typeof trip.distance_m === "number" && trip.distance_m <= alertRadiusMeters) {
    events.push("near_destination");
  }
  if (typeof trip.distance_m === "number" && trip.distance_m <= arrivalRadiusMeters) {
    events.push("arrived");
  }
  if (trip.last_location_at) {
    const lastLocationAt = new Date(trip.last_location_at).getTime();
    if (!Number.isNaN(lastLocationAt) && now - lastLocationAt > LOCATION_LOST_THRESHOLD_MS) {
      events.push("location_lost");
    }
  }

  return events;
}

async function getRecipients(trip: TripEventRow): Promise<Recipient[]> {
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
    .filter((subscription) => subscription.endpoint && subscription.p256dh && subscription.auth)
    .map((subscription) => ({
      role: subscription.role === "viewer" ? "viewer" : "owner",
      code: subscription.role === "viewer" ? subscription.user_code : trip.owner_code,
      endpoint: subscription.endpoint,
      subscription
    })) satisfies Recipient[];

  const familyRecipients = await getFamilyRecipients(trip.owner_code);
  return dedupeRecipients([...baseRecipients, ...familyRecipients]);
}

async function getFamilyRecipients(ownerCode: string): Promise<Recipient[]> {
  if (!supabase) {
    return [];
  }

  const { data: connections } = await supabase
    .from("family_connections")
    .select("user_a_code,user_b_code,user_a_permissions,user_b_permissions")
    .or(`user_a_code.eq.${ownerCode},user_b_code.eq.${ownerCode}`)
    .eq("status", "confirmed");

  const viewerCodes = ((connections ?? []) as FamilyConnectionRow[])
    .filter((connection) => {
      const permissions = connection.user_a_code === ownerCode ? connection.user_a_permissions : connection.user_b_permissions;
      return permissions?.can_receive_notifications === true;
    })
    .map((connection) => (connection.user_a_code === ownerCode ? connection.user_b_code : connection.user_a_code));

  if (viewerCodes.length === 0) {
    return [];
  }

  const { data: subscriptions } = await supabase
    .from("push_subscriptions")
    .select("role, user_code, share_code, endpoint, p256dh, auth")
    .in("user_code", viewerCodes);

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

function getNotificationContent(role: "owner" | "viewer", eventType: NotificationEventType, trip: TripEventRow) {
  const ownerName = trip.owner_code || "對方";
  const distanceText = typeof trip.distance_m === "number" ? `距離約 ${Math.max(0, Math.round(trip.distance_m))} m。` : "";

  if (role === "owner" && eventType === "near_destination") {
    return {
      title: "GeoClock 到站提醒",
      body: `快到目的地了，${distanceText}請確認是否醒著。`
    };
  }
  if (role === "owner" && eventType === "arrived") {
    return {
      title: "GeoClock 已抵達",
      body: "你已抵達目的地，請確認是否醒著。"
    };
  }
  if (eventType === "arrived") {
    return {
      title: "GeoClock 已抵達",
      body: `${ownerName} 已抵達目的地。`
    };
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
