-- 시설 지역 격리 — 서울 시설은 어떤 브라우저 역할에도 보이지 않는다(docs/SEOUL_TESTBED_PLAN.md §6 S3 · §7 A1).
--
-- 왜: S3 에서 서울 시설을 같은 facilities 표에 적재한다. 서울은 내부(개발자) 전용 테스트베드라
--   관광객·게스트·사장님·관제(admin)·심사 계정 화면에는 한 행도 나오면 안 된다. 그런데 관제 화면 약 20곳이
--   facilities·congestion_logs 를 지역 조건 없이 브라우저에서 바로 읽는다. 그래서 화면을 고치는 대신
--   **DB 가 브라우저 역할(anon·authenticated)에게 경주 행만 돌려주게** 한다(설계 B). 내부 서울 화면은
--   역할을 확인하는 API 코드(service_role)만 그린다.
--
-- 무엇을 하나:
--   1) facilities.region TEXT NOT NULL DEFAULT 'gyeongju' — 지금 행과 기존 적재기는 그대로 경주다.
--   2) 서울 좌표 상자(위도 37.41~37.72 · 경도 126.76~127.19)와 region 이 서로를 요구하는 CHECK 두 개.
--      위반 행이 있으면 경고가 아니라 **예외로 멈춘다**(사람 작업 '사전 점검' 쿼리가 0행이어야 한다).
--   3) **새 RESTRICTIVE 정책** facilities_public_region_only — anon·authenticated 는 region='gyeongju' 만.
--      제한 정책은 허용 정책과 AND 로 묶이므로, 옛 마이그레이션(20260602130000 · 20260827140000)을 다시 돌려
--      USING (true) 허용 정책이 되살아나도 서울은 열리지 않는다. 이름이 새것이라 옛 파일이 지우지도 못한다.
--      허용 정책 세 개(select_facilities · anon_select_facilities · admin_all_facilities)에도 같은 조건을 넣는다(두 겹).
--      service_role 은 RLS 를 우회한다(API·적재기).
--   4) 자식 표 6개 트리거 — 경주가 아닌 시설을 가리키는 행을 막는다(P0001 'facility_region_not_public').
--      congestion_logs 는 공개 혼잡 기록이라 서울 행이 들어가면 관제·지도 숫자가 섞인다. 나머지는 브라우저
--      임베드(facilities!...)와 제보·타임세일·가게 소유·사업자 인증 경로를 닫는다.
--   5) 방문 확인 투영(project_outcome_congestion_log)을 경주 시설로 한정 — 20261031130000 본문을 그대로 옮기고
--      facilities 조인에 한 줄만 더했다. 서울 방문 확인의 체감 혼잡 답은 recommendation_outcomes 에만 남고
--      공개 congestion_logs 로 가지 않는다(4 의 트리거에 걸려 500 이 나는 대신 조용히 건너뛴다).
--   6) region 은 바뀌지 않는다(freeze 트리거) — 경주 행이 서울로, 서울 행이 경주로 넘어가는 일이 없다.
--   7) 추천 이력(recommendations · user_feedback) RESTRICTIVE 정책 — 관제(admin·심사 계정)는 '전체 조회' 정책
--      (is_admin_or_dev)으로 남의 추천 행을 읽는다. 개발자의 서울 추천 행에는 시설 이름·구역 이름이 JSON 으로
--      복사돼 있어 facilities 정책이 닿지 않는다. 그래서 본인 행이 아니면 '서울 표시가 없고 + 가리키는 시설이
--      호출자에게 보이는' 행만 남긴다. 경주 행은 언제나 통과한다(시설이 지워져 NULL 이어도).
--   8) 격리 상태 점검 함수 region_isolation_status() — 위 장치가 전부 살아 있을 때만 1. service_role 전용.
--      이 마이그레이션 끝, 서울 적재 사전 점검, 30분마다 도는 region-guard 워크플로가 읽는다.
--   9) 봉쇄 함수 region_guard_contain() — region-guard 가 DB 쪽 깨짐(상태 0 · anon 이 서울 행을 봄)을 찾으면
--      부른다. RLS 를 다시 켜고 위 RESTRICTIVE 정책 세 개를 이 파일과 같은 정의로 다시 만든다(service_role 전용).
--
-- 다른 SQL 쓰기 경로 점검(바꿀 필요 없음): apply_localdata_sync 는 경주 LOCALDATA 출처만 맞춘다 ·
--   record_facility_availability_report 는 /reports/availability 로만 닿고 API 가 지역을 거른다(P0001 → 404) ·
--   시드 INSERT 는 경주 행이다.
--
-- 멱등: 컬럼 IF NOT EXISTS, 제약은 pg_constraint 확인 후 추가, 정책·트리거는 DROP IF EXISTS 후 생성,
--   함수는 CREATE OR REPLACE. 마지막 DO 블록이 격리 완료를 확인하고, 아니면 예외로 멈춘다.
-- ⚠️ 사람이 Supabase SQL Editor 에 붙여넣어 적용한다. 서울 적재 전에 반드시 먼저. 적용 후
--    `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1).

-- ── 1. 지역 컬럼 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.facilities
    ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'gyeongju';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.facilities'::regclass
           AND conname = 'facilities_region_known'
    ) THEN
        ALTER TABLE public.facilities
            ADD CONSTRAINT facilities_region_known CHECK (region IN ('gyeongju', 'seoul'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_facilities_region_active
    ON public.facilities (region, is_active);

COMMENT ON COLUMN public.facilities.region IS
    '서비스 지역(20261101090000). gyeongju = 공개 서비스, seoul = 내부 테스트베드(개발자 전용 — 브라우저 역할에는 '
    'RESTRICTIVE 정책 facilities_public_region_only 가 경주 행만 돌려준다). 한 번 정하면 바뀌지 않는다(freeze 트리거).';

-- ── 2. 서울 좌표 상자 ↔ 지역 CHECK ─────────────────────────────────────────────────────────
-- 서울 상자 안의 시설은 서울이어야 하고, 서울 시설은 서울 상자 안에 있어야 한다. 경주 적재기가 실수로 서울 좌표를
-- 경주로 넣거나, 서울 적재기가 좌표가 틀린 행을 넣는 일을 DB 가 막는다.
-- NOT VALID 로 붙인 뒤 VALIDATE 한다. 위반 행이 남아 있으면 반쯤 걸린 제약을 남기지 않고 **예외로 멈춘다** —
-- VALIDATE 못 한 제약을 그대로 두면 경주 야간 upsert 가 나중에 엉뚱하게 실패한다.
DO $$
DECLARE
    v_violators INTEGER;
BEGIN
    SELECT count(*) INTO v_violators
      FROM public.facilities AS f
     WHERE (f.region <> 'seoul'
            AND f.latitude BETWEEN 37.41 AND 37.72
            AND f.longitude BETWEEN 126.76 AND 127.19)
        OR (f.region = 'seoul'
            AND NOT (f.latitude BETWEEN 37.41 AND 37.72
                     AND f.longitude BETWEEN 126.76 AND 127.19));
    IF v_violators > 0 THEN
        RAISE EXCEPTION 'facilities_seoul_bbox_violation: % row(s) break the Seoul bbox/region rule — fix or hide them first (HANDOVER pre-check)', v_violators
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.facilities'::regclass
           AND conname = 'facilities_seoul_coords_need_seoul_region'
    ) THEN
        ALTER TABLE public.facilities
            ADD CONSTRAINT facilities_seoul_coords_need_seoul_region CHECK (
                region = 'seoul'
                OR NOT (latitude BETWEEN 37.41 AND 37.72 AND longitude BETWEEN 126.76 AND 127.19)
            ) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.facilities'::regclass
           AND conname = 'facilities_seoul_region_needs_seoul_coords'
    ) THEN
        ALTER TABLE public.facilities
            ADD CONSTRAINT facilities_seoul_region_needs_seoul_coords CHECK (
                region <> 'seoul'
                OR (latitude BETWEEN 37.41 AND 37.72 AND longitude BETWEEN 126.76 AND 127.19)
            ) NOT VALID;
    END IF;

    ALTER TABLE public.facilities VALIDATE CONSTRAINT facilities_seoul_coords_need_seoul_region;
    ALTER TABLE public.facilities VALIDATE CONSTRAINT facilities_seoul_region_needs_seoul_coords;
END;
$$;

-- ── 3. 브라우저 역할은 경주 행만 — RESTRICTIVE 정책 + 허용 정책 다시 쓰기 ──────────────────────────
ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;

-- 핵심. 제한 정책은 모든 허용 정책과 AND 로 묶인다. 이 이름은 이전 마이그레이션 어디에도 없다.
DROP POLICY IF EXISTS facilities_public_region_only ON public.facilities;
CREATE POLICY facilities_public_region_only ON public.facilities
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (region = 'gyeongju')
    WITH CHECK (region = 'gyeongju');

-- 두 겹: 허용 정책에도 같은 조건(제한 정책이 사라져도 지금 정책만으로 서울이 닫힌다).
DROP POLICY IF EXISTS select_facilities ON public.facilities;
CREATE POLICY select_facilities ON public.facilities FOR SELECT TO authenticated
    USING (region = 'gyeongju');

DROP POLICY IF EXISTS anon_select_facilities ON public.facilities;
CREATE POLICY anon_select_facilities ON public.facilities FOR SELECT TO anon
    USING (region = 'gyeongju');

DROP POLICY IF EXISTS admin_all_facilities ON public.facilities;
CREATE POLICY admin_all_facilities ON public.facilities FOR ALL TO authenticated
    USING (region = 'gyeongju' AND public.is_admin_or_dev())
    WITH CHECK (region = 'gyeongju' AND public.is_admin_or_dev());

-- ── 4. 자식 표 — 경주가 아닌 시설을 가리키는 행을 막는다 ─────────────────────────────────────────
-- SECURITY DEFINER: 호출자(authenticated)는 RLS 때문에 서울 행을 못 보므로, 함수 소유자 권한으로 region 을 읽는다.
-- facility_id 가 NULL 이거나(사업자 인증 요청은 NULL 허용) 시설이 없으면(FK 가 따로 막는다) 통과시킨다.
CREATE OR REPLACE FUNCTION public.reject_non_public_region_facility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_region TEXT;
BEGIN
    IF NEW.facility_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT f.region INTO v_region FROM public.facilities AS f WHERE f.id = NEW.facility_id;
    IF v_region IS NOT NULL AND v_region <> 'gyeongju' THEN
        RAISE EXCEPTION 'facility_region_not_public' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_non_public_region_facility() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_congestion_logs_public_region ON public.congestion_logs;
CREATE TRIGGER trg_congestion_logs_public_region
    BEFORE INSERT OR UPDATE OF facility_id ON public.congestion_logs
    FOR EACH ROW EXECUTE FUNCTION public.reject_non_public_region_facility();

DROP TRIGGER IF EXISTS trg_facility_source_refs_public_region ON public.facility_source_refs;
CREATE TRIGGER trg_facility_source_refs_public_region
    BEFORE INSERT OR UPDATE OF facility_id ON public.facility_source_refs
    FOR EACH ROW EXECUTE FUNCTION public.reject_non_public_region_facility();

DROP TRIGGER IF EXISTS trg_merchant_timesales_public_region ON public.merchant_timesales;
CREATE TRIGGER trg_merchant_timesales_public_region
    BEFORE INSERT OR UPDATE OF facility_id ON public.merchant_timesales
    FOR EACH ROW EXECUTE FUNCTION public.reject_non_public_region_facility();

DROP TRIGGER IF EXISTS trg_facility_owners_public_region ON public.facility_owners;
CREATE TRIGGER trg_facility_owners_public_region
    BEFORE INSERT OR UPDATE OF facility_id ON public.facility_owners
    FOR EACH ROW EXECUTE FUNCTION public.reject_non_public_region_facility();

DROP TRIGGER IF EXISTS trg_facility_availability_reports_public_region ON public.facility_availability_reports;
CREATE TRIGGER trg_facility_availability_reports_public_region
    BEFORE INSERT OR UPDATE OF facility_id ON public.facility_availability_reports
    FOR EACH ROW EXECUTE FUNCTION public.reject_non_public_region_facility();

-- bvr_insert_own 정책은 로그인 사용자가 아무 facility_id 로나 요청을 넣게 둔다 — 서울 시설 id 는 여기서 막는다.
DROP TRIGGER IF EXISTS trg_business_verification_requests_public_region ON public.business_verification_requests;
CREATE TRIGGER trg_business_verification_requests_public_region
    BEFORE INSERT OR UPDATE OF facility_id ON public.business_verification_requests
    FOR EACH ROW EXECUTE FUNCTION public.reject_non_public_region_facility();

-- ── 5. 방문 확인 투영 — 경주 시설만 공개 혼잡 기록으로 옮긴다 ─────────────────────────────────────
-- 20261031130000_guest_crowd_answer_shadow.sql §5 본문 그대로 + facilities 조인의 `AND f.region = 'gyeongju'` 한 줄.
-- 서울 시설이면 target_facility_id 가 NULL 이 되어 아무것도 넣지 않고 돌아간다(답은 방문 결과 행에 남는다).
-- 트리거는 같은 함수를 가리키므로 다시 만들지 않는다.
CREATE OR REPLACE FUNCTION public.project_outcome_congestion_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_facility_id UUID;
    target_capacity INTEGER;
    normalized_level DOUBLE PRECISION;
    is_guest_answer BOOLEAN;
BEGIN
    -- rated 멱등 재요청이나 다른 필드 갱신으로 동일 관측을 중복 적재하지 않는다.
    IF NEW.observed_congestion IS NULL
       OR (TG_OP = 'UPDATE' AND OLD.observed_congestion IS NOT NULL) THEN
        RETURN NEW;
    END IF;

    -- 게스트 그림자 답은 방문 결과 행에만 남는다 — 지도·추천·corroborated 판정에 들어가지 않는다.
    IF NEW.observed_answer_mode = 'guest_shadow' THEN
        RETURN NEW;
    END IF;
    is_guest_answer := NEW.observed_answer_mode = 'guest_live';

    normalized_level := CASE NEW.observed_congestion
        WHEN 'quiet' THEN 0.2
        WHEN 'normal' THEN 0.5
        WHEN 'busy' THEN 0.8
        ELSE NULL
    END;
    IF normalized_level IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT r.recommended_facility_id, f.capacity
      INTO target_facility_id, target_capacity
      FROM public.recommendations AS r
      JOIN public.facilities AS f ON f.id = r.recommended_facility_id
                                 AND f.region = 'gyeongju'
     WHERE r.id = NEW.recommendation_id;

    IF target_facility_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.congestion_logs (
        facility_id, timestamp, current_count, congestion_level,
        source, evidence_tier, reporter_user_id, origin_outcome_id,
        reporter_is_guest, reporter_network_hash
    ) VALUES (
        target_facility_id,
        COALESCE(NEW.observed_at, NEW.updated_at, timezone('utc', now())),
        round(COALESCE(target_capacity, 0) * normalized_level),
        normalized_level,
        'user_report',
        'single_report',
        NEW.user_id,
        NEW.recommendation_id,
        COALESCE(is_guest_answer, false),
        CASE WHEN is_guest_answer THEN NEW.observed_network_hash END
    ) ON CONFLICT (origin_outcome_id) WHERE origin_outcome_id IS NOT NULL DO NOTHING;

    -- congestion_logs 의 correlate_congestion_report_evidence 트리거가 교차검증(corroborated 승격)을 맡는다.
    RETURN NEW;
END;
$$;

-- ── 6. 지역은 바뀌지 않는다 ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.freeze_facility_region()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF OLD.region IS DISTINCT FROM NEW.region THEN
        RAISE EXCEPTION 'facility_region_immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.freeze_facility_region() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_facilities_freeze_region ON public.facilities;
CREATE TRIGGER trg_facilities_freeze_region
    BEFORE UPDATE OF region ON public.facilities
    FOR EACH ROW EXECUTE FUNCTION public.freeze_facility_region();

-- ── 7. 추천 이력 — 남의 서울 추천 행은 어떤 브라우저 역할에도 보이지 않는다 ──────────────────────────
-- select_recommendations · select_feedback(20260827140000)은 `user_id = auth.uid() OR is_admin_or_dev()` 라 관제
-- 계정이 개발자의 서울 추천 행(스냅샷의 시설 이름 · breakdown 의 구역 이름)을 브라우저에서 바로 읽는다.
-- 제한 정책은 허용 정책과 AND 로 묶인다 — 본인 행이거나, 다음을 모두 만족할 때만 남는다:
--   · 스냅샷에 지역 표시가 없다(API 는 경주가 아닌 추천에만 recommendation_snapshot.region 을 적는다) —
--     서울 시설이 지워져 id 가 NULL 이 돼도 스냅샷의 이름은 이 조건이 막는다.
--   · 가리키는 시설이 호출자에게 보인다(EXISTS 는 호출자의 facilities RLS 로 돈다 → 서울 시설은 안 보인다).
-- 경주 행은 표시가 없고 시설이 보이거나(또는 지워져 NULL) — 관제 숫자는 그대로다.
-- 피드백은 자기 추천 행이 호출자에게 보일 때만(recommendations RLS 를 그대로 따른다).
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recommendations_public_region_only ON public.recommendations;
CREATE POLICY recommendations_public_region_only ON public.recommendations
    AS RESTRICTIVE
    FOR SELECT
    TO anon, authenticated
    USING (
        user_id = auth.uid()
        OR (
            (recommendation_snapshot ->> 'region') IS NULL
            AND (recommended_facility_id IS NULL
                 OR EXISTS (SELECT 1 FROM public.facilities AS f WHERE f.id = recommendations.recommended_facility_id))
            AND (original_facility_id IS NULL
                 OR EXISTS (SELECT 1 FROM public.facilities AS f WHERE f.id = recommendations.original_facility_id))
        )
    );

ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_feedback_public_region_only ON public.user_feedback;
CREATE POLICY user_feedback_public_region_only ON public.user_feedback
    AS RESTRICTIVE
    FOR SELECT
    TO anon, authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.recommendations AS r WHERE r.id = user_feedback.recommendation_id)
    );

-- ── 8. 격리 상태 점검 — 장치가 전부 살아 있을 때만 1 ─────────────────────────────────────────────
-- 상수를 돌려주지 않고 카탈로그를 직접 본다. 누가 옛 마이그레이션을 다시 돌리거나 트리거를 끄거나 투영 함수를
-- 옛 본문으로 덮으면 0 이 된다. region-guard 워크플로가 30분마다 읽고, 0 이면 봉쇄(§9)를 부르고 서울 행을 비활성화한다.
--   · facilities RLS 켜짐
--   · facilities_public_region_only 가 RESTRICTIVE 이고 anon·authenticated 를 덮으며 USING·WITH CHECK 둘 다 지역 조건
--   · 자식 트리거 6개 + freeze 트리거가 있고 꺼져 있지 않음(tgenabled <> 'D'), 올바른 함수를 가리킴
--   · recommendations · user_feedback 의 제한 정책(§7)이 RESTRICTIVE 로 있고 두 표의 RLS 가 켜짐
--   · 방문 확인 투영 본문에 경주 조건이 있음
CREATE OR REPLACE FUNCTION public.region_isolation_status()
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_facilities REGCLASS := to_regclass('public.facilities');
    v_guard_fn REGPROCEDURE := to_regprocedure('public.reject_non_public_region_facility()');
    v_freeze_fn REGPROCEDURE := to_regprocedure('public.freeze_facility_region()');
    v_projection_fn REGPROCEDURE := to_regprocedure('public.project_outcome_congestion_log()');
    v_ok BOOLEAN;
    v_child_triggers INTEGER;
BEGIN
    IF v_facilities IS NULL OR v_guard_fn IS NULL OR v_freeze_fn IS NULL OR v_projection_fn IS NULL THEN
        RETURN 0;
    END IF;

    SELECT c.relrowsecurity INTO v_ok FROM pg_class AS c WHERE c.oid = v_facilities;
    IF NOT COALESCE(v_ok, false) THEN
        RETURN 0;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM pg_policy AS p
         WHERE p.polrelid = v_facilities
           AND p.polname = 'facilities_public_region_only'
           AND NOT p.polpermissive
           AND p.polcmd = '*'
           AND (SELECT array_agg(r.rolname::TEXT) FROM pg_roles AS r WHERE r.oid = ANY (p.polroles))
               @> ARRAY['anon', 'authenticated']
           AND pg_get_expr(p.polqual, p.polrelid) LIKE '%region = ''gyeongju''%'
           AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%region = ''gyeongju''%'
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN 0;
    END IF;

    SELECT count(*) INTO v_child_triggers
      FROM pg_trigger AS t
     WHERE NOT t.tgisinternal
       AND t.tgenabled <> 'D'
       AND t.tgfoid = v_guard_fn::OID
       AND (t.tgrelid, t.tgname) IN (
           (to_regclass('public.congestion_logs')::OID, 'trg_congestion_logs_public_region'::NAME),
           (to_regclass('public.facility_source_refs')::OID, 'trg_facility_source_refs_public_region'::NAME),
           (to_regclass('public.merchant_timesales')::OID, 'trg_merchant_timesales_public_region'::NAME),
           (to_regclass('public.facility_owners')::OID, 'trg_facility_owners_public_region'::NAME),
           (to_regclass('public.facility_availability_reports')::OID, 'trg_facility_availability_reports_public_region'::NAME),
           (to_regclass('public.business_verification_requests')::OID, 'trg_business_verification_requests_public_region'::NAME)
       );
    IF v_child_triggers <> 6 THEN
        RETURN 0;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM pg_trigger AS t
         WHERE t.tgrelid = v_facilities
           AND t.tgname = 'trg_facilities_freeze_region'
           AND NOT t.tgisinternal
           AND t.tgenabled <> 'D'
           AND t.tgfoid = v_freeze_fn::OID
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN 0;
    END IF;

    -- 추천 이력 제한 정책 두 개(§7) — RESTRICTIVE · SELECT · anon·authenticated · 본인 조건과 시설/추천 가시성 조건.
    SELECT count(*) = 2 INTO v_ok
      FROM pg_policy AS p
     WHERE NOT p.polpermissive
       AND p.polcmd = 'r'
       AND (SELECT array_agg(r.rolname::TEXT) FROM pg_roles AS r WHERE r.oid = ANY (p.polroles))
           @> ARRAY['anon', 'authenticated']
       AND (
           (p.polrelid = to_regclass('public.recommendations')
            AND p.polname = 'recommendations_public_region_only'
            AND pg_get_expr(p.polqual, p.polrelid) LIKE '%auth.uid()%'
            AND pg_get_expr(p.polqual, p.polrelid) LIKE '%''region''%'
            AND pg_get_expr(p.polqual, p.polrelid) LIKE '%facilities%')
        OR (p.polrelid = to_regclass('public.user_feedback')
            AND p.polname = 'user_feedback_public_region_only'
            AND pg_get_expr(p.polqual, p.polrelid) LIKE '%auth.uid()%'
            AND pg_get_expr(p.polqual, p.polrelid) LIKE '%recommendations%')
       );
    IF NOT COALESCE(v_ok, false) THEN
        RETURN 0;
    END IF;
    SELECT bool_and(c.relrowsecurity) AND count(*) = 2 INTO v_ok
      FROM pg_class AS c
     WHERE c.oid IN (to_regclass('public.recommendations'), to_regclass('public.user_feedback'));
    IF NOT COALESCE(v_ok, false) THEN
        RETURN 0;
    END IF;

    SELECT position('f.region = ''gyeongju''' IN p.prosrc) > 0 INTO v_ok
      FROM pg_proc AS p
     WHERE p.oid = v_projection_fn;
    IF NOT COALESCE(v_ok, false) THEN
        RETURN 0;
    END IF;

    RETURN 1;
END;
$$;
REVOKE ALL ON FUNCTION public.region_isolation_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.region_isolation_status() TO service_role;

-- ── 9. 봉쇄 — region-guard 가 DB 쪽 깨짐을 찾았을 때 부른다(service_role 전용) ─────────────────────────
-- 서울 행을 is_active=false 로 내려도 행은 facilities 에 남는다. 브라우저 경로(anon 탐침 · 관제 시설 목록)는
-- is_active 로 거르지 않으므로 비활성화만으로는 노출이 멈추지 않는다. 브라우저에서 서울을 가리는 장치는
-- RESTRICTIVE 정책뿐이라, 감시가 그것을 이 파일과 **같은 정의**로 되살린다(테스트가 두 정의가 같은지 잠근다).
-- 트리거·투영 함수 같은 쓰기 쪽 장치는 되살리지 않는다 — 상태가 1 로 돌아오지 않으면 감시가 계속 실패로 알린다.
-- 돌려주는 값: 봉쇄 뒤의 region_isolation_status().
CREATE OR REPLACE FUNCTION public.region_guard_contain()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS facilities_public_region_only ON public.facilities;
    CREATE POLICY facilities_public_region_only ON public.facilities
        AS RESTRICTIVE
        FOR ALL
        TO anon, authenticated
        USING (region = 'gyeongju')
        WITH CHECK (region = 'gyeongju');

    ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS recommendations_public_region_only ON public.recommendations;
    CREATE POLICY recommendations_public_region_only ON public.recommendations
        AS RESTRICTIVE
        FOR SELECT
        TO anon, authenticated
        USING (
            user_id = auth.uid()
            OR (
                (recommendation_snapshot ->> 'region') IS NULL
                AND (recommended_facility_id IS NULL
                     OR EXISTS (SELECT 1 FROM public.facilities AS f WHERE f.id = recommendations.recommended_facility_id))
                AND (original_facility_id IS NULL
                     OR EXISTS (SELECT 1 FROM public.facilities AS f WHERE f.id = recommendations.original_facility_id))
            )
        );

    ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS user_feedback_public_region_only ON public.user_feedback;
    CREATE POLICY user_feedback_public_region_only ON public.user_feedback
        AS RESTRICTIVE
        FOR SELECT
        TO anon, authenticated
        USING (
            user_id = auth.uid()
            OR EXISTS (SELECT 1 FROM public.recommendations AS r WHERE r.id = user_feedback.recommendation_id)
        );

    RETURN public.region_isolation_status();
END;
$$;
REVOKE ALL ON FUNCTION public.region_guard_contain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.region_guard_contain() TO service_role;

-- ── 10. 끝까지 격리됐는지 확인 — 아니면 예외로 멈춘다(반쯤 적용된 상태로 서울 적재가 시작되지 않게) ─────────
DO $$
BEGIN
    IF public.region_isolation_status() <> 1 THEN
        RAISE EXCEPTION 'region isolation incomplete';
    END IF;
END;
$$;

-- 적용 후 SQL Editor 에서 `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1).
