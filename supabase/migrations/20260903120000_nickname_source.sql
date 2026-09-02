-- 닉네임 출처 추적 — 프로바이더에서 이름을 바꿔도 앱에는 옛 이름이 굳어 있던 문제.
--
-- 증상(2026-09-02 실측): 카카오 계정으로 로그인했는데 닉네임이 '윤성1' 로 떴다.
--   auth.users.raw_user_meta_data 는 이미 '오윤성' 을 주고 있었는데
--   public.users.nickname 은 첫 가입(2026-07-15) 때 값 그대로였다.
--
-- 원인: 프로필 백필이 **NULL 인 칼럼만** 채운다. 사용자가 마이페이지에서 직접 정한 이름을
--   로그인할 때마다 덮어쓰지 않으려는 의도였는데, 그 대가로 프로바이더 유래 이름도 영영
--   갱신되지 않았다. 둘을 구분할 정보가 없어서 생긴 문제다 — 그 정보를 여기서 만든다.
--
--   'provider' : 소셜 프로바이더가 준 이름. 로그인할 때 최신 값으로 맞춘다.
--   'user'     : 사용자가 직접 지정. **어떤 경우에도 덮어쓰지 않는다.**
--   NULL       : 닉네임이 없거나 출처를 알 수 없다.
--
-- 닉네임에 유일성 제약은 없다(있던 적도 없다). 두 계정이 같은 이름을 써도 무방하며,
-- 닉네임으로 사용자를 찾는 코드도 없다 — 표시용 값이다.
--
-- 멱등: 재실행 가능(ADD COLUMN IF NOT EXISTS · 제약은 이름 확인 후 · 백필은 NULL 만).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS nickname_source TEXT;

-- CHECK 을 따로 붙이는 이유: ADD COLUMN IF NOT EXISTS 의 인라인 CHECK 은 컬럼이 이미 있으면
-- 통째로 건너뛰어, 컬럼만 먼저 생긴 환경에 제약이 영영 안 붙는다.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.users'::regclass
           AND conname = 'users_nickname_source_check'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_nickname_source_check
            CHECK (nickname_source IS NULL OR nickname_source IN ('provider', 'user'));
    END IF;
END $$;

-- 기존 행 백필 — 지금 프로바이더가 주는 이름과 **같으면** 프로바이더 유래로 본다.
--
-- 다르면 사용자가 바꾼 건지 프로바이더 쪽이 바뀐 건지 알 수 없다. 그때는 'user' 로 둔다:
-- 사용자가 고른 이름이 로그인 한 번에 사라지는 쪽이, 옛 이름이 남아 있는 쪽보다 나쁘다
-- (옛 이름은 마이페이지에서 직접 고칠 수 있지만, 지워진 이름은 되돌릴 방법이 없다).
UPDATE public.users u
   SET nickname_source = CASE
        WHEN u.nickname = COALESCE(
                 a.raw_user_meta_data->>'full_name',
                 a.raw_user_meta_data->>'name'
             ) THEN 'provider'
        ELSE 'user'
       END
  FROM auth.users a
 WHERE a.id = u.id
   AND u.nickname IS NOT NULL
   AND u.nickname_source IS NULL;

-- handle_new_user 확장 — 가입 시점에 출처를 같이 남긴다.
-- 이 트리거로 들어온 닉네임은 정의상 프로바이더 유래다(익명 가입은 메타가 비어 NULL).
-- 나머지 동작은 20260715140000 판과 동일하다.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
    v_nickname TEXT;
BEGIN
    v_nickname := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name'
    );
    INSERT INTO public.users (id, preferred_categories, nickname, avatar_url, nickname_source)
    VALUES (
        NEW.id,
        '[]'::jsonb,
        v_nickname,
        NEW.raw_user_meta_data->>'avatar_url',
        CASE WHEN v_nickname IS NOT NULL THEN 'provider' END
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- 트리거(on_auth_user_created)는 20260710160000 에서 이미 만들었다 — 함수만 교체하면 된다.
--
-- ⚠️ 익명 세션의 linkIdentity 승격은 auth.users 를 UPDATE 하므로 이 트리거(AFTER INSERT)를
--    타지 않는다. 그 경로와 '로그인할 때마다 갱신'은 프런트가 담당한다
--    (apps/web/lib/auth.ts syncProfileFromProvider → lib/oauthFlow.ts resolveProfileSync).
