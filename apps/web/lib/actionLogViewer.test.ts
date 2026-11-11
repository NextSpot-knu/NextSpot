// 이용 기록(행동 로그) 뷰어 도우미 — 화면과 CSV 가 같은 규칙을 쓰는지, 심사 증빙으로 쓸 값이 틀리지 않는지 잠근다.
//
// 기기 시간대와 무관해야 한다: KST 는 고정 +9시간으로 계산하고, 기기 시간대(Date#getHours)를 쓰면 안 된다.
// 그래서 시간대를 일부러 서울이 아닌 곳으로 바꿔 놓고 돌린다(Node 는 실행 중 TZ 변경을 반영한다).
process.env.TZ = 'America/Los_Angeles';

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ACCOUNTS } from './judgeAccounts';
import {
  ACTION_LOG_MIGRATION,
  ActionLogError,
  CSV_BOM,
  DEVICE_CSV_COLUMNS,
  ROW_CSV_COLUMNS,
  accountLabel,
  actionLogErrorText,
  deviceRequestLimit,
  heartbeatSeconds,
  snapshotUpperBound,
  trimDeviceList,
  addKstDays,
  buildCsv,
  classifyRpcError,
  clockDiffSeconds,
  collectKeyset,
  csvCell,
  csvFileName,
  csvHeader,
  csvRows,
  deviceHasJudge,
  eventLabel,
  formatClockDiff,
  formatDuration,
  formatKst,
  groupBySession,
  ipChainText,
  isKstDay,
  isRetryableActionLogError,
  judgeConsoleForEmail,
  judgeUsage,
  kstDay,
  kstDayStartMs,
  normalizeDevice,
  normalizeDevices,
  normalizeRange,
  normalizeRow,
  normalizeRows,
  parseTimestamp,
  pathLabel,
  presetRange,
  rangeDayCount,
  rangeToIso,
  referrerLabel,
  rowAccountLabel,
  shortId,
  shortUserAgent,
  summarizeProps,
  toActionLogError,
  type ActionLogDevice,
  type ActionLogRow,
} from './actionLogViewer';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 시각 파싱 · KST 표기 ──────────────────────────────────────────────────────
{
  const base = Date.parse('2026-11-12T03:04:05.123Z');
  assert.equal(parseTimestamp('2026-11-12T03:04:05.123456+00:00'), base, 'Postgres 마이크로초를 못 읽는다');
  assert.equal(parseTimestamp('2026-11-12 03:04:05.123+00'), base, '공백 구분 · 시만 있는 오프셋을 못 읽는다');
  assert.equal(parseTimestamp('2026-11-12T12:04:05.123+0900'), base, '+0900 오프셋을 못 읽는다');
  assert.equal(parseTimestamp('2026-11-12T03:04:05.123'), base, '오프셋이 없으면 UTC 로 읽어야 한다(기기 시간대 X)');
  assert.equal(parseTimestamp(new Date(base)), base);
  assert.equal(parseTimestamp(base), base);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp('어제'), null);
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp({}), null);

  // UTC 15:30 = KST 다음 날 00:30 — 날짜가 넘어가는 경계에서 기기 시간대(LA)를 쓰면 틀린다.
  const late = '2026-11-12T15:30:05Z';
  assert.equal(formatKst(late, 'full'), '2026-11-13 00:30:05');
  assert.equal(formatKst(late, 'minute'), '11-13 00:30');
  assert.equal(formatKst(late, 'second'), '11-13 00:30:05');
  assert.equal(formatKst(late), '11-13 00:30:05', '기본 표기는 초까지');
  assert.equal(formatKst(late, 'time'), '00:30:05');
  assert.equal(formatKst(null), '');
  assert.equal(formatKst('nope', 'full'), '');
  assert.equal(formatKst(8.64e15 + 1), '', 'Date 범위 밖 값에서 던지지 않는다');
  assert.equal(kstDay(Date.parse(late)), '2026-11-13');
  assert.equal(kstDay(Number.NaN), '');
}

// ── KST 달력 기간 ─────────────────────────────────────────────────────────────
{
  assert.equal(kstDayStartMs('2026-11-12'), Date.parse('2026-11-11T15:00:00Z'), 'KST 자정은 전날 15:00Z');
  assert.ok(Number.isNaN(kstDayStartMs('2026/11/12')));
  assert.equal(isKstDay('2026-11-12'), true);
  assert.equal(isKstDay('2026-02-30'), false, '달력에 없는 날짜를 받았다');
  assert.equal(isKstDay(''), false);
  assert.equal(isKstDay(undefined), false);
  // 9999-12-31 의 다음 날은 Date 범위를 넘어 RPC 인자를 만들다 던졌다(화면이 통째로 죽었다).
  assert.equal(isKstDay('9999-12-31'), false);
  assert.equal(isKstDay('1999-12-31'), false);
  assert.equal(isKstDay('2100-12-31'), true);
  assert.doesNotThrow(() => rangeToIso({ fromDay: '2100-12-31', toDay: '2100-12-31' }));

  // 내려받기 끝 시각 고정 — 기간 끝과 '지금 − 10초' 중 이른 쪽.
  const nowMs = Date.parse('2026-11-12T05:00:00.000Z');
  assert.equal(snapshotUpperBound('2026-11-12T15:00:00.000Z', nowMs), '2026-11-12T04:59:50.000Z', '오늘이 든 기간은 지금 직전까지');
  assert.equal(snapshotUpperBound('2026-11-10T15:00:00.000Z', nowMs), '2026-11-10T15:00:00.000Z', '지난 기간은 그대로');
  assert.equal(snapshotUpperBound('nope', nowMs), '2026-11-12T04:59:50.000Z');
  assert.equal(addKstDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addKstDays('2026-03-01', -1), '2026-02-28');

  // 지금 = KST 11-13 00:30. '오늘' 은 KST 날짜여야 한다(UTC 로는 아직 11-12).
  const now = Date.parse('2026-11-12T15:30:00Z');
  assert.deepEqual(presetRange('today', now), { fromDay: '2026-11-13', toDay: '2026-11-13' });
  assert.deepEqual(presetRange('7d', now), { fromDay: '2026-11-07', toDay: '2026-11-13' }, '7일은 오늘 포함 7일');
  assert.deepEqual(presetRange('30d', now), { fromDay: '2026-10-15', toDay: '2026-11-13' });
  assert.equal(rangeDayCount(presetRange('7d', now)), 7);
  assert.equal(rangeDayCount(presetRange('30d', now)), 30);
  assert.equal(rangeDayCount(presetRange('today', now)), 1);

  // RPC 인자: 첫날 KST 자정 ~ 마지막 날 다음 날 KST 자정(마지막 날 끝까지 들어오게).
  assert.deepEqual(rangeToIso({ fromDay: '2026-11-06', toDay: '2026-11-12' }), {
    from: '2026-11-05T15:00:00.000Z',
    to: '2026-11-12T15:00:00.000Z',
  });
  // 앞뒤가 뒤집혀도 같은 기간으로 읽는다.
  assert.deepEqual(normalizeRange({ fromDay: '2026-11-12', toDay: '2026-11-06' }), {
    fromDay: '2026-11-06',
    toDay: '2026-11-12',
  });
  assert.deepEqual(
    rangeToIso({ fromDay: '2026-11-12', toDay: '2026-11-06' }),
    rangeToIso({ fromDay: '2026-11-06', toDay: '2026-11-12' }),
  );
}

// ── 시간 길이 · 하트비트 시간 · 시각 차이 ──────────────────────────────────────
{
  assert.equal(formatDuration(0), '0초');
  assert.equal(formatDuration(45), '45초');
  assert.equal(formatDuration(120), '2분');
  assert.equal(formatDuration(150), '2분 30초');
  assert.equal(formatDuration(3600), '1시간');
  assert.equal(formatDuration(3900), '1시간 5분');
  assert.equal(formatDuration(90000), '1일 1시간');
  assert.equal(formatDuration(-5), '0초');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(NaN), '');

  assert.equal(heartbeatSeconds(5), 150, '하트비트 하나는 30초');
  assert.equal(heartbeatSeconds(0), 0);
  assert.equal(heartbeatSeconds(-3), 0);
  assert.equal(formatDuration(heartbeatSeconds(5)), '2분 30초');

  const diff = clockDiffSeconds('2026-11-12T03:04:05.000Z', '2026-11-12T03:04:06.200Z');
  assert.equal(diff, -1.2, '브라우저 시각 − 서버 시각');
  assert.equal(clockDiffSeconds(null, '2026-11-12T03:04:06Z'), null);
  assert.equal(formatClockDiff(-1.2), '-1.2초');
  assert.equal(formatClockDiff(0.01), '0초');
  assert.equal(formatClockDiff(0), '0초');
  assert.equal(formatClockDiff(12), '+12초');
  assert.equal(formatClockDiff(-185), '-3분 5초');
  assert.equal(formatClockDiff(null), '');
}

// ── 짧은 표기 ────────────────────────────────────────────────────────────────
{
  assert.equal(shortId('0f8e9d7c-1234-5678-9abc-def012345678'), '0f8e9d7c');
  assert.equal(shortId('abc'), 'abc');
  assert.equal(shortId(null), '');
  assert.equal(shortId('0f8e9d7c-1234', 6), '0f8e9d');

  const UA = {
    chromeWin:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    edgeWin:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.53',
    whale:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Whale/4.33.325.17 Safari/537.36',
    safariIphone:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    chromeIos:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.46 Mobile/15E148 Safari/604.1',
    samsung:
      'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    kakao:
      'Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36;KAKAOTALK 2511020',
    naver:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.10.3; 16PRO)',
    firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:144.0) Gecko/20100101 Firefox/144.0',
    googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  };
  assert.equal(shortUserAgent(UA.chromeWin), 'Chrome 142 · Windows');
  assert.equal(shortUserAgent(UA.edgeWin), 'Edge 142 · Windows', '엣지를 크롬으로 읽었다');
  assert.equal(shortUserAgent(UA.whale), 'Whale 4 · Windows', '웨일을 크롬으로 읽었다');
  assert.equal(shortUserAgent(UA.safariIphone), 'Safari 18 · iPhone', '아이폰을 macOS 로 읽었다');
  assert.equal(shortUserAgent(UA.chromeIos), 'Chrome 142 · iPhone');
  assert.equal(shortUserAgent(UA.samsung), 'Samsung Internet 28 · Android', '안드로이드를 Linux 로 읽었다');
  assert.equal(shortUserAgent(UA.kakao), '카카오톡 앱 · Android');
  assert.equal(shortUserAgent(UA.naver), '네이버 앱 · iPhone');
  assert.equal(shortUserAgent(UA.firefoxMac), 'Firefox 144 · macOS');
  assert.equal(shortUserAgent(UA.googlebot), '봇 · Googlebot');
  assert.equal(shortUserAgent('Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)'), '봇 · Yeti');
  assert.equal(shortUserAgent('kakaotalk-scrap/1.0; +https://devtalk.kakao.com/'), '봇 · kakaotalk-scrap', '링크 미리보기를 사람(카카오톡 앱)으로 셌다');
  assert.equal(
    shortUserAgent(
      'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    ),
    'Chrome 120 · Android',
    '휴대폰 이름에 BOT 이 들어 있다고 봇으로 읽었다',
  );
  assert.equal(shortUserAgent('curl/8.4.0'), 'curl 8');
  assert.equal(shortUserAgent(''), '');
  assert.equal(shortUserAgent(null), '');

  assert.equal(referrerLabel(''), '직접');
  assert.equal(referrerLabel(null), '직접');
  assert.equal(referrerLabel('https://www.google.com/search?q=nextspot'), 'google.com');
  assert.equal(referrerLabel('https://m.search.naver.com/search.naver?query=x'), 'm.search.naver.com');
  assert.equal(referrerLabel('not a url'), 'not a url');

  assert.equal(pathLabel('https://nextspot-nu.vercel.app/main?lang=ko'), '/main?lang=ko');
  assert.equal(pathLabel('/course'), '/course');
  assert.equal(pathLabel(null), '');

  assert.equal(ipChainText(['1.2.3.4', '10.0.0.1']), '1.2.3.4, 10.0.0.1');
  assert.equal(ipChainText('1.2.3.4, 10.0.0.1'), '1.2.3.4, 10.0.0.1');
  assert.equal(ipChainText(null), '');

  assert.equal(eventLabel('click'), '클릭');
  assert.equal(eventLabel('new_event'), 'new_event', '모르는 이벤트는 이름 그대로');
}

// ── 내용 요약 ────────────────────────────────────────────────────────────────
{
  assert.equal(
    summarizeProps('click', { tag: 'button', role: '', name: '바로 갈래요', href: '/course', testid: 'rec-accept' }),
    '“바로 갈래요” (button) · #rec-accept · → /course',
  );
  assert.equal(summarizeProps('click', { tag: 'a', testid: 'nav-map' }), '#nav-map (a)');
  assert.equal(
    summarizeProps('input', { field: 'search', type: 'text', length: 2, value: '경주' }),
    'search(text) · 2자 · “경주”',
  );
  // 비밀번호 값은 들어와 있어도 화면·CSV 요약에 내지 않는다.
  const secret = summarizeProps('input', { field: 'password', type: 'password', length: 9, value: 'hunter2!!' });
  assert.ok(!secret.includes('hunter2'), `비밀번호 값이 요약에 나왔다: ${secret}`);
  assert.equal(secret, 'password(password) · 9자 · 값 숨김');
  assert.equal(summarizeProps('input', { field: 'email', type: 'email', length: 12 }), 'email(email) · 12자');
  assert.equal(summarizeProps('search', { q: '황리단길 카페', source: 'main' }), '“황리단길 카페” · main');
  assert.equal(summarizeProps('voice', { text: '근처 덜 붐비는 곳', source: 'pill', phase: 'final' }), '[final] · “근처 덜 붐비는 곳” · pill');
  assert.equal(summarizeProps('key', { key: 'Enter' }), 'Enter');
  assert.equal(summarizeProps('swipe', { dir: 'left', dist: 120 }), '왼쪽 · 120px');
  assert.equal(summarizeProps('scroll', { depth: 75 }), '75%');
  assert.equal(summarizeProps('map', { level: 5, kind: 'zoom' }), 'zoom · 레벨 5');
  assert.equal(summarizeProps('visibility', { state: 'hidden' }), '숨김(다른 탭·앱으로)');
  assert.equal(summarizeProps('heartbeat', { active: true }), '활동 중');
  assert.equal(summarizeProps('heartbeat', { active: false }), '자리 비움');
  assert.equal(
    summarizeProps('api', { svc: 'api', method: 'GET', path: '/api/v1/recommend', status: 200, ms: 412 }),
    'GET /api/v1/recommend · → 200 · 412ms · api',
  );
  assert.equal(
    summarizeProps('error', { message: 'TypeError: x is undefined', file: 'main.js', line: 12 }),
    'TypeError: x is undefined · main.js:12',
  );
  assert.equal(summarizeProps('auth', { kind: 'SIGNED_IN', anonymous: false, provider: 'email' }), 'SIGNED_IN · email');
  assert.equal(summarizeProps('auth', { kind: 'SIGNED_IN', anonymous: true }), 'SIGNED_IN · 게스트(익명)');
  assert.equal(summarizeProps('page_view', { from: '/main', nav: 'push', query: '?id=3' }), '← /main · push · ?id=3');
  assert.equal(
    summarizeProps('session_start', {
      referrer: 'https://www.google.com/',
      landing: '/main',
      viewport: '390x844',
      screen: { w: 1170, h: 2532 },
      timezone: 'Asia/Seoul',
      languages: ['ko-KR', 'en'],
    }),
    '첫 화면 /main · 유입 google.com · 창 390x844 · 화면 1170×2532 · Asia/Seoul · ko-KR,en',
  );
  // 모르는 이벤트 · JSON 문자열로 온 props 도 읽는다.
  assert.equal(summarizeProps('custom', '{"a":1,"b":"x","c":null}'), 'a=1 · b=x');
  assert.equal(summarizeProps('click', null), '');
  assert.equal(summarizeProps('submit', {}), '');
  // 아주 긴 값은 잘린다(표가 한 칸 때문에 무너지지 않게).
  assert.ok(summarizeProps('search', { q: 'ㄱ'.repeat(500) }).length < 120);
}

// ── 심사 계정 ────────────────────────────────────────────────────────────────
{
  assert.equal(judgeConsoleForEmail(JUDGE_ACCOUNTS.admin), 'admin');
  assert.equal(judgeConsoleForEmail(JUDGE_ACCOUNTS.merchant), 'merchant');
  assert.equal(judgeConsoleForEmail('openapi@gmail.com'), 'admin');
  assert.equal(judgeConsoleForEmail('  OpenAPI@Naver.com '), 'merchant', '대소문자·공백 때문에 심사 계정을 놓쳤다');
  assert.equal(judgeConsoleForEmail('openapi@daum.net'), null);
  assert.equal(judgeConsoleForEmail(''), null);
  assert.equal(judgeConsoleForEmail(null), null);

  const device = (id: string, emails: (string | null)[], extra: Partial<ActionLogDevice> = {}): ActionLogDevice => ({
    device_id: id,
    first_at: '2026-11-10T01:00:00Z',
    last_at: '2026-11-10T02:00:00Z',
    sessions: 1,
    events: 10,
    page_views: 2,
    clicks: 3,
    heartbeats: 4,
    accounts: emails.map((email, i) => ({ user_id: `u-${id}-${i}`, email, role: email ? 'admin' : 'tourist' })),
    ips: [],
    user_agent: null,
    landing: null,
    referrer: null,
    ...extra,
  });
  const devices = [
    device('d1', ['openapi@gmail.com'], { first_at: '2026-11-09T00:00:00Z', last_at: '2026-11-12T05:00:00Z', events: 40 }),
    device('d2', [null, 'OPENAPI@GMAIL.COM'], { first_at: '2026-11-08T00:00:00Z', last_at: '2026-11-11T00:00:00Z', events: 7 }),
    device('d3', ['someone@example.com']),
    device('d4', []),
  ];
  assert.equal(deviceHasJudge(devices[0]), true);
  assert.equal(deviceHasJudge(devices[2]), false);
  assert.equal(deviceHasJudge(devices[3]), false);

  const usage = judgeUsage(devices);
  assert.equal(usage.length, 2, '심사 계정마다 한 줄 — 기록이 없어도 0 으로 보여야 한다');
  const admin = usage.find((u) => u.console === 'admin')!;
  assert.equal(admin.email, JUDGE_ACCOUNTS.admin);
  assert.equal(admin.devices, 2);
  assert.equal(admin.events, 47);
  assert.equal(admin.firstAt, '2026-11-08T00:00:00Z');
  assert.equal(admin.lastAt, '2026-11-12T05:00:00Z');
  const merchant = usage.find((u) => u.console === 'merchant')!;
  assert.equal(merchant.devices, 0);
  assert.equal(merchant.firstAt, null);
  assert.equal(merchant.lastAt, null);

  assert.equal(accountLabel({ user_id: 'u1', email: 'openapi@gmail.com', role: 'admin' }), 'openapi@gmail.com · admin');
  assert.equal(accountLabel({ user_id: '0f8e9d7c-aaaa', email: null, role: 'tourist' }), 'uid 0f8e9d7c · tourist');
}

// ── RPC 응답 정규화 ──────────────────────────────────────────────────────────
{
  const d = normalizeDevice({
    device_id: 'dev-1',
    first_at: '2026-11-12T01:00:00+00:00',
    last_at: '2026-11-12T02:00:00+00:00',
    sessions: '3',
    events: 120,
    page_views: null,
    clicks: 9.7,
    heartbeats: -2,
    accounts: '[{"user_id":"u1","email":"openapi@naver.com","role":"merchant"},{"user_id":null,"email":null}]',
    ips: '{1.2.3.4,5.6.7.8}',
    user_agent: 'curl/8.4.0',
    landing: '/main',
    referrer: '',
  });
  assert.ok(d);
  assert.equal(d.sessions, 3, 'bigint 가 문자열로 와도 센다');
  assert.equal(d.page_views, 0);
  assert.equal(d.clicks, 9);
  assert.equal(d.heartbeats, 0, '음수는 0');
  assert.deepEqual(d.accounts, [{ user_id: 'u1', email: 'openapi@naver.com', role: 'merchant' }], '빈 계정은 버린다');
  assert.deepEqual(d.ips, ['1.2.3.4', '5.6.7.8'], 'Postgres 배열 리터럴도 읽는다');
  assert.equal(normalizeDevice({ events: 3 }), null, 'device_id 없는 행은 버린다');

  // 한 대 더 물어 잘렸는지 안다. 상한(1000)에서는 더 물을 수 없어 꽉 차면 잘렸을 수 있다고 본다.
  assert.equal(deviceRequestLimit(300), 301);
  assert.equal(deviceRequestLimit(1000), 1000);
  const list = Array.from({ length: 301 }, (_, i) => i);
  assert.deepEqual(trimDeviceList(list, 300), { devices: list.slice(0, 300), truncated: true });
  assert.equal(trimDeviceList(list.slice(0, 300), 300).truncated, false, '딱 300대뿐인데 잘렸다고 했다');
  assert.equal(trimDeviceList(list.slice(0, 12), 300).truncated, false);
  const full = Array.from({ length: 1000 }, (_, i) => i);
  assert.equal(trimDeviceList(full, 1000).truncated, true);
  assert.equal(trimDeviceList(full.slice(0, 999), 1000).truncated, false);
  assert.deepEqual(normalizeDevices(null), []);
  assert.equal(normalizeDevices([{ device_id: 'a', ips: ['9.9.9.9'] }, 'junk', { nope: 1 }]).length, 1);

  const row = normalizeRow({
    id: '42',
    received_at: '2026-11-12T03:04:06+00:00',
    occurred_at: '2026-11-12T03:04:05+00:00',
    device_id: 'dev-1',
    session_id: 's-1',
    seq: '7',
    event: 'click',
    page: '/main',
    host: 'nextspot-nu.vercel.app',
    locale: 'ko',
    props: '{"name":"바로 갈래요"}',
    user_id: 'u1',
    email: 'openapi@naver.com',
    is_anonymous: 'false',
    account_role: 'merchant',
    ip: '1.2.3.4',
    ip_chain: ['1.2.3.4', '10.0.0.1'],
    user_agent: 'x',
  });
  assert.ok(row);
  assert.equal(row.id, 42);
  assert.equal(row.seq, 7);
  assert.equal(row.is_anonymous, false);
  assert.deepEqual(row.props, { name: '바로 갈래요' });
  assert.deepEqual(row.ip_chain, ['1.2.3.4', '10.0.0.1']);
  const bare = normalizeRow({ id: 1, event: 'heartbeat', seq: null, props: null });
  assert.ok(bare);
  assert.equal(bare.seq, null);
  assert.deepEqual(bare.props, {});
  assert.equal(bare.ip_chain, null);
  assert.equal(normalizeRow({ id: 'x' }), null, 'id 없는 행은 키셋을 깨므로 버린다');
  assert.equal(normalizeRows([{ id: 1 }, { id: null }, 7]).length, 1);
}

// ── RPC 오류 분류 ────────────────────────────────────────────────────────────
{
  assert.equal(classifyRpcError({ code: '42501', message: 'permission denied' }, 403), 'forbidden');
  assert.equal(classifyRpcError({ code: 'PGRST202', message: 'Could not find the function' }, 404), 'missing');
  assert.equal(classifyRpcError({ code: '' }, 404), 'missing', '404 만 와도 함수가 없는 것');
  assert.equal(classifyRpcError({ code: 'XX000', message: 'boom' }, 500), 'failed');
  assert.equal(classifyRpcError(null), 'failed');

  const forbidden = toActionLogError({ code: '42501', message: 'only developers' }, 403);
  assert.ok(forbidden instanceof ActionLogError);
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbidden.code, '42501');
  assert.equal(actionLogErrorText(forbidden).title, '개발자 계정만 볼 수 있어요.');

  const missing = toActionLogError({ code: 'PGRST202', message: 'Could not find the function public.action_log_rows' }, 404);
  assert.equal(missing.kind, 'missing');
  assert.ok(actionLogErrorText(missing).title.includes(ACTION_LOG_MIGRATION));
  assert.equal(ACTION_LOG_MIGRATION, '20261112090000_action_logs');

  const failed = toActionLogError(new Error('FetchError: network down'));
  assert.equal(failed.kind, 'failed');
  assert.equal(actionLogErrorText(failed).detail, 'FetchError: network down', '그 밖의 실패는 원래 메시지를 보여 준다');
  assert.equal(toActionLogError(forbidden), forbidden, '이미 분류된 오류는 그대로');

  assert.equal(isRetryableActionLogError(failed), true);
  assert.equal(isRetryableActionLogError(forbidden), false, '권한 없음을 다시 물으면 같은 답만 온다');
  assert.equal(isRetryableActionLogError(missing), false);
  assert.equal(isRetryableActionLogError(new Error('x')), true);
}

// ── 세션 묶음 ────────────────────────────────────────────────────────────────
{
  const mk = (id: number, sessionId: string | null, at: string, event: string, extra: Partial<ActionLogRow> = {}): ActionLogRow => ({
    id,
    received_at: at,
    occurred_at: at,
    device_id: 'dev-1',
    session_id: sessionId,
    seq: id,
    event,
    page: '/main',
    host: null,
    locale: 'ko',
    props: {},
    user_id: null,
    email: null,
    is_anonymous: null,
    account_role: null,
    ip: '1.2.3.4',
    ip_chain: null,
    user_agent: null,
    ...extra,
  });
  // 두 탭(세션)이 겹쳐 돈 기기 — 행은 id 순으로 섞여 온다.
  const rows = [
    mk(1, 'B', '2026-11-12T01:05:00Z', 'session_start', { page: '/course' }),
    mk(2, 'A', '2026-11-12T01:00:00Z', 'session_start'),
    mk(3, 'A', '2026-11-12T01:00:30Z', 'heartbeat', { props: { active: true } }),
    mk(4, 'A', '2026-11-12T01:01:00Z', 'heartbeat', { props: { active: false } }),
    mk(5, 'A', '2026-11-12T01:01:30Z', 'click', { user_id: 'u1', email: 'openapi@gmail.com', account_role: 'admin' }),
    mk(6, 'B', '2026-11-12T01:06:00Z', 'page_view', { ip: '5.6.7.8' }),
    mk(7, 'A', '2026-11-12T01:10:00Z', 'page_view', { user_id: 'u1', email: 'openapi@gmail.com', account_role: 'admin' }),
    mk(8, null, 'garbage', 'error'),
  ];
  const groups = groupBySession(rows);
  assert.deepEqual(
    groups.map((g) => g.sessionId),
    ['A', 'B', null],
    '세션은 시작 시각 순, 시각을 못 읽은 묶음은 맨 뒤',
  );
  const [a, b, none] = groups;
  assert.deepEqual(a.rows.map((r) => r.id), [2, 3, 4, 5, 7], '묶음 안의 순서는 들어온 순서 그대로');
  assert.equal(a.startAt, '2026-11-12T01:00:00Z');
  assert.equal(a.endAt, '2026-11-12T01:10:00Z');
  assert.equal(a.durationS, 600);
  assert.equal(a.events, 5);
  assert.equal(a.pageViews, 1);
  assert.equal(a.clicks, 1);
  assert.equal(a.visibleS, 60, '열어 둔 시간은 하트비트 전부(기기 표와 같은 셈법)');
  assert.equal(a.activeS, 30, '자리 비움(active:false) 하트비트는 조작 시간에 넣지 않는다');
  assert.deepEqual(a.accounts, [{ user_id: 'u1', email: 'openapi@gmail.com', role: 'admin', anonymous: false }]);
  assert.equal(a.firstPage, '/main');
  assert.deepEqual(b.ips, ['1.2.3.4', '5.6.7.8']);
  assert.equal(b.firstPage, '/course');
  assert.equal(none.durationS, null);
  assert.equal(none.startAt, null);
  assert.deepEqual(groupBySession([]), []);

  assert.equal(rowAccountLabel(rows[4]), 'openapi@gmail.com · admin');
  assert.equal(rowAccountLabel(mk(9, 'A', '2026-11-12T01:00:00Z', 'click', { user_id: 'abcdef123', is_anonymous: true })), '게스트 abcdef');
  assert.equal(rowAccountLabel(rows[0]), '');
}

// ── 키셋 모으기 ──────────────────────────────────────────────────────────────
// 가짜 서버: id 1..total 을 오름차순으로, PostgREST max-rows 처럼 serverCap 보다 많이는 안 준다.
function fakeServer(total: number, serverCap = Infinity) {
  const calls: { afterId: number; limit: number }[] = [];
  const fetchPage = async (afterId: number, limit: number) => {
    calls.push({ afterId, limit });
    const out: { id: number }[] = [];
    for (let id = afterId + 1; id <= total && out.length < Math.min(limit, serverCap); id += 1) out.push({ id });
    return out;
  };
  return { calls, fetchPage };
}

// 테스트는 CJS 로 돈다(top-level await 불가) — 비동기 부분은 함수로 감싸 맨 끝에서 기다린다.
async function keysetTests() {
  // 서버가 요청(5000)보다 짧게(1000) 잘라 줘도 빈 쪽이 올 때까지 이어 간다.
  {
    const server = fakeServer(2500, 1000);
    const pages: number[] = [];
    const result = await collectKeyset({
      fetchPage: server.fetchPage,
      pageSize: 5000,
      maxRows: 300_000,
      onPage: (rows, loaded) => pages.push(rows.length, loaded),
    });
    assert.deepEqual(result, { loaded: 2500, lastId: 2500, reason: 'end' }, '짧은 쪽을 끝으로 오인했다');
    assert.deepEqual(pages, [1000, 1000, 1000, 2000, 500, 2500]);
    assert.deepEqual(
      server.calls.map((c) => c.afterId),
      [0, 1000, 2000, 2500],
      'after_id 는 직전 쪽의 마지막 id',
    );
    // 짧게 온 크기(서버 상한)를 배워 다음부터 그만큼만 청한다 — plpgsql 함수가 p_limit 만큼 헛되이 만들지 않게.
    assert.deepEqual(server.calls.map((c) => c.limit), [5000, 1000, 1000, 500]);
  }

  // 상한에서 '더 있나' 를 묻다 실패해도 받은 것은 버리지 않는다 — 잘렸을 수 있다(cap)로 끝낸다.
  {
    const server = fakeServer(3000);
    let probeCalls = 0;
    const result = await collectKeyset({
      fetchPage: async (afterId, limit) => {
        if (limit === 1) {
          probeCalls += 1;
          throw new ActionLogError('failed', 'timeout');
        }
        return server.fetchPage(afterId, limit);
      },
      pageSize: 1000,
      maxRows: 3000,
      retryDelayMs: 0,
    });
    assert.deepEqual(result, { loaded: 3000, lastId: 3000, reason: 'cap' }, '마지막 확인 실패로 받은 3000건을 잃었다');
    assert.equal(probeCalls, 3, '확인도 다시 묻는다(처음 1 + 다시 2)');
  }

  // 실패가 이어지는 중에 중지하면 오류가 아니라 cancelled 다.
  {
    let stop = false;
    const result = await collectKeyset({
      fetchPage: async () => {
        stop = true;
        throw new ActionLogError('failed', 'timeout');
      },
      pageSize: 1000,
      maxRows: 10_000,
      retryDelayMs: 0,
      isCancelled: () => stop,
    });
    assert.deepEqual(result, { loaded: 0, lastId: 0, reason: 'cancelled' });
  }

  // 상한에 닿고 뒤에 더 있으면 cap, 딱 상한만큼만 있었으면 end(잘렸다고 말하지 않는다).
  {
    const more = fakeServer(2500);
    const capped = await collectKeyset({ fetchPage: more.fetchPage, pageSize: 1000, maxRows: 2000 });
    assert.deepEqual(capped, { loaded: 2000, lastId: 2000, reason: 'cap' });
    assert.equal(more.calls.at(-1)?.limit, 1, '상한에서는 한 건만 더 물어 본다');

    const exact = fakeServer(2000);
    assert.deepEqual(await collectKeyset({ fetchPage: exact.fetchPage, pageSize: 1000, maxRows: 2000 }), {
      loaded: 2000,
      lastId: 2000,
      reason: 'end',
    });

    // 마지막 쪽은 상한까지 남은 만큼만 요청한다.
    const partial = fakeServer(5000);
    await collectKeyset({ fetchPage: partial.fetchPage, pageSize: 2000, maxRows: 4500 });
    assert.deepEqual(partial.calls.map((c) => c.limit), [2000, 2000, 500, 1]);

    // '더 불러오기' 는 lastId 에서 이어 간다.
    const resumed = await collectKeyset({ fetchPage: more.fetchPage, afterId: capped.lastId, pageSize: 1000, maxRows: 2000 });
    assert.deepEqual(resumed, { loaded: 500, lastId: 2500, reason: 'end' });
  }

  // 중간에 그만두면 cancelled, 그 쪽은 버린다.
  {
    const server = fakeServer(5000);
    let stop = false;
    const seen: number[] = [];
    const result = await collectKeyset({
      fetchPage: server.fetchPage,
      pageSize: 1000,
      maxRows: 300_000,
      isCancelled: () => stop,
      onPage: (rows) => {
        seen.push(rows.length);
        stop = true;
      },
    });
    assert.deepEqual(result, { loaded: 1000, lastId: 1000, reason: 'cancelled' });
    assert.deepEqual(seen, [1000]);
  }

  // 일시 실패는 쪽 크기를 줄여 다시 묻고, 권한 없음은 바로 던진다.
  {
    const server = fakeServer(1500);
    let failures = 1;
    const flaky = async (afterId: number, limit: number) => {
      if (failures > 0) {
        failures -= 1;
        server.calls.push({ afterId, limit });
        throw new ActionLogError('failed', 'timeout');
      }
      return server.fetchPage(afterId, limit);
    };
    const result = await collectKeyset({
      fetchPage: flaky,
      pageSize: 1000,
      maxRows: 300_000,
      retryDelayMs: 0,
      isRetryable: isRetryableActionLogError,
    });
    assert.deepEqual(result, { loaded: 1500, lastId: 1500, reason: 'end' });
    assert.deepEqual(
      server.calls.map((c) => c.limit),
      [1000, 500, 500, 500, 500],
      '실패 뒤에는 절반 크기로 다시 묻는다',
    );

    let calls = 0;
    await assert.rejects(
      collectKeyset({
        fetchPage: async () => {
          calls += 1;
          throw new ActionLogError('forbidden', 'no');
        },
        pageSize: 1000,
        maxRows: 10,
        retryDelayMs: 0,
        isRetryable: isRetryableActionLogError,
      }),
      (err: unknown) => err instanceof ActionLogError && err.kind === 'forbidden',
    );
    assert.equal(calls, 1, '권한 없음을 다시 물었다');

    let attempts = 0;
    await assert.rejects(
      collectKeyset({
        fetchPage: async () => {
          attempts += 1;
          throw new Error('down');
        },
        pageSize: 1000,
        maxRows: 10,
        retries: 2,
        retryDelayMs: 0,
      }),
      /down/,
    );
    assert.equal(attempts, 3, '처음 1번 + 다시 2번');
  }

  // 서버가 같은 쪽을 되풀이하면(앞으로 가지 않으면) 끝없이 돌지 않고 멈춘다.
  await assert.rejects(
    collectKeyset({ fetchPage: async () => [{ id: 5 }], afterId: 5, pageSize: 10, maxRows: 1000 }),
    /앞으로 가지 않았어요/,
  );
}

// ── CSV ──────────────────────────────────────────────────────────────────────
{
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('경주, 황리단길'), '"경주, 황리단길"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(-1.5), '-1.5', '숫자 음수는 수식 방지 대상이 아니다');
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell(true), 'true');
  assert.equal(csvCell({ a: 1, b: 'x' }), '"{""a"":1,""b"":""x""}"', '객체는 JSON');
  assert.equal(csvCell(['1.2.3.4']), '"[""1.2.3.4""]"');
  // 방문자가 친 값이 엑셀에서 수식으로 실행되지 않게 한다(CSV injection).
  assert.equal(csvCell('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");

  const columns = [
    { header: 'a', value: (r: { a: unknown; b: unknown }) => r.a },
    { header: 'b', value: (r: { a: unknown; b: unknown }) => r.b },
  ];
  assert.equal(csvHeader(columns), 'a,b\r\n');
  assert.equal(csvRows(columns, [{ a: 1, b: 'x,y' }, { a: null, b: 2 }]), '1,"x,y"\r\n,2\r\n');
  assert.equal(csvRows(columns, []), '');
  const csv = buildCsv(columns, [{ a: '한글', b: 1 }]);
  assert.equal(csv, `${CSV_BOM}a,b\r\n한글,1\r\n`);
  const bytes = Buffer.from(csv, 'utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '엑셀용 UTF-8 BOM 이 없다');

  // RPC 필드는 하나도 빠짐없이 CSV 에 들어간다(계약이 바뀌면 여기서 먼저 깨진다).
  const DEVICE_FIELDS = [
    'device_id', 'first_at', 'last_at', 'sessions', 'events', 'page_views', 'clicks', 'heartbeats',
    'accounts', 'ips', 'user_agent', 'landing', 'referrer',
  ];
  const ROW_FIELDS = [
    'id', 'received_at', 'occurred_at', 'device_id', 'session_id', 'seq', 'event', 'page', 'host', 'locale',
    'props', 'user_id', 'email', 'is_anonymous', 'account_role', 'ip', 'ip_chain', 'user_agent',
  ];
  const deviceHeaders = DEVICE_CSV_COLUMNS.map((c) => c.header);
  const rowHeaders = ROW_CSV_COLUMNS.map((c) => c.header);
  for (const field of DEVICE_FIELDS) assert.ok(deviceHeaders.includes(field), `기기 CSV 에 ${field} 가 없다`);
  for (const field of ROW_FIELDS) assert.ok(rowHeaders.includes(field), `행 CSV 에 ${field} 가 없다`);
  assert.equal(new Set(deviceHeaders).size, deviceHeaders.length, '기기 CSV 열 이름이 겹친다');
  assert.equal(new Set(rowHeaders).size, rowHeaders.length, '행 CSV 열 이름이 겹친다');

  // 행 CSV 한 줄 — props 는 JSON, 시각은 원본(UTC)과 KST 를 둘 다.
  const row = normalizeRow({
    id: 7,
    received_at: '2026-11-12T15:30:05+00:00',
    occurred_at: '2026-11-12T15:30:04+00:00',
    device_id: 'dev-1',
    session_id: 's-1',
    seq: 3,
    event: 'search',
    page: '/main',
    host: 'nextspot-nu.vercel.app',
    locale: 'ko',
    props: { q: '=1+1', source: 'main' },
    user_id: 'u1',
    email: 'openapi@gmail.com',
    is_anonymous: false,
    account_role: 'admin',
    ip: '1.2.3.4',
    ip_chain: '1.2.3.4, 10.0.0.1',
    user_agent: 'curl/8.4.0',
  })!;
  const line = csvRows(ROW_CSV_COLUMNS, [row]);
  const get = (header: string) => ROW_CSV_COLUMNS.find((c) => c.header === header)!.value(row);
  assert.equal(get('received_at_kst'), '2026-11-13 00:30:05');
  assert.equal(get('clock_diff_s'), -1);
  assert.equal(get('judge_account'), 'admin');
  assert.deepEqual(get('props'), { q: '=1+1', source: 'main' });
  assert.equal(get('summary'), '“=1+1” · main');
  assert.ok(line.includes('"{""q"":""=1+1"",""source"":""main""}"'), `props JSON 이 그대로 들어가지 않았다: ${line}`);
  assert.ok(line.endsWith('\r\n'));

  const deviceRow: ActionLogDevice = {
    device_id: 'dev-1',
    first_at: '2026-11-12T00:00:00Z',
    last_at: '2026-11-12T01:00:00Z',
    sessions: 2,
    events: 99,
    page_views: 10,
    clicks: 20,
    heartbeats: 5,
    accounts: [
      { user_id: 'u1', email: 'openapi@naver.com', role: 'merchant' },
      { user_id: 'u2', email: 'x@example.com', role: 'tourist' },
    ],
    ips: ['1.2.3.4'],
    user_agent: null,
    landing: '/main',
    referrer: null,
  };
  const dget = (header: string) => DEVICE_CSV_COLUMNS.find((c) => c.header === header)!.value(deviceRow);
  assert.equal(dget('visible_minutes_est'), 2.5);
  assert.ok(!DEVICE_CSV_COLUMNS.some((c) => c.header === 'active_minutes_est'), '방치된 탭도 하트비트를 보낸다 — 활동으로 이름 붙이지 않는다');
  assert.equal(dget('judge_accounts'), 'openapi@naver.com');
  assert.equal(dget('account_list'), 'openapi@naver.com · merchant; x@example.com · tourist');
  assert.equal(dget('first_at_kst'), '2026-11-12 09:00:00');
}

// ── 파일 이름 ────────────────────────────────────────────────────────────────
{
  const range = { fromDay: '2026-11-06', toDay: '2026-11-12' };
  assert.equal(csvFileName(range), 'nextspot-action-log_2026-11-06_2026-11-12.csv');
  assert.equal(csvFileName(range, { kind: 'devices' }), 'nextspot-action-log_2026-11-06_2026-11-12_devices.csv');
  assert.equal(
    csvFileName(range, { kind: 'devices', accountsOnly: true, partial: true }),
    'nextspot-action-log_2026-11-06_2026-11-12_devices_accounts-only_partial.csv',
    '로그인 기기만 거른 목록이 전체 목록처럼 보인다',
  );
  assert.equal(
    csvFileName(range, { deviceId: '0f8e9d7c-1234-5678' }),
    'nextspot-action-log_2026-11-06_2026-11-12_device-0f8e9d7c.csv',
  );
  assert.equal(csvFileName(range, { partial: true }), 'nextspot-action-log_2026-11-06_2026-11-12_partial.csv');
  assert.equal(
    csvFileName({ fromDay: '2026-11-12', toDay: '2026-11-06' }),
    'nextspot-action-log_2026-11-06_2026-11-12.csv',
    '뒤집힌 기간도 앞→뒤 순으로',
  );
  assert.equal(
    csvFileName(range, { deviceId: '../../a b' }),
    'nextspot-action-log_2026-11-06_2026-11-12_device-ab.csv',
    '파일 이름에 경로·공백 문자가 섞였다',
  );
}

// ── 화면 배선 — 관문과 RPC 이름이 빠지면 개발자 아닌 계정에 관문 없는 화면이 열린다 ─────
{
  const page = readFileSync(join(WEB, 'app', 'dev', 'activity', 'page.tsx'), 'utf8');
  assert.match(page, /^'use client';/, '정적 export — 클라이언트 컴포넌트여야 한다');
  assert.match(page, /canEnterDevConsole\(account\)/, '개발자 관문이 없다');
  assert.match(page, /router\.replace\('\/main'\)/, '개발자가 아니면 /main 으로 보내야 한다');
  assert.match(page, /rpc\('action_log_devices'/);
  assert.match(page, /rpc\('action_log_rows'/);
  assert.doesNotMatch(page, /useT\(|from '@\/lib\/i18n/, '개발자 콘솔은 한국어 전용(i18n 키를 만들지 않는다)');

  const devConsole = readFileSync(join(WEB, 'app', 'dev', 'page.tsx'), 'utf8');
  assert.match(devConsole, /href="\/dev\/activity"/, '개발자 콘솔에서 이용 기록으로 가는 길이 없다');
}

keysetTests()
  .then(() => console.log('actionLogViewer.test.ts ✓'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
