import assert from 'node:assert/strict';
import {
  ACTION_LOG_EVENTS,
  ACTION_LOG_LIMITS,
  actionLogHosts,
  apiTargets,
  byteLength,
  capOutbox,
  classifyActionLogResponse,
  cleanProps,
  createActionLogCore,
  createLoggingFetch,
  describeFieldChange,
  describePlainTarget,
  describeTarget,
  findInteractive,
  hrefForLog,
  isActionLogRow,
  isTextEntry,
  isValueCapturable,
  jwtExpiry,
  maskText,
  sanitizePath,
  sanitizeQuery,
  shouldRecordActionLog,
  takeBatch,
  type ActionLogAuth,
  type ActionLogCoreDeps,
  type ActionLogRow,
} from './actionLog';

// 접속·조작 기록(lib/actionLog) — 켜는 조건 · 가리기 · 값을 읽는 칸 · 누른 것 설명 · 묶음/저장분 · 표가 없을 때 멈춤 ·
// fetch 감싸기. 브라우저 없이 가짜 저장소·fetch·타이머로 돈다(외부 호출 없음).

const OUTBOX = 'nextspot_action_outbox';
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── 이벤트 목록(DB CHECK 와 같은 순서) ──────────────────────────────────────
assert.deepEqual(
  [...ACTION_LOG_EVENTS],
  ['session_start', 'page_view', 'click', 'input', 'submit', 'search', 'voice', 'key', 'swipe', 'scroll', 'map', 'visibility', 'heartbeat', 'api', 'error', 'auth'],
);

// ── 켜는 조건 ─────────────────────────────────────────────────────────────
assert.equal(shouldRecordActionLog({ hostname: 'nextspot-nu.vercel.app', webdriver: false }), true);
assert.equal(shouldRecordActionLog({ hostname: 'NextSpot-NU.vercel.app' }), true, '주소는 대소문자를 가리지 않는다');
assert.equal(shouldRecordActionLog({ hostname: 'localhost', webdriver: false }), false, '로컬은 남기지 않는다');
assert.equal(shouldRecordActionLog({ hostname: 'nextspot-git-yunseong.vercel.app' }), false, 'Vercel 미리보기는 목록에 넣어야 남긴다');
assert.equal(shouldRecordActionLog({ hostname: 'nextspot-nu.vercel.app', webdriver: true }), false, '자동화(Playwright 등)는 남기지 않는다');
assert.equal(shouldRecordActionLog({ hostname: 'localhost', webdriver: true, flag: 'force' }), true, "'force' 는 주소·자동화를 둘 다 무시한다");
assert.equal(shouldRecordActionLog({ hostname: 'localhost', webdriver: false, flag: 'yes' }), false, "'force' 만 켠다");
assert.equal(shouldRecordActionLog({ hostname: 'qa.example.com', extraHosts: ' demo.example.com , QA.example.com ,' }), true);
assert.deepEqual(actionLogHosts(''), ['nextspot-nu.vercel.app']);
assert.deepEqual(actionLogHosts('a.example.com,,b.example.com'), ['nextspot-nu.vercel.app', 'a.example.com', 'b.example.com']);
assert.equal(shouldRecordActionLog(), false, 'window 가 없으면(프리렌더) 남기지 않는다');

// 브라우저에서 읽는 경로 — 추적 거부(Do Not Track)는 보지 않는다(개인정보 안내에 적은 1차 운영 기록).
{
  const g = globalThis as Record<string, unknown>;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousHosts = process.env.NEXT_PUBLIC_ACTION_LOG_HOSTS;
  try {
    g.window = { location: { hostname: 'nextspot-nu.vercel.app' } };
    Object.defineProperty(globalThis, 'navigator', { value: { webdriver: false, doNotTrack: '1' }, configurable: true, writable: true });
    assert.equal(shouldRecordActionLog(), true, '추적 거부(DNT)로 끄지 않는다');
    Object.defineProperty(globalThis, 'navigator', { value: { webdriver: true }, configurable: true, writable: true });
    assert.equal(shouldRecordActionLog(), false);
    (g.window as Record<string, unknown>).__NEXTSPOT_ACTION_LOG__ = 'force';
    assert.equal(shouldRecordActionLog(), true);
    g.window = { location: { hostname: 'staging.example.com' } };
    Object.defineProperty(globalThis, 'navigator', { value: { webdriver: false }, configurable: true, writable: true });
    process.env.NEXT_PUBLIC_ACTION_LOG_HOSTS = 'staging.example.com';
    assert.equal(shouldRecordActionLog(), true, 'NEXT_PUBLIC_ACTION_LOG_HOSTS 의 주소도 남긴다');
  } finally {
    delete g.window;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete g.navigator;
    if (previousHosts === undefined) delete process.env.NEXT_PUBLIC_ACTION_LOG_HOSTS;
    else process.env.NEXT_PUBLIC_ACTION_LOG_HOSTS = previousHosts;
  }
}

// ── 가리기 ────────────────────────────────────────────────────────────────
assert.equal(maskText('문의 judge.demo+1@example.co.kr 로 주세요'), '문의 [email] 로 주세요');
assert.equal(maskText('전화 010-1234-5678'), '전화 [phone]');
assert.equal(maskText('01012345678'), '[phone]');
assert.equal(maskText('+82 10 1234 5678 로'), '[phone] 로');
assert.equal(maskText('매장 02-123-4567'), '매장 [phone]');
assert.equal(maskText('대표 1588-1234'), '대표 [phone]');
assert.equal(maskText('주민 900101-1234567'), '주민 [num]');
assert.equal(maskText('사업자 123-45-67890'), '사업자 [num]');
assert.equal(maskText('1234-5678-9012-3456 카드'), '[num] 카드');
assert.equal(maskText('123456789'), '[num]', '아홉 자리 이상 숫자');
assert.equal(maskText('12345678'), '12345678', '여덟 자리까지는 남는다');
assert.equal(maskText('2026-11-12 10:00 예약'), '2026-11-12 10:00 예약', '날짜·시각은 남는다');
assert.equal(maskText('좌표 35.8372, 129.2095'), '좌표 [geo]', '좌표 한 쌍');
assert.equal(maskText('35.837,129.209 근처'), '[geo] 근처', '소수 셋째 자리 쌍도 좌표');
assert.equal(maskText('lat35.8372 pos_35.8372_x'), 'lat[geo] pos_[geo]_x', '글자·밑줄에 붙은 좌표');
assert.equal(maskText('평점 4.5 · 1.2km'), '평점 4.5 · 1.2km', '짧은 소수는 남는다');
assert.equal(maskText('(010)1234-5678'), '[phone]', '괄호 친 휴대폰 앞자리');
assert.equal(maskText('010–1234–5678 · 010—1234—5678'), '[phone] · [phone]', '다른 대시 문자');
assert.equal(maskText('홍길동@네이버.com 으로'), '[email] 으로', '한글 도메인 이메일');
assert.equal(maskText('see https://ex.com/a/b?token=abc&lat=35.1#x.'), 'see https://ex.com/a/b.', '글 속 URL 은 쿼리를 뗀다');
assert.equal(maskText('  여러   칸\n\n공백  '), '여러 칸 공백');
assert.equal(maskText('가'.repeat(100), 10), `${'가'.repeat(9)}…`);
assert.equal(maskText(null), '');
assert.equal(maskText(undefined), '');

// ── 쿼리 · 경로 · 링크 ────────────────────────────────────────────────────
assert.equal(sanitizeQuery(''), '');
assert.equal(sanitizeQuery('?code=abc&next=/merchant'), '?next=/merchant');
assert.equal(
  sanitizeQuery('?access_token=x&refresh_token=y&type=recovery&email=a@b.com&password=p&key=k&apikey=z&otp=1&signature=s&token=t&token_hash=h'),
  '',
  '인증·비밀 키는 통째로 뺀다',
);
assert.equal(
  sanitizeQuery('?facilityId=r1&lat=35.8372&lng=129.2095&name=황남 쌈밥'),
  '?facilityId=r1&lat=[geo]&lng=[geo]&name=황남 쌈밥',
);
assert.equal(sanitizeQuery('x=1&y=2&center=35,129&coords=a&Lat=1&mapx=129.2'), '?x=[geo]&y=[geo]&center=[geo]&coords=[geo]&Lat=[geo]&mapx=[geo]');
assert.equal(sanitizeQuery('?q=010-1234-5678'), '?q=[phone]');
assert.ok(sanitizeQuery(`?q=${'a'.repeat(500)}&r=${'b'.repeat(500)}`).length <= 200);
assert.equal(sanitizePath('/explore/%ED%99%A9%EB%82%A8'), '/explore/황남');
assert.equal(sanitizePath(''), '/');

const BASE = 'https://nextspot-nu.vercel.app/main';
assert.equal(hrefForLog('/explore/recommend?facilityId=r1&lat=35.8&lng=129.2', BASE), '/explore/recommend?facilityId=r1&lat=[geo]&lng=[geo]');
assert.equal(hrefForLog('/login?next=/merchant&code=abc', BASE), '/login?next=/merchant');
assert.equal(
  hrefForLog('https://map.kakao.com/link/to/황남쌈밥,35.8372,129.2095?ref=x', BASE),
  'https://map.kakao.com/link/to/황남쌈밥,[geo]',
  '바깥 링크는 쿼리 없이, 경로 속 좌표도 가린다',
);
assert.equal(hrefForLog('mailto:someone@example.com', BASE), 'mailto:');
assert.equal(hrefForLog('tel:010-1234-5678', BASE), 'tel:');
assert.equal(hrefForLog('#top', BASE), '#');
assert.equal(hrefForLog('kakaomap://route?sp=35.8,129.2', BASE), 'kakaomap:');
assert.equal(hrefForLog('', BASE), null);

// ── 가짜 요소 ──────────────────────────────────────────────────────────────
interface FakeOptions {
  text?: string;
  value?: string;
  checked?: boolean;
  parent?: Element | null;
  selectedOptions?: { label?: string; text?: string }[];
}

function el(tag: string, attrs: Record<string, string> = {}, opts: FakeOptions = {}): Element {
  return {
    tagName: tag.toUpperCase(),
    parentElement: opts.parent ?? null,
    innerText: opts.text,
    value: opts.value,
    checked: opts.checked,
    selectedOptions: opts.selectedOptions,
    getAttribute: (name: string) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    hasAttribute: (name: string) => Object.prototype.hasOwnProperty.call(attrs, name),
  } as unknown as Element;
}

// ── 값을 읽는 칸 — 검색칸만, 비밀번호·이메일·전화는 표시가 있어도 절대 ──────────
assert.equal(isValueCapturable(el('input', { type: 'search' })), true);
assert.equal(isValueCapturable(el('input', { type: 'text', role: 'searchbox' })), true);
assert.equal(isValueCapturable(el('input', { type: 'text', 'data-log-value': 'search' })), true);
assert.equal(isValueCapturable(el('textarea', { 'data-log-value': 'search' })), true);
assert.equal(isValueCapturable(el('input', { type: 'text' })), false, '보통 글 칸은 값을 읽지 않는다');
assert.equal(isValueCapturable(el('input', {})), false);
assert.equal(isValueCapturable(el('textarea', { name: 'content' })), false, '문의 본문');
assert.equal(isValueCapturable(el('input', { type: 'password', 'data-log-value': 'search' })), false, '비밀번호는 절대');
assert.equal(isValueCapturable(el('input', { type: 'email', 'data-log-value': 'search' })), false, '이메일은 절대');
assert.equal(isValueCapturable(el('input', { type: 'tel', role: 'searchbox' })), false, '전화는 절대');
assert.equal(isValueCapturable(el('input', { type: 'search', autocomplete: 'email' })), false);
assert.equal(isValueCapturable(el('input', { type: 'search', autocomplete: 'current-password' })), false);
assert.equal(isValueCapturable(el('input', { type: 'text', autocomplete: 'cc-number', 'data-log-value': 'search' })), false);
assert.equal(isValueCapturable(el('input', { type: 'text', autocomplete: 'nickname', 'data-log-value': 'search' })), false, '프로필 칸');
assert.equal(isValueCapturable(el('div', { role: 'searchbox' })), false);
assert.equal(isValueCapturable(el('input', { type: 'search' }, { parent: el('section', { 'data-log-private': '' }) })), false, '비공개 영역');
assert.equal(isValueCapturable(null), false);

{
  const password = describeFieldChange(el('input', { type: 'password', name: 'password' }, { value: 'hunter2-secret' }));
  assert.deepEqual(password, { field: 'password', type: 'password' }, '비밀번호 칸은 길이도 남기지 않는다');
  const email = describeFieldChange(el('input', { type: 'email', placeholder: '이메일', autocomplete: 'email' }, { value: 'judge-demo@example.invalid' }));
  assert.deepEqual(email, { field: '이메일', type: 'email' });
  assert.ok(!JSON.stringify(email).includes('judge-demo'));
  const typed = '황남 010-1234-5678';
  const search = describeFieldChange(el('input', { type: 'text', 'data-log-value': 'search', placeholder: '경주 장소 검색' }, { value: typed }));
  assert.deepEqual(search, { field: '경주 장소 검색', type: 'text', length: typed.length, value: '황남 [phone]' });
  const nickname = describeFieldChange(el('input', { type: 'text', id: 'displayName' }, { value: '홍길동' }));
  assert.deepEqual(nickname, { field: 'displayName', type: 'text', length: 3 }, '프로필 값은 남기지 않는다');
  const body = '환불 문의입니다 010-0000-0000';
  const textarea = describeFieldChange(el('textarea', { name: 'content' }, { value: body, text: body }));
  assert.deepEqual(textarea, { field: 'content', type: 'textarea', length: body.length }, '문의 본문은 남기지 않는다');
  assert.deepEqual(describeFieldChange(el('input', { type: 'checkbox', name: 'agree' }, { checked: true })), { field: 'agree', type: 'checkbox', checked: true });
  assert.deepEqual(
    describeFieldChange(el('select', { 'aria-label': '언어' }, { selectedOptions: [{ label: 'English' }] })),
    { field: '언어', type: 'select', option: 'English' },
  );
  assert.deepEqual(
    describeFieldChange(el('input', { type: 'search' }, { value: '카페', parent: el('div', { 'data-log-private': '' }) })),
    { field: 'input', type: 'search', length: 2 },
    '비공개 영역의 검색칸은 값을 남기지 않는다',
  );
}

assert.equal(isTextEntry(el('input', {})), true);
assert.equal(isTextEntry(el('input', { type: 'search' })), true);
assert.equal(isTextEntry(el('textarea')), true);
assert.equal(isTextEntry(el('input', { type: 'checkbox' })), false);
assert.equal(isTextEntry(el('button')), false);

// ── 누른 것 설명 ──────────────────────────────────────────────────────────
{
  const clear = el('button', { type: 'button', 'aria-label': '검색어 지우기' }, { text: 'X' });
  assert.deepEqual(describeTarget(clear, { base: BASE }), { tag: 'button', name: '검색어 지우기', type: 'button' });

  const save = el('button', { 'data-testid': 'save-btn' }, { text: '저장\n3' });
  const icon = el('svg', {}, { parent: el('span', {}, { text: '저장', parent: save }) });
  const found = findInteractive(icon);
  assert.equal(found, save, '가장 가까운 버튼을 찾는다');
  assert.deepEqual(describeTarget(save, { base: BASE }), { tag: 'button', name: '저장', testid: 'save-btn' }, '보이는 글자의 첫 줄');

  const link = el('a', { href: '/explore/recommend?facilityId=r1&lat=35.8&lng=129.2&code=x' }, { text: '추천 보기' });
  assert.deepEqual(describeTarget(link, { base: BASE }), { tag: 'a', name: '추천 보기', href: '/explore/recommend?facilityId=r1&lat=[geo]&lng=[geo]' });

  const external = el('a', { href: 'https://place.map.kakao.com/12345?ref=share', title: '카카오맵에서 보기' });
  assert.deepEqual(describeTarget(external, { base: BASE }), { tag: 'a', name: '카카오맵에서 보기', href: 'https://place.map.kakao.com/12345' });

  // 글 입력 칸 — React 는 value '속성' 까지 맞추므로 value 를 이름으로 쓰지 않는다.
  const input = el('input', { type: 'text', value: '내가 친 글', placeholder: '닉네임' }, { value: '내가 친 글' });
  assert.deepEqual(describeTarget(input, { base: BASE }), { tag: 'input', name: '닉네임', type: 'text' });
  const submit = el('input', { type: 'submit', value: '보내기' });
  assert.equal(describeTarget(submit, { base: BASE }).name, '보내기', '제출 input 의 value 속성은 버튼 글자다');
  // textarea 의 innerText(처음 값)는 이름이 되지 않는다.
  assert.deepEqual(describeTarget(el('textarea', { name: 'content' }, { text: '문의 본문' }), { base: BASE }), { tag: 'textarea' });

  assert.equal(describeTarget(el('button', {}, { text: 'openapi@gmail.com 입력' }), { base: BASE }).name, '[email] 입력', '버튼 속 이메일도 가린다');
  assert.equal(describeTarget(el('button', { 'data-log-name': '심사 계정 채우기' }, { text: 'openapi@gmail.com 입력' }), { base: BASE }).name, '심사 계정 채우기');

  const privateButton = el('button', {}, { text: '홍길동 님의 문의', parent: el('div', { 'data-log-private': '' }) });
  assert.deepEqual(describeTarget(privateButton, { base: BASE }), { tag: 'button', private: true }, '비공개 영역에서는 글자를 읽지 않는다');
  assert.deepEqual(describeTarget(el('button', {}, { text: '사용자 a@b.com 삭제' }), { base: BASE, privateZone: true }), { tag: 'button', private: true });

  // 버튼이 아닌 곳(문의 목록 줄처럼 div 에 onClick) — 글자는 읽지 않고 자리 표시만.
  const ticketRow = el('div', {}, { text: '홍길동 · 환불 문의', parent: el('div', { 'data-testid': 'ticket-list' }) });
  assert.equal(findInteractive(ticketRow), null);
  assert.deepEqual(describePlainTarget(ticketRow), { tag: 'div', plain: true, ctx: 'testid:ticket-list' });
  assert.deepEqual(describePlainTarget(null), { tag: 'unknown', plain: true });
  assert.equal(findInteractive(el('div', { 'data-log': 'card' })) !== null, true, 'data-log 표시도 누를 수 있는 것으로 본다');
  assert.equal(findInteractive(el('div', { role: 'tab' })) !== null, true);
}

// ── props 크기 ────────────────────────────────────────────────────────────
{
  const big = cleanProps({ a: '가'.repeat(400), b: '나'.repeat(400), c: '다'.repeat(400), d: '라'.repeat(400), n: 1, bad: Number.NaN, skip: undefined });
  assert.ok(byteLength(JSON.stringify(big)) <= ACTION_LOG_LIMITS.propsBytes, 'props 는 상한 아래로 줄인다');
  assert.equal(big.n, 1);
  assert.equal(big.bad, null);
  assert.ok(!('skip' in big));
  assert.deepEqual(cleanProps({ q: 'a@b.com 로', langs: ['ko-KR', 'en-US'] }), { q: '[email] 로', langs: ['ko-KR', 'en-US'] }, '문자열은 전부 가린다');
  assert.deepEqual(cleanProps(null), {});
}

// ── 묶음 · 저장분 상한 ────────────────────────────────────────────────────
function row(seq: number, name = ''): ActionLogRow {
  return {
    occurred_at: new Date(1_800_000_000_000 + seq).toISOString(),
    device_id: 'device-0001',
    session_id: 'session-0001',
    seq,
    event: 'click',
    page: '/main',
    host: 'nextspot-nu.vercel.app',
    locale: 'ko',
    props: name ? { name } : {},
  };
}

assert.equal(isActionLogRow(row(0)), true);
assert.equal(isActionLogRow({ ...row(0), event: 'nope' }), false);
assert.equal(isActionLogRow({ ...row(0), extra: 1 }), false, '모르는 칸이 붙은 줄은 저장분에서 버린다');
assert.equal(isActionLogRow({ ...row(0), device_id: 'short' }), false);

{
  const rows = Array.from({ length: 120 }, (_, i) => row(i));
  assert.equal(takeBatch(rows).length, ACTION_LOG_LIMITS.batchRows, '한 번에 50줄');
  const fat = Array.from({ length: 40 }, (_, i) => row(i, '가'.repeat(600)));
  const fatBatch = takeBatch(fat);
  assert.ok(fatBatch.length > 0 && fatBatch.length < 40, '큰 줄은 60KB 에서 끊는다');
  assert.ok(byteLength(JSON.stringify(fatBatch)) <= ACTION_LOG_LIMITS.batchBytes);
  const capped = capOutbox(Array.from({ length: 310 }, (_, i) => i));
  assert.equal(capped.length, ACTION_LOG_LIMITS.outboxRows);
  assert.equal(capped[0], 10, '오래된 것부터 버린다');
  assert.equal(capped[capped.length - 1], 309);
}

assert.equal(classifyActionLogResponse(201), 'ok');
assert.equal(classifyActionLogResponse(204), 'ok');
assert.equal(classifyActionLogResponse(404), 'schema');
assert.equal(classifyActionLogResponse(404, 'PGRST205'), 'schema');
assert.equal(classifyActionLogResponse(400, 'PGRST204'), 'schema', '칸 이름이 다르면 줄을 버리지 않고 멈춘다');
assert.equal(classifyActionLogResponse(401), 'auth');
assert.equal(classifyActionLogResponse(403, '42501'), 'forbidden');
assert.equal(classifyActionLogResponse(400, '23514'), 'reject');
assert.equal(classifyActionLogResponse(409, '23505'), 'reject');
assert.equal(classifyActionLogResponse(503), 'retry');
assert.equal(classifyActionLogResponse(0), 'retry');

// ── 보내기(가짜 fetch · 저장소 · 타이머) ─────────────────────────────────
function memoryStorage() {
  const map = new Map<string, string>();
  let writes = 0;
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes += 1;
      map.set(key, value);
    },
    get writes() {
      return writes;
    },
  };
}

function fakeTimers() {
  let id = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      id += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
  };
}

interface Call {
  url: string;
  init: RequestInit;
  rows: ActionLogRow[];
  auth: string;
  status: number;
}

function fakeFetch(respond: (call: Call) => { status: number; body?: string }) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const call: Call = { url, init, rows: JSON.parse(String(init.body)) as ActionLogRow[], auth: headers.Authorization, status: 0 };
    calls.push(call);
    const res = respond(call);
    call.status = res.status;
    return { status: res.status, text: async () => res.body ?? '' };
  };
  return { fn, calls };
}

function core(overrides: Partial<ActionLogCoreDeps> & Pick<ActionLogCoreDeps, 'fetch'>) {
  const timers = fakeTimers();
  return createActionLogCore({
    endpoint: 'https://sb.example.co/rest/v1/action_logs',
    anonKey: 'anon-key',
    storage: memoryStorage(),
    entryKey: () => 'session-0001',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
}

function readOutbox(storage: { getItem(key: string): string | null }) {
  return JSON.parse(storage.getItem(OUTBOX) ?? '{"v":1,"s":{}}') as { s: Record<string, { live: number; rows: ActionLogRow[] }> };
}

void (async () => {
  // 3초 뒤 또는 25줄에 보낸다 · 머리말 · anon 키
  {
    const timers = fakeTimers();
    const net = fakeFetch(() => ({ status: 201 }));
    const log = core({ fetch: net.fn, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    log.push(row(0));
    assert.equal(net.calls.length, 0, '첫 줄은 바로 보내지 않는다');
    assert.ok([...timers.pending.values()].some((t) => t.ms === ACTION_LOG_LIMITS.flushDelayMs), '3초 뒤 보내기를 예약한다');
    for (let i = 1; i < ACTION_LOG_LIMITS.flushAtRows; i += 1) log.push(row(i));
    await settle();
    assert.equal(net.calls.length, 1, '25줄이 모이면 바로 보낸다');
    assert.equal(net.calls[0].url, 'https://sb.example.co/rest/v1/action_logs');
    assert.equal(net.calls[0].rows.length, ACTION_LOG_LIMITS.flushAtRows);
    const headers = net.calls[0].init.headers as Record<string, string>;
    assert.deepEqual(headers, { apikey: 'anon-key', Authorization: 'Bearer anon-key', 'Content-Type': 'application/json', Prefer: 'return=minimal' });
    assert.equal(net.calls[0].init.keepalive, false);
    assert.equal(log.queue.length, 0);
  }

  // 세션이 있으면 그 토큰으로 · 로그인 전 게스트 줄은 게스트 토큰으로 · 모르는 계정 줄은 anon 키로
  {
    const net = fakeFetch(() => ({ status: 201 }));
    const log = core({
      fetch: net.fn,
      currentAuth: async () => ({ sub: 'member', token: 'member-token' }),
      tokenForSub: (sub) => (sub === 'guest' ? 'guest-token' : null),
    });
    log.push(row(0), 'guest');
    log.push(row(1), 'guest');
    log.push(row(2), 'member');
    log.push(row(3), null);
    log.push(row(4), 'gone');
    log.push(row(5), '');
    for (let i = 0; i < 6; i += 1) await log.flush();
    assert.deepEqual(
      net.calls.map((c) => [c.auth, c.rows.map((r) => r.seq)]),
      // 계정을 모르는 줄(null)·로그인 안 한 때의 줄('')은 지금 계정이 아니라 anon 키로 — 나중 계정에 붙지 않게.
      [['Bearer guest-token', [0, 1]], ['Bearer member-token', [2]], ['Bearer anon-key', [3]], ['Bearer anon-key', [4]], ['Bearer anon-key', [5]]],
      '줄은 만들 때의 계정으로 묶여 들어간다',
    );
  }

  // 401 — 세션을 한 번만 새로 받아 다시, 그래도 안 되면 그 묶음은 anon 키로
  {
    let refreshes = 0;
    const net = fakeFetch((call) => (call.auth === 'Bearer anon-key' ? { status: 201 } : { status: 401 }));
    const auth: ActionLogAuth = { sub: 'user-a', token: 'token-1' };
    const log = core({
      fetch: net.fn,
      currentAuth: async () => auth,
      refreshAuth: async () => {
        refreshes += 1;
        return { sub: 'user-a', token: 'token-2' };
      },
    });
    log.push(row(0), 'user-a');
    await log.flush();
    assert.deepEqual(net.calls.map((c) => c.auth), ['Bearer token-1', 'Bearer token-2', 'Bearer anon-key']);
    assert.equal(log.queue.length, 0);
    log.push(row(1), 'user-a');
    await log.flush();
    assert.equal(refreshes, 1, '세션 새로 받기는 페이지당 한 번');
    assert.deepEqual(net.calls.slice(3).map((c) => c.auth), ['Bearer token-1', 'Bearer anon-key']);
  }

  // 실패하면 물러난다 · 저장분은 300줄 · outbox 는 줄마다 쓰지 않는다
  {
    const storage = memoryStorage();
    const timers = fakeTimers();
    const net = fakeFetch(() => ({ status: 503 }));
    const log = core({ fetch: net.fn, storage, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    for (let i = 0; i < 310; i += 1) log.push(row(i));
    await settle();
    assert.equal(net.calls.length, 1, '실패한 뒤에는 25줄마다 두드리지 않는다');
    assert.equal(log.queue.length, ACTION_LOG_LIMITS.outboxRows, '300줄 넘으면 오래된 것부터 버린다');
    assert.equal(log.queue[0].seq, 10);
    assert.equal(storage.writes, 0, 'outbox 는 몰아서 쓴다(줄마다 쓰지 않는다)');
    const backoff = [...timers.pending.values()].map((t) => t.ms).filter((ms) => ms !== ACTION_LOG_LIMITS.outboxWriteDelayMs);
    assert.ok(backoff.some((ms) => ms >= 1500 && ms <= 2500), `물러났다 다시 보내기를 예약한다 (${backoff.join(',')})`);
    log.persistNow();
    const saved = readOutbox(storage);
    assert.equal(saved.s['session-0001'].rows.length, ACTION_LOG_LIMITS.outboxRows);
    assert.equal(saved.s['session-0001'].live, 1);
  }

  // 표가 아직 없다(404 · PGRST205) — 이 페이지에서는 멈추고 줄은 지킨다 → 다음 방문이 이어받아 보낸다
  {
    const storage = memoryStorage();
    const missing = fakeFetch(() => ({ status: 404, body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.action_logs'" }) }));
    const log = core({ fetch: missing.fn, storage });
    for (let i = 0; i < 3; i += 1) log.push(row(i));
    await log.flush();
    assert.equal(missing.calls.length, 1);
    assert.equal(log.paused, true);
    assert.equal(log.queue.length, 3, '표가 없어도 줄은 지킨다');
    assert.equal(readOutbox(storage).s['session-0001'].rows.length, 3, '멈출 때 저장분에 바로 쓴다');
    log.push(row(3));
    await log.flush();
    await settle();
    assert.equal(missing.calls.length, 1, '멈춘 뒤에는 이 페이지에서 다시 보내지 않는다');
    log.release(); // pagehide

    const ok = fakeFetch(() => ({ status: 201 }));
    const next = core({ fetch: ok.fn, storage });
    next.adopt();
    assert.deepEqual(next.queue.map((r) => r.seq), [0, 1, 2, 3], '새로고침한 같은 탭이 이어받는다');
    await next.flush();
    assert.equal(ok.calls.length, 1);
    assert.equal(next.queue.length, 0);
  }

  // 잘못된 줄 하나가 묶음을 막지 않는다 — 반씩 나눠 그 줄만 버린다
  {
    const net = fakeFetch((call) => (call.rows.some((r) => r.seq === 2) ? { status: 400, body: '{"code":"23514"}' } : { status: 201 }));
    const log = core({ fetch: net.fn });
    for (let i = 0; i < 5; i += 1) log.push(row(i));
    await log.flush();
    const sent = net.calls.filter((c) => c.status === 201).flatMap((c) => c.rows.map((r) => r.seq)).sort((a, b) => a - b);
    assert.deepEqual(sent, [0, 1, 3, 4]);
    assert.equal(log.queue.length, 0);
    assert.equal(log.paused, false);
  }

  // pagehide — keepalive 로 바로 보내고, 보낸 셈 친 줄은 저장분에서 뺀다(다음 방문에 또 보내지 않게)
  {
    const storage = memoryStorage();
    const net = fakeFetch(() => ({ status: 201 }));
    const log = core({ fetch: net.fn, storage });
    log.adopt();
    log.push(row(0));
    log.push(row(1));
    log.unload();
    assert.equal(net.calls.length, 1, '문서가 내려가기 전에 바로 보낸다');
    assert.equal(net.calls[0].init.keepalive, true);
    assert.equal(readOutbox(storage).s['session-0001'], undefined);
    await settle();
  }

  // 로그인 상태가 정해지기 전에 만든 줄은 정해진 상태로 묶인다(assignSub) — 이미 정해진 줄은 그대로.
  {
    const net = fakeFetch(() => ({ status: 201 }));
    const log = core({ fetch: net.fn, currentAuth: async () => ({ sub: 'member', token: 'member-token' }) });
    const early = [row(0), row(1)];
    log.push(early[0], null);
    log.push(early[1], null);
    log.push(row(2), 'member');
    log.assignSub(early, 'member');
    log.assignSub([log.queue[2]], 'guest');
    await log.flush();
    assert.deepEqual(net.calls.map((c) => [c.auth, c.rows.map((r) => r.seq)]), [['Bearer member-token', [0, 1, 2]]]);
  }

  // pagehide 에 토큰이 낡았으면(숨긴 탭은 갱신이 멈춘다) 보내지 않고 저장분에 남긴다 — 401 뒤 다시 보낼 기회가 없다.
  {
    const storage = memoryStorage();
    const net = fakeFetch(() => ({ status: 201 }));
    const log = core({
      fetch: net.fn,
      storage,
      cachedAuth: () => ({ sub: 'member', token: 'old-token' }),
      isTokenFresh: (token) => token !== 'old-token',
    });
    log.adopt();
    log.push(row(0), 'member');
    log.unload();
    assert.equal(net.calls.length, 0, '낡은 토큰으로는 보내지 않는다');
    assert.deepEqual(readOutbox(storage).s['session-0001'].rows.map((r) => r.seq), [0], '다음 방문이 보내도록 남긴다');
  }

  // 탭 복제 판별 · 주인이 떠난 칸 이어받기 · 살아 있는 탭의 칸은 건드리지 않기
  {
    const storage = memoryStorage();
    let t = 10_000_000;
    const ok = () => fakeFetch(() => ({ status: 201 })).fn;
    const tabA = core({ fetch: ok(), storage, entryKey: () => 'session-aaaa', now: () => t });
    tabA.adopt();
    assert.equal(tabA.liveElsewhere('session-aaaa'), true, '같은 세션 번호로 살아 있는 탭이 있다');
    t += 120_000;
    assert.equal(tabA.liveElsewhere('session-aaaa'), false, '90초 넘게 소식이 없으면 살아 있다고 보지 않는다');
    tabA.touch();
    assert.equal(tabA.liveElsewhere('session-aaaa'), true);
    tabA.push(row(7));
    tabA.release();

    const tabC = core({ fetch: ok(), storage, entryKey: () => 'session-cccc', now: () => t });
    tabC.adopt();
    assert.deepEqual(tabC.queue.map((r) => r.seq), [7], '주인이 떠난 칸은 다른 탭이 이어받는다');
    assert.equal(readOutbox(storage).s['session-aaaa'], undefined);
    tabC.push(row(8));
    tabC.persistNow();

    const tabD = core({ fetch: ok(), storage, entryKey: () => 'session-dddd', now: () => t });
    tabD.adopt();
    assert.equal(tabD.queue.length, 0, '살아 있는 탭의 칸은 가져가지 않는다');
    assert.ok(readOutbox(storage).s['session-cccc'].rows.length >= 1);

    // 다른 탭이 오래 멈춘 탭의 칸을 가져갔으면, 돌아온 탭은 그때 저장한 줄을 다시 보내지 않는다.
    t += 11 * 60_000;
    const tabE = core({ fetch: ok(), storage, entryKey: () => 'session-eeee', now: () => t });
    tabE.adopt();
    assert.ok(tabE.queue.some((r) => r.seq === 8), '10분 넘게 소식 없는 칸은 이어받는다');
    tabC.reclaim();
    assert.ok(!tabC.queue.some((r) => r.seq === 8), '넘겨준 줄은 돌아온 탭이 다시 보내지 않는다');
  }

  // ── fetch 감싸기 — API 만, 경로만(쿼리·본문 없음), 이 기록의 전송은 빼고, 네트워크 오류는 0 ─────
  {
    const targets = apiTargets('https://api.example.com', 'https://sb.example.co');
    const seen: unknown[] = [];
    const original = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/fail')) throw new TypeError('Failed to fetch');
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const wrapped = createLoggingFetch(original, { targets, onCall: (info) => seen.push(info), now: () => 100 });
    await wrapped('https://api.example.com/api/v1/recommendations?lat=35.8372&lng=129.2095&email=a@b.com', { method: 'post', body: '{"lat":35.8372}' });
    await wrapped('https://sb.example.co/rest/v1/facilities?select=id,name&region=eq.gyeongju');
    await wrapped('https://sb.example.co/rest/v1/action_logs', { method: 'POST', body: '[]' });
    await wrapped('https://sb.example.co/rest/v1/action_logs?select=*');
    await wrapped('https://sb.example.co/rest/v1/rpc/action_log_rows', { method: 'POST', body: '{}' });
    await wrapped('https://other.example.net/api/v1/x?y=1');
    await wrapped(new Request('https://sb.example.co/auth/v1/token?grant_type=password', { method: 'POST' }));
    await wrapped(new URL('https://api.example.com/api/v1/users/a%40b.com/visits?x=1'));
    await assert.rejects(wrapped('https://api.example.com/api/v1/fail?q=1'));
    await settle();
    assert.deepEqual(seen, [
      { svc: 'api', method: 'POST', path: '/api/v1/recommendations', status: 204, ms: 0 },
      { svc: 'supabase', method: 'GET', path: '/rest/v1/facilities', status: 204, ms: 0 },
      { svc: 'supabase', method: 'POST', path: '/auth/v1/token', status: 204, ms: 0 },
      { svc: 'api', method: 'GET', path: '/api/v1/users/[email]/visits', status: 204, ms: 0 },
      { svc: 'api', method: 'GET', path: '/api/v1/fail', status: 0, ms: 0 },
    ]);
    const text = JSON.stringify(seen);
    assert.ok(!text.includes('?'), '쿼리스트링을 담지 않는다');
    assert.ok(!text.includes('35.8372') && !text.includes('grant_type'), '쿼리·본문 값을 담지 않는다');
    assert.ok(!text.includes('action_logs'), '이 기록 자체의 전송은 남기지 않는다');
  }

  // 시작할 때 skip 이면(기록 보기 화면) 응답이 화면을 옮긴 뒤 와도 남기지 않는다.
  {
    let onViewer = true;
    const seen: unknown[] = [];
    const wrapped = createLoggingFetch((async () => new Response(null, { status: 200 })) as typeof fetch, {
      targets: apiTargets('https://api.example.com', 'https://sb.example.co'),
      onCall: (info) => seen.push(info),
      skip: () => onViewer,
    });
    const pending = wrapped('https://sb.example.co/rest/v1/facilities');
    onViewer = false;
    await pending;
    await wrapped('https://sb.example.co/rest/v1/facilities');
    await settle();
    assert.equal(seen.length, 1);
  }

  // JWT exp — 서명은 보지 않고 만료만 읽는다.
  {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    assert.equal(jwtExpiry(`${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp: 1_800_000_000 })}.sig`), 1_800_000_000);
    assert.equal(jwtExpiry('not-a-jwt'), null);
    assert.equal(jwtExpiry('your-supabase-anon-key'), null);
  }

  console.log('actionLog tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
