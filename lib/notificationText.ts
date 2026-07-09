type TripTextLike = {
  owner_code?: string | null;
  owner_display_name?: string | null;
  destination_name?: string | null;
  destination_address?: string | null;
  distance_m?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
  arrived_at?: string | null;
};

type NotificationText = {
  title: string;
  body: string;
};

export function getDisplayName(userCode?: string | null, displayName?: string | null) {
  return displayName?.trim() || userCode?.trim() || "對方";
}

export function getDestinationLabel(trip: TripTextLike) {
  return trip.destination_name?.trim() || trip.destination_address?.trim() || "目的地";
}

export function buildTestNotification(): NotificationText {
  return {
    title: "GeoClock 測試通知",
    body: "你可以收到背景通知。"
  };
}

export function buildCallableTestNotification(): NotificationText {
  return {
    title: "GeoClock 呼叫測試",
    body: "你可以收到家人呼叫通知。"
  };
}

export function buildTripStartedNotification(trip: TripTextLike, role: "owner" | "viewer" = "viewer"): NotificationText {
  const destination = getDestinationLabel(trip);
  const startTime = formatTaiwanTime(trip.started_at);
  if (role === "owner") {
    return {
      title: `已開始前往 ${destination}`,
      body: `出發時間：${startTime}`
    };
  }
  return {
    title: `${getDisplayName(trip.owner_code, trip.owner_display_name)}即將前往 ${destination}`,
    body: `出發時間：${startTime}。點擊查看目前行程狀態。`
  };
}

export function buildTripEndedNotification(trip: TripTextLike, role: "owner" | "viewer" = "viewer"): NotificationText {
  const destination = getDestinationLabel(trip);
  const endTime = formatTaiwanTime(trip.ended_at);
  const duration = formatTripDurationBetween(trip.started_at, trip.ended_at);
  if (role === "owner") {
    return {
      title: `已結束前往 ${destination} 的行程`,
      body: `結束時間：${endTime}，總用時：${duration}`
    };
  }
  return {
    title: `${getDisplayName(trip.owner_code, trip.owner_display_name)}已結束前往 ${destination} 的行程`,
    body: `結束時間：${endTime}，總用時：${duration}。`
  };
}

export function buildNearDestinationNotification(trip: TripTextLike, role: "owner" | "viewer"): NotificationText {
  const destination = getDestinationLabel(trip);
  const nearTime = formatTaiwanTime();
  if (role === "owner") {
    return {
      title: `快到 ${destination} 了`,
      body: `快到達時間：${nearTime}`
    };
  }
  return {
    title: `${getDisplayName(trip.owner_code, trip.owner_display_name)}快抵達 ${destination}`,
    body: `快抵達時間：${nearTime}。點擊查看目前行程狀態。`
  };
}

export function buildArrivedNotification(trip: TripTextLike, role: "owner" | "viewer"): NotificationText {
  const destination = getDestinationLabel(trip);
  const arrivedTime = formatTaiwanTime(trip.arrived_at);
  const duration = formatTripDurationBetween(trip.started_at, trip.arrived_at);
  if (role === "owner") {
    return {
      title: `已抵達 ${destination}`,
      body: `抵達時間：${arrivedTime}，GeoClock 已自動結束這趟行程。`
    };
  }
  return {
    title: `${getDisplayName(trip.owner_code, trip.owner_display_name)}已經抵達 ${destination}`,
    body: `抵達時間：${arrivedTime}，總用時：${duration}。`
  };
}

export function buildMaybeArrivedNotification(trip: TripTextLike): NotificationText {
  return {
    title: "是否已抵達？",
    body: `你曾接近 ${getDestinationLabel(trip)}，請確認是否已抵達。`
  };
}

export function buildAutoExtendedNotification(trip: TripTextLike): NotificationText {
  return {
    title: "GeoClock 已延長行程時間",
    body: "有效時間到期後已自動延長，避免行程中斷。"
  };
}

export function buildWakeRequestNotification(callerName?: string | null): NotificationText {
  const name = callerName?.trim();
  return {
    title: name ? `${name}正在呼叫你` : "家人正在呼叫你",
    body: "點擊打開 GeoClock 回應。"
  };
}

export function buildWakeAcknowledgedNotification(displayName?: string | null, acknowledgedAt?: string | null): NotificationText {
  return {
    title: displayName?.trim() ? `${displayName.trim()}已回應你的呼叫` : "對方已回應你的呼叫",
    body: `回應時間：${formatTaiwanTime(acknowledgedAt)}。`
  };
}

export function formatTaiwanTime(value?: string | Date | null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function formatTaiwanDateTime(value?: string | Date | null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "--/-- --:--";
  }
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function formatTripDurationBetween(startedAt?: string | null, endedAt?: string | null) {
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return "0 分鐘";
  }
  const minutes = Math.max(1, Math.round((end - start) / 60000));
  if (minutes < 60) {
    return `${minutes} 分鐘`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} 小時 ${remainingMinutes} 分鐘` : `${hours} 小時`;
}
