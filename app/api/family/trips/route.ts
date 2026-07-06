import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

type FamilyConnectionRow = {
  user_a_code: string;
  user_b_code: string;
  user_a_permissions: Record<string, boolean>;
  user_b_permissions: Record<string, boolean>;
  status: string;
};

export async function GET(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。", trips: [] }, { status: 503 });
  }

  const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();
  if (!code) {
    return NextResponse.json({ ok: false, error: "缺少 code。", trips: [] }, { status: 400 });
  }

  const { data: connections, error: connectionError } = await supabase
    .from("family_connections")
    .select("user_a_code,user_b_code,user_a_permissions,user_b_permissions,status")
    .or(`user_a_code.eq.${code},user_b_code.eq.${code}`)
    .eq("status", "confirmed");

  if (connectionError) {
    return NextResponse.json({ ok: false, error: connectionError.message, trips: [] }, { status: 500 });
  }

  const rows = (connections ?? []) as FamilyConnectionRow[];
  const familyCodes = rows.map((row) => (row.user_a_code === code ? row.user_b_code : row.user_a_code));
  if (familyCodes.length === 0) {
    return NextResponse.json({ ok: true, trips: [] });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: trips, error: tripsError } = await supabase
    .from("trips")
    .select("*")
    .in("owner_code", familyCodes)
    .is("ended_at", null)
    .gte("started_at", since)
    .order("started_at", { ascending: false });

  if (tripsError) {
    return NextResponse.json({ ok: false, error: tripsError.message, trips: [] }, { status: 500 });
  }

  const decoratedTrips = (trips ?? []).map((trip) => {
    const connection = rows.find((row) => row.user_a_code === trip.owner_code || row.user_b_code === trip.owner_code);
    const permissions = connection
      ? connection.user_a_code === trip.owner_code
        ? connection.user_a_permissions
        : connection.user_b_permissions
      : {};
    return {
      ...trip,
      permissions
    };
  });

  return NextResponse.json({ ok: true, trips: decoratedTrips });
}
