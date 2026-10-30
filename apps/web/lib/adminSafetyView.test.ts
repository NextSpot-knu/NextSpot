// 안전 경보 화면 판정 — '모름' 을 '정상' 으로 보여 주지 않는다(P0-4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SAFETY_DEFAULT_WINDOW_MINUTES,
  kstClockLabel,
  relativeAgeLabel,
  resolveSafetyJudgement,
  zoneSourceLine,
} from './adminSafetyView';

const NOW = Date.parse('2026-10-31T05:00:00Z'); // KST 14:00

// ── 새 서버 ──────────────────────────────────────────────────────────────────
{
  // 관측 없음 → 판정 불가(정상이 아니다). 마지막 관측 시각은 그대로 들고 간다.
  const none = resolveSafetyJudgement({
    judgement: 'unavailable', sampleEmpty: true, latestObservedAt: '2026-10-17T05:00:00Z',
    meta: { maxObservationAgeMinutes: 30 }, zones: [],
  });
  assert.deepEqual(none, { kind: 'unavailable', windowMinutes: 30, latestObservedAt: '2026-10-17T05:00:00Z', ageKnown: true });

  // 관측된 존이 전부 주의 미만 → clear(관측된 존 수와 함께 — '전 구역' 이 아니다).
  const clear = resolveSafetyJudgement({
    judgement: 'available', zones: [{ level: 'normal', observedAt: '2026-10-31T04:50:00Z' }, { level: 'normal' }],
  });
  assert.deepEqual(clear, { kind: 'clear', windowMinutes: SAFETY_DEFAULT_WINDOW_MINUTES, observedZones: 2 });

  const flagged = resolveSafetyJudgement({ judgement: 'available', zones: [{ level: 'warn' }, { level: 'normal' }] });
  assert.deepEqual(flagged, { kind: 'zones', windowMinutes: 30, ageKnown: true });

  // available 인데 존이 없다(좌표 없는 시설만 관측) → 판정할 존이 없으니 판정 불가.
  assert.equal(resolveSafetyJudgement({ judgement: 'available', zones: [] }).kind, 'unavailable');
}

// ── 옛 서버(관측 나이를 모름) — 위험 신호는 그리되 '정상' 은 말하지 않는다 ──────────────
{
  assert.deepEqual(resolveSafetyJudgement({ sampleEmpty: true, zones: [] }), {
    kind: 'unavailable', windowMinutes: 30, latestObservedAt: null, ageKnown: false,
  });
  assert.deepEqual(resolveSafetyJudgement({ sampleEmpty: false, zones: [{ level: 'alert' }] }), {
    kind: 'zones', windowMinutes: 30, ageKnown: false,
  });
  // 전부 normal 이어도 나이를 모르면 '정상' 이 아니다.
  assert.equal(resolveSafetyJudgement({ sampleEmpty: false, zones: [{ level: 'normal' }] }).kind, 'unavailable');
  assert.equal(resolveSafetyJudgement(null).kind, 'unavailable');
}

// ── 시각 문구 ─────────────────────────────────────────────────────────────────
{
  assert.equal(relativeAgeLabel('2026-10-31T04:59:40Z', NOW), '방금');
  assert.equal(relativeAgeLabel('2026-10-31T04:48:00Z', NOW), '12분 전');
  assert.equal(relativeAgeLabel('2026-10-31T02:00:00Z', NOW), '3시간 전');
  assert.equal(relativeAgeLabel('2026-10-17T05:00:00Z', NOW), '14일 전');
  assert.equal(relativeAgeLabel('2026-10-31T06:00:00Z', NOW), null, '미래 시각에 나이를 붙였다');
  assert.equal(relativeAgeLabel('x', NOW), null);
  assert.equal(kstClockLabel('2026-10-31T04:48:00Z', NOW), '13:48');
  assert.equal(kstClockLabel('2026-10-17T05:00:00Z', NOW), '10/17 14:00');
  assert.equal(kstClockLabel(null, NOW), null);
}

// ── 출처 한 줄 ────────────────────────────────────────────────────────────────
assert.equal(zoneSourceLine({ user_report: 2, admin_override: 1 }), '손님 제보 2 · 관리자 입력 1');
assert.equal(zoneSourceLine({ merchant_report: 1, mystery: 2 }), '기타 2 · 좌석 방송 1');
assert.equal(zoneSourceLine({}), null);
assert.equal(zoneSourceLine(undefined), null);

// ── 화면 배선 — '정상' 문구는 clear 판정에만, 근거 없는 '전 구역 정상' 은 없다 ──────────────
{
  const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
  const page = strip(readFileSync(join(process.cwd(), 'app/admin/safety/page.tsx'), 'utf8'));
  assert.match(page, /resolveSafetyJudgement\(data\)/, '안전 화면이 판정 함수를 쓰지 않는다');
  assert.doesNotMatch(page, /전 구역 정상|전체 정상입니다/, "관측 없이 '정상' 이라고 말하는 문구가 남아 있다");
  assert.match(page, /판정 불가/, "관측이 없을 때의 '판정 불가' 문구가 없다");
  assert.match(page, /최근 \$\{judgement\.windowMinutes\}분 관측 없음/, "판정 불가 문구가 판정 창(분)을 말하지 않는다");
  // 존 카드에 관측 시각이 있다.
  assert.match(page, /kstClockLabel\(zone\.observedAt/, '존 카드가 관측 시각을 보이지 않는다');
  // 알림이 '즉시 전달' 된다고 약속하지 않는다(열린 탭에만 뜬다).
  assert.doesNotMatch(page, /즉시 전달됩니다/, '브라우저 알림 범위를 넘는 약속이 남아 있다');
}

console.log('adminSafetyView tests passed');
