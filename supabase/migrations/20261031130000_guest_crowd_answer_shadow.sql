-- 게스트 방문 확인 체감 혼잡 — 그림자 모드(D3, docs/PRODUCT_EVALUATION_PLAN.md §6 A3' 답).
--
-- 문제: 방문 확인의 체감 혼잡(recommendation_outcomes.observed_congestion)은 project_outcome_congestion_log
--   트리거(20260820123000)가 congestion_logs 의 user_report 로 옮기고, correlate_congestion_report_evidence 가
--   30분 안의 서로 다른 계정 둘이 일치하면 corroborated 로 올린다. 게스트(익명 세션)는 브라우저·시크릿 창마다
--   공짜로 생기므로 한 사람이 게스트 둘로 '두 사람의 일치'를 꾸밀 수 있었다(10-30 에 명시 제보를 막은 이유와 같다).
--
-- 결정(10-31): 게스트 답은 **받되**, 2주 그림자 모드 동안은 실시간 판정에 넣지 않는다. 숫자를 보고 켠다.
--   · 그림자(기본): 답은 방문 결과 행에 '게스트 답' 표시와 함께 남는다. congestion_logs 로 옮기지 않으므로
--     지도·추천 순위·corroborated 판정·쿠폰 보상 어디에도 들어가지 않는다. 로그인 사용자는 이전과 같다.
--   · 실시간(API GUEST_CROWD_ANSWERS_LIVE=true 일 때만): 게스트 답도 user_report 가 되지만, 게스트가 낀 일치는
--     '서로 다른 네트워크 둘 이상' 또는 '로그인 사용자·실측 하나 이상'이 있어야 corroborated 가 된다.
--     로그인 사용자끼리의 일치 규칙은 그대로다.
--
-- 게스트 판정 — **DB 가 auth.users.is_anonymous 로 직접 본다**(API 가 넘기는 값을 믿지 않는다).
--   · API 의 JWT is_anonymous 와 같은 근거이고(Supabase 가 둘을 같이 관리한다), 이 트리거는 RPC 말고 다른 경로가
--     observed_congestion 을 써도 똑같이 걸린다.
--   · 마이그레이션과 API 배포 순서에 묶이지 않는다 — 구 API(이 열을 모름)가 그대로 돌아도 게스트 답은 그림자로 간다.
--   · auth.users 행이 없으면(정상 경로에서는 없다) 게스트로 본다 — 모르면 실시간에 넣지 않는 쪽이 안전하다.
--   · 판정은 답한 그 순간에 한 번 하고 observed_answer_mode 에 남긴다. 나중에 게스트가 계정을 만들거나
--     merge_guest_account_data 로 계정에 합쳐져도 '그때 게스트로 답했다'는 기록은 바뀌지 않는다.
--
-- 네트워크 키 — observed_network_hash / congestion_logs.reporter_network_hash
--   · API 가 IPv4 /24 · IPv6 /64 대역을 서버 비밀값으로 HMAC 한 32자 hex 만 넘긴다(app/core/network_key.py).
--     원본 IP 는 DB 에 들어오지 않는다. 게스트 답에만 남기고 로그인 사용자 답에서는 트리거가 지운다.
--   · 쓰는 곳: 그림자 측정(같은 네트워크에서 여러 게스트가 답하는지)과, 실시간 모드의 '서로 다른 네트워크 둘' 규칙.
--   · 보관: 30일. 아래 pg_cron 이 매일 지난 값을 NULL 로 지운다(답 자체는 남는다).
--   · 브라우저 공개: congestion_logs 는 컬럼 GRANT 라 새 컬럼은 비공개다(20260905090000). recommendation_outcomes 는
--     본인 행 SELECT 정책이 있어 본인은 자기 행의 해시를 볼 수 있다 — 자기 네트워크의 키 해시라 남의 정보가 없다.
--
-- 적용 순서: 이 마이그레이션 → API 배포 순서가 맞다. 반대 순서(API 먼저)도 깨지지 않는다 — API 는 새 RPC 인자를
--   못 찾으면 옛 인자로 다시 부른다(그동안은 오늘과 같은 동작). 구 API + 새 DB 도 무해하다: 새 RPC 는 추가 인자에
--   기본값이 있어 옛 5개 인자 호출을 그대로 받는다.
-- 멱등: 컬럼 IF NOT EXISTS, 함수 CREATE OR REPLACE(시그니처가 바뀌는 RPC 는 DROP 후 생성), 트리거 DROP IF EXISTS 후 생성,
--   cron 은 같은 이름을 먼저 지우고 다시 건다.

-- ── 1. 방문 결과: 답의 출처 표시 · 답한 시각 · 네트워크 키 ─────────────────────────────────────────
ALTER TABLE public.recommendation_outcomes
    ADD COLUMN IF NOT EXISTS observed_answer_mode TEXT
        CHECK (observed_answer_mode IN ('registered', 'guest_shadow', 'guest_live')),
    ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS observed_network_hash TEXT
        CHECK (observed_network_hash ~ '^[0-9a-f]{32}$');

COMMENT ON COLUMN public.recommendation_outcomes.observed_answer_mode IS
    '체감 혼잡 답의 출처(20261031130000): registered=계정 사용자(실시간 반영), guest_shadow=게스트(저장만, 실시간 판정 제외), '
    'guest_live=게스트(GUEST_CROWD_ANSWERS_LIVE 로 실시간 반영). NULL 은 이 마이그레이션 전의 답이거나 답이 없는 행.';
COMMENT ON COLUMN public.recommendation_outcomes.observed_network_hash IS
    '게스트 답의 네트워크 키 — IPv4 /24 · IPv6 /64 대역의 HMAC(서버 비밀값) 32자. 원본 IP 아님. 30일 뒤 NULL(pg_cron).';

CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_observed_at
    ON public.recommendation_outcomes (observed_at DESC)
    WHERE observed_answer_mode IS NOT NULL;

-- ── 2. 혼잡 로그: 게스트 출처 · 네트워크 키(실시간 모드에서만 채워진다) ───────────────────────────
ALTER TABLE public.congestion_logs
    ADD COLUMN IF NOT EXISTS reporter_is_guest BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS reporter_network_hash TEXT
        CHECK (reporter_network_hash ~ '^[0-9a-f]{32}$');
-- 브라우저 GRANT 는 주지 않는다 — 공개 컬럼 7개(20260905090000)만 보인다.

-- ── 3. 혼잡 단계 띠(한산·보통·혼잡) — 3단계 답과 연속 실측값을 같은 눈금으로 비교한다 ───────────────
-- 사용자 답은 0.2·0.5·0.8 이고 실측은 0~1 연속값이다. 경계 0.35·0.65 는 세 값의 중간점이다.
CREATE OR REPLACE FUNCTION public.congestion_level_band(p_level DOUBLE PRECISION)
RETURNS SMALLINT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE
        WHEN p_level IS NULL THEN NULL
        WHEN p_level < 0.35 THEN 0
        WHEN p_level < 0.65 THEN 1
        ELSE 2
    END::SMALLINT;
$$;

-- ── 4. 답 분류(BEFORE) — 게스트인지 DB 가 정하고, 실시간 요청은 게스트에게만 의미가 있다 ─────────────
CREATE OR REPLACE FUNCTION public.classify_outcome_congestion_answer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_anonymous BOOLEAN;
BEGIN
    IF NEW.observed_congestion IS NULL THEN
        NEW.observed_answer_mode := NULL;
        NEW.observed_network_hash := NULL;
        NEW.observed_at := NULL;
        RETURN NEW;
    END IF;

    -- 이미 받은 답은 다시 분류하지 않는다(멱등 재요청 · 다른 필드 갱신).
    IF TG_OP = 'UPDATE' AND OLD.observed_congestion IS NOT NULL THEN
        NEW.observed_answer_mode := OLD.observed_answer_mode;
        NEW.observed_network_hash := OLD.observed_network_hash;
        NEW.observed_at := OLD.observed_at;
        RETURN NEW;
    END IF;

    SELECT u.is_anonymous INTO v_is_anonymous FROM auth.users AS u WHERE u.id = NEW.user_id;
    NEW.observed_at := timezone('utc', now());
    IF NOT COALESCE(v_is_anonymous, true) THEN
        NEW.observed_answer_mode := 'registered';
        NEW.observed_network_hash := NULL;  -- 계정 사용자의 네트워크 키는 남기지 않는다(최소 수집)
    ELSIF NEW.observed_answer_mode IS DISTINCT FROM 'guest_live' THEN
        -- 실시간은 호출자(RPC)가 GUEST_CROWD_ANSWERS_LIVE 로 명시 요청했을 때만. 그 밖에는 전부 그림자.
        NEW.observed_answer_mode := 'guest_shadow';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.classify_outcome_congestion_answer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS classify_outcome_congestion_answer ON public.recommendation_outcomes;
CREATE TRIGGER classify_outcome_congestion_answer
    BEFORE INSERT OR UPDATE OF observed_congestion ON public.recommendation_outcomes
    FOR EACH ROW EXECUTE FUNCTION public.classify_outcome_congestion_answer();

-- ── 5. 혼잡 로그 투영(AFTER) — 그림자 답은 건너뛴다 ─────────────────────────────────────────────
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

DROP TRIGGER IF EXISTS project_outcome_congestion_log ON public.recommendation_outcomes;
CREATE TRIGGER project_outcome_congestion_log
    AFTER INSERT OR UPDATE OF observed_congestion ON public.recommendation_outcomes
    FOR EACH ROW EXECUTE FUNCTION public.project_outcome_congestion_log();

-- ── 6. 교차검증 — 로그인 사용자끼리는 그대로, 게스트가 끼면 네트워크·실측 조건을 더한다 ───────────────
CREATE OR REPLACE FUNCTION public.correlate_congestion_report_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    matching_users INTEGER;
    registered_users INTEGER;
    guest_networks INTEGER;
    measured_agrees BOOLEAN;
BEGIN
    IF NEW.source <> 'user_report' OR NEW.reporter_user_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT count(DISTINCT reporter_user_id),
           count(DISTINCT reporter_user_id) FILTER (WHERE NOT reporter_is_guest),
           count(DISTINCT reporter_network_hash) FILTER (WHERE reporter_is_guest)
      INTO matching_users, registered_users, guest_networks
      FROM public.congestion_logs
     WHERE facility_id = NEW.facility_id
       AND source = 'user_report'
       AND reporter_user_id IS NOT NULL
       AND timestamp BETWEEN NEW.timestamp - interval '30 minutes' AND NEW.timestamp + interval '30 minutes'
       AND abs(congestion_level - NEW.congestion_level) <= 0.05;
    IF matching_users < 2 THEN
        RETURN NEW;
    END IF;

    -- 게스트만으로 된 일치: 서로 다른 네트워크 둘 이상이거나, 같은 단계의 실측이 30분 안에 있어야 한다.
    -- (게스트 + 로그인 사용자 하나 이상, 또는 로그인 사용자끼리는 예전 규칙 그대로 통과한다.)
    IF registered_users = 0 AND guest_networks < 2 THEN
        SELECT EXISTS (
            SELECT 1
              FROM public.congestion_logs AS m
             WHERE m.facility_id = NEW.facility_id
               AND m.evidence_tier = 'verified'
               AND m.source NOT IN ('user_report', 'admin_override', 'seed', 'simulated')
               AND m.timestamp BETWEEN NEW.timestamp - interval '30 minutes' AND NEW.timestamp + interval '30 minutes'
               AND public.congestion_level_band(m.congestion_level) = public.congestion_level_band(NEW.congestion_level)
        ) INTO measured_agrees;
        IF NOT measured_agrees THEN
            RETURN NEW;
        END IF;
    END IF;

    UPDATE public.congestion_logs
       SET evidence_tier = 'corroborated'
     WHERE facility_id = NEW.facility_id
       AND source = 'user_report'
       AND timestamp BETWEEN NEW.timestamp - interval '30 minutes' AND NEW.timestamp + interval '30 minutes'
       AND abs(congestion_level - NEW.congestion_level) <= 0.05;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS correlate_congestion_report_evidence ON public.congestion_logs;
CREATE TRIGGER correlate_congestion_report_evidence
    AFTER INSERT ON public.congestion_logs
    FOR EACH ROW EXECUTE FUNCTION public.correlate_congestion_report_evidence();

-- ── 7. 방문 결과 RPC — 네트워크 키 · 실시간 요청을 받는다(추가 인자는 기본값이 있어 옛 호출도 그대로) ──
DROP FUNCTION IF EXISTS public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.record_recommendation_outcome(
    p_recommendation_id UUID,
    p_user_id UUID,
    p_stage TEXT,
    p_rating TEXT DEFAULT NULL,
    p_observed_congestion TEXT DEFAULT NULL,
    p_network_hash TEXT DEFAULT NULL,
    p_guest_answer_live BOOLEAN DEFAULT false
)
RETURNS public.recommendation_outcomes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    rec_owner UUID;
    current_row public.recommendation_outcomes;
    server_now TIMESTAMPTZ := timezone('utc', now());
    -- 실시간 '요청'일 뿐이다 — 게스트가 아니면 분류 트리거가 registered 로 덮는다.
    requested_mode TEXT := CASE WHEN COALESCE(p_guest_answer_live, false) THEN 'guest_live' END;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    IF p_stage NOT IN ('navigation_started', 'arrival_confirmed', 'rated') THEN
        RAISE EXCEPTION 'invalid outcome stage' USING ERRCODE = '22023';
    END IF;
    IF p_stage = 'rated' AND p_rating NOT IN ('up', 'down') THEN
        RAISE EXCEPTION 'rating required for rated stage' USING ERRCODE = '22023';
    END IF;
    IF p_stage <> 'rated' AND p_rating IS NOT NULL THEN
        RAISE EXCEPTION 'rating is only valid for rated stage' USING ERRCODE = '22023';
    END IF;
    IF p_observed_congestion IS NOT NULL
       AND p_observed_congestion NOT IN ('quiet', 'normal', 'busy') THEN
        RAISE EXCEPTION 'invalid observed congestion' USING ERRCODE = '22023';
    END IF;
    IF p_network_hash IS NOT NULL AND p_network_hash !~ '^[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'invalid network hash' USING ERRCODE = '22023';
    END IF;

    SELECT user_id INTO rec_owner
      FROM public.recommendations
     WHERE id = p_recommendation_id;
    IF rec_owner IS NULL THEN
        RAISE EXCEPTION 'recommendation not found' USING ERRCODE = 'P0002';
    END IF;
    IF rec_owner <> p_user_id THEN
        RAISE EXCEPTION 'recommendation owner mismatch' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO current_row
      FROM public.recommendation_outcomes
     WHERE recommendation_id = p_recommendation_id
     FOR UPDATE;

    IF current_row.recommendation_id IS NULL THEN
        IF p_stage <> 'navigation_started' THEN
            RAISE EXCEPTION 'navigation_started must be recorded first' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.recommendation_outcomes (
            recommendation_id, user_id, navigation_started_at
        ) VALUES (p_recommendation_id, p_user_id, server_now)
        RETURNING * INTO current_row;
        RETURN current_row;
    END IF;

    IF p_stage = 'arrival_confirmed' AND current_row.arrival_confirmed_at IS NULL THEN
        UPDATE public.recommendation_outcomes
           SET arrival_confirmed_at = server_now, updated_at = server_now
         WHERE recommendation_id = p_recommendation_id
         RETURNING * INTO current_row;
    ELSIF p_stage = 'rated' THEN
        IF current_row.arrival_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'arrival_confirmed must be recorded first' USING ERRCODE = '22023';
        END IF;
        IF current_row.rated_at IS NULL THEN
            UPDATE public.recommendation_outcomes
               SET rated_at = server_now,
                   rating = p_rating,
                   observed_congestion = p_observed_congestion,
                   observed_answer_mode = requested_mode,
                   observed_network_hash = p_network_hash,
                   updated_at = server_now
             WHERE recommendation_id = p_recommendation_id
             RETURNING * INTO current_row;
        ELSIF current_row.rating = p_rating
              AND current_row.observed_congestion IS NULL
              AND p_observed_congestion IS NOT NULL THEN
            UPDATE public.recommendation_outcomes
               SET observed_congestion = p_observed_congestion,
                   observed_answer_mode = requested_mode,
                   observed_network_hash = p_network_hash,
                   updated_at = server_now
             WHERE recommendation_id = p_recommendation_id
             RETURNING * INTO current_row;
        ELSIF current_row.rating <> p_rating THEN
            RAISE EXCEPTION 'rating cannot be changed' USING ERRCODE = '22023';
        END IF;
    END IF;

    RETURN current_row;
END;
$$;
REVOKE ALL ON FUNCTION public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
    TO service_role;

-- ── 8. 네트워크 키 보관 30일 ─────────────────────────────────────────────────────────────────
-- 답·로그 행은 남기고 키만 지운다. 그림자 측정 창(최대 30일)과 같은 길이다.
CREATE OR REPLACE FUNCTION public.purge_expired_network_hashes()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_outcomes INTEGER;
    v_logs INTEGER;
BEGIN
    UPDATE public.recommendation_outcomes
       SET observed_network_hash = NULL
     WHERE observed_network_hash IS NOT NULL
       AND COALESCE(observed_at, updated_at) < timezone('utc', now()) - interval '30 days';
    GET DIAGNOSTICS v_outcomes = ROW_COUNT;
    UPDATE public.congestion_logs
       SET reporter_network_hash = NULL
     WHERE reporter_network_hash IS NOT NULL
       AND timestamp < timezone('utc', now()) - interval '30 days';
    GET DIAGNOSTICS v_logs = ROW_COUNT;
    RETURN v_outcomes + v_logs;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_network_hashes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_network_hashes() TO service_role;

-- 매일 03:37 KST(18:37 UTC). 재적용해도 같은 이름 예약이 겹치지 않게 먼저 지운다.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
DECLARE
    v_job_id BIGINT;
BEGIN
    FOR v_job_id IN
        SELECT jobid FROM cron.job WHERE jobname = 'nextspot-network-hash-retention'
    LOOP
        PERFORM cron.unschedule(v_job_id);
    END LOOP;
END;
$$;

SELECT cron.schedule(
    'nextspot-network-hash-retention',
    '37 18 * * *',
    $command$SELECT public.purge_expired_network_hashes();$command$
);

-- ── 9. 그림자 측정 집계(관리자 API 전용 — service_role) ─────────────────────────────────────────
-- 숫자만 돌려준다(행·계정·네트워크 키는 밖으로 나가지 않는다). 기간 1~30일(기본 14일, 키 보관 30일을 넘지 않는다).
--   answers                     답 수(registered · guest_shadow · guest_live)
--   guest_accounts              답한 게스트 계정 수
--   agreement.<a>_vs_<b>        {comparable, agree} — a 의 답마다 같은 장소 ±30분 안에서 시각이 가장 가까운 b 하나와
--                               혼잡 단계 띠(congestion_level_band)가 같은가. b: registered = 계정 사용자 user_report
--                               (본인 것 제외 — 계정 사용자 방문 답의 투영분 포함), measured = 실측(verified,
--                               user_report·admin_override·seed·simulated 제외). 기준선으로 계정 사용자 답도 같은 방식으로 잰다.
--   networks                    게스트 답 중 네트워크 키가 있는 수 · 서로 다른 키 수 · 게스트 계정 둘 이상이 쓴 키에서 온 답 수
--                               · 같은 장소·같은 키·30분 안에 다른 게스트 계정과 겹친 답 수(의심 묶음)
CREATE OR REPLACE FUNCTION public.guest_crowd_answer_shadow_metrics(p_days INTEGER DEFAULT 14)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_days INTEGER := LEAST(GREATEST(COALESCE(p_days, 14), 1), 30);
    v_since TIMESTAMPTZ;
    v_result JSONB;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    v_since := timezone('utc', now()) - make_interval(days => v_days);

    WITH answers AS (
        SELECT o.recommendation_id,
               o.user_id,
               o.observed_answer_mode AS mode,
               o.observed_network_hash AS network_hash,
               o.observed_at,
               r.recommended_facility_id AS facility_id,
               public.congestion_level_band(CASE o.observed_congestion
                   WHEN 'quiet' THEN 0.2 WHEN 'normal' THEN 0.5 WHEN 'busy' THEN 0.8 END) AS band
          FROM public.recommendation_outcomes AS o
          JOIN public.recommendations AS r ON r.id = o.recommendation_id
         WHERE o.observed_congestion IS NOT NULL
           AND o.observed_answer_mode IS NOT NULL
           AND o.observed_at >= v_since
    ),
    scored AS (
        SELECT a.*,
               (a.mode <> 'registered') AS is_guest,
               reg.band AS registered_band,
               mea.band AS measured_band
          FROM answers AS a
          LEFT JOIN LATERAL (
              SELECT public.congestion_level_band(c.congestion_level) AS band
                FROM public.congestion_logs AS c
               WHERE c.facility_id = a.facility_id
                 AND c.source = 'user_report'
                 AND NOT c.reporter_is_guest
                 AND c.reporter_user_id IS DISTINCT FROM a.user_id
                 AND c.timestamp BETWEEN a.observed_at - interval '30 minutes' AND a.observed_at + interval '30 minutes'
               ORDER BY abs(extract(epoch FROM c.timestamp - a.observed_at)), c.id
               LIMIT 1
          ) AS reg ON true
          LEFT JOIN LATERAL (
              SELECT public.congestion_level_band(c.congestion_level) AS band
                FROM public.congestion_logs AS c
               WHERE c.facility_id = a.facility_id
                 AND c.evidence_tier = 'verified'
                 AND c.source NOT IN ('user_report', 'admin_override', 'seed', 'simulated')
                 AND c.timestamp BETWEEN a.observed_at - interval '30 minutes' AND a.observed_at + interval '30 minutes'
               ORDER BY abs(extract(epoch FROM c.timestamp - a.observed_at)), c.id
               LIMIT 1
          ) AS mea ON true
    ),
    guest_network_users AS (
        SELECT network_hash, count(DISTINCT user_id) AS accounts
          FROM answers
         WHERE mode <> 'registered' AND network_hash IS NOT NULL
         GROUP BY network_hash
    ),
    clustered AS (
        SELECT count(DISTINCT a1.recommendation_id) AS n
          FROM answers AS a1
          JOIN answers AS a2
            ON a2.facility_id = a1.facility_id
           AND a2.network_hash = a1.network_hash
           AND a2.user_id <> a1.user_id
           AND a2.mode <> 'registered'
           AND abs(extract(epoch FROM a2.observed_at - a1.observed_at)) <= 1800
         WHERE a1.mode <> 'registered'
    )
    SELECT jsonb_build_object(
        'days', v_days,
        'since', v_since,
        'answers', jsonb_build_object(
            'registered', (SELECT count(*) FROM answers WHERE mode = 'registered'),
            'guest_shadow', (SELECT count(*) FROM answers WHERE mode = 'guest_shadow'),
            'guest_live', (SELECT count(*) FROM answers WHERE mode = 'guest_live')
        ),
        'guest_accounts', (SELECT count(DISTINCT user_id) FROM answers WHERE mode <> 'registered'),
        'agreement', jsonb_build_object(
            'guest_vs_registered', (SELECT jsonb_build_object(
                'comparable', count(*) FILTER (WHERE registered_band IS NOT NULL),
                'agree', count(*) FILTER (WHERE registered_band = band)) FROM scored WHERE is_guest),
            'guest_vs_measured', (SELECT jsonb_build_object(
                'comparable', count(*) FILTER (WHERE measured_band IS NOT NULL),
                'agree', count(*) FILTER (WHERE measured_band = band)) FROM scored WHERE is_guest),
            'registered_vs_registered', (SELECT jsonb_build_object(
                'comparable', count(*) FILTER (WHERE registered_band IS NOT NULL),
                'agree', count(*) FILTER (WHERE registered_band = band)) FROM scored WHERE NOT is_guest),
            'registered_vs_measured', (SELECT jsonb_build_object(
                'comparable', count(*) FILTER (WHERE measured_band IS NOT NULL),
                'agree', count(*) FILTER (WHERE measured_band = band)) FROM scored WHERE NOT is_guest)
        ),
        'networks', jsonb_build_object(
            'guest_answers_with_network', (SELECT count(*) FROM answers
                                            WHERE mode <> 'registered' AND network_hash IS NOT NULL),
            'distinct_networks', (SELECT count(*) FROM guest_network_users),
            'answers_from_shared_networks', (SELECT count(*) FROM answers AS a
                                              JOIN guest_network_users AS g ON g.network_hash = a.network_hash
                                             WHERE a.mode <> 'registered' AND g.accounts >= 2),
            'same_place_cluster_answers', (SELECT n FROM clustered)
        )
    ) INTO v_result;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.guest_crowd_answer_shadow_metrics(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guest_crowd_answer_shadow_metrics(INTEGER) TO service_role;

-- 적용 후 SQL Editor 에서 `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1) —
-- 빼먹으면 API 가 새 RPC 인자를 못 찾아 옛 인자로 다시 부른다(그동안 게스트 답은 그림자로 가지만 네트워크 키는 비어 있다).
