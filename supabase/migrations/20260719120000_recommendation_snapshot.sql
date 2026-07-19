-- 생성 당시 추천 수치와 검증된 시설 사실을 고정해, 이후 데이터 변경이 설명을 왜곡하지 않게 한다.
ALTER TABLE public.recommendations
    ADD COLUMN IF NOT EXISTS recommendation_snapshot JSONB;

COMMENT ON COLUMN public.recommendations.recommendation_snapshot IS
    '추천 생성 당시 시설 사실·SPOT 점수·순위·도착 상태 스냅샷. 설명 API는 이 값만 사용한다.';
