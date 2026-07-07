-- =========================================================================
-- 보안 강화 (2026-07-07 전방위 감사 후속) — docs/IMPROVEMENT_PLAN.md WS-A-1/2
-- =========================================================================
-- 1) [P0] users 자기 role 승격(privilege escalation) 차단
--    기존 update_users 의 WITH CHECK 이 행 소유권만 검증해, 로그인 사용자가
--    `UPDATE users SET role='admin'` 으로 자기 role 을 바꿔 admin 전용 정책
--    (admin_all_facilities / admin_all_logs / admin_update_settings)을 탈취할 수 있었다.
-- 2) [P1] anon 의 recommendations / user_feedback 전체 열람 제거
--    (relax_dashboard_rls 가 열었던 사용자 단위 행위 데이터 노출. 관리자 대시보드의
--     해당 지표는 FastAPI /api/v1/admin/metrics — service_role — 경유로 대체된다.)
-- 3) [P1] inquiries 의 무제한(public) 읽기/수정 제거 — PII(user_name/content) 보호.
--    익명 문의 '접수'(INSERT) 는 유지. 관리자 목록/상태변경은 FastAPI /api/v1/admin/inquiries 경유.
-- 4) [P1] recommendations FK 의 NOT NULL + ON DELETE SET NULL 모순 해소
--    (POI 삭제 시 SET NULL 이 NOT NULL 제약을 위반해 삭제가 런타임 에러로 실패했다.
--     이력 보존 의도에 맞게 NULL 허용으로 변경.)
-- 멱등: 재실행 가능하도록 DROP IF EXISTS 후 CREATE.

-- 1) users: 본인 행만 수정 가능 + role 은 변경 불가(권한 상승 차단)
--    get_auth_user_role() 은 SECURITY DEFINER 라 users 정책 안에서 재귀 없이 기존 role 을 읽는다.
--    (동일 문장 스냅샷 기준이므로 NEW.role = OLD.role 강제와 동치 — role 변경은 service_role 전용.)
DROP POLICY IF EXISTS update_users ON public.users;
CREATE POLICY update_users ON public.users FOR UPDATE TO authenticated
    USING (id = auth.uid())
    WITH CHECK (
        id = auth.uid()
        AND role = public.get_auth_user_role()
    );

-- 2) anon 의 사용자 행위 데이터 열람 제거 (facilities/congestion_logs 공개 읽기는 공용 데이터라 유지)
DROP POLICY IF EXISTS anon_select_recommendations ON public.recommendations;
DROP POLICY IF EXISTS anon_select_feedback ON public.user_feedback;

-- 3) inquiries: 무제한 SELECT/UPDATE 정책 제거 → 본인 또는 admin 만
DROP POLICY IF EXISTS "Allow select on inquiries" ON public.inquiries;
DROP POLICY IF EXISTS "Allow update on inquiries" ON public.inquiries;

CREATE POLICY select_own_or_admin_inquiries ON public.inquiries FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.get_auth_user_role() = 'admin');

CREATE POLICY admin_update_inquiries ON public.inquiries FOR UPDATE TO authenticated
    USING (public.get_auth_user_role() = 'admin')
    WITH CHECK (public.get_auth_user_role() = 'admin');

-- 4) recommendations FK: 이력 보존형 SET NULL 이 실제로 동작하도록 NOT NULL 해제
ALTER TABLE public.recommendations ALTER COLUMN original_facility_id DROP NOT NULL;
ALTER TABLE public.recommendations ALTER COLUMN recommended_facility_id DROP NOT NULL;
