-- =========================================================================
-- system_settings: 관리자 시스템 설정 (단일 행, id=1 고정)
-- =========================================================================
-- admin/settings 페이지가 점검모드·공지문구·혼잡 임계값·콜드스타트 가중치를 읽고/쓴다.
-- 모든 인증 사용자는 읽기 가능(앱 공지/점검 배너 표시용), 쓰기는 admin 만.
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전).

CREATE TABLE IF NOT EXISTS public.system_settings (
    id INT PRIMARY KEY DEFAULT 1,
    maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
    notice_text TEXT NOT NULL DEFAULT '',
    congestion_threshold INT NOT NULL DEFAULT 80 CHECK (congestion_threshold BETWEEN 0 AND 100),
    coldstart_weight INT NOT NULL DEFAULT 50 CHECK (coldstart_weight BETWEEN 0 AND 100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    -- 단일 행만 허용(설정 레코드는 항상 id=1 하나)
    CONSTRAINT system_settings_single_row CHECK (id = 1)
);

-- 기본 설정 행 시드 (없을 때만)
INSERT INTO public.system_settings (id, notice_text)
VALUES (1, '경주 황리단길 실시간 혼잡도와 대안 장소 추천을 제공합니다. 축제·행사 기간에는 혼잡도가 평소보다 높을 수 있습니다.')
ON CONFLICT (id) DO NOTHING;

-- updated_at 자동 갱신 (init.sql 의 handle_updated_at 재사용)
DROP TRIGGER IF EXISTS update_system_settings_modtime ON public.system_settings;
CREATE TRIGGER update_system_settings_modtime
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();

-- --- RLS ---
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- service_role(백엔드) 전체 권한
DROP POLICY IF EXISTS service_role_all_settings ON public.system_settings;
CREATE POLICY service_role_all_settings ON public.system_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 모든 인증 사용자 읽기 (앱이 점검모드/공지 배너를 읽어야 함)
DROP POLICY IF EXISTS select_settings ON public.system_settings;
CREATE POLICY select_settings ON public.system_settings
    FOR SELECT TO authenticated USING (true);

-- 수정은 admin 만 (rls.sql 의 get_auth_user_role 재사용; JWT role 이 아닌 users.role 로 판정)
DROP POLICY IF EXISTS admin_update_settings ON public.system_settings;
CREATE POLICY admin_update_settings ON public.system_settings
    FOR UPDATE TO authenticated
    USING (public.get_auth_user_role() = 'admin')
    WITH CHECK (public.get_auth_user_role() = 'admin');
