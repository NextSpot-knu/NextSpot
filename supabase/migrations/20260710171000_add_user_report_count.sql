-- users.report_count: 혼잡 제보 누적 횟수(제보 보상 게이팅용).
-- 배경: 크라우드소싱 혼잡 제보(POST /api/v1/reports/congestion) 참여를 현물 보상으로 유도한다.
--   제보 3건마다 해당 시설이 제휴(coupon_rate>0)면 쿠폰을 발급(reports 라우터)한다.
-- NOT NULL DEFAULT 0: 기존 사용자도 0 에서 시작(백필 불필요).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS report_count INT NOT NULL DEFAULT 0;
