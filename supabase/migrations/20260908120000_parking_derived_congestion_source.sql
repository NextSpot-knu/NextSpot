-- 주차 실측에서 파생한 혼잡 **추정치**에 전용 source 값을 준다.
--
-- 배경: congestion_logs 에는 두 달 동안 실제 현장 관측이 사실상 한 건뿐이다(실측
-- 2026-09-08: 7/02~7/09 시드 덩어리 + 8/21 낱개 1건). 관제 대시보드·히트맵·통계가 통째로
-- 비어 있다. 반면 경주 ITS 공영주차 실측은 살아 있다(area_demand_snapshots, 10분 주기).
-- 시연 마감까지 시설 단위 실시간 데이터를 구할 방법이 없으므로 그 주차 실측에서 구역
-- 혼잡을 계산해 시설별 추정치를 만든다. 산식과 한계는
-- docs/PARKING_DERIVED_CONGESTION.md 와 app/services/parking_derived_congestion_service.py.
--
-- ── 왜 기존 source 에 섞지 않는가 ────────────────────────────────────────────
-- 섞으면 **나중에 골라낼 수 없다.** 이 표는 이미 '측정' 과 '사람의 주장' 과 '데모용 합성'
-- 이 한 칸에 들어와 있고(20260906120000 이 그중 하나를 뒤늦게 갈라냈다), 그때마다 과거
-- 행은 구분할 근거가 없어 손대지 못한 채 남았다. 새 종류를 넣을 때 이름을 따로 주는 것이
-- 그 반복을 끊는 유일한 방법이다.
--
-- ── 추정치가 실측으로 팔리지 않게 하는 세 겹 ─────────────────────────────────
--   1. source='parking_derived'        — 이 마이그레이션.
--   2. evidence_tier='synthetic'       — 적재 코드가 명시적으로 넣는다(컬럼 기본값도 동일).
--   3. scripts/train.py NEVER_TRAINABLE_SOURCES 에 추가 — tier 로 이미 막히지만 두 겹.
--
-- 그래서 이 행들은:
--   · 학습 정답이 되지 않는다 — train.py 는 {verified, corroborated} 만 쓴다.
--   · 추천·지도의 '지금 혼잡' 이 되지 않는다 — 아래 latest_congestion_for_facilities 와
--     app/routers/infrastructures.py::_fetch_latest_one 이 둘 다 tier 허용목록
--     {single_report, corroborated, verified} 로 거른다. 즉 SPOT 점수에 닿지 않는다.
--   · 관리자 대시보드·수집 통계에는 **보인다.** 거기가 이 값을 원한 자리이고, 화면은
--     '주차 실측 기반 추정' 으로 라벨한다.
--
-- ⚠️ 적용 순서: **이 마이그레이션이 백엔드 배포보다 먼저** 가야 한다. 코드가 먼저 나가도
--    서버는 500 이 되지 않는다 — 적재 엔드포인트가 CHECK/NOT NULL 위반을 골라내
--    409 migration_not_applied 로 돌려준다(_is_missing_source_migration). 반대 순서
--    (먼저 적용 + 구 코드)는 완전히 무해하다.
--
-- 기존 행은 건드리지 않는다. 이 마이그레이션은 UPDATE 를 하나도 하지 않는다.
--
-- 멱등: 재실행 가능(제약·인덱스를 이름으로 지우고 다시 만든다).

-- 1) source 허용목록에 새 값 추가.
--    20260906120000 까지의 값을 **전부** 유지한다 — 하나라도 빠지면 그 경로의 INSERT 가 죽는다.
ALTER TABLE public.congestion_logs
    DROP CONSTRAINT IF EXISTS congestion_logs_source_check;
ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_source_check
    CHECK (source IN (
        'traffic_cctv', 'tour_api', 'event', 'user_report', 'merchant_report',
        'admin_override', 'seed', 'simulated', 'parking_derived'
    ));

-- 2) current_count 의 NOT NULL 을 푼다.
--
--    주차 파생 추정치는 **인원수를 모른다.** 주차 점유율에서 사람 수로 가는 환산 계수가
--    없기 때문이다. 기존 경로들처럼 capacity × level 로 채우면 관측한 적 없는 인원수를
--    지어내는 것이고, 이 표에 그런 숫자가 이미 여럿 있다는 것이 문제의 일부다.
--    (읽는 쪽은 이미 NULL 을 다룬다: infrastructures._exact_current_count 는 traffic_cctv
--     가 아니면 애초에 None 을 돌려주고, latest_congestion_for_facilities 의 반환 타입도
--     nullable INT 다. 대시보드 집계는 congestion_level 만 쓴다.)
--
--    기존 행에는 영향이 없다(제약을 푸는 방향이라 재작성도 잠금도 없다).
ALTER TABLE public.congestion_logs
    ALTER COLUMN current_count DROP NOT NULL;

-- 3) 같은 관측을 두 번 넣지 못하게 한다.
--
--    적재 코드가 먼저 확인하지만(_existing_rows_at), 두 관리자가 동시에 누르면 확인과
--    INSERT 사이가 벌어진다. 그때 조용히 두 배로 쌓이면 대시보드 평균이 바뀌지 않아
--    **아무도 눈치채지 못한다.** 부분 인덱스라 다른 source 는 전혀 제약받지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_congestion_logs_parking_derived
    ON public.congestion_logs (facility_id, "timestamp")
    WHERE source = 'parking_derived';

-- 4) 추천·지도의 '지금 혼잡' 조회에서 이 source 를 이름으로도 배제한다.
--
--    tier 필터가 이미 막는다(synthetic 은 허용목록에 없다). 그런데도 이름을 한 겹 더 거는
--    이유는 seed/simulated 를 그렇게 다뤄 왔기 때문이다 — 누군가 나중에 이 행들의 tier 를
--    올리는 순간(오분류든 실수든) 추정치가 추천 순위에 들어간다. 두 겹이면 그 한 번의
--    실수로는 뚫리지 않는다.
--
--    본문은 20260820123000 의 정의를 그대로 옮기고 NOT IN 목록만 늘렸다.
CREATE OR REPLACE FUNCTION public.latest_congestion_for_facilities(facility_ids UUID[])
RETURNS TABLE (
    facility_id UUID,
    congestion_level DOUBLE PRECISION,
    current_count INT,
    "timestamp" TIMESTAMPTZ,
    source VARCHAR,
    evidence_tier TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (c.facility_id)
        c.facility_id, c.congestion_level, c.current_count, c.timestamp, c.source, c.evidence_tier
    FROM public.congestion_logs AS c
    WHERE c.facility_id = ANY(facility_ids)
      AND c.evidence_tier IN ('single_report', 'corroborated', 'verified')
      AND c.source NOT IN ('seed', 'simulated', 'parking_derived')
    ORDER BY c.facility_id, c.timestamp DESC, c.id DESC;
$$;

COMMENT ON CONSTRAINT congestion_logs_source_check ON public.congestion_logs IS
    'parking_derived 는 공영주차 점유율에서 파생한 추정치다. 현장 관측이 아니며 항상 evidence_tier=synthetic 으로 적재된다.';
