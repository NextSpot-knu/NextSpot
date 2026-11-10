import assert from 'node:assert/strict';

import { HttpError } from '~/lib/core/httpCore';

import {
  LAB_HINT_MAX_SHOWS,
  acceptNotices,
  bookmarkFrom,
  greetingKey,
  nextCandidateAfter,
  nextLabHintCount,
  postAcceptWithFallback,
} from './actionsCore';
import type { SheetCandidate } from './types';

const cand = (id: string, extra: Partial<SheetCandidate> = {}): SheetCandidate => ({
  facility: { id, name: `n${id}`, type: 'restaurant', latitude: 35.8, longitude: 129.2 },
  ...extra,
});

async function main() {
  // 수락: 추천 id 를 함께 보낸다
  const sent: unknown[] = [];
  await postAcceptWithFallback(async (b) => { sent.push(b); return {}; }, 'f1', 'r1');
  assert.deepEqual(sent, [{ facilityId: 'f1', recommendationId: 'r1' }]);

  // 404/403/409 → 시설 수락으로 한 번 더
  for (const status of [404, 403, 409]) {
    const calls: unknown[] = [];
    const res = await postAcceptWithFallback(async (b) => {
      calls.push(b);
      if (calls.length === 1) throw new HttpError('x', status);
      return { couponIssued: true };
    }, 'f1', 'r1');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { facilityId: 'f1' });
    assert.equal(res?.couponIssued, true);
  }
  // 500 은 다시 보내지 않고 던진다 / 추천 id 가 없으면 폴백도 없다
  await assert.rejects(postAcceptWithFallback(async () => { throw new HttpError('x', 500); }, 'f1', 'r1'));
  await assert.rejects(postAcceptWithFallback(async () => { throw new HttpError('x', 404); }, 'f1', undefined));

  // 알림 재료
  assert.deepEqual(acceptNotices({ couponIssued: true, couponRate: 0.1, updatedVector: true }, 'r1'), { couponRatePct: 10, profile: true });
  assert.deepEqual(acceptNotices({ updatedVector: true }, undefined), { couponRatePct: null, profile: false });
  assert.deepEqual(acceptNotices(null, 'r1'), { couponRatePct: null, profile: false });

  assert.equal(greetingKey('cafe'), 'map.greetingCafe');
  assert.equal(greetingKey('culture'), 'map.greetingView');
  assert.equal(greetingKey(undefined), 'map.greetingDefault');

  // 다음 후보 — 현재·제외 건너뜀, 소진이면 null
  const list = [cand('a'), cand('b'), cand('c')];
  assert.equal(nextCandidateAfter(list, 'a', new Set())?.facility.id, 'b');
  assert.equal(nextCandidateAfter(list, 'a', new Set(['b']))?.facility.id, 'c');
  assert.equal(nextCandidateAfter(list, 'c', new Set(['a', 'b'])), null);
  assert.equal(nextCandidateAfter([], 'a', new Set()), null);

  // 북마크 모양
  const bm = bookmarkFrom(cand('a', {
    recommendationId: 'r1', congestionLevel: 0.8, spotScore: 71, scoringMode: 'model', congestionSource: 'predicted',
    breakdown: { preference: 0.8, travelTime: 3.2, waitTime: 4.1, incentive: 0 },
  }));
  assert.equal(bm.id, 'a');
  assert.equal(bm.category, '음식점');
  assert.equal(bm.trafficStatus, 'orange');
  assert.equal(bm.waitTime, '5분');
  assert.equal((bm.spot as { preferencePercent: number }).preferencePercent, 80);
  assert.equal(bookmarkFrom(cand('z')).trafficStatus, 'unknown');
  assert.equal(bookmarkFrom(cand('z')).waitTime, null);

  // 킵 북마크의 spot 은 웹 모양 — 점수 0~100, timeToService(이동 + 대기) 포함 (G3-03 · G4a-R01)
  const kept = bookmarkFrom(cand('k', {
    spotScore: 0.548, scoringMode: 'model', congestionSource: 'predicted',
    breakdown: { preference: 0.8, travelTime: 3.2, waitTime: 4.1, incentive: 0 },
  }));
  const keptSpot = kept.spot as { score: number; timeToService: number };
  assert.equal(keptSpot.score, 55);
  assert.ok(Math.abs(keptSpot.timeToService - 7.3) < 0.01);

  // 실험실 힌트 — 상한 · 저장소 불가면 안 띄운다
  assert.equal(nextLabHintCount(null, true), 1);
  assert.equal(nextLabHintCount(String(LAB_HINT_MAX_SHOWS - 1), true), LAB_HINT_MAX_SHOWS);
  assert.equal(nextLabHintCount(String(LAB_HINT_MAX_SHOWS), true), null);
  assert.equal(nextLabHintCount('0', false), null);
}

void main().then(() => console.log('actionsCore.test OK'));
