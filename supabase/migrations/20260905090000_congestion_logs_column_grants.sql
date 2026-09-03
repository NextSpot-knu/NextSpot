-- congestion_logs 의 신원 컬럼을 브라우저 역할에서 가린다.
--
-- 문제: 이 표에는 anon·authenticated 대상 `USING (true)` SELECT 정책이 두 개 걸려 있다
-- (20260602130000, 20250523120001). 그 정책들이 쓰일 당시 이 표는 facility_id/timestamp/
-- level/source 뿐이라 실제로 공용 데이터였고, 20260707120000 이 recommendations·user_feedback
-- 에서 anon 읽기를 걷어낼 때도 "공용 데이터라 유지" 라고 명시적으로 남겨 두었다.
--
-- 그 뒤 20260819120000 이 `reporter_user_id` 를, 20260820123000 이 `origin_outcome_id` 를
-- 추가했다. 정책은 다시 검토되지 않았다. 배포된 번들에서 anon 키를 꺼내면
--   /rest/v1/congestion_logs?select=reporter_user_id,facility_id,timestamp
-- 로 **사용자 → 장소 → 분 단위 방문 이력**이 통째로 조회된다. 제보·좌석 방송·도착 확인
-- 세 경로가 전부 이 컬럼을 채운다.
--
-- ── 왜 컬럼 단위 REVOKE 만으로는 안 되는가 ────────────────────────────────
-- PostgreSQL 에서 **테이블 단위 SELECT 가 있으면 컬럼 단위 권한은 검사되지 않는다.**
-- 그래서 `REVOKE SELECT (reporter_user_id) ...` 한 줄만 넣으면 아무 일도 일어나지 않는다
-- (고쳤다고 믿게 되는 쪽이 안 고친 것보다 나쁘다). 테이블 권한을 걷고 공개 컬럼만 다시 준다.
--
-- 행 접근은 기존 RLS 정책이 그대로 담당한다 — 정책은 '어느 행', 이 GRANT 는 '어느 컬럼'이다.
-- service_role 은 RLS 와 컬럼 ACL 을 모두 우회하므로 백엔드 적재·학습 쿼리는 영향이 없다.
--
-- ⚠️ 앞으로 이 표에 컬럼을 추가하면 **기본적으로 브라우저에서 안 보인다.** 화면에 필요한
--    컬럼이면 그때 GRANT 를 함께 넣어야 한다. 번거롭지만 이게 이번 사고의 정확한 반대편이다 —
--    지금까지는 컬럼을 더하면 아무도 모르게 공개됐다.
--
-- 멱등: REVOKE/GRANT 는 반복 실행해도 같은 상태로 수렴한다.

REVOKE SELECT ON public.congestion_logs FROM anon, authenticated;

GRANT SELECT (
    id,
    facility_id,
    timestamp,
    current_count,
    congestion_level,
    source,
    evidence_tier
) ON public.congestion_logs TO anon, authenticated;

-- 가리는 컬럼(부여 목록에 **없다**): reporter_user_id, origin_outcome_id.
