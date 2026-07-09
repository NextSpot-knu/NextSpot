-- user_coupons: 사용자 인센티브 지갑('내 쿠폰함').
-- 배경: SPOT 점수의 w3 인센티브 항은 이미 facilities.coupon_rate(제휴 할인율)을 소비하지만
--   (20260707150000_add_coupon_incentive.sql), 그 값이 고객에게는 보이지 않았다.
--   분산 추천을 '수락'하면 실제 쿠폰이 지갑에 발급되도록 이 테이블로 노출한다.
-- 쓰기 경로: FastAPI /api/v1/coupons/issue (service_role) 만 발급/갱신한다.
--   사용자는 본인 쿠폰만 조회한다(20260707120000_security_hardening.sql 의 하드닝 스타일 미러).

CREATE TABLE IF NOT EXISTS public.user_coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    -- 발급 시점의 제휴 할인율 스냅샷(0.10 = 10%). facilities.coupon_rate 와 동일한 0~1 CHECK.
    coupon_rate DOUBLE PRECISION NOT NULL CHECK (coupon_rate >= 0 AND coupon_rate <= 1),
    status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'used')),
    issued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    used_at TIMESTAMP WITH TIME ZONE,
    -- 한 시설당 사용자 1장 — 재발급은 upsert(on conflict)로 할인율/상태를 갱신한다.
    UNIQUE (user_id, facility_id)
);

-- 본인 쿠폰 목록 조회용 인덱스(내 쿠폰함 = user_id 필터).
CREATE INDEX IF NOT EXISTS idx_user_coupons_user_id ON public.user_coupons (user_id);

-- RLS: 하드닝 스타일 — 읽기는 본인 행만, 쓰기(INSERT/UPDATE)는 service_role(FastAPI) 전용.
--   (anon/authenticated 쓰기 정책 없음 → 발급은 반드시 신뢰 경로를 거친다.)
ALTER TABLE public.user_coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_coupons_select_own ON public.user_coupons;
CREATE POLICY user_coupons_select_own ON public.user_coupons FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- service_role 전체 허용(발급/사용 처리). RLS 우회는 이 신뢰 경로 안에서만 일어난다.
DROP POLICY IF EXISTS user_coupons_service_all ON public.user_coupons;
CREATE POLICY user_coupons_service_all ON public.user_coupons
    FOR ALL TO service_role USING (true) WITH CHECK (true);
