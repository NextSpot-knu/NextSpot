-- =============================================================================
-- NextSpot 미적용 마이그레이션 델타 (2026-07-14 리허설에서 5종 전부 미적용 실증)
-- 적용법: Supabase Dashboard → SQL Editor → 이 파일 전체를 붙여넣고 1회 Run.
-- 순서 보장을 위해 타임스탬프순으로 이어 붙였다. 이미 적용된 항목이 있으면 해당
-- 구간만 오류가 나므로, 그 경우 남은 구간을 개별 실행한다.
-- 미적용 시 데모 영향(실증): simulate-peak 500(source CHECK), 쿠폰 발급 무음 실패
--   (user_coupons.expires_at 부재), 신선도 마커 폴백(app_events 부재), 상세 필드 공백.
-- =============================================================================

-- ─────────────────────────── 20260710170000_add_coupon_expiry.sql ───────────────────────────
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

-- ─────────────────────────── 20260710171000_add_user_report_count.sql ───────────────────────────
-- users.report_count: 혼잡 제보 누적 횟수(제보 보상 게이팅용).
-- 배경: 크라우드소싱 혼잡 제보(POST /api/v1/reports/congestion) 참여를 현물 보상으로 유도한다.
--   제보 3건마다 해당 시설이 제휴(coupon_rate>0)면 쿠폰을 발급(reports 라우터)한다.
-- NOT NULL DEFAULT 0: 기존 사용자도 0 에서 시작(백필 불필요).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS report_count INT NOT NULL DEFAULT 0;

-- ─────────────────────────── 20260710172000_congestion_source_honesty.sql ───────────────────────────
-- congestion_logs.source 정직화 — 실 CCTV/TourAPI 인제스트가 아직 없다(현재 데이터는 전부 합성).
-- 1) source CHECK 제약에 'seed'(시드 합성)·'simulated'(관리자 피크 시뮬)을 추가한다.
-- 2) 데이터 정직화 UPDATE: 실측처럼 보이던 'traffic_cctv'/'tour_api' 라벨(실제로는 전부 시드 합성)을
--    'seed' 로 교정한다. (사용자 제보 'user_report'·관리자 수동 'event' 는 실제 출처라 그대로 둔다.)
--    infrastructures.simulate_peak 는 이제 'simulated' 로 기록한다(코드측 반영).
-- 재실행 안전: DROP CONSTRAINT IF EXISTS 후 재생성. UPDATE 는 제약 해제 상태에서 수행해 순서 무관.

ALTER TABLE public.congestion_logs DROP CONSTRAINT IF EXISTS congestion_logs_source_check;

UPDATE public.congestion_logs
   SET source = 'seed'
 WHERE source IN ('traffic_cctv', 'tour_api');

ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_source_check
    CHECK (source IN ('traffic_cctv', 'tour_api', 'event', 'user_report', 'seed', 'simulated'));

-- ─────────────────────────── 20260710173000_add_app_events.sql ───────────────────────────
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

-- ─────────────────────────── 20260713090000_add_detail_common_fields.sql ───────────────────────────
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
