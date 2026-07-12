-- app_events: 경량 제품 분석 이벤트(무인증 POST /api/v1/events/track 적재).
-- 배경: 리텐션/퍼널 계측(랜딩 조회·추천 수락·쿠폰 사용 등)을 남길 곳이 없었다.
--   민감정보가 아닌 익명 이벤트만 기록하며 user_id 는 선택(익명 세션 허용, FK 없음 — 경량 로그).
-- 쓰기/읽기 모두 service_role(FastAPI) 전용 — anon/authenticated 정책 부재로 직접 접근을 차단한다.

CREATE TABLE IF NOT EXISTS public.app_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,                                   -- 선택(무인증 트래킹은 NULL). FK 미설정(경량 로그).
    event TEXT NOT NULL,                            -- 이벤트명(<=64자, 애플리케이션에서 상한 검증)
    props JSONB NOT NULL DEFAULT '{}'::jsonb,       -- 부가 속성(<=1KB, 애플리케이션에서 상한 검증)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 최근 이벤트 조회(퍼널/리텐션 분석) 인덱스.
CREATE INDEX IF NOT EXISTS idx_app_events_created_at ON public.app_events (created_at DESC);

ALTER TABLE public.app_events ENABLE ROW LEVEL SECURITY;

-- service_role 전용(insert/select 포함 전체). anon/authenticated 정책 부재 → 직접 접근 거부.
DROP POLICY IF EXISTS app_events_service_all ON public.app_events;
CREATE POLICY app_events_service_all ON public.app_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);
