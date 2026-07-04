import type { ActiveTrip, EventRecord, FamilyMember, UserProfile } from "./types";

export type CloudSyncAdapter = {
  saveUser(user: UserProfile): Promise<void>;
  saveTripState(trip: ActiveTrip): Promise<void>;
  saveFamilyMember(member: FamilyMember): Promise<void>;
  appendEvent(event: EventRecord): Promise<void>;
};

export type PushWakeAdapter = {
  requestPermission(): Promise<NotificationPermission>;
  sendWakeRequest(targetCode: string, message: string): Promise<void>;
};

export type PlaceSearchResult = {
  name: string;
  address: string;
  lat: number;
  lng: number;
};

export type FutureGeocodeAdapter = {
  searchPlaces(query: string): Promise<PlaceSearchResult[]>;
  geocodeAddress(address: string): Promise<PlaceSearchResult | null>;
};

export const cloudSyncAdapter: CloudSyncAdapter | null = null;
export const pushWakeAdapter: PushWakeAdapter | null = null;
export const futureGeocodeAdapter: FutureGeocodeAdapter | null = null;
