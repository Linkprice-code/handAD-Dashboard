-- 네이버 SA_Daily Overview 리포트는 그룹/키워드(검색어) 단위로 내려받으면 캠페인 이름
-- 컬럼 자체가 없다(실제 파일로 확인, 2026-08-21). create_sa_manual_raw_tables.sql을 처음
-- 실행했을 때는 campaign을 필수로 뒀는데, 이미 만들어진 테이블이라 not null 제약을 풀어준다.
alter table sa_manual_adgroup_raw alter column campaign drop not null;
alter table sa_manual_keyword_raw alter column campaign drop not null;
