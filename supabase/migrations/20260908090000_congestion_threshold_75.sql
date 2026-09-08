-- '혼잡' 등급 경계를 80 → 75 로 맞춘다.
--
-- 왜 지금 필요한가: 이 값은 오랫동안 **아무 데도 연결돼 있지 않았다**(검토목록 6번). 관리자
-- 화면에서 저장은 됐지만 읽는 곳이 없었다. 2026-09-07 에 `GET /api/v1/system/public-settings`
-- 로 관광객 앱에 배선하면서 비로소 화면에 영향을 주기 시작했다.
--
-- 그런데 두 값이 어긋나 있었다:
--   · DB 칼럼 기본값이자 저장된 값  = 80
--   · 프런트에 하드코딩돼 있던 경계 = 0.75  (course/page.tsx, main/page.tsx, 지도 마커·히트맵)
-- 배선을 켜는 순간 경계가 0.75 → 0.80 으로 움직여, 코드는 아무것도 안 바꿨는데 화면의 '혼잡'
-- 판정만 조용히 관대해진다. 사용자가 **75 로 통일**하기로 정했다.
--
-- 행만 고치면 안 되는 이유: 칼럼 DEFAULT 가 80 이라 새로 세팅하는 환경(RESET_AND_SETUP.sql,
-- 로컬·심사용 복제본)은 다시 80 으로 시작한다. 그러면 "환경마다 혼잡 기준이 다르다" 가 되고,
-- 그건 이 지표를 근거로 쓰는 모든 화면의 신뢰를 깎는다. 그래서 **기본값과 현재 행을 함께** 바꾼다.
--
-- 앱 폴백(설정을 못 읽을 때)은 이미 75 다(lib/congestionScale.ts DEFAULT_BUSY_THRESHOLD).
-- 이 마이그레이션이 적용되면 세 값(칼럼 기본값·저장값·앱 폴백)이 전부 75 로 일치한다.

ALTER TABLE public.system_settings
    ALTER COLUMN congestion_threshold SET DEFAULT 75;

-- 저장된 값도 함께 옮긴다. 80 을 의도적으로 골라 둔 환경이 있을 수 있으므로 **80 인 행만**
-- 건드린다(관리자가 이미 다른 값으로 조정해 뒀다면 그 선택을 덮지 않는다).
UPDATE public.system_settings
SET congestion_threshold = 75
WHERE congestion_threshold = 80;
