-- user_preference_vectors: 사용자 8차원 선호 벡터 저장소.
-- (대회 종료 후 GCP Firestore 선호벡터 저장소를 제거하고 Supabase 테이블로 이전 — 로컬 전용 전환.)
-- 백엔드(FastAPI)는 service_role 로 적재/조회하고, 사용자는 본인 벡터만 조회한다.

CREATE TABLE IF NOT EXISTS public.user_preference_vectors (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    vector JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.user_preference_vectors ENABLE ROW LEVEL SECURITY;

-- service_role 전체 허용 (FastAPI 추천 엔진이 선호벡터 적재/조회/갱신)
CREATE POLICY service_role_all_pref_vectors ON public.user_preference_vectors
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 선호 벡터만 조회 가능 (authenticated). 쓰기는 service_role 백엔드 경유라 별도 정책 없음.
CREATE POLICY select_own_pref_vector ON public.user_preference_vectors FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- updated_at 자동 갱신 (handle_updated_at 은 20250523120000_init.sql 에서 정의됨)
CREATE TRIGGER update_user_pref_vectors_modtime
    BEFORE UPDATE ON public.user_preference_vectors
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();
