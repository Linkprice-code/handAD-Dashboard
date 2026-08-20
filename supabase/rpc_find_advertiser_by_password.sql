-- =========================================================
-- find_advertiser_by_password
-- advertiser-login Edge Function 전용 RPC.
-- password_hash를 밖으로 꺼내지 않고, DB 내부에서 bcrypt 비교까지 끝낸다.
-- schema.sql 실행 후에 실행할 것.
-- =========================================================

create extension if not exists pgcrypto;

create or replace function find_advertiser_by_password(input_password text)
returns table (id uuid, name text, slug text)
language sql
security invoker
set search_path = public
as $$
  select id, name, slug
  from advertisers
  where active = true
    and password_hash = crypt(input_password, password_hash)
  limit 1;
$$;

-- 기본적으로 함수 생성자는 PUBLIC에 EXECUTE 권한을 부여하므로 명시적으로 회수한다.
-- RLS(advertisers)에 정책이 없어 anon/authenticated로는 이미 조회가 막혀 있지만,
-- 이 함수는 Edge Function의 service_role에서만 호출하도록 이중으로 제한한다.
revoke all on function find_advertiser_by_password(text) from public;
revoke all on function find_advertiser_by_password(text) from anon;
revoke all on function find_advertiser_by_password(text) from authenticated;
grant execute on function find_advertiser_by_password(text) to service_role;
