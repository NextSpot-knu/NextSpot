-- user_coupons.expires_at: 쿠폰 만료(발급 시각 + 7일).
-- 배경: 발급된 쿠폰이 영구 유효라 인센티브의 '지금 분산하면 이득' 긴급성이 사라졌다.
--   발급 시 만료시각을 못박고, /api/v1/coupons/mine 은 만료를 파생 status('expired')로 노출,
--   /api/v1/coupons/{id}/use 는 만료 쿠폰이면 409 로 거부한다.
-- DB status CHECK 는 issued/used 불변(만료는 애플리케이션 파생) — 이력/제약 단순성 유지.

ALTER TABLE public.user_coupons ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

-- 기존 발급분 백필: issued_at + 7일. (NULL 인 행만 갱신 — 재실행 안전.)
UPDATE public.user_coupons
   SET expires_at = issued_at + interval '7 days'
 WHERE expires_at IS NULL;
