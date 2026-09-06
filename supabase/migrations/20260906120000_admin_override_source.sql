-- 관리자 수동 혼잡 개입에 **전용 source 값**을 준다.
--
-- 배경: 관리자 콘솔의 혼잡 슬라이더는 congestion_logs 에 source='event' 로 기록해 왔다.
-- 그런데 마이그레이션 20260819120000 이
--     source IN ('traffic_cctv','tour_api','event') → evidence_tier='verified'
-- 로 백필하며 'event' 를 **운영 검증 소스**로 분류했다. 그래서 source 만 봐서는
-- '측정된 이벤트 관측' 과 '사람이 슬라이더로 넣은 값' 을 구분할 수 없었고, 그 값이
-- scripts/train.py 의 학습 정답으로 들어갔다(7aa7646 에서 tier 를 single_report 로 내려
-- 실질 피해는 먼저 막았다 — 이 마이그레이션은 그 나머지 절반, 이름 정리다).
--
-- 왜 이름까지 정리하나: tier 만 고치면 '이 행이 무엇인지' 는 여전히 로그에서 복원할 수 없다.
-- 나중에 데이터 품질을 따질 때 관리자 개입분을 골라낼 수 없으면 전체 수치를 믿을 수 없다.
--
-- ⚠️ 적용 순서: **이 마이그레이션이 백엔드 배포보다 먼저** 가야 한다. 코드가 먼저 나가면
--    CHECK 위반으로 관리자 오버라이드가 통째로 500 이 된다. 반대 순서(먼저 적용 + 구 코드)는
--    무해하다 — 구 코드는 계속 'event' 를 쓰고 그 값은 여전히 허용된다.
--
-- 기존 행은 건드리지 않는다. 과거의 source='event' 행은 관리자 개입인지 실제 이벤트 관측인지
-- 구분할 근거가 없으므로 **추측해서 다시 쓰지 않는다.** 구분이 되는 것은 이 시점 이후부터다.
--
-- 멱등: 재실행 가능(제약을 이름으로 지우고 다시 만든다).

ALTER TABLE public.congestion_logs
    DROP CONSTRAINT IF EXISTS congestion_logs_source_check;
ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_source_check
    CHECK (source IN (
        'traffic_cctv', 'tour_api', 'event', 'user_report', 'merchant_report',
        'admin_override', 'seed', 'simulated'
    ));

-- 아래 두 곳은 새 값을 **이미 올바르게** 처리하므로 손대지 않는다(확인하고 남긴다):
--   · latest_congestion_for_facilities — source 는 거부목록('seed','simulated')이라 통과하고,
--     tier 허용목록('single_report','corroborated','verified')에도 든다 → 지도·추천에 그대로 반영.
--   · correlate_congestion_report_evidence — source <> 'user_report' 면 즉시 반환하므로
--     관리자 개입이 다른 제보를 corroborated 로 승격시키지 않는다.
