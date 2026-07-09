-- congestion_logs: timestamp 단독 인덱스 — 관리자 대시보드 timestamp 범위조회 최적화.
-- 대시보드는 facility_id 없이 timestamp 범위로만 조회한다(.gte/.lte/.order('timestamp')).
-- 기존 (facility_id, timestamp DESC) 복합 인덱스는 선두 컬럼이 facility_id 라
-- timestamp 단독 필터를 타지 못해 seq scan + sort 가 발생 → timestamp 단일 btree 로 해소.
CREATE INDEX IF NOT EXISTS idx_congestion_logs_timestamp
ON public.congestion_logs (timestamp DESC);
