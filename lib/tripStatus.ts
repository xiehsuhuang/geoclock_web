export type TripLifecycleLike = {
  status?: string | null;
  ended_at?: string | null;
  expires_at?: string | null;
};

export function isTripEnded(trip: TripLifecycleLike | null | undefined) {
  return Boolean(
    trip?.ended_at ||
      trip?.status === "ended" ||
      trip?.status === "arrived" ||
      trip?.status === "stopped" ||
      trip?.status === "已抵達"
  );
}

export function isTripExpired(trip: TripLifecycleLike | null | undefined, now = Date.now()) {
  if (!trip || isTripEnded(trip) || !trip.expires_at) {
    return false;
  }
  const expiresAt = new Date(trip.expires_at).getTime();
  return Number.isFinite(expiresAt) && now >= expiresAt;
}

export function shouldAutoExtendTrip(trip: TripLifecycleLike | null | undefined, now = Date.now()) {
  return isTripExpired(trip, now);
}

export function isTripActive(trip: TripLifecycleLike | null | undefined, now = Date.now()) {
  return Boolean(trip && !isTripEnded(trip));
}

export function canViewerInteractWithTrip(trip: TripLifecycleLike | null | undefined, now = Date.now()) {
  return isTripActive(trip, now);
}

export function canWakeOwner(trip: TripLifecycleLike | null | undefined, now = Date.now()) {
  return Boolean(trip && isTripActive(trip, now));
}

export function getTripDisplayStatus(trip: TripLifecycleLike | null | undefined, now = Date.now()) {
  if (isTripEnded(trip)) {
    return "行程已結束";
  }
  if (shouldAutoExtendTrip(trip, now)) {
    return "行程有效時間已到，正在嘗試延長";
  }
  return trip?.status || "行程進行中";
}

export function canViewerSeeTrip({
  trip,
  hasShareCode,
  isRecipient,
  isConfirmedFamily,
  now = Date.now()
}: {
  trip: TripLifecycleLike | null | undefined;
  hasShareCode?: boolean;
  isRecipient?: boolean;
  isConfirmedFamily?: boolean;
  now?: number;
}) {
  if (!trip || isTripEnded(trip) || !isTripActive(trip, now)) {
    return false;
  }
  return Boolean(hasShareCode || isRecipient || isConfirmedFamily);
}
