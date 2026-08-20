-- =========================================================
-- ad_performance에 channel(SA/GFA) 컬럼 추가
-- ---------------------------------------------------------
-- GFA는 네이버 API 연동 전까지 광고주가 원시 데이터를 직접 업로드하고,
-- SA는 추후 네이버 광고 API 연동으로 채워질 예정이라 채널 구분이 필요하다.
-- schema.sql 실행 후 아무 때나 실행 가능하며, 기존 데이터가 없어도 안전하다.
-- =========================================================

alter table ad_performance
  add column if not exists channel text not null default 'SA';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ad_performance_channel_check'
  ) then
    alter table ad_performance
      add constraint ad_performance_channel_check check (channel in ('SA', 'GFA'));
  end if;
end $$;

create index if not exists idx_ad_performance_advertiser_channel_date
  on ad_performance (advertiser_id, channel, date);
