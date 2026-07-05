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
  role: "owner" | "viewer" | string;
  user_code: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type NotificationEventType = "near_destination" | "arrived" | "location_lost";

const LOCATION_LOST_THRESHOLD_MS = 60_000;

export async function POST(request: Request) {
  const diagnostics = {
    ok: true,
    checkedEvents: [] as NotificationEventType[],
    sentCount: 0,
    failedCount: 0,
    skippedMutedCount: 0,
    errors: [] as string[]
  };

  if (!supabase) {
    return NextResponse.json({ ...diagnostics, ok: false, errors: ["Supabase 環境變數未設定。"] }, { status: 503 });
  }
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return NextResponse.json({ ...diagnostics, ok: false, errors: ["VAPID 環境變數未設定。"] }, { status: 503 });
  }

  const payload = (await request.json()) as NotifyTripEventsPayload;
  const tripId = payload.tripId?.trim();
  const shareCode = payload.shareCode?.trim();
  if (!tripId && !shareCode) {
    return NextResponse.json({ ...diagnostics, ok: false, errors: ["缺少行程資料。"] }, { status: 400 });
  }

  const query = supabase
    .from("trips")
    .select("id, share_code, owner_code, alert_radius_m, arrival_radius_m, distance_m, last_location_at, ended_at");
  const { data: tripData, error: tripError } = tripId
    ? await query.eq("id", tripId).maybeSingle()
    : await query.eq("share_code", shareCode).maybeSingle();

  if (tripError || !tripData) {
    return NextResponse.json(
      { ...diagnostics, ok: false, errors: [tripError?.message ?? "找不到共享行程。"] },
      { status: 404 }
    );
  }

  const trip = tripData as TripEventRow;
  const targetEvents = getTargetEvents(trip);
  diagnostics.checkedEvents = targetEvents;
  if (targetEvents.length === 0) {
    return NextResponse.json(diagnostics);
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("role, user_code, endpoint, p256dh, auth")
    .or(`user_code.eq.${trip.owner_code},share_code.eq.${trip.share_code}`);

  if (subscriptionError) {
    return NextResponse.json({ ...diagnostics, ok: false, errors: [subscriptionError.message] }, { status: 500 });
  }

  const rows = ((subscriptions ?? []) as PushSubscriptionRow[]).filter(
    (subscription) => subscription.role === "owner" || subscription.role === "viewer"
  );

  for (const eventType of targetEvents) {
    await insertNotificationRecord(trip, eventType);
    for (const subscription of rows) {
      const role = subscription.role === "owner" ? "owner" : "viewer";
      const muted = await isMuted({
        shareCode: trip.share_code,
        role,
        userCode: role === "owner" ? trip.owner_code : subscription.user_code,
        endpoint: role === "viewer" ? subscription.endpoint : null
      });
      if (muted) {
        diagnostics.skippedMutedCount += 1;
        continue;
      }

      const notificationPayload = JSON.stringify({
        ...getNotificationContent(role, eventType, trip.distance_m),
        url: role === "owner" ? "/" : `/share/${trip.share_code}`,
        tag: `geoclock-${trip.id}-${role}-${eventType}`
      });

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
        diagnostics.sentCount += 1;
      } catch (error) {
        diagnostics.failedCount += 1;
        diagnostics.errors.push(error instanceof Error ? error.message : "Push 發送失敗");
      }
    }
  }

  return NextResponse.json(diagnostics);
}

function getTargetEvents(trip: TripEventRow): NotificationEventType[] {
  if (trip.ended_at) {
    return [];
  }

  const events: NotificationEventType[] = [];
  const arrivalRadiusMeters = trip.arrival_radius_m ?? 100;
  if (typeof trip.distance_m === "number" && trip.distance_m <= trip.alert_radius_m) {
    events.push("near_destination");
  }
  if (typeof trip.distance_m === "number" && trip.distance_m <= arrivalRadiusMeters) {
    events.push("arrived");
  }
  if (trip.last_location_at) {
    const staleMs = Date.now() - new Date(trip.last_location_at).getTime();
    if (staleMs > LOCATION_LOST_THRESHOLD_MS) {
      events.push("location_lost");
    }
  }

  return events;
}

async function isMuted({
  endpoint,
  role,
  shareCode,
  userCode
}: {
  endpoint: string | null;
  role: "owner" | "viewer";
  shareCode: string;
  userCode: string | null;
}) {
  if (!supabase) {
    return false;
  }

  let query = supabase
    .from("trip_notification_mutes")
    .select("muted")
    .eq("share_code", shareCode)
    .eq("role", role)
    .eq("event_type", "all")
    .eq("muted", true);

  if (role === "owner") {
    if (!userCode) {
      return false;
    }
    query = query.eq("user_code", userCode);
  } else if (endpoint) {
    query = query.eq("endpoint", endpoint);
  } else if (userCode) {
    query = query.eq("user_code", userCode);
  } else {
    return false;
  }

  const { data } = await query.limit(1).maybeSingle();
  return Boolean(data?.muted);
}

async function insertNotificationRecord(trip: TripEventRow, eventType: NotificationEventType) {
  if (!supabase) {
    return;
  }

  await supabase
    .from("notification_events")
    .insert({
      trip_id: trip.id,
      share_code: trip.share_code,
      event_type: eventType
    })
    .then(() => undefined);
}

function getNotificationContent(role: "owner" | "viewer", eventType: NotificationEventType, distanceMeters: number | null) {
  const roundedDistance = typeof distanceMeters === "number" ? Math.max(0, Math.round(distanceMeters)) : 0;

  if (role === "owner" && eventType === "near_destination") {
    return {
      title: "GeoClock 快到提醒",
      body: `你已進入提醒範圍，距離目的地約 ${roundedDistance} m。按停止可關閉本趟通知。`
    };
  }
  if (role === "owner" && eventType === "arrived") {
    return {
      title: "GeoClock 已抵達",
      body: "你已抵達目的地附近。按停止可關閉本趟通知。"
    };
  }
  if (eventType === "arrived") {
    return {
      title: "GeoClock 已抵達",
      body: "對方已抵達目的地附近。按停止可關閉本趟通知。"
    };
  }
  if (eventType === "location_lost") {
    return {
      title: "GeoClock 定位可能中斷",
      body: "對方的位置已一段時間沒有更新。按停止可關閉本趟通知。"
    };
  }
  return {
    title: "GeoClock 到站提醒",
    body: `對方快到目的地了，距離約 ${roundedDistance} m。按停止可關閉本趟通知。`
  };
}
