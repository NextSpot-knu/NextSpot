-- 인센티브 항(w3) 데이터 — D1 재결정(2026-07-07): '쿠폰 강도 + 수요 재배치 기여' 결합형.
--   incentive = 0.5 × min(1, coupon_rate/0.20) + 0.5 × max(0, 원본혼잡 − 후보 도착시점 예측혼잡)
-- 쿠폰을 0/1 로 두는 대신 제휴 등급(할인율)을 연속값으로 반영하고, InduSpot 에서 검증된
-- 혼잡분산 항을 도착시점 예측 기준으로 유지한다. 산식 구현: apps/api/app/services/spot/score.py,
-- 상수 공유: packages/shared-types/spot.ts (CI 패리티 테스트로 정합 강제).

-- coupon_rate: 제휴 가맹점 할인율 (0.10 = 10%). 0 = 제휴 없음. 상한은 산식에서 20% 캡.
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS coupon_rate DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (coupon_rate >= 0 AND coupon_rate <= 1);

-- 데모용 제휴 가맹점 시드: 핫스팟(첨성대·대릉원 등)이 아닌 '분산 목적지' 위주로 등급을 달리 지정해
-- 쿠폰 강도가 수요 재배치 방향으로 차등 작동하는 모습을 시연한다.
-- (TourAPI 적재 행은 contentid 기준이라 name 매칭 무해 — 기본 0 유지.)
UPDATE public.facilities SET coupon_rate = 0.20 WHERE name IN ('황리단길 한우국밥', '황리단길 공예공방거리');
UPDATE public.facilities SET coupon_rate = 0.15 WHERE name IN ('경주 한정식 다온', '한옥카페 다랑');
UPDATE public.facilities SET coupon_rate = 0.10 WHERE name IN ('월정교', '경주 최부자댁');
