-- 거절 실험실(Rejection Lab) — user_feedback 확장.
-- 배경: 기존 피드백은 accepted|rejected|ignored 3종뿐이라 "왜 거절했는지"를 알 수 없었고,
--   preference_vector_service 가 accepted 외 모든 액션을 일괄 -5% 로 학습해
--   단순 '다음' 스와이프·'다른 대안 보기'까지 취향 벡터를 깎는 오학습이 있었다
--   (docs/REJECTION_LAB_AUDIT.md, docs/COMMERCIAL_PRODUCT_IDEAS.md §2).
-- 의도:
--   1) 액션 어휘를 의도별로 분리한다. 결정 액션(accepted_visit_intent/rejected/skipped/
--      dismissed_batch/unsaved)과 품질 신호(helpful/not_helpful)를 구분해, 학습은 명시적
--      거절 이유가 확보된 경우에만 정확히 1회 적용한다.
--   2) 거절은 즉시 학습하지 않고 reason_status='pending' 으로 적재한다. 나중에 실험실 화면에서
--      사용자가 이유(reason_code)를 답하면 learning_scope 에 따라 장기 학습 여부를 결정한다.
--   3) learning_applied_at/learning_version 으로 중복 학습을 차단한다(멱등).
-- 데이터 보존: 기존 행(현재 action='accepted' 1행)을 지우지 않기 위해 legacy 어휘
--   (accepted, rejected, ignored)를 CHECK 에 남긴다. API 입력 Literal 에서만 제외한다.
-- ⚠️ action 은 원래 VARCHAR(20) 이었는데 신규 값 'accepted_visit_intent' 가 21자라 들어가지 않는다.
--   → TEXT 로 확장한다(길이 상한은 CHECK 목록이 대신한다).
-- 재실행 안전: DROP ... IF EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
--   새 테이블·함수를 만들지 않으므로 scripts/build_reset.mjs 의 PRELUDE DROP 목록은 수정 불필요
--   (user_feedback 은 이미 DROP 대상에 포함되어 있다).

-- ---------------------------------------------------------------------------
-- 1) action: 길이 확장 + 신규/legacy 어휘로 CHECK 교체
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_action_check;

ALTER TABLE public.user_feedback ALTER COLUMN action TYPE TEXT;

ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_action_check
    CHECK (action IN (
        -- 신규 어휘
        'accepted_visit_intent',  -- 실제 방문 수락(길안내/수락) — 쿠폰·성과지표·벡터 +10%
        'rejected',               -- 명시 거절 — reason_status='pending', 장기 학습은 이유 응답 후
        'skipped',                -- 음성 '다음'/나중에 — 학습 없음
        'dismissed_batch',        -- '다른 대안 보기' — 학습 없음
        'unsaved',                -- 저장 해제 — 학습 없음
        'helpful',                -- 만족도 👍 — 품질 신호만, 벡터 학습 없음
        'not_helpful',            -- 만족도 👎 — 품질 신호만, 벡터 학습 없음
        -- legacy(기존 행 보존용. API 입력에선 제외. 'rejected' 는 신규와 어휘 공유)
        'accepted',
        'ignored'
    ));

-- ---------------------------------------------------------------------------
-- 2) 상세 이유 / 학습 상태 컬럼
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_note TEXT;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_answered_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS learning_scope TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS learning_applied_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS learning_version INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.user_feedback.reason_code IS '거절 상세 이유(실험실 응답). NULL=미응답.';
COMMENT ON COLUMN public.user_feedback.reason_note IS '자유 서술 이유(<=200자).';
COMMENT ON COLUMN public.user_feedback.reason_status IS 'none|pending|answered|skipped|expired — pending 만 실험실 목록에 뜬다.';
COMMENT ON COLUMN public.user_feedback.hidden_at IS '사용자가 실험실 목록에서 숨긴 시각. NOT NULL 이면 목록 제외.';
COMMENT ON COLUMN public.user_feedback.learning_scope IS 'none|session|long_term|data_quality — reason_code 로부터 결정. long_term 만 취향 벡터를 움직인다.';
COMMENT ON COLUMN public.user_feedback.learning_applied_at IS '학습 적용 시각. NOT NULL 이면 재적용 금지(멱등 가드).';
COMMENT ON COLUMN public.user_feedback.learning_version IS '적용된 학습 로직 버전. 0=미적용.';

-- CHECK 제약 (재실행 안전을 위해 DROP 후 재생성)
ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_reason_code_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_reason_code_check
    CHECK (reason_code IS NULL OR reason_code IN (
        'too_far',          -- long_term
        'too_crowded',      -- long_term
        'not_my_taste',     -- long_term
        'too_expensive',    -- long_term
        'closed',           -- data_quality (취향 학습 금지)
        'inaccurate',       -- data_quality (취향 학습 금지)
        'already_visited',  -- none (재추천 억제만)
        'bad_timing',       -- session
        'other'             -- none
    ));

ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_reason_note_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_reason_note_check
    CHECK (reason_note IS NULL OR char_length(reason_note) <= 200);

ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_reason_status_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_reason_status_check
    CHECK (reason_status IN ('none', 'pending', 'answered', 'skipped', 'expired'));

ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_learning_scope_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_learning_scope_check
    CHECK (learning_scope IN ('none', 'session', 'long_term', 'data_quality'));

-- ---------------------------------------------------------------------------
-- 3) 결정 액션 멱등성 — 방어적 dedupe 후 부분 UNIQUE 인덱스
--    한 추천(recommendation_id)에 결정 액션 행은 하나만 존재해야 중복 학습이 불가능해진다.
--    (helpful/not_helpful 은 결정이 아닌 품질 신호라 제외 — 수락 후에도 남길 수 있어야 한다.)
--    ⚠️ dedupe 는 인덱스 생성 **직전**에 수행해야 한다. 현재 중복은 0건이지만(감사 확인),
--       원격 DB 가 그 사이 앞서갔을 수 있으므로 방어적으로 둔다.
--       가장 이른 행(timestamp ASC)만 남기고, 동률이면 id ASC 로 tiebreak — 결정적 결과.
-- ---------------------------------------------------------------------------
DELETE FROM public.user_feedback f
 WHERE f.action IN ('accepted_visit_intent', 'rejected', 'skipped',
                    'dismissed_batch', 'unsaved', 'accepted', 'ignored')
   AND EXISTS (
       SELECT 1
         FROM public.user_feedback keep
        WHERE keep.recommendation_id = f.recommendation_id
          AND keep.action IN ('accepted_visit_intent', 'rejected', 'skipped',
                              'dismissed_batch', 'unsaved', 'accepted', 'ignored')
          AND (keep.timestamp, keep.id) < (f.timestamp, f.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_feedback_decision_recommendation
    ON public.user_feedback (recommendation_id)
    WHERE action IN ('accepted_visit_intent', 'rejected', 'skipped',
                     'dismissed_batch', 'unsaved', 'accepted', 'ignored');

-- ---------------------------------------------------------------------------
-- 4) 실험실 목록 조회 인덱스 — GET /api/v1/lab/pending (본인·미숨김·최신순 10건)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_feedback_lab_pending
    ON public.user_feedback (user_id, timestamp DESC)
    WHERE reason_status = 'pending' AND hidden_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5) RLS — 본인 행 UPDATE 허용(실험실에서 이유 응답/스킵/숨김).
--    service_role_all_feedback(FOR ALL)·select_feedback·insert_feedback 은 20250523120001_rls.sql 에 이미 있다.
--    USING 과 WITH CHECK 를 모두 user_id = auth.uid() 로 묶어 타인 소유로의 이전(user_id 변조)을 막는다.
--    ⚠️ 백엔드는 service_role 로 접근하므로 이 정책을 우회한다 — 소유권 검사는 라우터에서 명시적으로 한다.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS update_feedback ON public.user_feedback;
CREATE POLICY update_feedback ON public.user_feedback FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
