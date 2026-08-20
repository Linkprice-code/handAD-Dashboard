// POST /functions/v1/sa-manual-performance
// 헤더: Authorization: Bearer <anon key>  (Supabase 게이트웨이 JWT 검증용, 필수)
//       apikey: <anon key>
//       X-Session-Token: <advertiser-login이 발급한 세션 토큰>
// body (집계 - 캠페인 유형별/캠페인별/그룹별/상품별):
//   { mode: "aggregate", group_by: "type" | "campaign" | "adgroup" | "product",
//     date_from?: "YYYY-MM-DD", date_to?: "YYYY-MM-DD" }
//   -> { success: true, rows: [{ name, impressions, clicks, cost, conversions, revenue, ctr, cvr, roas, cpa }] }
//
// body (키워드별 - 파워링크/쇼핑검색/브랜드검색 키워드별 성과 상세):
//   { mode: "keyword", campaign_type: "WEB_SITE" | "SHOPPING" | "BRAND_SEARCH",
//     date_from?: "YYYY-MM-DD", date_to?: "YYYY-MM-DD" }
//   -> { success: true, rows: [{ keyword, ad_group, campaign, impressions, clicks, cost, ctr, cpc }] }
//
// sa-manual-upload가 수기 업로드로 채운 sa_manual_campaign_raw / sa_manual_adgroup_raw /
// sa_manual_keyword_raw / sa_manual_product_raw(GFA와 동일한 캠페인/그룹/키워드/상품 raw
// 4종 구조)에서, 세션 토큰으로 검증된 advertiser_id의 행만 날짜 범위(있으면) 안에서 가져와
// 집계해 돌려준다. gfa-performance / (기존) sa-performance와 동일한 응답 형태를 최대한
// 유지해서 프론트엔드가 API 자동 동기화용 응답과 동일하게 다룰 수 있게 한다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://ad-dashboard-hand.netlify.app",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function corsHeaders(origin: string | null): HeadersInit {
  const allowOrigin =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-session-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/* ---------------------------------------------------------
   세션 토큰 검증 (advertiser-login에서 발급한 것과 같은 방식/같은 secret)
--------------------------------------------------------- */
function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getSigningKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("SESSION_SIGNING_SECRET");
  if (!secret) throw new Error("SESSION_SIGNING_SECRET secret이 설정되어 있지 않습니다.");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

interface SessionPayload {
  advertiser_id: string;
  slug: string;
  exp: number;
}

async function verifySessionToken(token: string): Promise<SessionPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token format");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const key = await getSigningKey();
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(encodedSignature),
    new TextEncoder().encode(signingInput),
  );
  if (!valid) throw new Error("invalid signature");

  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(encodedPayload)),
  ) as SessionPayload;

  if (typeof payload.advertiser_id !== "string" || typeof payload.exp !== "number") {
    throw new Error("invalid payload");
  }
  if (Date.now() >= payload.exp * 1000) {
    throw new Error("token expired");
  }
  return payload;
}

const CAMPAIGN_TYPES = new Set(["WEB_SITE", "SHOPPING", "BRAND_SEARCH"]);

/* ---------------------------------------------------------
   group_by별 설정(집계 모드) - 테이블/그룹기준 컬럼은 여기 허용 목록에서만 고른다
--------------------------------------------------------- */
const AGGREGATE_CONFIG: Record<string, { table: string; nameField: string }> = {
  type: { table: "sa_manual_campaign_raw", nameField: "campaign_type" },
  campaign: { table: "sa_manual_campaign_raw", nameField: "campaign" },
  adgroup: { table: "sa_manual_adgroup_raw", nameField: "ad_group" },
  product: { table: "sa_manual_product_raw", nameField: "product" },
};

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, message: "지원하지 않는 요청입니다." }, 405, headers);
  }

  const sessionToken = req.headers.get("x-session-token");
  if (!sessionToken) {
    return jsonResponse({ success: false, message: "인증이 필요합니다." }, 401, headers);
  }

  let session: SessionPayload;
  try {
    session = await verifySessionToken(sessionToken);
  } catch {
    return jsonResponse(
      { success: false, message: "세션이 만료되었거나 유효하지 않습니다. 다시 로그인해주세요." },
      401,
      headers,
    );
  }

  let body: {
    mode?: unknown;
    group_by?: unknown;
    campaign_type?: unknown;
    date_from?: unknown;
    date_to?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: "요청 형식이 올바르지 않습니다." }, 400, headers);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const dateFrom = typeof body.date_from === "string" && DATE_RE.test(body.date_from) ? body.date_from : null;
  const dateTo = typeof body.date_to === "string" && DATE_RE.test(body.date_to) ? body.date_to : null;
  if ((body.date_from && !dateFrom) || (body.date_to && !dateTo)) {
    return jsonResponse({ success: false, message: "date_from/date_to 형식이 올바르지 않습니다 (YYYY-MM-DD)." }, 400, headers);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("sa-manual-performance: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
    return jsonResponse({ success: false, message: "서버 설정 오류입니다." }, 500, headers);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const mode = typeof body.mode === "string" ? body.mode : "aggregate";

  if (mode === "keyword") {
    const campaignType = typeof body.campaign_type === "string" ? body.campaign_type : "";
    if (!CAMPAIGN_TYPES.has(campaignType)) {
      return jsonResponse({ success: false, message: "campaign_type 값이 올바르지 않습니다." }, 400, headers);
    }

    let query = supabase
      .from("sa_manual_keyword_raw")
      .select("campaign, ad_group, keyword, impressions, clicks, cost")
      .eq("advertiser_id", session.advertiser_id)
      .eq("campaign_type", campaignType);

    if (dateFrom) query = query.gte("date", dateFrom);
    if (dateTo) query = query.lte("date", dateTo);

    const { data, error } = await query;
    if (error) {
      console.error("sa-manual-performance keyword query error:", error.message);
      return jsonResponse({ success: false, message: "데이터를 불러오지 못했습니다." }, 500, headers);
    }

    const groups = new Map<
      string,
      { keyword: string; ad_group: string; campaign: string; impressions: number; clicks: number; cost: number }
    >();

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const keyword = String(row.keyword ?? "");
      const adGroup = String(row.ad_group ?? "") || "-";
      const campaign = String(row.campaign ?? "");
      const key = `${campaign}|||${adGroup}|||${keyword}`;
      const acc = groups.get(key) ?? { keyword, ad_group: adGroup, campaign, impressions: 0, clicks: 0, cost: 0 };
      acc.impressions += Number(row.impressions ?? 0);
      acc.clicks += Number(row.clicks ?? 0);
      acc.cost += Number(row.cost ?? 0);
      groups.set(key, acc);
    }

    const rows = [...groups.values()]
      .map((acc) => ({
        keyword: acc.keyword,
        ad_group: acc.ad_group,
        campaign: acc.campaign,
        impressions: acc.impressions,
        clicks: acc.clicks,
        cost: acc.cost,
        ctr: acc.impressions > 0 ? Number(((acc.clicks / acc.impressions) * 100).toFixed(2)) : 0,
        cpc: acc.clicks > 0 ? Math.round(acc.cost / acc.clicks) : 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    return jsonResponse({ success: true, rows }, 200, headers);
  }

  // mode === "aggregate"
  const groupBy = typeof body.group_by === "string" ? body.group_by : "";
  const config = AGGREGATE_CONFIG[groupBy];
  if (!config) {
    return jsonResponse({ success: false, message: "group_by 값이 올바르지 않습니다." }, 400, headers);
  }

  let query = supabase
    .from(config.table)
    .select(`${config.nameField}, impressions, clicks, cost, conversions, revenue`)
    .eq("advertiser_id", session.advertiser_id);

  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);

  const { data, error } = await query;

  if (error) {
    console.error("sa-manual-performance aggregate query error:", error.message);
    return jsonResponse({ success: false, message: "데이터를 불러오지 못했습니다." }, 500, headers);
  }

  const groups = new Map<
    string,
    { impressions: number; clicks: number; cost: number; conversions: number; revenue: number }
  >();

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const key = String(row[config.nameField] ?? "미지정") || "미지정";
    const acc = groups.get(key) ?? { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
    acc.impressions += Number(row.impressions ?? 0);
    acc.clicks += Number(row.clicks ?? 0);
    acc.cost += Number(row.cost ?? 0);
    acc.conversions += Number(row.conversions ?? 0);
    acc.revenue += Number(row.revenue ?? 0);
    groups.set(key, acc);
  }

  const rows = [...groups.entries()]
    .map(([name, acc]) => ({
      name,
      impressions: acc.impressions,
      clicks: acc.clicks,
      cost: acc.cost,
      conversions: acc.conversions,
      revenue: acc.revenue,
      ctr: acc.impressions > 0 ? Number(((acc.clicks / acc.impressions) * 100).toFixed(2)) : 0,
      cvr: acc.clicks > 0 ? Number(((acc.conversions / acc.clicks) * 100).toFixed(2)) : 0,
      roas: acc.cost > 0 ? Math.round((acc.revenue / acc.cost) * 100) : 0,
      cpa: acc.conversions > 0 ? Math.round(acc.cost / acc.conversions) : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  return jsonResponse({ success: true, rows }, 200, headers);
});
