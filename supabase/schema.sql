-- =========================================================
-- ADS PERFORMANCE DASHBOARD - Supabase 스키마
-- advertisers (1) : ad_performance (N)
-- Supabase SQL Editor에 그대로 붙여넣어 실행하세요.
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- advertisers: 광고주 마스터
-- ---------------------------------------------------------
create table if not exists advertisers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text not null unique,
  password_hash     text not null,
  naver_customer_id text,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

comment on column advertisers.password_hash is
  '평문 비밀번호 절대 저장 금지. Edge Function에서 bcrypt 등으로 해시 후 저장/검증.';

-- ---------------------------------------------------------
-- ad_performance: 일별 광고 성과 (캠페인/광고그룹/상품/카테고리 단위)
-- ---------------------------------------------------------
create table if not exists ad_performance (
  id             bigint generated always as identity primary key,
  advertiser_id  uuid not null references advertisers(id) on delete cascade,
  date           date not null,
  campaign       text,
  ad_group       text,
  product        text,
  category       text,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  cost           numeric(14, 2) not null default 0,
  conversions    bigint not null default 0,
  revenue        numeric(14, 2) not null default 0
);

-- 대시보드 조회 패턴(광고주 + 기간, 광고주 + 캠페인 등)에 맞춘 인덱스
create index if not exists idx_ad_performance_advertiser_date
  on ad_performance (advertiser_id, date);

create index if not exists idx_ad_performance_advertiser_campaign
  on ad_performance (advertiser_id, campaign);

-- ---------------------------------------------------------
-- RLS: 프론트엔드(anon key)는 테이블에 직접 접근하지 않고,
-- 전부 Supabase Edge Function(service_role)을 통해서만 조회/검증합니다.
-- 정책을 추가하지 않으면 RLS 활성화 시 anon/authenticated 접근이 기본 차단됩니다.
-- ---------------------------------------------------------
alter table advertisers enable row level security;
alter table ad_performance enable row level security;
