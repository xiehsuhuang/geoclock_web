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
  alert_radius_m: number;
  arrival_radius_m: number | null;
  distance_m: number | null;
  last_location_at: string | null;
  ended_at: string | null;
};

type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type NotificationEventType = "near_destination" | "arrived" | "location_lost";

const LOCATION_LOST_THRESHOLD_MS = 60_000;

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ message: "尚未設定 Supabase，無法發送自動通知。" }, { status: 503 });
  }
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return NextResponse.json({ message: "尚未設定 Web Push VAPID keys。" }, { status: 503 });
  }

  const payload = (await request.json()) as NotifyTripEventsPayload;
  const tripId = payload.tripId?.trim();
  const shareCode = payload.shareCode?.trim();
  if (!tripId && !shareCode) {
    return NextResponse.json({ message: "缺少行程資料。" }, { status: 400 });
  }

  const query = supabase
    .from("trips")
    .select("id, share_code, owner_code, alert_radius_m, arrival_radius_m, distance_m, last_location_at, ended_at");
  const { data: trip, error: tripError } = tripId
    ? await query.eq("id", tripId).maybeSingle()
    : await query.eq("share_code", shareCode).maybeSingle();

  if (tripError || !trip) {
    return NextResponse.json({ message: "找不到共享行程。" }, { status: 404 });
  }

  const targetEvents = getTargetEvents(trip as TripEventRow);
  if (targetEvents.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, events: [] });
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const ownerName = await getOwnerName((trip as TripEventRow).owner_code);
  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("share_code", (trip as TripEventRow).share_code)
    .eq("role", "viewer");

  if (subscriptionError) {
    return NextResponse.json({ message: "讀取家人通知訂閱失敗。" }, { status: 500 });
  }

  let sent = 0;
  const sentEvents: NotificationEventType[] = [];

  for (const eventType of targetEvents) {
    const inserted = await reserveNotificationEvent(trip as TripEventRow, eventType);
    if (!inserted) {
      continue;
    }

    sentEvents.push(eventType);
    const notificationPayload = JSON.stringify({
      ...getNotificationContent(eventType, ownerName, (trip as TripEventRow).distance_m),
      url: `/share/${(trip as TripEventRow).share_code}`,
      tag: `geoclock-${(trip as TripEventRow).id}-${eventType}`
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
        .then(() => {
          sent += 1;
        })
        .catch(() => undefined)
    );
    await Promise.all(sends);
  }

  return NextResponse.json({ ok: true, sent, events: sentEvents });
}

function getTargetEvents(trip: TripEventRow): NotificationEventType[] {
  if (trip.ended_at) {
    return [];
  }

  const events: NotificationEventType[] = [];
  const arrivalRadiusMeters = trip.arrival_radius_m ?? 100;
  if (typeof trip.distance_m === "number" && trip.distance_m <= arrivalRadiusMeters) {
    events.push("arrived");
  } else if (typeof trip.distance_m === "number" && trip.distance_m <= trip.alert_radius_m) {
    events.push("near_destination");
  }

  if (trip.last_location_at) {
    const staleMs = Date.now() - new Date(trip.last_location_at).getTime();
    if (staleMs > LOCATION_LOST_THRESHOLD_MS) {
      events.push("location_lost");
    }
  }

  return events;
}

async function reserveNotificationEvent(trip: TripEventRow, eventType: NotificationEventType) {
  if (!supabase) {
    return false;
  }

  const { error } = await supabase.from("notification_events").insert({
    trip_id: trip.id,
    share_code: trip.share_code,
    event_type: eventType
  });

  return !error;
}

async function getOwnerName(ownerCode: string) {
  if (!supabase) {
    return ownerCode;
  }

  const { data } = await supabase.from("users").select("display_name").eq("user_code", ownerCode).maybeSingle();
  return data?.display_name ?? ownerCode;
}

function getNotificationContent(eventType: NotificationEventType, ownerName: string, distanceMeters: number | null) {
  if (eventType === "arrived") {
    return {
      title: "GeoClock 已抵達",
      body: `${ownerName}已抵達目的地。`
    };
  }

  if (eventType === "location_lost") {
    return {
      title: "GeoClock 定位可能中斷",
      body: `${ownerName}的位置已經一段時間沒有更新，請打開頁面確認。`
    };
  }

  const roundedDistance = typeof distanceMeters === "number" ? Math.max(0, Math.round(distanceMeters)) : 0;
  return {
    title: "GeoClock 到站提醒",
    body: `${ownerName}快到目的地了，距離約 ${roundedDistance} m。`
  };
}
