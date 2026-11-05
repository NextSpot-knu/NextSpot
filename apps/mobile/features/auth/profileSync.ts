// 소셜 로그인·가입 뒤 public.users 프로필을 무엇으로 맞출지 — 순수 모듈(테스트: profileSync.test.ts).
//
// 웹 원본: apps/web/lib/oauthFlow.ts 의 resolveProfileSync · StoredProfile · ProfilePatch (기준 커밋 0d145a1)
// 왜 다시 썼나: 웹 oauthFlow.ts 가 `import type { User } from "@supabase/supabase-js"` 를 해서 check:shared 의
// 외부 패키지 금지에 걸린다. 판정은 그대로다 — nickname_source 가 'user' 면 이름을 건드리지 않고, 그 밖에는 공급자
// 최신 값으로 맞춘다. 아바타는 항상 공급자 값.

export interface StoredProfile {
  nickname: string | null;
  avatar_url: string | null;
  nickname_source: 'provider' | 'user' | null;
}

export interface ProfilePatch {
  nickname?: string;
  nickname_source?: 'provider';
  avatar_url?: string;
}

export function resolveProfileSync(
  meta: { name: string | null; avatar: string | null },
  profile: StoredProfile | null,
): ProfilePatch {
  const patch: ProfilePatch = {};
  const userChoseTheName = profile?.nickname_source === 'user';
  if (meta.name && !userChoseTheName && profile?.nickname !== meta.name) {
    patch.nickname = meta.name;
    patch.nickname_source = 'provider';
  }
  if (meta.avatar && profile?.avatar_url !== meta.avatar) {
    patch.avatar_url = meta.avatar;
  }
  return patch;
}

/** user_metadata 에서 이름·사진을 읽는다(공급자마다 키가 다르다). 문자열이 아니면 null. */
export function readProviderMeta(meta: Record<string, unknown> | null | undefined): { name: string | null; avatar: string | null } {
  const m = meta ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    name: str(m.full_name) ?? str(m.name),
    avatar: str(m.avatar_url) ?? str(m.picture),
  };
}
