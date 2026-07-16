-- OAuth 프로필 필드 + handle_new_user 확장 (2026-07-15) — docs/OAUTH_PLAN.md M1
-- 배경: 익명(무마찰) 세션 위에 카카오·구글 OAuth 연동을 얹는다(linkIdentity 승격).
--   OAuth 가입/연동 시 프로바이더가 주는 닉네임·프로필 이미지를 public.users 에 보존해
--   마이페이지가 실제 이름/아바타를 표시할 수 있게 한다.
--
-- 1) users.avatar_url: OAuth 프로바이더 프로필 이미지 URL(nullable). 익명/이메일 미제공 시 NULL.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- 2) handle_new_user() 확장 — auth.users INSERT 시 raw_user_meta_data 에서 프로필을 채운다.
--    · 익명 가입: raw_user_meta_data 가 비어 있어 nickname/avatar_url 은 NULL → 기존 동작과 동일.
--    · OAuth '신규' 가입(기기 B 등 익명 세션 없이 바로 로그인): full_name/name/avatar_url 을 복사.
--    ⚠️ 익명 사용자의 linkIdentity 승격은 auth.users 를 UPDATE 하므로 이 트리거(AFTER INSERT)를
--       타지 않는다. 그 경로의 프로필 백필은 프런트(lib/auth.ts)가 승격 직후 users 를 UPDATE 로 채운다.
--    COALESCE(full_name, name): 프로바이더마다 키가 달라(구글=name, 카카오=full_name/name 혼재) 폴백한다.
--    ON CONFLICT (id) DO NOTHING: 승격 전 익명 INSERT 로 이미 행이 있으면 보존(재실행 안전).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.users (id, preferred_categories, nickname, avatar_url)
    VALUES (
        NEW.id,
        '[]'::jsonb,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
        NEW.raw_user_meta_data->>'avatar_url'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- 트리거는 20260710160000 에서 이미 생성됨(on_auth_user_created) — 함수만 교체하면 되므로 재생성 불필요.
