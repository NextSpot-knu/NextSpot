-- =========================================================================
-- 4번째 인프라 카테고리 loading_dock(하역장) → rest_area(휴게 공간) 개명
-- =========================================================================
-- 배경: 서비스의 4개 섹션은 식당/주차장/회의실/휴게 공간이다. 초기 스키마가 4번째를
--       loading_dock 으로 두어 백엔드/프런트/목업이 어긋나 있었다. 이를 rest_area 로 통일한다.
--
-- ML 영향 없음: predict_service.normalize_facility_type 가 rest_area → loading_dock 으로
--       매핑하므로, 기존에 loading_dock 으로 학습된 모델/Vertex Endpoint/BQML 을 재학습하지
--       않고 그대로 사용한다.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행. 재실행해도 안전(idempotent).

-- 1) CHECK 제약을 rest_area 허용으로 교체
ALTER TABLE public.facilities DROP CONSTRAINT IF EXISTS facilities_type_check;
ALTER TABLE public.facilities
  ADD CONSTRAINT facilities_type_check
  CHECK (type IN ('cafeteria', 'parking', 'meeting_room', 'rest_area'));

-- 2) 기존 loading_dock 시설을 휴게 공간으로 전환 + 휴게 amenities 부여
UPDATE public.facilities
SET type = 'rest_area',
    name = CASE
      WHEN name LIKE '%D-1%' THEN '북부 직원 휴게라운지 D-1'
      WHEN name LIKE '%E-2%' THEN '남부 직원 휴게라운지 E-2'
      ELSE replace(replace(name, '물류하역장', '휴게라운지'), '하역장', '휴게라운지')
    END,
    features = '{"massageChairs": {"total": 3, "inUse": 0}, "sleepCapsules": {"total": 2, "inUse": 0}, "playstation": {"total": 1, "inUse": 0}}'::jsonb
WHERE type = 'loading_dock';
