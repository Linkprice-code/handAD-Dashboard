-- =========================================================
-- GFA 원시 데이터 테이블 3종 (캠페인 Raw / 그룹 Raw / ADV Raw)
-- ---------------------------------------------------------
-- 네이버 GFA는 캠페인별 / 광고그룹별 / 상품(ADVoost)별 리포트를 각각
-- 별도 파일로 내려주기 때문에, 하나의 테이블에 억지로 합치지 않고
-- 원본 리포트 단위 그대로 테이블 3개로 나눠서 저장한다.
-- 셋 다 RLS를 활성화하고 정책은 추가하지 않는다
-- (gfa-upload / gfa-performance Edge Function의 service_role을 통해서만 읽고 쓴다).
-- =========================================================

-- 캠페인 Raw
create table if not exists gfa_campaign_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  date date not null,
  campaign text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 2) not null default 0,
  conversions bigint not null default 0,
  revenue numeric(14, 2) not null default 0
);

create index if not exists idx_gfa_campaign_raw_advertiser_date
  on gfa_campaign_raw (advertiser_id, date);

alter table gfa_campaign_raw enable row level security;

-- 그룹 Raw
create table if not exists gfa_adgroup_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  date date not null,
  campaign text not null,
  ad_group text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 2) not null default 0,
  conversions bigint not null default 0,
  revenue numeric(14, 2) not null default 0
);

create index if not exists idx_gfa_adgroup_raw_advertiser_date
  on gfa_adgroup_raw (advertiser_id, date);

alter table gfa_adgroup_raw enable row level security;

-- ADV(상품) Raw
create table if not exists gfa_adv_raw (
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

create index if not exists idx_gfa_adv_raw_advertiser_date
  on gfa_adv_raw (advertiser_id, date);

alter table gfa_adv_raw enable row level security;
