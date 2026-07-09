import { NextResponse } from "next/server";
import webpush from "web-push";
import { buildWakeAcknowledgedNotification } from "@/lib/notificationText";
import { supabase } from "@/lib/supabaseClient";

export const runtime = "nodejs";

type WakeRequestRow = {
  id: string;
  trip_id: string | null;
  share_code: string;
  from_viewer_code: string | null;
  to_owner_code: string;
  status: string | null;
  acknowledged_at: string | null;
};

type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, message: "尚未設定 Supabase，無法回應呼叫。" }, { status: 503 });
  }

  const payload = (await request.json().catch(() => ({}))) as {
    wakeRequestId?: string;
    userCode?: string;
  };

  const wakeRequest = await findWakeRequest(payload.wakeRequestId, payload.userCode);
  if (!wakeRequest) {
    return NextResponse.json({ ok: false, message: "找不到呼叫紀錄。" }, { status: 404 });
  }

  if (wakeRequest.status === "acknowledged" || wakeRequest.acknowledged_at) {
    return NextResponse.json({ ok: true, status: "acknowledged", alreadyAcknowledged: true });
  }

  const nowIso = new Date().toISOString();
  const updated = await markWakeAcknowledged(wakeRequest.id, nowIso);
  if (!updated.ok) {
    return NextResponse.json({ ok: false, message: updated.error ?? "回應呼叫失敗。" }, { status: 500 });
  }
  if (updated.alreadyAcknowledged) {
    return NextResponse.json({ ok: true, status: "acknowledged", alreadyAcknowledged: true });
  }

  const pushResult = await notifyRequester({ ...wakeRequest, acknowledged_at: nowIso });
  return NextResponse.json({
    ok: true,
    status: "acknowledged",
    alreadyAcknowledged: false,
    notifiedRequester: pushResult.sent > 0,
    sent: pushResult.sent,
    failed: pushResult.failed,
    errors: pushResult.errors
  });
}

async function findWakeRequest(wakeRequestId?: string, userCode?: string) {
  if (!supabase) {
    return null;
  }

  let query = supabase
    .from("wake_requests")
    .select("id, trip_id, share_code, from_viewer_code, to_owner_code, status, acknowledged_at")
    .order("created_at", { ascending: false })
    .limit(1);

  if (wakeRequestId?.trim()) {
    query = query.eq("id", wakeRequestId.trim());
  } else if (userCode?.trim()) {
    query = query.eq("to_owner_code", userCode.trim().toUpperCase()).eq("status", "active");
  } else {
    return null;
  }

  const { data } = await query.maybeSingle();
  return (data as WakeRequestRow | null) ?? null;
}

async function markWakeAcknowledged(wakeRequestId: string, acknowledgedAt: string): Promise<{ ok: true; alreadyAcknowledged?: boolean } | { ok: false; error?: string }> {
  if (!supabase) {
    return { ok: false, error: "Supabase 環境變數未設定。" };
  }

  const updateWithTimestamp = await supabase
    .from("wake_requests")
    .update({
      status: "acknowledged",
      acknowledged_at: acknowledgedAt,
      updated_at: acknowledgedAt
    })
    .eq("id", wakeRequestId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  if (!updateWithTimestamp.error) {
    return updateWithTimestamp.data?.id ? { ok: true } : { ok: true, alreadyAcknowledged: true };
  }

  const fallback = await supabase
    .from("wake_requests")
    .update({
      status: "acknowledged",
      acknowledged_at: acknowledgedAt
    })
    .eq("id", wakeRequestId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  if (fallback.error) {
    return { ok: false, error: fallback.error.message };
  }
  return fallback.data?.id ? { ok: true } : { ok: true, alreadyAcknowledged: true };
}

async function notifyRequester(wakeRequest: WakeRequestRow) {
  const result = {
    sent: 0,
    failed: 0,
    errors: [] as string[]
  };

  if (!supabase || !wakeRequest.from_viewer_code) {
    return result;
  }
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    result.failed += 1;
    result.errors.push("VAPID 環境變數未設定。");
    await insertWakeAckEvent(wakeRequest, null, false, "VAPID 環境變數未設定。");
    return result;
  }

  const { data: owner } = await supabase
    .from("users")
    .select("display_name")
    .eq("user_code", wakeRequest.to_owner_code)
    .maybeSingle();
  const content = buildWakeAcknowledgedNotification((owner as { display_name?: string } | null)?.display_name, wakeRequest.acknowledged_at);

  const { data: subscriptions, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth")
    .eq("user_code", wakeRequest.from_viewer_code);

  if (error) {
    result.failed += 1;
    result.errors.push(error.message);
    await insertWakeAckEvent(wakeRequest, null, false, error.message);
    return result;
  }
  if (!subscriptions || subscriptions.length === 0) {
    result.failed += 1;
    result.errors.push("呼叫方尚未啟用通知。");
    await insertWakeAckEvent(wakeRequest, null, false, "呼叫方尚未啟用通知。");
    return result;
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const payload = JSON.stringify({
    ...content,
    type: "wake_acknowledged",
    share_code: wakeRequest.share_code,
    url: `/share/${wakeRequest.share_code}`,
    tag: `geoclock-wake-ack-${wakeRequest.id}`,
    renotify: false
  });

  for (const subscription of (subscriptions ?? []) as PushSubscriptionRow[]) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth
          }
        },
        payload
      );
      result.sent += 1;
      await insertWakeAckEvent(wakeRequest, subscription.endpoint, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Push 發送失敗。";
      result.failed += 1;
      result.errors.push(message);
      await insertWakeAckEvent(wakeRequest, subscription.endpoint, false, message);
    }
  }

  return result;
}

async function insertWakeAckEvent(wakeRequest: WakeRequestRow, endpoint: string | null, success: boolean, error?: string) {
  if (!supabase) {
    return;
  }

  await supabase.from("notification_events").insert({
    trip_id: wakeRequest.trip_id,
    share_code: wakeRequest.share_code,
    event_type: "wake_acknowledged",
    recipient_role: "viewer",
    recipient_code: wakeRequest.from_viewer_code,
    endpoint,
    success,
    error: error ?? null
  });
}
