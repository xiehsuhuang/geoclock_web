import type { Destination, EventRecord, FamilyMember, PrivacySettings, TripSettings, UserProfile } from "./types";

export const STORAGE_KEYS = {
  user: "geoclock.web.user",
  destinations: "geoclock.web.destinations",
  family: "geoclock.web.family",
  events: "geoclock.web.events",
  privacy: "geoclock.web.privacy",
  tripSettings: "geoclock.web.tripSettings"
} as const;

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  familyApproximateLocation: true
};

export const DEFAULT_TRIP_SETTINGS: TripSettings = {
  alertRadiusMeters: 500,
  arrivalRadiusMeters: 100
};

export function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function clearGeoClockStorage() {
  Object.values(STORAGE_KEYS).forEach((key) => window.localStorage.removeItem(key));
}

export function loadSnapshot() {
  const destinations = readStored<Destination[]>(STORAGE_KEYS.destinations, []).map((destination, index) => ({
    ...destination,
    id: destination.id || createStorageId("destination", destination.createdAt, index)
  }));
  const family = readStored<FamilyMember[]>(STORAGE_KEYS.family, []).map((member, index) => ({
    ...member,
    id: member.id || createStorageId("family", member.createdAt, index)
  }));

  return {
    user: readStored<UserProfile | null>(STORAGE_KEYS.user, null),
    destinations,
    family,
    events: readStored<EventRecord[]>(STORAGE_KEYS.events, []),
    privacy: readStored<PrivacySettings>(STORAGE_KEYS.privacy, DEFAULT_PRIVACY_SETTINGS),
    tripSettings: readStored<TripSettings>(STORAGE_KEYS.tripSettings, DEFAULT_TRIP_SETTINGS)
  };
}

function createStorageId(prefix: string, stableValue: string | undefined, index: number) {
  const base = stableValue ? new Date(stableValue).getTime() : Date.now();
  const safeBase = Number.isFinite(base) ? base : Date.now();
  return `${prefix}-${safeBase}-${index}`;
}
