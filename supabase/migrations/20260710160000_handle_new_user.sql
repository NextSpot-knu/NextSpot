-- =========================================================================
-- auth.users INSERT → public.users 자동 프로비저닝 (익명/신규 인증 사용자 대응)
-- =========================================================================
-- 배경: 관광객 무마찰 익명 로그인(supabase.auth.signInAnonymously — apps/web SessionBootstrap) 도입으로
--   모든 방문자가 실제 auth.users 행을 갖게 된다. 그러나 백엔드 recommendations.fetch_user 는 매칭되는
--   public.users 행이 없으면 404("사용자 정보를 찾을 수 없습니다.")를 던져 추천/코스/쿠폰 흐름을 막는다.
--   따라서 신규 auth 사용자(익명 포함)마다 대응하는 public.users 행이 즉시 존재해야 한다.
--   이 트리거가 그 간극을 메운다 — Supabase 표준 handle_new_user 패턴.
--
-- 동작: auth.users 에 행이 INSERT 될 때(익명 포함) 같은 id 로 public.users 행을 만든다.
--   - SECURITY DEFINER + SET search_path=public: auth 스키마 트리거가 함수 소유자(RLS 우회) 권한으로
--     public.users(RLS 적용 테이블)에 안전하게 INSERT 한다. (기존 get_auth_user_role 과 동일 관용구.)
--   - preferred_categories 는 스키마 기본값('[]'::jsonb)과 동일하게 명시 — 콜드스타트 선호벡터의 안전한 기본.
--     (role='tourist', created_at/updated_at 은 컬럼 DEFAULT, nickname/visit_time_pref 는 NULL 허용.)
--   - ON CONFLICT (id) DO NOTHING: 이미 존재하는 행을 덮어쓰지 않는다 → 기존 사용자 보존 + 재실행 안전.
-- 멱등: 함수는 CREATE OR REPLACE, 트리거는 DROP IF EXISTS 후 재생성.
--
-- ⚠️ 이 마이그레이션만으로 익명 로그인이 켜지지는 않는다(트리거는 '가입 후 프로비저닝'만 담당).
--    실제 활성화하려면 Supabase 대시보드에서
--    Authentication → Sign In / Providers → "Allow anonymous sign-ins" 를 켜야 한다.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.users (id, preferred_categories)
    VALUES (NEW.id, '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();
