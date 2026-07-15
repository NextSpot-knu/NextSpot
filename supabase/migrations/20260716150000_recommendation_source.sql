-- 메인 브라우즈의 '관심 없음'도 나의 실험실로 보내되, SPOT 추천 노출과 섞지 않는다.
-- source='browse' 행은 B2G 수락률·머천트 추천 제안 분모에서 제외해 성과 지표를 보존한다.
ALTER TABLE public.recommendations
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'spot';

ALTER TABLE public.recommendations
    DROP CONSTRAINT IF EXISTS recommendations_source_check;

ALTER TABLE public.recommendations
    ADD CONSTRAINT recommendations_source_check
    CHECK (source IN ('spot', 'browse'));

COMMENT ON COLUMN public.recommendations.source IS
    '추천 유입 경로: spot=성과 집계 대상, browse=메인 탐색 거절의 실험실 유입 전용(성과 집계 제외)';
