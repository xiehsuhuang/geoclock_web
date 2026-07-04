import type { Destination, EventRecord, FamilyMember, UserProfile } from "./types";

export const STORAGE_KEYS = {
  user: "geoclock.web.user",
  destinations: "geoclock.web.destinations",
  family: "geoclock.web.family",
  events: "geoclock.web.events"
} as const;

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
  return {
    user: readStored<UserProfile | null>(STORAGE_KEYS.user, null),
    destinations: readStored<Destination[]>(STORAGE_KEYS.destinations, []),
    family: readStored<FamilyMember[]>(STORAGE_KEYS.family, []),
    events: readStored<EventRecord[]>(STORAGE_KEYS.events, [])
  };
}
