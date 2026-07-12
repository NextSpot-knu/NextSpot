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
