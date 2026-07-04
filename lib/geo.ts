import type { Destination, LocationHealth, TripStatus } from "./types";

const COORDINATE_PATTERNS = [
  /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
  /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/
];

export function parseGoogleMapsCoordinates(input: string): { lat: number; lng: number } | null {
  if (!input.trim()) {
    return null;
  }

  const decoded = safeDecodeURIComponent(input);
  for (const pattern of COORDINATE_PATTERNS) {
    const match = decoded.match(pattern);
    if (!match) {
      continue;
    }

    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

export function normalizeDestinationIdentity(destination: Pick<Destination, "name" | "address">) {
  return [destination.name.trim().toLowerCase(), destination.address.trim().toLowerCase()].join("|");
}

export function haversineDistanceMeters(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const radius = 6371e3;
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const deltaPhi = toRadians(to.lat - from.lat);
  const deltaLambda = toRadians(to.lng - from.lng);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function destinationKey(destination: Pick<Destination, "name" | "address" | "lat" | "lng">) {
  return [
    destination.name.trim().toLowerCase(),
    destination.address.trim().toLowerCase(),
    destination.lat?.toFixed(6) ?? "no-lat",
    destination.lng?.toFixed(6) ?? "no-lng"
  ].join("|");
}

export function getLocationHealth(lastUpdatedAt?: string, now = Date.now()): LocationHealth {
  if (!lastUpdatedAt) {
    return "中斷";
  }

  const ageMs = now - new Date(lastUpdatedAt).getTime();
  if (ageMs > 60000) {
    return "中斷";
  }
  if (ageMs > 20000) {
    return "延遲";
  }
  return "正常";
}

export function getTripStatus(distanceMeters: number | undefined, radiusMeters: number, health: LocationHealth): TripStatus {
  if (health === "中斷") {
    return "定位中斷";
  }
  if (health === "延遲") {
    return "定位延遲";
  }
  if (typeof distanceMeters !== "number") {
    return "行程中";
  }
  if (distanceMeters < 100) {
    return "已抵達";
  }
  if (distanceMeters < radiusMeters) {
    return "快到目的地";
  }
  if (distanceMeters < 5000) {
    return "接近目的地";
  }
  return "行程中";
}

export function formatDistance(meters?: number) {
  if (typeof meters !== "number") {
    return "尚未取得";
  }
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
