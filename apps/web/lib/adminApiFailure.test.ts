import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_LOGIN_PATH,
  adminFailureLine,
  describeAdminFailure,
  kindFromMessage,
} from './adminApiFailure';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  // ── 401: 재시도로 절대 풀리지 않는다 → 로그인 경로를 준다 ─────────────────────
  const expired = describeAdminFailure({
    kind: 'http',
    status: 401,
    message: '인증 헤더(Authorization 또는 X-Forwarded-Authorization)가 누락되었거나 Bearer 형식이 아닙니다.',
  });
  assert.match(expired.title, /로그인/, '401 은 로그인 문제라고 말해야 한다');
  assert.equal(expired.href, ADMIN_LOGIN_PATH, '401 에 로그인 경로가 없으면 관리자가 갈 곳을 모른다');
  assert.equal(expired.retryable, false, "401 에 '다시 시도' 를 붙이면 될 리 없는 버튼이 된다");
  // 서버 원문을 삼키지 않는다(앞세우지도 않는다).
  assert.match(expired.detail ?? '', /HTTP 401/);
  assert.match(expired.detail ?? '', /인증 헤더/);
  assert.doesNotMatch(expired.title, /인증 헤더/, '서버 원문이 제목이 되면 다시 행동 불가 문구가 된다');

  // 요청을 보내지도 못한 경우(세션 없음)도 관리자가 할 일은 401 과 같다.
  const noSession = describeAdminFailure({ kind: 'no-session', message: '관리자 세션이 없습니다.' });
  assert.equal(noSession.href, ADMIN_LOGIN_PATH);
  assert.equal(noSession.retryable, false);
  // 다만 상태 코드를 지어내지 않는다 — 보내지도 않은 요청에 401 은 없다.
  assert.doesNotMatch(noSession.detail ?? '', /HTTP/, '보내지 않은 요청에 HTTP 상태를 붙이면 거짓이다');

  // ── 403: 로그인이 아니라 권한 문제다. 두 문구가 같으면 안 된다 ────────────────
  const forbidden = describeAdminFailure({ kind: 'http', status: 403, message: '이 기능에 접근할 권한이 없습니다.' });
  assert.match(forbidden.title, /권한/);
  assert.notEqual(forbidden.title, expired.title, '401 과 403 이 같은 문장이면 갈라 말한 의미가 없다');
  assert.equal(forbidden.retryable, false, '권한 부족은 재시도로 풀리지 않는다');
  assert.equal(forbidden.href, ADMIN_LOGIN_PATH);

  // ── 타임아웃: 재시도가 실제로 답이다(콜드 스타트) ────────────────────────────
  const timeout = describeAdminFailure({ kind: 'timeout', message: '요청 시간이 초과되었습니다.' });
  assert.equal(timeout.retryable, true, '타임아웃은 다시 누르면 풀릴 수 있다');
  assert.equal(timeout.href, null, '타임아웃을 로그인 문제로 안내하면 엉뚱한 곳으로 보낸다');
  assert.match(timeout.title, /늦|콜드/, '왜 늦는지(콜드 스타트)를 알려야 재시도가 납득된다');

  // ── 5xx: 서버 잘못이라고 말하고 재시도를 준다 ────────────────────────────────
  const serverError = describeAdminFailure({ kind: 'http', status: 500, message: '지표 조회에 실패했습니다.' });
  assert.match(serverError.title, /서버 오류/);
  assert.match(serverError.title, /500/, '상태 코드를 화면에서 지우면 개발팀에 전달할 단서가 사라진다');
  assert.equal(serverError.retryable, true);
  assert.equal(serverError.href, null);
  assert.match(describeAdminFailure({ status: 503 }).title, /503/);

  // ── 그 밖의 상태: 숨기지 말고 숫자를 그대로 ──────────────────────────────────
  const notFound = describeAdminFailure({ kind: 'http', status: 404, message: 'Not Found' });
  assert.match(notFound.title, /404/, '매핑에 없는 상태를 숨기면 화면에서 조용히 사라진다');
  assert.equal(notFound.retryable, true);
  const tooMany = describeAdminFailure({ status: 429 });
  assert.match(tooMany.title, /429/);

  // ── 상태도 종류도 모를 때: 지어내지 않는다 ──────────────────────────────────
  const unknown = describeAdminFailure({});
  assert.equal(unknown.detail, null, '없는 근거를 만들어 붙이지 않는다');
  assert.equal(unknown.href, null);
  assert.equal(unknown.retryable, true);
  // 0 은 상태 코드가 아니다 — 'HTTP 0' 을 화면에 내보내면 관리자가 그 숫자를 찾아 헤맨다.
  assert.equal(describeAdminFailure({ status: null }).detail, null);
  assert.equal(describeAdminFailure({ status: Number.NaN }).detail, null);
  // 빈 문자열 메시지가 근거인 척 하지 않는다.
  assert.equal(describeAdminFailure({ message: '   ' }).detail, null);

  // 모든 안내는 '무엇을 하면 되는지' 를 반드시 갖는다 — 이 모듈의 존재 이유다.
  for (const notice of [expired, noSession, forbidden, timeout, serverError, notFound, unknown]) {
    assert.ok(notice.action.trim().length > 0, `행동 문구가 비었다: ${notice.title}`);
    assert.ok(notice.retryable || notice.href, `재시도도 링크도 없으면 막다른 골목이다: ${notice.title}`);
  }

  // ── kindFromMessage: 상태 코드가 없는 경로(Supabase)에서 타임아웃만은 갈라낸다 ──
  assert.equal(kindFromMessage('AbortError: The operation was aborted.'), 'timeout');
  assert.equal(kindFromMessage('요청 시간이 초과되었습니다.'), 'timeout');
  assert.equal(kindFromMessage('TypeError: Failed to fetch'), 'network');
  // 확신할 수 없으면 짐작하지 않는다 — 틀린 지시는 침묵보다 나쁘다.
  assert.equal(kindFromMessage('permission denied for table congestion_logs'), null);
  assert.equal(kindFromMessage(''), null);
  assert.equal(kindFromMessage(null), null);
  assert.equal(kindFromMessage(undefined), null);

  // Supabase 타임아웃이 '알 수 없는 오류' 로 끝나지 않는다(회귀 방지).
  const supabaseTimeout = describeAdminFailure({
    kind: kindFromMessage('AbortError: signal is aborted without reason'),
    message: 'AbortError: signal is aborted without reason',
  });
  assert.equal(supabaseTimeout.retryable, true);
  assert.notEqual(supabaseTimeout.title, unknown.title);

  // ── adminFailureLine: 한 줄로 눌러도 근거를 잃지 않는다 ──────────────────────
  const line = adminFailureLine(serverError);
  assert.match(line, /서버 오류/);
  assert.match(line, /HTTP 500/, 'CSV 로 빠져나간 수치의 유일한 출처 표시다');
  assert.doesNotMatch(adminFailureLine(unknown), /\(\s*\)/, '근거가 없으면 빈 괄호를 남기지 않는다');

  // ── 배선 확인: 화면이 실제로 이 판정을 쓰는가 ────────────────────────────────
  const reportsSrc = readFileSync(join(WEB, 'app', 'admin', 'reports', 'page.tsx'), 'utf8');
  assert.match(reportsSrc, /describeAdminFailure\(/, '리포트 화면이 실패를 행동 가능한 문구로 바꾸지 않는다');
  // 상태 코드를 읽지 않으면 401(재로그인)·403(권한 없음)·5xx(서버 장애)가 한 문장으로 뭉개진다.
  assert.match(reportsSrc, /adminApiStatus\(/, '관리자 API 실패의 HTTP 상태를 읽지 않는다');
  assert.match(reportsSrc, /adminApiKind\(/, '타임아웃·연결 실패를 상태 없는 일반 오류로 뭉갠다');
  assert.match(reportsSrc, /notice\.retryable/, '재시도 버튼이 실패 종류와 무관하게 뜬다');
  assert.match(reportsSrc, /notice\.href/, '401/403 에서 로그인 경로를 보여주지 않는다');

  const apiSrc = readFileSync(join(WEB, 'lib', 'admin-api.ts'), 'utf8');
  assert.match(apiSrc, /class AdminApiError/, '관리자 API 가 상태 코드를 호출부까지 전달하지 않는다');
  assert.match(apiSrc, /response\.status/, '상태 코드를 에러에 싣지 않는다');
  // fetch 예외를 잡지 않으면 abort 가 DOMException 그대로 올라가고, DOMException 은 Error 가
  // 아니라서 화면에 사유 없는 '알 수 없는 오류' 만 남는다.
  assert.match(apiSrc, /"timeout"/, '타임아웃을 별도 종류로 분류하지 않는다');
  assert.match(apiSrc, /"network"/, '연결 실패를 별도 종류로 분류하지 않는다');
  assert.match(apiSrc, /"no-session"/, '세션 없음이 맨 Error 로 남아 있다');

  console.log('admin api failure tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
