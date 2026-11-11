// 개발자 전용 '이용 기록(행동 로그)' 화면(app/dev/activity)의 순수 도우미.
//
// 왜 있나: 공모전 심사위원이 서비스를 실제로 써 봤는지(심사 계정 openapi@…)를 기기·세션 단위로
// 보여 주고 CSV 로 남기려는 화면이다. 표·CSV 가 같은 규칙(KST 표기·내용 요약·심사 계정 판정)을 써야
// 화면에서 본 것과 내려받은 파일이 어긋나지 않는다 — 그래서 React 없이 여기 모으고 테스트로 잠근다.
//
// DB 계약(public.action_logs, 마이그레이션 20261112090000_action_logs):
//   action_log_devices(p_from, p_to, p_accounts_only, p_limit) — 기기별 요약, last_at 내림차순
//   action_log_rows(p_from, p_to, p_device_id, p_after_id, p_limit) — 행, id 오름차순(키셋 페이지)
// 읽기는 users.role = 'developer' 만 된다(DB 가 42501 로 막는다 — 심사 계정은 admin 이라 못 본다).

import { JUDGE_ACCOUNTS, type JudgeConsole } from './judgeAccounts';

export const ACTION_LOG_MIGRATION = '20261112090000_action_logs';

/** 한국 표준시. 서머타임이 없어 고정 +9시간이면 된다(기기 시간대와 무관하게 같은 결과). */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 브라우저가 heartbeat 를 보내는 간격(초). 수집 쪽(lib/actionLog)은 **탭이 보이는 동안** 30초마다 보내고,
 * 입력이 10분 넘게 없으면 5분마다로 줄인다. props.active 는 직전 30초 안에 입력이 있었는가다.
 * 그래서 heartbeat 수 × 30초는 '열어 둔 시간'에 가까운 대략값이고(오래 방치한 시간은 덜 센다),
 * active 인 것만 센 값이 '조작한 시간'에 가깝다.
 */
export const HEARTBEAT_INTERVAL_S = 30;
/** action_log_devices 의 p_limit 상한(DB 가 1..1000 으로 자른다). */
export const DEVICE_LIST_MAX = 1000;

// =========================================================================
// 행 타입 — RPC 가 주는 이름(snake_case)을 그대로 쓴다. CSV 열 이름도 이것이다.
// =========================================================================

export const ACTION_LOG_EVENTS = [
  'session_start',
  'page_view',
  'click',
  'input',
  'submit',
  'search',
  'voice',
  'key',
  'swipe',
  'scroll',
  'map',
  'visibility',
  'heartbeat',
  'api',
  'error',
  'auth',
] as const;
export type ActionLogEvent = (typeof ACTION_LOG_EVENTS)[number];

export const EVENT_LABELS: Record<ActionLogEvent, string> = {
  session_start: '세션 시작',
  page_view: '화면 이동',
  click: '클릭',
  input: '입력',
  submit: '제출',
  search: '검색',
  voice: '음성',
  key: '키 입력',
  swipe: '스와이프',
  scroll: '스크롤',
  map: '지도',
  visibility: '탭 전환',
  heartbeat: '하트비트',
  api: 'API',
  error: '오류',
  auth: '인증',
};

/** 모르는 이벤트 이름은 그대로 보여 준다(수집 쪽이 새 이벤트를 더해도 화면이 깨지지 않게). */
export function eventLabel(event: string): string {
  return (EVENT_LABELS as Record<string, string>)[event] ?? event;
}

export interface ActionLogDeviceAccount {
  user_id: string | null;
  email: string | null;
  role: string | null;
}

export interface ActionLogDevice {
  device_id: string;
  first_at: string | null;
  last_at: string | null;
  sessions: number;
  events: number;
  page_views: number;
  clicks: number;
  heartbeats: number;
  accounts: ActionLogDeviceAccount[];
  ips: string[];
  user_agent: string | null;
  landing: string | null;
  referrer: string | null;
}

export type ActionLogProps = Record<string, unknown>;

export interface ActionLogRow {
  id: number;
  received_at: string | null;
  occurred_at: string | null;
  device_id: string;
  session_id: string | null;
  seq: number | null;
  event: string;
  page: string | null;
  host: string | null;
  locale: string | null;
  props: ActionLogProps;
  user_id: string | null;
  email: string | null;
  is_anonymous: boolean | null;
  account_role: string | null;
  ip: string | null;
  /** 프록시 체인. DB 가 text 로 줄지 text[] 로 줄지에 상관없이 받는다. */
  ip_chain: string | string[] | null;
  user_agent: string | null;
}

// =========================================================================
// RPC 응답 정규화 — data 는 any 라 컴파일러가 모양을 지켜 주지 않는다.
// =========================================================================

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const v = typeof value === 'string' ? parseJson(value) : value;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    if (Array.isArray(parsed)) return parsed;
    // Postgres 배열 리터럴('{1.2.3.4,5.6.7.8}')로 올 때.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((part) => part.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    }
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function textOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function countOf(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function boolOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 't') return true;
  if (value === 'false' || value === 'f') return false;
  return null;
}

export function normalizeDevice(raw: unknown): ActionLogDevice | null {
  const r = asRecord(raw);
  const deviceId = textOrNull(r.device_id);
  if (!deviceId) return null;
  return {
    device_id: deviceId,
    first_at: textOrNull(r.first_at),
    last_at: textOrNull(r.last_at),
    sessions: countOf(r.sessions),
    events: countOf(r.events),
    page_views: countOf(r.page_views),
    clicks: countOf(r.clicks),
    heartbeats: countOf(r.heartbeats),
    accounts: asArray(r.accounts)
      .map((item) => {
        const a = asRecord(item);
        return { user_id: textOrNull(a.user_id), email: textOrNull(a.email), role: textOrNull(a.role) };
      })
      .filter((a) => a.user_id || a.email),
    ips: asArray(r.ips)
      .map(textOrNull)
      .filter((ip): ip is string => !!ip),
    user_agent: textOrNull(r.user_agent),
    landing: textOrNull(r.landing),
    referrer: textOrNull(r.referrer),
  };
}

export function normalizeDevices(data: unknown): ActionLogDevice[] {
  return Array.isArray(data)
    ? data.map(normalizeDevice).filter((d): d is ActionLogDevice => d !== null)
    : [];
}

/** 보여 줄 기기 수보다 한 대 더 물어, 정말 더 있는지(목록이 잘렸는지) 안다. 상한(1000)에서는 그럴 수 없다. */
export function deviceRequestLimit(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)) + 1, DEVICE_LIST_MAX);
}

/** deviceRequestLimit 로 받은 목록을 limit 대로 자르고, 잘렸는지 알려 준다. */
export function trimDeviceList<T>(list: readonly T[], limit: number): { devices: T[]; truncated: boolean } {
  const atMax = deviceRequestLimit(limit) <= limit; // 한 대 더 물을 수 없었다 — 꽉 찼으면 잘렸을 수 있다고 본다.
  return {
    devices: list.slice(0, limit),
    truncated: list.length > limit || (atMax && list.length >= limit),
  };
}

function ipChainOf(value: unknown): string | string[] | null {
  if (Array.isArray(value)) {
    return value.map(textOrNull).filter((ip): ip is string => !!ip);
  }
  return textOrNull(value);
}

/** Number(null) 이 0 이라 그냥 바꾸면 빈 값이 0 이 된다 — 빈 값은 NaN 으로 둔다. */
function numberOrNaN(value: unknown): number {
  return value === null || value === undefined || value === '' ? NaN : Number(value);
}

export function normalizeRow(raw: unknown): ActionLogRow | null {
  const r = asRecord(raw);
  const id = numberOrNaN(r.id);
  if (!Number.isFinite(id)) return null;
  const seq = numberOrNaN(r.seq);
  return {
    id,
    received_at: textOrNull(r.received_at),
    occurred_at: textOrNull(r.occurred_at),
    device_id: textOrNull(r.device_id) ?? '',
    session_id: textOrNull(r.session_id),
    seq: Number.isFinite(seq) ? seq : null,
    event: textOrNull(r.event) ?? '',
    page: textOrNull(r.page),
    host: textOrNull(r.host),
    locale: textOrNull(r.locale),
    props: asRecord(r.props),
    user_id: textOrNull(r.user_id),
    email: textOrNull(r.email),
    is_anonymous: boolOrNull(r.is_anonymous),
    account_role: textOrNull(r.account_role),
    ip: textOrNull(r.ip),
    ip_chain: ipChainOf(r.ip_chain),
    user_agent: textOrNull(r.user_agent),
  };
}

export function normalizeRows(data: unknown): ActionLogRow[] {
  return Array.isArray(data)
    ? data.map(normalizeRow).filter((row): row is ActionLogRow => row !== null)
    : [];
}

// =========================================================================
// RPC 오류 — 권한 없음(42501) · 함수 미배포(PGRST202/404) · 그 밖의 실패를 가른다.
// =========================================================================

export type ActionLogErrorKind = 'forbidden' | 'missing' | 'failed';

export class ActionLogError extends Error {
  readonly kind: ActionLogErrorKind;
  readonly code: string | null;

  constructor(kind: ActionLogErrorKind, message: string, code: string | null = null) {
    super(message);
    this.name = 'ActionLogError';
    this.kind = kind;
    this.code = code;
  }
}

/**
 * PostgREST 오류를 화면이 할 말로 가른다.
 *
 * 42501 은 DB 가 developer 가 아닌 호출을 막은 것이다(심사 계정 admin 포함). PGRST202 는 PostgREST
 * 스키마 캐시에 함수가 없다는 뜻이라 — 마이그레이션 전이거나 적용 뒤 스키마를 다시 읽지 않았다.
 */
export function classifyRpcError(
  error: { code?: unknown; message?: unknown } | null | undefined,
  status?: number | null,
): ActionLogErrorKind {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === '42501') return 'forbidden';
  if (code === 'PGRST202' || code === '42883' || status === 404) return 'missing';
  return 'failed';
}

/** 무엇이 던져졌든 ActionLogError 로 만든다(supabase-js 는 대개 던지지 않고 error 를 돌려준다). */
export function toActionLogError(err: unknown, status?: number | null): ActionLogError {
  if (err instanceof ActionLogError) return err;
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const message = typeof e.message === 'string' && e.message ? e.message : String(err ?? '');
  const code = typeof e.code === 'string' && e.code ? e.code : null;
  return new ActionLogError(classifyRpcError(e, status), message, code);
}

/** 화면에 띄울 문구. detail 은 한 줄 보충(없으면 null). */
export function actionLogErrorText(err: ActionLogError): { title: string; detail: string | null } {
  switch (err.kind) {
    case 'forbidden':
      return {
        title: '개발자 계정만 볼 수 있어요.',
        detail: '관리자(심사) 계정으로는 열리지 않아요. 개발자 계정으로 로그인했는지 확인하세요.',
      };
    case 'missing':
      return {
        title: `DB 마이그레이션(${ACTION_LOG_MIGRATION}) 적용 전이에요.`,
        detail:
          "이미 적용했다면 SQL Editor 에서 NOTIFY pgrst, 'reload schema'; 를 실행해 API 가 함수를 다시 읽게 하세요.",
      };
    default:
      return { title: '기록을 불러오지 못했어요.', detail: err.message || null };
  }
}

/** 다시 물어볼 만한 실패인가. 권한·미배포는 몇 번을 다시 물어도 같다. */
export function isRetryableActionLogError(err: unknown): boolean {
  return !(err instanceof ActionLogError) || err.kind === 'failed';
}

// =========================================================================
// 시각 — 모두 KST 로 보여 준다. 기기 시간대(Date#getHours)를 쓰지 않는다.
// =========================================================================

/**
 * timestamptz 문자열을 epoch ms 로. 못 읽으면 null.
 *
 * Postgres 는 마이크로초 6자리('…05.123456+00:00')와 시만 있는 오프셋('+00')을 줄 수 있고,
 * 사파리의 Date.parse 는 V8 보다 엄격하다. 그래서 먼저 ISO 모양으로 다듬는다.
 */
export function parseTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;
  s = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  const time = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/.exec(s);
  if (time) {
    const rest = s.slice(time.index + time[0].length);
    if (/^[+-]\d{2}$/.test(rest)) s += ':00';
    else if (/^[+-]\d{4}$/.test(rest)) s = `${s.slice(0, -2)}:${s.slice(-2)}`;
    else if (rest === '') s += 'Z'; // 오프셋이 없으면 UTC 로 본다(기기 시간대로 읽지 않게).
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** 'YYYY-MM-DDTHH:mm:ss.sssZ' 모양의 KST 벽시계. Date 범위를 벗어나면(toISOString 이 던진다) 빈 문자열. */
function kstIso(ms: number): string {
  const date = new Date(ms + KST_OFFSET_MS);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

/** epoch ms → KST 날짜 'YYYY-MM-DD'. */
export function kstDay(ms: number): string {
  return kstIso(ms).slice(0, 10);
}

export type KstFormat = 'full' | 'minute' | 'second' | 'time';

/**
 * KST 표기. full='2026-11-12 14:03:05'(CSV), minute='11-12 14:03'(기기 표),
 * second='11-12 14:03:05'(타임라인), time='14:03:05'. 못 읽으면 빈 문자열.
 */
export function formatKst(value: unknown, format: KstFormat = 'second'): string {
  const ms = parseTimestamp(value);
  if (ms === null) return '';
  const iso = kstIso(ms);
  if (!iso) return '';
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  switch (format) {
    case 'full':
      return `${date} ${time}`;
    case 'minute':
      return `${date.slice(5)} ${time.slice(0, 5)}`;
    case 'time':
      return time;
    default:
      return `${date.slice(5)} ${time}`;
  }
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' 의 KST 자정(epoch ms). 형식이 틀리면 NaN. */
export function kstDayStartMs(day: string): number {
  const m = DAY_RE.exec(day);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - KST_OFFSET_MS;
}

/** 날짜 칸이 받는 범위. 9999-12-31 같은 값은 다음 날이 Date 범위를 넘어 RPC 인자를 만들다 던진다. */
export const KST_DAY_MIN = '2000-01-01';
export const KST_DAY_MAX = '2100-12-31';

/** 달력에 있는 날짜인가('2026-02-30' 은 아니다). KST_DAY_MIN..KST_DAY_MAX 밖도 아니다. */
export function isKstDay(day: unknown): day is string {
  if (typeof day !== 'string' || day < KST_DAY_MIN || day > KST_DAY_MAX) return false;
  const start = kstDayStartMs(day);
  return Number.isFinite(start) && kstDay(start) === day;
}

export function addKstDays(day: string, days: number): string {
  const start = kstDayStartMs(day);
  return Number.isFinite(start) ? kstDay(start + days * DAY_MS) : '';
}

/** 기간 — KST 달력 날짜 둘(양 끝 포함). */
export interface KstDayRange {
  fromDay: string;
  toDay: string;
}

export type RangePreset = 'today' | '7d' | '30d';

export const RANGE_PRESETS: { key: RangePreset; label: string; days: number }[] = [
  { key: 'today', label: '오늘', days: 1 },
  { key: '7d', label: '7일', days: 7 },
  { key: '30d', label: '30일', days: 30 },
];

/** 오늘을 포함해 거꾸로 N일(KST 달력 기준). '7일' = 엿새 전 자정부터 오늘 끝까지. */
export function presetRange(preset: RangePreset, nowMs: number): KstDayRange {
  const days = RANGE_PRESETS.find((p) => p.key === preset)?.days ?? 7;
  const today = kstDay(nowMs);
  return { fromDay: addKstDays(today, -(days - 1)), toDay: today };
}

/** 앞뒤가 뒤집혔으면 바로잡는다. */
export function normalizeRange(range: KstDayRange): KstDayRange {
  return range.fromDay <= range.toDay ? range : { fromDay: range.toDay, toDay: range.fromDay };
}

/** RPC 인자. to 는 마지막 날 **다음 날** KST 자정 — 마지막 날 23:59:59.999 까지 들어온다. */
export function rangeToIso(range: KstDayRange): { from: string; to: string } {
  const r = normalizeRange(range);
  return {
    from: new Date(kstDayStartMs(r.fromDay)).toISOString(),
    to: new Date(kstDayStartMs(addKstDays(r.toDay, 1))).toISOString(),
  };
}

export function rangeDayCount(range: KstDayRange): number {
  const r = normalizeRange(range);
  return Math.round((kstDayStartMs(r.toDay) - kstDayStartMs(r.fromDay)) / DAY_MS) + 1;
}

/**
 * 내려받기의 끝 시각을 '시작한 순간 − margin' 과 기간 끝 중 이른 쪽으로 고정한다.
 *
 * 오늘이 든 기간을 받는 동안에도 행은 계속 들어온다. 끝을 열어 두면 파일이 받는 도중의 상태로 흔들리고,
 * id 를 먼저 받고 늦게 커밋된 행은 키셋이 이미 지나간 자리라 빠질 수 있다 — 고정한 끝 앞의 행만 받으면 둘 다 없다.
 */
export function snapshotUpperBound(toIso: string, nowMs: number, marginMs = 10_000): string {
  const to = Date.parse(toIso);
  const cut = nowMs - marginMs;
  return new Date(Number.isFinite(to) ? Math.min(to, cut) : cut).toISOString();
}

// =========================================================================
// 시간 길이
// =========================================================================

/** 초 → '45초' · '2분 30초' · '1시간 5분' · '2일 3시간'. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}초`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}분 ${s}초` : `${m}분`;
  }
  if (total < 86400) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  return h ? `${d}일 ${h}시간` : `${d}일`;
}

/** heartbeat 수 → 초(× 30). '열어 둔 시간'에 가까운 대략값이다 — HEARTBEAT_INTERVAL_S 주석 참고. */
export function heartbeatSeconds(heartbeats: number): number {
  return Math.max(0, Number.isFinite(heartbeats) ? heartbeats : 0) * HEARTBEAT_INTERVAL_S;
}

/** 브라우저가 적은 시각 − 서버가 받은 시각(초). 둘 중 하나라도 못 읽으면 null. */
export function clockDiffSeconds(occurredAt: unknown, receivedAt: unknown): number | null {
  const occurred = parseTimestamp(occurredAt);
  const received = parseTimestamp(receivedAt);
  if (occurred === null || received === null) return null;
  return Math.round(occurred - received) / 1000;
}

/**
 * 시각 차이 표기 — '-1.2초' · '+12초' · '-3분 5초'.
 * 보통은 몇 초 음수다(브라우저가 모았다가 보낸다). 크게 어긋나면 기기 시계가 틀렸거나 오프라인 뒤에 몰아 보낸 것.
 */
export function formatClockDiff(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const abs = Math.abs(seconds);
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  if (abs < 10) {
    const text = abs.toFixed(1);
    return text === '0.0' ? '0초' : `${sign}${text}초`;
  }
  return `${sign}${formatDuration(abs)}`;
}

// =========================================================================
// 짧은 표기
// =========================================================================

export function shortId(id: unknown, length = 8): string {
  const text = textOrNull(id) ?? '';
  return text.length > length ? text.slice(0, length) : text;
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const BROWSER_RULES: { re: RegExp; name: string; version?: boolean }[] = [
  // 앱 안 브라우저 — 심사위원이 카톡·네이버로 받은 링크를 눌렀을 때 이렇게 보인다.
  { re: /KAKAOTALK/i, name: '카카오톡 앱' },
  { re: /NAVER\(inapp/i, name: '네이버 앱' },
  { re: /Instagram/, name: '인스타그램 앱' },
  // 크로뮴 계열은 UA 에 Chrome/ 이 같이 있어 먼저 본다.
  { re: /Whale\/(\d+)/, name: 'Whale', version: true },
  { re: /SamsungBrowser\/(\d+)/, name: 'Samsung Internet', version: true },
  { re: /Edg(?:e|A|iOS)?\/(\d+)/, name: 'Edge', version: true },
  { re: /OPR\/(\d+)/, name: 'Opera', version: true },
  { re: /(?:Firefox|FxiOS)\/(\d+)/, name: 'Firefox', version: true },
  { re: /HeadlessChrome\/(\d+)/, name: 'Headless Chrome', version: true },
  { re: /CriOS\/(\d+)/, name: 'Chrome', version: true },
  { re: /Chrome\/(\d+)/, name: 'Chrome', version: true },
  { re: /Version\/(\d+)[\d.]*.*Safari\//, name: 'Safari', version: true },
];

function osOf(ua: string): string {
  // 순서가 중요하다: 아이폰 UA 에는 'Mac OS X', 안드로이드 UA 에는 'Linux' 가 같이 들어 있다.
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows NT|Windows Phone|Win64/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

/**
 * 검색엔진·링크 미리보기 봇. 'Googlebot/2.1' 처럼 이름 뒤에 '/버전' 이 붙은 것만 본다 —
 * 그냥 'bot' 이 들어 있는지로 보면 휴대폰 이름(CUBOT X30)까지 봇이 된다. 네이버 Yeti·다음 Daum 은 이름에 bot 이 없다.
 * 카카오톡 링크 미리보기(kakaotalk-scrap)는 아래 '카카오톡 앱' 규칙보다 먼저 걸러야 사람으로 안 센다.
 */
const BOT_RE = /([\w-]*(?:bot|crawler|spider|scrap)[\w-]*)\/\d|compatible;\s*(Yeti|Daum[\w-]*)\//i;

/** User-Agent → 'Chrome 142 · Windows' 같은 짧은 표기. 비어 있으면 빈 문자열. */
export function shortUserAgent(ua: unknown): string {
  const text = typeof ua === 'string' ? ua.trim() : '';
  if (!text) return '';
  const bot = BOT_RE.exec(text);
  if (bot) return `봇 · ${bot[1] ?? bot[2]}`;
  let browser = '';
  for (const rule of BROWSER_RULES) {
    const m = rule.re.exec(text);
    if (m) {
      browser = rule.version && m[1] ? `${rule.name} ${m[1]}` : rule.name;
      break;
    }
  }
  const os = osOf(text);
  if (!browser && !os) {
    // 브라우저가 아닌 도구(curl/8.4.0 · python-requests/2.31) — 첫 토큰만.
    const tool = /^([\w.-]+)\/(\d+)/.exec(text);
    return tool ? `${tool[1]} ${tool[2]}` : clip(text, 40);
  }
  return [browser, os].filter(Boolean).join(' · ');
}

/** 유입 경로 → 호스트('google.com'). 비었으면 '직접'. */
export function referrerLabel(referrer: unknown): string {
  const text = typeof referrer === 'string' ? referrer.trim() : '';
  if (!text) return '직접';
  try {
    const host = new URL(text).hostname.replace(/^www\./, '');
    return host || clip(text, 40);
  } catch {
    return clip(text, 40);
  }
}

/** 전체 URL 이면 경로(+쿼리)만, 경로면 그대로. */
export function pathLabel(value: unknown, max = 60): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return clip(`${url.pathname}${url.search}`, max);
    } catch {
      return clip(text, max);
    }
  }
  return clip(text, max);
}

export function ipChainText(chain: string | string[] | null | undefined): string {
  if (Array.isArray(chain)) return chain.join(', ');
  return chain ?? '';
}

// =========================================================================
// 내용 요약 — 이벤트마다 사람이 읽을 한 줄(표의 '내용' 열 · CSV 의 summary 열)
// =========================================================================

function propText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function quoted(value: unknown, max = 60): string {
  const text = propText(value);
  return text ? `“${clip(text, max)}”` : '';
}

function sizeText(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const w = propText(v.w ?? v.width);
    const h = propText(v.h ?? v.height);
    if (w && h) return `${w}×${h}`;
  }
  return propText(value);
}

function genericSummary(props: ActionLogProps): string {
  const parts = Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}=${clip(text, 40)}`;
    });
  return clip(parts.join(' · '), 200);
}

const SWIPE_DIRS: Record<string, string> = { left: '왼쪽', right: '오른쪽', up: '위', down: '아래' };

/** 이벤트별 한 줄 요약. 이벤트 이름은 옆 열에 있으니 되풀이하지 않는다. */
export function summarizeProps(event: string, rawProps: unknown): string {
  const p = asRecord(rawProps);
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  switch (event) {
    case 'click': {
      const name = propText(p.name);
      const testid = propText(p.testid);
      const target = [propText(p.tag), propText(p.role)].filter(Boolean).join('/');
      const label = name ? quoted(name) : testid ? `#${testid}` : '';
      const href = propText(p.href);
      return join(
        [label, target && `(${target})`].filter(Boolean).join(' '),
        name && testid ? `#${testid}` : '',
        href ? `→ ${clip(href, 80)}` : '',
      );
    }
    case 'input': {
      const field = propText(p.field) || '입력칸';
      const type = propText(p.type);
      const length = propText(p.length);
      // 비밀번호 칸은 수집 쪽이 값을 안 보내야 하지만, 혹시 들어와도 화면에는 내지 않는다.
      const secret = type === 'password';
      return join(
        `${field}${type ? `(${type})` : ''}`,
        length ? `${length}자` : '',
        secret ? (p.value !== undefined ? '값 숨김' : '') : quoted(p.value),
      );
    }
    case 'search':
      return join(quoted(p.q, 80), propText(p.source));
    case 'voice':
      return join(propText(p.phase) ? `[${propText(p.phase)}]` : '', quoted(p.text, 80), propText(p.source));
    case 'key':
      return propText(p.key);
    case 'swipe': {
      const dir = propText(p.dir);
      const dist = propText(p.dist);
      return join(SWIPE_DIRS[dir] ?? dir, dist ? `${dist}px` : '');
    }
    case 'scroll': {
      const depth = propText(p.depth);
      return depth ? `${depth}%` : '';
    }
    case 'map':
      return join(propText(p.kind), propText(p.level) ? `레벨 ${propText(p.level)}` : '');
    case 'visibility': {
      const state = propText(p.state);
      return state === 'hidden' ? '숨김(다른 탭·앱으로)' : state === 'visible' ? '다시 보임' : state;
    }
    case 'heartbeat':
      return p.active === false ? '자리 비움' : '활동 중';
    case 'api': {
      const status = propText(p.status);
      const ms = propText(p.ms);
      return join(
        [propText(p.method), clip(propText(p.path), 80)].filter(Boolean).join(' '),
        status ? `→ ${status}` : '',
        ms ? `${ms}ms` : '',
        propText(p.svc),
      );
    }
    case 'error': {
      const file = propText(p.file);
      const line = propText(p.line);
      return join(clip(propText(p.message), 140), file ? `${clip(file, 60)}${line ? `:${line}` : ''}` : '');
    }
    case 'auth':
      return join(propText(p.kind), propText(p.provider), p.anonymous === true ? '게스트(익명)' : '');
    case 'page_view': {
      const from = propText(p.from);
      const query = propText(p.query);
      return join(from ? `← ${clip(from, 60)}` : '', propText(p.nav), query ? `?${clip(query.replace(/^\?/, ''), 60)}` : '');
    }
    case 'session_start': {
      const languages = Array.isArray(p.languages) ? p.languages.map(propText).filter(Boolean).join(',') : propText(p.languages);
      return join(
        propText(p.landing) ? `첫 화면 ${pathLabel(p.landing)}` : '',
        `유입 ${referrerLabel(p.referrer)}`,
        sizeText(p.viewport) ? `창 ${sizeText(p.viewport)}` : '',
        sizeText(p.screen) ? `화면 ${sizeText(p.screen)}` : '',
        propText(p.timezone),
        languages,
      );
    }
    default:
      return genericSummary(p);
  }
}

// =========================================================================
// 심사 계정 · 계정 표기
// =========================================================================

export const JUDGE_CONSOLE_LABELS: Record<JudgeConsole, string> = {
  merchant: '사장님 콘솔',
  admin: '관제',
};

/** 심사 계정 이메일이면 그 콘솔, 아니면 null. 대소문자·앞뒤 공백은 무시한다. */
export function judgeConsoleForEmail(email: unknown): JudgeConsole | null {
  if (typeof email !== 'string') return null;
  const target = email.trim().toLowerCase();
  if (!target) return null;
  for (const key of Object.keys(JUDGE_ACCOUNTS) as JudgeConsole[]) {
    if (JUDGE_ACCOUNTS[key].toLowerCase() === target) return key;
  }
  return null;
}

export function deviceHasJudge(device: ActionLogDevice): boolean {
  return device.accounts.some((a) => judgeConsoleForEmail(a.email) !== null);
}

export interface JudgeUsage {
  console: JudgeConsole;
  email: string;
  devices: number;
  /** 그 기기들의 이벤트 합 — 같은 기기의 로그인 전(게스트) 행동도 들어간다. */
  events: number;
  firstAt: string | null;
  lastAt: string | null;
}

/** 심사 계정마다 이 목록에서 쓴 기기 수 · 처음 · 마지막. 기록이 없어도 0 으로 한 줄씩 낸다. */
export function judgeUsage(devices: readonly ActionLogDevice[]): JudgeUsage[] {
  return (Object.keys(JUDGE_ACCOUNTS) as JudgeConsole[]).map((key) => {
    const used = devices.filter((d) => d.accounts.some((a) => judgeConsoleForEmail(a.email) === key));
    let firstAt: string | null = null;
    let lastAt: string | null = null;
    let firstMs = Infinity;
    let lastMs = -Infinity;
    for (const d of used) {
      const f = parseTimestamp(d.first_at);
      const l = parseTimestamp(d.last_at);
      if (f !== null && f < firstMs) {
        firstMs = f;
        firstAt = d.first_at;
      }
      if (l !== null && l > lastMs) {
        lastMs = l;
        lastAt = d.last_at;
      }
    }
    return {
      console: key,
      email: JUDGE_ACCOUNTS[key],
      devices: used.length,
      events: used.reduce((sum, d) => sum + d.events, 0),
      firstAt,
      lastAt,
    };
  });
}

/** 기기 표의 계정 한 줄: 'openapi@gmail.com · admin'. 이메일이 없으면 uid 앞자리. */
export function accountLabel(account: { user_id: string | null; email: string | null; role: string | null }): string {
  const who = account.email || (account.user_id ? `uid ${shortId(account.user_id, 8)}` : '');
  return [who, account.role].filter(Boolean).join(' · ');
}

/** 타임라인 행의 계정. 로그인 안 한 행은 빈 문자열, 익명 세션은 '게스트'. */
export function rowAccountLabel(row: ActionLogRow): string {
  if (row.email) return [row.email, row.account_role].filter(Boolean).join(' · ');
  if (row.user_id) {
    return row.is_anonymous ? `게스트 ${shortId(row.user_id, 6)}` : accountLabel({ user_id: row.user_id, email: null, role: row.account_role });
  }
  return '';
}

// =========================================================================
// 세션 묶음 — 타임라인은 세션(탭)마다 끊어 보여 주고 머리에 요약을 단다.
// =========================================================================

export interface SessionGroup {
  /** 행의 session_id. 없던 행끼리는 null 한 묶음. */
  sessionId: string | null;
  rows: ActionLogRow[];
  /** 서버가 받은 시각(received_at) 기준 — 브라우저 시계는 틀릴 수 있다. */
  startAt: string | null;
  endAt: string | null;
  durationS: number | null;
  events: number;
  pageViews: number;
  clicks: number;
  /** heartbeat 전부 × 30초 — 탭을 열어 둔(보이던) 시간에 가까운 대략값. 기기 표의 값과 같은 셈법이다. */
  visibleS: number;
  /** 그중 active(직전 30초 안에 입력)인 heartbeat × 30초 — 조작한 시간에 가까운 대략값. */
  activeS: number;
  accounts: { user_id: string | null; email: string | null; role: string | null; anonymous: boolean }[];
  ips: string[];
  firstPage: string | null;
}

/** 세션별로 묶어 시작 시각 순으로 낸다. 각 묶음 안의 행 순서는 들어온 그대로(id 오름차순)다. */
export function groupBySession(rows: readonly ActionLogRow[]): SessionGroup[] {
  interface Acc extends SessionGroup {
    startMs: number;
    endMs: number;
    seenAccounts: Set<string>;
  }
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    const key = row.session_id ?? '';
    let g = groups.get(key);
    if (!g) {
      g = {
        sessionId: row.session_id,
        rows: [],
        startAt: null,
        endAt: null,
        durationS: null,
        events: 0,
        pageViews: 0,
        clicks: 0,
        visibleS: 0,
        activeS: 0,
        accounts: [],
        ips: [],
        firstPage: null,
        startMs: Infinity,
        endMs: -Infinity,
        seenAccounts: new Set(),
      };
      groups.set(key, g);
    }
    g.rows.push(row);
    g.events += 1;
    if (row.event === 'page_view') g.pageViews += 1;
    if (row.event === 'click') g.clicks += 1;
    if (row.event === 'heartbeat') {
      g.visibleS += HEARTBEAT_INTERVAL_S;
      if (row.props.active !== false) g.activeS += HEARTBEAT_INTERVAL_S;
    }
    const at = parseTimestamp(row.received_at);
    if (at !== null) {
      if (at < g.startMs) {
        g.startMs = at;
        g.startAt = row.received_at;
      }
      if (at > g.endMs) {
        g.endMs = at;
        g.endAt = row.received_at;
      }
    }
    if (!g.firstPage && row.page) g.firstPage = row.page;
    const accountKey = row.user_id || row.email;
    if (accountKey && !g.seenAccounts.has(accountKey)) {
      g.seenAccounts.add(accountKey);
      g.accounts.push({
        user_id: row.user_id,
        email: row.email,
        role: row.account_role,
        anonymous: row.is_anonymous === true,
      });
    }
    if (row.ip && !g.ips.includes(row.ip)) g.ips.push(row.ip);
  }
  // 시각을 못 읽은 묶음(startMs=Infinity)은 뒤로. Infinity - Infinity 는 NaN 이라 뺄셈으로 비교하지 않는다.
  return [...groups.values()]
    .sort((a, b) => (a.startMs === b.startMs ? 0 : a.startMs < b.startMs ? -1 : 1))
    .map(({ startMs, endMs, seenAccounts: _seen, ...group }) => ({
      ...group,
      durationS: Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 1000 : null,
    }));
}

// =========================================================================
// 키셋 페이지 모으기 — id 오름차순으로 p_after_id 를 넘기며 끝(빈 쪽)까지.
// =========================================================================

export interface KeysetOptions<T extends { id: number }> {
  /** afterId 보다 큰 id 를 limit 개까지(오름차순). 실패하면 던진다. */
  fetchPage: (afterId: number, limit: number) => Promise<T[]>;
  afterId?: number;
  pageSize: number;
  /** 이만큼 모이면 멈춘다(안전 상한). 멈춘 자리에서 더 있는지는 한 건만 물어 본다. */
  maxRows: number;
  onPage?: (rows: T[], loaded: number) => void;
  isCancelled?: () => boolean;
  /** 한 쪽당 다시 묻는 횟수. 다시 물을 때마다 쪽 크기를 절반으로 줄인다(타임아웃 대비). */
  retries?: number;
  minPageSize?: number;
  isRetryable?: (err: unknown) => boolean;
  retryDelayMs?: number;
}

export interface KeysetResult {
  loaded: number;
  /** 마지막으로 받은 id — '더 불러오기' 가 여기서 이어 간다. */
  lastId: number;
  /** end=끝까지 받음, cap=상한에서 멈췄고 더 있다, cancelled=중간에 그만둠. */
  reason: 'end' | 'cap' | 'cancelled';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 키셋으로 끝까지 받는다.
 *
 * 쪽이 요청보다 짧아도 끝으로 보지 않는다 — PostgREST 의 max-rows(Supabase 기본 1000)가 요청한
 * p_limit 보다 작으면 쪽마다 잘려 오기 때문이다. 빈 쪽이 와야 끝이다(요청 한 번이 더 들 뿐이다).
 * 대신 짧게 온 크기를 다음 쪽 크기로 배운다: 읽기 함수가 plpgsql 이라 p_limit 만큼 다 만든 뒤에 잘리므로,
 * 5000 을 계속 청하면 쪽마다 4000 행을 헛되이 만든다(6초 타임아웃에 가까워진다).
 *
 * 실패는 던진다(받은 데까지는 onPage 로 이미 넘겼다 — 이어 받기는 호출하는 쪽이 마지막 id 로 한다).
 * 그만둔 뒤에 난 실패는 실패로 치지 않고 cancelled 로 끝낸다.
 */
export async function collectKeyset<T extends { id: number }>(options: KeysetOptions<T>): Promise<KeysetResult> {
  const retries = options.retries ?? 2;
  const delay = options.retryDelayMs ?? 600;
  let pageSize = Math.max(1, Math.floor(options.pageSize));
  const minPageSize = Math.max(1, Math.min(options.minPageSize ?? 250, pageSize));
  let afterId = options.afterId ?? 0;
  let loaded = 0;
  const cancelled = () => options.isCancelled?.() === true;

  /** 한 쪽 받기. 그만뒀으면 null. */
  const fetchWithRetry = async (requested: number): Promise<T[] | null> => {
    let limit = requested;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await options.fetchPage(afterId, limit);
      } catch (err) {
        if (cancelled()) return null;
        const retryable = options.isRetryable ? options.isRetryable(err) : true;
        if (attempt >= retries || !retryable) throw err;
        pageSize = Math.max(minPageSize, Math.floor(pageSize / 2));
        limit = Math.max(1, Math.min(limit, pageSize));
        if (delay > 0) await sleep(delay * (attempt + 1));
        if (cancelled()) return null;
      }
    }
  };

  for (;;) {
    if (cancelled()) return { loaded, lastId: afterId, reason: 'cancelled' };
    const remaining = options.maxRows - loaded;
    if (remaining <= 0) {
      // 딱 상한만큼만 있었던 경우를 '잘렸다' 고 말하지 않게, 한 건만 더 물어 본다.
      // 그 물음이 실패해도 받은 것은 다 받았다 — 뒤가 있는지 모를 뿐이니 잘렸을 수 있다(cap)고 보고한다.
      let probe: T[] | null;
      try {
        probe = await fetchWithRetry(1);
      } catch {
        return { loaded, lastId: afterId, reason: 'cap' };
      }
      if (probe === null || cancelled()) return { loaded, lastId: afterId, reason: 'cancelled' };
      return { loaded, lastId: afterId, reason: probe.length > 0 ? 'cap' : 'end' };
    }
    const requested = Math.min(pageSize, remaining);
    const rows = await fetchWithRetry(requested);
    if (rows === null || cancelled()) return { loaded, lastId: afterId, reason: 'cancelled' };
    if (rows.length === 0) return { loaded, lastId: afterId, reason: 'end' };
    if (rows.length < requested) pageSize = rows.length;
    let maxId = afterId;
    for (const row of rows) if (row.id > maxId) maxId = row.id;
    // 서버가 같은 쪽을 되풀이하면 끝없이 돈다 — 앞으로 가지 않으면 멈춘다.
    if (maxId <= afterId) throw new Error(`키셋이 앞으로 가지 않았어요(after_id ${afterId}).`);
    loaded += rows.length;
    afterId = maxId;
    options.onPage?.(rows, loaded);
  }
}

// =========================================================================
// CSV — 엑셀이 한글을 깨뜨리지 않게 UTF-8 BOM, 줄바꿈은 CRLF.
// =========================================================================

export const CSV_BOM = '﻿';

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/** 엑셀이 수식으로 읽는 첫 글자. 방문자가 친 값(검색어·UA·경로)이 수식으로 실행되지 않게 막는다. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** 값 하나 → CSV 칸. 객체·배열은 JSON, 문자열은 수식 방지 후 필요할 때만 따옴표로 감싼다. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'string') text = FORMULA_START.test(value) ? `'${value}` : value;
  else if (value instanceof Date) text = Number.isFinite(value.getTime()) ? value.toISOString() : '';
  else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = String(value);
    }
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

export function csvHeader<T>(columns: readonly CsvColumn<T>[]): string {
  return `${csvLine(columns.map((c) => c.header))}\r\n`;
}

/** 머리줄 없이 행만(끝에 CRLF). 쪽마다 이어 붙이는 내보내기용. */
export function csvRows<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  let out = '';
  for (const row of rows) out += `${csvLine(columns.map((c) => c.value(row)))}\r\n`;
  return out;
}

/** BOM + 머리줄 + 행 전부. */
export function buildCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  return CSV_BOM + csvHeader(columns) + csvRows(columns, rows);
}

/** 기기 목록 CSV 열 — RPC 필드 전부 + 사람이 읽기 쉬운 파생 열(KST·활동 분·심사 계정·브라우저). */
export const DEVICE_CSV_COLUMNS: CsvColumn<ActionLogDevice>[] = [
  { header: 'device_id', value: (d) => d.device_id },
  { header: 'first_at_kst', value: (d) => formatKst(d.first_at, 'full') },
  { header: 'last_at_kst', value: (d) => formatKst(d.last_at, 'full') },
  { header: 'first_at', value: (d) => d.first_at },
  { header: 'last_at', value: (d) => d.last_at },
  { header: 'sessions', value: (d) => d.sessions },
  { header: 'events', value: (d) => d.events },
  { header: 'page_views', value: (d) => d.page_views },
  { header: 'clicks', value: (d) => d.clicks },
  { header: 'heartbeats', value: (d) => d.heartbeats },
  // '활동' 이 아니라 '열어 둔' 시간이다 — 방치된 탭도 heartbeat 를 보낸다(HEARTBEAT_INTERVAL_S 주석).
  { header: 'visible_minutes_est', value: (d) => Math.round((heartbeatSeconds(d.heartbeats) / 60) * 10) / 10 },
  {
    header: 'judge_accounts',
    value: (d) =>
      d.accounts
        .filter((a) => judgeConsoleForEmail(a.email) !== null)
        .map((a) => a.email)
        .join('; '),
  },
  { header: 'account_list', value: (d) => d.accounts.map(accountLabel).join('; ') },
  { header: 'accounts', value: (d) => d.accounts },
  { header: 'ips', value: (d) => d.ips },
  { header: 'user_agent', value: (d) => d.user_agent },
  { header: 'browser', value: (d) => shortUserAgent(d.user_agent) },
  { header: 'landing', value: (d) => d.landing },
  { header: 'referrer', value: (d) => d.referrer },
];

/** 행 CSV 열 — RPC 필드 전부(props 는 JSON) + KST 시각 · 시각 차이 · 내용 요약 · 심사 계정. */
export const ROW_CSV_COLUMNS: CsvColumn<ActionLogRow>[] = [
  { header: 'id', value: (r) => r.id },
  { header: 'received_at_kst', value: (r) => formatKst(r.received_at, 'full') },
  { header: 'received_at', value: (r) => r.received_at },
  { header: 'occurred_at', value: (r) => r.occurred_at },
  { header: 'clock_diff_s', value: (r) => clockDiffSeconds(r.occurred_at, r.received_at) },
  { header: 'device_id', value: (r) => r.device_id },
  { header: 'session_id', value: (r) => r.session_id },
  { header: 'seq', value: (r) => r.seq },
  { header: 'event', value: (r) => r.event },
  { header: 'page', value: (r) => r.page },
  { header: 'host', value: (r) => r.host },
  { header: 'locale', value: (r) => r.locale },
  { header: 'summary', value: (r) => summarizeProps(r.event, r.props) },
  { header: 'props', value: (r) => r.props },
  { header: 'user_id', value: (r) => r.user_id },
  { header: 'email', value: (r) => r.email },
  { header: 'is_anonymous', value: (r) => r.is_anonymous },
  { header: 'account_role', value: (r) => r.account_role },
  { header: 'judge_account', value: (r) => judgeConsoleForEmail(r.email) ?? '' },
  { header: 'ip', value: (r) => r.ip },
  { header: 'ip_chain', value: (r) => r.ip_chain },
  { header: 'user_agent', value: (r) => r.user_agent },
];

/**
 * 파일 이름 — nextspot-action-log_<from>_<to>[_devices[_accounts-only]|_device-xxxx][_partial].csv (날짜는 KST).
 * 상한·오류로 다 못 받은 파일에는 _partial 을, 로그인 기기만 거른 목록에는 _accounts-only 를 붙여
 * 파일만 받아 본 사람도 무엇이 빠졌는지 알게 한다.
 */
export function csvFileName(
  range: KstDayRange,
  options: { kind?: 'rows' | 'devices'; deviceId?: string | null; accountsOnly?: boolean; partial?: boolean } = {},
): string {
  const r = normalizeRange(range);
  let name = `nextspot-action-log_${r.fromDay}_${r.toDay}`;
  if (options.kind === 'devices') name += options.accountsOnly ? '_devices_accounts-only' : '_devices';
  if (options.deviceId) {
    // 거른 다음에 자른다 — 자르고 거르면 경로 문자만큼 이름이 짧아진다.
    const safe = shortId(options.deviceId.replace(/[^A-Za-z0-9_-]/g, ''), 8);
    if (safe) name += `_device-${safe}`;
  }
  if (options.partial) name += '_partial';
  return `${name}.csv`;
}
