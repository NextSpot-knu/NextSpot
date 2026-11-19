import assert from 'node:assert/strict';

import { colors, fontFamilies } from '~/lib/theme/tokens';

import { defaultLineHeight, fontStyleFor, glassTextColor, resolveColor } from './textStyle';

// ── fontStyleFor(G2-G04 · G2-R03) ──
assert.deepEqual(fontStyleFor('bold', 'ko', 'native'), { fontFamily: fontFamilies.bold, fontWeight: 'normal' });
assert.deepEqual(fontStyleFor('regular', 'en', 'native'), { fontFamily: fontFamilies.regular, fontWeight: 'normal' });
// 웹 빌드: 대체 고딕 목록(명조로 떨어지지 않게) + 숫자 굵기
assert.deepEqual(fontStyleFor('medium', 'ko', 'web'), {
  fontFamily: `${fontFamilies.medium}, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif`,
  fontWeight: '500',
});
// ja·zh 네이티브: family 키 없음(시스템 CJK) + 숫자 굵기
assert.deepEqual(fontStyleFor('black', 'ja', 'native'), { fontWeight: '900' });
assert.ok(!('fontFamily' in fontStyleFor('semibold', 'zh', 'native')));
// ja·zh 웹 빌드: 웹 globals.css 목록 → Freesentation(한글) → system-ui
const ja = fontStyleFor('bold', 'ja', 'web');
assert.equal(ja.fontWeight, '700');
assert.ok(ja.fontFamily!.startsWith('"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP"'));
assert.ok(ja.fontFamily!.endsWith(`"Yu Gothic UI", ${fontFamilies.bold}, system-ui, sans-serif`));
const zh = fontStyleFor('regular', 'zh', 'web');
assert.ok(zh.fontFamily!.startsWith('"PingFang SC", "Noto Sans SC"'));
assert.equal(zh.fontWeight, '400');

// ── defaultLineHeight(G2-G05) ──
assert.equal(defaultLineHeight('text-[16px] text-muk', undefined), 24);
assert.equal(defaultLineHeight('text-[13px]', null), 19.5); // 웹 칩 13px → 19.5
assert.equal(defaultLineHeight('text-[12px] font-bold', {}), 18);
assert.equal(defaultLineHeight('text-[11px]', {}), 16.5); // 저장 히어로 칩(G4a-R02)
assert.equal(defaultLineHeight('text-[1.25rem]', {}), 30);
assert.equal(defaultLineHeight('', {}), 24); // 크기 없음 → 16
// style 의 fontSize 가 먼저
assert.equal(defaultLineHeight('text-[16px]', { fontSize: 10 }), 15);
// 줄 높이를 이미 정했으면 덮지 않는다
assert.equal(defaultLineHeight('text-[13px] leading-[18px]', {}), undefined);
assert.equal(defaultLineHeight('text-[13px] leading-none', {}), undefined);
assert.equal(defaultLineHeight('text-[13px] md:leading-5', {}), undefined);
assert.equal(defaultLineHeight('text-[13px]', { lineHeight: 20 }), undefined);
// 이름 크기는 NativeWind 가 줄 높이를 이미 준다
assert.equal(defaultLineHeight('text-xs', {}), undefined);
assert.equal(defaultLineHeight('text-2xl font-bold', {}), undefined);
// 변형 크기는 기본 상태 크기가 아니다
assert.equal(defaultLineHeight('text-[14px] md:text-lg', {}), 21);
// 색·정렬 클래스는 크기로 보지 않는다
assert.equal(defaultLineHeight('text-[14px] text-center text-muk-soft', {}), 21);

// ── 유리 안 글자색(G2-G03) ──
assert.equal(glassTextColor('text-[13px] text-muk-soft', null), undefined); // 유리 밖
assert.equal(glassTextColor('text-[13px] text-muk-soft', 'light'), colors['glass-muk-soft']);
assert.equal(glassTextColor('text-gold-deep text-center', 'light'), colors['glass-gold-deep']);
assert.equal(glassTextColor('text-muk', 'light'), undefined); // 먹은 그대로
assert.equal(glassTextColor('text-jade', 'light'), undefined);
assert.equal(glassTextColor('text-muk-soft/70', 'light'), 'rgba(70, 59, 52, 0.7)');
assert.equal(glassTextColor('active:text-muk-soft', 'light'), undefined);
// rail 은 먹도 뒤집는다
assert.equal(glassTextColor('text-muk text-[16px]', 'rail'), colors['rail-muk']);
assert.equal(glassTextColor('text-gold', 'rail'), colors['rail-gold']);

// ── Icon 색(G4a-02 · G5b-12 fill 과 같은 해석) ──
assert.equal(resolveColor('terracotta'), colors.terracotta);
assert.equal(resolveColor('rgba(193,154,62,0.6)'), 'rgba(193,154,62,0.6)');
assert.equal(resolveColor('muk-soft', 'light'), colors['glass-muk-soft']);
assert.equal(resolveColor('gold-deep', 'light'), colors['glass-gold-deep']);
assert.equal(resolveColor('jade', 'light'), colors.jade);

console.log('ok textStyle');
