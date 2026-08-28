-- =========================================================
-- SA 상품 매칭 Raw (쇼핑검색 전용) - 소재ID <-> 상품명 매칭표
-- ---------------------------------------------------------
-- 네이버 SA 상품(쇼핑검색) 성과 리포트는 상품명 없이 소재ID("소재")로만 내려온다
-- (2026-08-28 실제 파일 "상품raw.csv"로 확인). 상품명(기본상품명)은 별도의
-- "광고 다운로드 - 소재 목록" 리포트("상품 매칭 raw.csv")에만 있고, 날짜/지표가
-- 없는 스냅샷(현재 소재 목록) 데이터다. 그래서 시계열 성과(sa_manual_product_raw)와
-- 매칭표(이 테이블)를 분리하고, 조회 시 advertiser_id + creative_id로 조인해서
-- 상품명을 붙인다 (sa-manual-performance group_by=product 참고).
--
-- 날짜 개념이 없으므로 재업로드 시 advertiser 전체를 delete-then-insert로
-- 최신 상태로 덮어쓴다(sa-manual-upload의 snapshotOnly 처리 참고).
-- =========================================================

create table if not exists sa_manual_product_match_raw (
  id bigint generated always as identity primary key,
  advertiser_id uuid not null references advertisers(id) on delete cascade,
  creative_id text not null,
  product text not null,
  campaign text,
  ad_group text,
  category text,
  mall_product_id text,
  unique (advertiser_id, creative_id)
);

create index if not exists idx_sa_manual_product_match_raw_advertiser
  on sa_manual_product_match_raw (advertiser_id);

alter table sa_manual_product_match_raw enable row level security;

-- sa_manual_product_raw: 실제 리포트에는 상품명 컬럼이 없다 - product를 creative_id로
-- 교체한다 (2026-08-28 이전까지 이 테이블은 비어 있어 데이터 손실 없이 안전하게 변경 가능,
-- 업로드 시점에 count(*) = 0으로 확인함).
alter table sa_manual_product_raw drop column if exists product;
alter table sa_manual_product_raw add column if not exists creative_id text not null default '';
alter table sa_manual_product_raw alter column creative_id drop default;

create index if not exists idx_sa_manual_product_raw_advertiser_creative
  on sa_manual_product_raw (advertiser_id, creative_id);
