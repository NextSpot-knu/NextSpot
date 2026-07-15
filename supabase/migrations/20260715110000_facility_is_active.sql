-- 폐업·표출중단 자동 감지(2차 기획 1위) — facilities.is_active.
-- scripts/ingest_tourapi.py 의 --sync 스텝이 TourAPI areaBasedSyncList2 의 showflag 를 실측
-- 대조해 이 컬럼을 갱신한다(showflag='0' → false, showflag='1' → true 복구).
--
-- 실측(2026-07-15, areaCode=35+sigunguCode=2=경주, 587건 전수 스캔): showflag 는 문자열
-- '1'(표출)/'0'(비표출) 두 값만 관측됨(제3값 없음) — 판정 로직은 이 두 값 기준으로 확정 구현한다.
--
-- 설계 결정: NOT NULL DEFAULT true. 컬럼 추가 시 기존 행 전부가 DEFAULT 로 자동 backfill 되므로
--   (Postgres ADD COLUMN ... NOT NULL DEFAULT 관례 — coupon_rate 컬럼과 동일 패턴) 별도 UPDATE 문이
--   필요 없고, 백엔드 필터도 null 분기 없이 단순 `.eq('is_active', true)` 로 충분하다.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전 — IF NOT EXISTS).
-- ⚠️ 사람 작업 — 원격 DB 적용 전까지 백엔드 필터/ingest 동기화 스텝은 컬럼 부재(42703)를 감지해
--   필터 없이(또는 갱신 생략) 폴백하도록 구현되어 있다(오탐/500 방지, 정직한 저하).
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 비표출(폐업 추정) 시설 조회/집계용 부분 인덱스 — 활성 다수 대비 비활성은 소수라
-- uq_facilities_contentid 와 동일한 부분 인덱스 관례를 따른다.
CREATE INDEX IF NOT EXISTS idx_facilities_is_active_false
ON public.facilities (is_active) WHERE is_active = false;
