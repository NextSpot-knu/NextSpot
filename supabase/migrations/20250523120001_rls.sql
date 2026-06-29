-- 1. RLS 활성화
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.congestion_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;

-- 2. 무한 재귀 조회를 방지하기 위한 Security Definer 헬퍼 함수 정의
-- RLS 정책 평가 시 users 테이블을 직접 셀프 조인하면 infinite recursion 에러가 발생합니다.
-- SECURITY DEFINER로 선언된 함수를 통해 auth.uid() 기준의 role과 company_name을 안전하게 반환합니다.
CREATE OR REPLACE FUNCTION public.get_auth_user_info()
RETURNS TABLE (user_role VARCHAR, company VARCHAR)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT role, company_name
    FROM users
    WHERE id = auth.uid();
END;
$$;


-- =========================================================================
-- [users] RLS 정책
-- =========================================================================

-- service_role은 전체 권한 허용
CREATE POLICY service_role_all_users ON public.users 
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 근로자(본인) 및 관리자(동일 회사 직원) 조회 권한
CREATE POLICY select_users ON public.users FOR SELECT TO authenticated
    USING (
        id = auth.uid() 
        OR EXISTS (
            SELECT 1 FROM public.get_auth_user_info() AS ac 
            WHERE ac.user_role = 'admin' AND ac.company = company_name
        )
    );

-- 본인 정보만 수정 가능 (사번, 회사명 등은 관리자만 수정하거나 초기설정만 가능하도록 제한하는 것이 좋지만, 본인 레코드 수정을 기본 허용)
CREATE POLICY update_users ON public.users FOR UPDATE TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());


-- =========================================================================
-- [facilities] RLS 정책
-- =========================================================================

-- service_role 허용
CREATE POLICY service_role_all_facilities ON public.facilities 
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 모든 인증된 사용자는 공용 시설(POI) 조회 가능
CREATE POLICY select_facilities ON public.facilities FOR SELECT TO authenticated
    USING (true);

-- 관리자(admin)만 시설 정보 등록/수정/삭제 가능
CREATE POLICY admin_all_facilities ON public.facilities FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.get_auth_user_info() AS ac 
            WHERE ac.user_role = 'admin'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.get_auth_user_info() AS ac 
            WHERE ac.user_role = 'admin'
        )
    );


-- =========================================================================
-- [congestion_logs] RLS 정책
-- =========================================================================

-- service_role 허용 (IoT 센서나 백엔드 적재용)
CREATE POLICY service_role_all_logs ON public.congestion_logs 
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 모든 인증된 근로자는 혼잡도 이력 조회 가능
CREATE POLICY select_logs ON public.congestion_logs FOR SELECT TO authenticated
    USING (true);

-- 관리자(admin)는 수동 이력 적재/관리가 가능하게 허용
CREATE POLICY admin_all_logs ON public.congestion_logs FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.get_auth_user_info() AS ac 
            WHERE ac.user_role = 'admin'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.get_auth_user_info() AS ac 
            WHERE ac.user_role = 'admin'
        )
    );


-- =========================================================================
-- [recommendations] RLS 정책
-- =========================================================================

-- service_role 허용 (FastAPI 추천 엔진 적재용)
CREATE POLICY service_role_all_recommendations ON public.recommendations 
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인의 추천 이력 및 관리자의 회사 인원 추천 이력 조회 가능
CREATE POLICY select_recommendations ON public.recommendations FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.users AS u
            JOIN public.get_auth_user_info() AS ac ON u.company_name = ac.company
            WHERE u.id = user_id AND ac.user_role = 'admin'
        )
    );


-- =========================================================================
-- [user_feedback] RLS 정책
-- =========================================================================

-- service_role 허용
CREATE POLICY service_role_all_feedback ON public.user_feedback 
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인의 피드백 조회/등록 및 관리자의 동일 회사 직원 피드백 조회 권한
CREATE POLICY select_feedback ON public.user_feedback FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.users AS u
            JOIN public.get_auth_user_info() AS ac ON u.company_name = ac.company
            WHERE u.id = user_id AND ac.user_role = 'admin'
        )
    );

-- 본인 피드백만 작성(INSERT) 가능
CREATE POLICY insert_feedback ON public.user_feedback FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());
