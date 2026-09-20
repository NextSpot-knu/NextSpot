-- 서울 수집 보충 호출을 하루 두 번꼴로 줄인다 — 인증키 일 호출 한도 1,000회에 맞추기 위해서다.
--
-- 왜: `20260920121000` 은 주 호출(:04/:14/…)과 보충 호출(:09/:19/…)을 **둘 다 10분 주기**로 걸었다.
-- 대상지가 5곳이므로 정상일 때는 주 호출만 돌아 하루 720회(= 144회 × 5곳)로 한도 안이다.
-- 문제는 **나쁜 날**이다: 주 호출이 계속 실패하면 보충 호출이 매 버킷 깨어나 하루 720회를 더 쓴다
-- (합계 1,440회). 그러면 한도를 넘겨 ERROR-337 이 뜨고, 장애가 끝난 뒤에도 **그날 남은 시간 전체**를
-- 수집하지 못한다 — 보충 호출이 고치려던 것보다 더 큰 구멍을 자기가 만든다.
--
-- 그래서 보충 호출만 시간당 2회(:09, :39)로 줄인다. 최악의 날에도 720 + 240 = 960회로 한도 안이다.
-- 주 호출의 10분 주기는 **그대로 둔다** — 버킷 해상도가 검증 지표(30분 전망 오차)의 기반이라
-- 여기를 성기게 하면 표본이 아니라 지표가 무뎌진다.
--
-- 되돌리려면 이 파일의 cron.schedule 두 번째 인자를 '9,19,29,39,49,59 * * * *' 로 바꿔 다시 적용한다.
--
-- ⚠️ 사람이 Supabase SQL Editor 에 붙여넣어 적용한다. 적용 후 확인:
--      SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'nextspot-seoul%';

DO $$
DECLARE
    v_job_id BIGINT;
BEGIN
    FOR v_job_id IN
        SELECT jobid
          FROM cron.job
         WHERE jobname = 'nextspot-seoul-citydata-retry'
    LOOP
        PERFORM cron.unschedule(v_job_id);
    END LOOP;
END;
$$;

-- 같은 함수를 그대로 쓴다(p_only_if_missing = true → 그 버킷에 행이 있으면 외부 호출 없음).
SELECT cron.schedule(
    'nextspot-seoul-citydata-retry',
    '9,39 * * * *',
    $command$SELECT public.request_seoul_citydata_collection(true);$command$
);
