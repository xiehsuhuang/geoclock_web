"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistance } from "@/lib/geo";
import { getNotificationDiagnostics, getStandaloneHint, urlBase64ToUint8Array } from "@/lib/notificationDiagnostics";
import { playAlertSoundFor, startAlertSoundLoop, stopAlertSoundLoop, unlockAlertSound } from "@/lib/sound";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";
import { canWakeOwner, getTripDisplayStatus, isTripActive, isTripEnded, isTripExpired } from "@/lib/tripStatus";
import type { CloudTripRow, CurrentPosition, Destination, NotificationDiagnostic } from "@/lib/types";

const TripMap = dynamic(() => import("@/components/TripMap"), {
  ssr: false
});

type ShareLoadState = {
  initialLoading: boolean;
  refreshing: boolean;
  refreshError: string;
  lastSuccessfulFetchAt: string | null;
  missingMessage: string;
  trip: CloudTripRow | null;
};

type ShareNotificationState = {
  status: "尚未啟用" | "已啟用" | "被拒絕" | "此瀏覽器不支援";
  message: string;
};

type WakeStatus = "idle" | "sending" | "sent" | "error";

const VIEWER_CODE_STORAGE_KEY = "geoclock.web.viewerCode";
const SHARE_POLL_INTERVAL_MS = 15_000;

export default function ShareTripClient({ shareCode }: { shareCode: string }) {
  const [loadState, setLoadState] = useState<ShareLoadState>({
    initialLoading: true,
    refreshing: false,
    refreshError: "",
    lastSuccessfulFetchAt: null,
    missingMessage: "",
    trip: null
  });
  const mountedRef = useRef(true);

  const loadTrip = useCallback(
    async ({ initial = false }: { initial?: boolean } = {}) => {
      if (!isSupabaseConfigured || !supabase) {
        setLoadState((current) => ({
          ...current,
          initialLoading: false,
          refreshing: false,
          refreshError: "Supabase 環境變數未設定。",
          missingMessage: current.trip ? "" : "Supabase 環境變數未設定。",
          trip: current.trip
        }));
        return;
      }

      setLoadState((current) => ({
        ...current,
        initialLoading: initial && !current.trip,
        refreshing: !initial,
        refreshError: initial ? "" : current.refreshError
      }));

      const { data, error } = await supabase.from("trips").select("*").eq("share_code", shareCode).maybeSingle();
      if (!mountedRef.current) {
        return;
      }

      if (error) {
        setLoadState((current) => ({
          ...current,
          initialLoading: false,
          refreshing: false,
          refreshError: `更新失敗，稍後再試：${error.message}`,
          missingMessage: current.trip ? "" : `Supabase 查詢錯誤：${error.message}`
        }));
        return;
      }

      if (!data) {
        setLoadState((current) => ({
          ...current,
          initialLoading: false,
          refreshing: false,
          refreshError: "",
          missingMessage: `找不到行程代碼：${shareCode}。行程可能已結束，或代碼輸入錯誤。`,
          trip: current.trip
        }));
        return;
      }

      setLoadState({
        initialLoading: false,
        refreshing: false,
        refreshError: "",
        lastSuccessfulFetchAt: new Date().toISOString(),
        missingMessage: "",
        trip: normalizeTripRow(data as CloudTripRow, shareCode)
      });
    },
    [shareCode]
  );

  useEffect(() => {
    mountedRef.current = true;
    void loadTrip({ initial: true });
    const interval = window.setInterval(() => {
      void loadTrip();
    }, SHARE_POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      stopAlertSoundLoop();
    };
  }, [loadTrip]);

  if (loadState.initialLoading && !loadState.trip) {
    return (
      <main className="app-shell share-shell">
        <section className="card">
          <p className="eyebrow">GeoClock 家人查看</p>
          <h1>正在讀取...</h1>
          <p className="muted">行程代碼：{shareCode}</p>
        </section>
      </main>
    );
  }

  if (!loadState.trip) {
    return (
      <main className="app-shell share-shell">
        <section className="card">
          <p className="eyebrow">GeoClock 家人查看</p>
          <h1>找不到共享行程</h1>
          <p className="code">行程代碼：{shareCode}</p>
          <p className="warning">{loadState.missingMessage || loadState.refreshError}</p>
          <button className="secondary-button" onClick={() => void loadTrip({ initial: true })} type="button">
            重新載入
          </button>
        </section>
      </main>
    );
  }

  return (
    <SharedTripView
      lastSuccessfulFetchAt={loadState.lastSuccessfulFetchAt}
      onReload={() => void loadTrip()}
      refreshError={loadState.refreshError}
      refreshing={loadState.refreshing}
      trip={loadState.trip}
    />
  );
}

function SharedTripView({
  lastSuccessfulFetchAt,
  onReload,
  refreshError,
  refreshing,
  trip
}: {
  lastSuccessfulFetchAt: string | null;
  onReload: () => void;
  refreshError: string;
  refreshing: boolean;
  trip: CloudTripRow;
}) {
  const router = useRouter();
  const [wakeStatus, setWakeStatus] = useState<WakeStatus>("idle");
  const [wakeMessage, setWakeMessage] = useState("每按一次呼叫，會送出一次通知給對方。");
  const [wakeDetail, setWakeDetail] = useState("");
  const [notificationState, setNotificationState] = useState<ShareNotificationState>({
    status: "尚未啟用",
    message: "啟用後，對方快到、抵達或位置更新暫停時，你會收到系統通知。"
  });
  const [notificationDiagnostics, setNotificationDiagnostics] = useState<NotificationDiagnostic[]>([]);
  const [viewerCode, setViewerCode] = useState("");
  const [viewerAlertSoundStatus, setViewerAlertSoundStatus] = useState<"尚未測試" | "已解鎖" | "提醒中">("尚未測試");
  const [viewerAlertMessage, setViewerAlertMessage] = useState("畫面開著時會響；背景只會收到系統通知。");
  const health = getSharedHealth(trip);
  const statusLabel = getShareStatusLabel(trip);
  const tripActive = isTripActive(trip);
  const tripEnded = isTripEnded(trip);
  const tripExpired = isTripExpired(trip);
  const viewerCanWake = canWakeOwner(trip);
  const destinationLabel = getDestinationLabel(trip);
  const destination = useMemo<Destination>(
    () => ({
      id: trip.share_code,
      name: destinationLabel,
      address: trip.destination_address ?? "",
      lat: trip.destination_lat,
      lng: trip.destination_lng,
      createdAt: trip.started_at,
      updatedAt: trip.started_at,
      lastUsedAt: trip.started_at
    }),
    [destinationLabel, trip]
  );
  const familyPosition = getFamilyPosition(trip);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryViewer = params.get("viewer")?.trim().toUpperCase();
    const storedViewer = window.localStorage.getItem(VIEWER_CODE_STORAGE_KEY);
    const nextViewerCode = queryViewer || storedViewer || createFamilyViewerCode();
    window.localStorage.setItem(VIEWER_CODE_STORAGE_KEY, nextViewerCode);
    setViewerCode(nextViewerCode);
    void getNotificationDiagnostics().then(setNotificationDiagnostics);

    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationState({
        status: "此瀏覽器不支援",
        message: "此瀏覽器不支援 Web Push。iPhone 需要加入主畫面後從主畫面開啟。"
      });
      return;
    }

    if (Notification.permission === "granted") {
      setNotificationState({
        status: "已啟用",
        message: "通知權限已允許。如仍顯示訂閱未完成，可以再按一次啟用家人通知。"
      });
    } else if (Notification.permission === "denied") {
      setNotificationState({
        status: "被拒絕",
        message: "通知權限被拒絕，請到 Safari 網站設定中允許通知。"
      });
    }
  }, []);

  useEffect(() => {
    const shouldAlert = isViewerAlertCondition(trip, health);
    if (!tripActive || !shouldAlert) {
      stopAlertSoundLoop();
      setViewerAlertSoundStatus("已解鎖");
      return;
    }

    setViewerAlertSoundStatus("提醒中");
    startAlertSoundLoop({
      playMs: 5000,
      intervalMs: 10000,
      onError: (error) => setViewerAlertMessage(`提醒聲播放失敗：${error}`)
    });
  }, [trip.distance_m, trip.alert_radius_m, trip.arrival_radius_m, trip.last_location_at, trip.ended_at, trip.expires_at, health, tripActive]);

  async function testViewerAlertSound() {
    const unlocked = await unlockAlertSound();
    if (!unlocked.ok) {
      setViewerAlertMessage(unlocked.error ?? "提示音被瀏覽器阻擋，請再點一次測試提示音。");
      return;
    }
    const played = await playAlertSoundFor(5000);
    if (!played.ok) {
      setViewerAlertMessage(played.error ?? "提示音播放失敗。");
      return;
    }
    setViewerAlertSoundStatus("已解鎖");
    setViewerAlertMessage("提示音已解鎖。畫面開著時會響；背景只會收到系統通知。");
  }

  async function enableViewerNotifications() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationState({
        status: "此瀏覽器不支援",
        message: "此瀏覽器不支援 Web Push。iPhone Safari 需要加入主畫面後使用。"
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(null, "此瀏覽器不支援 Web Push"));
      return;
    }

    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
      setNotificationState({
        status: "此瀏覽器不支援",
        message: "VAPID public key 未設定，無法啟用通知。"
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(null, "VAPID public key 未設定"));
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await registration.update().catch(() => undefined);
      setNotificationDiagnostics(await getNotificationDiagnostics(null, "Service Worker 已註冊"));

      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission === "denied") {
        setNotificationState({
          status: "被拒絕",
          message: "通知權限被拒絕，請到 Safari 網站設定中允許通知。"
        });
        setNotificationDiagnostics(await getNotificationDiagnostics(null, "通知權限被拒絕"));
        return;
      }
      if (permission !== "granted") {
        setNotificationState({
          status: "尚未啟用",
          message: "尚未允許通知。請再按一次啟用家人通知。"
        });
        setNotificationDiagnostics(await getNotificationDiagnostics(null, "尚未允許通知"));
        return;
      }

      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
        }));
      setNotificationDiagnostics(await getNotificationDiagnostics(subscription, "PushSubscription 已取得"));

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          role: "viewer",
          user_code: viewerCode || undefined,
          share_code: trip.share_code,
          subscription: subscription.toJSON()
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? "Supabase 訂閱寫入失敗。");
      }

      setNotificationState({
        status: "已啟用",
        message: "家人通知已啟用。對方快到、抵達或位置更新暫停時，你會收到通知。"
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(subscription, "Supabase 訂閱寫入：已寫入"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "通知設定失敗。";
      setNotificationState({
        status: "尚未啟用",
        message
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(null, message));
    }
  }

  async function callOwner() {
    if (wakeStatus === "sending") {
      return;
    }
    if (!canWakeOwner(trip)) {
      setWakeStatus("error");
      setWakeMessage("這趟行程已結束或已失效，不能再呼叫對方。");
      return;
    }

    setWakeStatus("sending");
    setWakeMessage("正在送出呼叫...");
    setWakeDetail("");

    try {
      const response = await fetch("/api/wake/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          shareCode: trip.share_code,
          fromViewerCode: viewerCode || undefined
        })
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        id?: string;
        status?: string;
        message?: string;
        diagnostics?: {
          ownerSubscriptions: number;
          pushSuccess: number;
          pushFailed: number;
          errors: string[];
        };
      };

      if (payload.diagnostics) {
        setWakeDetail(formatWakeDiagnostics(payload.diagnostics));
      }

      if (!response.ok || !payload.ok) {
        setWakeStatus("error");
        setWakeMessage(payload.message ?? "呼叫失敗，請稍後再試。");
        return;
      }

      setWakeStatus("sent");
      setWakeMessage("已送出呼叫。");
    } catch (error) {
      setWakeStatus("error");
      setWakeMessage(`呼叫失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    }
  }

  function safeBack() {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/");
  }

  return (
    <main className="app-shell share-shell">
      <header className="topbar">
        <button className="secondary-button small-button" onClick={safeBack} type="button">
          返回
        </button>
        <div>
          <p className="eyebrow">GeoClock 家人查看</p>
          <h1>{statusLabel}</h1>
          <p className="muted">行程代碼：{trip.share_code}</p>
          <p className="field-hint">
            {refreshing ? "更新中..." : lastSuccessfulFetchAt ? `最後更新：${formatTime(lastSuccessfulFetchAt)}` : "尚未更新"}
          </p>
          {refreshError ? <p className="field-hint warning">{refreshError}</p> : null}
        </div>
        <button className="secondary-button small-button" onClick={onReload} type="button">
          重新載入
        </button>
      </header>

      <section className="card">
        <p className="eyebrow">行程狀態</p>
        <div className="status-grid">
          <Metric label="狀態" value={statusLabel} />
          <Metric label="目的地" value={destinationLabel} />
          <Metric label="距離目的地" value={formatDistance(trip.distance_m ?? undefined)} />
          <Metric label="最後位置更新" value={formatDateTime(trip.last_location_at)} />
          <Metric label="家人目前位置" value={familyPosition ? formatCoordinate(familyPosition) : "尚未取得家人位置"} />
          <Metric label="快到提醒距離" value={formatDistance(trip.alert_radius_m)} />
          <Metric label="已抵達判斷距離" value={formatDistance(trip.arrival_radius_m ?? 100)} />
        </div>
      </section>

      <section className="journey-panel active">
        <div>
          <p className="eyebrow">家人目前位置與目的地</p>
          <h2>{destinationLabel}</h2>
          <p className="muted">{familyPosition ? "地圖顯示家人目前位置與目的地。" : "尚未取得家人位置，地圖先顯示目的地。"}</p>
        </div>
        <div className="map-block">
          <TripMap
            currentLabel="家人目前位置"
            currentPosition={familyPosition}
            destination={destination}
            destinationLabel="目的地"
            radiusMeters={trip.alert_radius_m}
          />
          <div className="map-summary">
            <Metric label="家人目前位置" value={familyPosition ? formatCoordinate(familyPosition) : "尚未取得家人位置"} />
            <Metric label="目的地" value={destinationLabel} />
            <Metric label="距離目的地" value={`約 ${formatDistance(trip.distance_m ?? undefined)}`} />
            <Metric label="最後更新" value={formatDateTime(trip.last_location_at)} />
          </div>
        </div>
      </section>

      <section className="card cloud-share-card">
        <p className="eyebrow">操作</p>
        <div className="status-grid">
          <Metric label="家人通知" value={notificationState.status} />
          <Metric label="提醒聲" value={viewerAlertSoundStatus} />
        </div>
        <p className="notice">背景通知會透過系統通知提醒；畫面開著時，可額外播放提示聲。</p>
        <p className="muted">通知功能需將網站加入 iPhone 主畫面後使用。Web Push 不是原生鬧鐘，不能保證無視靜音。</p>
        <p className="muted">{getStandaloneHint()}</p>
        <p className={notificationState.status === "被拒絕" || notificationState.status === "此瀏覽器不支援" ? "warning" : "muted"}>
          {notificationState.message}
        </p>
        {!tripActive ? (
          <p className="warning">
            {tripEnded
              ? "這趟行程已由對方結束，不能再呼叫。"
              : tripExpired
                ? "這趟行程已超過有效時間，不能再呼叫。"
                : "這趟行程目前不可互動。"}
          </p>
        ) : null}
        <p className="muted">{viewerAlertMessage}</p>
        {tripActive ? (
        <div className="trip-actions">
          <button className="primary-button" onClick={enableViewerNotifications} type="button">
            啟用家人通知
          </button>
          <button className="secondary-button" onClick={testViewerAlertSound} type="button">
            測試提醒聲
          </button>
          <button className="secondary-button" disabled={wakeStatus === "sending" || !viewerCanWake} onClick={callOwner} type="button">
            呼叫對方
          </button>
        </div>
        ) : null}
        <p className={wakeStatus === "error" ? "warning" : "muted"}>{wakeMessage}</p>
        {wakeStatus === "sent" ? <p className="muted">本次呼叫已送出 1 次通知。可以再次按呼叫送出下一次。</p> : null}
        {wakeDetail ? <p className="field-hint">{wakeDetail}</p> : null}
      </section>

      <details className="card advanced-settings">
        <summary>進階診斷</summary>
        <div className="diagnostic-summary">
          <p className="muted">
            {notificationState.status === "已啟用" ? "通知設定完成。" : "通知尚未完成設定，點開查看原因。"}
          </p>
        </div>
        <label>
          我的家人代碼
          <input
            value={viewerCode}
            onChange={(event) => {
              const nextCode = event.target.value.toUpperCase();
              setViewerCode(nextCode);
              window.localStorage.setItem(VIEWER_CODE_STORAGE_KEY, nextCode);
            }}
            placeholder="例如 FAMILY-1234"
          />
        </label>
        <DiagnosticList items={notificationDiagnostics} />
      </details>
    </main>
  );
}

function DiagnosticList({ items }: { items: NotificationDiagnostic[] }) {
  if (items.length === 0) {
    return <p className="field-hint">尚未取得通知診斷。</p>;
  }

  return (
    <div className="diagnostic-list">
      {items.map((item) => (
        <div className="diagnostic-row" key={item.label}>
          <span>{item.label}</span>
          <strong className={item.ok ? "good" : "warning"}>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getDestinationLabel(trip: CloudTripRow) {
  return trip.destination_name?.trim() || trip.destination_address?.trim() || "目的地";
}

function getFamilyPosition(trip: CloudTripRow): CurrentPosition | undefined {
  if (typeof trip.current_lat === "number" && typeof trip.current_lng === "number") {
    return {
      lat: trip.current_lat,
      lng: trip.current_lng,
      updatedAt: trip.last_location_at ?? trip.started_at
    };
  }
  if (typeof trip.approximate_lat === "number" && typeof trip.approximate_lng === "number") {
    return {
      lat: trip.approximate_lat,
      lng: trip.approximate_lng,
      updatedAt: trip.last_location_at ?? trip.started_at
    };
  }
  return undefined;
}

function formatCoordinate(position: CurrentPosition) {
  return `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
}

function normalizeTripRow(row: CloudTripRow, shareCode: string): CloudTripRow {
  return {
    ...row,
    id: row.id ?? shareCode,
    share_code: row.share_code ?? shareCode,
    owner_code: row.owner_code ?? "UNKNOWN",
    destination_name: row.destination_name ?? "未命名目的地",
    destination_address: row.destination_address ?? "",
    destination_lat: Number(row.destination_lat ?? 0),
    destination_lng: Number(row.destination_lng ?? 0),
    alert_radius_m: Number(row.alert_radius_m ?? 500),
    arrival_radius_m: Number(row.arrival_radius_m ?? 100),
    status: row.status ?? "行程中",
    distance_m: typeof row.distance_m === "number" ? row.distance_m : null,
    current_lat: typeof row.current_lat === "number" ? row.current_lat : null,
    current_lng: typeof row.current_lng === "number" ? row.current_lng : null,
    approximate_lat: typeof row.approximate_lat === "number" ? row.approximate_lat : null,
    approximate_lng: typeof row.approximate_lng === "number" ? row.approximate_lng : null,
    last_location_at: row.last_location_at ?? null,
    started_at: row.started_at ?? new Date().toISOString(),
    ended_at: row.ended_at ?? null,
    expires_at: row.expires_at ?? null,
    duration_minutes: row.duration_minutes ?? null
  };
}

function createFamilyViewerCode() {
  return `FAMILY-${Math.floor(1000 + Math.random() * 9000)}`;
}

function formatWakeDiagnostics(diagnostics: { ownerSubscriptions: number; pushSuccess: number; pushFailed: number; errors: string[] }) {
  const errorText = diagnostics.errors.length > 0 ? `，原因：${diagnostics.errors.join("、")}` : "";
  return `找到 ${diagnostics.ownerSubscriptions} 個對方通知訂閱，成功 ${diagnostics.pushSuccess} 個，失敗 ${diagnostics.pushFailed} 個${errorText}`;
}

function getSharedHealth(trip: CloudTripRow) {
  if (isTripEnded(trip)) {
    return "ended";
  }
  if (isTripExpired(trip)) {
    return "needs_extend";
  }
  if (!trip.last_location_at) {
    return "unknown";
  }
  const ageMs = Date.now() - new Date(trip.last_location_at).getTime();
  if (Number.isNaN(ageMs)) {
    return "unknown";
  }
  if (ageMs > 30 * 60 * 1000) {
    return "expired";
  }
  if (ageMs > 5 * 60 * 1000) {
    return "lost";
  }
  if (ageMs > 60 * 1000) {
    return "paused";
  }
  return "ok";
}

function getShareStatusLabel(trip: CloudTripRow) {
  const lifecycleStatus = getTripDisplayStatus(trip);
  if (lifecycleStatus === "行程已結束" || lifecycleStatus === "行程有效時間已到，正在嘗試延長") {
    return lifecycleStatus;
  }
  const health = getSharedHealth(trip);
  if (health === "needs_extend") {
    return "行程有效時間已到，等待對方回到畫面更新";
  }
  if (health === "lost") {
    return "定位可能中斷";
  }
  if (health === "paused") {
    return "位置更新暫停";
  }
  return trip.status || "行程中";
}

function isViewerAlertCondition(trip: CloudTripRow, health: string) {
  if (!isTripActive(trip)) {
    return false;
  }
  const arrivalRadiusMeters = trip.arrival_radius_m ?? 100;
  if (typeof trip.distance_m === "number" && trip.distance_m <= trip.alert_radius_m) {
    return true;
  }
  if (typeof trip.distance_m === "number" && trip.distance_m <= arrivalRadiusMeters) {
    return true;
  }
  return health === "paused" || health === "lost";
}

async function getCurrentPushEndpoint() {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  return subscription?.endpoint ?? null;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "尚未取得";
  }
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
