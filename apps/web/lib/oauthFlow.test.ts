import assert from 'node:assert/strict';
import type { User } from '@supabase/supabase-js';
import { buildRedirectTo, deriveAuthState, resolveProfileSync, safeNext } from './oauthFlow';

// ── safeNext — 오픈 리다이렉트 방어 ────────────────────────────────────────
// `next` 는 콜백 URL 쿼리에서 오므로 공격자가 통제할 수 있다. 앱 내부 절대경로만 통과해야 한다.

// 정상 경로는 그대로 통과.
assert.equal(safeNext('/mypage'), '/mypage');
assert.equal(safeNext('/main'), '/main');
assert.equal(safeNext('/merchant/dashboard'), '/merchant/dashboard');
assert.equal(safeNext('/course?s=abc&ref=share'), '/course?s=abc&ref=share');

// 값이 없으면 기본 복귀지.
assert.equal(safeNext(undefined), '/mypage');
assert.equal(safeNext(''), '/mypage');

// 절대 URL 거부 — 프로바이더 왕복 뒤 외부 사이트로 튕기지 않게.
assert.equal(safeNext('https://evil.com'), '/mypage');
assert.equal(safeNext('http://evil.com/main'), '/mypage');

// 프로토콜 상대 URL 거부 — 브라우저는 `//evil.com` 을 외부 도메인으로 해석한다.
// (`/` 로 시작하는지만 봤다면 여기서 뚫린다 — 이 케이스가 이 함수의 존재 이유다.)
assert.equal(safeNext('//evil.com'), '/mypage');
assert.equal(safeNext('//evil.com/main'), '/mypage');

// 스킴 기반 우회 거부.
assert.equal(safeNext('javascript:alert(1)'), '/mypage');
assert.equal(safeNext('mypage'), '/mypage'); // 슬래시 없는 상대경로

// ── buildRedirectTo — 콜백 URL 조립 ───────────────────────────────────────
const origin = 'https://nextspot-nu.vercel.app';

// provider 는 콜백이 identity_already_exists 폴백에 쓰므로 반드시 실려야 한다.
const linkUrl = buildRedirectTo(origin, '/main', 'kakao');
assert.ok(linkUrl.startsWith(`${origin}/auth/callback?`));
const linkParams = new URLSearchParams(linkUrl.split('?')[1]);
assert.equal(linkParams.get('next'), '/main');
assert.equal(linkParams.get('provider'), 'kakao');
// 최초 연동에는 retry 표식이 없어야 한다 — 있으면 콜백이 폴백 로그인을 건너뛴다.
assert.equal(linkParams.get('retry'), null);

// 폴백 로그인 경로에는 retry=1 — 콜백이 또 폴백을 걸어 무한 루프가 되는 것을 막는 표식.
const retryParams = new URLSearchParams(
  buildRedirectTo(origin, '/mypage', 'google', true).split('?')[1],
);
assert.equal(retryParams.get('retry'), '1');
assert.equal(retryParams.get('provider'), 'google');

// safeNext 가 buildRedirectTo 안에서도 적용된다(외부 URL 이 콜백 파라미터로 새지 않게).
const evilParams = new URLSearchParams(
  buildRedirectTo(origin, '//evil.com', 'kakao').split('?')[1],
);
assert.equal(evilParams.get('next'), '/mypage');

// SSR/프리렌더처럼 origin 이 없으면 상대 경로로 조립된다(예외를 던지지 않는다).
assert.ok(buildRedirectTo('', '/main', 'kakao').startsWith('/auth/callback?'));

// ── deriveAuthState — 계정 상태 판정 ──────────────────────────────────────
function asUser(partial: Partial<User>): User {
  return { id: 'u1', identities: [], ...partial } as User;
}

// 세션 없음 → none(목업 폴백 상태).
assert.equal(deriveAuthState(null).status, 'none');
assert.equal(deriveAuthState(undefined).status, 'none');
assert.deepEqual(deriveAuthState(null).providers, []);

// 익명 세션 + 소셜 없음 → guest(연동 유도 노출).
const guest = deriveAuthState(asUser({ is_anonymous: true }));
assert.equal(guest.status, 'guest');
assert.deepEqual(guest.providers, []);

// 카카오 연동 → linked + 프로바이더 뱃지.
const kakao = deriveAuthState(
  asUser({ is_anonymous: false, identities: [{ provider: 'kakao' }] as User['identities'] }),
);
assert.equal(kakao.status, 'linked');
assert.deepEqual(kakao.providers, ['kakao']);

// 자체 이메일 회원(소셜 identity 없음)도 linked — 로그아웃 버튼이 필요한 상태다.
// providers 는 비어야 한다(뱃지에 'email' 이 뜨면 안 된다).
const emailMember = deriveAuthState(
  asUser({ is_anonymous: false, identities: [{ provider: 'email' }] as User['identities'] }),
);
assert.equal(emailMember.status, 'linked');
assert.deepEqual(emailMember.providers, []);

// 이메일 회원이 구글까지 연동 → 소셜만 추려진다.
const both = deriveAuthState(
  asUser({
    is_anonymous: false,
    identities: [{ provider: 'email' }, { provider: 'google' }] as User['identities'],
  }),
);
assert.deepEqual(both.providers, ['google']);

// is_anonymous 가 없는 구 토큰이라도 소셜 identity 가 있으면 linked 로 승격.
const legacyLinked = deriveAuthState(
  asUser({ identities: [{ provider: 'google' }] as User['identities'] }),
);
assert.equal(legacyLinked.status, 'linked');

// is_anonymous 도 소셜도 없으면 보수적으로 guest(연동을 권한다).
assert.equal(deriveAuthState(asUser({})).status, 'guest');

// identities 가 아예 undefined 여도 터지지 않는다(Supabase 응답 편차 방어).
assert.equal(deriveAuthState(asUser({ identities: undefined })).status, 'guest');

// ── resolveProfileSync — 프로바이더 이름 동기화 ─────────────────────────────
// 두 실패가 정반대 방향이라 둘 다 잠근다:
//   · 갱신을 안 하면 → 카카오에서 이름을 바꿔도 앱엔 첫 가입 때 값이 영영 남는다(2026-09-02 실제 증상).
//   · 무조건 갱신하면 → 사용자가 마이페이지에서 정한 이름이 로그인 한 번에 사라진다.

const KAKAO = { name: '오윤성', avatar: 'http://k.kakaocdn.net/new.jpg' };

// 프로바이더 유래 이름이 낡았으면 갱신한다 — 이게 원래 안 되던 부분이다.
{
  const patch = resolveProfileSync(KAKAO, {
    nickname: '윤성1',
    avatar_url: 'http://k.kakaocdn.net/new.jpg',
    nickname_source: 'provider',
  });
  assert.equal(patch.nickname, '오윤성');
  assert.equal(patch.nickname_source, 'provider');
}

// 컬럼이 없던 시절의 행(source=null)도 갱신 대상이다. 안 그러면 기존 사용자는 영영 안 고쳐진다.
assert.equal(
  resolveProfileSync(KAKAO, { nickname: '윤성1', avatar_url: null, nickname_source: null }).nickname,
  '오윤성',
);

// 사용자가 직접 정한 이름은 **절대** 건드리지 않는다.
{
  const patch = resolveProfileSync(KAKAO, {
    nickname: '내가고른이름',
    avatar_url: null,
    nickname_source: 'user',
  });
  assert.equal(patch.nickname, undefined, '사용자가 정한 이름이 덮였다');
  assert.equal(patch.nickname_source, undefined);
  // 아바타는 사용자가 지정할 경로가 없으므로 이 경우에도 맞춘다.
  assert.equal(patch.avatar_url, KAKAO.avatar);
}

// 이미 같으면 쓸 것이 없다 — 로그인마다 무의미한 UPDATE 를 날리지 않는다.
assert.deepEqual(
  resolveProfileSync(KAKAO, {
    nickname: '오윤성',
    avatar_url: KAKAO.avatar,
    nickname_source: 'provider',
  }),
  {},
);

// 프로필 행이 아직 없는 경우(승격 직후 백필) — 원래 동작대로 채운다.
{
  const patch = resolveProfileSync(KAKAO, null);
  assert.equal(patch.nickname, '오윤성');
  assert.equal(patch.avatar_url, KAKAO.avatar);
}

// 프로바이더가 이름을 안 주면(카카오 비즈앱 미전환 등) 이름은 손대지 않는다.
assert.equal(
  resolveProfileSync({ name: null, avatar: KAKAO.avatar }, {
    nickname: '윤성1',
    avatar_url: null,
    nickname_source: 'provider',
  }).nickname,
  undefined,
);

// 중복은 판단 근거가 아니다 — 다른 계정이 같은 이름을 써도 그대로 쓴다(유일성 제약 없음).
assert.equal(
  resolveProfileSync(KAKAO, { nickname: '옛이름', avatar_url: null, nickname_source: 'provider' })
    .nickname,
  '오윤성',
);

console.log('oauthFlow tests passed');
