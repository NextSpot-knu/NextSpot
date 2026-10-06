// 콘솔 입구 문구가 용어집(2026-10-06 계획 3.3)을 따르는가.
// 레일·폰 줄·마이페이지 카드·역할 신청 화면이 같은 이름을 불러야 심사위원이 '사장님 콘솔'·'관제 대시보드'를 한 가지로 기억한다.
// 일본어 관광객 화면에는 '管制' 를 쓰지 않는다 — 마이페이지 역할 신청 카드와 그 다음 화면(/account/business)이 남아 있었다.
// 실제 줄바꿈(레일 64px 칸에서 낱말 단위로만 접히는지)은 e2e/console-entries.spec.ts 가 잰다.
import assert from 'node:assert/strict';
import ko from './messages/ko.json';
import en from './messages/en.json';
import ja from './messages/ja.json';
import zh from './messages/zh.json';

const LOCALES = { ko, en, ja, zh } as const;
type Locale = keyof typeof LOCALES;

const GLOSSARY: Record<Locale, { merchant: string; admin: string; merchantShort: string; adminShort: string }> = {
  ko: { merchant: '사장님 콘솔', admin: '관제 대시보드', merchantShort: '사장님 콘솔', adminShort: '관제 대시보드' },
  en: { merchant: 'Merchant console', admin: 'Operations dashboard', merchantShort: 'Merchant', adminShort: 'Dashboard' },
  ja: { merchant: 'オーナーコンソール', admin: '運営ダッシュボード', merchantShort: 'オーナー', adminShort: '運営' },
  zh: { merchant: '商家控制台', admin: '运营仪表盘', merchantShort: '商家', adminShort: '运营' },
};

// 레일 라벨의 폭 없는 공백(U+200B)은 낱말 경계 표시일 뿐 — 보이는 글자는 용어집 그대로여야 한다.
const visible = (s: string) => s.replace(/\u200b/g, '');
// 화면에 보이는 이름은 대소문자만 다를 수 있다('Open operations dashboard').
const includesTerm = (s: string, term: string) => visible(s).toLowerCase().includes(term.toLowerCase());

for (const [locale, m] of Object.entries(LOCALES) as [Locale, typeof ko][]) {
  const g = GLOSSARY[locale];
  assert.equal(visible(m.nav.merchantConsole), g.merchant, `${locale} nav.merchantConsole`);
  assert.equal(visible(m.nav.adminDashboard), g.admin, `${locale} nav.adminDashboard`);
  assert.equal(m.nav.merchantShort, g.merchantShort, `${locale} nav.merchantShort`);
  assert.equal(m.nav.adminShort, g.adminShort, `${locale} nav.adminShort`);

  // 마이페이지 카드 — 사장님 카드와 관제 카드가 같은 용어로 번역돼 있다(예전 관제 카드는 한국어 고정).
  assert.ok(includesTerm(m.console.openMerchant, g.merchant), `${locale} console.openMerchant: ${m.console.openMerchant}`);
  assert.ok(includesTerm(m.console.openAdmin, g.admin), `${locale} console.openAdmin: ${m.console.openAdmin}`);
  assert.ok(m.console.openAdminDesc.trim().length > 0, `${locale} console.openAdminDesc`);
  if (locale !== 'ko') assert.doesNotMatch(m.console.openAdminDesc, /[가-힣]/, `${locale} console.openAdminDesc 가 한국어`);

  // 역할 신청 카드와 승인 화면은 대시보드를 용어집 이름으로 부른다.
  for (const key of ['adminApprovedDesc', 'goAdminConsole'] as const) {
    assert.ok(includesTerm(m.account[key], g.admin), `${locale} account.${key}: ${m.account[key]}`);
  }
  if (locale !== 'ko') {
    for (const key of ['roleRequestEntryDesc', 'roleAdminDesc'] as const) {
      assert.ok(includesTerm(m.account[key], g.admin), `${locale} account.${key}: ${m.account[key]}`);
    }
  }
}

// 관광객·계정 화면이 쓰는 일본어 묶음에 '管制' 가 없다(관제 콘솔 안쪽 문구는 이 검사 밖이다).
for (const section of ['nav', 'console', 'account', 'mypage', 'merchantGate', 'guide', 'login', 'setup'] as const) {
  const text = JSON.stringify((ja as Record<string, unknown>)[section] ?? {});
  assert.doesNotMatch(text, /管制/, `ja ${section}.* 에 '管制'`);
}

console.log('console glossary tests passed');
