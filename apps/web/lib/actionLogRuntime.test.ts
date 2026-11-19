import assert from 'node:assert/strict';

// 접속·조작 기록(lib/actionLog)의 브라우저 배선 — 설치 한 번 · 문서 리스너 · fetch 감싸기 · pagehide 의 keepalive 전송 ·
// /dev/activity 에서는 화면 열람만. 순수 규칙은 lib/actionLog.test.ts 가 잠그고, 여기서는 그 규칙이 실제 이벤트 경로로
// 이어지는지를 가짜 window/document 로 본다(외부 호출 없음 — fetch 는 가짜, Supabase 주소는 자리표시자).

type Handler = (event: unknown) => void;

function eventTarget() {
  const map = new Map<string, Handler[]>();
  return {
    addEventListener: (type: string, fn: Handler) => {
      map.set(type, [...(map.get(type) ?? []), fn]);
    },
    removeEventListener: () => {},
    fire: (type: string, event: unknown) => {
      for (const fn of map.get(type) ?? []) fn(event);
    },
    count: (type: string) => (map.get(type) ?? []).length,
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

class FakeElement {
  tagName: string;
  parentElement: FakeElement | null;
  innerText: string;
  value?: string;
  private attrs: Record<string, string>;
  constructor(tag: string, attrs: Record<string, string> = {}, text = '', parent: FakeElement | null = null) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.innerText = text;
    this.parentElement = parent;
  }
  getAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  hasAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }
}

interface Post {
  body: { event: string; seq: number; page: string; host: string; locale: string; props: Record<string, unknown> }[];
  headers: Record<string, string>;
  keepalive?: boolean;
}

const posts: Post[] = [];
const passedThrough: string[] = [];
const doc = Object.assign(eventTarget(), {
  visibilityState: 'visible',
  documentElement: { lang: 'ko' },
  referrer: 'https://search.naver.com/search.naver?query=%EA%B2%BD%EC%A3%BC',
  scrollingElement: { scrollTop: 0, scrollHeight: 2000, clientHeight: 800, scrollWidth: 390, clientWidth: 390, scrollLeft: 0 },
  body: {},
  getElementById: () => null,
});
const win = Object.assign(eventTarget(), {
  location: {
    hostname: 'localhost',
    host: 'localhost:3000',
    pathname: '/main',
    search: '?lat=35.8372&lng=129.2095&code=oauth-secret',
    href: 'http://localhost:3000/main?lat=35.8372&lng=129.2095&code=oauth-secret',
  },
  document: doc,
  // Next 라우터처럼 주소만 바꾸는 history — 쿼리만 바뀐 이동을 page_view 로 남기는지 본다.
  history: {
    state: null as unknown,
    pushState(state: unknown, _title: string, url?: string | URL | null) {
      this.state = state;
      if (url) setUrl(String(url));
    },
    replaceState(state: unknown, _title: string, url?: string | URL | null) {
      this.state = state;
      if (url) setUrl(String(url));
    },
  },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  navigator: { webdriver: true, languages: ['ko-KR', 'en-US', 'ja', 'zh'], language: 'ko-KR', maxTouchPoints: 5 },
  innerWidth: 390,
  innerHeight: 844,
  screen: { width: 390, height: 844 },
  devicePixelRatio: 3,
  matchMedia: () => ({ matches: false }),
  // e2e 와 같은 강제 켜기 — 자동화(webdriver)·로컬 주소여도 남긴다.
  __NEXTSPOT_ACTION_LOG__: 'force',
  fetch: async (url: string, init: RequestInit = {}) => {
    if (String(url).includes('/rest/v1/action_logs') && init.method === 'POST') {
      posts.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, keepalive: init.keepalive });
      return new Response(null, { status: 201 });
    }
    passedThrough.push(String(url));
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

function setUrl(url: string) {
  const next = new URL(url, win.location.href);
  win.location.pathname = next.pathname;
  win.location.search = next.search;
  win.location.href = next.href;
}

const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = doc;
g.localStorage = win.localStorage;
g.Element = FakeElement;
g.HTMLFormElement = class {};
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

void (async () => {
  const { installActionLog, logAction, logSearch, sanitizeQuery } = await import('./actionLog');
  const originalFetch = win.fetch;
  installActionLog();
  installActionLog();
  assert.equal(doc.count('click'), 1, '두 번 설치해도 리스너는 한 벌');
  assert.notEqual(win.fetch, originalFetch, 'window.fetch 를 감쌌다');

  // 버튼 안의 글자를 눌렀다 · 버튼이 아닌 줄을 눌렀다(사람 글은 읽지 않는다)
  const button = new FakeElement('button', { 'data-testid': 'go' }, '바로 갈래요\n(도보 길안내)');
  doc.fire('click', { target: new FakeElement('span', {}, '바로 갈래요', button) });
  doc.fire('click', { target: new FakeElement('div', {}, '홍길동 010-1234-5678 환불 문의', new FakeElement('div', { id: 'tickets' })) });
  // 검색칸(값은 가려서) · 비밀번호 칸(값도 길이도 없음)
  const search = new FakeElement('input', { type: 'text', 'data-log-value': 'search', placeholder: '검색' });
  search.value = '카페 someone@example.com';
  doc.fire('change', { target: search });
  const password = new FakeElement('input', { type: 'password', name: 'pw' });
  password.value = 'never-log-this';
  doc.fire('change', { target: password });
  logAction('page_view', { from: null, nav: 'load', query: sanitizeQuery(win.location.search) });
  logSearch('황남 010-9999-0000', 'main', 'enter');
  // 같은 경로에서 쿼리만 바뀐 이동 — 한 줄(nav='query'). 같은 주소로 다시 쓰기·인증 값만 바뀐 것은 남기지 않는다.
  win.history.pushState(null, '', '/main?tab=cafe&lat=35.8372');
  win.history.replaceState({ internal: true }, '', '/main?tab=cafe&lat=35.8372');
  win.history.replaceState(null, '', '/main?tab=cafe&lat=35.8372&code=oauth-secret-2');
  win.fire('popstate', {});

  // API 호출은 감싼 fetch 를 지나 원래 fetch 로 그대로 간다 — 기록에는 경로만.
  const wrapped = win.fetch as unknown as FetchLike;
  const res = await wrapped('https://your-supabase-project.supabase.co/rest/v1/facilities?select=*&lat=35.8372');
  assert.equal(res.status, 200, '응답은 그대로 돌려준다');
  await wrapped('http://localhost:8000/api/v1/weather?lat=35.8372&lng=129.2095');
  await wrapped('http://127.0.0.1:3000/_next/static/chunk.js');
  assert.equal(passedThrough.length, 3);
  await new Promise((resolve) => setTimeout(resolve, 50)); // Supabase 의 INITIAL_SESSION

  // 25줄 전이라 아직 보내지 않았다 — pagehide 에서 keepalive 로 바로(동기) 보낸다.
  assert.equal(posts.length, 0, '3초 전에는 보내지 않는다');
  win.fire('pagehide', { persisted: false });
  assert.equal(posts.length, 1, 'pagehide 에서 바로 보낸다');
  const sent = posts[0];
  assert.equal(sent.keepalive, true);
  assert.equal(sent.headers.Prefer, 'return=minimal');
  assert.equal(sent.headers.apikey, sent.headers.Authorization.replace(/^Bearer /, ''), '세션이 없으면 anon 키로');
  const rows = sent.body;
  const events = rows.map((r) => r.event);
  assert.equal(events[0], 'session_start');
  assert.equal(rows[0].seq, 0);
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i), '순번은 0부터 빈틈없이');
  for (const event of ['click', 'input', 'page_view', 'search', 'api', 'auth', 'visibility']) assert.ok(events.includes(event), `${event} 줄이 없다`);
  assert.ok(rows.every((r) => r.host === 'localhost:3000' && r.locale === 'ko' && r.page === '/main'));

  const start = rows[0].props;
  assert.equal(start.landing, '/main?lat=[geo]&lng=[geo]', '좌표는 [geo] · 인증 code 는 뺀다');
  assert.equal(start.referrer, 'https://search.naver.com/search.naver', '이전 주소는 쿼리 없이');
  assert.deepEqual(start.languages, ['ko-KR', 'en-US', 'ja']);
  assert.equal(rows.find((r) => r.event === 'click' && r.props.testid === 'go')?.props.name, '바로 갈래요');
  assert.deepEqual(rows.find((r) => r.event === 'click' && r.props.plain === true)?.props, { tag: 'div', plain: true, ctx: '#tickets' });
  const inputs = rows.filter((r) => r.event === 'input');
  assert.equal(inputs.find((r) => r.props.type === 'text')?.props.value, '카페 [email]');
  assert.deepEqual(inputs.find((r) => r.props.type === 'password')?.props, { field: 'pw', type: 'password' });
  assert.deepEqual(rows.find((r) => r.event === 'search')?.props, { q: '황남 [phone]', source: 'main', via: 'enter' });
  const queryViews = rows.filter((r) => r.event === 'page_view' && r.props.nav === 'query');
  assert.deepEqual(queryViews.map((r) => r.props), [
    { from: '/main', nav: 'query', how: 'push', query: '?tab=cafe&lat=[geo]', prev_query: '?lat=[geo]&lng=[geo]' },
  ], '쿼리만 바뀐 이동은 한 번만(같은 주소 · 인증 값만 다른 주소는 남기지 않는다)');
  assert.deepEqual(
    rows.filter((r) => r.event === 'api').map((r) => [r.props.svc, r.props.method, r.props.path, r.props.status]),
    [['supabase', 'GET', '/rest/v1/facilities', 200], ['api', 'GET', '/api/v1/weather', 200]],
    'API 는 우리 두 서비스만, 경로만',
  );
  assert.deepEqual(rows.find((r) => r.event === 'auth')?.props, { kind: 'initial', anonymous: null, provider: null });
  assert.deepEqual(rows[rows.length - 1].props, { state: 'pagehide', persisted: false });

  const text = JSON.stringify(rows);
  for (const secret of ['35.8372', '129.2095', 'oauth-secret', 'never-log-this', 'someone@example.com', '9999', '홍길동', 'select=']) {
    assert.ok(!text.includes(secret), `기록에 '${secret}' 가 남았다`);
  }
  // keepalive 로 보낸 줄도 저장분(탭 세션마다 키 하나)에 '확인 못 함' 으로 남는다 — 다음 방문이 다시 보내고 409 로 확인한다.
  const sessionId = win.sessionStorage.getItem('nextspot_action_session');
  const saved = JSON.parse(win.localStorage.getItem(`nextspot_action_outbox:${sessionId}`) ?? 'null') as { live: number; rows: unknown[]; u?: number[] } | null;
  assert.ok(saved, '이 탭의 키에 남는다');
  assert.equal(saved!.live, 0);
  assert.equal(saved!.rows.length, rows.length);
  assert.ok(saved!.u?.every((flag) => flag === 1), '보낸 줄은 확인 못 함으로');
  assert.equal(win.localStorage.getItem('nextspot_action_outbox'), null, '옛 한 키에는 쓰지 않는다');

  // 기록 보기 화면(/dev/activity) — 화면 열람만 남긴다.
  win.location.pathname = '/dev/activity';
  win.location.search = '';
  win.location.href = 'http://localhost:3000/dev/activity';
  // 그사이 같은 탭의 다른 페이지가 같은 세션으로 순번을 더 썼다(OAuth 왕복 등) — 돌아온 페이지는 새 세션을 연다.
  const before = win.sessionStorage.getItem('nextspot_action_session');
  win.sessionStorage.setItem('nextspot_action_seq', '999');
  win.fire('pageshow', { persisted: true }); // bfcache 에서 돌아온 기록 보기 화면
  assert.notEqual(win.sessionStorage.getItem('nextspot_action_session'), before, '순번이 앞선 세션은 이어 쓰지 않는다');
  doc.fire('click', { target: new FakeElement('button', {}, '새로고침') });
  await wrapped('https://your-supabase-project.supabase.co/rest/v1/action_logs?select=*');
  logAction('page_view', { from: '/main', nav: 'route', query: '' });
  logSearch('anything', 'dev');
  win.fire('pagehide', { persisted: true });
  const viewer = posts.slice(1).flatMap((p) => p.body);
  assert.deepEqual(viewer.map((r) => r.event), ['session_start', 'page_view'], '/dev/activity 에서는 session_start · page_view 만');
  assert.equal(viewer[0].seq, 0);
  assert.equal(viewer[0].props.restored, true);
  assert.equal(viewer[1].page, '/dev/activity');

  console.log('actionLogRuntime tests passed');
  process.exit(0); // Supabase 클라이언트의 자동 갱신 타이머가 프로세스를 붙잡지 않게
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
