import type { NotificationDiagnostic } from "./types";

export async function getNotificationDiagnostics(subscription?: PushSubscription | null, supabaseWrite?: string): Promise<NotificationDiagnostic[]> {
  const hasWindow = typeof window !== "undefined";
  const serviceWorkerSupported = hasWindow && "serviceWorker" in navigator;
  const pushSupported = hasWindow && "PushManager" in window;
  const notificationSupported = hasWindow && "Notification" in window;
  const isHttps = hasWindow && (window.location.protocol === "https:" || window.location.hostname === "localhost");
  const registration = serviceWorkerSupported ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;

  return [
    {
      label: "Service Worker 支援",
      value: serviceWorkerSupported ? "支援" : "不支援",
      ok: serviceWorkerSupported
    },
    {
      label: "PushManager 支援",
      value: pushSupported ? "支援" : "不支援",
      ok: pushSupported
    },
    {
      label: "通知權限",
      value: notificationSupported ? Notification.permission : "此瀏覽器不支援 Notification",
      ok: notificationSupported && Notification.permission === "granted"
    },
    {
      label: "HTTPS 狀態",
      value: isHttps ? "可用" : "目前不是 HTTPS",
      ok: isHttps
    },
    {
      label: "Service Worker 註冊",
      value: registration ? "已註冊" : "尚未註冊",
      ok: Boolean(registration)
    },
    {
      label: "PushSubscription",
      value: subscription ? "已取得" : "尚未取得",
      ok: Boolean(subscription)
    },
    {
      label: "Supabase 訂閱寫入",
      value: supabaseWrite ?? "尚未寫入",
      ok: supabaseWrite === "成功"
    }
  ];
}

export function getStandaloneHint() {
  return "iPhone 必須先用 Safari 加入主畫面，並從主畫面打開 GeoClock。直接在 Safari 分頁中可能無法啟用 Web Push；Web Push 不是原生鬧鐘，不能保證無視靜音。";
}

export function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && Boolean(navigator.standalone));
}

export function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((character) => character.charCodeAt(0)));
}
