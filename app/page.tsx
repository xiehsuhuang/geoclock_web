"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  destinationKey,
  formatDistance,
  getApproximateLocation,
  getLocationHealth,
  getTripStatus,
  haversineDistanceMeters,
  normalizeDestinationIdentity,
  parseGoogleMapsCoordinates
} from "@/lib/geo";
import { clearGeoClockStorage, DEFAULT_PRIVACY_SETTINGS, DEFAULT_TRIP_SETTINGS, loadSnapshot, STORAGE_KEYS, writeStored } from "@/lib/storage";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";
import type {
  ActiveTrip,
  CloudTripRow,
  CurrentPosition,
  Destination,
  EventRecord,
  EventType,
  FamilyMember,
  FamilyPermission,
  LocationHealth,
  PlaceSearchCandidate,
  PrivacySettings,
  TripStatus,
  UserProfile,
  WakeRequestRow
} from "@/lib/types";

const TripMap = dynamic(() => import("@/components/TripMap"), {
  ssr: false
});

const RADIUS_OPTIONS = [
  { label: "300 m", value: 300 },
  { label: "500 m", value: 500 },
  { label: "1 km", value: 1000 },
  { label: "2 km", value: 2000 }
];

const ARRIVAL_RADIUS_OPTIONS = [50, 100, 200, 300];
const DEFAULT_ARRIVAL_RADIUS_METERS = 100;
const MIN_ALERT_RADIUS_METERS = 50;
const MAX_ALERT_RADIUS_METERS = 10000;
const MILESTONE_METERS = [5000, 2000, 1000, 500, 300];
const PERMISSIONS: FamilyPermission[] = ["只看狀態", "可看位置", "可叫醒我"];

type PreflightStatus = "尚未測試" | "測試中" | "成功" | "失敗" | "不支援";

type PreflightCheckState = {
  status: PreflightStatus;
  message: string;
};

type LocationCheckState = PreflightCheckState & {
  position?: CurrentPosition;
};

const initialLocationCheck: LocationCheckState = {
  status: "尚未測試",
  message: "尚未測試定位"
};
const initialAudioCheck: PreflightCheckState = {
  status: "尚未測試",
  message: "尚未測試提示音"
};
const initialVibrationCheck: PreflightCheckState = {
  status: "尚未測試",
  message: "尚未測試震動"
};
const initialWakeLockCheck: PreflightCheckState = {
  status: "尚未測試",
  message: "尚未嘗試防鎖屏"
};

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

type DestinationFormState = {
  name: string;
  address: string;
  mapsUrl: string;
  manualLat: string;
  manualLng: string;
  locationSource: "none" | "geoapify" | "manual";
};

type PlaceSearchState = {
  status: "idle" | "loading" | "success" | "empty" | "error";
  message: string;
};

type CloudShareState = {
  status: "idle" | "creating" | "active" | "error";
  message: string;
  tripId?: string;
  shareCode?: string;
  shareUrl?: string;
};

type NotificationState = {
  status: "尚未啟用" | "已啟用" | "被拒絕" | "此瀏覽器不支援";
  message: string;
};

const emptyDestinationForm: DestinationFormState = {
  name: "",
  address: "",
  mapsUrl: "",
  manualLat: "",
  manualLng: "",
  locationSource: "none"
};

export default function Home() {
  const [hydrated, setHydrated] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [nicknameInput, setNicknameInput] = useState("");
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [destinationForm, setDestinationForm] = useState<DestinationFormState>(emptyDestinationForm);
  const [destinationNotice, setDestinationNotice] = useState<string | null>(null);
  const [advancedDestinationOpen, setAdvancedDestinationOpen] = useState(false);
  const [placeSearchState, setPlaceSearchState] = useState<PlaceSearchState>({
    status: "idle",
    message: ""
  });
  const [placeCandidates, setPlaceCandidates] = useState<PlaceSearchCandidate[]>([]);
  const [selectedDestinationId, setSelectedDestinationId] = useState("");
  const [radiusMeters, setRadiusMeters] = useState(DEFAULT_TRIP_SETTINGS.alertRadiusMeters);
  const [customRadiusInput, setCustomRadiusInput] = useState("");
  const [radiusNotice, setRadiusNotice] = useState("");
  const [arrivalRadiusMeters, setArrivalRadiusMeters] = useState(DEFAULT_TRIP_SETTINGS.arrivalRadiusMeters);
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [family, setFamily] = useState<FamilyMember[]>([]);
  const [familyCode, setFamilyCode] = useState("");
  const [familyPermission, setFamilyPermission] = useState<FamilyPermission>("只看狀態");
  const [privacySettings, setPrivacySettings] = useState<PrivacySettings>(DEFAULT_PRIVACY_SETTINGS);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [wakeLockStatus, setWakeLockStatus] = useState("尚未啟用");
  const [audioStatus, setAudioStatus] = useState("提醒音尚未啟用");
  const [strongAlert, setStrongAlert] = useState<string | null>(null);
  const [cloudShare, setCloudShare] = useState<CloudShareState>({
    status: "idle",
    message: ""
  });
  const [notificationState, setNotificationState] = useState<NotificationState>({
    status: "尚未啟用",
    message: "通知功能需將網站加入 iPhone 主畫面後使用。"
  });
  const [activeWakeRequest, setActiveWakeRequest] = useState<WakeRequestRow | null>(null);
  const [wakeToneActive, setWakeToneActive] = useState(false);
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [preflightDestination, setPreflightDestination] = useState<Destination | null>(null);
  const [preflightRadiusMeters, setPreflightRadiusMeters] = useState(500);
  const [preflightArrivalRadiusMeters, setPreflightArrivalRadiusMeters] = useState(DEFAULT_ARRIVAL_RADIUS_METERS);
  const [locationCheck, setLocationCheck] = useState<LocationCheckState>(initialLocationCheck);
  const [audioCheck, setAudioCheck] = useState<PreflightCheckState>(initialAudioCheck);
  const [vibrationCheck, setVibrationCheck] = useState<PreflightCheckState>(initialVibrationCheck);
  const [wakeLockCheck, setWakeLockCheck] = useState<PreflightCheckState>(initialWakeLockCheck);

  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const alertAudioRef = useRef<HTMLAudioElement | null>(null);
  const milestoneRef = useRef<Set<number>>(new Set());
  const eventGateRef = useRef<Set<EventType>>(new Set());
  const tripStartedRef = useRef(false);
  const cloudShareRef = useRef<CloudShareState>({
    status: "idle",
    message: ""
  });
  const wakeToneIntervalRef = useRef<number | null>(null);
  const wakeToneTimeoutRef = useRef<number | null>(null);

  const selectedDestination = useMemo(
    () => destinations.find((destination) => destination.id === selectedDestinationId) ?? null,
    [destinations, selectedDestinationId]
  );
  const mapsLocationPreview = useMemo(() => {
    const mapsUrl = destinationForm.mapsUrl.trim();
    if (!mapsUrl) {
      return null;
    }
    return parseGoogleMapsCoordinates(mapsUrl);
  }, [destinationForm.mapsUrl]);
  const manualLocationPreview = useMemo(
    () => parseManualLocation(destinationForm.manualLat, destinationForm.manualLng),
    [destinationForm.manualLat, destinationForm.manualLng]
  );
  const mapDestination = activeTrip?.destination ?? selectedDestination;
  const mapPosition = activeTrip?.lastPosition;
  const mapRadiusMeters = activeTrip?.radiusMeters ?? radiusMeters;
  const displayArrivalRadiusMeters = activeTrip?.arrivalRadiusMeters ?? arrivalRadiusMeters;
  const approximateLocationPreview = mapPosition ? getApproximateLocation(mapPosition.lat, mapPosition.lng) : null;
  const preflightChecksAttempted =
    locationCheck.status !== "尚未測試" &&
    audioCheck.status !== "尚未測試" &&
    vibrationCheck.status !== "尚未測試" &&
    wakeLockCheck.status !== "尚未測試";
  const preflightCanStart = preflightChecksAttempted && locationCheck.status === "成功";

  useEffect(() => {
    const snapshot = loadSnapshot();
    setUser(snapshot.user);
    setDestinations(snapshot.destinations);
    setFamily(snapshot.family);
    setEvents(snapshot.events);
    setPrivacySettings(snapshot.privacy);
    setRadiusMeters(snapshot.tripSettings.alertRadiusMeters);
    setArrivalRadiusMeters(getSafeArrivalRadius(snapshot.tripSettings.arrivalRadiusMeters, snapshot.tripSettings.alertRadiusMeters));
    setSelectedDestinationId(snapshot.destinations[0]?.id ?? "");
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

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
        message: "通知已允許。"
      });
    } else if (Notification.permission === "denied") {
      setNotificationState({
        status: "被拒絕",
        message: "通知權限被拒絕，請到 Safari 網站設定中允許通知。"
      });
    }
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    user ? writeStored(STORAGE_KEYS.user, user) : window.localStorage.removeItem(STORAGE_KEYS.user);
  }, [hydrated, user]);

  useEffect(() => {
    if (hydrated) {
      writeStored(STORAGE_KEYS.destinations, destinations);
    }
  }, [hydrated, destinations]);

  useEffect(() => {
    if (hydrated) {
      writeStored(STORAGE_KEYS.family, family);
    }
  }, [hydrated, family]);

  useEffect(() => {
    if (hydrated) {
      writeStored(STORAGE_KEYS.events, events.slice(0, 100));
    }
  }, [hydrated, events]);

  useEffect(() => {
    if (hydrated) {
      writeStored(STORAGE_KEYS.privacy, privacySettings);
    }
  }, [hydrated, privacySettings]);

  useEffect(() => {
    if (hydrated) {
      writeStored(STORAGE_KEYS.tripSettings, {
        alertRadiusMeters: radiusMeters,
        arrivalRadiusMeters
      });
    }
  }, [hydrated, radiusMeters, arrivalRadiusMeters]);

  useEffect(() => {
    cloudShareRef.current = cloudShare;
  }, [cloudShare]);

  useEffect(() => {
    if (!activeTrip) {
      return;
    }

    const interval = window.setInterval(() => {
      const health = getLocationHealth(activeTrip.lastPosition?.updatedAt);
      const status = getTripStatus(activeTrip.distanceMeters, activeTrip.radiusMeters, activeTrip.arrivalRadiusMeters, health);
      logStatusTransition(status, activeTrip.health, health);
      setActiveTrip((trip) => (trip ? { ...trip, health, status } : trip));
    }, 5000);

    return () => window.clearInterval(interval);
  }, [activeTrip]);

  useEffect(() => {
    return () => {
      stopGeolocationWatch();
      releaseWakeLock();
      stopWakeTone();
    };
  }, []);

  useEffect(() => {
    if (!user || !isSupabaseConfigured || !supabase) {
      return;
    }

    const supabaseClient = supabase;
    const ownerCode = user.code;
    let disposed = false;
    async function pollWakeRequests() {
      const { data } = await supabaseClient
        .from("wake_requests")
        .select("*")
        .eq("to_owner_code", ownerCode)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (disposed) {
        return;
      }

      if (data) {
        setActiveWakeRequest(data as WakeRequestRow);
        setStrongAlert("家人正在呼叫你。請確認目前位置與下車狀態。");
        startWakeTone();
        appendStatusEventOnce("收到家人呼叫", "收到家人呼叫提醒");
      }
    }

    void pollWakeRequests();
    const interval = window.setInterval(pollWakeRequests, 5000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [user]);

  function createEvent(type: EventType, message: string): EventRecord {
    return {
      id: createId("event"),
      type,
      message,
      createdAt: new Date().toISOString()
    };
  }

  function appendEvent(type: EventType, message: string) {
    setEvents((current) => [createEvent(type, message), ...current].slice(0, 100));
  }

  function appendStatusEventOnce(type: EventType, message: string) {
    if (eventGateRef.current.has(type)) {
      return;
    }
    eventGateRef.current.add(type);
    appendEvent(type, message);
  }

  function logStatusTransition(status: TripStatus, previousHealth: LocationHealth, health: LocationHealth) {
    if (status === "接近目的地") {
      appendStatusEventOnce("接近目的地", "距離目的地已小於 5 km");
    }
    if (status === "快到目的地") {
      appendStatusEventOnce("快到目的地", "已進入快到提醒距離");
    }
    if (status === "已抵達") {
      appendStatusEventOnce("已抵達", "已進入已抵達判斷距離");
    }
    if (previousHealth !== "延遲" && health === "延遲") {
      appendStatusEventOnce("定位延遲", "最後定位更新已超過 20 秒");
    }
    if (previousHealth !== "中斷" && health === "中斷") {
      appendStatusEventOnce("定位中斷", "最後定位更新已超過 60 秒");
    }
  }

  function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nickname = nicknameInput.trim();
    if (!nickname) {
      return;
    }

    const createdUser = {
      nickname,
      code: generateUserCode(nickname),
      createdAt: new Date().toISOString()
    };
    setUser(createdUser);
    appendEvent("建立使用者", `${createdUser.nickname} 建立了使用者代號 ${createdUser.code}`);
  }

  function handleDestinationSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = destinationForm.name.trim();
    const address = destinationForm.address.trim();
    const mapsUrl = destinationForm.mapsUrl.trim();
    const manualResult = parseManualLocation(destinationForm.manualLat, destinationForm.manualLng);

    if (!name || !address) {
      return;
    }

    if (manualResult.status === "invalid") {
      setDestinationNotice(manualResult.message);
      appendEvent("手動輸入定位資料失敗", manualResult.message);
      return;
    }

    const mapsCoordinates = mapsUrl ? parseGoogleMapsCoordinates(mapsUrl) : null;
    const manualCoordinates = manualResult.status === "valid" ? manualResult.location : null;
    const coordinates = mapsCoordinates ?? manualCoordinates;
    const now = new Date().toISOString();
    const nextDestination: Destination = {
      id: createId("destination"),
      name,
      address,
      mapsUrl: mapsUrl || undefined,
      lat: coordinates?.lat,
      lng: coordinates?.lng,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    };
    const hasLocation = hasCoordinates(nextDestination);

    if (mapsUrl) {
      appendEvent(
        mapsCoordinates ? "Google Maps 連結解析成功" : "Google Maps 連結解析失敗",
        mapsCoordinates
          ? `${name} 已透過 Google Maps 分享連結取得目的地定位`
          : "這個連結暫時無法取得目的地定位，請確認是否為 Google Maps 分享連結。"
      );
    }
    if (manualResult.status === "valid" && destinationForm.locationSource === "manual") {
      appendEvent("手動輸入定位資料成功", `${name} 已使用進階輸入取得目的地定位`);
    }

    setDestinations((current) => {
      const nextKey = destinationKey(nextDestination);
      const existing = current.find((destination) => destinationKey(destination) === nextKey);
      if (existing) {
        const updated = current.map((destination) =>
          destination.id === existing.id ? { ...destination, mapsUrl: mapsUrl || destination.mapsUrl, updatedAt: now, lastUsedAt: now } : destination
        );
        setSelectedDestinationId(existing.id);
        setDestinationNotice(
          hasCoordinates(existing) ? "已更新目的地。" : "已儲存，但尚未取得定位資料，暫時不能開始行程。"
        );
        return sortDestinations(updated);
      }

      const samePlaceWithoutLocation = current.find(
        (destination) =>
          normalizeDestinationIdentity(destination) === normalizeDestinationIdentity(nextDestination) &&
          !hasCoordinates(destination) &&
          hasLocation
      );
      if (samePlaceWithoutLocation) {
        const updated = current.map((destination) =>
          destination.id === samePlaceWithoutLocation.id
            ? {
                ...destination,
                mapsUrl: mapsUrl || destination.mapsUrl,
                lat: nextDestination.lat,
                lng: nextDestination.lng,
                updatedAt: now,
                lastUsedAt: now
              }
            : destination
        );
        setSelectedDestinationId(samePlaceWithoutLocation.id);
        setDestinationNotice("已取得目的地定位");
        appendEvent("更新目的地定位資料", `${name} 已更新同一筆歷史目的地`);
        return sortDestinations(updated);
      }

      setSelectedDestinationId(nextDestination.id);
      setDestinationNotice(
        hasLocation
          ? "已取得目的地定位"
          : mapsUrl
            ? "這個連結暫時無法取得目的地定位，請確認是否為 Google Maps 分享連結。"
            : "已儲存，但尚未取得定位資料，暫時不能開始行程。"
      );
      appendEvent("新增目的地", `${name} 已加入歷史目的地`);
      return sortDestinations([nextDestination, ...current]);
    });
    setDestinationForm(emptyDestinationForm);
    setPlaceCandidates([]);
    setPlaceSearchState({ status: "idle", message: "" });
  }

  async function searchPlaces() {
    const query = destinationForm.address.trim() || destinationForm.name.trim();
    if (!query) {
      setPlaceSearchState({ status: "error", message: "請先輸入地址或地點。" });
      return;
    }

    setPlaceSearchState({ status: "loading", message: "搜尋中..." });
    setPlaceCandidates([]);

    try {
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
      const payload = (await response.json()) as {
        results?: PlaceSearchCandidate[];
        message?: string;
      };

      if (!response.ok) {
        setPlaceSearchState({
          status: "error",
          message: payload.message ?? "地點搜尋暫時無法使用，請稍後再試，或貼 Google Maps 分享連結。"
        });
        return;
      }

      const results = payload.results ?? [];
      if (results.length === 0) {
        setPlaceSearchState({
          status: "empty",
          message: "找不到目的地定位，請換更完整的地點名稱或貼 Google Maps 分享連結。"
        });
        return;
      }

      setPlaceCandidates(results);
      setPlaceSearchState({ status: "success", message: "請選擇最接近的地點。" });
    } catch {
      setPlaceSearchState({
        status: "error",
        message: "地點搜尋暫時無法使用，請稍後再試，或貼 Google Maps 分享連結。"
      });
    }
  }

  function selectPlaceCandidate(candidate: PlaceSearchCandidate) {
    setDestinationForm((form) => ({
      ...form,
      name: form.name.trim() ? form.name : candidate.label,
      address: candidate.address,
      manualLat: String(candidate.lat),
      manualLng: String(candidate.lng),
      locationSource: "geoapify"
    }));
    setDestinationNotice("已取得目的地定位");
    setPlaceSearchState({ status: "success", message: "已取得目的地定位" });
  }

  function selectDestination(destination: Destination) {
    setSelectedDestinationId(destination.id);
    setDestinationForm({
      name: destination.name,
      address: destination.address,
      mapsUrl: destination.mapsUrl ?? "",
      manualLat: "",
      manualLng: "",
      locationSource: "none"
    });
    setPlaceCandidates([]);
    setPlaceSearchState({ status: "idle", message: "" });
    setDestinations((current) =>
      sortDestinations(
        current.map((item) => (item.id === destination.id ? { ...item, lastUsedAt: new Date().toISOString() } : item))
      )
    );
  }

  function deleteDestination(destinationId: string) {
    const destination = destinations.find((item) => item.id === destinationId);
    setDestinations((current) => current.filter((item) => item.id !== destinationId));
    if (selectedDestinationId === destinationId) {
      setSelectedDestinationId("");
    }
    if (destination) {
      appendEvent("刪除目的地", `${destination.name} 已從歷史目的地刪除`);
    }
  }

  async function startTrip() {
    if (!selectedDestination || typeof selectedDestination.lat !== "number" || typeof selectedDestination.lng !== "number") {
      setStrongAlert("這個目的地還沒有定位資料，請貼上 Google Maps 分享連結，或在進階輸入中手動補上定位資料。");
      appendEvent("嘗試開始沒有定位資料的行程", selectedDestination ? `${selectedDestination.name} 尚未取得定位資料` : "尚未選擇目的地");
      return;
    }
    const safeArrivalRadius = getSafeArrivalRadius(arrivalRadiusMeters, radiusMeters);
    stopGeolocationWatch();
    resetPreflightChecks();
    setPreflightDestination(selectedDestination);
    setPreflightRadiusMeters(radiusMeters);
    setPreflightArrivalRadiusMeters(safeArrivalRadius);
    setPreflightOpen(true);
    setStrongAlert(null);
    appendEvent("進入啟動前檢查", `準備前往 ${selectedDestination.name}`);
  }

  function chooseAlertRadius(value: number) {
    setRadiusMeters(value);
    setCustomRadiusInput("");
    if (arrivalRadiusMeters > value) {
      setArrivalRadiusMeters(value);
      setRadiusNotice(`已抵達判斷距離已調整為 ${formatDistance(value)}，避免大於快到提醒距離。`);
      return;
    }
    setRadiusNotice("");
  }

  function applyCustomAlertRadius() {
    const parsed = Number(customRadiusInput.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setRadiusNotice("請輸入有效的公尺數，例如 750。");
      return;
    }
    if (parsed < MIN_ALERT_RADIUS_METERS || parsed > MAX_ALERT_RADIUS_METERS) {
      setRadiusNotice("自訂提醒距離需介於 50 m 到 10000 m。");
      return;
    }

    setRadiusMeters(parsed);
    if (arrivalRadiusMeters > parsed) {
      setArrivalRadiusMeters(parsed);
      setRadiusNotice(`快到提醒距離已設定為 ${formatDistance(parsed)}，已抵達判斷距離已同步調整。`);
      return;
    }
    setRadiusNotice(`快到提醒距離已設定為 ${formatDistance(parsed)}。`);
  }

  function chooseArrivalRadius(value: number) {
    const safeValue = getSafeArrivalRadius(value, radiusMeters);
    setArrivalRadiusMeters(safeValue);
    setRadiusNotice(
      safeValue === value ? "" : `已抵達判斷距離不可大於快到提醒距離，已調整為 ${formatDistance(safeValue)}。`
    );
  }

  function resetPreflightChecks() {
    setLocationCheck(initialLocationCheck);
    setAudioCheck(initialAudioCheck);
    setVibrationCheck(initialVibrationCheck);
    setWakeLockCheck(initialWakeLockCheck);
  }

  function testLocation() {
    if (!isLikelySecureForGeolocation()) {
      const message = "目前不是 HTTPS，iPhone Safari 可能不會允許定位。建議部署到 Vercel 後測試。";
      setLocationCheck({ status: "失敗", message });
      appendEvent("定位測試失敗", message);
      return;
    }
    if (!("geolocation" in navigator)) {
      const message = "此瀏覽器可能不支援定位，或目前不是 HTTPS。";
      setLocationCheck({ status: "不支援", message });
      appendEvent("定位測試失敗", message);
      return;
    }

    setLocationCheck({ status: "測試中", message: "正在測試定位..." });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const currentPosition: CurrentPosition = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          updatedAt: new Date().toISOString()
        };
        const message = "定位可用";
        setLocationCheck({ status: "成功", message, position: currentPosition });
        appendEvent("定位測試成功", `${message}：${formatPosition(currentPosition)}`);
      },
      (error) => {
        const message = getGeolocationFailureMessage(error);
        setLocationCheck({ status: "失敗", message });
        appendEvent("定位測試失敗", message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      }
    );
  }

  async function testAlertAudio() {
    try {
      const audio = getAlertAudio();
      alertAudioRef.current = audio;
      audio.currentTime = 0;
      await audio.play();
      setAudioStatus("提示音已解鎖");
      setAudioCheck({ status: "成功", message: "提示音已解鎖" });
      appendEvent("提示音測試成功", "提示音已解鎖");
    } catch {
      const message = "提示音被瀏覽器阻擋，請確認 iPhone 不是靜音模式，並再點一次測試提示音。";
      setAudioStatus(message);
      setAudioCheck({ status: "失敗", message });
      appendEvent("提示音測試失敗", message);
    }
  }

  function testVibration() {
    if (!("vibrate" in navigator)) {
      const message = "此瀏覽器不支援網頁震動，iPhone Safari 常見此限制。";
      setVibrationCheck({ status: "不支援", message });
      appendEvent("震動不支援", message);
      return;
    }

    navigator.vibrate([180, 80, 180]);
    setVibrationCheck({ status: "成功", message: "已送出震動測試" });
  }

  async function testWakeLock() {
    const enabled = await requestWakeLock();
    if (enabled) {
      setWakeLockCheck({ status: "成功", message: "防鎖屏已啟用" });
      appendEvent("防鎖屏啟用成功", "防鎖屏已啟用");
      return;
    }

    const message = "此瀏覽器不支援防鎖屏，請保持畫面開啟。";
    setWakeLockCheck({ status: "不支援", message });
    appendEvent("防鎖屏啟用失敗", message);
  }

  function startOfficialTrip() {
    if (!preflightDestination || typeof preflightDestination.lat !== "number" || typeof preflightDestination.lng !== "number") {
      return;
    }
    if (locationCheck.status !== "成功") {
      setStrongAlert("請先完成定位測試，定位可用後才能正式開始旅程。");
      return;
    }
    if (!("geolocation" in navigator)) {
      setStrongAlert("此瀏覽器可能不支援定位，或目前不是 HTTPS。");
      return;
    }

    stopGeolocationWatch();
    milestoneRef.current = new Set();
    eventGateRef.current = new Set();
    tripStartedRef.current = false;
    setStrongAlert("正在等待第一次定位，成功後會進入旅程模式。");
    appendEvent(
      "正式開始旅程",
      `前往 ${preflightDestination.name}，快到提醒距離 ${formatDistance(preflightRadiusMeters)}，已抵達判斷距離 ${formatDistance(preflightArrivalRadiusMeters)}`
    );
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        if (!tripStartedRef.current) {
          tripStartedRef.current = true;
          setPreflightOpen(false);
          setStrongAlert(null);
          appendEvent(
            "開始行程",
            `前往 ${preflightDestination.name}，快到提醒距離 ${formatDistance(preflightRadiusMeters)}，已抵達判斷距離 ${formatDistance(preflightArrivalRadiusMeters)}`
          );
        }
        handlePositionUpdate(position, preflightDestination, preflightRadiusMeters, preflightArrivalRadiusMeters);
      },
      (error) => {
        const message = getGeolocationFailureMessage(error);
        setStrongAlert(message);
        setActiveTrip((trip) => {
          if (!trip) {
            return trip;
          }
          appendStatusEventOnce("定位中斷", message);
          return { ...trip, status: "定位中斷", health: "中斷" };
        });
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000
      }
    );
  }

  function handlePositionUpdate(position: GeolocationPosition, destination: Destination, tripRadius: number, tripArrivalRadius: number) {
    if (typeof destination.lat !== "number" || typeof destination.lng !== "number") {
      return;
    }

    const nextPosition: CurrentPosition = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      updatedAt: new Date().toISOString()
    };
    const distanceMeters = haversineDistanceMeters(nextPosition, { lat: destination.lat, lng: destination.lng });
    const health = getLocationHealth(nextPosition.updatedAt);
    const status = getTripStatus(distanceMeters, tripRadius, tripArrivalRadius, health);

    logStatusTransition(status, activeTrip?.health ?? "正常", health);
    setActiveTrip((trip) => {
      const currentTrip =
        trip ??
        ({
          destination,
          radiusMeters: tripRadius,
          arrivalRadiusMeters: tripArrivalRadius,
          startedAt: new Date().toISOString(),
          status: "行程中",
          health: "正常"
        } satisfies ActiveTrip);
      return {
        ...currentTrip,
        lastPosition: nextPosition,
        distanceMeters,
        health,
        status
      };
    });

    appendEvent("定位更新", `距離 ${destination.name} ${formatDistance(distanceMeters)}`);
    void syncCloudTrip({
      destination,
      distanceMeters,
      health,
      position: nextPosition,
      radiusMeters: tripRadius,
      arrivalRadiusMeters: tripArrivalRadius,
      status
    });
    triggerMilestones(distanceMeters, tripRadius, tripArrivalRadius);
  }

  function triggerMilestones(distanceMeters: number, tripRadius: number, tripArrivalRadius: number) {
    for (const milestone of MILESTONE_METERS) {
      if (distanceMeters <= milestone && !milestoneRef.current.has(milestone)) {
        milestoneRef.current.add(milestone);
        setStrongAlert(`已進入 ${formatDistance(milestone)} 提醒範圍`);
        playAlert();
      }
    }

    const alertKey = 100000 + tripRadius;
    if (distanceMeters <= tripRadius && !milestoneRef.current.has(alertKey)) {
      milestoneRef.current.add(alertKey);
      setStrongAlert("快到目的地，請準備下車。");
      playAlert();
    }

    const arrivalKey = 200000 + tripArrivalRadius;
    if (distanceMeters <= tripArrivalRadius && !milestoneRef.current.has(arrivalKey)) {
      milestoneRef.current.add(arrivalKey);
      setStrongAlert("已抵達目的地附近，請確認下車。");
      playAlert();
    }
  }

  function stopTrip() {
    stopGeolocationWatch();
    releaseWakeLock();
    if (activeTrip) {
      appendEvent("停止行程", `${activeTrip.destination.name} 的行程已停止`);
      void endCloudTrip(activeTrip.status);
    }
    setActiveTrip(null);
    setStrongAlert(null);
    setWakeLockStatus("尚未啟用");
    setPreflightOpen(false);
    setPreflightDestination(null);
    tripStartedRef.current = false;
    setCloudShare((current) =>
      current.status === "active" ? { ...current, status: "idle", message: "共享行程已停止" } : current
    );
  }

  async function enableCloudSharing() {
    if (!activeTrip || !user) {
      return;
    }
    if (!isSupabaseConfigured || !supabase) {
      setCloudShare({
        status: "error",
        message: "尚未設定 Supabase，請先設定環境變數後再開啟共享。"
      });
      return;
    }

    setCloudShare({ status: "creating", message: "正在建立分享連結..." });

    const shareCode = createShareCode();
    const shareUrl = `${window.location.origin}/share/${shareCode}`;
    const approximate = activeTrip.lastPosition ? getApproximateLocation(activeTrip.lastPosition.lat, activeTrip.lastPosition.lng) : null;

    try {
      await supabase.from("users").upsert(
        {
          display_name: user.nickname,
          user_code: user.code
        },
        { ignoreDuplicates: true, onConflict: "user_code" }
      );

      const { data, error } = await supabase
        .from("trips")
        .insert({
          share_code: shareCode,
          owner_code: user.code,
          destination_name: activeTrip.destination.name,
          destination_address: activeTrip.destination.address,
          destination_lat: activeTrip.destination.lat as number,
          destination_lng: activeTrip.destination.lng as number,
          alert_radius_m: activeTrip.radiusMeters,
          arrival_radius_m: activeTrip.arrivalRadiusMeters,
          status: activeTrip.status,
          distance_m: activeTrip.distanceMeters ?? null,
          current_lat: activeTrip.lastPosition?.lat ?? null,
          current_lng: activeTrip.lastPosition?.lng ?? null,
          approximate_lat: approximate?.lat ?? null,
          approximate_lng: approximate?.lng ?? null,
          last_location_at: activeTrip.lastPosition?.updatedAt ?? null
        })
        .select("id, share_code")
        .single();

      if (error || !data) {
        throw error ?? new Error("Missing trip row");
      }

      setCloudShare({
        status: "active",
        message: "家人共享已開啟",
        tripId: data.id,
        shareCode: data.share_code,
        shareUrl
      });
      appendEvent("開啟家人共享", `分享連結已建立：${shareUrl}`);
    } catch {
      setCloudShare({
        status: "error",
        message: "雲端共享建立失敗，本機行程仍會繼續。請確認 Supabase 設定與 SQL 權限。"
      });
      appendEvent("雲端行程同步失敗", "建立分享連結失敗");
    }
  }

  async function copyShareLink() {
    if (!cloudShare.shareUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(cloudShare.shareUrl);
      setCloudShare((current) => ({ ...current, message: "分享連結已複製" }));
    } catch {
      setCloudShare((current) => ({ ...current, message: "無法自動複製，請手動複製分享連結。" }));
    }
  }

  async function syncCloudTrip({
    destination,
    distanceMeters,
    position,
    radiusMeters,
    arrivalRadiusMeters,
    status
  }: {
    destination: Destination;
    distanceMeters: number;
    health: LocationHealth;
    position: CurrentPosition;
    radiusMeters: number;
    arrivalRadiusMeters: number;
    status: TripStatus;
  }) {
    const share = cloudShareRef.current;
    if (!supabase || share.status !== "active" || !share.tripId) {
      return;
    }

    const approximate = getApproximateLocation(position.lat, position.lng);
    const { error } = await supabase
      .from("trips")
      .update({
        status,
        distance_m: distanceMeters,
        current_lat: position.lat,
        current_lng: position.lng,
        approximate_lat: approximate.lat,
        approximate_lng: approximate.lng,
        last_location_at: position.updatedAt,
        destination_lat: destination.lat as number,
        destination_lng: destination.lng as number,
        alert_radius_m: radiusMeters,
        arrival_radius_m: arrivalRadiusMeters
      })
      .eq("id", share.tripId);

    if (error) {
      setCloudShare((current) => ({
        ...current,
        message: "雲端同步失敗，本機行程仍會繼續。"
      }));
      appendStatusEventOnce("雲端行程同步失敗", "定位更新同步到 Supabase 失敗");
      return;
    }

    setCloudShare((current) => ({
      ...current,
      message: "雲端行程已同步"
    }));
    void notifyTripEvents(share.tripId, share.shareCode);
  }

  async function notifyTripEvents(tripId?: string, shareCode?: string) {
    if (!tripId && !shareCode) {
      return;
    }

    try {
      await fetch("/api/notify/trip-events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tripId,
          shareCode
        })
      });
    } catch {
      // 自動通知失敗不應影響本機行程或雲端同步。
    }
  }

  async function endCloudTrip(status: string) {
    const share = cloudShareRef.current;
    if (!supabase || share.status !== "active" || !share.tripId) {
      return;
    }

    const { error } = await supabase
      .from("trips")
      .update({
        status,
        ended_at: new Date().toISOString()
      })
      .eq("id", share.tripId);

    if (error) {
      appendStatusEventOnce("雲端行程同步失敗", "停止行程同步到 Supabase 失敗");
      return;
    }

    appendEvent("停止家人共享", "雲端共享行程已標記結束");
  }

  async function enableNotifications() {
    if (!user) {
      return;
    }
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
      appendEvent("通知訂閱失敗", "通知權限被拒絕");
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
          userCode: user.code,
          role: "owner",
          subscription: subscription.toJSON()
        })
      });

      if (!response.ok) {
        throw new Error("subscribe failed");
      }

      setNotificationState({
        status: "已啟用",
        message: "通知已啟用。連續呼叫提醒最多 15 秒，可由本人關閉。"
      });
      appendEvent("通知訂閱成功", "Web Push 通知已啟用");
    } catch {
      setNotificationState({
        status: "尚未啟用",
        message: "通知訂閱失敗。iPhone 請確認已加入主畫面並從主畫面開啟。"
      });
      appendEvent("通知訂閱失敗", "Web Push 通知訂閱失敗");
    }
  }

  async function acknowledgeWakeRequest() {
    if (!activeWakeRequest && !user) {
      return;
    }

    await fetch("/api/wake/ack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        wakeRequestId: activeWakeRequest?.id,
        userCode: user?.code
      })
    }).catch(() => undefined);

    setActiveWakeRequest(null);
    setStrongAlert(null);
    stopWakeTone();
    appendEvent("已回應家人呼叫", "已按下我醒了");
  }

  function startWakeTone() {
    if (wakeToneActive) {
      return;
    }
    setWakeToneActive(true);
    playAlert();
    wakeToneIntervalRef.current = window.setInterval(playAlert, 2500);
    wakeToneTimeoutRef.current = window.setTimeout(stopWakeTone, 15000);
  }

  function stopWakeTone() {
    if (wakeToneIntervalRef.current !== null) {
      window.clearInterval(wakeToneIntervalRef.current);
      wakeToneIntervalRef.current = null;
    }
    if (wakeToneTimeoutRef.current !== null) {
      window.clearTimeout(wakeToneTimeoutRef.current);
      wakeToneTimeoutRef.current = null;
    }
    setWakeToneActive(false);
  }

  function stopGeolocationWatch() {
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }

  async function requestWakeLock() {
    try {
      const wakeNavigator = navigator as WakeLockNavigator;
      if (!wakeNavigator.wakeLock) {
        setWakeLockStatus("此瀏覽器不支援防鎖屏，請保持畫面開啟。");
        return false;
      }

      wakeLockRef.current = await wakeNavigator.wakeLock.request("screen");
      wakeLockRef.current.addEventListener("release", () => {
        setWakeLockStatus("此瀏覽器不支援防鎖屏，請保持畫面開啟。");
      });
      setWakeLockStatus("防鎖屏已啟用");
      return true;
    } catch {
      setWakeLockStatus("此瀏覽器不支援防鎖屏，請保持畫面開啟。");
      return false;
    }
  }

  async function releaseWakeLock() {
    if (wakeLockRef.current && !wakeLockRef.current.released) {
      await wakeLockRef.current.release().catch(() => undefined);
    }
    wakeLockRef.current = null;
  }

  function playAlert() {
    if ("vibrate" in navigator) {
      navigator.vibrate([300, 120, 300, 120, 600]);
    }

    const audio = alertAudioRef.current;
    if (!audio) {
      setAudioStatus("提醒音播放失敗，畫面仍會強提醒");
      return;
    }

    audio.currentTime = 0;
    audio.play().catch(() => {
      setAudioStatus("提醒音播放失敗，畫面仍會強提醒");
    });
  }

  function addFamilyMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = familyCode.trim().toUpperCase();
    if (!code) {
      return;
    }

    const member: FamilyMember = {
      id: createId("family"),
      code,
      permission: familyPermission,
      createdAt: new Date().toISOString()
    };
    setFamily((current) => [member, ...current.filter((item) => item.code !== code)]);
    setFamilyCode("");
    appendEvent("新增家人權限", `${code} 已加入，權限：${familyPermission}`);
  }

  function deleteFamilyMember(member: FamilyMember) {
    setFamily((current) => current.filter((item) => item.id !== member.id));
    appendEvent("刪除家人權限", `${member.code} 的權限已刪除`);
  }

  function simulateWake() {
    setStrongAlert("家人正在叫醒你。請確認目前位置與下車狀態。");
    playAlert();
    appendEvent("模擬叫醒", "已觸發本機模擬叫醒通知");
  }

  function resetLocalData() {
    stopTrip();
    clearGeoClockStorage();
    setUser(null);
    setNicknameInput("");
    setDestinations([]);
    setDestinationForm(emptyDestinationForm);
    setSelectedDestinationId("");
    setDestinationNotice(null);
    setAdvancedDestinationOpen(false);
    setPlaceCandidates([]);
    setPlaceSearchState({ status: "idle", message: "" });
    setRadiusMeters(DEFAULT_TRIP_SETTINGS.alertRadiusMeters);
    setCustomRadiusInput("");
    setRadiusNotice("");
    setArrivalRadiusMeters(DEFAULT_TRIP_SETTINGS.arrivalRadiusMeters);
    setPrivacySettings(DEFAULT_PRIVACY_SETTINGS);
    setFamily([]);
    setEvents([]);
    setStrongAlert(null);
    setAudioStatus("提醒音尚未啟用");
    setWakeLockStatus("尚未啟用");
  }

  if (!hydrated) {
    return <main className="app-shell">載入中...</main>;
  }

  if (!user) {
    return (
      <main className="app-shell onboarding">
        <section className="hero-panel">
          <p className="eyebrow">GeoClock Web</p>
          <h1>到站提醒與家人協助叫醒</h1>
          <p className="muted">第一版使用本機資料，不登入、不接雲端。請先建立你的本機暱稱。</p>
          <form className="stack" onSubmit={handleCreateUser}>
            <label>
              暱稱
              <input
                value={nicknameInput}
                onChange={(event) => setNicknameInput(event.target.value)}
                placeholder="例如：阿黃"
                autoFocus
              />
            </label>
            <button className="primary-button" type="submit">
              建立使用者
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">GeoClock Web</p>
          <h1>旅程提醒</h1>
        </div>
        <button className="ghost-button small-button" onClick={resetLocalData}>
          重設資料
        </button>
      </header>

      {strongAlert ? (
        <section className="alert-panel" role="alert">
          <p className="eyebrow">強提醒</p>
          <h2>{strongAlert}</h2>
          {activeWakeRequest ? (
            <button className="primary-button" onClick={acknowledgeWakeRequest}>
              我醒了
            </button>
          ) : (
            <button className="secondary-button" onClick={() => setStrongAlert(null)}>
              我知道了
            </button>
          )}
        </section>
      ) : null}

      <section className="grid">
        <article className="card profile-card">
          <div>
            <p className="eyebrow">我的資料</p>
            <h2>{user.nickname}</h2>
            <p className="code">{user.code}</p>
          </div>
          <p className="notice">網頁版需要保持旅程頁面開啟，鎖屏或切換 App 後定位可能暫停。</p>
        </article>

        <article className="card">
          <p className="eyebrow">通知設定</p>
          <h2>{notificationState.status}</h2>
          <p className="notice">通知功能需將網站加入 iPhone 主畫面後使用。</p>
          <p className="muted">{notificationState.message}</p>
          <p className="muted">連續呼叫提醒最多 15 秒，可由本人關閉。</p>
          <button className="primary-button" disabled={notificationState.status === "被拒絕" || notificationState.status === "此瀏覽器不支援"} onClick={enableNotifications} type="button">
            啟用通知
          </button>
        </article>

        <article className="card">
          <p className="eyebrow">新增目的地</p>
          <form className="stack" onSubmit={handleDestinationSubmit}>
            <fieldset className="form-section">
              <legend>基本資料</legend>
              <label>
                目的地名稱
                <input
                  value={destinationForm.name}
                  onChange={(event) => setDestinationForm((form) => ({ ...form, name: event.target.value }))}
                  placeholder="例如：台北車站"
                />
              </label>
              <label>
                地址或地點
                <input
                  value={destinationForm.address}
                  onChange={(event) => setDestinationForm((form) => ({ ...form, address: event.target.value }))}
                  placeholder="輸入地址或地標"
                />
              </label>
            </fieldset>

            <fieldset className="form-section">
              <legend>取得目的地定位</legend>
              <div className="future-search-row">
                <button className="secondary-button" disabled={placeSearchState.status === "loading"} onClick={searchPlaces} type="button">
                  {placeSearchState.status === "loading" ? "搜尋中" : "搜尋地點"}
                </button>
                <span>使用 Geoapify 地點搜尋</span>
              </div>
              {placeSearchState.message ? (
                <p className={placeSearchState.status === "success" ? "inline-status good" : "inline-status warning"}>
                  {placeSearchState.message}
                </p>
              ) : null}
              {placeCandidates.length > 0 ? (
                <div className="candidate-list">
                  {placeCandidates.map((candidate) => (
                    <button className="candidate-button" key={candidate.id} onClick={() => selectPlaceCandidate(candidate)} type="button">
                      <strong>{candidate.label}</strong>
                      <span>{candidate.address}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <label>
                Google Maps 分享連結，可選
                <input
                  value={destinationForm.mapsUrl}
                  onChange={(event) => setDestinationForm((form) => ({ ...form, mapsUrl: event.target.value }))}
                  placeholder="貼上 Google Maps 分享連結"
                />
                <span className="field-hint">目前測試版可貼上 Google Maps 分享連結取得目的地定位。之後會加入地點搜尋。</span>
              </label>
              {destinationForm.mapsUrl.trim() ? (
                <p className={mapsLocationPreview ? "inline-status good" : "inline-status warning"}>
                  {mapsLocationPreview ? "已取得目的地定位" : "這個連結暫時無法取得目的地定位，請確認是否為 Google Maps 分享連結。"}
                </p>
              ) : null}
            </fieldset>

            <fieldset className="form-section">
              <button
                aria-expanded={advancedDestinationOpen}
                className="advanced-toggle"
                onClick={() => setAdvancedDestinationOpen((open) => !open)}
                type="button"
              >
                進階輸入
                <span>{advancedDestinationOpen ? "收合" : "展開"}</span>
              </button>
              {advancedDestinationOpen ? (
                <div className="stack">
                  <p className="field-hint">一般使用者不需要填。只有在 Google Maps 連結無法解析時才使用。</p>
                  <label>
                    手動輸入緯度
                    <input
                      inputMode="decimal"
                      value={destinationForm.manualLat}
                      onChange={(event) => setDestinationForm((form) => ({ ...form, manualLat: event.target.value, locationSource: "manual" }))}
                      placeholder="例如：24.1368"
                    />
                  </label>
                  <label>
                    手動輸入經度
                    <input
                      inputMode="decimal"
                      value={destinationForm.manualLng}
                      onChange={(event) => setDestinationForm((form) => ({ ...form, manualLng: event.target.value, locationSource: "manual" }))}
                      placeholder="例如：120.6850"
                    />
                  </label>
                  {manualLocationPreview.status !== "empty" ? (
                    <p className={manualLocationPreview.status === "valid" ? "inline-status good" : "inline-status warning"}>
                      {manualLocationPreview.status === "valid" ? "已取得目的地定位" : manualLocationPreview.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
            <button className="primary-button" type="submit">
              儲存目的地
            </button>
            {destinationNotice ? <p className="form-notice">{destinationNotice}</p> : null}
          </form>
        </article>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">歷史目的地</p>
            <h2>選擇旅程終點</h2>
          </div>
        </div>
        {destinations.length === 0 ? (
          <p className="muted">尚未新增目的地。</p>
        ) : (
          <div className="destination-list">
            {destinations.map((destination) => (
              <div className={`destination-row ${selectedDestinationId === destination.id ? "selected" : ""}`} key={destination.id}>
                <button type="button" onClick={() => selectDestination(destination)}>
                  <strong>{destination.name}</strong>
                  <span>{destination.address}</span>
                  <span className={hasCoordinates(destination) ? "good" : "warning"}>
                    {hasCoordinates(destination) ? "已取得目的地定位" : "定位資料尚未取得"}
                  </span>
                </button>
                <button className="danger-button" type="button" onClick={() => deleteDestination(destination.id)}>
                  刪除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card trip-card">
        <p className="eyebrow">行程模式</p>
        <h2>快到提醒距離</h2>
        <div className="radius-options">
          {RADIUS_OPTIONS.map((option) => (
            <button
              className={radiusMeters === option.value ? "selected" : ""}
              key={option.value}
              onClick={() => chooseAlertRadius(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="custom-radius-row">
          <label>
            自訂提醒距離，公尺
            <input
              inputMode="numeric"
              min={MIN_ALERT_RADIUS_METERS}
              max={MAX_ALERT_RADIUS_METERS}
              value={customRadiusInput}
              onChange={(event) => setCustomRadiusInput(event.target.value)}
              placeholder="例如：750"
            />
          </label>
          <button className="secondary-button" onClick={applyCustomAlertRadius} type="button">
            套用
          </button>
        </div>
        <details className="advanced-settings">
          <summary>進階設定</summary>
          <div className="stack">
            <p className="field-hint">已抵達判斷距離預設為 100 m，只用來判斷是否已到目的地附近，不是主要提醒距離。</p>
            <div className="radius-options compact">
              {ARRIVAL_RADIUS_OPTIONS.map((option) => (
                <button
                  className={arrivalRadiusMeters === option ? "selected" : ""}
                  key={option}
                  onClick={() => chooseArrivalRadius(option)}
                  type="button"
                >
                  {formatDistance(option)}
                </button>
              ))}
            </div>
          </div>
        </details>
        <div className="status-grid">
          <Metric label="快到提醒距離" value={formatDistance(radiusMeters)} />
          <Metric label="已抵達判斷距離" value={formatDistance(arrivalRadiusMeters)} />
        </div>
        {radiusNotice ? <p className="form-notice">{radiusNotice}</p> : null}
        <div className="trip-actions">
          <button
            className="primary-button"
            disabled={!selectedDestination || Boolean(activeTrip)}
            onClick={startTrip}
          >
            開始行程
          </button>
          <button className="secondary-button" disabled={!activeTrip} onClick={stopTrip}>
            停止行程
          </button>
        </div>
        {!selectedDestination ? <p className="muted">請先選擇目的地。</p> : null}
        {selectedDestination && !hasCoordinates(selectedDestination) ? (
          <p className="warning">這個目的地還沒有定位資料，請貼上 Google Maps 分享連結，或在進階輸入中手動補上定位資料。</p>
        ) : null}
        <p className="muted">{audioStatus}</p>
      </section>

      {preflightOpen && preflightDestination ? (
        <section className="card preflight-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">V0.3 啟動前檢查</p>
              <h2>{preflightDestination.name}</h2>
            </div>
          </div>
          <p className="notice">網頁版需要定位權限與音效權限。建議使用 Vercel HTTPS 網址測試；區網 HTTP 可能無法啟用定位。</p>
          {!isLikelySecureForGeolocation() ? (
            <p className="warning">目前不是 HTTPS，iPhone Safari 可能不會允許定位。建議部署到 Vercel 後測試。</p>
          ) : null}
          <div className="preflight-list">
            <PreflightRow
              actionLabel="測試定位"
              detail={locationCheck.position ? `${formatPosition(locationCheck.position)}，${formatTime(locationCheck.position.updatedAt)}` : undefined}
              label="定位權限"
              onAction={testLocation}
              state={locationCheck}
            />
            <PreflightRow actionLabel="測試提示音" label="提示音" onAction={testAlertAudio} state={audioCheck} />
            <PreflightRow actionLabel="測試震動" label="震動" onAction={testVibration} state={vibrationCheck} />
            <PreflightRow actionLabel="嘗試防鎖屏" label="防鎖屏" onAction={testWakeLock} state={wakeLockCheck} />
          </div>
          {preflightChecksAttempted ? (
            <button className="primary-button" disabled={!preflightCanStart || Boolean(activeTrip)} onClick={startOfficialTrip}>
              正式開始旅程
            </button>
          ) : (
            <p className="muted">請先完成上方檢查。震動與防鎖屏若不支援，仍可開始旅程。</p>
          )}
          {preflightChecksAttempted && locationCheck.status !== "成功" ? (
            <p className="warning">定位測試成功後才能正式開始旅程。</p>
          ) : null}
        </section>
      ) : null}

      <section className={`journey-panel ${activeTrip ? "active" : ""}`}>
        <div>
          <p className="eyebrow">旅程模式</p>
          <h2>{activeTrip?.status ?? "尚未開始"}</h2>
          <p className="journey-destination">{activeTrip?.destination.name ?? selectedDestination?.name ?? "尚未選擇目的地"}</p>
        </div>
        {mapDestination && hasCoordinates(mapDestination) ? (
          <div className="map-block">
            <TripMap currentPosition={mapPosition} destination={mapDestination} radiusMeters={mapRadiusMeters} />
            <div className="map-summary">
              <Metric label="目前位置最後更新" value={formatTime(mapPosition?.updatedAt)} />
              <Metric label="目的地" value={mapDestination.name} />
              <Metric label="距離目的地" value={formatDistance(activeTrip?.distanceMeters)} />
            </div>
          </div>
        ) : null}
        <div className="status-grid">
          <Metric label="目的地" value={activeTrip?.destination.address ?? selectedDestination?.address ?? "尚未設定"} />
          <Metric label="目前位置" value={formatPosition(activeTrip?.lastPosition)} />
          <Metric label="距離目的地" value={formatDistance(activeTrip?.distanceMeters)} />
          <Metric label="最後更新時間" value={formatTime(activeTrip?.lastPosition?.updatedAt)} />
          <Metric label="快到提醒距離" value={formatDistance(activeTrip?.radiusMeters ?? radiusMeters)} />
          <Metric label="已抵達判斷距離" value={formatDistance(displayArrivalRadiusMeters)} />
          <Metric label="定位健康度" value={activeTrip?.health ?? "正常"} />
          <Metric label="防鎖屏" value={wakeLockStatus} />
        </div>
        <p className="notice">網頁版需要保持旅程頁面開啟，鎖屏或切換 App 後定位可能暫停。</p>
      </section>

      {activeTrip ? (
        <section className="card cloud-share-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">家人共享</p>
              <h2>分享這趟行程</h2>
            </div>
          </div>
          <p className="notice">分享連結持有者可以查看行程狀態與粗略位置。V0.3 暫時不做通知與 Web Push。</p>
          {cloudShare.status === "active" && cloudShare.shareUrl ? (
            <div className="share-link-box">
              <span>{cloudShare.shareUrl}</span>
              <button className="secondary-button" onClick={copyShareLink} type="button">
                複製分享連結
              </button>
            </div>
          ) : (
            <button className="primary-button" disabled={cloudShare.status === "creating"} onClick={enableCloudSharing} type="button">
              {cloudShare.status === "creating" ? "建立中" : "開啟家人共享"}
            </button>
          )}
          {cloudShare.message ? <p className={cloudShare.status === "error" ? "inline-status warning" : "inline-status good"}>{cloudShare.message}</p> : null}
        </section>
      ) : null}

      <section className="grid">
        <article className="card">
          <p className="eyebrow">家人協助叫醒</p>
          <form className="stack" onSubmit={addFamilyMember}>
            <label>
              家人代號
              <input value={familyCode} onChange={(event) => setFamilyCode(event.target.value)} placeholder="例如：AMOM-2048" />
            </label>
            <label>
              權限
              <select value={familyPermission} onChange={(event) => setFamilyPermission(event.target.value as FamilyPermission)}>
                {PERMISSIONS.map((permission) => (
                  <option key={permission}>{permission}</option>
                ))}
              </select>
            </label>
            <button className="primary-button" type="submit">
              新增家人權限
            </button>
          </form>
          <p className="notice">未來雲端版中，擁有可叫醒我權限的人可以按按鈕發送 Push 通知。</p>
          <label className="toggle-row">
            <input
              checked={privacySettings.familyApproximateLocation}
              onChange={(event) =>
                setPrivacySettings((settings) => ({
                  ...settings,
                  familyApproximateLocation: event.target.checked
                }))
              }
              type="checkbox"
            />
            <span>家人查看時只顯示粗略位置</span>
          </label>
          {privacySettings.familyApproximateLocation && approximateLocationPreview ? (
            <p className="field-hint">
              粗略位置預覽：{approximateLocationPreview.lat.toFixed(4)}, {approximateLocationPreview.lng.toFixed(4)}
            </p>
          ) : null}
          <button className="secondary-button full-width" onClick={simulateWake}>
            模擬叫醒通知
          </button>
        </article>

        <article className="card">
          <p className="eyebrow">權限名單</p>
          {family.length === 0 ? (
            <p className="muted">尚未新增家人。</p>
          ) : (
            <div className="family-list">
              {family.map((member) => (
                <div className="family-row" key={member.id}>
                  <div>
                    <strong>{member.code}</strong>
                    <span>{member.permission}</span>
                  </div>
                  <button className="danger-button" onClick={() => deleteFamilyMember(member)}>
                    刪除
                  </button>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">事件紀錄</p>
            <h2>{events.length} 筆事件</h2>
          </div>
          <button className="secondary-button small-button" onClick={() => setEventsExpanded((expanded) => !expanded)} type="button">
            {eventsExpanded ? "收合事件紀錄" : "展開事件紀錄"}
          </button>
        </div>
        {events[0] ? (
          <p className="muted">
            最近一筆：{events[0].type}，{events[0].message}
          </p>
        ) : (
          <p className="muted">尚無事件。</p>
        )}
        {eventsExpanded && events.length > 0 ? (
          <ol className="event-list">
            {events.map((event) => (
              <li key={event.id}>
                <span>{formatTime(event.createdAt)}</span>
                <strong>{event.type}</strong>
                <p>{event.message}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PreflightRow({
  actionLabel,
  detail,
  label,
  onAction,
  state
}: {
  actionLabel: string;
  detail?: string;
  label: string;
  onAction: () => void;
  state: PreflightCheckState;
}) {
  return (
    <div className="preflight-row">
      <div>
        <span>{label}</span>
        <strong>{state.message}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
      <button className="secondary-button" disabled={state.status === "測試中"} onClick={onAction} type="button">
        {state.status === "測試中" ? "測試中" : actionLabel}
      </button>
    </div>
  );
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createShareCode() {
  return `share-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSafeArrivalRadius(arrivalRadius: number, alertRadius: number) {
  return Math.min(arrivalRadius, alertRadius);
}

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && Boolean(navigator.standalone));
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

function getAlertAudio() {
  if (!alertAudioElement) {
    alertAudioElement = new Audio(createBeepWavDataUrl());
    alertAudioElement.preload = "auto";
  }
  return alertAudioElement;
}

let alertAudioElement: HTMLAudioElement | null = null;

function createBeepWavDataUrl() {
  const sampleRate = 44100;
  const durationSeconds = 0.45;
  const frequency = 880;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  for (let i = 0; i < sampleCount; i += 1) {
    const fadeOut = 1 - i / sampleCount;
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.28 * fadeOut;
    view.setInt16(44 + i * 2, sample * 32767, true);
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function isLikelySecureForGeolocation() {
  if (typeof window === "undefined") {
    return false;
  }

  const { protocol, hostname } = window.location;
  return protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function getGeolocationFailureMessage(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) {
    return "定位權限被拒絕，請到 Safari 網站設定中允許定位。";
  }
  if (error.code === error.POSITION_UNAVAILABLE) {
    return "目前無法取得定位，請確認定位服務與網路。";
  }
  if (error.code === error.TIMEOUT) {
    return "定位逾時，請到戶外或稍後再試。";
  }
  return "此瀏覽器可能不支援定位，或目前不是 HTTPS。";
}

function parseManualLocation(
  manualLat: string,
  manualLng: string
):
  | { status: "empty" }
  | { status: "valid"; location: { lat: number; lng: number } }
  | { status: "invalid"; message: string } {
  const latText = manualLat.trim();
  const lngText = manualLng.trim();
  if (!latText && !lngText) {
    return { status: "empty" };
  }
  if (!latText || !lngText) {
    return { status: "invalid", message: "請同時填寫緯度與經度，或先清空進階輸入。" };
  }

  const lat = Number(latText);
  const lng = Number(lngText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: "invalid", message: "定位資料格式不正確，請輸入數字。" };
  }
  if (lat < -90 || lat > 90) {
    return { status: "invalid", message: "緯度必須介於 -90 到 90。" };
  }
  if (lng < -180 || lng > 180) {
    return { status: "invalid", message: "經度必須介於 -180 到 180。" };
  }

  return { status: "valid", location: { lat, lng } };
}

function generateUserCode(nickname: string) {
  const normalized = nickname
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .split(/\s+/)
    .join("")
    .toUpperCase();
  const prefix = normalized ? normalized.slice(0, 6) : "GEOCLK";
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function sortDestinations(destinations: Destination[]) {
  return [...destinations].sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
}

function hasCoordinates(destination: Destination | null): destination is Destination & { lat: number; lng: number } {
  return Boolean(destination && typeof destination.lat === "number" && typeof destination.lng === "number");
}

function formatPosition(position?: CurrentPosition) {
  if (!position) {
    return "尚未取得";
  }
  const accuracy = typeof position.accuracy === "number" ? `，誤差約 ${Math.round(position.accuracy)} m` : "";
  return `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}${accuracy}`;
}

function formatTime(value?: string) {
  if (!value) {
    return "尚未取得";
  }
  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
