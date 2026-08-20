-- =========================================================
-- GFA 소재 Raw 테이블
-- ---------------------------------------------------------
-- 네이버 GFA "소재 리포트"를 캠페인/그룹/ADV Raw와 같은 패턴으로
-- 별도 테이블에 저장한다. RLS를 활성화하고 정책은 추가하지 않는다
-- (gfa-upload / gfa-performance Edge Function의 service_role을 통해서만 읽고 쓴다).
-- =========================================================

create table if not exists gfa_creative_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  date date not null,
  creative text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 2) not null default 0,
  conversions bigint not null default 0,
  revenue numeric(14, 2) not null default 0
);

create index if not exists idx_gfa_creative_raw_advertiser_date
  on gfa_creative_raw (advertiser_id, date);

alter table gfa_creative_raw enable row level security;
