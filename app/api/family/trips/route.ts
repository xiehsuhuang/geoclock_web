import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

type FamilyPermissions = {
  can_view_status?: boolean;
  can_view_approx_location?: boolean;
  can_view_precise_location?: boolean;
  can_receive_notifications?: boolean;
  can_wake_me?: boolean;
  can_view_destination?: boolean;
};

type FamilyConnectionRow = {
  user_a_code: string;
  user_b_code: string;
  user_a_permissions: FamilyPermissions | null;
  user_b_permissions: FamilyPermissions | null;
  user_a_confirmed?: boolean;
  user_b_confirmed?: boolean;
  status: string;
};

type TripRow = {
  id: string;
  share_code: string;
  owner_code: string;
  started_at: string;
  ended_at: string | null;
  expires_at?: string | null;
  [key: string]: unknown;
};

const ACTIVE_TRIP_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。", trips: [], families: [] }, { status: 503 });
  }

  const url = new URL(request.url);
  const viewerCode = (url.searchParams.get("viewer_code") ?? url.searchParams.get("code"))?.trim().toUpperCase();
  const ownerCode = url.searchParams.get("owner_code")?.trim().toUpperCase();
  const shareCode = url.searchParams.get("share_code")?.trim();

  if (!viewerCode) {
    return NextResponse.json({ ok: false, error: "缺少 viewer_code。", trips: [], families: [] }, { status: 400 });
  }

  const { data: connections, error: connectionError } = await supabase
    .from("family_connections")
    .select("user_a_code,user_b_code,user_a_permissions,user_b_permissions,user_a_confirmed,user_b_confirmed,status")
    .or(`user_a_code.eq.${viewerCode},user_b_code.eq.${viewerCode}`)
    .eq("status", "confirmed")
    .eq("user_a_confirmed", true)
    .eq("user_b_confirmed", true);

  if (connectionError) {
    return NextResponse.json({ ok: false, error: connectionError.message, trips: [], families: [] }, { status: 500 });
  }

  const rows = (connections ?? []) as FamilyConnectionRow[];

  if (ownerCode) {
    return getSingleFamilyTrip({
      ownerCode,
      rows,
      shareCode,
      viewerCode
    });
  }

  const familyCodes = rows.map((row) => getOtherCode(row, viewerCode));
  if (familyCodes.length === 0) {
    return NextResponse.json({ ok: true, trips: [], families: [] });
  }

  const since = new Date(Date.now() - ACTIVE_TRIP_WINDOW_MS).toISOString();
  const nowIso = new Date().toISOString();
  const { data: trips, error: tripsError } = await supabase
    .from("trips")
    .select("*")
    .in("owner_code", familyCodes)
    .is("ended_at", null)
    .gte("started_at", since)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("started_at", { ascending: false });

  if (tripsError) {
    return NextResponse.json({ ok: false, error: tripsError.message, trips: [], families: [] }, { status: 500 });
  }

  const tripRows = (trips ?? []) as TripRow[];
  const visibleShareCodes = await getVisibleShareCodesForViewer(
    viewerCode,
    tripRows.map((trip) => trip.share_code)
  );
  const latestTripByOwner = new Map<string, TripRow>();
  for (const trip of tripRows) {
    if (!visibleShareCodes.has(trip.share_code)) {
      continue;
    }
    if (!latestTripByOwner.has(trip.owner_code)) {
      latestTripByOwner.set(trip.owner_code, trip);
    }
  }

  const { data: endedTrips, error: endedTripsError } = await supabase
    .from("trips")
    .select("*")
    .in("owner_code", familyCodes)
    .not("ended_at", "is", null)
    .order("ended_at", { ascending: false })
    .limit(Math.max(familyCodes.length * 3, 1));

  if (endedTripsError) {
    return NextResponse.json({ ok: false, error: endedTripsError.message, trips: [], families: [] }, { status: 500 });
  }

  const latestEndedTripByOwner = new Map<string, TripRow>();
  for (const trip of (endedTrips ?? []) as TripRow[]) {
    if (!latestEndedTripByOwner.has(trip.owner_code)) {
      latestEndedTripByOwner.set(trip.owner_code, trip);
    }
  }

  const families = rows.map((connection) => {
    const familyCode = getOtherCode(connection, viewerCode);
    const permissions = getOwnerGrantedPermissions(connection, familyCode);
    const trip = latestTripByOwner.get(familyCode);
    const latestEndedTrip = latestEndedTripByOwner.get(familyCode);
    return {
      owner_code: familyCode,
      connection_status: connection.status,
      permissions,
      trip: trip ? decorateTrip(trip, permissions) : null,
      latestEndedTrip: latestEndedTrip ? decorateTrip(latestEndedTrip, permissions) : null
    };
  });

  return NextResponse.json({
    ok: true,
    trips: families.map((family) => family.trip).filter(Boolean),
    families
  });
}

async function getSingleFamilyTrip({
  ownerCode,
  rows,
  shareCode,
  viewerCode
}: {
  ownerCode: string;
  rows: FamilyConnectionRow[];
  shareCode?: string;
  viewerCode: string;
}) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。", trips: [], families: [] }, { status: 503 });
  }

  const connection = rows.find((row) => getOtherCode(row, viewerCode) === ownerCode);
  const permissions = connection ? getOwnerGrantedPermissions(connection, ownerCode) : {};
  const connectedCanView = Boolean(connection && permissions.can_view_status !== false);

  const since = new Date(Date.now() - ACTIVE_TRIP_WINDOW_MS).toISOString();
  const nowIso = new Date().toISOString();
  let query = supabase.from("trips").select("*").eq("owner_code", ownerCode);

  if (shareCode) {
    query = query.eq("share_code", shareCode);
  } else {
    query = query.is("ended_at", null).gte("started_at", since).or(`expires_at.is.null,expires_at.gt.${nowIso}`);
  }

  const { data, error } = await query.order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message, trips: [], families: [] }, { status: 500 });
  }

  if (!data) {
    const latestEndedTrip = await getLatestEndedTrip(ownerCode, permissions);
    return NextResponse.json({
      ok: true,
      message: "這位家人目前沒有進行中的行程。",
      trips: [],
      families: [
        {
          owner_code: ownerCode,
          connection_status: connection?.status ?? "not_connected",
          permissions,
          trip: null,
          latestEndedTrip
        }
      ]
    });
  }

  const recipientPermission = await getTripRecipientPermission((data as TripRow).share_code, viewerCode);
  const recipientCanView = Boolean(recipientPermission?.can_view);
  if (!recipientCanView && !(shareCode && connectedCanView)) {
    return NextResponse.json(
      {
        ok: false,
        error: shareCode
          ? "你沒有這趟行程的查看權限，請確認已完成家人連線或請對方重新分享。"
          : "你尚未被加入這趟行程的可查看家人，請對方在出發前勾選你。",
        trips: [],
        families: []
      },
      { status: 403 }
    );
  }

  const viewPermissions = recipientCanView && !connection ? getRecipientDefaultPermissions() : permissions;
  const trip = decorateTrip(data as TripRow, viewPermissions);
  return NextResponse.json({
    ok: true,
    trips: [trip],
    trip,
    families: [
      {
          owner_code: ownerCode,
          connection_status: connection?.status ?? "share_code",
          permissions: viewPermissions,
          trip
        }
      ]
  });
}

async function getLatestEndedTrip(ownerCode: string, permissions: FamilyPermissions) {
  if (!supabase) {
    return null;
  }

  const { data } = await supabase
    .from("trips")
    .select("*")
    .eq("owner_code", ownerCode)
    .not("ended_at", "is", null)
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ? decorateTrip(data as TripRow, permissions) : null;
}

function getOtherCode(connection: FamilyConnectionRow, viewerCode: string) {
  return connection.user_a_code === viewerCode ? connection.user_b_code : connection.user_a_code;
}

function getOwnerGrantedPermissions(connection: FamilyConnectionRow, ownerCode: string): FamilyPermissions {
  return ownerCode === connection.user_a_code ? connection.user_a_permissions ?? {} : connection.user_b_permissions ?? {};
}

async function getTripRecipientPermission(shareCode: string, viewerCode: string) {
  if (!supabase) {
    return null;
  }

  const { data } = await supabase
    .from("trip_recipients")
    .select("can_view,can_receive_notifications")
    .eq("share_code", shareCode)
    .eq("recipient_code", viewerCode)
    .eq("can_view", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data as { can_view: boolean; can_receive_notifications: boolean } | null;
}

async function getVisibleShareCodesForViewer(viewerCode: string, shareCodes: string[]) {
  if (!supabase || shareCodes.length === 0) {
    return new Set<string>();
  }
  const { data } = await supabase
    .from("trip_recipients")
    .select("share_code")
    .eq("recipient_code", viewerCode)
    .eq("can_view", true)
    .in("share_code", shareCodes);
  return new Set(((data ?? []) as { share_code: string }[]).map((row) => row.share_code));
}

function getRecipientDefaultPermissions(): FamilyPermissions {
  return {
    can_view_status: true,
    can_view_approx_location: true,
    can_view_precise_location: false,
    can_receive_notifications: true,
    can_wake_me: false,
    can_view_destination: true
  };
}

function decorateTrip(trip: TripRow, permissions: FamilyPermissions) {
  return {
    ...trip,
    permissions,
    destination_name: permissions.can_view_destination === false ? "已隱藏" : trip.destination_name,
    destination_address: permissions.can_view_destination === false ? "" : trip.destination_address,
    current_lat: permissions.can_view_precise_location ? trip.current_lat : null,
    current_lng: permissions.can_view_precise_location ? trip.current_lng : null,
    approximate_lat: permissions.can_view_approx_location === false && !permissions.can_view_precise_location ? null : trip.approximate_lat,
    approximate_lng: permissions.can_view_approx_location === false && !permissions.can_view_precise_location ? null : trip.approximate_lng
  };
}
