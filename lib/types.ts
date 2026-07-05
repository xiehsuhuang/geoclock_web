export type TripStatus =
  | "尚未開始"
  | "行程中"
  | "接近目的地"
  | "快到目的地"
  | "已抵達"
  | "定位延遲"
  | "定位中斷";

export type LocationHealth = "正常" | "延遲" | "中斷";

export type FamilyPermission = "只看狀態" | "可看位置" | "可叫醒我";

export type PlaceSearchCandidate = {
  id: string;
  label: string;
  address: string;
  lat: number;
  lng: number;
  source: "geoapify";
};

export type EventType =
  | "建立使用者"
  | "新增目的地"
  | "開始行程"
  | "定位更新"
  | "接近目的地"
  | "快到目的地"
  | "已抵達"
  | "定位延遲"
  | "定位中斷"
  | "停止行程"
  | "模擬叫醒"
  | "刪除目的地"
  | "新增家人權限"
  | "刪除家人權限"
  | "更新目的地定位資料"
  | "Google Maps 連結解析成功"
  | "Google Maps 連結解析失敗"
  | "手動輸入定位資料成功"
  | "手動輸入定位資料失敗"
  | "嘗試開始沒有定位資料的行程"
  | "進入啟動前檢查"
  | "定位測試成功"
  | "定位測試失敗"
  | "提示音測試成功"
  | "提示音測試失敗"
  | "震動不支援"
  | "防鎖屏啟用成功"
  | "防鎖屏啟用失敗"
  | "正式開始旅程"
  | "開啟家人共享"
  | "雲端行程同步成功"
  | "雲端行程同步失敗"
  | "停止家人共享"
  | "通知訂閱成功"
  | "通知訂閱失敗"
  | "收到家人呼叫"
  | "已回應家人呼叫";

export type WakeRequestRow = {
  id: string;
  trip_id: string | null;
  share_code: string;
  from_viewer_code: string | null;
  to_owner_code: string;
  status: "active" | "acknowledged" | "stopped" | string;
  message: string | null;
  created_at: string;
  acknowledged_at: string | null;
  stopped_at: string | null;
};

export type UserProfile = {
  nickname: string;
  code: string;
  createdAt: string;
};

export type Destination = {
  id: string;
  name: string;
  address: string;
  mapsUrl?: string;
  lat?: number;
  lng?: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
};

export type FamilyMember = {
  id: string;
  code: string;
  permission: FamilyPermission;
  createdAt: string;
};

export type EventRecord = {
  id: string;
  type: EventType;
  message: string;
  createdAt: string;
};

export type CurrentPosition = {
  lat: number;
  lng: number;
  accuracy?: number;
  updatedAt: string;
};

export type ActiveTrip = {
  destination: Destination;
  radiusMeters: number;
  arrivalRadiusMeters: number;
  startedAt: string;
  status: TripStatus;
  health: LocationHealth;
  lastPosition?: CurrentPosition;
  distanceMeters?: number;
};

export type PrivacySettings = {
  familyApproximateLocation: boolean;
};

export type TripSettings = {
  alertRadiusMeters: number;
  arrivalRadiusMeters: number;
};

export type CloudTripRow = {
  id: string;
  share_code: string;
  owner_code: string;
  destination_name: string;
  destination_address: string | null;
  destination_lat: number;
  destination_lng: number;
  alert_radius_m: number;
  arrival_radius_m?: number | null;
  status: string;
  distance_m: number | null;
  current_lat: number | null;
  current_lng: number | null;
  approximate_lat: number | null;
  approximate_lng: number | null;
  last_location_at: string | null;
  started_at: string;
  ended_at: string | null;
};
