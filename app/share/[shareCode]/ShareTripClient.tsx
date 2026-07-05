"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistance, getLocationHealth } from "@/lib/geo";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";
import type { CloudTripRow, CurrentPosition, Destination, LocationHealth } from "@/lib/types";

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

export default function ShareTripClient({ shareCode }: { shareCode: string }) {
  const [state, setState] = useState<ShareState>({
    status: "loading",
    message: "正在讀取共享行程..."
  });

  useEffect(() => {
    let disposed = false;

    async function loadTrip() {
      if (!isSupabaseConfigured || !supabase) {
        setState({
          status: "error",
          message: "尚未設定 Supabase，無法讀取共享行程。"
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
          message: "共享行程暫時無法讀取，請稍後再試。"
        });
        return;
      }

      if (!data) {
        setState({
          status: "missing",
          message: "找不到這趟共享行程，可能已結束或連結錯誤。"
        });
        return;
      }

      setState({ status: "ready", trip: data });
    }

    void loadTrip();
    const interval = window.setInterval(loadTrip, 15000);
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
          <p className={state.status === "loading" ? "muted" : "warning"}>{state.message}</p>
        </section>
      </main>
    );
  }

  return <SharedTripView trip={state.trip} />;
}

function SharedTripView({ trip }: { trip: CloudTripRow }) {
  const [wakeStatus, setWakeStatus] = useState<"idle" | "calling" | "acknowledged" | "ended" | "error">("idle");
  const [wakeMessage, setWakeMessage] = useState("這會連續推播提醒對方，最多 15 秒。");
  const [wakeCount, setWakeCount] = useState(0);
  const [notificationState, setNotificationState] = useState<ShareNotificationState>({
    status: "尚未啟用",
    message: "啟用後，對方快到、抵達或定位中斷時，你會收到通知。"
  });
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
    if (health !== "中斷" || trip.ended_at) {
      return;
    }

    void notifyTripEvents(trip.share_code);
  }, [health, trip.ended_at, trip.share_code]);

  async function callOwner() {
    if (wakeStatus === "calling") {
      return;
    }

    wakeStoppedRef.current = false;
    wakeRequestIdRef.current = null;
    setWakeStatus("calling");
    setWakeCount(0);
    setWakeMessage("呼叫中...");

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
          wakeRequestId: wakeRequestIdRef.current
        })
      });
      const payload = (await response.json()) as {
        id?: string;
        status?: string;
        message?: string;
      };

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

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          shareCode: trip.share_code,
          role: "viewer",
          subscription: subscription.toJSON()
        })
      });

      if (!response.ok) {
        throw new Error("subscribe failed");
      }

      setNotificationState({
        status: "已啟用",
        message: "家人通知已啟用。對方快到、抵達或定位中斷時，你會收到通知。"
      });
    } catch {
      setNotificationState({
        status: "尚未啟用",
        message: "通知訂閱失敗。iPhone 請確認已加入主畫面並從主畫面開啟。"
      });
    }
  }

  return (
    <main className="app-shell share-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">GeoClock 共享行程</p>
          <h1>家人查看</h1>
        </div>
      </header>

      <section className="card">
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
        <p className="eyebrow">家人通知</p>
        <h2>{notificationState.status}</h2>
        <p className="notice">啟用後，對方快到、抵達或定位中斷時，你會收到通知。</p>
        <p className="muted">iPhone 需要先分享 → 加入主畫面，再從主畫面開啟 GeoClock 才能使用 Web Push。</p>
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
      </section>

      <section className="card cloud-share-card">
        <p className="eyebrow">呼叫提醒</p>
        <h2>{wakeStatus === "calling" ? "呼叫中" : wakeStatus === "acknowledged" ? "對方已回應" : "呼叫對方"}</h2>
        <p className={wakeStatus === "error" ? "warning" : "muted"}>{wakeMessage}</p>
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

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && Boolean(navigator.standalone));
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((character) => character.charCodeAt(0)));
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getSharedHealth(trip: CloudTripRow): LocationHealth {
  if (trip.ended_at) {
    return "正常";
  }
  return getLocationHealth(trip.last_location_at ?? undefined);
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
