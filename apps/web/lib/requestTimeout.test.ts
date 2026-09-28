// 클라이언트 타임아웃을 구분하는 오류 타입 — /explore/recommend 가 45초 타임아웃 뒤 같은 개인화 POST 를
// 다시 보내지 않고(캐시·단일 비행 없음, 기록 행도 한 번 더) 바로 by-type 대안으로 가게 한다.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, isRequestTimeout, RequestTimeoutError } from './api-client';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGE = '요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.';

/** src 에서 `name(` 호출의 인자 목록(괄호 짝까지)을 모두 뽑는다. */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(`${name}(`, from);
    if (at < 0) return out;
    let depth = 0;
    let i = at + name.length;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(at + name.length + 1, i));
    from = i;
  }
}

// 판정
{
  const err = new RequestTimeoutError();
  assert.equal(isRequestTimeout(err), true);
  assert.ok(err instanceof Error, '메시지로 분류하는 기존 소비자가 Error 로 받아야 한다');
  assert.equal(err.message, MESSAGE, '사용자에게 보이는 타임아웃 문구가 바뀌었다');
  assert.equal(isRequestTimeout(new Error(MESSAGE)), false, '메시지만 같은 일반 오류를 타임아웃으로 보면 안 된다');
  assert.equal(isRequestTimeout(new HttpError('Service Unavailable', 503)), false);
  assert.equal(isRequestTimeout(null), false);
  assert.equal(isRequestTimeout(undefined), false);
}

// 배선 가드 — 전송 계층
{
  const src = readFileSync(join(WEB, 'lib', 'api-client.ts'), 'utf8');
  assert.match(src, /throw new RequestTimeoutError\(\)/, '타임아웃이 구분되지 않는 일반 Error 로 던져진다');
  assert.doesNotMatch(src, /429[^\n]*503[^\n]*재시도한다/, '429·503 을 재시도한다는 낡은 주석이 남아 있다(B4)');
  // 예전 주석은 두 줄에 걸쳐 있었다 — 줄바꿈을 넘어서도 같은 주장이 없어야 한다.
  assert.doesNotMatch(src, /429[\s\S]{0,120}503[\s\S]{0,120}재시도한다/, '429·503 을 재시도한다는 낡은 주석이 남아 있다(B4)');
}

// 배선 가드 — POI 상세 대안
{
  const src = readFileSync(join(WEB, 'app', 'explore', 'recommend', 'page.tsx'), 'utf8');
  assert.match(src, /isRequestTimeout\(firstErr\)/, '타임아웃 뒤에도 같은 개인화 요청을 다시 보낸다');
  assert.match(src, /BY_TYPE_FALLBACK_TIMEOUT_MS = 45_000/, 'by-type 대안 폴백이 45초 예산을 갖지 않는다');
  const calls = callArgs(src, 'recommendByType');
  assert.equal(calls.length, 1, `recommendByType 호출이 한 곳이어야 한다(두 폴백이 같은 호출을 쓴다): ${calls.length}`);
  assert.match(calls[0].trim(), /BY_TYPE_FALLBACK_TIMEOUT_MS,?$/, 'by-type 폴백이 전송 기본값(10초)으로 돈다');
  const uses = src.match(/byTypeFallback\(\)/g) ?? [];
  assert.ok(uses.length >= 2, `두 폴백 경로가 같은 byTypeFallback 을 써야 한다: ${uses.length}`);
}

console.log('request timeout tests passed');
