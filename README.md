# handAD-Dashboard

[ads-performance-dashboard](https://github.com/wjdauddba998-code/AD-Dashboard)를 복제해서 만든 자매 사이트입니다.
화면/기능은 원본과 거의 동일하지만, **SA(네이버 검색광고)도 GFA처럼 CSV 수기 업로드**로 데이터를 채웁니다
(원본은 SA를 네이버 검색광고 Open API로 매일 자동 동기화합니다).

## 원본과의 관계

- **Supabase 프로젝트를 원본과 공유**합니다 (`https://agglowdlyduilkjskxyx.supabase.co`).
  `advertisers` 테이블, `advertiser-login` / `gfa-upload` / `gfa-performance` Edge Function을
  그대로 재사용합니다 (이 사이트의 새 Netlify 주소만 그 3개 함수의 CORS 허용 목록에 추가되어 있습니다).
- 원본의 SA 자동 동기화 테이블(`sa_campaign_daily`, `sa_product_daily` 등)과 Edge Function
  (`sa-sync`, `sa-performance`, `sa-keyword-performance`, `sa-product-performance`,
  `sa-product-mapping-upload`)은 이 사이트에서 **전혀 쓰지 않습니다** — 이 사이트는 완전히
  새로운 테이블(`sa_manual_campaign_raw`, `sa_manual_keyword_raw`, `sa_manual_product_raw`)과
  새 Edge Function(`sa-manual-upload`, `sa-manual-performance`)만 씁니다. 이름이 겹치지 않으므로
  원본 사이트의 Cron 자동 동기화가 이 사이트의 수기 업로드 데이터를 덮어쓰는 일은 없습니다.
- 브랜드검색 계약비용 입력 기능(`sa_brand_search_contracts`)은 이번 버전에서는 제외했습니다.

## SA 수기 업로드 구조

"데이터 업로드" 메뉴가 GFA뿐 아니라 SA 채널에서도 나타나며, 파워링크/쇼핑검색/브랜드검색
리포트를 카드별로 구분해서 업로드합니다 (네이버가 애초에 리포트를 유형별로 따로 내려주기 때문에
캠페인 유형은 CSV 컬럼이 아니라 어느 업로드 카드에 올렸는지로 서버에서 정해집니다).

| 업로드 카드 | raw_type | 저장 테이블 |
|---|---|---|
| 파워링크/쇼핑검색/브랜드검색 - 캠페인별 성과 | `sa_powerlink_campaign` / `sa_shopping_campaign` / `sa_brand_campaign` | `sa_manual_campaign_raw` |
| 파워링크/쇼핑검색/브랜드검색 - 키워드별 성과 | `sa_powerlink_keyword` / `sa_shopping_keyword` / `sa_brand_keyword` | `sa_manual_keyword_raw` |
| 쇼핑검색 - 상품별 성과 | `sa_shopping_product` | `sa_manual_product_raw` |

같은 (advertiser, 캠페인 유형, 날짜)로 다시 업로드하면 그 날짜의 기존 데이터만 교체됩니다
(GFA 업로드와 동일한 delete-then-insert 방식).

`sa-manual-performance`가 프론트엔드에 돌려주는 응답 형태는 원본의 `sa-performance` /
`sa-keyword-performance` / `sa-product-performance`와 동일해서, 화면 렌더링 코드는 API
자동 동기화 버전과 거의 그대로 재사용됩니다 (`app.js`의 `fetchSaPerformance` /
`fetchSaKeywordPerformance` / `fetchSaProductPerformance`만 새 엔드포인트를 부르도록 바뀌었습니다).

> **CSV 헤더 인식은 아직 실제 네이버 검색광고 다운로드 파일로 검증되지 않았습니다.**
> `app.js`의 `GFA_HEADER_ALIASES`에 표준적으로 쓰이는 헤더 이름 후보들을 등록해뒀지만,
> 실제 파일의 첫 줄(헤더) 이름과 다르면 업로드가 "컬럼을 찾지 못했습니다" 오류로 실패합니다.
> 실패하면 그 CSV의 헤더 행을 그대로 알려주면 후보를 추가해서 바로잡을 수 있습니다.

## 파일 구조

```
index.html / style.css / app.js        # 원본과 동일한 구조, SA 업로드 카드/로직만 추가
supabase/
  functions/
    advertiser-login/                  # 원본과 공유 (CORS만 이 사이트 주소 추가)
    gfa-upload/, gfa-performance/      # 원본과 공유 (CORS만 이 사이트 주소 추가)
    sa-manual-upload/                  # 신규 - SA CSV 업로드
    sa-manual-performance/             # 신규 - SA 집계 조회
  create_sa_manual_raw_tables.sql      # 신규 - sa_manual_campaign_raw / keyword_raw / product_raw
  (그 외 schema.sql 등은 원본과 공유하는 기존 테이블 정의)
```

## 배포 상태

- [x] `create_sa_manual_raw_tables.sql`을 Supabase SQL Editor에서 실행
- [x] `sa-manual-upload`, `sa-manual-performance` Edge Function 배포
- [x] 원본의 `advertiser-login` / `gfa-upload` / `gfa-performance`의 `ALLOWED_ORIGINS`에
      이 사이트의 Netlify 주소 추가 후 재배포
- [x] GitHub 저장소 생성 & push (https://github.com/wjdauddba998-code/handAD-Dashboard)
- [x] Netlify 새 사이트 연결 & Public 설정 (https://ad-dashboard-hand.netlify.app)
