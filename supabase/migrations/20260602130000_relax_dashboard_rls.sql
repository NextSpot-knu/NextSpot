-- [프로토타입] 관리자 인증을 Firebase(Identity Platform)로 이관하면서, 관리자는 Supabase 세션이 없다.
-- admin 대시보드/리포트가 createPublicClient(anon)로도 실데이터를 읽도록, 대시보드용 '읽기' 테이블을
-- anon SELECT 허용으로 완화한다.
--   · 쓰기 및 기존 admin/authenticated RLS 정책은 그대로 유지(워커=authenticated 도 기존대로 동작).
--   · 주의: congestion_logs/recommendations/user_feedback/facilities 의 '읽기'가 공개된다(프로토타입 허용 결정).
-- 멱등: 재실행 가능하도록 DROP IF EXISTS 후 CREATE.

DROP POLICY IF EXISTS anon_select_facilities ON public.facilities;
CREATE POLICY anon_select_facilities ON public.facilities
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_select_logs ON public.congestion_logs;
CREATE POLICY anon_select_logs ON public.congestion_logs
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_select_recommendations ON public.recommendations;
CREATE POLICY anon_select_recommendations ON public.recommendations
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_select_feedback ON public.user_feedback;
CREATE POLICY anon_select_feedback ON public.user_feedback
    FOR SELECT TO anon USING (true);
