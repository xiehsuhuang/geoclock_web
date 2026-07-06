import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { getFamilyPair, normalizePermissions, type FamilyPermissions } from "../utils";

type Payload = {
  my_code?: string;
  family_code?: string;
  permissions?: Partial<FamilyPermissions>;
};

export async function POST(request: Request) {
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 環境變數未設定。" }, { status: 503 });
  }

  const payload = (await request.json()) as Payload;
  const myCode = payload.my_code?.trim().toUpperCase();
  const familyCode = payload.family_code?.trim().toUpperCase();
  if (!myCode || !familyCode) {
    return NextResponse.json({ ok: false, error: "缺少代號。" }, { status: 400 });
  }

  const pair = getFamilyPair(myCode, familyCode);
  const field = myCode === pair.userA ? "user_a_permissions" : "user_b_permissions";
  const { error } = await supabase
    .from("family_connections")
    .update({ [field]: normalizePermissions(payload.permissions), updated_at: new Date().toISOString() })
    .eq("pair_key", pair.pairKey);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
