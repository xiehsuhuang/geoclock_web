"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistance, getLocationHealth } from "@/lib/geo";
import { getNotificationDiagnostics, getStandaloneHint, isStandaloneMode, urlBase64ToUint8Array } from "@/lib/notificationDiagnostics";
import { playAlertSoundFor, startAlertSoundLoop, stopAlertSoundLoop, unlockAlertSound } from "@/lib/sound";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";
import type { CloudTripRow, CurrentPosition, Destination, LocationHealth, NotificationDiagnostic } from "@/lib/types";

const TripMap = dynamic(() => import("@/components/TripMap"), {
  ssr: false
});

type ShareState =
  | {
      status: "loading";
      message: string;
    }
  | {
      status: "ready";
      trip: CloudTripRow;
    }
  | {
      status: "missing" | "error";
      message: string;
    };

type ShareNotificationState = {
  status: "尚未啟用" | "已啟用" | "被拒絕" | "此瀏覽器不支援";
  message: string;
};

type PermissionLevel = "status_only" | "notify" | "wake" | null;

const VIEWER_CODE_STORAGE_KEY = "geoclock.web.viewerCode";

export default function ShareTripClient({ shareCode }: { shareCode: string }) {
  const [state, setState] = useState<ShareState>({
    status: "loading",
    message: "正在讀取共享行程..."
  });

  async function loadTrip(disposed = false) {
    setState({
      status: "loading",
      message: "正在讀取共享行程..."
    });

    if (!isSupabaseConfigured || !supabase) {
      setState({
        status: "error",
        message: "Supabase 環境變數未設定：請確認 NEXT_PUBLIC_SUPABASE_URL 與 NEXT_PUBLIC_SUPABASE_ANON_KEY。"
      });
      return;
    }

    const { data, error } = await supabase.from("trips").select("*").eq("share_code", shareCode).maybeSingle();
    if (disposed) {
      return;
    }

    if (error) {
      setState({
        status: "error",
        message: `Supabase 查詢錯誤：${error.message}`
      });
      return;
    }

    if (!data) {
      setState({
        status: "missing",
        message: `找不到行程代碼：${shareCode}。行程可能已結束，或代碼輸入錯誤。`
      });
      return;
    }

    setState({ status: "ready", trip: normalizeTripRow(data as CloudTripRow, shareCode) });
  }

  useEffect(() => {
    let disposed = false;
    void loadTrip(disposed);
    const interval = window.setInterval(() => void loadTrip(disposed), 15000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [shareCode]);

  if (state.status !== "ready") {
    return (
      <main className="app-shell share-shell">
        <section className="card">
          <p className="eyebrow">GeoClock 共享行程</p>
          <h1>家人查看</h1>
          <p className="code">行程代碼：{shareCode}</p>
          <p className={state.status === "loading" ? "muted" : "warning"}>{state.message}</p>
          <button className="secondary-button" onClick={() => void loadTrip()} type="button">
            重新載入
          </button>
        </section>
      </main>
    );
  }

  return <SharedTripView onReload={() => void loadTrip()} trip={state.trip} />;
}

function SharedTripView({ onReload, trip }: { onReload: () => void; trip: CloudTripRow }) {
  const [wakeStatus, setWakeStatus] = useState<"idle" | "calling" | "acknowledged" | "ended" | "error">("idle");
  const [wakeMessage, setWakeMessage] = useState("這會連續推播提醒對方，最多 15 秒。");
  const [wakeCount, setWakeCount] = useState(0);
  const [wakeDetail, setWakeDetail] = useState("");
  const [notificationState, setNotificationState] = useState<ShareNotificationState>({
    status: "尚未啟用",
    message: "啟用後，對方快到、抵達或定位中斷時，你會收到通知。"
  });
  const [notificationDiagnostics, setNotificationDiagnostics] = useState<NotificationDiagnostic[]>([]);
  const [viewerCode, setViewerCode] = useState("");
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>(null);
  const [permissionMessage, setPermissionMessage] = useState("未輸入家人代碼，仍可查看公開 MVP 行程。");
  const [viewerAlertSoundStatus, setViewerAlertSoundStatus] = useState<"未解鎖" | "已解鎖" | "提醒中" | "已停止">("未解鎖");
  const [viewerTripMuted, setViewerTripMuted] = useState(false);
  const [viewerAlertMessage, setViewerAlertMessage] = useState("提醒聲尚未啟用。");
  const wakeRequestIdRef = useRef<string | null>(null);
  const wakeStoppedRef = useRef(false);
  const destination: Destination = useMemo(
    () => ({
      id: trip.share_code,
      name: trip.destination_name,
      address: trip.destination_address ?? "",
      lat: trip.destination_lat,
      lng: trip.destination_lng,
      createdAt: trip.started_at,
      updatedAt: trip.started_at,
      lastUsedAt: trip.started_at
    }),
    [trip]
  );
  const currentPosition: CurrentPosition | undefined =
    typeof trip.approximate_lat === "number" && typeof trip.approximate_lng === "number"
      ? {
          lat: trip.approximate_lat,
          lng: trip.approximate_lng,
          updatedAt: trip.last_location_at ?? trip.started_at
        }
      : undefined;
  const health = getSharedHealth(trip);
  const arrivalRadiusMeters = trip.arrival_radius_m ?? 100;

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
        message: "此瀏覽器不支援 Web Push。iPhone 請確認已加入主畫面並從主畫面開啟。"
      });
      return;
    }

    if (Notification.permission === "granted") {
      setNotificationState({
        status: "已啟用",
        message: "通知權限已允許。若尚未收到通知，請重新按一次啟用家人通知。"
      });
    } else if (Notification.permission === "denied") {
      setNotificationState({
        status: "被拒絕",
        message: "通知權限被拒絕，請到 Safari 網站設定中允許通知。"
      });
    }
  }, []);

  useEffect(() => {
    void loadPermission();
  }, [trip.owner_code, viewerCode]);

  async function loadPermission() {
    if (!viewerCode || !supabase) {
      setPermissionLevel(null);
      setPermissionMessage("未輸入家人代碼，仍可查看公開 MVP 行程。");
      return;
    }

    const { data, error } = await supabase
      .from("permissions")
      .select("permission_level, enabled")
      .eq("owner_code", trip.owner_code)
      .eq("viewer_code", viewerCode)
      .eq("enabled", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      setPermissionLevel(null);
      setPermissionMessage(`權限查詢失敗：${error.message}。仍可查看公開 MVP 行程。`);
      return;
    }

    if (!data) {
      setPermissionLevel(null);
      setPermissionMessage("沒有找到家人權限，仍可查看公開 MVP 行程。");
      return;
    }

    setPermissionLevel(data.permission_level as PermissionLevel);
    setPermissionMessage(`已套用家人權限：${getPermissionLabel(data.permission_level)}`);
  }

  async function refreshViewerMuteStatus() {
    const endpoint = await getCurrentPushEndpoint();
    const query = new URLSearchParams({
      share_code: trip.share_code,
      role: "viewer",
      event_type: "all"
    });
    if (endpoint) {
      query.set("endpoint", endpoint);
    } else if (viewerCode) {
      query.set("user_code", viewerCode);
    } else {
      setViewerTripMuted(false);
      return;
    }

    try {
      const response = await fetch(`/api/notify/mute-status?${query.toString()}`);
      const payload = (await response.json()) as { muted?: boolean };
      setViewerTripMuted(Boolean(payload.muted));
      if (payload.muted) {
        setViewerAlertSoundStatus("已停止");
      }
    } catch {
      setViewerTripMuted(false);
    }
  }

  async function testViewerAlertSound() {
    const unlocked = await unlockAlertSound();
    if (!unlocked.ok) {
      setViewerAlertMessage(unlocked.error ?? "提示音解鎖失敗。");
      return;
    }
    const played = await playAlertSoundFor(5000);
    if (!played.ok) {
      setViewerAlertMessage(played.error ?? "提示音播放失敗。");
      return;
    }
    setViewerAlertSoundStatus("已解鎖");
    setViewerAlertMessage("提示音已解鎖。");
  }

  async function stopViewerTripNotifications() {
    stopAlertSoundLoop();
    setViewerTripMuted(true);
    setViewerAlertSoundStatus("已停止");
    const endpoint = await getCurrentPushEndpoint();

    try {
      const response = await fetch("/api/notify/mute-trip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          share_code: trip.share_code,
          role: "viewer",
          user_code: viewerCode || undefined,
          endpoint: endpoint || undefined,
          event_type: "all"
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setViewerAlertMessage(payload.ok ? "本趟家人通知已停止。" : `停止通知失敗：${payload.error ?? "未知錯誤"}`);
    } catch (error) {
      setViewerAlertMessage(`停止通知失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    }
  }

  useEffect(() => {
    return () => {
      stopAlertSoundLoop();
    };
  }, []);

  useEffect(() => {
    void refreshViewerMuteStatus();
  }, [trip.share_code, viewerCode]);

  useEffect(() => {
    const shouldAlert = isViewerAlertCondition(trip, health);
    if (!shouldAlert || viewerTripMuted) {
      stopAlertSoundLoop();
      if (viewerAlertSoundStatus === "提醒中") {
        setViewerAlertSoundStatus(viewerTripMuted ? "已停止" : "已解鎖");
      }
      return;
    }

    setViewerAlertSoundStatus("提醒中");
    startAlertSoundLoop({
      playMs: 5000,
      intervalMs: 10000,
      onError: (error) => setViewerAlertMessage(`提醒音播放失敗：${error}`)
    });
    void notifyTripEvents(trip.share_code);
  }, [trip.distance_m, trip.alert_radius_m, trip.arrival_radius_m, trip.last_location_at, health, viewerTripMuted, trip.share_code]);

  async function callOwner() {
    if (wakeStatus === "calling") {
      return;
    }
    if (permissionLevel !== "wake") {
      setWakeStatus("error");
      setWakeMessage("這個家人代碼尚未取得可呼叫我的權限。");
      setWakeDetail(permissionMessage);
      return;
    }

    wakeStoppedRef.current = false;
    wakeRequestIdRef.current = null;
    setWakeStatus("calling");
    setWakeCount(0);
    setWakeMessage("呼叫中...");
    setWakeDetail("");

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (wakeStoppedRef.current) {
        break;
      }

      const sent = await sendWakeAttempt(attempt);
      if (!sent) {
        break;
      }
      if (wakeStoppedRef.current || attempt === 5) {
        break;
      }

      await delay(3000);
      const acknowledged = await refreshWakeStatus();
      if (acknowledged) {
        break;
      }
    }

    if (!wakeStoppedRef.current) {
      setWakeStatus("ended");
      setWakeMessage("呼叫結束");
    }
  }

  async function sendWakeAttempt(attempt: number) {
    try {
      const response = await fetch("/api/wake/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          shareCode: trip.share_code,
          wakeRequestId: wakeRequestIdRef.current,
          fromViewerCode: viewerCode || undefined
        })
      });
      const payload = (await response.json()) as {
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

      if (!response.ok) {
        setWakeStatus("error");
        setWakeMessage(payload.message ?? "呼叫失敗，請稍後再試。");
        wakeStoppedRef.current = true;
        return false;
      }

      if (payload.id) {
        wakeRequestIdRef.current = payload.id;
      }
      if (payload.status === "acknowledged") {
        setWakeStatus("acknowledged");
        setWakeMessage("對方已回應");
        wakeStoppedRef.current = true;
        return false;
      }

      setWakeCount(attempt);
      setWakeMessage(`呼叫中，已送出第 ${attempt} 次提醒`);
      return true;
    } catch {
      setWakeStatus("error");
      setWakeMessage("呼叫失敗，請稍後再試。");
      wakeStoppedRef.current = true;
      return false;
    }
  }

  async function refreshWakeStatus() {
    if (!wakeRequestIdRef.current) {
      return false;
    }

    try {
      const response = await fetch(`/api/wake/status?id=${encodeURIComponent(wakeRequestIdRef.current)}`);
      const payload = (await response.json()) as {
        status?: string;
      };
      if (payload.status === "acknowledged") {
        setWakeStatus("acknowledged");
        setWakeMessage("對方已回應");
        wakeStoppedRef.current = true;
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  async function enableViewerNotifications() {
    setNotificationDiagnostics(await getNotificationDiagnostics());
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationState({
        status: "此瀏覽器不支援",
        message: "此瀏覽器不支援 Web Push。iPhone 請確認已加入主畫面並從主畫面開啟。"
      });
      return;
    }

    if (!isStandaloneMode()) {
      setNotificationState({
        status: "尚未啟用",
        message: "iPhone 請先分享 → 加入主畫面，再從主畫面開啟 GeoClock 啟用通知。"
      });
    }

    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
      setNotificationState({
        status: "此瀏覽器不支援",
        message: "尚未設定 VAPID public key，無法啟用通知。"
      });
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission === "denied") {
      setNotificationState({
        status: "被拒絕",
        message: "通知權限被拒絕，請到 Safari 網站設定中允許通知。"
      });
      return;
    }
    if (permission !== "granted") {
      setNotificationState({
        status: "尚未啟用",
        message: "尚未允許通知。"
      });
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(subscription, "尚未寫入"));

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          userCode: viewerCode || undefined,
          shareCode: trip.share_code,
          role: "viewer",
          subscription: subscription.toJSON()
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? "通知訂閱寫入 Supabase 失敗");
      }

      setNotificationState({
        status: "已啟用",
        message: "家人通知已啟用。對方快到、抵達或定位中斷時，你會收到通知。"
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(subscription, "成功"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "通知訂閱失敗";
      setNotificationState({
        status: "尚未啟用",
        message: `通知訂閱失敗：${message}`
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(null, message));
    }
  }

  return (
    <main className="app-shell share-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">GeoClock 共享行程</p>
          <h1>家人查看</h1>
          <p className="code">行程代碼：{trip.share_code}</p>
        </div>
        <button className="secondary-button small-button" onClick={onReload} type="button">
          重新載入
        </button>
      </header>

      <section className="card">
        <div className="status-grid">
          <Metric label="行程代碼" value={trip.share_code} />
          <Metric label="我的家人代碼" value={viewerCode || "尚未取得"} />
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
            placeholder="例如：FAMILY-1234"
          />
        </label>
        <p className="muted">{permissionMessage}</p>
        <p className="notice">此頁顯示的是粗略位置，非精準定位。</p>
        <p className="notice">這會連續推播提醒對方，最多 15 秒。</p>
        {health === "中斷" && !trip.ended_at ? <p className="warning">定位可能中斷</p> : null}
        <div className="status-grid">
          <Metric label="行程狀態" value={trip.ended_at ? "已結束" : trip.status} />
          <Metric label="目的地" value={trip.destination_name} />
          <Metric label="距離目的地" value={formatDistance(trip.distance_m ?? undefined)} />
          <Metric label="最後更新時間" value={formatDateTime(trip.last_location_at)} />
          <Metric label="定位健康度" value={trip.ended_at ? "已結束" : health === "中斷" ? "定位可能中斷" : health} />
          <Metric label="快到提醒距離" value={formatDistance(trip.alert_radius_m)} />
          <Metric label="已抵達判斷距離" value={formatDistance(arrivalRadiusMeters)} />
        </div>
      </section>

      <section className="card cloud-share-card">
        <p className="eyebrow">家人提醒</p>
        <div className="status-grid">
          <Metric label="提醒聲狀態" value={viewerAlertSoundStatus} />
          <Metric label="本趟家人通知" value={viewerTripMuted ? "已停止" : "啟用中"} />
        </div>
        <p className="notice">分享頁開著時會每 10 秒檢查一次，符合條件時每次響約 5 秒。</p>
        <p className="muted">背景或鎖屏時只能依賴系統通知聲。</p>
        <p className={viewerTripMuted ? "good" : "muted"}>{viewerAlertMessage}</p>
        <div className="trip-actions">
          <button className="secondary-button" onClick={testViewerAlertSound} type="button">
            測試提示音
          </button>
          <button className="primary-button" disabled={viewerTripMuted} onClick={stopViewerTripNotifications} type="button">
            收到，停止本趟通知
          </button>
        </div>
      </section>

      <section className="card cloud-share-card">
        <p className="eyebrow">家人通知</p>
        <h2>{notificationState.status}</h2>
        <p className="notice">啟用後，對方快到、抵達或定位中斷時，你會收到通知。</p>
        <p className="muted">{getStandaloneHint()}</p>
        <p className={notificationState.status === "被拒絕" || notificationState.status === "此瀏覽器不支援" ? "warning" : "muted"}>
          {notificationState.message}
        </p>
        <button
          className="primary-button"
          disabled={notificationState.status === "被拒絕" || notificationState.status === "此瀏覽器不支援"}
          onClick={enableViewerNotifications}
          type="button"
        >
          啟用家人通知
        </button>
        <DiagnosticList items={notificationDiagnostics} />
      </section>

      <section className="card cloud-share-card">
        <p className="eyebrow">呼叫提醒</p>
        <h2>{wakeStatus === "calling" ? "呼叫中" : wakeStatus === "acknowledged" ? "對方已回應" : "呼叫對方"}</h2>
        <p className={wakeStatus === "error" ? "warning" : "muted"}>{wakeMessage}</p>
        {permissionLevel !== "wake" ? <p className="warning">需要「可呼叫我」權限才可以呼叫對方。</p> : null}
        {wakeDetail ? <p className="field-hint">{wakeDetail}</p> : null}
        {wakeStatus === "calling" ? <p className="muted">已送出第 {wakeCount} 次提醒</p> : null}
        <button className="primary-button" disabled={wakeStatus === "calling" || Boolean(trip.ended_at)} onClick={callOwner} type="button">
          呼叫對方
        </button>
      </section>

      <section className="journey-panel active">
        <div>
          <p className="eyebrow">粗略位置地圖</p>
          <h2>{trip.ended_at ? "已結束" : trip.status}</h2>
          <p className="journey-destination">{trip.destination_name}</p>
        </div>
        <div className="map-block">
          <TripMap currentPosition={currentPosition} destination={destination} radiusMeters={trip.alert_radius_m} />
          <div className="map-summary">
            <Metric label="目前位置最後更新" value={formatDateTime(trip.last_location_at)} />
            <Metric label="目的地" value={trip.destination_name} />
            <Metric label="距離目的地" value={formatDistance(trip.distance_m ?? undefined)} />
            <Metric label="快到提醒距離" value={formatDistance(trip.alert_radius_m)} />
            <Metric label="已抵達判斷距離" value={formatDistance(arrivalRadiusMeters)} />
          </div>
        </div>
      </section>
    </main>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

async function notifyTripEvents(shareCode: string) {
  try {
    await fetch("/api/notify/trip-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        shareCode
      })
    });
  } catch {
    // 自動通知檢查失敗不應影響家人查看頁。
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
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
    ended_at: row.ended_at ?? null
  };
}

function createFamilyViewerCode() {
  return `FAMILY-${Math.floor(1000 + Math.random() * 9000)}`;
}

function getPermissionLabel(permission: string) {
  if (permission === "status_only") {
    return "只看狀態";
  }
  if (permission === "notify") {
    return "接收到站通知";
  }
  if (permission === "wake") {
    return "可呼叫我";
  }
  return permission;
}

function formatWakeDiagnostics(diagnostics: { ownerSubscriptions: number; pushSuccess: number; pushFailed: number; errors: string[] }) {
  const errorText = diagnostics.errors.length > 0 ? `，原因：${diagnostics.errors.join("；")}` : "";
  return `找到 ${diagnostics.ownerSubscriptions} 個本人通知訂閱，成功送出 ${diagnostics.pushSuccess} 個，失敗 ${diagnostics.pushFailed} 個${errorText}`;
}

function getSharedHealth(trip: CloudTripRow): LocationHealth {
  if (trip.ended_at) {
    return "正常";
  }
  return getLocationHealth(trip.last_location_at ?? undefined);
}

function isViewerAlertCondition(trip: CloudTripRow, health: LocationHealth) {
  if (trip.ended_at) {
    return false;
  }
  const arrivalRadiusMeters = trip.arrival_radius_m ?? 100;
  if (typeof trip.distance_m === "number" && trip.distance_m <= trip.alert_radius_m) {
    return true;
  }
  if (typeof trip.distance_m === "number" && trip.distance_m <= arrivalRadiusMeters) {
    return true;
  }
  return health === "中斷";
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
