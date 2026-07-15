-- admin_ingest_requests: TourAPI 실시간 키워드 검색 결과의 적재 요청(대기 큐).
-- 배경(2위 실시간 키워드 게이트웨이): 관광객이 지도 검색에서 0건(적재 85곳 밖 POI)을 만나면
--   TourAPI 키워드 검색(searchKeyword2)으로 폴백해 결과를 보여주되, 그 자리에서 즉시
--   facilities 에 적재하지 않고 "다음 배치 추가 요청"만 큐잉한다(운영자 검수 게이트 — 무단 대량
--   적재/오탐 방지). 관리자(admin/infrastructure)가 승인하면 백엔드가 detailCommon2/Intro2 로
--   단건 인제스트한 뒤 이 행을 status='approved' 로 갱신한다.
--   (apps/api/app/routers/search.py 가 유일한 쓰기/갱신 경로.)
--
-- 쓰기는 전부 FastAPI(service_role) 경유:
--   - POST /api/v1/search/ingest-request 는 무인증이지만 service_role 로 INSERT/upsert 한다
--     (라우터 자체의 IP 레이트리밋이 1차 방어선).
--   - GET /api/v1/search/ingest-requests, POST /api/v1/search/ingest-requests/approve 는
--     require_admin(X-Admin-Authorization) 가드 뒤에서 service_role 로 조회/갱신한다.
-- anon/authenticated 직접 접근 정책은 두지 않는다(security_hardening.sql 의 보수적 기본 거부 관례).

CREATE TABLE IF NOT EXISTS public.admin_ingest_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- TourAPI contentid. UNIQUE 제약은 라우터의 upsert(on_conflict='contentid', ignore_duplicates=True)가
    -- "이미 요청된 곳 재요청은 무시"를 DB 레벨에서 보장하는 데 필요하다(중복 요청 방지).
    contentid TEXT NOT NULL UNIQUE,
    name TEXT,
    content_type_id INT,
    -- 익명 요청 허용(무인증 엔드포인트) — FK 미설정(app_events.user_id 와 동일한 경량 로그 관례).
    requested_by UUID,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    approved_at TIMESTAMP WITH TIME ZONE
);

-- 관리자 대기 목록 조회(status='pending' 최신순) 인덱스.
CREATE INDEX IF NOT EXISTS idx_admin_ingest_requests_status_created
    ON public.admin_ingest_requests (status, created_at DESC);

ALTER TABLE public.admin_ingest_requests ENABLE ROW LEVEL SECURITY;

-- service_role 전용(app_events/merchant_timesales 쓰기 정책과 동일 관례).
-- anon/authenticated 정책 부재 → 직접 접근은 기본 거부된다(백엔드 신뢰 경로만 허용).
DROP POLICY IF EXISTS admin_ingest_requests_service_all ON public.admin_ingest_requests;
CREATE POLICY admin_ingest_requests_service_all ON public.admin_ingest_requests
    FOR ALL TO service_role USING (true) WITH CHECK (true);
