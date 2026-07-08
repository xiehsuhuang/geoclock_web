import { NextResponse } from "next/server";
import webpush from "web-push";
import { buildWakeRequestNotification } from "@/lib/notificationText";
import { supabase } from "@/lib/supabaseClient";
import { canWakeOwner } from "@/lib/tripStatus";

export const runtime = "nodejs";

type WakeRequestPayload = {
  shareCode?: string;
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
    .select("id, share_code, owner_code, status, ended_at, expires_at")
    .eq("share_code", shareCode)
    .maybeSingle();

  if (tripError || !trip) {
    return NextResponse.json({ message: `找不到行程代碼：${shareCode}。`, diagnostics: emptyDiagnostics }, { status: 404 });
  }
  if (!canWakeOwner(trip) || !isWakeableTripStatus(trip.status)) {
    return NextResponse.json(
      {
        ok: false,
        error: "這趟行程已結束，不能再呼叫對方。",
        message: "這趟行程已結束，不能再呼叫對方。",
        diagnostics: emptyDiagnostics
      },
      { status: 409 }
    );
  }
  const viewerCode = payload.fromViewerCode?.trim().toUpperCase();
  if (!viewerCode) {
    return NextResponse.json(
      {
        ok: false,
        error: "請先輸入家人代號，完成家人連線後才能呼叫對方。",
        message: "請先輸入家人代號，完成家人連線後才能呼叫對方。",
        diagnostics: emptyDiagnostics
      },
      { status: 403 }
    );
  }

  const canWake = await canViewerWakeOwner(trip.owner_code, viewerCode);
  if (!canWake) {
    return NextResponse.json(
      {
        ok: false,
        error: "你沒有這趟行程的呼叫權限。",
        message: "你沒有這趟行程的呼叫權限。",
        diagnostics: emptyDiagnostics
      },
      { status: 403 }
    );
  }

  const created = await createWakeRequest({
    tripId: trip.id,
    shareCode: trip.share_code,
    fromViewerCode: viewerCode,
    toOwnerCode: trip.owner_code
  });
  if (!created.ok) {
    return NextResponse.json(
      { ok: false, message: `呼叫建立失敗：${created.error ?? "請稍後再試。"}`, diagnostics: emptyDiagnostics },
      { status: 500 }
    );
  }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_code", trip.owner_code)
    .eq("role", "owner");

  if (subscriptionError) {
    return NextResponse.json(
      { id: created.id, message: `讀取通知訂閱失敗：${subscriptionError.message}`, diagnostics: emptyDiagnostics },
      { status: 500 }
    );
  }

  const ownerSubscriptions = ((subscriptions ?? []) as PushSubscriptionRow[]).length;
  if (ownerSubscriptions === 0) {
    return NextResponse.json(
      {
        id: created.id,
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
    ...buildWakeRequestNotification(),
    url: "/",
    tag: `geoclock-wake-${created.id}`
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
    ok: diagnostics.pushSuccess > 0,
    id: created.id,
    status: "active",
    message: diagnostics.pushSuccess > 0 ? "呼叫已送出。" : "呼叫未送出，請查看診斷。",
    diagnostics
  });
}

async function createWakeRequest({
  tripId,
  shareCode,
  fromViewerCode,
  toOwnerCode
}: {
  tripId: string;
  shareCode: string;
  fromViewerCode: string;
  toOwnerCode: string;
}): Promise<{ ok: true; id: string } | { ok: false; error?: string }> {
  if (!supabase) {
    return { ok: false, error: "Supabase 環境變數未設定。" };
  }

  const values = {
    trip_id: tripId,
    share_code: shareCode,
    from_viewer_code: fromViewerCode,
    to_owner_code: toOwnerCode,
    status: "active",
    message: "有人提醒你快到了，請確認是否醒著",
    push_count: 1
  };

  const { data, error } = await supabase.from("wake_requests").insert(values).select("id").single();
  if (!error && data?.id) {
    return { ok: true, id: data.id };
  }

  const fallbackValues = {
    trip_id: values.trip_id,
    share_code: values.share_code,
    from_viewer_code: values.from_viewer_code,
    to_owner_code: values.to_owner_code,
    status: values.status,
    message: values.message
  };
  const fallback = await supabase.from("wake_requests").insert(fallbackValues).select("id").single();
  if (fallback.error || !fallback.data?.id) {
    return { ok: false, error: fallback.error?.message ?? error?.message };
  }
  return { ok: true, id: fallback.data.id };
}

async function canViewerWakeOwner(ownerCode: string, viewerCode: string) {
  if (!supabase || ownerCode === viewerCode) {
    return false;
  }

  const { data } = await supabase
    .from("family_connections")
    .select("user_a_code,user_b_code,user_a_permissions,user_b_permissions,status")
    .or(`and(user_a_code.eq.${ownerCode},user_b_code.eq.${viewerCode}),and(user_a_code.eq.${viewerCode},user_b_code.eq.${ownerCode})`)
    .eq("status", "confirmed")
    .limit(1)
    .maybeSingle();

  if (!data) {
    return false;
  }

  const permissions =
    data.user_a_code === ownerCode
      ? (data.user_a_permissions as { can_wake_me?: boolean } | null)
      : (data.user_b_permissions as { can_wake_me?: boolean } | null);
  return permissions?.can_wake_me === true;
}

function isWakeableTripStatus(status?: string | null) {
  if (!status) {
    return true;
  }
  return [
    "active",
    "in_progress",
    "started",
    "行程中",
    "接近目的地",
    "快到目的地",
    "定位延遲",
    "定位中斷"
  ].includes(status);
}
