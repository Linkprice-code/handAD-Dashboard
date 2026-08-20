-- =========================================================
-- SA(네이버 검색광고) 수기 업로드 원시 데이터 테이블 4종
-- ---------------------------------------------------------
-- API 자동 동기화(sa-sync, sa_campaign_daily/sa_product_daily) 대신, 네이버 검색광고
-- 관리시스템에서 다운로드한 리포트 CSV를 수기로 업로드해서 채우는 이 사이트 전용 테이블이다.
-- 기존 자동 동기화 테이블과 이름이 겹치지 않도록 sa_manual_ 접두사를 쓴다
-- (자동 동기화 Cron이 그 테이블을 매일 delete-then-insert로 덮어쓰기 때문에,
--  같은 테이블을 쓰면 수기로 올린 데이터가 다음 날 사라진다).
--
-- GFA(캠페인 Raw/그룹 Raw/ADV Raw/소재 Raw)와 동일한 구조로 캠페인/그룹/키워드/상품
-- Raw 4종을 둔다. GFA와 다른 점은 campaign_type(파워링크/쇼핑검색/브랜드검색)이다 - 네이버
-- 리포트 자체는 유형별로 따로 내려받지만, 이 사이트에서는 raw_type이 아니라 CSV 안의
-- campaign_type 컬럼으로 구분해서 한 파일에 여러 유형을 같이 올릴 수 있게 한다(캠페인/그룹/
-- 키워드 Raw 3개는 campaign_type이 필수, 상품 Raw는 쇼핑검색 전용이라 필요 없다).
--
-- GFA 원시 테이블과 동일하게 advertiser_id + date(+ campaign_type)로 idempotent
-- delete-then-insert 방식이다. 넷 다 RLS를 활성화하고 정책은 추가하지 않는다
-- (sa-manual-upload / sa-manual-performance Edge Function의 service_role을 통해서만 읽고 쓴다).
-- =========================================================

-- 캠페인 Raw (파워링크 / 쇼핑검색 / 브랜드검색 공통)
create table if not exists sa_manual_campaign_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  date date not null,
  campaign_type text not null check (campaign_type in ('WEB_SITE', 'SHOPPING', 'BRAND_SEARCH')),
  campaign text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 2) not null default 0,
  conversions bigint not null default 0,
  revenue numeric(14, 2) not null default 0
);

create index if not exists idx_sa_manual_campaign_raw_advertiser_date
  on sa_manual_campaign_raw (advertiser_id, date);

alter table sa_manual_campaign_raw enable row level security;

-- 그룹 Raw (파워링크 / 쇼핑검색 / 브랜드검색 공통)
create table if not exists sa_manual_adgroup_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  date date not null,
  campaign_type text not null check (campaign_type in ('WEB_SITE', 'SHOPPING', 'BRAND_SEARCH')),
  campaign text not null,
  ad_group text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 2) not null default 0,
  conversions bigint not null default 0,
  revenue numeric(14, 2) not null default 0
);

create index if not exists idx_sa_manual_adgroup_raw_advertiser_date
  on sa_manual_adgroup_raw (advertiser_id, date);

alter table sa_manual_adgroup_raw enable row level security;

-- 키워드 Raw (파워링크 / 쇼핑검색 / 브랜드검색 공통)
create table if not exists sa_manual_keyword_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  date date not null,
  campaign_type text not null check (campaign_type in ('WEB_SITE', 'SHOPPING', 'BRAND_SEARCH')),
  campaign text not null,
  ad_group text,
  keyword text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 2) not null default 0,
  conversions bigint not null default 0,
  revenue numeric(14, 2) not null default 0
);

create index if not exists idx_sa_manual_keyword_raw_advertiser_date
  on sa_manual_keyword_raw (advertiser_id, date);

alter table sa_manual_keyword_raw enable row level security;

-- 상품 Raw (쇼핑검색 전용)
create table if not exists sa_manual_product_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  date date not null,
  product text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 2) not null default 0,
  conversions bigint not null default 0,
  revenue numeric(14, 2) not null default 0
);

create index if not exists idx_sa_manual_product_raw_advertiser_date
  on sa_manual_product_raw (advertiser_id, date);

alter table sa_manual_product_raw enable row level security;
