-- =========================================================
-- 신규 광고주 등록: 좋은 것은 이웃과 함께 (handAD-Dashboard 전용, 수기 업로드)
-- ---------------------------------------------------------
-- 로그인 크리덴셜은 naver_customer_id다. password_hash는 직접 넣지 않고,
-- 원본 프로젝트의 sync_password_hash_from_naver_customer_id.sql 트리거가
-- naver_customer_id로부터 자동으로 계산한다 (advertisers 테이블은 공유).
-- =========================================================

insert into advertisers (name, slug, naver_customer_id, active)
values (
  '좋은 것은 이웃과 함께',
  'good-neighbor',
  '2148168',
  true
)
on conflict (slug) do update
  set naver_customer_id = excluded.naver_customer_id,
      active = true;

-- 확인
-- select name, slug, naver_customer_id, active from advertisers where slug = 'good-neighbor';
