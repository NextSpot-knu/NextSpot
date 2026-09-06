// 코스 공유 딥링크 포맷 — 왕복과 **하위호환**을 잠근다.
//
// 이 포맷에는 테스트가 없었다. 그런데 여기서 값을 하나 잘못 읽으면 받는 사람 화면에 없는
// 혼잡도가 뜬다(공유 링크는 발신자가 본 것을 그대로 보여 준다는 약속 위에 있다).
import assert from 'node:assert/strict';
import { encodeStops, parseShareParam } from './courseShare';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

// --- 왕복: 숫자 혼잡도 -------------------------------------------------------
{
  const encoded = encodeStops([{ id: A, offsetMin: 12.4, congestion: 0.75 }]);
  const parsed = parseShareParam(encoded);
  assert.equal(parsed.stops.length, 1);
  assert.equal(parsed.stops[0].id, A);
  assert.equal(parsed.stops[0].offsetMin, 12, '오프셋은 반올림해 싣는다');
  assert.equal(parsed.stops[0].congestion, 0.75);
  assert.ok(parsed.sharedAtMin && parsed.sharedAtMin > 0, '공유 시각이 실려야 경과 보정이 된다');
}

// --- 왕복: 혼잡도 미상 -------------------------------------------------------
// 모델이 미학습이면(degraded_rules) 모든 정류지가 이 경우다. 예전에는 이런 코스를 아예
// 공유할 수 없었고, 버튼은 그대로 보이는 채 코스가 빠진 맨 URL 이 조용히 공유됐다.
{
  const encoded = encodeStops([{ id: A, offsetMin: 5, congestion: null }]);
  assert.ok(encoded.includes(`${A}.5.-`), `미상은 '-' 로 실어야 한다: ${encoded}`);
  const parsed = parseShareParam(encoded);
  assert.equal(parsed.stops.length, 1, '미상이라고 정류지를 버리면 안 된다');
  assert.equal(parsed.stops[0].congestion, null, '모르는 값을 0 으로 채우면 거짓이 된다');
}

// --- '-' 를 고른 이유: 옛 번들이 거짓 숫자를 만들지 않는다 -------------------
// 옛 파서는 Number(congRaw) 가 유한한지만 봤다. 빈 문자열이었다면 Number('') === 0 이라
// '한산 0%' 를 지어냈을 것이다. '-' 는 NaN 이라 옛 파서가 그 조각을 조용히 버린다 —
// 최악이라도 '정류지가 빠진 짧은 코스'이지 없는 값을 보여 주지는 않는다.
{
  assert.ok(Number.isNaN(Number('-')), "'-' 는 NaN 이어야 옛 파서가 버린다");
  assert.equal(Number(''), 0, '빈 문자열이었다면 0 으로 읽혔을 것이다(그래서 쓰지 않는다)');
  // 새 파서도 빈 문자열은 거부한다 — 어디서 흘러들어오든 0 으로 읽지 않는다.
  const parsed = parseShareParam(`999~${A}.5.`);
  assert.equal(parsed.stops.length, 0, "빈 혼잡도 칸을 0 으로 읽으면 안 된다");
}

// --- 하위호환: 옛 링크는 그대로 열려야 한다 ----------------------------------
{
  // 공유 시각 프리픽스가 있는 현행 포맷
  const withTime = parseShareParam(`29000000~${A}.10.30,${B}.40.80`);
  assert.equal(withTime.sharedAtMin, 29000000);
  assert.deepEqual(
    withTime.stops.map((s) => [s.id, s.offsetMin, s.congestion]),
    [[A, 10, 0.3], [B, 40, 0.8]],
  );

  // '~' 가 없던 더 옛날 포맷 — 시각 미상으로 읽되 정류지는 살린다.
  const legacy = parseShareParam(`${A}.10.30`);
  assert.equal(legacy.sharedAtMin, null);
  assert.equal(legacy.stops.length, 1);
  assert.equal(legacy.stops[0].congestion, 0.3);
}

// --- 깨진 조각 하나가 전체를 막지 않는다 -------------------------------------
{
  const parsed = parseShareParam(`29000000~${A}.10.30,쓰레기,${B}.x.50,${B}.40.-`);
  assert.deepEqual(
    parsed.stops.map((s) => [s.id, s.congestion]),
    [[A, 0.3], [B, null]],
    '형식이 어긋난 조각만 걸러내고 나머지는 살려야 한다',
  );
}

// --- 범위 보정 ---------------------------------------------------------------
{
  const parsed = parseShareParam(`1~${A}.0.250,${B}.0.-40`);
  assert.equal(parsed.stops[0].congestion, 1, '100 초과는 1 로 클램프');
  assert.equal(parsed.stops[1].congestion, 0, '음수는 0 으로 클램프');
}

console.log('courseShare tests passed');
