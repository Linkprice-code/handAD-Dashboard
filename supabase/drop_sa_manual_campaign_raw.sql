-- sa_manual_campaign_raw was created but is no longer used: 캠페인별/캠페인 유형별 성과는
-- sa_manual_keyword_raw를 합산해서 만드는 것으로 구조를 단순화했다 (키워드 리포트가 이미
-- 캠페인 전체 키워드를 담고 있어서, 별도 캠페인 단위 리포트 업로드가 필요 없다).
-- 업로드된 실데이터가 없는 상태에서 내린 결정이라 데이터 손실 없이 바로 지운다.
drop table if exists sa_manual_campaign_raw;
