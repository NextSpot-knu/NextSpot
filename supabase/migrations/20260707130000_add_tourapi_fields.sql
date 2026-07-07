-- TourAPI 필드 추가 (2026-07-07) — docs/IMPROVEMENT_PLAN.md WS-B-3
-- 한국관광공사 TourAPI 적재(scripts/ingest_tourapi.py)를 위한 **가산적(additive)** 스키마 확장.
--
-- 설계 결정: 테이블명은 `facilities` 를 유지한다. IMPROVEMENT_PLAN 의 facilities→pois 개명은
--   백엔드 .from("facilities")·프론트 참조 전면 수정을 동반하는 침습적 변경이라
--   D2(스키마 소스 오브 트루스) 결정 확정 전까지 보류한다. 본 마이그레이션은 컬럼 추가만 수행.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전 — IF NOT EXISTS).

-- TourAPI 콘텐츠 식별자 (upsert 기준키)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS contentid VARCHAR(20);

-- TourAPI 관광타입 (관광지 12 / 문화시설 14 / 음식점 39)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS contenttypeid INTEGER;

-- 주소(addr1)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS address TEXT;

-- 무장애(barrier-free) 여부 — detailInfo2 기반. NULL = 정보 없음(미상)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS barrier_free BOOLEAN;

-- 대표 이미지(firstimage)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS image_url TEXT;

-- contentid 부분 유니크 인덱스: TourAPI 적재분의 upsert(on_conflict) 기준.
-- 부분(partial) 인덱스로 두어 contentid 가 NULL 인 기존 수동 시드 행들과 공존 가능하게 한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_facilities_contentid
ON public.facilities (contentid) WHERE contentid IS NOT NULL;
