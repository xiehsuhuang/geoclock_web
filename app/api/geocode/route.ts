import { NextResponse } from "next/server";
import type { PlaceSearchCandidate } from "@/lib/types";

type GeoapifyResult = {
  place_id?: string;
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  lat?: number;
  lon?: number;
};

type GeoapifyResponse = {
  results?: GeoapifyResult[];
};

export async function GET(request: Request) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "MISSING_API_KEY",
        message: "尚未設定地點搜尋 API，請先使用 Google Maps 分享連結或進階輸入。"
      },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ results: [] satisfies PlaceSearchCandidate[] });
  }

  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set("text", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "6");
  url.searchParams.set("lang", "zh");
  url.searchParams.set("apiKey", apiKey);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      },
      next: {
        revalidate: 60 * 60 * 24
      }
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "GEOCODE_FAILED",
          message: "地點搜尋暫時無法使用，請稍後再試，或貼 Google Maps 分享連結。"
        },
        { status: 502 }
      );
    }

    const payload = (await response.json()) as GeoapifyResponse;
    const results =
      payload.results
        ?.filter((item): item is GeoapifyResult & { lat: number; lon: number } => Number.isFinite(item.lat) && Number.isFinite(item.lon))
        .map((item, index) => ({
          id: item.place_id ?? `geoapify-${index}-${item.lat}-${item.lon}`,
          label: item.address_line1 || item.formatted || "未命名地點",
          address: item.formatted || [item.address_line1, item.address_line2].filter(Boolean).join("，") || "地址未提供",
          lat: item.lat,
          lng: item.lon,
          source: "geoapify" as const
        })) ?? [];

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json(
      {
        error: "GEOCODE_FAILED",
        message: "地點搜尋暫時無法使用，請稍後再試，或貼 Google Maps 分享連結。"
      },
      { status: 502 }
    );
  }
}
