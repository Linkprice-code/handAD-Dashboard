// POST /functions/v1/advertiser-login
// { "password": "..." } -> 광고주 고객번호(naver_customer_id)를 서버(service_role)에서만 검증한다.
// password는 광고주의 naver_customer_id 값이며, password_hash는 그 해시다.
// password_hash, naver_customer_id 등 민감 정보는 절대 응답에 포함하지 않는다.
//
// Supabase Dashboard의 웹 에디터에서 파일 하나만으로 배포할 수 있도록
// CORS / 세션 토큰 로직을 전부 이 파일 안에 포함했다 (로컬 상대경로 import 없음).
// 이후 데이터 조회용 Edge Function을 추가할 때도, 아래 세션 토큰 검증 로직을
// 그대로 복사해서 각 함수 파일에 포함시키면 된다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_PASSWORD_LENGTH = 200;
const GENERIC_FAIL_MESSAGE = "고객번호가 올바르지 않습니다.";
const SESSION_TTL_SECONDS = 30 * 60; // 30분

/* ---------------------------------------------------------
   CORS - GitHub Pages 배포 주소 + 로컬 개발 서버만 허용
--------------------------------------------------------- */
const ALLOWED_ORIGINS = [
  "https://wjdauddba998-code.github.io",
  "https://linkprice-dashboard.netlify.app",
  // handAD-Dashboard(SA 수기 업로드 사이트) - advertisers 테이블/이 함수를 그대로 재사용한다.
  "https://ad-dashboard-hand.netlify.app",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function corsHeaders(origin: string | null): HeadersInit {
  const allowOrigin =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/* ---------------------------------------------------------
   세션 토큰 - 외부 라이브러리 없이 HS256 JWT를 직접 서명한다
--------------------------------------------------------- */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
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
    ["sign"],
  );
}

async function createSessionToken(advertiserId: string, slug: string): Promise<string> {
  const key = await getSigningKey();

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    advertiser_id: advertiserId,
    slug,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };

  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  const encodedSignature = base64UrlEncode(new Uint8Array(signatureBytes));

  return `${signingInput}.${encodedSignature}`;
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

  // TODO(다음 단계): 여기서 요청 IP / advertiser 단위로 실패 횟수를 세어
  // rate limiting을 붙이기 쉽도록 검증 로직을 이 지점 하나로 모아둔다.

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: "요청 형식이 올바르지 않습니다." }, 400, headers);
  }

  const password = body?.password;
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return jsonResponse({ success: false, message: GENERIC_FAIL_MESSAGE }, 401, headers);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("advertiser-login: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
    return jsonResponse({ success: false, message: "서버 설정 오류입니다." }, 500, headers);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // password_hash는 이 함수 밖으로 절대 나오지 않는다. 비교는 DB 안에서 crypt()로 끝난다.
  const { data, error } = await supabase
    .rpc("find_advertiser_by_password", { input_password: password })
    .maybeSingle();

  if (error) {
    // 광고주 존재 여부나 DB 구조를 추측할 수 있는 상세 오류는 응답에 담지 않는다.
    console.error("advertiser-login rpc error:", error.message);
    return jsonResponse({ success: false, message: GENERIC_FAIL_MESSAGE }, 401, headers);
  }

  if (!data) {
    return jsonResponse({ success: false, message: GENERIC_FAIL_MESSAGE }, 401, headers);
  }

  let sessionToken: string;
  try {
    sessionToken = await createSessionToken(data.id, data.slug);
  } catch (err) {
    console.error("advertiser-login token error:", (err as Error).message);
    return jsonResponse({ success: false, message: "서버 설정 오류입니다." }, 500, headers);
  }

  return jsonResponse(
    {
      success: true,
      advertiser: { id: data.id, name: data.name, slug: data.slug },
      session_token: sessionToken,
    },
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
