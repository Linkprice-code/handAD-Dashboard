// POST /functions/v1/gfa-performance
// 헤더: Authorization: Bearer <anon key>  (Supabase 게이트웨이 JWT 검증용, 필수)
//       apikey: <anon key>
//       X-Session-Token: <advertiser-login이 발급한 세션 토큰>
// body: {
//   raw_type: "campaign" | "adgroup" | "adv" | "creative" | "campaign_type",
//   date_from?: "YYYY-MM-DD", date_to?: "YYYY-MM-DD",   // 분석기간/비교기간 필터 (둘 다 없으면 전체 기간)
//   campaign?: string                                    // raw_type이 "adgroup"일 때만 적용, 캠페인별 드릴다운용
// }
//
// raw_type에 맞는 GFA 원시 데이터 테이블(gfa_campaign_raw / gfa_adgroup_raw /
// gfa_adv_raw / gfa_creative_raw)에서 세션 토큰으로 검증된 advertiser_id의 행만,
// 날짜 범위(있으면) 안에서 가져와서 이름(캠페인/광고그룹/상품/소재) 기준으로 합산한
// 뒤 돌려준다. "campaign_type"은 gfa_campaign_raw를 캠페인이 아니라 캠페인 목적
// (웹사이트 전환/쇼핑 프로모션 등) 기준으로 합산하는 것만 다르고 나머지는 동일하다.
// 성과 대시보드(overview)의 핵심지표/캠페인별/그룹별 표는 이 함수를
// campaign raw_type으로 두 번(분석기간/비교기간) 호출해 그 결과를 합산하는 식으로 구성한다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://wjdauddba998-code.github.io",
  "https://linkprice-dashboard.netlify.app",
  // handAD-Dashboard(SA 수기 업로드 사이트) - GFA 조회는 그대로 재사용한다.
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
  if (!secret) {
    throw new Error("SESSION_SIGNING_SECRET secret이 설정되어 있지 않습니다.");
  }
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

/* ---------------------------------------------------------
   raw_type별 설정 - 테이블/컬럼명은 여기 허용 목록에서만 고른다
--------------------------------------------------------- */
const RAW_TYPE_CONFIG: Record<
  string,
  { table: string; nameField: string; select: string }
> = {
  campaign: {
    table: "gfa_campaign_raw",
    nameField: "campaign",
    select: "campaign, impressions, clicks, cost, conversions, revenue",
  },
  adgroup: {
    table: "gfa_adgroup_raw",
    nameField: "ad_group",
    select: "ad_group, impressions, clicks, cost, conversions, revenue",
  },
  adv: {
    table: "gfa_adv_raw",
    nameField: "product",
    select: "product, impressions, clicks, cost, conversions, revenue",
  },
  creative: {
    table: "gfa_creative_raw",
    nameField: "creative",
    select: "creative, impressions, clicks, cost, conversions, revenue",
  },
  campaign_type: {
    table: "gfa_campaign_raw",
    nameField: "campaign_type",
    select: "campaign_type, impressions, clicks, cost, conversions, revenue",
  },
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

  let body: { raw_type?: unknown; date_from?: unknown; date_to?: unknown; campaign?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: "요청 형식이 올바르지 않습니다." }, 400, headers);
  }

  const rawType = typeof body.raw_type === "string" ? body.raw_type : "";
  const config = RAW_TYPE_CONFIG[rawType];
  if (!config) {
    return jsonResponse({ success: false, message: "raw_type 값이 올바르지 않습니다." }, 400, headers);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const dateFrom = typeof body.date_from === "string" && DATE_RE.test(body.date_from) ? body.date_from : null;
  const dateTo = typeof body.date_to === "string" && DATE_RE.test(body.date_to) ? body.date_to : null;
  if ((body.date_from && !dateFrom) || (body.date_to && !dateTo)) {
    return jsonResponse({ success: false, message: "date_from/date_to 형식이 올바르지 않습니다 (YYYY-MM-DD)." }, 400, headers);
  }

  const campaignFilter =
    rawType === "adgroup" && typeof body.campaign === "string" && body.campaign.trim()
      ? body.campaign.trim()
      : null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("gfa-performance: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
    return jsonResponse({ success: false, message: "서버 설정 오류입니다." }, 500, headers);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let query = supabase
    .from(config.table)
    .select(config.select)
    .eq("advertiser_id", session.advertiser_id);

  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);
  if (campaignFilter) query = query.eq("campaign", campaignFilter);

  const { data, error } = await query;

  if (error) {
    console.error("gfa-performance query error:", error.message);
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

function jsonResponse(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
