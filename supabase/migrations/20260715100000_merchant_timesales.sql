-- merchant_timesales: 소상공인 '내 가게 대시보드'(머천트 콘솔) 셀프 타임세일.
-- 배경: 사장님이 직접 15/20/30% 할인율 × 1/2/3시간 지속시간의 한시적 타임세일을 발행/취소할 수 있게 한다.
--   (apps/api/app/routers/merchant.py POST/GET /api/v1/merchant/timesale, /timesale/cancel 이 유일한 쓰기 경로.)
-- ⚠️ 발행이 추천 랭킹(score.py)에 즉시 반영되지는 않는다 — 랭킹 인센티브 연동은 2단계 예정(이번 스코프 아님).
-- 쓰기 경로: FastAPI merchant 라우터(service_role, X-Merchant-Token 가드)만 INSERT/UPDATE(취소) 한다.
--   사장님 프런트(apps/web/app/merchant/*)는 anon 으로 활성 목록만 읽는다(user_coupons 하드닝 스타일 미러).

CREATE TABLE IF NOT EXISTS public.merchant_timesales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    -- 타임세일 할인율(0 초과 ~ 0.5 이하). facilities.coupon_rate(0~1)보다 좁은 상한 —
    -- 셀프서비스 타임세일은 사장님이 직접 발행하므로 남용 방지 캡을 둔다.
    rate NUMERIC NOT NULL CHECK (rate > 0 AND rate <= 0.5),
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    canceled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 활성 타임세일 조회(facility_id + 미취소 + 미만료)용 인덱스.
CREATE INDEX IF NOT EXISTS idx_merchant_timesales_facility ON public.merchant_timesales (facility_id);

-- RLS: user_coupons(20260710130000) 하드닝 스타일 미러 — 읽기는 anon 허용(대시보드/지도 노출용),
--   쓰기(INSERT/UPDATE)는 service_role(FastAPI merchant 라우터) 전용.
ALTER TABLE public.merchant_timesales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_timesales_select_anon ON public.merchant_timesales;
CREATE POLICY merchant_timesales_select_anon ON public.merchant_timesales
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS merchant_timesales_select_authenticated ON public.merchant_timesales;
CREATE POLICY merchant_timesales_select_authenticated ON public.merchant_timesales
    FOR SELECT TO authenticated USING (true);

-- service_role 전체 허용(발행/취소). RLS 우회는 이 신뢰 경로 안에서만 일어난다.
DROP POLICY IF EXISTS merchant_timesales_service_all ON public.merchant_timesales;
CREATE POLICY merchant_timesales_service_all ON public.merchant_timesales
    FOR ALL TO service_role USING (true) WITH CHECK (true);
