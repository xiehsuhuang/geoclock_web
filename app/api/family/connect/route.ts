import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { getFamilyPair, normalizePermissions, type FamilyPermissions } from "../utils";

type ConnectPayload = {
  my_code?: string;
  family_code?: string;
  permissions?: Partial<FamilyPermissions>;
};

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。" }, { status: 503 });
  }

  const payload = (await request.json()) as ConnectPayload;
  const myCode = payload.my_code?.trim().toUpperCase();
  const familyCode = payload.family_code?.trim().toUpperCase();
  if (!myCode || !familyCode || myCode === familyCode) {
    return NextResponse.json({ ok: false, error: "請輸入有效的家人代號。" }, { status: 400 });
  }

  const pair = getFamilyPair(myCode, familyCode);
  const permissions = normalizePermissions(payload.permissions);
  const isUserA = myCode === pair.userA;

  const { data: existing, error: findError } = await supabase
    .from("family_connections")
    .select("*")
    .eq("pair_key", pair.pairKey)
    .maybeSingle();
  if (findError) {
    return NextResponse.json({ ok: false, error: findError.message }, { status: 500 });
  }

  const nextAConfirmed = isUserA ? true : Boolean(existing?.user_a_confirmed);
  const nextBConfirmed = isUserA ? Boolean(existing?.user_b_confirmed) : true;
  const confirmed = nextAConfirmed && nextBConfirmed;
  const values = {
    pair_key: pair.pairKey,
    user_a_code: pair.userA,
    user_b_code: pair.userB,
    user_a_permissions: isUserA ? permissions : existing?.user_a_permissions ?? {},
    user_b_permissions: isUserA ? existing?.user_b_permissions ?? {} : permissions,
    user_a_confirmed: nextAConfirmed,
    user_b_confirmed: nextBConfirmed,
    status: confirmed ? "confirmed" : "pending",
    updated_at: new Date().toISOString(),
    confirmed_at: confirmed ? new Date().toISOString() : existing?.confirmed_at ?? null
  };

  const { data, error } = existing?.id
    ? await supabase.from("family_connections").update(values).eq("id", existing.id).select("*").single()
    : await supabase.from("family_connections").insert(values).select("*").single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, connection: data });
}
