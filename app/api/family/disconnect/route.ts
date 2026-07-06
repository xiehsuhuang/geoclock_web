import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { getFamilyPair } from "../utils";

type Payload = {
  my_code?: string;
  family_code?: string;
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

  const { pairKey } = getFamilyPair(myCode, familyCode);
  const { error } = await supabase
    .from("family_connections")
    .update({ status: "blocked", updated_at: new Date().toISOString() })
    .eq("pair_key", pairKey);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
