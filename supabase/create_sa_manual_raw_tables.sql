-- =========================================================
-- SA(네이버 검색광고) 수기 업로드 원시 데이터 테이블 2종
-- ---------------------------------------------------------
-- API 자동 동기화(sa-sync, sa_campaign_daily/sa_product_daily) 대신, 네이버 검색광고
-- 관리시스템에서 다운로드한 리포트 CSV를 수기로 업로드해서 채우는 이 사이트 전용 테이블이다.
-- 기존 자동 동기화 테이블과 이름이 겹치지 않도록 sa_manual_ 접두사를 쓴다
-- (자동 동기화 Cron이 그 테이블을 매일 delete-then-insert로 덮어쓰기 때문에,
--  같은 테이블을 쓰면 수기로 올린 데이터가 다음 날 사라진다).
--
-- campaign_type은 CSV 컬럼이 아니라, 업로드 폼(raw_type)에서 고정으로 정해서 넣는다
-- (파워링크/쇼핑검색/브랜드검색 리포트는 네이버에서 애초에 따로 다운로드하기 때문).
--
-- 캠페인별/캠페인 유형별 성과는 별도 캠페인 Raw 테이블 없이 키워드 Raw를 합산해서
-- 만든다(sa-manual-performance) - 키워드 리포트가 그 캠페인의 전체 키워드를 담고 있다는
-- 전제라서, 캠페인 단위 리포트를 따로 올릴 필요가 없다.
--
-- GFA 원시 테이블과 동일하게 advertiser_id + date로 idempotent delete-then-insert 방식이다.
-- 둘 다 RLS를 활성화하고 정책은 추가하지 않는다
-- (sa-manual-upload / sa-manual-performance Edge Function의 service_role을 통해서만 읽고 쓴다).
-- =========================================================

-- 키워드 Raw (파워링크 / 쇼핑검색 / 브랜드검색 공통 - 캠페인/캠페인 유형별 집계의 원천이기도 하다)
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
