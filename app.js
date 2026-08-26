/* =========================================================
   handAD-Dashboard - app.js
   ---------------------------------------------------------
   ads-performance-dashboard(SA API 자동 동기화)를 복제해서 만든 수기 업로드
   전용 사이트. GFA는 원본과 동일하게 CSV 수기 업로드를 쓰고, SA도 이제
   API 동기화 대신 GFA와 같은 방식(수기 업로드)으로 동작한다.
   ========================================================= */

/* ---------------------------------------------------------
   1. Supabase 공개 설정
   ---------------------------------------------------------
   url / anonKey는 브라우저에 노출되어도 되는 공개 값이다.
   실제 데이터 접근 권한은 RLS + Edge Function이 담당하므로
   GitHub에 커밋해도 안전하다. (service_role key는 절대 여기 두지 않는다)
--------------------------------------------------------- */
const SUPABASE_CONFIG = {
  url: "https://agglowdlyduilkjskxyx.supabase.co",
  anonKey: "sb_publishable_SM4u637sEeM0Vi0HtD-DgQ_9bQU-AD9"
};

const ADVERTISER_LOGIN_ENDPOINT = `${SUPABASE_CONFIG.url}/functions/v1/advertiser-login`;
const GFA_UPLOAD_ENDPOINT = `${SUPABASE_CONFIG.url}/functions/v1/gfa-upload`;
const GFA_PERFORMANCE_ENDPOINT = `${SUPABASE_CONFIG.url}/functions/v1/gfa-performance`;
// SA는 네이버 API 자동 동기화 대신, 관리시스템에서 다운로드한 CSV를 수기로 업로드해서 채운다
// (GFA와 동일한 원리 - sa-manual-upload/sa-manual-performance가 sa_manual_*_raw 테이블을 다룬다).
const SA_MANUAL_UPLOAD_ENDPOINT = `${SUPABASE_CONFIG.url}/functions/v1/sa-manual-upload`;
const SA_MANUAL_PERFORMANCE_ENDPOINT = `${SUPABASE_CONFIG.url}/functions/v1/sa-manual-performance`;
const SESSION_STORAGE_KEY = "adsDashboardSession";

/* ---------------------------------------------------------
   2. 사이드바 메뉴 정의
   ---------------------------------------------------------
   channels에 지금 선택된 채널(SA/GFA)이 없으면 사이드바에 아예 나타나지
   않는다. gfaRawType이 있는 항목은 GFA 채널일 때 그 raw 테이블을
   집계해서 보여준다.
--------------------------------------------------------- */
const MENU_ITEMS = [
  { id: "overview", label: "성과 대시보드", channels: ["SA", "GFA"] },
  { id: "trend", label: "그래프 추이", channels: ["SA", "GFA"] },
  { id: "product", label: "상품별 데이터", channels: ["SA", "GFA"], gfaRawType: "adv" },
  { id: "powerlink", label: "파워링크", channels: ["SA"], naverCampaignType: "WEB_SITE" },
  { id: "shopping", label: "쇼핑검색", channels: ["SA"], naverCampaignType: "SHOPPING" },
  { id: "brand", label: "브랜드검색", channels: ["SA"], naverCampaignType: "BRAND_SEARCH" },
  { id: "creative", label: "소재별 성과", channels: ["GFA"], gfaRawType: "creative" },
  { id: "upload", label: "데이터 업로드", channels: ["SA", "GFA"] }
];

// raw_type -> "이름" 컬럼 헤더에 쓸 표시명
const GFA_RAW_TYPE_NAME_LABEL = {
  campaign: "캠페인",
  adgroup: "광고그룹",
  adv: "상품",
  creative: "소재"
};

// GFA 캠페인 유형별 성과 표에 고정으로 보여줄 유형 순서 (네이버 GFA "캠페인 목적" 값)
const GFA_CAMPAIGN_TYPE_ORDER = ["웹사이트 전환", "인지도 및 트래픽", "쇼핑 프로모션", "카탈로그 판매", "동영상 조회", "ADVoost 쇼핑"];

/* ---------------------------------------------------------
   3. 채널(SA / GFA) 라벨
   ---------------------------------------------------------
   GFA는 업로드된 gfa_*_raw 데이터로, SA는 업로드된 sa_manual_*_raw 데이터로
   핵심지표를 계산한다. CTR/CPC/CVR/ROAS/CPA는 두 채널 모두 동일한 계산식
   (computeDerivedMetrics)으로 매번 다시 계산한다.
--------------------------------------------------------- */
const CHANNEL_LABELS = {
  SA: "SA",
  GFA: "GFA"
};

// sa-manual-performance가 group_by="type"로 돌려주는 네이버 캠페인 유형 코드 <-> 캠페인 유형별
// 필터 탭(data-campaign-type)의 매핑. 네이버 SA 표준 리포트 기준 코드다.
const SA_CAMPAIGN_TYPE_TO_NAVER = {
  powerlink: "WEB_SITE",
  shopping: "SHOPPING",
  brand: "BRAND_SEARCH"
};

// 상품 카테고리별 뱃지 색상 (현재는 카테고리를 넘겨주는 데이터가 없어 항상 기본색으로
// 표시되지만, 값이 들어오면 자동으로 매칭되도록 남겨둔다).
const MODEL_BADGE_COLORS = {};

/* ---------------------------------------------------------
   4. 인증
   ---------------------------------------------------------
   로그인 크리덴셜(광고주 naver_customer_id) 검증은 항상 Supabase Edge
   Function(advertiser-login)에서 수행한다. 브라우저는 결과로 받은 광고주
   정보 + 서명된 세션 토큰만 보관하며, password / password_hash는 어떤
   경우에도 다루지 않는다.
--------------------------------------------------------- */
async function authenticateAdvertiser(password) {
  let res;
  try {
    res = await fetch(ADVERTISER_LOGIN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_CONFIG.anonKey}`,
        "apikey": SUPABASE_CONFIG.anonKey
      },
      body: JSON.stringify({ password })
    });
  } catch {
    return { success: false, message: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { success: false, message: "서버 응답을 처리할 수 없습니다." };
  }

  if (!res.ok || !payload.success) {
    return { success: false, message: payload.message || "고객번호가 올바르지 않습니다." };
  }

  saveSession(payload.advertiser, payload.session_token);
  return { success: true, advertiser: payload.advertiser };
}

function saveSession(advertiser, token) {
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ advertiser, token }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

// advertiser_id 등은 여기서 신뢰용으로 쓰지 않는다 - UI 표시용일 뿐이며,
// 이후 실제 데이터 조회 Edge Function은 매 요청마다 토큰을 서버에서 다시 검증한다.
function getSession() {
  const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    clearSession();
    return null;
  }

  if (!session?.token || !session?.advertiser || isTokenExpired(session.token)) {
    clearSession();
    return null;
  }

  return session;
}

function isTokenExpired(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return true;

  try {
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);
    return typeof payload.exp !== "number" || Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

/* ---------------------------------------------------------
   4-1. GFA 데이터 업로드 / 조회
   ---------------------------------------------------------
   두 요청 모두 advertiser-login에서 받은 세션 토큰을 X-Session-Token
   헤더로 보낸다. advertiser_id는 서버가 이 토큰을 검증해서 알아내므로
   프론트엔드에서 advertiser_id를 별도로 보내지 않는다.
   rawType은 "campaign" / "adgroup" / "adv" 중 하나이며, 각각
   gfa_campaign_raw / gfa_adgroup_raw / gfa_adv_raw 테이블에 대응한다.
--------------------------------------------------------- */
// data-raw-type="sa_..."로 시작하는 업로드 카드는 GFA가 아니라 SA 수기 업로드
// 엔드포인트(sa-manual-upload)로 보낸다 - "데이터 업로드" 페이지가 채널 상관없이
// 같은 폼/파싱 로직을 공유하기 때문에 여기서 엔드포인트만 갈라준다.
async function uploadGfaData(rawType, rows) {
  const session = getSession();
  if (!session) {
    return { success: false, message: "세션이 만료되었습니다. 다시 로그인해주세요." };
  }

  const endpoint = rawType.startsWith("sa_") ? SA_MANUAL_UPLOAD_ENDPOINT : GFA_UPLOAD_ENDPOINT;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_CONFIG.anonKey}`,
        "apikey": SUPABASE_CONFIG.anonKey,
        "X-Session-Token": session.token
      },
      body: JSON.stringify({ raw_type: rawType, rows })
    });
  } catch {
    return { success: false, message: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { success: false, message: "서버 응답을 처리할 수 없습니다." };
  }

  if (!res.ok || !payload.success) {
    return { success: false, message: payload.message || "업로드에 실패했습니다." };
  }

  return payload;
}

async function fetchGfaPerformance(rawType, { dateFrom, dateTo, campaign } = {}) {
  const session = getSession();
  if (!session) {
    return { success: false, message: "세션이 만료되었습니다. 다시 로그인해주세요." };
  }

  let res;
  try {
    res = await fetch(GFA_PERFORMANCE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_CONFIG.anonKey}`,
        "apikey": SUPABASE_CONFIG.anonKey,
        "X-Session-Token": session.token
      },
      body: JSON.stringify({
        raw_type: rawType,
        date_from: dateFrom,
        date_to: dateTo,
        campaign
      })
    });
  } catch {
    return { success: false, message: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { success: false, message: "서버 응답을 처리할 수 없습니다." };
  }

  if (!res.ok || !payload.success) {
    return { success: false, message: payload.message || "데이터를 불러오지 못했습니다." };
  }

  return payload;
}

// group_by: "type"(캠페인 유형별) | "campaign"(캠페인별) - sa_manual_campaign_raw 집계.
async function fetchSaPerformance(groupBy, { dateFrom, dateTo } = {}) {
  return callSaManualPerformance({ mode: "aggregate", group_by: groupBy, date_from: dateFrom, date_to: dateTo });
}

// 파워링크/쇼핑검색/브랜드검색 키워드별 성과 - 수기 업로드한 sa_manual_keyword_raw를 집계한다.
async function fetchSaKeywordPerformance(campaignType, { dateFrom, dateTo } = {}) {
  return callSaManualPerformance({ mode: "keyword", campaign_type: campaignType, date_from: dateFrom, date_to: dateTo });
}

// 쇼핑검색 상품별 성과 - 수기 업로드한 sa_manual_product_raw를 집계한다.
async function fetchSaProductPerformance({ dateFrom, dateTo } = {}) {
  return callSaManualPerformance({ mode: "aggregate", group_by: "product", date_from: dateFrom, date_to: dateTo });
}

async function callSaManualPerformance(body) {
  const session = getSession();
  if (!session) {
    return { success: false, message: "세션이 만료되었습니다. 다시 로그인해주세요." };
  }

  let res;
  try {
    res = await fetch(SA_MANUAL_PERFORMANCE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_CONFIG.anonKey}`,
        "apikey": SUPABASE_CONFIG.anonKey,
        "X-Session-Token": session.token
      },
      body: JSON.stringify(body)
    });
  } catch {
    return { success: false, message: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { success: false, message: "서버 응답을 처리할 수 없습니다." };
  }

  if (!res.ok || !payload.success) {
    return { success: false, message: payload.message || "데이터를 불러오지 못했습니다." };
  }

  return payload;
}

function deleteBrandSearchContract(id) {
  return callBrandSearchContract({ action: "delete", id });
}

/* ---------------------------------------------------------
   5. DOM 참조
--------------------------------------------------------- */
const loginScreen = document.getElementById("loginScreen");
const dashboardScreen = document.getElementById("dashboardScreen");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const loginError = document.getElementById("loginError");
const loginSubmitBtn = loginForm.querySelector("button[type=submit]");

const sidebar = document.getElementById("sidebar");
const sidebarMenuList = document.getElementById("sidebarMenuList");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const menuToggle = document.getElementById("menuToggle");
const channelSwitch = document.getElementById("channelSwitch");
const overviewTitle = document.getElementById("overviewTitle");

const advertiserNameEl = document.getElementById("advertiserName");
const periodLabel = document.getElementById("periodLabel");
const logoutBtn = document.getElementById("logoutBtn");
const pdfExportBtn = document.getElementById("pdfExportBtn");

const kpiGrid = document.getElementById("kpiGrid");
const viewOverview = document.getElementById("view-overview");
const viewPlaceholder = document.getElementById("view-placeholder");
const placeholderTitle = document.getElementById("placeholderTitle");

const viewGrouped = document.getElementById("view-grouped");
const groupedTitle = document.getElementById("groupedTitle");
const groupedNameHeader = document.getElementById("groupedNameHeader");
const groupedTableBody = document.getElementById("groupedTableBody");

const viewUpload = document.getElementById("view-upload");
const uploadViewTitle = document.getElementById("uploadViewTitle");
const uploadViewIntro = document.getElementById("uploadViewIntro");
const channelUploadGrids = document.querySelectorAll(".channel-upload-grid");

const viewTrend = document.getElementById("view-trend");
const trendTitle = document.getElementById("trendTitle");

const analysisYearSelect = document.getElementById("analysisYearSelect");
const analysisMonthSelect = document.getElementById("analysisMonthSelect");
const analysisWeekSelect = document.getElementById("analysisWeekSelect");
const analysisDaySelect = document.getElementById("analysisDaySelect");
const analysisConfirmBtn = document.getElementById("analysisConfirmBtn");
const analysisThisMonthBtn = document.getElementById("analysisThisMonthBtn");
const analysisAllYearBtn = document.getElementById("analysisAllYearBtn");
const analysisResetBtn = document.getElementById("analysisResetBtn");

const compareYearSelect = document.getElementById("compareYearSelect");
const compareMonthSelect = document.getElementById("compareMonthSelect");
const compareWeekSelect = document.getElementById("compareWeekSelect");
const compareDaySelect = document.getElementById("compareDaySelect");
const compareConfirmBtn = document.getElementById("compareConfirmBtn");
const compareResetBtn = document.getElementById("compareResetBtn");

const viewModel = document.getElementById("view-model");
const modelViewTitle = document.getElementById("modelViewTitle");
const modelViewNotice = document.getElementById("modelViewNotice");
const modelListCard = document.getElementById("modelListCard");
const modelCardGrid = document.getElementById("modelCardGrid");
const modelSearchInput = document.getElementById("modelSearchInput");
const modelDetailModal = document.getElementById("modelDetailModal");
const modelDetailCloseBtn = document.getElementById("modelDetailCloseBtn");
const modelDetailBadge = document.getElementById("modelDetailBadge");
const modelDetailTitle = document.getElementById("modelDetailTitle");
const modelDetailPeriodLabel = document.getElementById("modelDetailPeriodLabel");
const modelDetailImpressions = document.getElementById("modelDetailImpressions");
const modelDetailClicks = document.getElementById("modelDetailClicks");
const modelDetailCpc = document.getElementById("modelDetailCpc");
const modelDetailCtr = document.getElementById("modelDetailCtr");
const modelDetailCvr = document.getElementById("modelDetailCvr");
const modelDetailCost = document.getElementById("modelDetailCost");
const modelDetailConversions = document.getElementById("modelDetailConversions");
const modelDetailRevenue = document.getElementById("modelDetailRevenue");
const modelDetailRoas = document.getElementById("modelDetailRoas");
const modelDetailKeywordBody = document.getElementById("modelDetailKeywordBody");

const viewKeyword = document.getElementById("view-keyword");
const keywordViewTitle = document.getElementById("keywordViewTitle");
const keywordViewNotice = document.getElementById("keywordViewNotice");
const keywordViewSubtitle = document.getElementById("keywordViewSubtitle");
const keywordSearchInput = document.getElementById("keywordSearchInput");
const keywordTable = document.getElementById("keywordTable");
const keywordTableBody = document.getElementById("keywordTableBody");

const overviewEmptyNotice = document.getElementById("overviewEmptyNotice");

const campaignTypeSection = document.getElementById("campaignTypeSection");
const campaignTypeFilter = document.getElementById("campaignTypeFilter");
const campaignTypeTableBody = document.getElementById("campaignTypeTableBody");

const gfaCampaignTypeSection = document.getElementById("gfaCampaignTypeSection");
const gfaCampaignTypeTableBody = document.getElementById("gfaCampaignTypeTableBody");

const breakdownTitle = document.getElementById("breakdownTitle");
const breakdownFilter = document.getElementById("breakdownFilter");
const breakdownTable = document.getElementById("breakdownTable");
const breakdownTableBody = document.getElementById("breakdownTableBody");
const breakdownNameHeader = document.getElementById("breakdownNameHeader");

const state = {
  charts: {},
  currentChannel: "SA",
  currentView: "overview",
  analysisPeriod: null,
  comparisonPeriod: null,
  breakdownRawType: "campaign",
  breakdownRows: [],
  campaignTypeRows: [],
  modelViewRows: [],
  modelViewOpts: null,
  keywordViewRows: [],
  breakdownSort: { key: "cost", dir: "desc" },
  keywordSort: { key: "cost", dir: "desc" },
  overviewRenderToken: 0
};

/* ---------------------------------------------------------
   5-1. 분석기간 / 비교기간 유틸
   ---------------------------------------------------------
   비교기간은 분석기간과 같은 길이만큼, 분석기간 바로 직전으로 자동 계산한다.
   (예: 분석기간이 8/1~8/14면 비교기간은 7/18~7/31)
--------------------------------------------------------- */
// toISOString()은 UTC 기준이라, UTC+9(한국)처럼 UTC보다 앞선 시간대에서는
// 자정 근처 날짜가 하루 밀려서 계산될 수 있다. 항상 로컬 날짜 기준으로 뽑는다.
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetweenInclusive(fromStr, toStr) {
  const from = new Date(`${fromStr}T00:00:00`);
  const to = new Date(`${toStr}T00:00:00`);
  return Math.round((to - from) / 86400000) + 1;
}

function defaultAnalysisPeriod() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29); // 최근 30일
  return { from: toISODate(from), to: toISODate(to) };
}

function computeComparisonPeriod(fromStr, toStr) {
  const lengthDays = Math.max(daysBetweenInclusive(fromStr, toStr), 1);
  const compareTo = new Date(`${fromStr}T00:00:00`);
  compareTo.setDate(compareTo.getDate() - 1);
  const compareFrom = new Date(compareTo);
  compareFrom.setDate(compareFrom.getDate() - (lengthDays - 1));
  return { from: toISODate(compareFrom), to: toISODate(compareTo) };
}

function formatPeriodRange(period) {
  if (!period) return "-";
  return `${period.from.replace(/-/g, ".")} ~ ${period.to.replace(/-/g, ".")}`;
}

// --- 주별(월~일 7일 고정) / 월별 선택 -> 실제 from~to 날짜로 변환 ---
// "n월 n주차"처럼 월 경계에서 잘린(예: 5~6일짜리) 짧은 주가 생기지 않도록, 항상
// 월요일~일요일 7일 단위로만 나눈다. 그 달의 1일이 속한 주(월요일 시작)부터 그
// 달 마지막 날이 속한 주까지 훑으므로, 앞뒤로 다른 달 날짜가 며칠 섞일 수 있다 -
// 그래서 "n주차" 순번 대신 실제 날짜 범위를 라벨로 보여준다.
function computeMonthWeeks(year, month) {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const weeks = [];

  const cursor = new Date(first);
  const daysSinceMonday = (cursor.getDay() + 6) % 7; // 0=월요일 ~ 6=일요일
  cursor.setDate(cursor.getDate() - daysSinceMonday);

  while (cursor <= last) {
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const label = `${cursor.getMonth() + 1}/${cursor.getDate()} ~ ${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`;
    weeks.push({ label, from: toISODate(cursor), to: toISODate(weekEnd) });

    cursor.setDate(cursor.getDate() + 7);
  }

  return weeks;
}

function daysInMonthCount(year, month) {
  return new Date(year, month, 0).getDate();
}

// year/fromMonth~toMonth(둘 다 1-12) 범위의 1일부터 말일까지. 그 범위 끝이 아직 안 지난
// 미래 날짜를 포함하면(=오늘이 걸쳐 있는 달이면) 어제까지로 잘라서, 안 끝난 오늘 데이터가
// 섞여 어색하게 보이지 않게 한다.
function monthsToRange(year, fromMonth, toMonth) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const first = new Date(year, fromMonth - 1, 1);
  const lastOfToMonth = new Date(year, toMonth, 0);
  const end = lastOfToMonth > yesterday ? yesterday : lastOfToMonth;

  return { from: toISODate(first), to: toISODate(end) };
}

function populateYearOptions(selectEl, year) {
  selectEl.innerHTML = [year - 1, year, year + 1].map((y) => `<option value="${y}">${y}년</option>`).join("");
  selectEl.value = String(year);
}

function populateMonthOptions(selectEl, month) {
  selectEl.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}">${m}월</option>`).join("");
  selectEl.value = String(month);
}

function populateWeekOptions(selectEl, year, month) {
  const weeks = computeMonthWeeks(year, month);
  selectEl.innerHTML =
    '<option value="">주차별 선택 (선택 안 함 = 월 전체)</option>' +
    weeks.map((w) => `<option value="${w.label}">${w.label}</option>`).join("");
  selectEl.value = "";
}

function populateDayOptions(selectEl, year, month) {
  const days = daysInMonthCount(year, month);
  selectEl.innerHTML =
    '<option value="">일별 선택</option>' +
    Array.from({ length: days }, (_, i) => i + 1).map((d) => `<option value="${d}">${month}월 ${d}일</option>`).join("");
  selectEl.value = "";
}

// 연/월/주차/일 드롭다운의 현재 선택값을 실제 {from, to} 날짜 범위로 바꾼다.
// 일 > 주차 > (둘 다 안 골랐으면) 월 전체 순서로 우선한다.
function readPickerRange(yearSelect, monthSelect, weekSelect, daySelect) {
  const year = Number(yearSelect.value);
  const month = Number(monthSelect.value);
  const day = daySelect.value;
  const weekLabel = weekSelect.value;

  if (day) {
    const d = `${year}-${String(month).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
    return { from: d, to: d };
  }
  if (weekLabel) {
    const weeks = computeMonthWeeks(year, month);
    const w = weeks.find((w) => w.label === weekLabel);
    if (w) return { from: w.from, to: w.to };
  }
  return monthsToRange(year, month, month);
}

function setPickerToMonth(yearSelect, monthSelect, weekSelect, daySelect, year, month) {
  populateYearOptions(yearSelect, year);
  populateMonthOptions(monthSelect, month);
  populateWeekOptions(weekSelect, year, month);
  populateDayOptions(daySelect, year, month);
}

/* ---------------------------------------------------------
   6. 로그인 / 로그아웃
--------------------------------------------------------- */
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = passwordInput.value;

  loginError.hidden = true;
  loginSubmitBtn.disabled = true;
  const originalLabel = loginSubmitBtn.textContent;
  loginSubmitBtn.textContent = "확인 중...";

  const result = await authenticateAdvertiser(password);
  console.debug("[login] result:", result);

  loginSubmitBtn.disabled = false;
  loginSubmitBtn.textContent = originalLabel;

  if (result.success) {
    passwordInput.value = "";
    showDashboard(result.advertiser);
  } else {
    loginError.textContent = result.message;
    loginError.hidden = false;
    console.debug("[login] loginError state:", {
      textContent: loginError.textContent,
      hidden: loginError.hidden,
      computedDisplay: getComputedStyle(loginError).display
    });
  }
});

logoutBtn.addEventListener("click", () => {
  clearSession();
  dashboardScreen.hidden = true;
  loginScreen.hidden = false;
  loginError.hidden = true;
  passwordInput.value = "";
  passwordInput.focus();
});

/* ---------------------------------------------------------
   현재 화면(지금 열려있는 뷰) 그대로 PDF로 저장
--------------------------------------------------------- */
pdfExportBtn.addEventListener("click", exportCurrentViewToPdf);

async function exportCurrentViewToPdf() {
  const target = document.querySelector("#content .view:not([hidden])");
  if (!target) return;

  const originalLabel = pdfExportBtn.textContent;
  pdfExportBtn.disabled = true;
  pdfExportBtn.textContent = "생성 중...";

  try {
    const canvas = await html2canvas(target, {
      scale: 2,
      backgroundColor: "#f3f5f9",
      useCORS: true,
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "pt", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 28;

    const viewLabel = (MENU_ITEMS.find((m) => m.id === state.currentView) || {}).label || "";

    // 헤더(광고주명 / 메뉴 / 분석기간)는 캡처 이미지가 아니라 텍스트로 직접 그려서 흐려지지 않게 한다.
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(14);
    pdf.text(advertiserNameEl.textContent || "", margin, margin + 12);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(90, 98, 117);
    pdf.text(`${viewLabel} · ${periodLabel.textContent || ""}`, margin, margin + 28);
    pdf.setTextColor(0, 0, 0);

    const imgWidth = pageWidth - margin * 2;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL("image/png");

    let position = margin + 44;
    pdf.addImage(imgData, "PNG", margin, position, imgWidth, imgHeight);

    let heightLeft = imgHeight - (pageHeight - position);
    while (heightLeft > 0) {
      pdf.addPage();
      position = -(imgHeight - heightLeft);
      pdf.addImage(imgData, "PNG", margin, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    const advertiserSlug = (advertiserNameEl.textContent || "advertiser").replace(/\s+/g, "_");
    const dateStr = new Date().toISOString().slice(0, 10);
    pdf.save(`${advertiserSlug}_${viewLabel}_${dateStr}.pdf`);
  } catch (e) {
    console.error("[pdf export]", e);
    alert("PDF 생성 중 오류가 발생했습니다.");
  } finally {
    pdfExportBtn.disabled = false;
    pdfExportBtn.textContent = originalLabel;
  }
}

function showDashboard(advertiser) {
  loginScreen.hidden = true;
  dashboardScreen.hidden = false;

  advertiserNameEl.textContent = advertiser.name;

  state.analysisPeriod = defaultAnalysisPeriod();
  state.comparisonPeriod = computeComparisonPeriod(state.analysisPeriod.from, state.analysisPeriod.to);

  const today = new Date();
  setPickerToMonth(analysisYearSelect, analysisMonthSelect, analysisWeekSelect, analysisDaySelect, today.getFullYear(), today.getMonth() + 1);
  const compareDate = new Date(`${state.comparisonPeriod.from}T00:00:00`);
  setPickerToMonth(compareYearSelect, compareMonthSelect, compareWeekSelect, compareDaySelect, compareDate.getFullYear(), compareDate.getMonth() + 1);

  applyChannelVisibility();
  renderSidebarMenu();
  switchView("overview");
}

function refreshCurrentPeriodView() {
  if (state.currentView === "overview") {
    renderOverview();
  } else if (state.currentView === "trend") {
    renderTrendView();
  } else if (state.currentView === "product") {
    renderModelView();
  } else {
    const item = MENU_ITEMS.find((m) => m.id === state.currentView);
    if (item && item.naverCampaignType) renderKeywordView(item);
  }
}

/* ---------------------------------------------------------
   6-0. 분석기간 / 비교기간 선택 - 연도 → 월 → (선택)주차 → (선택)일
   ---------------------------------------------------------
   드롭다운을 고르는 것만으로는 바로 조회하지 않고, "확인"을 눌러야
   실제로 반영된다 (고를 때마다 매번 다시 불러오면 느려지기 때문).
   주차와 일은 서로 배타적이다 - 하나를 고르면 다른 하나는 비워진다.
   둘 다 안 고르면 그 달 전체가 기간이 된다.
--------------------------------------------------------- */
function onPickerMonthChange(yearSelect, monthSelect, weekSelect, daySelect) {
  const year = Number(yearSelect.value);
  const month = Number(monthSelect.value);
  populateWeekOptions(weekSelect, year, month);
  populateDayOptions(daySelect, year, month);
}

analysisYearSelect.addEventListener("change", () =>
  onPickerMonthChange(analysisYearSelect, analysisMonthSelect, analysisWeekSelect, analysisDaySelect)
);
analysisMonthSelect.addEventListener("change", () =>
  onPickerMonthChange(analysisYearSelect, analysisMonthSelect, analysisWeekSelect, analysisDaySelect)
);
analysisWeekSelect.addEventListener("change", () => {
  if (analysisWeekSelect.value) analysisDaySelect.value = "";
});
analysisDaySelect.addEventListener("change", () => {
  if (analysisDaySelect.value) analysisWeekSelect.value = "";
});
analysisConfirmBtn.addEventListener("click", () => {
  state.analysisPeriod = readPickerRange(analysisYearSelect, analysisMonthSelect, analysisWeekSelect, analysisDaySelect);
  refreshCurrentPeriodView();
});

compareYearSelect.addEventListener("change", () =>
  onPickerMonthChange(compareYearSelect, compareMonthSelect, compareWeekSelect, compareDaySelect)
);
compareMonthSelect.addEventListener("change", () =>
  onPickerMonthChange(compareYearSelect, compareMonthSelect, compareWeekSelect, compareDaySelect)
);
compareWeekSelect.addEventListener("change", () => {
  if (compareWeekSelect.value) compareDaySelect.value = "";
});
compareDaySelect.addEventListener("change", () => {
  if (compareDaySelect.value) compareWeekSelect.value = "";
});
compareConfirmBtn.addEventListener("click", () => {
  state.comparisonPeriod = readPickerRange(compareYearSelect, compareMonthSelect, compareWeekSelect, compareDaySelect);
  refreshCurrentPeriodView();
});

// 분석기간 바로가기: 이번달 보기 / 전체 선택(연도 전체) / 전체 해제(이번달로 되돌리기)
analysisThisMonthBtn.addEventListener("click", () => {
  const now = new Date();
  setPickerToMonth(analysisYearSelect, analysisMonthSelect, analysisWeekSelect, analysisDaySelect, now.getFullYear(), now.getMonth() + 1);
  state.analysisPeriod = monthsToRange(now.getFullYear(), now.getMonth() + 1, now.getMonth() + 1);
  refreshCurrentPeriodView();
});
analysisAllYearBtn.addEventListener("click", () => {
  const year = Number(analysisYearSelect.value);
  state.analysisPeriod = monthsToRange(year, 1, 12);
  refreshCurrentPeriodView();
});
analysisResetBtn.addEventListener("click", () => {
  const now = new Date();
  setPickerToMonth(analysisYearSelect, analysisMonthSelect, analysisWeekSelect, analysisDaySelect, now.getFullYear(), now.getMonth() + 1);
  state.analysisPeriod = monthsToRange(now.getFullYear(), now.getMonth() + 1, now.getMonth() + 1);
  refreshCurrentPeriodView();
});

// 비교기간 초기화: 분석기간 기준으로 자동 계산한 "직전 같은 길이" 기간으로 되돌린다.
compareResetBtn.addEventListener("click", () => {
  state.comparisonPeriod = computeComparisonPeriod(state.analysisPeriod.from, state.analysisPeriod.to);
  const d = new Date(`${state.comparisonPeriod.from}T00:00:00`);
  setPickerToMonth(compareYearSelect, compareMonthSelect, compareWeekSelect, compareDaySelect, d.getFullYear(), d.getMonth() + 1);
  refreshCurrentPeriodView();
});

/* ---------------------------------------------------------
   6-1. 채널(SA / GFA) 전환
--------------------------------------------------------- */
// ADVoost 쇼핑은 GFA 전용 - SA에서는 탭 자체를 숨기고, 그 탭이 선택된
// 상태로 SA로 넘어왔으면 캠페인별로 되돌린다. 채널 전환 시뿐 아니라
// 최초 로그인 시(SA가 기본값)에도 반영되어야 하므로 함수로 분리한다.
function applyChannelVisibility() {
  const isGfa = state.currentChannel === "GFA";
  breakdownFilter.querySelectorAll(".gfa-only-tab").forEach((btn) => {
    btn.hidden = !isGfa;
  });
  if (!isGfa && state.breakdownRawType === "adv") {
    state.breakdownRawType = "campaign";
    breakdownFilter.querySelectorAll(".breakdown-filter-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.rawType === "campaign");
    });
    breakdownTitle.textContent = "캠페인별 성과";
  }
  state.breakdownSort = { key: "cost", dir: "desc" };
}

channelSwitch.addEventListener("click", (e) => {
  const tab = e.target.closest(".channel-tab");
  if (!tab || tab.classList.contains("active")) return;

  state.currentChannel = tab.dataset.channel;

  channelSwitch.querySelectorAll(".channel-tab").forEach((btn) => {
    const isActive = btn === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });

  applyChannelVisibility();

  renderSidebarMenu();
  renderCurrentView();
});

async function renderOverview() {
  overviewTitle.textContent = `${CHANNEL_LABELS[state.currentChannel]} 성과 대시보드`;
  periodLabel.textContent = formatPeriodRange(state.analysisPeriod);
  breakdownNameHeader.textContent = GFA_RAW_TYPE_NAME_LABEL[state.breakdownRawType] || "이름";

  // 캠페인 유형별(파워링크/쇼핑검색/브랜드검색)은 SA 전용 섹션이라 GFA에서는 숨긴다.
  campaignTypeSection.hidden = state.currentChannel !== "SA";
  // GFA 캠페인 유형별(웹사이트 전환/인지도 및 트래픽/쇼핑 프로모션/카탈로그 판매/동영상 조회)은 그 반대.
  gfaCampaignTypeSection.hidden = state.currentChannel !== "GFA";

  if (state.currentChannel === "GFA") {
    await renderGfaOverview();
  } else {
    await renderSaOverview();
  }
}

/* ---------------------------------------------------------
   6-1a. SA 성과 대시보드 - 실데이터 ("데이터 업로드" 메뉴에서 올린 sa_manual_campaign_raw 기준)
   ---------------------------------------------------------
   광고그룹(그룹별) 단위는 아직 범위 밖이라, 그 탭을 고르면 계속 안내 문구가 나온다.
--------------------------------------------------------- */
async function renderSaOverview() {
  const token = ++state.overviewRenderToken;
  const { from, to } = state.analysisPeriod;
  const { from: compareFrom, to: compareTo } = state.comparisonPeriod;

  const [currentResult, comparisonResult] = await Promise.all([
    fetchSaPerformance("type", { dateFrom: from, dateTo: to }),
    fetchSaPerformance("type", { dateFrom: compareFrom, dateTo: compareTo })
  ]);

  if (token !== state.overviewRenderToken) return;

  if (!currentResult.success) {
    overviewEmptyNotice.hidden = false;
    overviewEmptyNotice.textContent = currentResult.message;
    renderKpiCards(withDerivedMetrics({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 }), null);
    state.campaignTypeRows = [];
    renderCampaignTypeRows();
    state.breakdownRows = [];
    breakdownTableBody.innerHTML = `<tr><td colspan="9" class="grouped-empty">${escapeHtml(currentResult.message)}</td></tr>`;
    return;
  }

  const currentTotals = sumRawTotals(currentResult.rows);
  const comparisonTotals = comparisonResult.success ? sumRawTotals(comparisonResult.rows) : null;
  const hasData = currentResult.rows.length > 0;

  overviewEmptyNotice.hidden = hasData;
  if (!hasData) {
    overviewEmptyNotice.textContent =
      '표시할 데이터가 없습니다. "데이터 업로드" 메뉴에서 CSV를 먼저 업로드해주세요.';
  }

  renderKpiCards(
    withDerivedMetrics(currentTotals),
    comparisonTotals ? withDerivedMetrics(comparisonTotals) : null
  );

  state.campaignTypeRows = currentResult.rows;
  renderCampaignTypeRows();

  if (state.breakdownRawType === "campaign" || state.breakdownRawType === "adgroup") {
    await loadSaBreakdownData(state.breakdownRawType);
  } else {
    renderSaBreakdownPlaceholder();
  }
}

/* ---------------------------------------------------------
   6-1b. 캠페인 유형별 성과 (SA 전용: 파워링크 / 쇼핑검색 / 브랜드검색)
--------------------------------------------------------- */
campaignTypeFilter.addEventListener("click", (e) => {
  const btn = e.target.closest(".breakdown-filter-btn");
  if (!btn || btn.classList.contains("active")) return;

  campaignTypeFilter.querySelectorAll(".breakdown-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderCampaignTypeRows();
});

function renderCampaignTypeRows() {
  const activeBtn = campaignTypeFilter.querySelector(".breakdown-filter-btn.active");
  const key = activeBtn ? activeBtn.dataset.campaignType : "powerlink";
  const naverType = SA_CAMPAIGN_TYPE_TO_NAVER[key];
  const row = state.campaignTypeRows.find((r) => r.name === naverType);
  const label = activeBtn ? activeBtn.textContent : "";

  if (!row) {
    campaignTypeTableBody.innerHTML =
      '<tr><td colspan="9" class="grouped-empty">이 기간에 해당 유형 데이터가 없습니다.</td></tr>';
    return;
  }

  campaignTypeTableBody.innerHTML = `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${formatWon(row.cost)}</td>
      <td>${formatWon(row.revenue)}</td>
      <td>${row.roas}%</td>
      <td>${formatNumber(row.clicks)}</td>
      <td>${row.ctr.toFixed(2)}%</td>
      <td>${formatNumber(row.conversions)}</td>
      <td>${row.cvr.toFixed(2)}%</td>
      <td>${formatWon(row.cpa)}</td>
    </tr>
  `;
}

/* ---------------------------------------------------------
   6-2. GFA 성과 대시보드 - 실데이터 (분석기간/비교기간 기준)
--------------------------------------------------------- */
function sumRawTotals(rows) {
  const totals = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  rows.forEach((row) => {
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.cost += row.cost;
    totals.conversions += row.conversions;
    totals.revenue += row.revenue;
  });
  return totals;
}

// GFA 핵심지표(KPI 카드)와 "캠페인 유형별 성과"는 캠페인 Raw(gfa_campaign_raw)뿐 아니라
// ADVoost 쇼핑(gfa_adv_raw)까지 합산해서 보여준다 - ADVoost는 캠페인 목적(campaign_type)
// 컬럼이 아예 없는 별도 상품이라 원래 캠페인 Raw 집계에는 안 잡히기 때문에, 여기서
// "ADVoost 쇼핑"이라는 이름의 유형 하나로 직접 합쳐 넣는다.
async function renderGfaOverview() {
  const token = ++state.overviewRenderToken;
  const { from, to } = state.analysisPeriod;
  const { from: compareFrom, to: compareTo } = state.comparisonPeriod;

  const [currentResult, comparisonResult, campaignTypeResult, advCurrentResult, advComparisonResult] = await Promise.all([
    fetchGfaPerformance("campaign", { dateFrom: from, dateTo: to }),
    fetchGfaPerformance("campaign", { dateFrom: compareFrom, dateTo: compareTo }),
    fetchGfaPerformance("campaign_type", { dateFrom: from, dateTo: to }),
    fetchGfaPerformance("adv", { dateFrom: from, dateTo: to }),
    fetchGfaPerformance("adv", { dateFrom: compareFrom, dateTo: compareTo })
  ]);

  if (token !== state.overviewRenderToken) return; // 그 사이 다른 요청으로 대체됨

  if (!currentResult.success) {
    overviewEmptyNotice.hidden = false;
    overviewEmptyNotice.textContent = currentResult.message;
    renderKpiCards(withDerivedMetrics({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 }), null);
    renderGfaCampaignTypeRows([]);
    state.breakdownRows = [];
    breakdownTableBody.innerHTML = `<tr><td colspan="9" class="grouped-empty">${escapeHtml(currentResult.message)}</td></tr>`;
    return;
  }

  const advCurrentTotals = advCurrentResult.success ? sumRawTotals(advCurrentResult.rows) : null;
  const advComparisonTotals = advComparisonResult.success ? sumRawTotals(advComparisonResult.rows) : null;

  const currentTotals = addRawTotals(sumRawTotals(currentResult.rows), advCurrentTotals);
  const comparisonTotals = comparisonResult.success
    ? addRawTotals(sumRawTotals(comparisonResult.rows), advComparisonTotals)
    : null;
  const hasData = currentResult.rows.length > 0 || (advCurrentTotals && advCurrentTotals.impressions > 0);

  overviewEmptyNotice.hidden = hasData;
  if (!hasData) {
    overviewEmptyNotice.textContent =
      '표시할 데이터가 없습니다. GFA는 "데이터 업로드" 메뉴에서 CSV를 먼저 업로드해주세요.';
  }

  renderKpiCards(
    withDerivedMetrics(currentTotals),
    comparisonTotals ? withDerivedMetrics(comparisonTotals) : null
  );

  const campaignTypeRows = campaignTypeResult.success ? [...campaignTypeResult.rows] : [];
  if (advCurrentTotals) {
    campaignTypeRows.push({ name: "ADVoost 쇼핑", ...withDerivedMetrics(advCurrentTotals) });
  }
  renderGfaCampaignTypeRows(campaignTypeRows);

  await loadBreakdownData();
}

function addRawTotals(a, b) {
  if (!b) return a;
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    cost: a.cost + b.cost,
    conversions: a.conversions + b.conversions,
    revenue: a.revenue + b.revenue
  };
}

/* ---------------------------------------------------------
   6-2a. GFA 캠페인 유형별 성과 (웹사이트 전환 / 인지도 및 트래픽 / 쇼핑 프로모션 / 카탈로그
   판매 / 동영상 조회 / ADVoost 쇼핑)
   ---------------------------------------------------------
   캠페인 Raw 업로드 시 "캠페인 목적" 컬럼에서 뽑아 저장해둔 campaign_type 기준으로,
   고정된 유형(ADVoost 쇼핑 포함 6개)은 항상 순서대로 보여주고 그 외 값(또는 비어있는
   값)은 "기타"로 묶는다. ADVoost 쇼핑은 campaign_type 컬럼이 없는 별도 raw 테이블
   (gfa_adv_raw)이라, renderGfaOverview에서 합산해 이 이름으로 끼워 넣는다.
--------------------------------------------------------- */
function renderGfaCampaignTypeRows(rows) {
  const byName = new Map(rows.map((r) => [r.name, r]));

  const etcAcc = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  rows.forEach((r) => {
    if (!GFA_CAMPAIGN_TYPE_ORDER.includes(r.name)) {
      etcAcc.impressions += r.impressions;
      etcAcc.clicks += r.clicks;
      etcAcc.cost += r.cost;
      etcAcc.conversions += r.conversions;
      etcAcc.revenue += r.revenue;
    }
  });
  const hasEtc = etcAcc.impressions > 0 || etcAcc.clicks > 0 || etcAcc.cost > 0 || etcAcc.conversions > 0 || etcAcc.revenue > 0;

  const zero = withDerivedMetrics({ impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 });
  const displayRows = GFA_CAMPAIGN_TYPE_ORDER.map((type) => ({ label: type, data: byName.get(type) || zero }));
  if (hasEtc) {
    displayRows.push({ label: "기타", data: withDerivedMetrics(etcAcc) });
  }

  gfaCampaignTypeTableBody.innerHTML = displayRows
    .map(
      ({ label, data }) => `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${formatWon(data.cost)}</td>
      <td>${formatWon(data.revenue)}</td>
      <td>${data.roas}%</td>
      <td>${formatNumber(data.clicks)}</td>
      <td>${data.ctr.toFixed(2)}%</td>
      <td>${formatNumber(data.conversions)}</td>
      <td>${data.cvr.toFixed(2)}%</td>
      <td>${formatWon(data.cpa)}</td>
    </tr>
  `
    )
    .join("");
}

/* ---------------------------------------------------------
   6-3. 캠페인별 / 그룹별 / ADVoost 쇼핑 필터 (성과 대시보드 하단)
   ---------------------------------------------------------
   세 카테고리를 표 2개로 나란히 보여주던 이전 방식 대신, 필터 탭
   하나로 캠페인별/그룹별/ADVoost 쇼핑(상품별)을 전환한다. 컬럼 헤더를
   클릭하면 그 지표 기준으로 오름차순/내림차순 정렬된다.
--------------------------------------------------------- */
breakdownFilter.addEventListener("click", (e) => {
  const btn = e.target.closest(".breakdown-filter-btn");
  if (!btn || btn.classList.contains("active")) return;

  state.breakdownRawType = btn.dataset.rawType;
  breakdownFilter.querySelectorAll(".breakdown-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
  breakdownTitle.textContent = `${btn.textContent} 성과`;
  breakdownNameHeader.textContent = GFA_RAW_TYPE_NAME_LABEL[state.breakdownRawType] || "이름";
  state.breakdownSort = { key: "cost", dir: "desc" };

  if (state.currentChannel === "GFA") {
    loadBreakdownData();
  } else if (state.breakdownRawType === "campaign" || state.breakdownRawType === "adgroup") {
    loadSaBreakdownData(state.breakdownRawType);
  } else {
    renderSaBreakdownPlaceholder();
  }
});

breakdownTable.querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;

  const key = th.dataset.sortKey;
  if (state.breakdownSort.key === key) {
    state.breakdownSort.dir = state.breakdownSort.dir === "desc" ? "asc" : "desc";
  } else {
    state.breakdownSort = { key, dir: key === "name" ? "asc" : "desc" };
  }
  renderBreakdownRows();
});

async function loadBreakdownData() {
  const token = ++state.overviewRenderToken;
  breakdownTableBody.innerHTML = '<tr><td colspan="9" class="grouped-empty">불러오는 중...</td></tr>';

  const result = await fetchGfaPerformance(state.breakdownRawType, {
    dateFrom: state.analysisPeriod.from,
    dateTo: state.analysisPeriod.to
  });

  if (token !== state.overviewRenderToken) return;

  if (!result.success) {
    state.breakdownRows = [];
    breakdownTableBody.innerHTML = `<tr><td colspan="9" class="grouped-empty">${escapeHtml(result.message)}</td></tr>`;
    updateSortIndicators(breakdownTable, state.breakdownSort);
    return;
  }

  state.breakdownRows = result.rows;
  renderBreakdownRows();
}

async function loadSaBreakdownData(groupBy) {
  const token = ++state.overviewRenderToken;
  breakdownTableBody.innerHTML = '<tr><td colspan="9" class="grouped-empty">불러오는 중...</td></tr>';

  const result = await fetchSaPerformance(groupBy, {
    dateFrom: state.analysisPeriod.from,
    dateTo: state.analysisPeriod.to
  });

  if (token !== state.overviewRenderToken) return;

  if (!result.success) {
    state.breakdownRows = [];
    breakdownTableBody.innerHTML = `<tr><td colspan="9" class="grouped-empty">${escapeHtml(result.message)}</td></tr>`;
    updateSortIndicators(breakdownTable, state.breakdownSort);
    return;
  }

  state.breakdownRows = result.rows;
  renderBreakdownRows();
}

// ADVoost 쇼핑 탭은 GFA 전용이라 SA에서는 숨겨지지만(gfa-only-tab), 안전장치로 남겨둔다.
function renderSaBreakdownPlaceholder() {
  state.breakdownRows = [];
  breakdownTableBody.innerHTML =
    '<tr><td colspan="9" class="grouped-empty">표시할 수 없는 항목입니다.</td></tr>';
  updateSortIndicators(breakdownTable, state.breakdownSort);
}

/* ---------------------------------------------------------
   6-1c. 파워링크 / 쇼핑검색 / 브랜드검색 - 키워드별 성과 (SA 전용, 수기 업로드)
   ---------------------------------------------------------
   "데이터 업로드" 메뉴에서 올린 키워드 리포트 CSV(sa_manual_keyword_raw)를 키워드
   기준으로 집계해서 보여준다 (캠페인/광고그룹 구분 없이 키워드별로 합산).
--------------------------------------------------------- */
async function renderKeywordView(item) {
  keywordViewTitle.textContent = `${item.label} 키워드별 성과`;
  keywordViewSubtitle.textContent = `${item.label} 키워드별 성과 상세`;
  keywordViewNotice.hidden = true;
  keywordSearchInput.value = "";
  state.keywordSort = { key: "cost", dir: "desc" };
  keywordTableBody.innerHTML = '<tr><td colspan="10" class="grouped-empty">불러오는 중...</td></tr>';

  const token = ++state.overviewRenderToken;
  const result = await fetchSaKeywordPerformance(item.naverCampaignType, {
    dateFrom: state.analysisPeriod.from,
    dateTo: state.analysisPeriod.to
  });

  if (token !== state.overviewRenderToken) return;

  if (!result.success) {
    state.keywordViewRows = [];
    keywordViewNotice.hidden = false;
    keywordViewNotice.textContent = result.message;
    keywordTableBody.innerHTML = `<tr><td colspan="10" class="grouped-empty">${escapeHtml(result.message)}</td></tr>`;
    return;
  }

  state.keywordViewRows = result.rows;
  if (result.rows.length === 0) {
    keywordViewNotice.hidden = false;
    keywordViewNotice.textContent = "이 기간에 실적이 있는 키워드가 없습니다.";
  }
  renderKeywordTable();
}

const KEYWORD_TEXT_SORT_KEYS = new Set(["keyword"]);

function renderKeywordTable() {
  updateSortIndicators(keywordTable, state.keywordSort);

  const q = keywordSearchInput.value.trim().toLowerCase();
  const filtered = q
    ? state.keywordViewRows.filter((r) => r.keyword.toLowerCase().includes(q))
    : state.keywordViewRows;

  if (filtered.length === 0) {
    keywordTableBody.innerHTML = `<tr><td colspan="10" class="grouped-empty">${
      state.keywordViewRows.length === 0 ? "데이터가 없습니다." : "검색 결과가 없습니다."
    }</td></tr>`;
    return;
  }

  const { key, dir } = state.keywordSort;
  const sorted = [...filtered].sort((a, b) => {
    const cmp = KEYWORD_TEXT_SORT_KEYS.has(key)
      ? String(a[key]).localeCompare(String(b[key]), "ko")
      : a[key] - b[key];
    return dir === "asc" ? cmp : -cmp;
  });

  keywordTableBody.innerHTML = sorted
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.keyword)}</td>
          <td>${formatNumber(r.impressions)}</td>
          <td>${formatNumber(r.clicks)}</td>
          <td>${r.ctr.toFixed(2)}%</td>
          <td>${formatWon(r.cpc)}</td>
          <td>${formatWon(r.cost)}</td>
          <td>${formatNumber(r.conversions)}</td>
          <td>${formatWon(r.revenue)}</td>
          <td>${r.roas}%</td>
          <td>${formatWon(r.cpa)}</td>
        </tr>
      `
    )
    .join("");
}

keywordSearchInput.addEventListener("input", renderKeywordTable);

keywordTable.querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;

  const key = th.dataset.sortKey;
  if (state.keywordSort.key === key) {
    state.keywordSort.dir = state.keywordSort.dir === "desc" ? "asc" : "desc";
  } else {
    state.keywordSort = { key, dir: KEYWORD_TEXT_SORT_KEYS.has(key) ? "asc" : "desc" };
  }
  renderKeywordTable();
});

/* ---------------------------------------------------------
   6-2. 상품별(모델별) 성과 뷰 - 도넛/막대+선 차트 + 모델 카드 + 상세 모달
   ---------------------------------------------------------
   SA는 쇼핑검색 상품 수기 업로드 실데이터(sa_manual_product_raw),
   GFA는 gfa_adv_raw(ADVoost) 실데이터를 쓴다.
--------------------------------------------------------- */
async function renderModelView() {
  modelViewTitle.textContent = `${CHANNEL_LABELS[state.currentChannel]} 상품별(모델별) 성과`;
  if (state.currentChannel === "GFA") {
    await renderGfaModelView();
  } else {
    await renderSaModelView();
  }
}

async function renderSaModelView() {
  modelListCard.hidden = false;
  modelViewNotice.hidden = true;

  const token = ++state.overviewRenderToken;
  const result = await fetchSaProductPerformance({
    dateFrom: state.analysisPeriod.from,
    dateTo: state.analysisPeriod.to
  });

  if (token !== state.overviewRenderToken) return;

  if (!result.success) {
    modelViewNotice.hidden = false;
    modelViewNotice.textContent = result.message;
    destroyChart("modelDonut");
    destroyChart("modelCvrRoas");
    modelSearchInput.value = "";
    renderModelCardGrid([], { showBadge: false, onClick: openModelDetailModal });
    return;
  }

  if (result.rows.length === 0) {
    modelViewNotice.hidden = false;
    modelViewNotice.textContent =
      '표시할 상품별 데이터가 없습니다. "데이터 업로드" 메뉴에서 쇼핑검색 상품별 리포트를 먼저 업로드해주세요.';
  }

  const models = result.rows.map((r) => ({ model: r.name, category: null, ...r }));
  const top5 = [...models].sort((a, b) => b.revenue - a.revenue).slice(0, 5);

  renderModelDonutChart(top5);
  renderModelCvrRoasChart(top5);
  modelSearchInput.value = "";
  renderModelCardGrid(models, { showBadge: false, onClick: openModelDetailModal });
}

// ADVoost 쇼핑은 검색어(키워드) 단위 데이터가 원래 없어서, 카드 목록/클릭 상세 없이
// 모델 매출 비중 + 주요 5개 상품 CVR&ROAS 차트 2개만 보여준다.
async function renderGfaModelView() {
  modelListCard.hidden = true;
  modelViewNotice.hidden = true;

  const token = ++state.overviewRenderToken;
  const result = await fetchGfaPerformance("adv", {
    dateFrom: state.analysisPeriod.from,
    dateTo: state.analysisPeriod.to
  });

  if (token !== state.overviewRenderToken) return;

  if (!result.success) {
    modelViewNotice.hidden = false;
    modelViewNotice.textContent = result.message;
    destroyChart("modelDonut");
    destroyChart("modelCvrRoas");
    return;
  }

  if (result.rows.length === 0) {
    modelViewNotice.hidden = false;
    modelViewNotice.textContent =
      '표시할 데이터가 없습니다. "데이터 업로드" 메뉴에서 ADV Raw를 먼저 업로드해주세요.';
  }

  const models = result.rows.map((r) => ({ model: r.name, category: null, ...r }));
  const top5 = [...models].sort((a, b) => b.revenue - a.revenue).slice(0, 5);

  renderModelDonutChart(top5);
  renderModelCvrRoasChart(top5);
}

function renderModelDonutChart(top5) {
  destroyChart("modelDonut");
  const colors = ["#2563eb", "#38bdf8", "#22c55e", "#f59e0b", "#a855f7"];
  const total = top5.reduce((sum, m) => sum + m.revenue, 0);
  const percentOf = (revenue) => (total > 0 ? ((revenue / total) * 100).toFixed(1) : "0.0");

  state.charts.modelDonut = new Chart(document.getElementById("modelRevenueDonutChart"), {
    type: "doughnut",
    data: {
      labels: top5.map((m) => `${m.model} (${percentOf(m.revenue)}%)`),
      datasets: [{ data: top5.map((m) => m.revenue), backgroundColor: colors, borderWidth: 0 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${formatWon(ctx.parsed)}` } }
      }
    }
  });
}

function renderModelCvrRoasChart(top5) {
  destroyChart("modelCvrRoas");
  state.charts.modelCvrRoas = new Chart(document.getElementById("modelCvrRoasChart"), {
    data: {
      labels: top5.map((m) => m.model),
      datasets: [
        {
          type: "bar",
          label: "전환율(CVR) %",
          data: top5.map((m) => Number(m.cvr.toFixed(1))),
          backgroundColor: "#2563eb",
          yAxisID: "y"
        },
        {
          type: "line",
          label: "ROAS (천%)",
          data: top5.map((m) => Number((m.roas / 1000).toFixed(1))),
          borderColor: "#ef4444",
          backgroundColor: "#ef4444",
          yAxisID: "y1",
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        y: { position: "left", title: { display: true, text: "CVR (%)" }, grid: { color: "rgba(0,0,0,0.05)" } },
        y1: { position: "right", title: { display: true, text: "ROAS (천%)" }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

// models: {model, category, impressions, clicks, cost, conversions, revenue, ctr, cvr, roas, cpa}[]
// opts: { showBadge: 카테고리 뱃지 표시 여부, onClick: 카드 클릭 시 호출할 함수(model) }
function renderModelCardGrid(models, opts) {
  state.modelViewRows = models;
  state.modelViewOpts = opts;

  const q = modelSearchInput.value.trim().toLowerCase();
  const filtered = q
    ? models.filter((m) => m.model.toLowerCase().includes(q) || (m.category || "").toLowerCase().includes(q))
    : models;

  if (models.length === 0) {
    modelCardGrid.innerHTML = "";
    return;
  }

  if (filtered.length === 0) {
    modelCardGrid.innerHTML = '<p class="grouped-empty">검색 결과가 없습니다.</p>';
    return;
  }

  modelCardGrid.innerHTML = filtered
    .map((m, i) => {
      const badgeHtml = opts.showBadge
        ? `<span class="model-badge ${MODEL_BADGE_COLORS[m.category] || "badge-blue"}">${escapeHtml(m.category)}</span>`
        : "";
      return `
        <div class="model-card" data-idx="${i}">
          <div class="model-card-top">
            <span class="model-card-name">${escapeHtml(m.model)}</span>
            ${badgeHtml}
          </div>
          <div class="model-card-metrics">
            <div><span class="model-metric-label">노출수</span><span class="model-metric-value">${formatNumber(m.impressions)}</span></div>
            <div><span class="model-metric-label">클릭수</span><span class="model-metric-value">${formatNumber(m.clicks)}</span></div>
            <div><span class="model-metric-label">총비용</span><span class="model-metric-value">${formatWon(m.cost)}</span></div>
            <div><span class="model-metric-label">전환수</span><span class="model-metric-value">${formatNumber(m.conversions)}건</span></div>
          </div>
          <div class="model-card-bottom">
            <div><span class="model-metric-label">총매출</span><span class="model-metric-value strong">${formatWon(m.revenue)}</span></div>
            <div class="model-card-bottom-right">
              <span class="model-metric-label">CVR ${formatPercent(m.cvr)}</span>
              <span class="model-metric-value accent">ROAS ${formatPercent(m.roas)}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  modelCardGrid.querySelectorAll(".model-card").forEach((card) => {
    card.addEventListener("click", () => opts.onClick(filtered[Number(card.dataset.idx)]));
  });
}

modelSearchInput.addEventListener("input", () => {
  renderModelCardGrid(state.modelViewRows, state.modelViewOpts);
});

function openModelDetailModal(model) {
  const d = withDerivedMetrics(model);

  if (model.category) {
    const badgeClass = MODEL_BADGE_COLORS[model.category] || "badge-blue";
    modelDetailBadge.className = `model-badge ${badgeClass}`;
    modelDetailBadge.textContent = model.category;
    modelDetailBadge.hidden = false;
  } else {
    modelDetailBadge.hidden = true;
  }

  modelDetailTitle.textContent = model.model;
  modelDetailPeriodLabel.textContent = state.analysisPeriod ? formatPeriodRange(state.analysisPeriod) : "";

  modelDetailImpressions.textContent = formatNumber(d.impressions);
  modelDetailClicks.textContent = formatNumber(d.clicks);
  modelDetailCpc.textContent = formatWon(d.cpc);
  modelDetailCtr.textContent = formatPercent(d.ctr);
  modelDetailCvr.textContent = formatPercent(d.cvr);

  modelDetailCost.textContent = formatWon(d.cost);
  modelDetailConversions.textContent = `${formatNumber(d.conversions)}건`;
  modelDetailRevenue.textContent = formatWon(d.revenue);
  modelDetailRoas.textContent = formatPercent(d.roas);

  if (model.keywords) {
    modelDetailKeywordBody.innerHTML = model.keywords
      .map(
        (k) => `
          <tr>
            <td>${escapeHtml(k.keyword)}</td>
            <td>${formatNumber(k.impressions)}</td>
            <td>${formatNumber(k.clicks)}</td>
            <td>${formatWon(k.cost)}</td>
            <td>${formatNumber(k.conversions)}</td>
            <td>${formatWon(k.revenue)}</td>
          </tr>
        `
      )
      .join("");
  } else {
    modelDetailKeywordBody.innerHTML =
      '<tr><td colspan="6" class="grouped-empty">키워드 단위 데이터는 제공되지 않습니다.</td></tr>';
  }

  modelDetailModal.hidden = false;
}

function closeModelDetailModal() {
  modelDetailModal.hidden = true;
}

modelDetailCloseBtn.addEventListener("click", closeModelDetailModal);
modelDetailModal.addEventListener("click", (e) => {
  if (e.target === modelDetailModal) closeModelDetailModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modelDetailModal.hidden) closeModelDetailModal();
});

function renderBreakdownRows() {
  updateSortIndicators(breakdownTable, state.breakdownSort);

  if (state.breakdownRows.length === 0) {
    breakdownTableBody.innerHTML =
      '<tr><td colspan="9" class="grouped-empty">이 기간에 업로드된 데이터가 없습니다.</td></tr>';
    return;
  }

  const { key, dir } = state.breakdownSort;
  const sorted = [...state.breakdownRows].sort((a, b) => {
    const cmp = key === "name" ? String(a.name).localeCompare(String(b.name), "ko") : a[key] - b[key];
    return dir === "asc" ? cmp : -cmp;
  });

  breakdownTableBody.innerHTML = sorted
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${formatWon(row.cost)}</td>
          <td>${formatWon(row.revenue)}</td>
          <td>${row.roas}%</td>
          <td>${formatNumber(row.clicks)}</td>
          <td>${row.ctr.toFixed(2)}%</td>
          <td>${formatNumber(row.conversions)}</td>
          <td>${row.cvr.toFixed(2)}%</td>
          <td>${formatWon(row.cpa)}</td>
        </tr>
      `
    )
    .join("");
}

// breakdownTable(캠페인별 성과)과 keywordTable(파워링크/쇼핑검색/브랜드검색 키워드별
// 성과) 둘 다 컬럼 클릭 정렬을 쓰므로, 어느 테이블/정렬 상태든 공통으로 처리한다.
function updateSortIndicators(table, sortState) {
  table.querySelectorAll("th.sortable").forEach((th) => {
    const isSorted = th.dataset.sortKey === sortState.key;
    th.classList.toggle("sorted", isSorted);
    let arrow = th.querySelector(".sort-arrow");
    if (!arrow) {
      arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      th.appendChild(arrow);
    }
    arrow.textContent = isSorted && sortState.dir === "asc" ? "▲" : "▼";
  });
}

/* ---------------------------------------------------------
   6-4. 그래프 추이 (SA/GFA 공통, 분석기간 총합 기준)
--------------------------------------------------------- */
async function renderTrendView() {
  trendTitle.textContent = `${CHANNEL_LABELS[state.currentChannel]} 그래프 추이`;

  const token = ++state.overviewRenderToken;
  const result =
    state.currentChannel === "GFA"
      ? await fetchGfaPerformance("campaign", { dateFrom: state.analysisPeriod.from, dateTo: state.analysisPeriod.to })
      : await fetchSaPerformance("campaign", { dateFrom: state.analysisPeriod.from, dateTo: state.analysisPeriod.to });

  if (token !== state.overviewRenderToken) return;

  const totals = result.success ? sumRawTotals(result.rows) : { cost: 0, revenue: 0 };
  renderCharts(totals);
}

/* ---------------------------------------------------------
   7. 사이드바 메뉴 렌더링 / 뷰 전환
--------------------------------------------------------- */
function renderSidebarMenu() {
  sidebarMenuList.innerHTML = "";

  MENU_ITEMS.forEach((item) => {
    if (!item.channels.includes(state.currentChannel)) return;

    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "sidebar-menu-item";
    btn.dataset.viewId = item.id;
    btn.innerHTML = `<span class="menu-icon"></span><span>${item.label}</span>`;
    btn.addEventListener("click", () => {
      switchView(item.id);
      closeSidebarOnMobile();
    });
    li.appendChild(btn);
    sidebarMenuList.appendChild(li);
  });
}

function switchView(viewId) {
  state.currentView = viewId;
  renderCurrentView();
}

function renderCurrentView() {
  let item = MENU_ITEMS.find((m) => m.id === state.currentView);

  // 지금 채널의 사이드바에 없는 메뉴면(예: SA에서 GFA 전용 메뉴) 성과 대시보드로 되돌린다.
  if (!item || !item.channels.includes(state.currentChannel)) {
    item = MENU_ITEMS[0];
    state.currentView = item.id;
  }

  document
    .querySelectorAll(".sidebar-menu-item")
    .forEach((btn) => btn.classList.toggle("active", btn.dataset.viewId === item.id));

  viewOverview.hidden = true;
  viewTrend.hidden = true;
  viewModel.hidden = true;
  viewKeyword.hidden = true;
  viewGrouped.hidden = true;
  viewUpload.hidden = true;
  viewPlaceholder.hidden = true;

  const isGfa = state.currentChannel === "GFA";

  if (item.id === "overview") {
    viewOverview.hidden = false;
    renderOverview();
  } else if (item.id === "trend") {
    viewTrend.hidden = false;
    renderTrendView();
  } else if (item.id === "upload") {
    viewUpload.hidden = false;
    renderUploadView();
  } else if (item.id === "product") {
    viewModel.hidden = false;
    renderModelView();
  } else if (item.naverCampaignType) {
    viewKeyword.hidden = false;
    renderKeywordView(item);
  } else if (item.gfaRawType && isGfa) {
    viewGrouped.hidden = false;
    renderGroupedPerformance(item);
  } else {
    viewPlaceholder.hidden = false;
    placeholderTitle.textContent = item.label;
  }
}

// GFA/SA 둘 다 "데이터 업로드" 메뉴를 쓰므로, 지금 채널에 맞는 업로드 카드 묶음만 보여준다.
function renderUploadView() {
  const isGfa = state.currentChannel === "GFA";

  channelUploadGrids.forEach((grid) => {
    grid.hidden = grid.dataset.channel !== state.currentChannel;
  });

  if (isGfa) {
    uploadViewTitle.textContent = "GFA 데이터 업로드";
    uploadViewIntro.innerHTML =
      '네이버 GFA에서 다운로드한 캠페인/그룹/ADV/소재 리포트 파일을 <b>수정 없이 그대로</b> 올리시면 됩니다. ' +
      '"기간", "캠페인 이름", "노출수", "총비용", "구매완료 수", "구매완료 전환매출액" 같은 원본 헤더를 ' +
      '자동으로 인식합니다 (전환수/전환매출액은 여러 종류 중 <b>구매완료 기준</b>만 사용합니다).';
  } else {
    uploadViewTitle.textContent = "SA 데이터 업로드";
    uploadViewIntro.innerHTML =
      '네이버 검색광고 관리시스템에서 다운로드한 캠페인/그룹/키워드/상품 리포트 파일을 ' +
      '<b>수정 없이 그대로</b> 올리시면 됩니다. 파워링크/쇼핑검색/브랜드검색은 파일을 따로 ' +
      '올릴 필요 없이 <b>"캠페인 유형" 컬럼</b>으로 구분됩니다 (한 파일에 여러 유형이 섞여 있어도 됩니다).';
  }
}

function closeSidebarOnMobile() {
  sidebar.classList.remove("open");
}

menuToggle.addEventListener("click", () => sidebar.classList.toggle("open"));
sidebarBackdrop.addEventListener("click", () => sidebar.classList.remove("open"));

/* ---------------------------------------------------------
   7-1. GFA 그룹별 성과 (캠페인별 / 광고그룹별 / 상품별 공용)
--------------------------------------------------------- */
async function renderGroupedPerformance(item) {
  groupedTitle.textContent = `GFA ${item.label}`;
  groupedNameHeader.textContent = GFA_RAW_TYPE_NAME_LABEL[item.gfaRawType] || "이름";
  groupedTableBody.innerHTML = `<tr><td colspan="9" class="grouped-empty">불러오는 중...</td></tr>`;

  const result = await fetchGfaPerformance(item.gfaRawType);

  // 그 사이에 다른 메뉴로 이동했다면 낡은 응답으로 화면을 덮어쓰지 않는다.
  if (state.currentView !== item.id || state.currentChannel !== "GFA") return;

  if (!result.success) {
    groupedTableBody.innerHTML = `<tr><td colspan="9" class="grouped-empty">${escapeHtml(result.message)}</td></tr>`;
    return;
  }

  if (result.rows.length === 0) {
    groupedTableBody.innerHTML =
      `<tr><td colspan="9" class="grouped-empty">업로드된 GFA 데이터가 없습니다. "데이터 업로드" 메뉴에서 먼저 업로드해주세요.</td></tr>`;
    return;
  }

  groupedTableBody.innerHTML = result.rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${formatWon(row.cost)}</td>
          <td>${formatWon(row.revenue)}</td>
          <td>${row.roas}%</td>
          <td>${formatNumber(row.clicks)}</td>
          <td>${row.ctr.toFixed(2)}%</td>
          <td>${formatNumber(row.conversions)}</td>
          <td>${row.cvr.toFixed(2)}%</td>
          <td>${formatWon(row.cpa)}</td>
        </tr>
      `
    )
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* ---------------------------------------------------------
   7-2. GFA 데이터 업로드 (CSV, raw_type별 3개 폼)
   ---------------------------------------------------------
   네이버 GFA에서 그대로 다운로드한 리포트는 헤더가 한글이고
   ("캠페인 이름", "노출수", "총비용", "구매완료 수", "구매완료 전환매출액" 등),
   전환/매출 관련 컬럼도 여러 종류(총 전환수, 구매완료 수, 회원가입 수...)가
   같이 들어있다. 우리는 그중 "구매완료" 기준만 쓰기로 했으므로, 아래
   GFA_RAW_TYPE_HEADER_ALIASES에서 내부 필드(date/campaign/...)마다
   실제로 올 수 있는 헤더 이름 후보들을 등록해두고, 업로드된 CSV 헤더에서
   그중 하나라도 찾아서 매칭한다. 우리가 만든 템플릿(date, campaign, ...
   영문 헤더)도 계속 지원한다.
--------------------------------------------------------- */
// date는 이 목록에 넣지 않는다 - 아래 parseGfaCsv가 항상 별도로 찾고, CSV에 없으면
// 업로드 폼의 날짜 입력값으로 대신 채운다(네이버 리포트 중에 기간별로 안 나눠서
// 합계만 주는 파일은 "기간" 컬럼 자체가 없는 경우가 있다 - 실제 파일로 확인, 2026-08-26).
const GFA_RAW_TYPE_COLUMNS = {
  campaign: ["campaign", "impressions", "clicks", "cost", "conversions", "revenue"],
  adgroup: ["campaign", "ad_group", "impressions", "clicks", "cost", "conversions", "revenue"],
  adv: ["product", "impressions", "clicks", "cost", "conversions", "revenue"],
  creative: ["creative", "impressions", "clicks", "cost", "conversions", "revenue"],
  // SA 수기 업로드 - GFA와 동일하게 캠페인/그룹/키워드/상품 Raw 4종이다. 파워링크/쇼핑검색/
  // 브랜드검색은 raw_type(=어느 카드에 올렸는지)이 아니라 CSV 안의 campaign_type(캠페인 유형)
  // 컬럼으로 구분하므로, 한 파일에 여러 유형이 섞여 있어도 된다. 네이버 SA_Daily Overview
  // 리포트는 그룹/키워드(검색어) 단위로 내려받으면 캠페인 이름 컬럼 자체가 없다(실제 파일로
  // 확인, 2026-08-21) - 그래서 campaign은 캠페인 Raw에서만 필수이고 그룹/키워드 Raw에서는
  // 선택 컬럼이다.
  sa_campaign: ["campaign_type", "campaign", "impressions", "clicks", "cost", "conversions", "revenue"],
  sa_adgroup: ["campaign_type", "ad_group", "impressions", "clicks", "cost", "conversions", "revenue"],
  sa_keyword: ["campaign_type", "keyword", "impressions", "clicks", "cost", "conversions", "revenue"],
  sa_product: ["product", "impressions", "clicks", "cost", "conversions", "revenue"]
};

// requiredColumns와 달리, CSV에 없어도 업로드 자체는 막지 않는 추가 컬럼
// (campaign은 그룹/키워드 리포트에 없는 게 정상이지만, 있는 파일이 오면 같이 담는다.
//  ad_group은 SA 키워드 리포트에 광고그룹 컬럼이 없는 형태로 다운로드됐을 때를 대비한다).
const GFA_OPTIONAL_COLUMNS = {
  sa_adgroup: ["campaign"],
  sa_keyword: ["campaign", "ad_group"]
};

// 내부 필드명 -> 실제 CSV에 올 수 있는 헤더 이름 후보 (전부 소문자/trim 비교)
// SA 헤더 후보 중 "일별"/"캠페인유형"/"캠페인"/"구매완료 전환수"/"구매완료 전환매출액(원)"은
// 네이버 검색광고 관리시스템의 실제 "SA_Daily Overview" 다운로드 파일로 확인한 것이다
// (2026-08-21). 다른 SA 후보(키워드/광고그룹 등)는 아직 실제 파일로 검증되지 않았다 -
// 업로드가 안 되면 그 CSV의 헤더 줄 그대로 알려주면 후보를 추가해서 바로 잡을 수 있다.
const GFA_HEADER_ALIASES = {
  date: ["date", "기간", "날짜", "일자", "일별"],
  campaign: ["campaign", "캠페인 이름", "캠페인명", "캠페인"],
  // GFA는 캠페인 "목적"(웹사이트 전환 등, 설명용) 표기, SA는 캠페인 "유형"(파워링크/쇼핑검색/
  // 브랜드검색, 페이지 분류용) 표기를 쓴다 - 같은 내부 필드를 공유하되 후보만 늘려둔다.
  campaign_type: ["campaign_type", "캠페인 목적", "캠페인 유형", "캠페인유형"],
  ad_group: ["ad_group", "광고 그룹 이름", "광고그룹 이름", "광고그룹명", "광고그룹"],
  // 네이버 SA_Daily Overview 리포트는 키워드 단위를 "검색어"라고 표기한다 (실제 파일로 확인).
  keyword: ["keyword", "키워드", "키워드 이름", "검색어"],
  product: ["product", "상품명", "상품 이름"],
  creative: ["creative", "소재 이름", "소재명", "소재"],
  impressions: ["impressions", "노출수"],
  clicks: ["clicks", "클릭수"],
  cost: ["cost", "총비용", "비용"],
  // 전환/매출은 종류가 여러 개(총 전환수, 회원가입 수 등) 나오는데
  // GFA는 "구매완료" 기준만 쓰고, SA는 "구매완료 전환수"/"전환수" 표기를 추가로 인식한다.
  conversions: ["conversions", "구매완료 수", "구매완료수", "전환수", "구매완료 전환수"],
  revenue: [
    "revenue",
    "구매완료 전환매출액",
    "구매완료 매출액",
    "구매완료전환매출액",
    "전환매출액",
    "구매완료 전환매출액(원)"
  ]
};

// SA campaign_type 셀 값(파워링크/쇼핑검색/브랜드검색 등)을 서버가 이해하는 코드로 정규화한다.
// 어느 후보와도 안 맞으면 null - 업로드 시점에 오류로 처리한다.
const SA_CAMPAIGN_TYPE_ALIASES = {
  WEB_SITE: ["web_site", "파워링크", "웹사이트"],
  SHOPPING: ["shopping", "쇼핑검색", "쇼핑"],
  // 네이버 SA_Daily Overview 리포트는 브랜드검색을 "브랜드검색/신제품검색" 복합
  // 표기로 내려준다 (2026-08-21 실제 파일로 확인).
  BRAND_SEARCH: ["brand_search", "브랜드검색", "브랜드", "브랜드검색/신제품검색", "신제품검색"]
};

// campaignName은 선택값이다 - 캠페인 유형 값이 후보 목록에 없어도, 캠페인 이름 자체에
// "브랜드검색"이 들어있으면 브랜드검색으로 분류한다(네이버 리포트마다 캠페인 유형
// 표기가 조금씩 달라서 두는 안전장치).
function normalizeSaCampaignType(raw, campaignName) {
  const value = String(raw ?? "").trim().toLowerCase();
  for (const [code, aliases] of Object.entries(SA_CAMPAIGN_TYPE_ALIASES)) {
    if (aliases.includes(value)) return code;
  }
  if (campaignName && String(campaignName).includes("브랜드검색")) {
    return "BRAND_SEARCH";
  }
  return null;
}

const GFA_RAW_TYPE_TEMPLATE_CSV = {
  campaign:
    "date,campaign,campaign_type,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,여름신상프로모션,웹사이트 전환,15200,320,540000,18,3200000\n",
  adgroup:
    "date,campaign,ad_group,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,여름신상프로모션,배너그룹A,15200,320,540000,18,3200000\n",
  adv:
    "date,product,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,ADVoost,15200,320,540000,18,3200000\n",
  creative:
    "date,creative,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,여름신상_소재A,15200,320,540000,18,3200000\n",
  sa_campaign:
    "date,campaign_type,campaign,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,파워링크,여름신상_파워링크,15200,320,540000,18,3200000\n" +
    "2026-08-01,쇼핑검색,여름신상_쇼핑검색,9800,210,310000,9,1200000\n",
  sa_adgroup:
    "date,campaign_type,ad_group,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,파워링크,여름신상_파워링크_그룹A,15200,320,540000,18,3200000\n",
  sa_keyword:
    "date,campaign_type,keyword,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,파워링크,여름원피스,15200,320,540000,18,3200000\n",
  sa_product:
    "date,product,impressions,clicks,cost,conversions,revenue\n" +
    "2026-08-01,여름원피스,15200,320,540000,18,3200000\n"
};

// SA 키워드(검색어) Raw는 검색어 하나하나가 다 행이 되다 보니 4만 행을 넘는 파일도
// 흔해서(2026-08-21 실제 파일로 확인), GFA 원래 한도(2만)보다 넉넉하게 잡는다.
const GFA_MAX_UPLOAD_ROWS = 100000;
const GFA_NUMERIC_FIELDS = ["impressions", "clicks", "cost", "conversions", "revenue"];

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

// "2026.08.17." / "2026.08.17. ~ 2026.08.31." (네이버 "기간" 컬럼) -> "2026-08-17"
// 이미 "2026-08-17" 형식이면 그대로 둔다. 범위로 나오면 시작일을 쓴다.
function normalizeGfaDate(raw) {
  const trimmed = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?/);
  if (match) {
    const [, y, m, d] = match;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return trimmed;
}

function toGfaNumber(raw) {
  const cleaned = String(raw ?? "").replace(/,/g, "").trim();
  return cleaned === "" ? 0 : Number(cleaned);
}

// 네이버에서 다운로드한 CSV는 UTF-8이 아니라 EUC-KR(한글 레거시 인코딩)인 경우가 흔하다
// (예: 엑셀에서 "CSV(쉼표로 분리)"로 저장하면 EUC-KR/CP949로 저장된다). UTF-8로 그냥
// 읽으면 한글이 전부 깨진 문자로 보이고, 그 결과 헤더 인식이 통째로 실패한다.
// UTF-8로 먼저 엄격하게(fatal) 디코딩을 시도해보고, 실패하면(=EUC-KR 바이트열은 대부분
// 올바른 UTF-8이 아니다) EUC-KR로 다시 디코딩한다.
async function readCsvFileAsText(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("euc-kr").decode(buffer);
  }
}

// header(첫 줄) 안에서 후보 이름들 중 하나라도 있는 컬럼의 인덱스를 찾는다.
function findColumnIndex(header, aliases) {
  for (const alias of aliases) {
    const idx = header.indexOf(alias.trim().toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

// 실제 헤더 줄을 찾는다 - 첫 줄부터 순서대로 살펴보다가, 필수 컬럼이 전부 매칭되는
// 첫 번째 줄을 헤더로 쓴다. 네이버 리포트는 보통 헤더가 첫 줄이지만, SA 리포트처럼
// 맨 위에 "SA_Daily Overview(2026.07.01.~2026.08.19.),1903725" 같은 제목 줄이 한
// 줄 더 있는 경우도 있어서(광고주 고객번호까지 같이 들어있다), 최대 5줄까지 훑는다.
const MAX_HEADER_SCAN_LINES = 5;

function findHeaderRow(lines, requiredColumns) {
  let firstAttemptMissing = null;

  for (let i = 0; i < Math.min(MAX_HEADER_SCAN_LINES, lines.length - 1); i++) {
    const header = splitCsvLine(lines[i]).map((h) => h.trim().toLowerCase());
    const columnIndex = {};
    const missing = [];

    requiredColumns.forEach((field) => {
      const idx = findColumnIndex(header, GFA_HEADER_ALIASES[field] || [field]);
      if (idx === -1) {
        missing.push((GFA_HEADER_ALIASES[field] || [field])[0]);
      } else {
        columnIndex[field] = idx;
      }
    });

    if (missing.length === 0) {
      return { rowIndex: i, header, columnIndex };
    }
    if (firstAttemptMissing === null) firstAttemptMissing = missing;
  }

  throw new Error(`CSV에서 다음 컬럼을 찾지 못했습니다: ${firstAttemptMissing.join(", ")}`);
}

// manualDate: "YYYY-MM-DD" - CSV에 날짜(기간) 컬럼이 아예 없는 파일(기간별로 안 나눈
// 합계 리포트 등)일 때, 업로드 폼에서 직접 고른 날짜로 모든 행을 채운다. CSV에 날짜
// 컬럼이 있으면 그 값이 우선이고, manualDate는 무시된다.
function parseGfaCsv(text, requiredColumns, optionalColumns = [], manualDate = null) {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("업로드할 데이터가 없습니다 (헤더 다음 줄부터 데이터가 있어야 합니다).");
  }

  const { rowIndex: headerRowIndex, header, columnIndex } = findHeaderRow(lines, requiredColumns);

  // date는 requiredColumns에 없지만 항상 따로 찾아본다 - CSV에 있으면 그 컬럼을 쓰고,
  // 없으면 manualDate로 대신한다(둘 다 없으면 오류).
  const dateIdx = findColumnIndex(header, GFA_HEADER_ALIASES.date);
  if (dateIdx !== -1) {
    columnIndex.date = dateIdx;
  } else if (!manualDate) {
    throw new Error(
      "이 CSV에는 날짜(기간) 컬럼이 없습니다. 파일 선택 위에서 날짜를 직접 골라주세요."
    );
  }

  // optionalColumns는 없어도 업로드를 막지 않는다 - 있으면 같이 담고, 없으면 그냥 건너뛴다.
  optionalColumns.forEach((field) => {
    const idx = findColumnIndex(header, GFA_HEADER_ALIASES[field] || [field]);
    if (idx !== -1) columnIndex[field] = idx;
  });

  const allFields = ["date", ...requiredColumns, ...optionalColumns];

  return lines.slice(headerRowIndex + 1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};

    allFields.forEach((field) => {
      if (field === "date" && !(field in columnIndex)) {
        row.date = manualDate;
        return;
      }
      if (!(field in columnIndex)) return; // optional인데 이 CSV엔 없는 컬럼

      const cellValue = (cells[columnIndex[field]] ?? "").trim();
      if (field === "date") {
        row.date = normalizeGfaDate(cellValue);
      } else if (GFA_NUMERIC_FIELDS.includes(field)) {
        row[field] = toGfaNumber(cellValue);
      } else {
        row[field] = cellValue;
      }
    });

    return row;
  });
}

// GFA/SA 업로드 폼 전부(8개)에 공통 로직을 붙인다.
document.querySelectorAll("#view-upload .upload-form").forEach((form) => {
  const rawType = form.dataset.rawType;
  const fileInput = form.querySelector(".upload-file-input");
  const dateInput = form.querySelector(".upload-date-input");
  const statusEl = form.closest(".upload-card").querySelector(".upload-status");
  const submitBtn = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const file = fileInput.files[0];
    if (!file) return;

    statusEl.hidden = true;
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = "업로드 중...";

    try {
      const text = await readCsvFileAsText(file);
      const rows = parseGfaCsv(
        text,
        GFA_RAW_TYPE_COLUMNS[rawType],
        GFA_OPTIONAL_COLUMNS[rawType] || [],
        dateInput.value || null
      );

      // SA 캠페인/그룹/키워드 Raw는 campaign_type 셀 값(파워링크/쇼핑검색/브랜드검색 등)을
      // 서버가 쓰는 코드(WEB_SITE/SHOPPING/BRAND_SEARCH)로 미리 정규화해서, 잘못된 값이면
      // 업로드 전에 바로 알려준다.
      if (rawType === "sa_campaign" || rawType === "sa_adgroup" || rawType === "sa_keyword") {
        rows.forEach((row, i) => {
          const normalized = normalizeSaCampaignType(row.campaign_type);
          if (!normalized) {
            throw new Error(
              `${i + 1}번째 행: 캠페인 유형 값("${row.campaign_type}")을 인식하지 못했습니다. ` +
              `파워링크/쇼핑검색/브랜드검색 중 하나로 입력해주세요.`
            );
          }
          row.campaign_type = normalized;
        });
      }

      if (rows.length === 0) {
        throw new Error("업로드할 데이터가 없습니다.");
      }
      if (rows.length > GFA_MAX_UPLOAD_ROWS) {
        throw new Error(`한 번에 최대 ${GFA_MAX_UPLOAD_ROWS}행까지 업로드할 수 있습니다.`);
      }

      const result = await uploadGfaData(rawType, rows);
      if (!result.success) {
        throw new Error(result.message);
      }

      showUploadStatus(
        statusEl,
        `업로드 완료: ${result.inserted}건 저장 (${result.dates_replaced.length}개 날짜 갱신)`,
        "success"
      );
      form.reset();
    } catch (err) {
      showUploadStatus(statusEl, err.message || "업로드 중 오류가 발생했습니다.", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
});

// 업로드 카드 전체를 드롭존으로 써서, 파일을 마우스로 끌어다 놓으면 그 카드 안의
// 파일 입력에 그대로 반영되게 한다 ("파일 선택" 버튼을 꼭 누르지 않아도 되게).
document.querySelectorAll(".upload-dropzone").forEach((zone) => {
  const fileInput = zone.querySelector(".upload-file-input");
  if (!fileInput) return;

  ["dragenter", "dragover"].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
    });
  });

  zone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length > 0) {
      fileInput.files = e.dataTransfer.files;
    }
  });
});

function showUploadStatus(statusEl, message, type) {
  statusEl.textContent = message;
  statusEl.className = `upload-status upload-status-${type}`;
  statusEl.hidden = false;
}

// CSV 템플릿 다운로드 링크 (정적 파일 없이 브라우저에서 즉석으로 생성)
document.querySelectorAll("#view-upload .upload-template-link").forEach((link) => {
  const template = GFA_RAW_TYPE_TEMPLATE_CSV[link.dataset.template];
  if (template) {
    link.href = "data:text/csv;charset=utf-8," + encodeURIComponent(template);
  }
});

/* ---------------------------------------------------------
   8. 유틸
--------------------------------------------------------- */
function formatWon(n) {
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

function formatNumber(n) {
  return n.toLocaleString("ko-KR");
}

function formatPercent(n) {
  return `${n.toFixed(2)}%`;
}

/* ---------------------------------------------------------
   9. 핵심지표(KPI) 계산 / 렌더링
   ---------------------------------------------------------
   저장은 원시 지표(impressions/clicks/cost/conversions/revenue)로만 하고,
   CTR/CPC/CVR/ROAS/CPA는 항상 이 값들로부터 계산한다 (GFA 실데이터,
   SA Mock 데이터 모두 동일한 계산식을 탄다).
--------------------------------------------------------- */
function withDerivedMetrics(totals) {
  const { impressions, clicks, cost, conversions, revenue } = totals;
  return {
    impressions,
    clicks,
    cost,
    conversions,
    revenue,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? cost / clicks : 0,
    cvr: clicks > 0 ? (conversions / clicks) * 100 : 0,
    roas: cost > 0 ? Math.round((revenue / cost) * 100) : 0,
    cpa: conversions > 0 ? Math.round(cost / conversions) : 0
  };
}

const KPI_DEFS = [
  { key: "impressions", label: "노출수", format: formatNumber },
  { key: "clicks", label: "클릭수", format: formatNumber },
  { key: "ctr", label: "클릭률", format: formatPercent },
  { key: "cpc", label: "CPC", format: formatWon },
  { key: "cost", label: "총비용", format: formatWon },
  { key: "conversions", label: "전환수", format: formatNumber },
  { key: "cvr", label: "전환율", format: formatPercent },
  { key: "revenue", label: "전환매출액", format: formatWon },
  { key: "roas", label: "ROAS", format: (n) => `${n}%` },
  { key: "cpa", label: "전환당비용", format: formatWon }
];

function renderKpiCards(current, comparison) {
  kpiGrid.innerHTML = "";
  KPI_DEFS.forEach((def) => {
    const card = document.createElement("div");
    card.className = "kpi-card";
    card.innerHTML = `
      <span class="kpi-label">${def.label}</span>
      <span class="kpi-value">${def.format(current[def.key])}</span>
      ${comparison ? buildDeltaHtml(current[def.key], comparison[def.key]) : ""}
    `;
    kpiGrid.appendChild(card);
  });
}

function buildDeltaHtml(current, previous) {
  if (!previous) {
    return current ? `<span class="kpi-sub up">신규</span>` : "";
  }
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.05) {
    return `<span class="kpi-sub">변동 없음</span>`;
  }
  const direction = change > 0 ? "up" : "down";
  const arrow = change > 0 ? "▲" : "▼";
  const word = change > 0 ? "증가" : "감소";
  return `<span class="kpi-sub ${direction}">${arrow} ${Math.abs(change).toFixed(1)}% ${word}</span>`;
}

function generateDailySeries(baseCost, baseRevenue, days = 14) {
  const labels = [];
  const cost = [];
  const revenue = [];
  const roas = [];

  const endDate = state.analysisPeriod ? new Date(`${state.analysisPeriod.to}T00:00:00`) : new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - i);
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`);

    const noiseA = 0.8 + Math.random() * 0.4;
    const noiseB = 0.8 + Math.random() * 0.4;
    const dailyCost = Math.round((baseCost / days) * noiseA);
    const dailyRevenue = Math.round((baseRevenue / days) * noiseB);

    cost.push(dailyCost);
    revenue.push(dailyRevenue);
    roas.push(dailyCost > 0 ? Math.round((dailyRevenue / dailyCost) * 100) : 0);
  }

  return { labels, cost, revenue, roas };
}

function renderCharts(kpi) {
  const periodDays = state.analysisPeriod
    ? daysBetweenInclusive(state.analysisPeriod.from, state.analysisPeriod.to)
    : 14;
  const chartDays = Math.min(Math.max(periodDays, 1), 60);
  const series = generateDailySeries(kpi.cost, kpi.revenue, chartDays);

  destroyChart("spend");
  destroyChart("revenue");
  destroyChart("roas");

  state.charts.spend = new Chart(document.getElementById("spendChart"), {
    type: "line",
    data: {
      labels: series.labels,
      datasets: [
        {
          label: "광고비",
          data: series.cost,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.1)",
          tension: 0.35,
          fill: true,
          pointRadius: 2
        }
      ]
    },
    options: chartOptions((v) => `${(v / 10000).toFixed(0)}만`)
  });

  state.charts.revenue = new Chart(document.getElementById("revenueChart"), {
    type: "line",
    data: {
      labels: series.labels,
      datasets: [
        {
          label: "광고매출",
          data: series.revenue,
          borderColor: "#16a34a",
          backgroundColor: "rgba(22, 163, 74, 0.1)",
          tension: 0.35,
          fill: true,
          pointRadius: 2
        }
      ]
    },
    options: chartOptions((v) => `${(v / 10000).toFixed(0)}만`)
  });

  state.charts.roas = new Chart(document.getElementById("roasChart"), {
    type: "line",
    data: {
      labels: series.labels,
      datasets: [
        {
          label: "ROAS",
          data: series.roas,
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245, 158, 11, 0.1)",
          tension: 0.35,
          fill: true,
          pointRadius: 2
        }
      ]
    },
    options: chartOptions((v) => `${v}%`)
  });
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    delete state.charts[key];
  }
}

function chartOptions(yTickFormatter) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: "#9aa3b5", font: { size: 11 } }
      },
      y: {
        grid: { color: "#eef0f5" },
        ticks: {
          color: "#9aa3b5",
          font: { size: 11 },
          callback: yTickFormatter
        }
      }
    }
  };
}

/* ---------------------------------------------------------
   10. 초기화 - 유효한 세션이 남아있으면 로그인 화면을 건너뛴다
--------------------------------------------------------- */
(function init() {
  const session = getSession();
  if (session) {
    showDashboard(session.advertiser);
  }
})();
