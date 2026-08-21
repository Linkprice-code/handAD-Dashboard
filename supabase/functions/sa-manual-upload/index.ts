// POST /functions/v1/sa-manual-upload
// 헤더: Authorization: Bearer <anon key>  (Supabase 게이트웨이 JWT 검증용, 필수)
//       apikey: <anon key>
//       X-Session-Token: <advertiser-login이 발급한 세션 토큰>  (실제 광고주 식별용)
// body: { raw_type: "sa_campaign" | "sa_adgroup" | "sa_keyword" | "sa_product", rows: [...] }
//
// 네이버 검색광고 API 자동 동기화(sa-sync) 대신, 관리시스템에서 다운로드한 리포트 CSV를
// 수기로 업로드하는 이 사이트 전용 엔드포인트다. GFA(캠페인/그룹/ADV/소재 Raw)와 동일한
// 구조로 캠페인/그룹/키워드/상품 Raw 4종을 둔다. GFA와 다른 점은, 파워링크/쇼핑검색/
// 브랜드검색을 raw_type이 아니라 CSV 안의 campaign_type(캠페인 유형) 컬럼으로 구분한다는
// 것이다 - 한 캠페인/그룹/키워드 Raw 파일에 여러 유형이 섞여 있어도 된다. 사용자가 입력한
// 캠페인 유형 값(파워링크/쇼핑검색/브랜드검색 등)은 normalizeCampaignType으로 WEB_SITE/
// SHOPPING/BRAND_SEARCH 코드로 정규화한 뒤에만 저장한다.
// campaign_type이 행마다 다를 수 있으므로, 재업로드 시 delete-then-insert는 (date,
// campaign_type) 조합 단위로 수행한다(다른 유형/날짜 데이터를 지우지 않기 위해).
// GFA raw 업로드와 달리, 네이버 SA 리포트는 전환수/전환매출액 컬럼이 아예 없는 경우가
// 흔해서(전환추적 미연결 등) 그 값들은 없으면 오류 대신 0으로 채운다.
// advertiser_id는 절대 body에서 받지 않고, X-Session-Token을 서버에서 검증해서 나온 값만 쓴다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  // Netlify에서 GitHub Pages로 이전함 (2026-08-21).
  "https://linkprice-code.github.io",
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
   raw_type별 설정 - 테이블명/텍스트 컬럼은 여기 허용 목록에서만 고른다
   (사용자 입력을 테이블명 등 식별자로 직접 쓰지 않는다)
--------------------------------------------------------- */
interface RawTypeConfig {
  table: string;
  campaignTypeRequired: boolean;
  textFields: string[];
  optionalTextFields?: string[];
}

// 네이버 SA_Daily Overview 리포트는 그룹/키워드(검색어) 단위로 내려받으면 캠페인 이름
// 컬럼 자체가 없다(실제 파일로 확인, 2026-08-21) - 그래서 campaign은 캠페인 Raw에서만
// 필수이고, 그룹/키워드 Raw에서는 선택 컬럼이다.
const RAW_TYPE_CONFIG: Record<string, RawTypeConfig> = {
  sa_campaign: { table: "sa_manual_campaign_raw", campaignTypeRequired: true, textFields: ["campaign"] },
  sa_adgroup: {
    table: "sa_manual_adgroup_raw",
    campaignTypeRequired: true,
    textFields: ["ad_group"],
    optionalTextFields: ["campaign"],
  },
  sa_keyword: {
    table: "sa_manual_keyword_raw",
    campaignTypeRequired: true,
    textFields: ["keyword"],
    optionalTextFields: ["campaign", "ad_group"],
  },
  sa_product: { table: "sa_manual_product_raw", campaignTypeRequired: false, textFields: ["product"] },
};

const MAX_ROWS = 20000;
const MAX_TEXT_LENGTH = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_FIELDS = ["impressions", "clicks", "cost", "conversions", "revenue"];

// 파워링크/쇼핑검색/브랜드검색을 가리킬 수 있는 표현들을 코드로 정규화한다.
// 프론트엔드(app.js normalizeSaCampaignType)에서 이미 정규화해서 보내지만,
// 이 엔드포인트를 직접 호출하는 경우도 있을 수 있어 서버에서도 다시 검증한다.
const CAMPAIGN_TYPE_ALIASES: Record<string, string> = {
  web_site: "WEB_SITE",
  파워링크: "WEB_SITE",
  웹사이트: "WEB_SITE",
  shopping: "SHOPPING",
  쇼핑검색: "SHOPPING",
  쇼핑: "SHOPPING",
  brand_search: "BRAND_SEARCH",
  브랜드검색: "BRAND_SEARCH",
  브랜드: "BRAND_SEARCH",
  // 네이버 SA_Daily Overview 리포트는 브랜드검색을 "브랜드검색/신제품검색" 복합
  // 표기로 내려준다 (2026-08-21 실제 파일로 확인).
  "브랜드검색/신제품검색": "BRAND_SEARCH",
  신제품검색: "BRAND_SEARCH",
};

function normalizeCampaignType(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return CAMPAIGN_TYPE_ALIASES[value] ?? null;
}

// GFA와 달리, 값이 아예 없으면(컬럼 자체가 CSV에 없었으면) 오류 대신 0으로 채운다.
// 값이 있는데 숫자로 못 읽거나 음수면 오류로 처리한다.
function toNonNegativeNumberOrZero(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function validateRow(
  raw: Record<string, unknown>,
  index: number,
  textFields: string[],
  optionalTextFields: string[],
  campaignTypeRequired: boolean,
): Record<string, unknown> {
  const rowNo = index + 1;

  if (typeof raw.date !== "string" || !DATE_RE.test(raw.date)) {
    throw new Error(`${rowNo}번째 행: date 형식이 올바르지 않습니다 (YYYY-MM-DD).`);
  }

  const clean: Record<string, unknown> = { date: raw.date };

  if (campaignTypeRequired) {
    const normalized = normalizeCampaignType(raw.campaign_type);
    if (!normalized) {
      throw new Error(
        `${rowNo}번째 행: 캠페인 유형 값("${String(raw.campaign_type ?? "")}")을 인식하지 못했습니다. ` +
          `파워링크/쇼핑검색/브랜드검색 중 하나로 입력해주세요.`,
      );
    }
    clean.campaign_type = normalized;
  }

  for (const field of textFields) {
    const value = String(raw[field] ?? "").trim();
    if (!value) {
      throw new Error(`${rowNo}번째 행: ${field}는 비어있을 수 없습니다.`);
    }
    if (value.length > MAX_TEXT_LENGTH) {
      throw new Error(`${rowNo}번째 행: ${field} 값이 너무 깁니다 (최대 ${MAX_TEXT_LENGTH}자).`);
    }
    clean[field] = value;
  }

  for (const field of optionalTextFields) {
    const value = String(raw[field] ?? "").trim();
    if (!value) continue;
    if (value.length > MAX_TEXT_LENGTH) {
      throw new Error(`${rowNo}번째 행: ${field} 값이 너무 깁니다 (최대 ${MAX_TEXT_LENGTH}자).`);
    }
    clean[field] = value;
  }

  for (const field of NUMERIC_FIELDS) {
    const n = toNonNegativeNumberOrZero(raw[field]);
    if (n === null) {
      throw new Error(`${rowNo}번째 행: ${field} 값이 올바르지 않습니다.`);
    }
    clean[field] = n;
  }

  return clean;
}

/* ---------------------------------------------------------
   핸들러
--------------------------------------------------------- */
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

  let body: { raw_type?: unknown; rows?: unknown };
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

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return jsonResponse({ success: false, message: "업로드할 데이터가 없습니다." }, 400, headers);
  }
  if (body.rows.length > MAX_ROWS) {
    return jsonResponse(
      { success: false, message: `한 번에 최대 ${MAX_ROWS}행까지 업로드할 수 있습니다.` },
      400,
      headers,
    );
  }

  let cleanRows: Record<string, unknown>[];
  try {
    cleanRows = body.rows.map((row, i) =>
      validateRow(
        row as Record<string, unknown>,
        i,
        config.textFields,
        config.optionalTextFields ?? [],
        config.campaignTypeRequired,
      )
    );
  } catch (err) {
    return jsonResponse({ success: false, message: (err as Error).message }, 400, headers);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("sa-manual-upload: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
    return jsonResponse({ success: false, message: "서버 설정 오류입니다." }, 500, headers);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // 같은 (advertiser, date[, campaign_type]) 조합을 다시 업로드해도 중복 누적되지 않도록,
  // 기존 데이터를 먼저 지우고 새로 넣는다. campaign_type이 행마다 다를 수 있으므로(한 파일에
  // 파워링크/쇼핑검색/브랜드검색이 섞여 있을 수 있음), (date, campaign_type) 조합 단위로 지운다.
  const uniqueDates = [...new Set(cleanRows.map((r) => r.date as string))];

  if (config.campaignTypeRequired) {
    const uniqueKeys = new Set(cleanRows.map((r) => `${r.date}|${r.campaign_type}`));
    for (const key of uniqueKeys) {
      const [date, campaignType] = key.split("|");
      const { error: deleteError } = await supabase
        .from(config.table)
        .delete()
        .eq("advertiser_id", session.advertiser_id)
        .eq("date", date)
        .eq("campaign_type", campaignType);
      if (deleteError) {
        console.error("sa-manual-upload delete error:", deleteError.message);
        return jsonResponse({ success: false, message: "기존 데이터 교체 중 오류가 발생했습니다." }, 500, headers);
      }
    }
  } else {
    const { error: deleteError } = await supabase
      .from(config.table)
      .delete()
      .eq("advertiser_id", session.advertiser_id)
      .in("date", uniqueDates);
    if (deleteError) {
      console.error("sa-manual-upload delete error:", deleteError.message);
      return jsonResponse({ success: false, message: "기존 데이터 교체 중 오류가 발생했습니다." }, 500, headers);
    }
  }

  const insertRows = cleanRows.map((r) => ({
    advertiser_id: session.advertiser_id,
    ...r,
  }));

  const { error: insertError } = await supabase.from(config.table).insert(insertRows);

  if (insertError) {
    console.error("sa-manual-upload insert error:", insertError.message);
    return jsonResponse({ success: false, message: "데이터 저장 중 오류가 발생했습니다." }, 500, headers);
  }

  return jsonResponse(
    { success: true, inserted: insertRows.length, dates_replaced: uniqueDates },
    200,
    headers,
  );
});

function jsonResponse(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
