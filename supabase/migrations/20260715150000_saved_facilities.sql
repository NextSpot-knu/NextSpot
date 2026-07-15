-- saved_facilities: 사용자가 저장한 장소(북마크) — 계정(user_id) 기준 DB 영속화.
-- 배경: 저장 장소가 localStorage(기기 단위)에만 있어 ① 기기 변경 시 유실 ② 로그아웃/전환 시 다음
--   사용자에게 유출됐다. 이제 사용자별로 DB 에 저장해 기기가 바뀌어도 따라오고, RLS 로 사용자 간 격리한다.
-- 스냅샷 보존: 저장 시점의 이름·카테고리·SPOT 점수·사유·좌표를 data(jsonb)에 그대로 담는다(프런트 구조 유지).
-- 익명 세션도 authenticated 역할이라 본인 uid 로 저장 가능 — linkIdentity(승격) 시 uid 유지로 그대로 승계된다.

CREATE TABLE IF NOT EXISTS public.saved_facilities (
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- 북마크 식별자(대개 facilities.id UUID; 스냅샷 저장이라 FK/UUID 를 강제하지 않는다).
    facility_id TEXT NOT NULL,
    data JSONB NOT NULL,  -- 저장 시점 북마크 스냅샷(id/name/category/spot/reason/좌표)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, facility_id)
);

-- 본인 저장 목록 조회 인덱스(PK 선두가 user_id 라 대개 충분하지만 명시).
CREATE INDEX IF NOT EXISTS idx_saved_facilities_user ON public.saved_facilities (user_id);

ALTER TABLE public.saved_facilities ENABLE ROW LEVEL SECURITY;

-- 개인 데이터 — 클라이언트가 본인 행만 직접 CRUD(user_feedback insert 정책과 동일한 auth.uid() 격리).
DROP POLICY IF EXISTS saved_facilities_select_own ON public.saved_facilities;
CREATE POLICY saved_facilities_select_own ON public.saved_facilities FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_facilities_insert_own ON public.saved_facilities;
CREATE POLICY saved_facilities_insert_own ON public.saved_facilities FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_facilities_update_own ON public.saved_facilities;
CREATE POLICY saved_facilities_update_own ON public.saved_facilities FOR UPDATE TO authenticated
    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_facilities_delete_own ON public.saved_facilities;
CREATE POLICY saved_facilities_delete_own ON public.saved_facilities FOR DELETE TO authenticated
    USING (auth.uid() = user_id);

-- service_role 전체 허용(백엔드 필요 시).
DROP POLICY IF EXISTS saved_facilities_service_all ON public.saved_facilities;
CREATE POLICY saved_facilities_service_all ON public.saved_facilities
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- updated_at 자동 갱신(20250523120000_init.sql 의 handle_updated_at 재사용).
DROP TRIGGER IF EXISTS update_saved_facilities_modtime ON public.saved_facilities;
CREATE TRIGGER update_saved_facilities_modtime
    BEFORE UPDATE ON public.saved_facilities
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();
