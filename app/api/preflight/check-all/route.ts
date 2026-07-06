import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();
  const checks = [
    {
      key: "supabase",
      status: supabase ? "success" : "failed",
      label: "Supabase 連線",
      message: supabase ? "Supabase 環境變數已設定。" : "Supabase 環境變數未設定。",
      suggestion: supabase ? "" : "請設定 NEXT_PUBLIC_SUPABASE_URL 與 NEXT_PUBLIC_SUPABASE_ANON_KEY。"
    }
  ];

  if (supabase && code) {
    const { data: connections } = await supabase
      .from("family_connections")
      .select("id")
      .or(`user_a_code.eq.${code},user_b_code.eq.${code}`)
      .eq("status", "confirmed");
    checks.push({
      key: "family",
      status: (connections ?? []).length > 0 ? "success" : "warning",
      label: "已連線家人",
      message: (connections ?? []).length > 0 ? `已連線 ${(connections ?? []).length} 位家人。` : "尚未連線家人。",
      suggestion: (connections ?? []).length > 0 ? "" : "仍可開始行程，但不會自動通知家人。"
    });

    const { data: subscriptions } = await supabase.from("push_subscriptions").select("id").eq("user_code", code);
    checks.push({
      key: "pushSubscriptions",
      status: (subscriptions ?? []).length > 0 ? "success" : "warning",
      label: "Push 訂閱",
      message: (subscriptions ?? []).length > 0 ? "已找到你的 Push 訂閱。" : "尚未啟用通知。",
      suggestion: (subscriptions ?? []).length > 0 ? "" : "請按啟用通知，背景通知才可能送達。"
    });
  }

  return NextResponse.json({ ok: true, checks });
}
