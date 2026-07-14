-- 상세 공통 필드 추가 (2026-07-13) — POI 상세 카드(A2)용 TourAPI detailCommon2 확장.
-- scripts/ingest_tourapi.py --details 가 detailCommon2 응답에서 채우는 **가산적(additive)** 스키마 확장.
--
-- 설계 결정: 전부 nullable TEXT — 실데이터가 있을 때만 저장한다('지어내지 않기' 원칙).
--   detailCommon2 미조회/미제공 행은 NULL 로 남고, 프런트는 값이 있을 때만 조건부 렌더한다.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전 — IF NOT EXISTS).

-- 전화번호(tel)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS phone TEXT;

-- 홈페이지 URL(homepage — anchor HTML 로 오면 href 만 추출해 저장)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS homepage TEXT;

-- 개요/소개 텍스트(overview)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS overview TEXT;
