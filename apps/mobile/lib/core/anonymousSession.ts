// 앱 전체가 나눠 쓰는 익명 세션 보장 함수(웹 apps/web/lib/anonymousSession.ts 의 ensureAnonymousSession 과 같은 이름).
// 로직은 anonymousSessionCore.ts — 이 파일은 앱의 Supabase 클라이언트에 묶기만 한다.
import { createAnonymousSessionEnsurer, type AnonymousAuthClient } from './anonymousSessionCore';
import { createPublicClient } from './supabase';

export { BACKOFF_MS, backoffDelayMs, type AnonymousSessionEnsurer } from './anonymousSessionCore';

export const ensureAnonymousSession = createAnonymousSessionEnsurer(
  () => createPublicClient().auth as unknown as AnonymousAuthClient,
);
