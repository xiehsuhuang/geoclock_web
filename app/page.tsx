"use client";

import dynamic from "next/dynamic";
import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { getNotificationDiagnostics, getStandaloneHint, isStandaloneMode, urlBase64ToUint8Array } from "@/lib/notificationDiagnostics";
import { playAlertSoundFor, startAlertSoundLoop, stopAlertSoundLoop, unlockAlertSound } from "@/lib/sound";
import { clearGeoClockStorage, DEFAULT_PRIVACY_SETTINGS, DEFAULT_TRIP_SETTINGS, loadSnapshot, STORAGE_KEYS, writeStored } from "@/lib/storage";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";
import { canWakeOwner, getTripDisplayStatus, isTripActive } from "@/lib/tripStatus";
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
  NotificationDiagnostic,
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
const TRIP_DURATION_OPTIONS = [
  { label: "30 分鐘", value: 30 },
  { label: "1 小時", value: 60 },
  { label: "2 小時", value: 120 },
  { label: "3 小時", value: 180 }
];
const DEFAULT_ARRIVAL_RADIUS_METERS = 100;
const DEFAULT_TRIP_DURATION_MINUTES = 120;
const MIN_ALERT_RADIUS_METERS = 50;
const MAX_ALERT_RADIUS_METERS = 10000;
const CONFIRMED_ARRIVAL_DISTANCE_METERS = 20;
const CONFIRMED_ARRIVAL_DURATION_MS = 5 * 60 * 1000;
const MAYBE_ARRIVED_DELAY_MS = 10 * 60 * 1000;
const AUTO_EXTEND_MINUTES = 30;
const VIEWER_CODE_STORAGE_KEY = "geoclock.web.viewerCode";
const NOTIFICATION_CENTER_STORAGE_KEY = "geoclock.web.notificationCenter";
const MILESTONE_METERS = [5000, 2000, 1000, 500, 300];
const PERMISSIONS: { label: string; value: FamilyPermission }[] = [
  { label: "只看狀態", value: "status_only" },
  { label: "接收到站通知", value: "notify" },
  { label: "可呼叫我", value: "wake" }
];

const DEFAULT_FAMILY_CONNECTION_PERMISSIONS: FamilyPermissions = {
  can_view_status: true,
  can_view_approx_location: true,
  can_view_precise_location: false,
  can_receive_notifications: true,
  can_wake_me: true,
  can_view_destination: true
};

const FAMILY_PERMISSION_OPTIONS: { key: keyof FamilyPermissions; label: string }[] = [
  { key: "can_view_status", label: "看得到我是否正在行程中" },
  { key: "can_view_approx_location", label: "看得到我的粗略位置" },
  { key: "can_view_precise_location", label: "看得到我的精準位置" },
  { key: "can_receive_notifications", label: "收到開始 / 快到 / 抵達 / 結束通知" },
  { key: "can_wake_me", label: "可以呼叫我" },
  { key: "can_view_destination", label: "看得到目的地名稱" }
];

type PreflightStatus = "尚未測試" | "測試中" | "成功" | "警告" | "失敗" | "不支援";

type PreflightCheckState = {
  status: PreflightStatus;
  message: string;
  lastTestedAt?: string;
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
const initialNotificationPermissionCheck: PreflightCheckState = {
  status: "尚未測試",
  message: "尚未測試背景通知"
};
const initialCloudConnectionCheck: PreflightCheckState = {
  status: "尚未測試",
  message: "尚未測試雲端連線"
};
const initialFamilyNotificationCheck: PreflightCheckState = {
  status: "尚未測試",
  message: "尚未測試家人通知"
};
const initialFamilyWakeCheck: PreflightCheckState = {
  status: "尚未測試",
  message: "尚未測試家人呼叫"
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
  expiresAt?: string;
};

type HomeMode = "start" | "view" | "family";

type FamilyConnectionRow = {
  id: string;
  user_a_code: string;
  user_b_code: string;
  user_a_permissions: FamilyPermissions;
  user_b_permissions: FamilyPermissions;
  user_a_confirmed: boolean;
  user_b_confirmed: boolean;
  status: string;
  updated_at?: string;
};

type FamilyPermissions = {
  can_view_status: boolean;
  can_view_approx_location: boolean;
  can_view_precise_location: boolean;
  can_receive_notifications: boolean;
  can_wake_me: boolean;
  can_view_destination: boolean;
};

type FamilyTripRow = CloudTripRow & {
  permissions?: Partial<FamilyPermissions>;
};

type PreflightCheckResult = {
  key: string;
  label: string;
  status: "success" | "warning" | "failed";
  message: string;
  suggestion: string;
};

type NotificationState = {
  status: "尚未啟用" | "已啟用" | "被拒絕" | "此瀏覽器不支援";
  message: string;
};

type NotificationCenterItem = {
  id: string;
  type: string;
  time: string;
  success: boolean;
  error?: string | null;
  shareCode?: string | null;
  recipientCode?: string | null;
  read?: boolean;
};

type SidebarSection = "preflight" | "notifications" | "family" | "testMode" | "notificationCenter" | "diagnostics" | null;

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
  const [homeMode, setHomeMode] = useState<HomeMode>("start");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>(null);
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
  const [showAllPlaceCandidates, setShowAllPlaceCandidates] = useState(false);
  const [selectedDestinationId, setSelectedDestinationId] = useState("");
  const [radiusMeters, setRadiusMeters] = useState(DEFAULT_TRIP_SETTINGS.alertRadiusMeters);
  const [customRadiusInput, setCustomRadiusInput] = useState("");
  const [radiusNotice, setRadiusNotice] = useState("");
  const [arrivalRadiusMeters, setArrivalRadiusMeters] = useState(DEFAULT_TRIP_SETTINGS.arrivalRadiusMeters);
  const [tripDurationMinutes, setTripDurationMinutes] = useState(DEFAULT_TRIP_DURATION_MINUTES);
  const [customTripDurationInput, setCustomTripDurationInput] = useState("");
  const [selectedTripRecipients, setSelectedTripRecipients] = useState<string[]>([]);
  const [familyPushEnabledCodes, setFamilyPushEnabledCodes] = useState<Set<string>>(new Set());
  const [existingCloudTrip, setExistingCloudTrip] = useState<FamilyTripRow | null>(null);
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [family, setFamily] = useState<FamilyMember[]>([]);
  const [familyCode, setFamilyCode] = useState("");
  const [familyPermission, setFamilyPermission] = useState<FamilyPermission>("status_only");
  const [connectionCode, setConnectionCode] = useState("");
  const [connectionPermissions, setConnectionPermissions] = useState<FamilyPermissions>(DEFAULT_FAMILY_CONNECTION_PERMISSIONS);
  const [familyConnections, setFamilyConnections] = useState<FamilyConnectionRow[]>([]);
  const [familyTrips, setFamilyTrips] = useState<FamilyTripRow[]>([]);
  const [familyConnectionMessage, setFamilyConnectionMessage] = useState("");
  const [preflightResults, setPreflightResults] = useState<PreflightCheckResult[]>([]);
  const [preflightSummary, setPreflightSummary] = useState("");
  const [viewerShareCode, setViewerShareCode] = useState("");
  const [viewerCodeInput, setViewerCodeInput] = useState("");
  const [viewerEntryMessage, setViewerEntryMessage] = useState("");
  const [manualViewerOpen, setManualViewerOpen] = useState(false);
  const [privacySettings, setPrivacySettings] = useState<PrivacySettings>(DEFAULT_PRIVACY_SETTINGS);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [wakeLockStatus, setWakeLockStatus] = useState("尚未啟用");
  const [audioStatus, setAudioStatus] = useState("提醒音尚未啟用");
  const [tripAlertSoundStatus, setTripAlertSoundStatus] = useState<"未解鎖" | "已解鎖" | "提醒中" | "已停止">("未解鎖");
  const [ownerTripMuted, setOwnerTripMuted] = useState(false);
  const [strongAlert, setStrongAlert] = useState<string | null>(null);
  const [cloudShare, setCloudShare] = useState<CloudShareState>({
    status: "idle",
    message: ""
  });
  const [notificationState, setNotificationState] = useState<NotificationState>({
    status: "尚未啟用",
    message: "通知功能需將網站加入 iPhone 主畫面後使用。"
  });
  const [notificationDiagnostics, setNotificationDiagnostics] = useState<NotificationDiagnostic[]>([]);
  const [notificationCenterItems, setNotificationCenterItems] = useState<NotificationCenterItem[]>([]);
  const [notificationCenterMessage, setNotificationCenterMessage] = useState("");
  const [testModeMessage, setTestModeMessage] = useState("");
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
  const [notificationPermissionCheck, setNotificationPermissionCheck] = useState<PreflightCheckState>(initialNotificationPermissionCheck);
  const [cloudConnectionCheck, setCloudConnectionCheck] = useState<PreflightCheckState>(initialCloudConnectionCheck);
  const [familyNotificationCheck, setFamilyNotificationCheck] = useState<PreflightCheckState>(initialFamilyNotificationCheck);
  const [familyWakeCheck, setFamilyWakeCheck] = useState<PreflightCheckState>(initialFamilyWakeCheck);
  const [foregroundLocationMessage, setForegroundLocationMessage] = useState("");

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
  const autoCloudShareStartedRef = useRef(false);
  const lastNotifyAttemptRef = useRef(0);
  const arrivalCandidateStartedAtRef = useRef<number | null>(null);
  const confirmedArrivalCompletedRef = useRef(false);
  const maybeArrivedCandidateStartedAtRef = useRef<number | null>(null);
  const maybeArrivedNotifiedRef = useRef(false);
  const autoExtendedUntilRef = useRef<string | null>(null);
  const wakeToneIntervalRef = useRef<number | null>(null);
  const wakeToneTimeoutRef = useRef<number | null>(null);
  const lastHandledWakeRequestIdRef = useRef<string | null>(null);

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
  const hasActiveLocalTrip = Boolean(activeTrip);
  const mapRadiusMeters = activeTrip?.radiusMeters ?? radiusMeters;
  const displayArrivalRadiusMeters = activeTrip?.arrivalRadiusMeters ?? arrivalRadiusMeters;
  const approximateLocationPreview = mapPosition ? getApproximateLocation(mapPosition.lat, mapPosition.lng) : null;
  const preflightChecksAttempted =
    locationCheck.status !== "尚未測試" &&
    audioCheck.status !== "尚未測試" &&
    vibrationCheck.status !== "尚未測試" &&
    wakeLockCheck.status !== "尚未測試";
  const preflightCanStart = locationCheck.status === "成功";
  const activeFamilyConnectionsCount = familyConnections.filter((connection) => connection.status === "confirmed").length;
  const confirmedFamilyOptions = useMemo(() => {
    if (!user) {
      return [];
    }
    return familyConnections
      .filter((connection) => connection.status === "confirmed")
      .map((connection) => {
        const code = connection.user_a_code === user.code ? connection.user_b_code : connection.user_a_code;
        const permissions = connection.user_a_code === user.code ? connection.user_b_permissions : connection.user_a_permissions;
        return {
          code,
          permissions: permissions ?? {}
        };
      });
  }, [familyConnections, user]);
  const preflightBadge = getPreflightSummaryLabel(preflightResults);
  const diagnosticsWarningCount = notificationDiagnostics.filter((item) => !item.ok).length;
  const notificationBadge = notificationState.status === "已啟用" ? "通知：已啟用" : "通知：未啟用";
  const soundBadge = audioCheck.status === "成功" || tripAlertSoundStatus === "已解鎖" ? "提示聲：已解鎖" : "提示聲：未解鎖";
  const locationBadge = activeTrip ? getPublicLocationStatus(activeTrip.lastPosition?.updatedAt) : "定位：未開始";
  const notificationUnreadCount = notificationCenterItems.filter((item) => !item.read).length;

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
    if (typeof window !== "undefined") {
      try {
        const rawNotifications = window.localStorage.getItem(NOTIFICATION_CENTER_STORAGE_KEY);
        if (rawNotifications) {
          setNotificationCenterItems(JSON.parse(rawNotifications) as NotificationCenterItem[]);
        }
      } catch {
        setNotificationCenterItems([]);
      }
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    return () => {
      stopAlertSoundLoop();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    const existingViewerCode = window.localStorage.getItem(VIEWER_CODE_STORAGE_KEY);
    if (!existingViewerCode) {
      window.localStorage.setItem(VIEWER_CODE_STORAGE_KEY, createFamilyViewerCode());
    }
  }, [hydrated]);

  useEffect(() => {
    if (!user) {
      return;
    }

    void ensureCloudUser(user);
    void loadFamilyConnections(user.code);
    void loadFamilyTrips(user.code);
  }, [user]);

  useEffect(() => {
    setSelectedTripRecipients((current) => {
      const validCodes = new Set(confirmedFamilyOptions.map((option) => option.code));
      const kept = current.filter((code) => validCodes.has(code));
      const defaults = confirmedFamilyOptions
        .filter((option) => option.permissions.can_receive_notifications === true)
        .map((option) => option.code);
      return Array.from(new Set([...kept, ...defaults]));
    });
  }, [confirmedFamilyOptions]);

  useEffect(() => {
    if (!supabase || confirmedFamilyOptions.length === 0) {
      setFamilyPushEnabledCodes(new Set());
      return;
    }

    let disposed = false;
    const codes = confirmedFamilyOptions.map((option) => option.code);
    async function loadPushEnabledCodes() {
      const { data } = await supabase!
        .from("push_subscriptions")
        .select("user_code")
        .in("user_code", codes);
      if (disposed) {
        return;
      }
      setFamilyPushEnabledCodes(new Set(((data ?? []) as { user_code: string | null }[]).map((row) => row.user_code).filter(Boolean) as string[]));
    }

    void loadPushEnabledCodes();
    return () => {
      disposed = true;
    };
  }, [confirmedFamilyOptions]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    void getNotificationDiagnostics().then(setNotificationDiagnostics);

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
      window.localStorage.setItem(NOTIFICATION_CENTER_STORAGE_KEY, JSON.stringify(notificationCenterItems.slice(0, 100)));
    }
  }, [hydrated, notificationCenterItems]);

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
    if (!activeTrip || autoCloudShareStartedRef.current || cloudShare.status !== "idle") {
      return;
    }
    autoCloudShareStartedRef.current = true;
    void enableCloudSharing();
  }, [activeTrip, cloudShare.status]);

  useEffect(() => {
    if (!activeTrip) {
      stopAlertSoundLoop();
      if (tripAlertSoundStatus === "提醒中") {
        setTripAlertSoundStatus(ownerTripMuted ? "已停止" : "已解鎖");
      }
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
    if (!activeTrip || ownerTripMuted || !isTripAlertCondition(activeTrip)) {
      stopAlertSoundLoop();
      if (tripAlertSoundStatus === "提醒中") {
        setTripAlertSoundStatus(ownerTripMuted ? "已停止" : "已解鎖");
      }
      return;
    }

    setTripAlertSoundStatus("提醒中");
    startAlertSoundLoop({
      playMs: 5000,
      intervalMs: 10000,
      onError: (error) => setAudioStatus(`提醒音播放失敗：${error}`)
    });
  }, [activeTrip?.distanceMeters, activeTrip?.radiusMeters, activeTrip?.arrivalRadiusMeters, activeTrip?.status, ownerTripMuted]);

  useEffect(() => {
    if (!activeTrip || !("geolocation" in navigator)) {
      return;
    }

    function refreshPositionWhenVisible() {
      if (document.visibilityState !== "visible" || !activeTrip) {
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          handlePositionUpdate(position, activeTrip.destination, activeTrip.radiusMeters, activeTrip.arrivalRadiusMeters);
          setForegroundLocationMessage("剛剛已重新取得位置。");
        },
        (error) => {
          setForegroundLocationMessage(getGeolocationFailureMessage(error));
        },
        {
          enableHighAccuracy: true,
          maximumAge: 10_000,
          timeout: 15_000
        }
      );
    }

    document.addEventListener("visibilitychange", refreshPositionWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshPositionWhenVisible);
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
    if (!hasActiveLocalTrip) {
      setActiveWakeRequest(null);
      stopWakeTone();
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

      if (data && data.id !== lastHandledWakeRequestIdRef.current) {
        lastHandledWakeRequestIdRef.current = data.id;
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
  }, [user, hasActiveLocalTrip]);

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
    if (isNotificationCenterEvent(type)) {
      appendNotificationCenterItem({
        type,
        success: !message.includes("失敗"),
        error: message.includes("失敗") ? message : null,
        shareCode: cloudShareRef.current.shareCode ?? null,
        recipientCode: null
      });
    }
  }

  function appendNotificationCenterItem(item: Omit<NotificationCenterItem, "id" | "time" | "read">) {
    setNotificationCenterItems((current) => [
      {
        id: createId("notification"),
        time: new Date().toISOString(),
        read: false,
        ...item
      },
      ...current
    ].slice(0, 100));
  }

  async function loadNotificationCenter() {
    if (!supabase) {
      setNotificationCenterMessage("Supabase 未設定，已顯示本機通知紀錄。");
      return;
    }

    try {
      const { data, error } = await supabase
        .from("notification_events")
        .select("id,event_type,sent_at,created_at,success,error,share_code,recipient_code")
        .order("sent_at", { ascending: false })
        .limit(50);
      if (error) {
        setNotificationCenterMessage(`通知中心讀取失敗：${error.message}`);
        return;
      }

      setNotificationCenterItems(
        ((data ?? []) as {
          id: string;
          event_type: string | null;
          sent_at: string | null;
          created_at: string | null;
          success: boolean | null;
          error: string | null;
          share_code: string | null;
          recipient_code: string | null;
        }[]).map((row) => ({
          id: row.id,
          type: row.event_type ?? "通知事件",
          time: row.sent_at ?? row.created_at ?? new Date().toISOString(),
          success: row.success !== false,
          error: row.error,
          shareCode: row.share_code,
          recipientCode: row.recipient_code,
          read: notificationCenterItems.find((item) => item.id === row.id)?.read ?? false
        }))
      );
      setNotificationCenterMessage("通知中心已重新載入。");
    } catch (error) {
      setNotificationCenterMessage(`通知中心讀取失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    }
  }

  function markNotificationCenterRead() {
    setNotificationCenterItems((current) => current.map((item) => ({ ...item, read: true })));
    setNotificationCenterMessage("已全部標記已讀。");
  }

  function clearLocalNotificationCenter() {
    setNotificationCenterItems([]);
    window.localStorage.removeItem(NOTIFICATION_CENTER_STORAGE_KEY);
    setNotificationCenterMessage("已清除本機通知紀錄。");
  }

  function appendStatusEventOnce(type: EventType, message: string) {
    if (eventGateRef.current.has(type)) {
      return;
    }
    eventGateRef.current.add(type);
    appendEvent(type, message);
  }

  function withTestedAt<T extends PreflightCheckState>(state: T): T {
    return {
      ...state,
      lastTestedAt: new Date().toISOString()
    };
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
    setShowAllPlaceCandidates(false);
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
    setShowAllPlaceCandidates(false);

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
      setShowAllPlaceCandidates(false);
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
    setShowAllPlaceCandidates(false);
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
    setShowAllPlaceCandidates(false);
    setPlaceSearchState({ status: "idle", message: "" });
    setDestinations((current) =>
      sortDestinations(
        current.map((item) => (item.id === destination.id ? { ...item, lastUsedAt: new Date().toISOString() } : item))
      )
    );
  }

  function deleteDestination(destinationId: string) {
    const destination = destinations.find((item) => item.id === destinationId);
    if (!destination || !window.confirm("確定刪除這筆歷史紀錄嗎？")) {
      return;
    }
    setDestinations((current) => current.filter((item) => item.id !== destinationId));
    if (selectedDestinationId === destinationId) {
      setSelectedDestinationId("");
      setDestinationForm(emptyDestinationForm);
      setDestinationNotice(null);
    }
    appendEvent("刪除目的地", `${destination.name} 已從歷史目的地刪除`);
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

  function chooseTripDuration(value: number) {
    setTripDurationMinutes(value);
    setCustomTripDurationInput("");
  }

  function applyCustomTripDuration() {
    const parsed = Number(customTripDurationInput.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 10 || parsed > 720) {
      setRadiusNotice("行程有效時間請輸入 10 到 720 分鐘之間的整數。");
      return;
    }
    setTripDurationMinutes(parsed);
    setRadiusNotice("");
  }

  function toggleTripRecipient(code: string, checked: boolean) {
    setSelectedTripRecipients((current) => {
      if (checked) {
        return Array.from(new Set([...current, code]));
      }
      return current.filter((item) => item !== code);
    });
  }

  function resetPreflightChecks() {
    setLocationCheck(initialLocationCheck);
    setAudioCheck(initialAudioCheck);
    setVibrationCheck(initialVibrationCheck);
    setWakeLockCheck(initialWakeLockCheck);
    setNotificationPermissionCheck(initialNotificationPermissionCheck);
    setCloudConnectionCheck(initialCloudConnectionCheck);
    setFamilyNotificationCheck(initialFamilyNotificationCheck);
    setFamilyWakeCheck(initialFamilyWakeCheck);
  }

  function testLocation() {
    if (!isLikelySecureForGeolocation()) {
      const message = "目前不是 HTTPS，iPhone Safari 可能不會允許定位。建議部署到 Vercel 後測試。";
      setLocationCheck(withTestedAt({ status: "失敗", message }));
      appendEvent("定位測試失敗", message);
      return;
    }
    if (!("geolocation" in navigator)) {
      const message = "此瀏覽器可能不支援定位，或目前不是 HTTPS。";
      setLocationCheck(withTestedAt({ status: "不支援", message }));
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
        setLocationCheck(withTestedAt({ status: "成功", message, position: currentPosition }));
        appendEvent("定位測試成功", `${message}：${formatPosition(currentPosition)}`);
      },
      (error) => {
        const message = getGeolocationFailureMessage(error);
        setLocationCheck(withTestedAt({ status: "失敗", message }));
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
    const unlocked = await unlockAlertSound();
    if (unlocked.ok) {
      const played = await playAlertSoundFor(1000);
      if (!played.ok) {
        const message = played.error ?? "提示音播放失敗，畫面仍會強提醒";
        setAudioStatus(message);
        setAudioCheck(withTestedAt({ status: "失敗", message }));
        appendEvent("提示音測試失敗", message);
        return;
      }
      setAudioStatus("提示音已解鎖");
      setTripAlertSoundStatus("已解鎖");
      setAudioCheck(withTestedAt({ status: "成功", message: "提示音已解鎖" }));
      appendEvent("提示音測試成功", "提示音已解鎖");
      return;
    }

    const message = unlocked.error ?? "請先點擊按鈕解鎖音效。";
    setAudioStatus(message);
    setAudioCheck(withTestedAt({ status: "失敗", message }));
    appendEvent("提示音測試失敗", message);
  }

  function testVibration() {
    if (!("vibrate" in navigator)) {
      const message = "此裝置或瀏覽器不支援網頁震動，iPhone 常見。";
      setVibrationCheck(withTestedAt({ status: "警告", message }));
      appendEvent("震動不支援", message);
      return;
    }

    navigator.vibrate(200);
    setVibrationCheck(withTestedAt({ status: "成功", message: "已送出震動測試" }));
  }

  async function testWakeLock() {
    const enabled = await requestWakeLock();
    if (enabled) {
      setWakeLockCheck(withTestedAt({ status: "成功", message: "防鎖屏已啟用" }));
      appendEvent("防鎖屏啟用成功", "防鎖屏已啟用");
      return;
    }

    const message = "此裝置或瀏覽器不支援防鎖屏，請手動保持畫面開啟。";
    setWakeLockCheck(withTestedAt({ status: "警告", message }));
    appendEvent("防鎖屏啟用失敗", message);
  }

  async function testNotificationPermission() {
    setNotificationPermissionCheck({ status: "測試中", message: "正在檢查通知權限..." });
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationPermissionCheck(
        withTestedAt({ status: "警告", message: "此瀏覽器不支援完整 Web Push。iPhone 需加入主畫面後使用。" })
      );
      return;
    }
    const diagnostics = await getNotificationDiagnostics();
    setNotificationDiagnostics(diagnostics);
    if (Notification.permission === "granted") {
      setNotificationPermissionCheck(withTestedAt({ status: "成功", message: "背景通知權限已啟用" }));
      return;
    }
    if (Notification.permission === "denied") {
      setNotificationPermissionCheck(withTestedAt({ status: "失敗", message: "通知權限已被拒絕，請到 Safari 網站設定調整。" }));
      return;
    }
    setNotificationPermissionCheck(withTestedAt({ status: "警告", message: "尚未啟用通知，可到通知設定啟用。" }));
  }

  async function testCloudConnection() {
    setCloudConnectionCheck({ status: "測試中", message: "正在測試雲端連線..." });
    if (!supabase) {
      setCloudConnectionCheck(withTestedAt({ status: "失敗", message: "Supabase 環境變數未設定。" }));
      return;
    }
    const { error } = await supabase.from("trips").select("id").limit(1);
    setCloudConnectionCheck(
      withTestedAt(error ? { status: "失敗", message: error.message } : { status: "成功", message: "雲端連線正常" })
    );
  }

  async function testFamilyNotificationPreflight() {
    if (confirmedFamilyOptions.length === 0 && selectedTripRecipients.length === 0) {
      setFamilyNotificationCheck(withTestedAt({ status: "警告", message: "尚未連線家人，略過。" }));
      return;
    }
    const share = cloudShareRef.current;
    if (share.status !== "active" || !share.shareCode) {
      setFamilyNotificationCheck(withTestedAt({ status: "警告", message: "需要進行中共享行程才能送出家人通知測試。" }));
      return;
    }
    setFamilyNotificationCheck({ status: "測試中", message: "正在測試家人通知..." });
    try {
      await testFamilyNotification();
      setFamilyNotificationCheck(withTestedAt({ status: "成功", message: "已呼叫家人通知測試" }));
    } catch (error) {
      setFamilyNotificationCheck(withTestedAt({ status: "失敗", message: error instanceof Error ? error.message : "家人通知測試失敗" }));
    }
  }

  function testFamilyWakePreflight() {
    const canWake = confirmedFamilyOptions.some((option) => option.permissions.can_wake_me !== false);
    if (!activeTrip || !canWake) {
      setFamilyWakeCheck(withTestedAt({ status: "警告", message: "需要進行中行程與可呼叫權限。" }));
      return;
    }
    testFamilyWake();
    setFamilyWakeCheck(withTestedAt({ status: "成功", message: "已觸發家人呼叫測試" }));
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
    autoCloudShareStartedRef.current = false;
    arrivalCandidateStartedAtRef.current = null;
    confirmedArrivalCompletedRef.current = false;
    maybeArrivedCandidateStartedAtRef.current = null;
    maybeArrivedNotifiedRef.current = false;
    autoExtendedUntilRef.current = null;
    setOwnerTripMuted(false);
    setStrongAlert("正在等待第一次定位，成功後會進入旅程模式。");
    appendEvent(
      "正式開始旅程",
      `前往 ${preflightDestination.name}，快到提醒距離 ${formatDistance(preflightRadiusMeters)}，已抵達判斷距離 ${formatDistance(preflightArrivalRadiusMeters)}，有效時間 ${formatTripDuration(tripDurationMinutes)}`
    );
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        if (!tripStartedRef.current) {
          tripStartedRef.current = true;
          setPreflightOpen(false);
          setStrongAlert(null);
          appendEvent(
            "開始行程",
            `前往 ${preflightDestination.name}，快到提醒距離 ${formatDistance(preflightRadiusMeters)}，已抵達判斷距離 ${formatDistance(preflightArrivalRadiusMeters)}，有效時間 ${formatTripDuration(tripDurationMinutes)}`
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
    evaluateArrivalLifecycle(distanceMeters, tripArrivalRadius, destination);
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

  function evaluateArrivalLifecycle(distanceMeters: number, tripArrivalRadius: number, destination: Destination) {
    const now = Date.now();
    if (distanceMeters <= CONFIRMED_ARRIVAL_DISTANCE_METERS) {
      maybeArrivedCandidateStartedAtRef.current = null;
      if (!arrivalCandidateStartedAtRef.current) {
        arrivalCandidateStartedAtRef.current = now;
        setForegroundLocationMessage("已接近目的地，正在確認是否連續停留。");
        return;
      }
      if (
        !confirmedArrivalCompletedRef.current &&
        now - arrivalCandidateStartedAtRef.current >= CONFIRMED_ARRIVAL_DURATION_MS
      ) {
        confirmedArrivalCompletedRef.current = true;
        void completeConfirmedArrival(destination);
      }
      return;
    }

    if (arrivalCandidateStartedAtRef.current) {
      arrivalCandidateStartedAtRef.current = null;
      setForegroundLocationMessage("尚未確認抵達，會繼續更新位置。");
    }

    if (distanceMeters <= tripArrivalRadius) {
      if (!maybeArrivedCandidateStartedAtRef.current) {
        maybeArrivedCandidateStartedAtRef.current = now;
        return;
      }
      if (!maybeArrivedNotifiedRef.current && now - maybeArrivedCandidateStartedAtRef.current >= MAYBE_ARRIVED_DELAY_MS) {
        maybeArrivedNotifiedRef.current = true;
        setStrongAlert("你可能已抵達目的地附近，請確認是否需要下車。");
        playAlert();
        appendEvent("已抵達", "可能已抵達目的地附近，尚未連續停留確認。");
        const share = cloudShareRef.current;
        if (share.status === "active") {
          void notifyTripEvents(share.tripId, share.shareCode, "maybe_arrived");
        }
      }
      return;
    }

    maybeArrivedCandidateStartedAtRef.current = null;
    maybeArrivedNotifiedRef.current = false;
  }

  async function completeConfirmedArrival(destination: Destination) {
    setStrongAlert("已確認抵達目的地附近，這趟行程將結束。");
    playAlert();
    appendEvent("已抵達", `${destination.name} 已連續停留確認抵達`);
    const share = cloudShareRef.current;
    if (share.status === "active") {
      await notifyTripEvents(share.tripId, share.shareCode, "arrived");
    }
    const ended = await endCloudTrip("已抵達");
    if (!ended) {
      setStrongAlert("已確認抵達，但雲端結束同步失敗，請稍後再試。");
      return;
    }
    stopGeolocationWatch();
    releaseWakeLock();
    stopAlertSoundLoop();
    setActiveTrip(null);
    setPreflightOpen(false);
    setPreflightDestination(null);
    setCloudShare((current) =>
      current.status === "active" ? { ...current, status: "idle", message: "已確認抵達，行程已結束" } : current
    );
  }

  async function stopTrip() {
    if (activeTrip) {
      const ended = await endCloudTrip(activeTrip.status);
      if (!ended) {
        setStrongAlert("結束行程同步失敗，請稍後再試。");
        return;
      }
      stopGeolocationWatch();
      releaseWakeLock();
      stopAlertSoundLoop();
      setTripAlertSoundStatus(ownerTripMuted ? "已停止" : "已解鎖");
      appendEvent("停止行程", `${activeTrip.destination.name} 的行程已停止`);
    }
    setActiveTrip(null);
    setStrongAlert(null);
    setWakeLockStatus("尚未啟用");
    setPreflightOpen(false);
    setPreflightDestination(null);
    tripStartedRef.current = false;
    autoCloudShareStartedRef.current = false;
    arrivalCandidateStartedAtRef.current = null;
    confirmedArrivalCompletedRef.current = false;
    maybeArrivedCandidateStartedAtRef.current = null;
    maybeArrivedNotifiedRef.current = false;
    autoExtendedUntilRef.current = null;
    setCloudShare((current) =>
      current.status === "active" ? { ...current, status: "idle", message: "共享行程已停止" } : current
    );
  }

  async function enableCloudSharing(forceEndExisting = false) {
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
    setExistingCloudTrip(null);

    const shareCode = createShareCode();
    const shareUrl = `${window.location.origin}/share/${shareCode}`;
    const approximate = activeTrip.lastPosition ? getApproximateLocation(activeTrip.lastPosition.lat, activeTrip.lastPosition.lng) : null;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + tripDurationMinutes * 60_000).toISOString();

    try {
      await supabase.from("users").upsert(
        {
          display_name: user.nickname,
          user_code: user.code
        },
        { ignoreDuplicates: true, onConflict: "user_code" }
      );

      const nowIso = new Date().toISOString();
      const { data: existingTrip } = await supabase
        .from("trips")
        .select("*")
        .eq("owner_code", user.code)
        .is("ended_at", null)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingTrip && !forceEndExisting) {
        setExistingCloudTrip(existingTrip as FamilyTripRow);
        setCloudShare({
          status: "error",
          message: "你目前已有一趟進行中的行程。"
        });
        return;
      }

      if (existingTrip && forceEndExisting) {
        await supabase
          .from("trips")
          .update({
            status: "ended",
            ended_at: new Date().toISOString()
          })
          .eq("id", (existingTrip as { id: string }).id);
      }

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
          last_location_at: activeTrip.lastPosition?.updatedAt ?? null,
          duration_minutes: tripDurationMinutes,
          expires_at: expiresAt
        })
        .select("id, share_code")
        .single();

      if (error || !data) {
        throw error ?? new Error("Missing trip row");
      }

      const recipientCodes = selectedTripRecipients.filter((code) => code !== user.code);
      if (recipientCodes.length > 0) {
        const recipientRows = recipientCodes.map((code) => ({
          trip_id: data.id,
          share_code: data.share_code,
          owner_code: user.code,
          recipient_code: code,
          source: "manual_start_selection",
          can_view: true,
          can_receive_notifications: true
        }));
        await supabase.from("trip_recipients").insert(recipientRows);
      }

      setCloudShare({
        status: "active",
        message: `家人共享已開啟，有效時間 ${formatTripDuration(tripDurationMinutes)}`,
        tripId: data.id,
        shareCode: data.share_code,
        shareUrl,
        expiresAt
      });
      appendEvent("開啟家人共享", `分享連結已建立：${shareUrl}`);
      void notifyFamilyTripEvent(data.share_code, "trip_started");
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

  async function copyShareCode() {
    if (!cloudShare.shareCode) {
      return;
    }

    try {
      await navigator.clipboard.writeText(cloudShare.shareCode);
      setCloudShare((current) => ({ ...current, message: "行程代碼已複製" }));
    } catch {
      setCloudShare((current) => ({ ...current, message: "複製失敗，請手動選取行程代碼" }));
    }
  }

  async function openViewerTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) {
      return;
    }
    const ownerCode = viewerCodeInput.trim().toUpperCase();
    const shareCode = viewerShareCode.trim();
    if (!ownerCode) {
      setViewerEntryMessage("請先輸入家人代號。");
      return;
    }
    await openFamilyTripByOwner(ownerCode, shareCode || undefined);
  }

  async function openFamilyTripByOwner(ownerCode: string, shareCode?: string) {
    if (!user) {
      return;
    }

    setViewerEntryMessage("正在查詢家人目前行程...");
    const query = new URLSearchParams({
      viewer_code: user.code,
      owner_code: ownerCode
    });
    if (shareCode) {
      query.set("share_code", shareCode);
    }

    try {
      const response = await fetch(`/api/family/trips?${query.toString()}`);
      const payload = (await response.json()) as { ok?: boolean; error?: string; message?: string; trip?: FamilyTripRow; trips?: FamilyTripRow[] };
      if (!response.ok || payload.ok === false) {
        setViewerEntryMessage(payload.error ?? "查詢失敗，請稍後再試。");
        return;
      }
      const trip = payload.trip ?? payload.trips?.[0];
      if (!trip?.share_code) {
        setViewerEntryMessage(payload.message ?? "這位家人目前沒有進行中的行程。");
        return;
      }
      window.location.href = `/share/${encodeURIComponent(trip.share_code)}?viewer=${encodeURIComponent(user.code)}`;
    } catch (error) {
      setViewerEntryMessage(`查詢失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    }
  }

  async function ensureCloudUser(profile: UserProfile) {
    if (!supabase) {
      return;
    }
    await supabase.from("users").upsert(
      {
        display_name: profile.nickname,
        user_code: profile.code
      },
      { ignoreDuplicates: true, onConflict: "user_code" }
    );
  }

  async function loadFamilyConnections(code: string) {
    try {
      const response = await fetch(`/api/family/list?code=${encodeURIComponent(code)}`);
      const payload = (await response.json()) as { connections?: FamilyConnectionRow[]; error?: string };
      setFamilyConnections(payload.connections ?? []);
      if (payload.error) {
        setFamilyConnectionMessage(payload.error);
      }
    } catch (error) {
      setFamilyConnectionMessage(error instanceof Error ? error.message : "家人連線讀取失敗");
    }
  }

  async function loadFamilyTrips(code: string) {
    try {
      const response = await fetch(`/api/family/trips?viewer_code=${encodeURIComponent(code)}`);
      const payload = (await response.json()) as { trips?: FamilyTripRow[] };
      setFamilyTrips(payload.trips ?? []);
    } catch {
      setFamilyTrips([]);
    }
  }

  async function connectFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) {
      return;
    }
    const code = connectionCode.trim().toUpperCase();
    if (!code || code === user.code) {
      setFamilyConnectionMessage("請輸入有效的家人代號。");
      return;
    }

    const response = await fetch("/api/family/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        my_code: user.code,
        family_code: code,
        permissions: connectionPermissions
      })
    });
    const payload = (await response.json()) as { ok?: boolean; error?: string };
    setFamilyConnectionMessage(payload.ok ? "已送出家人連線，等待雙方確認。" : payload.error ?? "家人連線失敗");
    if (payload.ok) {
      setConnectionCode("");
      void loadFamilyConnections(user.code);
    }
  }

  async function disconnectFamily(code: string) {
    if (!user) {
      return;
    }
    if (!window.confirm("確定刪除這位家人嗎？")) {
      return;
    }
    await fetch("/api/family/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        my_code: user.code,
        family_code: code
      })
    });
    setSelectedTripRecipients((current) => current.filter((item) => item !== code));
    void loadFamilyConnections(user.code);
  }

  async function runPreflightAll() {
    if (!user) {
      return;
    }
    setLocationCheck({ status: "測試中", message: "正在測試定位..." });
    setAudioCheck({ status: "測試中", message: "正在測試提示音..." });
    setVibrationCheck({ status: "測試中", message: "正在測試震動..." });
    setWakeLockCheck({ status: "測試中", message: "正在測試防鎖屏..." });
    setNotificationPermissionCheck({ status: "測試中", message: "正在測試背景通知..." });
    setCloudConnectionCheck({ status: "測試中", message: "正在測試雲端連線..." });

    const locationResult = await getLocationPreflightCheck();
    const soundResult = await getSoundPreflightCheck();
    const webPushResult = getWebPushPreflightCheck();
    const serviceWorkerResult = await getServiceWorkerPreflightCheck();
    const pushSubscriptionResult = await getPushSubscriptionPreflightCheck();
    const wakeLockResult = getWakeLockPreflightCheck();
    const vibrationResult = getVibrationPreflightCheck();
    const cloudResult = await getCloudPreflightCheck();

    setLocationCheck(
      withTestedAt({
        status: locationResult.status === "success" ? "成功" : "失敗",
        message: locationResult.message
      })
    );
    setAudioCheck(
      withTestedAt({
        status: soundResult.status === "success" ? "成功" : soundResult.status === "warning" ? "警告" : "失敗",
        message: soundResult.message
      })
    );
    setVibrationCheck(
      withTestedAt({
        status: vibrationResult.status === "success" ? "成功" : "警告",
        message: vibrationResult.message
      })
    );
    setWakeLockCheck(
      withTestedAt({
        status: wakeLockResult.status === "success" ? "成功" : "警告",
        message: wakeLockResult.message
      })
    );
    setNotificationPermissionCheck(
      withTestedAt({
        status: webPushResult.status === "success" && serviceWorkerResult.status === "success" && pushSubscriptionResult.status !== "failed" ? "成功" : "警告",
        message: pushSubscriptionResult.message || webPushResult.message
      })
    );
    setCloudConnectionCheck(
      withTestedAt({
        status: cloudResult.status === "success" ? "成功" : "失敗",
        message: cloudResult.message
      })
    );
    setFamilyNotificationCheck(
      withTestedAt(
        confirmedFamilyOptions.length > 0 || selectedTripRecipients.length > 0
          ? { status: "警告", message: "有家人可通知；實際推播需在行程共享後測試。" }
          : { status: "警告", message: "尚未連線家人，略過。" }
      )
    );
    setFamilyWakeCheck(
      withTestedAt(
        activeTrip ? { status: "警告", message: "行程中可用測試模式驗證家人呼叫。" } : { status: "警告", message: "需要進行中行程與可呼叫權限。" }
      )
    );

    const results: PreflightCheckResult[] = [
      getHttpsPwaCheck(),
      locationResult,
      soundResult,
      webPushResult,
      serviceWorkerResult,
      pushSubscriptionResult,
      wakeLockResult,
      vibrationResult,
      cloudResult
    ];

    try {
      const response = await fetch(`/api/preflight/check-all?code=${encodeURIComponent(user.code)}`);
      const payload = (await response.json()) as { checks?: PreflightCheckResult[] };
      results.push(...(payload.checks ?? []));
    } catch {
      results.push({
        key: "serverPreflight",
        label: "伺服器檢查",
        status: "warning",
        message: "伺服器檢查暫時無法完成。",
        suggestion: "仍可開始行程，但家人通知可能需要手動確認。"
      });
    }

    const failed = results.filter((item) => item.status === "failed").length;
    const warnings = results.filter((item) => item.status === "warning").length;
    setPreflightResults(results);
    setPreflightSummary(failed > 0 ? "有項目失敗，若 GPS 不可用請先修正。" : warnings > 0 ? "部分功能可能無法使用，仍可開始行程。" : "行前檢查完成。");
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

    await maybeAutoExtendCloudTrip(destination);

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
    const now = Date.now();
    if (!ownerTripMuted && now - lastNotifyAttemptRef.current > 60_000) {
      lastNotifyAttemptRef.current = now;
      void notifyTripEvents(share.tripId, share.shareCode);
    }
  }

  async function maybeAutoExtendCloudTrip(destination: Destination) {
    const share = cloudShareRef.current;
    if (!supabase || share.status !== "active" || !share.tripId || !share.expiresAt) {
      return;
    }

    const expiresAtMs = new Date(share.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || Date.now() < expiresAtMs || autoExtendedUntilRef.current === share.expiresAt) {
      return;
    }

    const previousExpiresAt = share.expiresAt;
    const nextExpiresAt = new Date(Date.now() + AUTO_EXTEND_MINUTES * 60_000).toISOString();
    autoExtendedUntilRef.current = previousExpiresAt;
    const { error } = await supabase
      .from("trips")
      .update({
        expires_at: nextExpiresAt,
        status: "行程中"
      })
      .eq("id", share.tripId);

    if (error) {
      setCloudShare((current) => ({ ...current, message: `行程延長失敗：${error.message}` }));
      appendStatusEventOnce("雲端行程同步失敗", "行程有效時間自動延長失敗");
      return;
    }

    setCloudShare((current) =>
      current.status === "active"
        ? {
            ...current,
            expiresAt: nextExpiresAt,
            message: "行程仍在進行，已自動延長 30 分鐘"
          }
        : current
    );
    appendEvent("雲端行程同步成功", `${destination.name} 行程已自動延長 30 分鐘`);
    void notifyTripEvents(share.tripId, share.shareCode, "auto_extended");
  }

  async function notifyTripEvents(tripId?: string, shareCode?: string, eventType?: string) {
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
          shareCode,
          eventType
        })
      });
    } catch {
      // 自動通知失敗不應影響本機行程或雲端同步。
    }
  }

  async function stopOwnerTripNotifications() {
    setOwnerTripMuted(true);
    setTripAlertSoundStatus("已停止");
    stopAlertSoundLoop();
    const share = cloudShareRef.current;
    if (!user || share.status !== "active" || !share.shareCode) {
      setAudioStatus("本趟通知已停止。若尚未開啟家人共享，停止狀態只保留在本頁。");
      return;
    }

    try {
      const response = await fetch("/api/notify/mute-trip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          share_code: share.shareCode,
          role: "owner",
          user_code: user.code,
          event_type: "all"
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setAudioStatus(payload.ok ? "本趟通知已停止。" : `本趟通知停止失敗：${payload.error ?? "未知錯誤"}`);
    } catch (error) {
      setAudioStatus(`本趟通知停止失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    }
  }

  function updateTestTripState({
    distanceMeters,
    status,
    updatedAt
  }: {
    distanceMeters?: number;
    status?: TripStatus;
    updatedAt?: string;
  }) {
    if (!activeTrip) {
      setTestModeMessage("請先開始一趟測試行程。");
      return;
    }

    const nextUpdatedAt = updatedAt ?? activeTrip.lastPosition?.updatedAt ?? new Date().toISOString();
    const nextPosition = activeTrip.lastPosition
      ? { ...activeTrip.lastPosition, updatedAt: nextUpdatedAt }
      : undefined;
    const nextStatus = status ?? activeTrip.status;
    setActiveTrip((trip) =>
      trip
        ? {
            ...trip,
            distanceMeters: distanceMeters ?? trip.distanceMeters,
            lastPosition: nextPosition,
            status: nextStatus,
            health: getLocationHealth(nextUpdatedAt)
          }
        : trip
    );

    const share = cloudShareRef.current;
    if (supabase && share.status === "active" && share.tripId) {
      void supabase
        .from("trips")
        .update({
          distance_m: distanceMeters ?? activeTrip.distanceMeters ?? null,
          status: nextStatus,
          last_location_at: nextUpdatedAt
        })
        .eq("id", share.tripId);
    }
    setTestModeMessage("測試狀態已套用。");
  }

  function simulateTestDistance(distanceMeters: number) {
    updateTestTripState({
      distanceMeters,
      status: distanceMeters <= arrivalRadiusMeters ? "已抵達" : distanceMeters <= radiusMeters ? "快到目的地" : "行程中",
      updatedAt: new Date().toISOString()
    });
  }

  function simulateTestStale(minutes: number) {
    updateTestTripState({
      updatedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
      status: minutes >= 5 ? "定位中斷" : "定位延遲"
    });
  }

  function simulateTestExpired() {
    const share = cloudShareRef.current;
    if (!activeTrip) {
      setTestModeMessage("請先開始一趟測試行程。");
      return;
    }
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    setCloudShare((current) => (current.status === "active" ? { ...current, expiresAt: expiredAt, message: "測試模式：行程已逾時" } : current));
    if (supabase && share.status === "active" && share.tripId) {
      void supabase.from("trips").update({ expires_at: expiredAt, status: "expired" }).eq("id", share.tripId);
    }
    setTestModeMessage("已模擬行程逾時。");
  }

  function simulateTestArrived() {
    simulateTestDistance(Math.min(arrivalRadiusMeters, 90));
    setStrongAlert("測試模式：已抵達目的地附近。");
  }

  async function testOwnerNotification() {
    showLocalTestNotification();
    appendNotificationCenterItem({
      type: "測試本人通知",
      success: true,
      shareCode: cloudShareRef.current.shareCode ?? null,
      recipientCode: user?.code ?? null
    });
    setTestModeMessage("已送出本機測試通知。");
  }

  async function testFamilyNotification() {
    const share = cloudShareRef.current;
    if (share.status !== "active" || !share.shareCode) {
      setTestModeMessage("請先開始一趟測試行程並開啟家人共享。");
      return;
    }
    try {
      await notifyFamilyTripEvent(share.shareCode, "trip_started");
      appendNotificationCenterItem({
        type: "測試家人通知",
        success: true,
        shareCode: share.shareCode,
        recipientCode: selectedTripRecipients.join(",")
      });
      setTestModeMessage("已呼叫家人通知測試。");
    } catch (error) {
      setTestModeMessage(`家人通知測試失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    }
  }

  function testFamilyWake() {
    simulateWake();
    setTestModeMessage("已觸發本機家人呼叫測試。");
  }

  async function clearTripMuteForTest() {
    const share = cloudShareRef.current;
    if (!supabase || share.status !== "active" || !share.shareCode || !user) {
      setOwnerTripMuted(false);
      setTripAlertSoundStatus("已解鎖");
      setTestModeMessage("已清除本機停止狀態。");
      return;
    }
    const { error } = await supabase
      .from("trip_notification_mutes")
      .update({ muted: false })
      .eq("share_code", share.shareCode)
      .eq("user_code", user.code);
    setOwnerTripMuted(false);
    setTripAlertSoundStatus("已解鎖");
    setTestModeMessage(error ? `清除停止狀態失敗：${error.message}` : "已清除本趟通知停止狀態。");
  }

  async function endCloudTrip(status: string) {
    const share = cloudShareRef.current;
    if (!supabase || share.status !== "active" || !share.tripId) {
      return true;
    }

    const { error } = await supabase
      .from("trips")
      .update({
        status: status === "已抵達" ? "arrived" : "ended",
        ended_at: new Date().toISOString()
      })
      .eq("id", share.tripId);

    if (error) {
      appendStatusEventOnce("雲端行程同步失敗", "停止行程同步到 Supabase 失敗");
      return false;
    }

    appendEvent("停止家人共享", "雲端共享行程已標記結束");
    if (share.shareCode) {
      void notifyFamilyTripEvent(share.shareCode, "trip_ended");
      void stopOwnerTripNotifications();
    }
    return true;
  }

  async function notifyFamilyTripEvent(shareCode: string, type: "trip_started" | "trip_ended") {
    try {
      await fetch("/api/notify/family-trip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          share_code: shareCode,
          type
        })
      });
    } catch {
      // 家人通知失敗不影響本機行程。
    }
  }

  async function enableNotifications() {
    if (!user) {
      return;
    }
    setNotificationDiagnostics(await getNotificationDiagnostics());
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
      setNotificationDiagnostics(await getNotificationDiagnostics(subscription, "尚未寫入"));

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
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? "通知訂閱寫入 Supabase 失敗");
      }

      setNotificationState({
        status: "已啟用",
        message: "通知已啟用。連續呼叫提醒最多 15 秒，可由本人關閉。"
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(subscription, "成功"));
      appendEvent("通知訂閱成功", "Web Push 通知已啟用");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Web Push 通知訂閱失敗";
      setNotificationState({
        status: "尚未啟用",
        message: `通知訂閱失敗：${message}`
      });
      setNotificationDiagnostics(await getNotificationDiagnostics(null, message));
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

    void playAlertSoundFor(5000).then((result) => {
      if (!result.ok) {
        setAudioStatus(result.error ?? "提醒音播放失敗，畫面仍會強提醒");
      }
    });
  }

  async function addFamilyMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = familyCode.trim().toUpperCase();
    if (!code || !user) {
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
    appendEvent("新增家人權限", `${code} 已加入，權限：${getFamilyPermissionLabel(familyPermission)}`);

    if (!supabase) {
      return;
    }

    const { error } = await supabase.from("permissions").upsert(
      {
        owner_code: user.code,
        viewer_code: code,
        permission_level: familyPermission,
        enabled: true
      },
      { onConflict: "owner_code,viewer_code,permission_level" }
    );

    if (error) {
      appendStatusEventOnce("雲端行程同步失敗", `家人權限寫入 Supabase 失敗：${error.message}`);
    }
  }

  async function deleteFamilyMember(member: FamilyMember) {
    if (!window.confirm("確定刪除這位家人嗎？")) {
      return;
    }
    setFamily((current) => current.filter((item) => item.id !== member.id));
    setSelectedTripRecipients((current) => current.filter((item) => item !== member.code));
    appendEvent("刪除家人權限", `${member.code} 的權限已刪除`);
    if (supabase && user) {
      try {
        await supabase.from("permissions").update({ enabled: false }).eq("owner_code", user.code).eq("viewer_code", member.code);
      } catch {
        appendStatusEventOnce("雲端行程同步失敗", "刪除家人權限同步到 Supabase 失敗");
      }
    }
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
    setShowAllPlaceCandidates(false);
    setPlaceSearchState({ status: "idle", message: "" });
    setRadiusMeters(DEFAULT_TRIP_SETTINGS.alertRadiusMeters);
    setCustomRadiusInput("");
    setRadiusNotice("");
    setArrivalRadiusMeters(DEFAULT_TRIP_SETTINGS.arrivalRadiusMeters);
    setTripDurationMinutes(DEFAULT_TRIP_DURATION_MINUTES);
    setCustomTripDurationInput("");
    setSelectedTripRecipients([]);
    setExistingCloudTrip(null);
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
          <div className="entry-tabs">
            <span>我要開始行程</span>
            <span>我是家人，用代號查看</span>
          </div>
          <p className="muted">本人請先建立本機暱稱；家人完成連線後可用家人代號查看目前行程，分享連結作為備用。</p>
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
          <form className="stack viewer-entry" onSubmit={openViewerTrip}>
            <p className="eyebrow">我是家人，要查看行程</p>
            <label>
              行程代碼
              <input value={viewerShareCode} onChange={(event) => setViewerShareCode(event.target.value)} placeholder="貼上或輸入 share_code" />
            </label>
            <label>
              我的家人代碼，可選
              <input value={viewerCodeInput} onChange={(event) => setViewerCodeInput(event.target.value.toUpperCase())} placeholder="例如：FAMILY-1234" />
            </label>
            {viewerEntryMessage ? <p className="warning">{viewerEntryMessage}</p> : null}
            <button className="secondary-button" type="submit">
              查看行程
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar app-topbar">
        <div>
          <p className="eyebrow">GeoClock</p>
          <h1>到站提醒</h1>
          <p className="mobile-subtitle">家人協助通知</p>
          <p className="muted">我的代號：<button className="inline-code-button" onClick={() => navigator.clipboard.writeText(user.code)} type="button">{user.code}</button></p>
        </div>
        <button className="secondary-button small-button settings-button" onClick={() => setSidebarOpen(true)} type="button">
          設定
          {diagnosticsWarningCount > 0 || notificationState.status !== "已啟用" ? <span className="status-dot" aria-hidden="true" /> : null}
        </button>
      </header>

      <section className="status-strip" aria-label="狀態摘要">
        <button className={notificationState.status === "已啟用" ? "status-badge good-badge" : "status-badge warning-badge"} onClick={() => { setSidebarSection("notifications"); setSidebarOpen(true); }} type="button">
          {notificationBadge}
        </button>
        <button className={soundBadge.includes("已解鎖") ? "status-badge good-badge" : "status-badge"} onClick={() => { setSidebarSection("notifications"); setSidebarOpen(true); }} type="button">
          {soundBadge}
        </button>
        <button className="status-badge" onClick={() => { setSidebarSection("family"); setSidebarOpen(true); }} type="button">
          家人：{activeFamilyConnectionsCount} 人
        </button>
        <button className={locationBadge.includes("暫停") || locationBadge.includes("中斷") || locationBadge.includes("失效") ? "status-badge warning-badge" : "status-badge"} onClick={() => { setSidebarSection("diagnostics"); setSidebarOpen(true); }} type="button">
          {locationBadge}
        </button>
        <button className={notificationUnreadCount > 0 ? "status-badge warning-badge" : "status-badge"} onClick={() => { setSidebarSection("notificationCenter"); setSidebarOpen(true); }} type="button">
          通知中心：{notificationUnreadCount} 則
        </button>
      </section>

      {strongAlert ? (
        <section className="alert-panel" role="alert">
          <p className="eyebrow">重要提醒</p>
          <h2>{strongAlert}</h2>
          {activeWakeRequest ? (
            <button className="primary-button" onClick={acknowledgeWakeRequest}>
              我醒了
            </button>
          ) : (
            <button className="secondary-button" onClick={() => setStrongAlert(null)}>
              知道了
            </button>
          )}
        </section>
      ) : null}

      <section className="v6-main-grid">
        <article className="card v6-action-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">開始行程</p>
              <h2>我要開始行程</h2>
            </div>
            <button className="ghost-button small-button" onClick={() => { setSidebarSection("preflight"); setSidebarOpen(true); }} type="button">
              行前測試
            </button>
          </div>

          {!activeTrip ? (
            <div className="stack">
              <p className="step-label">Step 1：去哪裡</p>
              <form className="compact-destination-form" onSubmit={handleDestinationSubmit}>
                <label>
                  目的地名稱
                  <input
                    value={destinationForm.name}
                    onChange={(event) => setDestinationForm((form) => ({ ...form, name: event.target.value }))}
                    placeholder="例如：台中車站"
                  />
                </label>
                <label>
                  地址或地點
                  <input
                    value={destinationForm.address}
                    onChange={(event) => setDestinationForm((form) => ({ ...form, address: event.target.value }))}
                    placeholder="輸入地點後可搜尋"
                  />
                </label>
                <button className="secondary-button" disabled={placeSearchState.status === "loading"} onClick={searchPlaces} type="button">
                  {placeSearchState.status === "loading" ? "搜尋中" : "搜尋地點"}
                </button>
                <button className="primary-button" type="submit">
                  儲存目的地
                </button>
              </form>
              {placeSearchState.message ? <p className={placeSearchState.status === "success" ? "inline-status good" : "inline-status warning"}>{placeSearchState.message}</p> : null}
              {destinationNotice ? <p className="form-notice">{destinationNotice}</p> : null}
              {placeCandidates.length > 0 ? (
                <div className="candidate-list compact-list">
                  {(showAllPlaceCandidates ? placeCandidates : placeCandidates.slice(0, 3)).map((candidate) => (
                    <button className="candidate-button" key={candidate.id} onClick={() => selectPlaceCandidate(candidate)} type="button">
                      <strong>{candidate.label}</strong>
                      <span>{candidate.address}</span>
                    </button>
                  ))}
                  {placeCandidates.length > 3 ? (
                    <button className="secondary-button small-button" onClick={() => setShowAllPlaceCandidates((value) => !value)} type="button">
                      {showAllPlaceCandidates ? "收合結果" : `顯示更多（${placeCandidates.length - 3}）`}
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="destination-list compact-list">
                {destinations.length === 0 ? (
                  <p className="muted">尚未建立目的地。</p>
                ) : (
                  destinations.slice(0, 4).map((destination) => (
                    <div className={`destination-row ${selectedDestinationId === destination.id ? "selected" : ""}`} key={destination.id}>
                      <button type="button" onClick={() => selectDestination(destination)}>
                        <strong>{destination.name}</strong>
                        <span>{destination.address}</span>
                        <span className={hasCoordinates(destination) ? "good" : "warning"}>
                          {hasCoordinates(destination) ? "已取得目的地定位" : "定位資料尚未取得"}
                        </span>
                      </button>
                      <button
                        aria-label={`刪除 ${destination.name}`}
                        className="icon-danger-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteDestination(destination.id);
                        }}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>

              <p className="step-label">Step 2：何時提醒</p>
              <div className="radius-options">
                {RADIUS_OPTIONS.map((option) => (
                  <button className={radiusMeters === option.value ? "selected" : ""} key={option.value} onClick={() => chooseAlertRadius(option.value)} type="button">
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="status-grid">
                <Metric label="快到提醒距離" value={formatDistance(radiusMeters)} />
                <Metric label="已抵達判斷距離" value={formatDistance(arrivalRadiusMeters)} />
              </div>
              <details className="mobile-details">
                <summary>進階距離設定</summary>
                <div className="custom-radius-row">
                  <label>
                    自訂快到距離
                    <input inputMode="numeric" value={customRadiusInput} onChange={(event) => setCustomRadiusInput(event.target.value)} placeholder="例如 750" />
                  </label>
                  <button className="secondary-button" onClick={applyCustomAlertRadius} type="button">
                    套用
                  </button>
                </div>
                <div className="radius-options">
                  {ARRIVAL_RADIUS_OPTIONS.map((option) => (
                    <button className={arrivalRadiusMeters === option ? "selected" : ""} key={option} onClick={() => chooseArrivalRadius(option)} type="button">
                      {formatDistance(option)}
                    </button>
                  ))}
                </div>
                {radiusNotice ? <p className="field-hint">{radiusNotice}</p> : null}
              </details>
              <div className="stack">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">行程有效時間</p>
                    <p className="muted">GeoClock 會在這段時間內視為行程進行中。超過時間後，行程會顯示可能已失效，避免舊行程一直通知。</p>
                  </div>
                </div>
                <div className="radius-options">
                  {TRIP_DURATION_OPTIONS.map((option) => (
                    <button className={tripDurationMinutes === option.value ? "selected" : ""} key={option.value} onClick={() => chooseTripDuration(option.value)} type="button">
                      {option.label}
                    </button>
                  ))}
                </div>
                <details className="mobile-details">
                  <summary>自訂有效時間</summary>
                  <div className="custom-radius-row">
                    <label>
                      自訂分鐘
                      <input inputMode="numeric" value={customTripDurationInput} onChange={(event) => setCustomTripDurationInput(event.target.value)} placeholder="例如 90" />
                    </label>
                    <button className="secondary-button" onClick={applyCustomTripDuration} type="button">
                      套用
                    </button>
                  </div>
                </details>
              </div>
              <div className="stack">
                <p className="step-label">Step 3：通知誰</p>
                <p className="eyebrow">通知家人</p>
                {confirmedFamilyOptions.length === 0 ? (
                  <p className="muted">尚未連線家人。你仍可開始行程，之後用分享連結提供查看。</p>
                ) : (
                  <div className="permission-grid">
                    {confirmedFamilyOptions.map((familyOption) => (
                      <label className="toggle-row" key={familyOption.code}>
                        <input
                          checked={selectedTripRecipients.includes(familyOption.code)}
                          onChange={(event) => toggleTripRecipient(familyOption.code, event.target.checked)}
                          type="checkbox"
                        />
                        <span>
                          {familyOption.code}
                          {!familyPushEnabledCodes.has(familyOption.code) ? "（尚未啟用通知，但仍可在 GeoClock 內查看）" : ""}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="preflight-summary-row">
                <span>行前檢查：{preflightBadge}</span>
                <div className="compact-actions">
                  <button className="secondary-button small-button" onClick={runPreflightAll} type="button">
                    一鍵測試
                  </button>
                  <button className="secondary-button small-button" onClick={() => { setSidebarSection("preflight"); setSidebarOpen(true); }} type="button">
                    單項測試
                  </button>
                </div>
              </div>
              {preflightResults.length > 0 && preflightResults.some((item) => item.status !== "success") ? (
                <p className="warning">部分提醒功能尚未啟用，仍可開始行程，但提醒可能不完整。</p>
              ) : null}
              {notificationState.status !== "已啟用" ? <p className="warning">尚未啟用背景通知，鎖屏後可能收不到提醒。仍可開始行程。</p> : null}
              <p className="muted">背景通知會透過系統通知提醒。畫面開著時，可額外播放提示聲。</p>
              <p className="muted">畫面開著時會持續更新位置；鎖屏或切到背景後，iPhone 可能暫停網頁定位。</p>
              {existingCloudTrip ? (
                <div className="inline-status warning">
                  <strong>你目前已有一趟進行中的行程。</strong>
                  <div className="trip-actions">
                    <button className="secondary-button" onClick={() => (window.location.href = `/share/${existingCloudTrip.share_code}`)} type="button">
                      回到目前行程
                    </button>
                    <button className="danger-button" onClick={() => void enableCloudSharing(true)} type="button">
                      結束舊行程並開始新行程
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="trip-actions">
                <button className="primary-button" disabled={!selectedDestination || Boolean(activeTrip)} onClick={startTrip} type="button">
                  開始行程
                </button>
                <button className="secondary-button" onClick={() => { setSidebarSection("notifications"); setSidebarOpen(true); }} type="button">
                  通知設定
                </button>
              </div>
              {preflightOpen && preflightDestination ? (
                <div className="inline-status">
                  <strong>啟動前檢查：{preflightDestination.name}</strong>
                  <p className="field-hint">定位測試成功後才能正式開始旅程。詳細測試在側欄。</p>
                  <button className="primary-button" disabled={!preflightCanStart || Boolean(activeTrip)} onClick={startOfficialTrip} type="button">
                    正式開始旅程
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="stack">
              <div className="status-grid">
                <Metric label="目的地" value={activeTrip.destination.name} />
                <Metric label="目前距離" value={formatDistance(activeTrip.distanceMeters)} />
                <Metric label="狀態" value={activeTrip.status} />
                <Metric label="最後位置更新" value={formatTime(activeTrip.lastPosition?.updatedAt)} />
                <Metric label="背景通知" value={notificationState.status} />
                <Metric label="位置更新" value={getPublicLocationStatus(activeTrip.lastPosition?.updatedAt, false)} />
              </div>
              {foregroundLocationMessage ? <p className="form-notice">{foregroundLocationMessage}</p> : null}
              {cloudShare.expiresAt && Date.now() >= new Date(cloudShare.expiresAt).getTime() ? (
                <p className="warning">行程已超過有效時間，是否結束？</p>
              ) : null}
              <p className="notice">若一段時間沒有更新，家人會看到位置更新暫停。若需要穩定背景定位，之後需做原生 App。</p>
              <div className="trip-actions">
                <button className="secondary-button" disabled={ownerTripMuted} onClick={stopOwnerTripNotifications} type="button">
                  停止本趟通知
                </button>
                <button className="danger-button" onClick={stopTrip} type="button">
                  結束行程
                </button>
              </div>
              {mapDestination && hasCoordinates(mapDestination) ? (
                <div className="map-block compact-map">
                  <TripMap currentPosition={mapPosition} destination={mapDestination} radiusMeters={mapRadiusMeters} />
                </div>
              ) : null}
            </div>
          )}
        </article>

        <article className="card v6-action-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">查看家人</p>
              <h2>我要查看家人</h2>
            </div>
            <button className="ghost-button small-button" onClick={() => { setSidebarSection("family"); setSidebarOpen(true); }} type="button">
              家人設定
            </button>
          </div>
          <FamilyTripsPanel
            connections={familyConnections}
            currentUserCode={user.code}
            onOpenFamilySettings={() => { setSidebarSection("family"); setSidebarOpen(true); }}
            onRefresh={() => user && void loadFamilyTrips(user.code)}
            onViewOwner={(ownerCode) => void openFamilyTripByOwner(ownerCode)}
            trips={familyTrips}
          />
          <div className="manual-viewer-panel">
            <button className="advanced-toggle" onClick={() => setManualViewerOpen((value) => !value)} type="button">
              <span>用代號手動查看</span>
              <span>{manualViewerOpen ? "收合" : "展開"}</span>
            </button>
            {manualViewerOpen ? (
              <form className="viewer-entry compact-viewer-entry" onSubmit={openViewerTrip}>
                <label>
                  家人代號
                  <input value={viewerCodeInput} onChange={(event) => setViewerCodeInput(event.target.value.toUpperCase())} placeholder="例如 FAMILY-1234" required />
                </label>
                <label>
                  行程代碼，選填
                  <input value={viewerShareCode} onChange={(event) => setViewerShareCode(event.target.value)} placeholder="選填；只有對方給你特定行程代碼時才需要" />
                </label>
                <button className="primary-button" type="submit">
                  查看家人目前行程
                </button>
                {viewerEntryMessage ? <p className="warning">{viewerEntryMessage}</p> : null}
              </form>
            ) : null}
          </div>
        </article>
      </section>

      <SettingsSidebar
        activeSection={sidebarSection}
        activeTrip={activeTrip}
        audioCheck={audioCheck}
        cloudShare={cloudShare}
        connectionCode={connectionCode}
        connectionPermissions={connectionPermissions}
        diagnosticsWarningCount={diagnosticsWarningCount}
        events={events}
        familyConnectionMessage={familyConnectionMessage}
        familyConnections={familyConnections}
        isOpen={sidebarOpen}
        locationCheck={locationCheck}
        notificationDiagnostics={notificationDiagnostics}
        notificationCenterItems={notificationCenterItems}
        notificationCenterMessage={notificationCenterMessage}
        notificationPermissionCheck={notificationPermissionCheck}
        notificationState={notificationState}
        cloudConnectionCheck={cloudConnectionCheck}
        onClearLocalNotificationCenter={clearLocalNotificationCenter}
        onClearTripMuteForTest={clearTripMuteForTest}
        onClose={() => setSidebarOpen(false)}
        onConnectFamily={connectFamily}
        onCopyShareCode={copyShareCode}
        onCopyShareLink={copyShareLink}
        onDeleteFamily={disconnectFamily}
        onEnableCloudSharing={enableCloudSharing}
        onEnableNotifications={enableNotifications}
        onResetLocalData={resetLocalData}
        onRunPreflightAll={runPreflightAll}
        onSectionChange={setSidebarSection}
        onLoadNotificationCenter={loadNotificationCenter}
        onMarkNotificationCenterRead={markNotificationCenterRead}
        onSimulateArrived={simulateTestArrived}
        onSimulateDistance={simulateTestDistance}
        onSimulateEndTrip={stopTrip}
        onSimulateExpired={simulateTestExpired}
        onSimulateStale={simulateTestStale}
        onStartOfficialTrip={startOfficialTrip}
        onStopOwnerTripNotifications={stopOwnerTripNotifications}
        onTestFamilyNotification={testFamilyNotification}
        onTestFamilyWake={testFamilyWake}
        onTestOwnerNotification={testOwnerNotification}
        onTestAlertAudio={testAlertAudio}
        onTestCloudConnection={testCloudConnection}
        onTestFamilyNotificationPreflight={testFamilyNotificationPreflight}
        onTestFamilyWakePreflight={testFamilyWakePreflight}
        onTestLocation={testLocation}
        onTestNotificationPermission={testNotificationPermission}
        onTestVibration={testVibration}
        onTestWakeLock={testWakeLock}
        ownerTripMuted={ownerTripMuted}
        preflightArrivalRadiusMeters={preflightArrivalRadiusMeters}
        preflightCanStart={preflightCanStart}
        preflightChecksAttempted={preflightChecksAttempted}
        preflightDestination={preflightDestination}
        preflightOpen={preflightOpen}
        preflightRadiusMeters={preflightRadiusMeters}
        preflightResults={preflightResults}
        preflightSummary={preflightSummary}
        familyNotificationCheck={familyNotificationCheck}
        familyWakeCheck={familyWakeCheck}
        setConnectionCode={setConnectionCode}
        setConnectionPermissions={setConnectionPermissions}
        tripAlertSoundStatus={tripAlertSoundStatus}
        testModeMessage={testModeMessage}
        user={user}
        vibrationCheck={vibrationCheck}
        wakeLockCheck={wakeLockCheck}
        wakeLockStatus={wakeLockStatus}
      />

      <div className="legacy-v05-panels" aria-hidden="true">
      <section className="card">
        <p className="eyebrow">首頁模式</p>
        <div className="mode-switch">
          <button className={homeMode === "start" ? "selected" : ""} onClick={() => setHomeMode("start")} type="button">
            我要開始行程
            <span>目的地、距離設定、行前檢查、開始行程</span>
          </button>
          <button className={homeMode === "view" ? "selected" : ""} onClick={() => setHomeMode("view")} type="button">
            我要查看家人行程
            <span>已連線家人、進行中行程、查看 / 呼叫</span>
          </button>
          <button className={homeMode === "family" ? "selected" : ""} onClick={() => setHomeMode("family")} type="button">
            家人連線設定
            <span>我的代號、輸入家人代號、選權限、雙方確認</span>
          </button>
        </div>
      </section>

      {homeMode === "view" ? (
      <section className="card">
        <p className="eyebrow">入口</p>
        <div className="entry-tabs">
          <span>已連線家人</span>
          <span>備用：輸入行程代碼查看</span>
        </div>
        <FamilyTripsPanel trips={familyTrips} onRefresh={() => user && void loadFamilyTrips(user.code)} />
        <form className="viewer-entry" onSubmit={openViewerTrip}>
          <label>
            行程代碼
            <input value={viewerShareCode} onChange={(event) => setViewerShareCode(event.target.value)} placeholder="貼上或輸入 share_code" />
          </label>
          <label>
            我的家人代碼，可選
            <input value={viewerCodeInput} onChange={(event) => setViewerCodeInput(event.target.value.toUpperCase())} placeholder="例如：FAMILY-1234" />
          </label>
          <button className="secondary-button" type="submit">
            查看行程
          </button>
          {viewerEntryMessage ? <p className="warning">{viewerEntryMessage}</p> : null}
        </form>
      </section>
      ) : null}

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

      {homeMode === "start" ? (
      <>
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
          <p className="muted">{getStandaloneHint()}</p>
          <p className="muted">{notificationState.message}</p>
          <p className="muted">連續呼叫提醒最多 15 秒，可由本人關閉。</p>
          <button className="primary-button" disabled={notificationState.status === "被拒絕" || notificationState.status === "此瀏覽器不支援"} onClick={enableNotifications} type="button">
            啟用通知
          </button>
          <details className="advanced-settings">
            <summary>進階診斷</summary>
            <p className="field-hint">
              {notificationState.status === "已啟用" ? "通知設定完成。" : "通知尚未完成設定，點開查看原因。"}
            </p>
            <DiagnosticList items={notificationDiagnostics} />
          </details>
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
                <button
                  className="icon-danger-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteDestination(destination.id);
                  }}
                  aria-label={`刪除 ${destination.name}`}
                >
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

      <section className="card">
        <p className="eyebrow">本趟提醒</p>
        <div className="status-grid">
          <Metric label="提醒聲狀態" value={tripAlertSoundStatus} />
          <Metric label="本趟通知" value={ownerTripMuted ? "已停止" : "啟用中"} />
        </div>
        <p className="notice">前景開著時會每 10 秒響一次，每次約 5 秒。</p>
        <p className="muted">背景或鎖屏時只能依賴系統通知聲，網頁不能保證持續響鈴。</p>
        <div className="trip-actions">
          <button className="secondary-button" onClick={testAlertAudio} type="button">
            測試提示音
          </button>
          <button className="primary-button" disabled={!activeTrip || ownerTripMuted} onClick={stopOwnerTripNotifications} type="button">
            收到，停止本趟通知
          </button>
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">行前檢查</p>
        <h2>一鍵測試所有</h2>
        <p className="notice">部分功能可能無法使用時仍可開始行程；如果 GPS 完全不可用，請先修正定位設定。</p>
        <button className="primary-button" onClick={runPreflightAll} type="button">
          一鍵測試所有
        </button>
        {preflightSummary ? <p className="form-notice">{preflightSummary}</p> : null}
        {preflightResults.length > 0 ? <PreflightResultList items={preflightResults} /> : null}
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
          <button className="primary-button" disabled={!preflightCanStart || Boolean(activeTrip)} onClick={startOfficialTrip}>
            正式開始旅程
          </button>
          {locationCheck.status !== "成功" ? (
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
          <p className="notice">家人可以輸入行程代碼查看，也可以使用分享連結。分享頁只顯示粗略位置。</p>
          {cloudShare.status === "active" && cloudShare.shareUrl ? (
            <div className="stack">
              <div className="status-grid">
                <Metric label="我的代碼" value={user.code} />
                <Metric label="行程代碼" value={cloudShare.shareCode ?? "尚未建立"} />
              </div>
              <p className="big-code">{cloudShare.shareCode}</p>
              <div className="trip-actions">
                <button className="secondary-button" onClick={copyShareCode} type="button">
                  複製行程代碼
                </button>
                <button className="secondary-button" onClick={copyShareLink} type="button">
                  複製分享連結
                </button>
              </div>
              <div className="share-link-box">
                <span>{cloudShare.shareUrl}</span>
              </div>
            </div>
          ) : (
            <button className="primary-button" disabled={cloudShare.status === "creating"} onClick={() => void enableCloudSharing()} type="button">
              {cloudShare.status === "creating" ? "建立中" : "開啟家人共享"}
            </button>
          )}
          {cloudShare.message ? <p className={cloudShare.status === "error" ? "inline-status warning" : "inline-status good"}>{cloudShare.message}</p> : null}
        </section>
      ) : null}
      </>
      ) : null}

      {homeMode === "family" ? (
      <section className="grid">
        <article className="card">
          <p className="eyebrow">家人連線設定</p>
          <h2>我的代號</h2>
          <p className="big-code">{user.code}</p>
          <p className="notice">把你的代號給家人，雙方互相加入後，就能自動共享行程。</p>
          <button className="secondary-button" onClick={() => navigator.clipboard.writeText(user.code)} type="button">
            複製我的代號
          </button>
          <form className="stack" onSubmit={connectFamily}>
            <label>
              輸入家人代號
              <input value={connectionCode} onChange={(event) => setConnectionCode(event.target.value.toUpperCase())} placeholder="例如：AMOM-2048" />
            </label>
            <div className="permission-grid">
              {FAMILY_PERMISSION_OPTIONS.map((option) => (
                <label className="toggle-row" key={option.key}>
                  <input
                    checked={connectionPermissions[option.key]}
                    onChange={(event) =>
                      setConnectionPermissions((current) => ({
                        ...current,
                        [option.key]: event.target.checked
                      }))
                    }
                    type="checkbox"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <button className="primary-button" type="submit">
              加入家人
            </button>
          </form>
          {familyConnectionMessage ? <p className="form-notice">{familyConnectionMessage}</p> : null}
        </article>

        <article className="card">
          <p className="eyebrow">已連線家人</p>
          {familyConnections.length === 0 ? (
            <p className="muted">尚未建立家人連線。</p>
          ) : (
            <div className="family-list">
              {familyConnections.map((connection) => {
                const otherCode = connection.user_a_code === user.code ? connection.user_b_code : connection.user_a_code;
                const myPermissions = connection.user_a_code === user.code ? connection.user_a_permissions : connection.user_b_permissions;
                return (
                  <div className="family-row" key={connection.id}>
                    <div>
                      <strong>{otherCode}</strong>
                      <span>{getConnectionStatusLabel(connection)}</span>
                      <p className="field-hint">{formatPermissionSummary(myPermissions)}</p>
                    </div>
                    <button
                      className="icon-danger-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        disconnectFamily(otherCode);
                      }}
                      type="button"
                      aria-label={`刪除 ${otherCode}`}
                    >
                      解除
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </article>

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
                  <option key={permission.value} value={permission.value}>
                    {permission.label}
                  </option>
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
                    <span>{getFamilyPermissionLabel(member.permission)}</span>
                  </div>
                  <button
                    className="icon-danger-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteFamilyMember(member);
                    }}
                    type="button"
                    aria-label={`刪除 ${member.code}`}
                  >
                    刪除
                  </button>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
      ) : null}

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
      </div>
    </main>
  );
}

function SettingsSidebar({
  activeSection,
  activeTrip,
  audioCheck,
  cloudShare,
  cloudConnectionCheck,
  connectionCode,
  connectionPermissions,
  diagnosticsWarningCount,
  events,
  familyConnectionMessage,
  familyConnections,
  familyNotificationCheck,
  familyWakeCheck,
  isOpen,
  locationCheck,
  notificationDiagnostics,
  notificationCenterItems,
  notificationCenterMessage,
  notificationPermissionCheck,
  notificationState,
  onClearLocalNotificationCenter,
  onClearTripMuteForTest,
  onClose,
  onConnectFamily,
  onCopyShareCode,
  onCopyShareLink,
  onDeleteFamily,
  onEnableCloudSharing,
  onEnableNotifications,
  onResetLocalData,
  onRunPreflightAll,
  onLoadNotificationCenter,
  onMarkNotificationCenterRead,
  onSectionChange,
  onSimulateArrived,
  onSimulateDistance,
  onSimulateEndTrip,
  onSimulateExpired,
  onSimulateStale,
  onStartOfficialTrip,
  onStopOwnerTripNotifications,
  onTestFamilyNotification,
  onTestFamilyWake,
  onTestOwnerNotification,
  onTestAlertAudio,
  onTestCloudConnection,
  onTestFamilyNotificationPreflight,
  onTestFamilyWakePreflight,
  onTestLocation,
  onTestNotificationPermission,
  onTestVibration,
  onTestWakeLock,
  ownerTripMuted,
  preflightCanStart,
  preflightChecksAttempted,
  preflightDestination,
  preflightOpen,
  preflightResults,
  preflightSummary,
  setConnectionCode,
  setConnectionPermissions,
  tripAlertSoundStatus,
  testModeMessage,
  user,
  vibrationCheck,
  wakeLockCheck,
  wakeLockStatus
}: {
  activeSection: SidebarSection;
  activeTrip: ActiveTrip | null;
  audioCheck: PreflightCheckState;
  cloudConnectionCheck: PreflightCheckState;
  cloudShare: CloudShareState;
  connectionCode: string;
  connectionPermissions: FamilyPermissions;
  diagnosticsWarningCount: number;
  events: EventRecord[];
  familyConnectionMessage: string;
  familyConnections: FamilyConnectionRow[];
  familyNotificationCheck: PreflightCheckState;
  familyWakeCheck: PreflightCheckState;
  isOpen: boolean;
  locationCheck: LocationCheckState;
  notificationDiagnostics: NotificationDiagnostic[];
  notificationCenterItems: NotificationCenterItem[];
  notificationCenterMessage: string;
  notificationPermissionCheck: PreflightCheckState;
  notificationState: NotificationState;
  onClearLocalNotificationCenter: () => void;
  onClearTripMuteForTest: () => void;
  onClose: () => void;
  onConnectFamily: (event: FormEvent<HTMLFormElement>) => void;
  onCopyShareCode: () => void;
  onCopyShareLink: () => void;
  onDeleteFamily: (code: string) => void;
  onEnableCloudSharing: () => void;
  onEnableNotifications: () => void;
  onResetLocalData: () => void;
  onRunPreflightAll: () => void;
  onLoadNotificationCenter: () => void;
  onMarkNotificationCenterRead: () => void;
  onSectionChange: (section: SidebarSection) => void;
  onSimulateArrived: () => void;
  onSimulateDistance: (distanceMeters: number) => void;
  onSimulateEndTrip: () => void;
  onSimulateExpired: () => void;
  onSimulateStale: (minutes: number) => void;
  onStartOfficialTrip: () => void;
  onStopOwnerTripNotifications: () => void;
  onTestFamilyNotification: () => void;
  onTestFamilyWake: () => void;
  onTestOwnerNotification: () => void;
  onTestAlertAudio: () => void;
  onTestCloudConnection: () => void;
  onTestFamilyNotificationPreflight: () => void;
  onTestFamilyWakePreflight: () => void;
  onTestLocation: () => void;
  onTestNotificationPermission: () => void;
  onTestVibration: () => void;
  onTestWakeLock: () => void;
  ownerTripMuted: boolean;
  preflightArrivalRadiusMeters: number;
  preflightCanStart: boolean;
  preflightChecksAttempted: boolean;
  preflightDestination: Destination | null;
  preflightOpen: boolean;
  preflightRadiusMeters: number;
  preflightResults: PreflightCheckResult[];
  preflightSummary: string;
  setConnectionCode: (value: string) => void;
  setConnectionPermissions: (updater: (current: FamilyPermissions) => FamilyPermissions) => void;
  tripAlertSoundStatus: string;
  testModeMessage: string;
  user: UserProfile;
  vibrationCheck: PreflightCheckState;
  wakeLockCheck: PreflightCheckState;
  wakeLockStatus: string;
}) {
  const toggleSection = (section: Exclude<SidebarSection, null>) => {
    onSectionChange(activeSection === section ? null : section);
  };

  return (
    <>
      {isOpen ? <button className="sidebar-backdrop" aria-label="關閉設定" onClick={onClose} type="button" /> : null}
      <aside className={`settings-sidebar ${isOpen ? "open" : ""}`} aria-hidden={!isOpen}>
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">設定</p>
            <h2>GeoClock</h2>
            <p className="field-hint">測試、通知、家人連線與診斷都放在這裡。</p>
          </div>
          <button className="secondary-button small-button" onClick={onClose} type="button">
            關閉
          </button>
        </div>

        <SidebarPanel
          isOpen={activeSection === "preflight"}
          onToggle={() => toggleSection("preflight")}
          title="行前測試"
          warning={preflightResults.some((item) => item.status === "failed")}
        >
          <p className="muted">主畫面只顯示摘要。定位、音效、震動與防鎖屏的細節在這裡測。</p>
          <button className="primary-button" onClick={onRunPreflightAll} type="button">
            一鍵測試所有
          </button>
          {preflightSummary ? <p className="form-notice">{preflightSummary}</p> : null}
          {preflightResults.length > 0 ? <PreflightResultList items={preflightResults} /> : null}
          <div className="preflight-list">
            <p className="eyebrow">單項測試</p>
            <PreflightRow actionLabel="測試定位" detail={locationCheck.position ? `${formatPosition(locationCheck.position)}，${formatTime(locationCheck.position.updatedAt)}` : undefined} label="定位測試" onAction={onTestLocation} state={locationCheck} />
            <PreflightRow actionLabel="測試提示音" label="提示音測試" onAction={onTestAlertAudio} state={audioCheck} />
            <PreflightRow actionLabel="測試震動" label="震動測試" onAction={onTestVibration} state={vibrationCheck} />
            <PreflightRow actionLabel="測試防鎖屏" label="防鎖屏測試" onAction={onTestWakeLock} state={wakeLockCheck} />
            <PreflightRow actionLabel="測試通知權限" label="背景通知" onAction={onTestNotificationPermission} state={notificationPermissionCheck} />
            <PreflightRow actionLabel="測試雲端連線" label="雲端連線" onAction={onTestCloudConnection} state={cloudConnectionCheck} />
            <PreflightRow actionLabel="測試家人通知" label="家人通知" onAction={onTestFamilyNotificationPreflight} state={familyNotificationCheck} />
            <PreflightRow actionLabel="測試家人呼叫" label="家人呼叫" onAction={onTestFamilyWakePreflight} state={familyWakeCheck} />
          </div>
          {preflightOpen && preflightDestination ? (
            <div className="preflight-list">
              <p className="field-hint">準備前往 {preflightDestination.name}。定位測試成功後才能正式開始旅程。</p>
              <button className="primary-button" disabled={!preflightCanStart || Boolean(activeTrip)} onClick={onStartOfficialTrip} type="button">
                正式開始旅程
              </button>
              {locationCheck.status !== "成功" ? <p className="warning">定位測試成功後才能正式開始旅程。</p> : null}
            </div>
          ) : null}
        </SidebarPanel>

        <SidebarPanel
          isOpen={activeSection === "notifications"}
          onToggle={() => toggleSection("notifications")}
          title="通知設定"
          warning={notificationState.status !== "已啟用"}
        >
          <div className="status-grid">
            <Metric label="背景通知" value={notificationState.status} />
            <Metric label="前景提示聲" value={tripAlertSoundStatus} />
            <Metric label="本趟通知" value={ownerTripMuted ? "已停止" : "啟用中"} />
            <Metric label="防鎖屏" value={wakeLockStatus} />
          </div>
          <p className="notice">背景通知會透過系統通知提醒。畫面開著時，可額外播放提示聲。</p>
          <p className="muted">{getStandaloneHint()}</p>
          <div className="trip-actions">
            <button className="primary-button" disabled={notificationState.status === "被拒絕" || notificationState.status === "此瀏覽器不支援"} onClick={onEnableNotifications} type="button">
              啟用本人通知
            </button>
            <button className="secondary-button" onClick={() => showLocalTestNotification()} type="button">
              測試通知
            </button>
            <button className="secondary-button" onClick={onTestAlertAudio} type="button">
              測試提示音
            </button>
            <button className="secondary-button" disabled={!activeTrip || ownerTripMuted} onClick={onStopOwnerTripNotifications} type="button">
              停止本趟通知
            </button>
          </div>
          {activeTrip ? (
            <div className="cloud-share-card card nested-card">
              <p className="eyebrow">家人共享</p>
              {cloudShare.status === "active" ? (
                <div className="stack">
                  <Metric label="行程代碼" value={cloudShare.shareCode ?? "尚未取得"} />
                  <div className="trip-actions">
                    <button className="secondary-button" onClick={onCopyShareCode} type="button">
                      複製行程代碼
                    </button>
                    <button className="secondary-button" onClick={onCopyShareLink} type="button">
                      複製分享連結
                    </button>
                  </div>
                </div>
              ) : (
                <button className="primary-button" disabled={cloudShare.status === "creating"} onClick={onEnableCloudSharing} type="button">
                  {cloudShare.status === "creating" ? "建立中" : "開啟家人共享"}
                </button>
              )}
              {cloudShare.message ? <p className={cloudShare.status === "error" ? "warning" : "muted"}>{cloudShare.message}</p> : null}
            </div>
          ) : null}
        </SidebarPanel>

        <SidebarPanel isOpen={activeSection === "family"} onToggle={() => toggleSection("family")} title="家人設定">
          <p className="muted">我的代號</p>
          <p className="big-code">{user.code}</p>
          <button className="secondary-button" onClick={() => navigator.clipboard.writeText(user.code)} type="button">
            複製代號
          </button>
          <form className="stack" onSubmit={onConnectFamily}>
            <label>
              輸入家人代號
              <input value={connectionCode} onChange={(event) => setConnectionCode(event.target.value.toUpperCase())} placeholder="例如 MOM-2048" />
            </label>
            <div className="permission-grid">
              {FAMILY_PERMISSION_OPTIONS.map((option) => (
                <label className="toggle-row" key={option.key}>
                  <input
                    checked={connectionPermissions[option.key]}
                    onChange={(event) =>
                      setConnectionPermissions((current) => ({
                        ...current,
                        [option.key]: event.target.checked
                      }))
                    }
                    type="checkbox"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <button className="primary-button" type="submit">
              加入家人
            </button>
          </form>
          {familyConnectionMessage ? <p className="form-notice">{familyConnectionMessage}</p> : null}
          <div className="family-list">
            {familyConnections.length === 0 ? (
              <p className="muted">尚未連線家人。</p>
            ) : (
              familyConnections.map((connection) => {
                const otherCode = connection.user_a_code === user.code ? connection.user_b_code : connection.user_a_code;
                const myPermissions = connection.user_a_code === user.code ? connection.user_a_permissions : connection.user_b_permissions;
                return (
                  <div className="family-row" key={connection.id}>
                    <div>
                      <strong>{otherCode}</strong>
                      <span>{getConnectionStatusLabel(connection)}</span>
                      <p className="field-hint">{formatPermissionSummary(myPermissions)}</p>
                    </div>
                    <button
                      className="icon-danger-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteFamily(otherCode);
                      }}
                      type="button"
                      aria-label={`刪除 ${otherCode}`}
                    >
                      移除
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </SidebarPanel>

        <SidebarPanel isOpen={activeSection === "testMode"} onToggle={() => toggleSection("testMode")} title="測試模式">
          <p className="warning">測試模式只用於開發驗證。</p>
          {!activeTrip ? <p className="warning">請先開始一趟測試行程。</p> : null}
          <div className="test-mode-group">
            <p className="eyebrow">距離模擬</p>
            <div className="test-button-grid">
              <button className="secondary-button" disabled={!activeTrip} onClick={() => onSimulateDistance(2000)} type="button">2000m</button>
              <button className="secondary-button" disabled={!activeTrip} onClick={() => onSimulateDistance(500)} type="button">500m</button>
              <button className="secondary-button" disabled={!activeTrip} onClick={() => onSimulateDistance(90)} type="button">90m</button>
            </div>
          </div>
          <div className="test-mode-group">
            <p className="eyebrow">狀態模擬</p>
            <div className="test-button-grid">
              <button className="secondary-button" disabled={!activeTrip} onClick={() => onSimulateStale(2)} type="button">位置更新暫停</button>
              <button className="secondary-button" disabled={!activeTrip} onClick={() => onSimulateStale(6)} type="button">定位可能中斷</button>
              <button className="secondary-button" disabled={!activeTrip} onClick={onSimulateExpired} type="button">行程逾時</button>
              <button className="secondary-button" disabled={!activeTrip} onClick={onSimulateArrived} type="button">已抵達</button>
            </div>
          </div>
          <div className="test-mode-group">
            <p className="eyebrow">通知測試</p>
            <div className="test-button-grid">
              <button className="secondary-button" onClick={onTestOwnerNotification} type="button">本人通知</button>
              <button className="secondary-button" onClick={onTestFamilyNotification} type="button">家人通知</button>
              <button className="secondary-button" onClick={onTestFamilyWake} type="button">家人呼叫</button>
            </div>
          </div>
          <div className="test-mode-group">
            <p className="eyebrow">清理</p>
            <div className="test-button-grid">
              <button className="danger-button" disabled={!activeTrip} onClick={onSimulateEndTrip} type="button">模擬結束行程</button>
              <button className="secondary-button" onClick={onClearTripMuteForTest} type="button">清除本趟通知停止狀態</button>
            </div>
          </div>
          {testModeMessage ? <p className="form-notice">{testModeMessage}</p> : null}
        </SidebarPanel>

        <SidebarPanel
          isOpen={activeSection === "notificationCenter"}
          onToggle={() => toggleSection("notificationCenter")}
          title={`通知中心：${notificationCenterItems.filter((item) => !item.read).length} 則`}
          warning={notificationCenterItems.some((item) => !item.success)}
        >
          <div className="trip-actions">
            <button className="secondary-button" onClick={onLoadNotificationCenter} type="button">
              重新載入
            </button>
            <button className="secondary-button" onClick={onMarkNotificationCenterRead} type="button">
              全部標記已讀
            </button>
            <button className="danger-button" onClick={onClearLocalNotificationCenter} type="button">
              清除本機紀錄
            </button>
          </div>
          {notificationCenterMessage ? <p className="field-hint">{notificationCenterMessage}</p> : null}
          <div className="notification-center-list">
            {notificationCenterItems.length === 0 ? (
              <p className="muted">尚無通知紀錄。</p>
            ) : (
              notificationCenterItems.map((item) => (
                <div className={`notification-center-item ${item.read ? "" : "unread"}`} key={item.id}>
                  <div>
                    <strong>{item.type}</strong>
                    <span>{formatTime(item.time)}</span>
                  </div>
                  <p className={item.success ? "good" : "warning"}>{item.success ? "成功" : "失敗"}</p>
                  {item.error ? (
                    <details className="notification-detail">
                      <summary>查看失敗原因</summary>
                      <p className="field-hint">{item.error}</p>
                    </details>
                  ) : null}
                  <p className="field-hint">
                    {item.shareCode ? `share_code：${item.shareCode}` : null}
                    {item.shareCode && item.recipientCode ? " / " : null}
                    {item.recipientCode ? `recipient：${item.recipientCode}` : null}
                  </p>
                </div>
              ))
            )}
          </div>
        </SidebarPanel>

        <SidebarPanel
          isOpen={activeSection === "diagnostics"}
          onToggle={() => toggleSection("diagnostics")}
          title="進階診斷"
          warning={diagnosticsWarningCount > 0}
        >
          <DiagnosticList items={notificationDiagnostics} />
          <div className="status-grid">
            <Metric label="Wake Lock" value={wakeLockStatus} />
            <Metric label="震動" value={vibrationCheck.status} />
            <Metric label="定位測試" value={locationCheck.status} />
            <Metric label="提示音" value={audioCheck.status} />
          </div>
          <p className="notice">畫面開著時會持續更新位置。鎖屏或切到背景後，iPhone 可能暫停網頁定位。</p>
          <div className="event-list">
            {events.slice(0, 5).map((event) => (
              <div className="event-list-item" key={event.id}>
                <span>{formatTime(event.createdAt)}</span>
                <strong>{event.type}</strong>
                <p>{event.message}</p>
              </div>
            ))}
          </div>
          <button className="danger-button" onClick={onResetLocalData} type="button">
            重設本機資料
          </button>
        </SidebarPanel>
      </aside>
    </>
  );
}

function SidebarPanel({
  children,
  isOpen,
  onToggle,
  title,
  warning
}: {
  children: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  title: string;
  warning?: boolean;
}) {
  return (
    <section className="sidebar-panel">
      <button className="sidebar-panel-toggle" onClick={onToggle} type="button">
        <span>{title}</span>
        {warning ? <span className="status-dot" aria-hidden="true" /> : null}
      </button>
      {isOpen ? <div className="sidebar-panel-body">{children}</div> : null}
    </section>
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

function DiagnosticList({ items }: { items: NotificationDiagnostic[] }) {
  if (items.length === 0) {
    return <p className="field-hint">尚未取得通知診斷。</p>;
  }

  return (
    <div className="diagnostic-list">
      {items.map((item) => (
        <div className="diagnostic-row" key={item.label}>
          <span>{item.label}</span>
          <strong className={item.ok ? "good" : "warning"}>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function PreflightResultList({ items }: { items: PreflightCheckResult[] }) {
  return (
    <div className="diagnostic-list">
      {items.map((item) => (
        <div className="diagnostic-row" key={item.key}>
          <div>
            <span>{item.label}</span>
            <strong className={item.status === "success" ? "good" : item.status === "warning" ? "warning" : "warning"}>{item.message}</strong>
            {item.suggestion ? <p className="field-hint">{item.suggestion}</p> : null}
          </div>
          <strong>{item.status === "success" ? "成功" : item.status === "warning" ? "警告" : "失敗"}</strong>
        </div>
      ))}
    </div>
  );
}

function FamilyTripsPanel({
  connections = [],
  currentUserCode,
  onOpenFamilySettings,
  onRefresh,
  onViewOwner,
  trips
}: {
  connections?: FamilyConnectionRow[];
  currentUserCode?: string;
  onOpenFamilySettings?: () => void;
  onRefresh: () => void;
  onViewOwner?: (ownerCode: string) => void;
  trips: FamilyTripRow[];
}) {
  const connectedFamilies = currentUserCode
    ? connections
        .filter((connection) => connection.status === "confirmed")
        .map((connection) => {
          const ownerCode = connection.user_a_code === currentUserCode ? connection.user_b_code : connection.user_a_code;
          return {
            ownerCode,
            connection,
            trip: trips.find((trip) => trip.owner_code === ownerCode)
          };
        })
    : [];

  return (
    <div className="stack">
      <div className="section-heading">
        <div>
          <h2>已連線家人</h2>
          <p className="muted">選擇已連線家人即可查看目前行程；通常不需要行程代碼。</p>
        </div>
        <button className="secondary-button small-button" onClick={onRefresh} type="button">
          重新整理
        </button>
      </div>
      {connectedFamilies.length === 0 && trips.length === 0 ? (
        <div className="empty-state">
          <strong>尚未連線家人</strong>
          <p className="muted">到設定的家人設定輸入對方代號，雙方確認後即可查看目前行程。</p>
          {onOpenFamilySettings ? (
            <button className="secondary-button" onClick={onOpenFamilySettings} type="button">
              前往家人設定
            </button>
          ) : null}
        </div>
      ) : (
        <div className="family-list">
          {(connectedFamilies.length > 0
            ? connectedFamilies
            : trips.map((trip) => ({ ownerCode: trip.owner_code, connection: null, trip }))
          ).map((item) => {
            const permissions = item.trip?.permissions;
            const activeFamilyTrip = item.trip && isTripActive(item.trip) ? item.trip : null;
            const canWake = permissions?.can_wake_me !== false && canWakeOwner(activeFamilyTrip);
            return (
              <div className="family-row" key={item.ownerCode}>
                <div>
                  <strong>{item.ownerCode}</strong>
                  <span>{item.connection ? getConnectionStatusLabel(item.connection) : "分享行程"}</span>
                  <p className="field-hint">
                    {activeFamilyTrip
                      ? `${getTripDisplayStatus(activeFamilyTrip)}，最近更新：${formatTime(activeFamilyTrip.last_location_at ?? undefined)}`
                      : "這位家人目前沒有進行中的行程。"}
                  </p>
                </div>
                <div className="family-row-actions">
                  <button className="primary-button" onClick={() => (onViewOwner ? onViewOwner(item.ownerCode) : item.trip && (window.location.href = `/share/${item.trip.share_code}`))} type="button">
                    查看目前行程
                  </button>
                  {canWake && activeFamilyTrip ? (
                    <button className="secondary-button" onClick={() => (window.location.href = `/share/${activeFamilyTrip.share_code}`)} type="button">
                      呼叫
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
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
        <p className={getPreflightStateClass(state.status)}>{state.status}</p>
        {state.lastTestedAt ? <p>最後測試：{formatTime(state.lastTestedAt)}</p> : null}
        {detail ? <p>{detail}</p> : null}
      </div>
      <button className="secondary-button" disabled={state.status === "測試中"} onClick={onAction} type="button">
        {state.status === "測試中" ? "測試中" : actionLabel}
      </button>
    </div>
  );
}

function getHttpsPwaCheck(): PreflightCheckResult {
  const secure = window.location.protocol === "https:" || window.location.hostname === "localhost";
  const standalone = window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && Boolean(navigator.standalone));
  if (!secure) {
    return {
      key: "https",
      label: "HTTPS / PWA 狀態",
      status: "failed",
      message: "目前不是 HTTPS。",
      suggestion: "請部署到 Vercel HTTPS 測試，iPhone Safari 可能不允許定位與通知。"
    };
  }
  return {
    key: "https",
    label: "HTTPS / PWA 狀態",
    status: standalone ? "success" : "warning",
    message: standalone ? "已從 PWA / 主畫面開啟。" : "目前不是 standalone PWA。",
    suggestion: standalone ? "" : "iPhone Web Push 通常需要加入主畫面並從主畫面開啟。"
  };
}

async function getLocationPreflightCheck(): Promise<PreflightCheckResult> {
  if (!("geolocation" in navigator)) {
    return {
      key: "location",
      label: "定位權限與 GPS",
      status: "failed",
      message: "此瀏覽器不支援定位。",
      suggestion: "請改用支援定位的瀏覽器或確認 HTTPS。"
    };
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () =>
        resolve({
          key: "location",
          label: "定位權限與 GPS",
          status: "success",
          message: "定位可用。",
          suggestion: ""
        }),
      (error) =>
        resolve({
          key: "location",
          label: "定位權限與 GPS",
          status: "failed",
          message: getGeolocationFailureMessage(error),
          suggestion: "請到 Safari 網站設定允許定位，或到戶外再試。"
        }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  });
}

async function getCloudPreflightCheck(): Promise<PreflightCheckResult> {
  if (!supabase) {
    return {
      key: "cloud",
      label: "雲端連線",
      status: "failed",
      message: "Supabase 環境變數未設定。",
      suggestion: "仍可本機測試，但家人共享與通知需要雲端連線。"
    };
  }
  const { error } = await supabase.from("trips").select("id").limit(1);
  if (error) {
    return {
      key: "cloud",
      label: "雲端連線",
      status: "failed",
      message: error.message,
      suggestion: "請確認 Supabase URL、anon key 與 RLS policy。"
    };
  }
  return {
    key: "cloud",
    label: "雲端連線",
    status: "success",
    message: "雲端連線正常。",
    suggestion: ""
  };
}

async function getSoundPreflightCheck(): Promise<PreflightCheckResult> {
  const unlocked = await unlockAlertSound();
  if (!unlocked.ok) {
    return {
      key: "sound",
      label: "提示音解鎖",
      status: "failed",
      message: unlocked.error ?? "提示音解鎖失敗。",
      suggestion: "請點測試提示音，並確認 iPhone 不是靜音模式。"
    };
  }
  await playAlertSoundFor(1000);
  return {
    key: "sound",
    label: "提示音解鎖",
    status: "success",
    message: "提示音已解鎖並播放 1 秒測試音。",
    suggestion: ""
  };
}

function getWebPushPreflightCheck(): PreflightCheckResult {
  const supported = "Notification" in window && "PushManager" in window;
  if (!supported) {
    return {
      key: "webPush",
      label: "Web Push 支援與通知權限",
      status: "failed",
      message: "此瀏覽器不支援 Web Push。",
      suggestion: "iPhone 請加入主畫面並從主畫面開啟。"
    };
  }
  return {
    key: "webPush",
    label: "Web Push 支援與通知權限",
    status: Notification.permission === "granted" ? "success" : "failed",
    message: `通知權限：${Notification.permission}`,
    suggestion: Notification.permission === "granted" ? "" : "請按啟用通知，背景通知可能才會送達。"
  };
}

async function getServiceWorkerPreflightCheck(): Promise<PreflightCheckResult> {
  if (!("serviceWorker" in navigator)) {
    return {
      key: "serviceWorker",
      label: "Service Worker 註冊",
      status: "failed",
      message: "此瀏覽器不支援 Service Worker。",
      suggestion: "請使用支援 PWA 的瀏覽器。"
    };
  }
  const registration = await navigator.serviceWorker.register("/sw.js").catch(() => null);
  return {
    key: "serviceWorker",
    label: "Service Worker 註冊",
    status: registration ? "success" : "failed",
    message: registration ? "Service Worker 已註冊。" : "Service Worker 註冊失敗。",
    suggestion: registration ? "" : "請確認網站是 HTTPS 並重新載入。"
  };
}

async function getPushSubscriptionPreflightCheck(): Promise<PreflightCheckResult> {
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  return {
    key: "pushSubscription",
    label: "PushSubscription 是否取得",
    status: subscription ? "success" : "warning",
    message: subscription ? "已取得 PushSubscription。" : "尚未取得 PushSubscription。",
    suggestion: subscription ? "" : "請先啟用通知。"
  };
}

function getWakeLockPreflightCheck(): PreflightCheckResult {
  return {
    key: "wakeLock",
    label: "防鎖屏 Wake Lock 支援",
    status: "wakeLock" in navigator ? "success" : "warning",
    message: "wakeLock" in navigator ? "支援防鎖屏。" : "此瀏覽器不支援防鎖屏。",
    suggestion: "wakeLock" in navigator ? "" : "請保持畫面開啟。"
  };
}

function getVibrationPreflightCheck(): PreflightCheckResult {
  return {
    key: "vibration",
    label: "震動支援",
    status: "vibrate" in navigator ? "success" : "warning",
    message: "vibrate" in navigator ? "支援震動。" : "此瀏覽器不支援網頁震動。",
    suggestion: "vibrate" in navigator ? "" : "iPhone Safari 常見此限制。"
  };
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

function createFamilyViewerCode() {
  return `FAMILY-${Math.floor(1000 + Math.random() * 9000)}`;
}

function getFamilyPermissionLabel(permission: string) {
  return PERMISSIONS.find((item) => item.value === permission)?.label ?? permission;
}

function getConnectionStatusLabel(connection: FamilyConnectionRow) {
  if (connection.status === "confirmed") {
    return "已連線";
  }
  if (connection.status === "blocked") {
    return "已封鎖 / 已停用";
  }
  return "等待對方確認";
}

function formatPermissionSummary(permissions: Partial<FamilyPermissions> | undefined) {
  if (!permissions) {
    return "尚未設定權限";
  }
  const enabled = FAMILY_PERMISSION_OPTIONS.filter((option) => permissions[option.key]).map((option) => option.label);
  return enabled.length > 0 ? enabled.join("、") : "未授權功能";
}

function isNotificationCenterEvent(type: EventType) {
  return [
    "開始行程",
    "快到目的地",
    "已抵達",
    "定位延遲",
    "定位中斷",
    "停止行程",
    "模擬叫醒",
    "通知訂閱成功",
    "通知訂閱失敗",
    "收到家人呼叫",
    "已回應家人呼叫",
    "雲端行程同步成功",
    "雲端行程同步失敗"
  ].includes(type);
}

function getPreflightSummaryLabel(items: PreflightCheckResult[]) {
  if (items.length === 0) {
    return "尚未測試";
  }
  const failed = items.filter((item) => item.status === "failed").length;
  const warnings = items.filter((item) => item.status === "warning").length;
  if (failed > 0) {
    return `有 ${failed} 個失敗`;
  }
  if (warnings > 0) {
    return `有 ${warnings} 個警告`;
  }
  return "通過";
}

function getPreflightStateClass(status: PreflightStatus) {
  if (status === "成功") {
    return "good";
  }
  if (status === "警告" || status === "不支援") {
    return "warning";
  }
  if (status === "失敗") {
    return "warning";
  }
  return "field-hint";
}

function getPublicLocationStatus(updatedAt?: string, ended = false) {
  if (ended) {
    return "定位：行程已結束";
  }
  if (!updatedAt) {
    return "定位：尚未取得";
  }
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  if (Number.isNaN(ageMs)) {
    return "定位：尚未取得";
  }
  if (ageMs > 30 * 60 * 1000) {
    return "位置更新：行程可能已失效";
  }
  if (ageMs > 5 * 60 * 1000) {
    return "位置更新：定位可能中斷";
  }
  if (ageMs > 60 * 1000) {
    return "位置更新：暫停";
  }
  return "定位：正常";
}

function showLocalTestNotification() {
  if (!("Notification" in window)) {
    return;
  }
  if (Notification.permission !== "granted") {
    return;
  }
  new Notification("GeoClock 測試通知", {
    body: "背景通知測試。實際到站通知仍受 iPhone PWA 與系統設定限制。"
  });
}

function formatTripDuration(minutes: number) {
  if (minutes % 60 === 0) {
    return `${minutes / 60} 小時`;
  }
  return `${minutes} 分鐘`;
}

function getSafeArrivalRadius(arrivalRadius: number, alertRadius: number) {
  return Math.min(arrivalRadius, alertRadius);
}

function isTripAlertCondition(trip: ActiveTrip) {
  if (trip.status === "定位中斷" || trip.status === "定位延遲") {
    return false;
  }
  if (typeof trip.distanceMeters !== "number") {
    return false;
  }
  return trip.distanceMeters <= trip.radiusMeters || trip.distanceMeters <= trip.arrivalRadiusMeters;
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
