type TripTextLike = {
  owner_code?: string | null;
  destination_name?: string | null;
  destination_address?: string | null;
  distance_m?: number | null;
};

export function getDisplayName(userCode?: string | null, displayName?: string | null) {
  return displayName?.trim() || userCode?.trim() || "對方";
}

export function getDestinationLabel(trip: TripTextLike) {
  return trip.destination_name?.trim() || trip.destination_address?.trim() || "目的地";
}

export function buildTripStartedNotification(trip: TripTextLike) {
  return {
    title: "GeoClock 行程開始",
    body: `${getDisplayName(trip.owner_code)} 已開始前往 ${getDestinationLabel(trip)}。你可以打開 GeoClock 查看狀態。`
  };
}

export function buildNearDestinationNotification(trip: TripTextLike, role: "owner" | "viewer") {
  const destination = getDestinationLabel(trip);
  const distanceText = formatDistanceText(trip.distance_m);
  if (role === "owner") {
    return {
      title: "GeoClock 到站提醒",
      body: `快到 ${destination} 了，${distanceText}請確認是否準備下車。`
    };
  }
  return {
    title: "GeoClock 到站提醒",
    body: `${getDisplayName(trip.owner_code)} 快到 ${destination} 了，${distanceText}`
  };
}

export function buildArrivedNotification(trip: TripTextLike, role: "owner" | "viewer") {
  const destination = getDestinationLabel(trip);
  if (role === "owner") {
    return {
      title: "GeoClock 已抵達",
      body: `你已抵達 ${destination} 附近，請確認是否下車。`
    };
  }
  return {
    title: "GeoClock 已抵達",
    body: `${getDisplayName(trip.owner_code)} 已抵達 ${destination} 附近。`
  };
}

export function buildMaybeArrivedNotification(trip: TripTextLike) {
  return {
    title: "GeoClock 可能已抵達",
    body: `你曾接近 ${getDestinationLabel(trip)}，但尚未連續停留確認。請查看是否已下車。`
  };
}

export function buildAutoExtendedNotification(trip: TripTextLike) {
  return {
    title: "GeoClock 已延長行程時間",
    body: `行程仍未結束，已自動延長 30 分鐘。畫面回到前景時會重新取得位置。`
  };
}

export function buildWakeRequestNotification() {
  return {
    title: "GeoClock 呼叫提醒",
    body: "有人提醒你快到了，請確認是否醒著"
  };
}

export function buildWakeAcknowledgedNotification(displayName?: string | null) {
  return {
    title: displayName?.trim() ? `${displayName.trim()}已回應你的呼叫` : "對方已回應你的呼叫",
    body: "對方已按下『我醒了』。"
  };
}

function formatDistanceText(distanceMeters?: number | null) {
  return typeof distanceMeters === "number" ? `距離約 ${Math.max(0, Math.round(distanceMeters))} m。` : "";
}
