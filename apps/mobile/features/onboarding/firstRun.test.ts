import assert from 'node:assert/strict';

import { writeLocationConsent } from '../auth/consentCore';
import {
  computeFirstRunStep,
  decideFirstRunRedirect,
  decideTabsFirstRunRedirect,
  INTRO_SEEN_KEY,
  markFlag,
  SETUP_SEEN_KEY,
  shouldTrackPageView,
} from './firstRunCore';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

// 순서: 소개 → 동의 → 설정 → 끝
const s = memoryStore();
assert.equal(computeFirstRunStep(s), 'intro');
markFlag(s, INTRO_SEEN_KEY);
assert.equal(computeFirstRunStep(s), 'consent');
// 거절도 결정이다 — 다음 단계로
writeLocationConsent(s, 'declined', false, new Date());
assert.equal(computeFirstRunStep(s), 'setup');
markFlag(s, SETUP_SEEN_KEY);
assert.equal(computeFirstRunStep(s), null);
// 사용자 데이터 격리(nextspot_setup_prefs 삭제)는 첫 설정을 다시 띄우지 않는다
s.removeItem('nextspot_setup_prefs');
assert.equal(computeFirstRunStep(s), null);
// 약관 판이 바뀌어 동의 기록이 무효가 되면 동의만 다시 묻는다
s.setItem('nextspot_location_consent', JSON.stringify({ decision: 'granted', ageConfirmed: true, termsVersion: 'old', decidedAt: 'x' }));
assert.equal(computeFirstRunStep(s), 'consent');

// 저장에 실패해도 이번 실행에 지난 단계는 다시 보이지 않는다
const empty = memoryStore();
assert.equal(computeFirstRunStep(empty, new Set(['intro'])), 'consent');
assert.equal(computeFirstRunStep(empty, new Set(['intro', 'consent'])), 'setup');
assert.equal(computeFirstRunStep(empty, new Set(['intro', 'consent', 'setup'])), null);

// 저장소를 못 쓰면 가두지 않는다(소개·설정 건너뜀) — 위치 동의는 없음으로 남는다(hasLocationConsent false)
assert.equal(computeFirstRunStep(null), null);

// 경로 판정
assert.equal(decideFirstRunRedirect(null, '/'), null, '끝났으면 보내지 않는다');
assert.equal(decideFirstRunRedirect(null, '/intro'), null, '끝난 뒤 소개를 다시 여는 것은 허용');
assert.equal(decideFirstRunRedirect('intro', '/'), '/intro');
assert.equal(decideFirstRunRedirect('intro', '/mypage'), '/intro');
assert.equal(decideFirstRunRedirect('intro', '/intro'), null);
assert.equal(decideFirstRunRedirect('consent', '/intro'), null, '동의도 /intro 가 그린다');
assert.equal(decideFirstRunRedirect('consent', '/setup'), '/intro', '동의 전에 설정으로 건너뛸 수 없다');
assert.equal(decideFirstRunRedirect('setup', '/intro'), '/setup');
assert.equal(decideFirstRunRedirect('setup', '/setup'), null);
// 설정 단계의 '뒤로' = 랜딩(/intro?view=landing) — 게이트가 설정으로 되돌리지 않는다(G1-15)
assert.equal(decideFirstRunRedirect('setup', '/intro', 'landing'), null);
assert.equal(decideFirstRunRedirect('setup', '/intro', 'other'), '/setup');
assert.equal(decideFirstRunRedirect('consent', '/setup', 'landing'), '/intro', '랜딩 예외는 설정 단계·/intro 에서만');
assert.equal(decideFirstRunRedirect('setup', '/mypage', 'landing'), '/setup');
// 로그인·재설정·OAuth 복귀는 첫 실행을 끊지 않는다
assert.equal(decideFirstRunRedirect('intro', '/login'), null);
assert.equal(decideFirstRunRedirect('consent', '/forgot-password'), null);
assert.equal(decideFirstRunRedirect('setup', '/auth/callback'), null);
assert.equal(decideFirstRunRedirect('setup', '/loginx'), '/setup');
assert.equal(decideFirstRunRedirect('intro', undefined), '/intro');

// 탭 진입 판정 — 단계가 남았으면 그 경로, OAuth 왕복 중이거나 다 끝났으면 null
assert.equal(decideTabsFirstRunRedirect('intro', false), '/intro');
assert.equal(decideTabsFirstRunRedirect('consent', false), '/intro');
assert.equal(decideTabsFirstRunRedirect('setup', false), '/setup');
assert.equal(decideTabsFirstRunRedirect(null, false), null);
assert.equal(decideTabsFirstRunRedirect('intro', true), null, 'OAuth 왕복 중에는 보내지 않는다');
// 첫 실행 화면으로 보낼 참이면 page_view 를 남기지 않는다
assert.equal(shouldTrackPageView('/intro'), false);
assert.equal(shouldTrackPageView(null), true);

console.log('firstRun.test OK');
