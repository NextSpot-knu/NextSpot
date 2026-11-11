// 접속·조작 기록 — 이 앱에서 사람이 한 일을 우리 DB(public.action_logs)에 한 줄씩 남긴다(2026-11-12).
//
// 왜: 부처 조사 뒤 공모전 재심사에서 심사위원이 서비스를 실제로 써 봤는지를 보여 줘야 한다. 심사위원은 대개 게스트
// (Supabase 익명 세션)로 관광객 화면을 둘러보고, 콘솔은 심사용 계정(사장님 openapi@naver.com · 관제 openapi@gmail.com)으로 본다.
// 그래서 모든 방문을 남기고, 로그인해 있으면 그 계정에 이어진다(user_id 는 DB 가 요청 JWT 의 auth.uid() 로 찍는다).
//
// 익명 이용 기록(lib/usageEvents · components/shell/UsageTracker · lib/analytics)과는 별개다 — 그쪽은 익명 통계로 그대로 두고,
// 여기는 계정에 이어지는 서비스 운영 기록이라 기기 번호도 따로 쓴다(nextspot_anon_id 를 재사용하지 않는다).
//
// 담는 것 / 담지 않는 것 — 개인정보 안내(app/mypage/privacy 의 '접속·조작 기록' 절)와 같은 내용이다.
// ⚠️ 범위·보관 기간·안내 문구는 법률 검토 대기 중이다(2026-11-12). 여기를 바꾸면 안내 문구 4개 로케일도 함께 바꾼다.
//   · 브라우저는 occurred_at(브라우저 시계) · device_id · session_id · seq · event · page · host · locale · props 만 보낸다.
//     받은 시각 · 계정 · 익명 여부 · 역할 · IP 원본(1년 보관) · 브라우저 정보는 DB 트리거가 요청에서 찍는다.
//   · 입력값은 담지 않는다. 예외는 검색칸(input[type=search] · [role=searchbox] · data-log-value="search")과 음성 비서에게 한
//     말뿐이고, 그것도 maskText 로 이메일·전화번호·긴 숫자를 가린다. 비밀번호·이메일·전화 칸은 표시가 붙어 있어도 값을 읽지 않는다.
//     사람이 쓴 글(문의 본문·프로필)이 버튼 안에 보이는 곳은 data-log-private 로 감싸면 그 안에서는 이름을 읽지 않는다
//     (/dev 개발자 콘솔은 통째로 그렇게 다룬다). 버튼·링크가 아닌 곳을 누르면 글자를 아예 읽지 않는다.
//   · 음성 녹음 · 위치 좌표(지도 중심 포함) · 쿼리스트링의 인증 값 · 요청/응답 본문은 어디에도 담지 않는다. 위치정보법 때문에
//     쿼리의 좌표 키와 자유 텍스트 속 좌표 꼴 숫자도 [geo] 로 바꾼다. 지도는 확대 단계만 남긴다.
//
// 언제 남기나(shouldRecordActionLog): 운영 주소(nextspot-nu.vercel.app + NEXT_PUBLIC_ACTION_LOG_HOSTS)에서 자동화가 아닌
// 브라우저(navigator.webdriver 가 아님)일 때. window.__NEXTSPOT_ACTION_LOG__ === 'force' 면 둘 다 무시하고 켠다(e2e/action-log.spec.ts).
// 추적 거부(Do Not Track)·지역(내부 검증 지역)으로는 끄지 않는다 — 광고·제3자 추적이 아니라 개인정보 안내에 적어 둔 1차 서비스
// 운영 기록이고, '모든 방문을 남긴다' 가 운영자 결정이기 때문이다.
//
// 보내는 법: 모았다가(첫 줄 뒤 3초 또는 25줄) Supabase REST 로 한 번에 넣는다(한 번에 50줄 · 60KB 이하). 보내기 전까지는
// localStorage(nextspot_action_outbox:<세션 번호> — 탭(세션)마다 키 하나, 키마다 최대 300줄)에 비춰 두어 새로고침에도 남는다.
// 탭마다 자기 키만 쓰므로 탭끼리 같은 값을 읽고-고쳐-쓰다 서로 덮지 않는다. 실패하면 물러났다 다시 보내고, 표가 아직 없거나
// 권한이 없으면(404 · 401 · 403) 잠시 멈췄다가(3분부터 늘려 30분까지) 다시 시도하며 저장분은 지킨다. 어떤 예외도 화면으로 던지지 않는다.
//
// 전송은 '적어도 한 번' 이다 — 응답을 못 받은 줄(끊긴 요청 · pagehide 의 keepalive)은 저장분에 남겨 다시 보낸다. DB 의
// (session_id, seq) 유일 인덱스가 이미 들어간 줄을 409(23505)로 돌려주면 그 줄은 '이미 저장됨' 으로 보고 지운다(버림으로 세지 않는다).
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { createPublicClient } from '@/lib/supabase';

/** DB CHECK 와 같은 목록·순서(supabase/migrations 의 action_logs) — 하나를 더하면 둘 다 고친다. */
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
export type ActionLogScalar = string | number | boolean | null;
export type ActionLogValue = ActionLogScalar | ActionLogScalar[];
/** logAction 에 넘기는 속성 — undefined 인 키는 빠진다. 문자열은 전부 maskText 를 거친다. */
export type ActionLogProps = Record<string, ActionLogValue | undefined>;

/** 브라우저가 넣을 수 있는 칸 전부(나머지는 DB 트리거가 찍는다). */
export interface ActionLogRow {
  occurred_at: string;
  device_id: string;
  session_id: string;
  seq: number;
  event: ActionLogEvent;
  page: string;
  host: string;
  locale: string;
  props: Record<string, ActionLogValue>;
}

export const ACTION_LOG_LIMITS = {
  /** localStorage 에 비춰 두는 줄 수(탭 칸마다) — 넘으면 오래된 것부터 버린다. */
  outboxRows: 300,
  batchRows: 50,
  batchBytes: 60_000,
  flushDelayMs: 3000,
  flushAtRows: 25,
  /** outbox 쓰기는 몰아서 — 이벤트마다 쓰지 않는다. */
  outboxWriteDelayMs: 1500,
  /** props 한 줄의 JSON 크기 상한(DB 는 4096 바이트까지 받지만 넉넉히 아래로). */
  propsBytes: 2000,
} as const;

const PRODUCTION_HOSTS = ['nextspot-nu.vercel.app'];
const DEVICE_KEY = 'nextspot_device_id';
const SESSION_KEY = 'nextspot_action_session';
const SEQ_KEY = 'nextspot_action_seq';
/** 옛 형식(모든 탭이 한 키를 나눠 쓰던 때)의 키 — 이어받기만 하고 더는 쓰지 않는다. */
const OUTBOX_KEY = 'nextspot_action_outbox';
/** 탭(세션)마다 하나 — `nextspot_action_outbox:<세션 번호>`. */
const OUTBOX_PREFIX = `${OUTBOX_KEY}:`;
const ACTION_LOG_PATH = '/rest/v1/action_logs';
/** 개발자 기록 보기 화면 — 여기서는 화면 열람만 남긴다(보는 동작이 기록을 다시 불리지 않게). */
const ACTIVITY_VIEWER_PATH = '/dev/activity';
/** 이 앞으로 시작하는 화면은 버튼 글자를 읽지 않는다(개발자 콘솔은 사용자 목록·이메일을 그대로 보여 준다). */
const PRIVATE_PATH_PREFIX = '/dev';
/** 다른 탭이 살아 있는지(같은 세션 번호를 복제한 탭인지) 판단하는 신선도. */
const LIVE_CLAIM_MS = 90_000;
/** 주인이 이만큼 소식이 없으면 남은 칸을 다른 탭이 이어받아 보낸다. */
const ORPHAN_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DROPPED_ROWS = 20;
/** 멈춘 뒤(404 · 401 · 403 · 버림 상한) 다시 시도하기까지 — 멈출 때마다 두 배, 상한 30분. */
const PAUSE_RETRY_MS = 3 * 60_000;
const PAUSE_RETRY_MAX_MS = 30 * 60_000;
const HEARTBEAT_MS = 30_000;
const IDLE_HEARTBEAT_AFTER_MS = 10 * 60_000;
const IDLE_HEARTBEAT_EVERY_MS = 5 * 60_000;

// lib/supabase.ts 와 같은 env 이름·기본값(그 파일은 값을 내보내지 않는다).
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://your-supabase-project.supabase.co').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'your-supabase-anon-key';
// lib/api-client.ts 의 BASE_URL 과 같은 값.
const FASTAPI_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || 'http://localhost:8000';

const EVENT_SET: ReadonlySet<string> = new Set(ACTION_LOG_EVENTS);

// ─────────────────────────────────────────────────────────────────────────────
// 켤지 말지
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionLogGateInput {
  hostname: string;
  webdriver?: boolean;
  /** window.__NEXTSPOT_ACTION_LOG__ */
  flag?: unknown;
  /** NEXT_PUBLIC_ACTION_LOG_HOSTS(쉼표 구분) */
  extraHosts?: string;
}

/** 기록하는 주소 목록 — 운영 주소 + NEXT_PUBLIC_ACTION_LOG_HOSTS(쉼표 구분, 소문자로 맞춘다). */
export function actionLogHosts(extra?: string | null): string[] {
  const hosts = new Set(PRODUCTION_HOSTS);
  for (const part of String(extra ?? '').split(',')) {
    const host = part.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/**
 * 이 브라우저에서 기록하는가. 운영 주소 + 사람이 쓰는 브라우저(webdriver 아님)일 때만. 'force' 는 둘 다 무시한다.
 * 추적 거부(Do Not Track)와 지역은 보지 않는다 — 개인정보 안내에 적은 1차 서비스 운영 기록이다(파일 머리말).
 */
export function shouldRecordActionLog(input?: ActionLogGateInput): boolean {
  const env = input ?? browserGateInput();
  if (!env) return false;
  if (env.flag === 'force') return true;
  if (env.webdriver) return false;
  return actionLogHosts(env.extraHosts).includes(String(env.hostname ?? '').toLowerCase());
}

interface ActionLogWindow extends Window {
  __NEXTSPOT_ACTION_LOG__?: unknown;
  __NEXTSPOT_ACTION_LOG_RUNTIME__?: ActionLogRuntime;
  __NEXTSPOT_ACTION_LOG_FETCH__?: typeof fetch;
}

function browserWindow(): ActionLogWindow | null {
  return typeof window === 'undefined' ? null : (window as ActionLogWindow);
}

function browserGateInput(): ActionLogGateInput | null {
  const w = browserWindow();
  if (!w) return null;
  return {
    hostname: w.location?.hostname ?? '',
    webdriver: typeof navigator !== 'undefined' && navigator.webdriver === true,
    flag: w.__NEXTSPOT_ACTION_LOG__,
    extraHosts: process.env.NEXT_PUBLIC_ACTION_LOG_HOSTS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 가리기 · 줄이기
// ─────────────────────────────────────────────────────────────────────────────

/** 글자 수(코드 포인트) 상한 — 넘으면 끝을 '…' 로. DB 의 char_length 상한과 같은 단위다. */
export function clipText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(1, max - 1)).join('') + '…';
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** UTF-8 바이트 수(jsonb 크기 상한을 재는 데 쓴다). */
export function byteLength(text: string): number {
  return textEncoder ? textEncoder.encode(text).length : text.length * 3;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// 정규식에 뒤보기(lookbehind)를 쓰지 않는다 — 옛 iOS Safari(16.3 이하)는 그 문법만 봐도 번들 전체가 죽는다.
const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// 한글 도메인(홍길동@네이버.com)까지 — \p{L} 은 ES2018(iOS 11.3+)이라 뒤보기와 달리 문제없다.
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// 하이픈 꼴 문자(‐ ‑ ‒ – — ― − ﹘ ﹣ －)는 먼저 '-' 로 맞춘다 — 그래야 아래 번호 규칙이 잡는다.
const DASHES_RE = /[‐-―−﹘﹣－]/g;
const PHONE_RES: readonly RegExp[] = [
  // +82 10-1234-5678 · 82 (0)10 1234 5678
  /(?:\+|\b)82[-. ]?(?:\(0\)|0)?[-. ]?1[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g,
  // 010-1234-5678 · 01012345678 · 011 123 4567 · (010)1234-5678
  /\(?\b01[016789]\)?[-. ]?\d{3,4}[-. ]?\d{4}\b/g,
  // 지역 번호(02 · 031~064 · 070) — 02-123-4567 · (054) 772-1234
  /\b0(?:2|[3-6][1-5]|70)[-. )]{0,2}\d{3,4}[-. ]?\d{4}\b/g,
  // 대표 번호 1588-1234
  /\b1[5-9]\d{2}-\d{4}\b/g,
  // 그 밖의 국제 번호 +1 (415) 555-1234
  /\+\d[\d ().-]{7,}\d/g,
];
const CARD_RE = /\b\d{4}(?:[ -]\d{4}){3}\b/g;
// 하이픈을 사이에 둔 것까지 아홉 자리 이상 숫자(주민·사업자·계좌 번호 꼴). 날짜(2026-11-12 = 8자리)는 남는다.
const DIGIT_RUN_RE = /\d(?:-?\d){8,}/g;
// 위경도 꼴 — 쉼표로 이은 한 쌍(소수 둘째 자리부터, 35.837,129.209), 빈칸으로 이은 한 쌍(소수 셋째 자리부터, 35.838 129.209)과
// 소수 넷째 자리 이상 하나(35.8372). 빈칸 쌍을 셋째 자리부터 보는 것은 '4.5 3.25' 같은 평점·가격 나열까지 가리지 않기 위해서다.
// 글자·밑줄에 붙어 있어도(lat35.8372 · pos_35.8372_x) 잡도록 \b 대신 '앞이 숫자·점이 아님' 을 잡아 되돌려 쓴다.
const GEO_PAIR_RE = /(^|[^\d.])-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}(?!\d)/g;
const GEO_SPACE_PAIR_RE = /(^|[^\d.])-?\d{1,3}\.\d{3,}\s+-?\d{1,3}\.\d{3,}(?!\d)/g;
const GEO_NUMBER_RE = /(^|[^\d.])-?\d{1,3}\.\d{4,}(?!\d)/g;

function stripUrlInText(raw: string): string {
  const match = /^(.*?)([).,;:!?\]]*)$/.exec(raw);
  const url = match ? match[1] : raw;
  const tail = match ? match[2] : '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${safeDecode(parsed.pathname)}${tail}`;
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

/**
 * 자유 텍스트를 기록해도 되는 꼴로 — 이메일 → [email], 전화번호 → [phone], 아홉 자리 이상 숫자 → [num],
 * 좌표 꼴 숫자 → [geo], 글 속 URL 은 쿼리를 뗀다. 공백을 하나로 접고 max 글자로 자른다.
 */
export function maskText(input: unknown, max = 80): string {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : String(input);
  if (!text) return '';
  if (text.length > 4000) text = text.slice(0, 4000); // 정규식 비용 상한
  text = text.replace(URL_IN_TEXT_RE, stripUrlInText);
  text = text.replace(DASHES_RE, '-');
  text = text.replace(EMAIL_RE, '[email]');
  for (const re of PHONE_RES) text = text.replace(re, '[phone]');
  text = text.replace(CARD_RE, '[num]');
  text = text.replace(DIGIT_RUN_RE, '[num]');
  text = text.replace(GEO_PAIR_RE, '$1[geo]');
  text = text.replace(GEO_SPACE_PAIR_RE, '$1[geo]');
  text = text.replace(GEO_NUMBER_RE, '$1[geo]');
  text = text.replace(/\s+/g, ' ').trim();
  return clipText(text, max);
}

const SECRET_QUERY_KEYS = new Set([
  'code', 'token', 'access_token', 'refresh_token', 'id_token', 'provider_token', 'provider_refresh_token', 'token_hash',
  'type', 'email', 'password', 'pass', 'passwd', 'pw', 'key', 'apikey', 'api_key', 'otp', 'signature', 'sig', 'secret',
  'state', 'nonce', 'phone', 'tel', 'mobile', 'captcha', 'auth', 'authorization', 'jwt',
]);
const SECRET_QUERY_PARTS = /token|secret|passw|signature|apikey|api_key|email|phone|jwt|captcha/;
const GEO_QUERY_KEYS = new Set([
  'lat', 'lng', 'lon', 'long', 'latitude', 'longitude', 'x', 'y', 'coords', 'coord', 'center', 'mapx', 'mapy',
  'location', 'loc', 'position', 'pos', 'bbox', 'bounds', 'sw', 'ne', 'geo', 'point', 'origin', 'destination', 'sp', 'ep',
]);

function isSecretQueryKey(lower: string): boolean {
  return SECRET_QUERY_KEYS.has(lower) || SECRET_QUERY_PARTS.test(lower);
}

/**
 * 쿼리스트링을 기록해도 되는 꼴로 — 인증·비밀 키(code·token·email·password·key·otp·signature…)는 뺀다, 좌표 키
 * (lat·lng·x·y·center…)는 값을 [geo] 로, 나머지 값은 가리고 줄인다. 비면 ''. 결과는 사람이 읽는 '?k=v&k2=v2' 꼴.
 */
export function sanitizeQuery(search: string | null | undefined, max = 200): string {
  if (!search) return '';
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return '';
  }
  const parts: string[] = [];
  params.forEach((value, rawKey) => {
    if (parts.length >= 12) return;
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    if (!key || isSecretQueryKey(lower)) return;
    const safeKey = maskText(key, 40);
    if (!safeKey) return;
    if (GEO_QUERY_KEYS.has(lower)) {
      parts.push(`${safeKey}=[geo]`);
      return;
    }
    const safeValue = maskText(value, 60);
    parts.push(safeValue ? `${safeKey}=${safeValue}` : safeKey);
  });
  if (!parts.length) return '';
  return clipText(`?${parts.join('&')}`, max);
}

/** 경로를 기록해도 되는 꼴로 — 퍼센트 인코딩을 풀고 maskText(이메일·긴 숫자·좌표 꼴 조각을 가린다). */
export function sanitizePath(pathname: string | null | undefined, max = 160): string {
  if (!pathname) return '/';
  const masked = maskText(safeDecode(pathname), max);
  return masked || '/';
}

function safeOrigin(base: string | undefined): string | null {
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** 링크 주소 — 우리 화면이면 경로 + 정리한 쿼리, 바깥이면 origin + 경로(쿼리 없음). mailto·tel 은 종류만. */
export function hrefForLog(href: string | null | undefined, base?: string): string | null {
  const trimmed = String(href ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const scheme of ['mailto:', 'tel:', 'sms:', 'javascript:', 'data:', 'blob:']) {
    if (lower.startsWith(scheme)) return scheme;
  }
  if (lower.startsWith('#')) return '#';
  let url: URL;
  try {
    url = new URL(trimmed, base ?? 'http://localhost/');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol;
  const baseOrigin = safeOrigin(base);
  if (baseOrigin && url.origin === baseOrigin) {
    return clipText(sanitizePath(url.pathname, 140) + sanitizeQuery(url.search, 120), 200);
  }
  return clipText(url.origin + sanitizePath(url.pathname, 140), 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 눌렀나 · 어느 칸인가
// ─────────────────────────────────────────────────────────────────────────────

// area — Kakao 지도 마커는 이미지 맵의 <area> 로 눌린다.
const INTERACTIVE_TAGS = new Set(['a', 'area', 'button', 'input', 'select', 'textarea', 'label', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'checkbox', 'radio',
]);
const FORM_FIELD_TAGS = new Set(['input', 'select', 'textarea']);
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);
const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel', 'hidden', 'file']);
// autocomplete 가 이 낱말을 품으면 개인 정보 칸이다(이메일·전화·비밀번호·카드·이름·주소·생일).
const SENSITIVE_AUTOCOMPLETE = /email|tel|password|cc-|one-time-code|name|street|address|postal|bday|sex|photo/;

function attr(el: Element | null | undefined, name: string): string {
  if (!el || typeof el.getAttribute !== 'function') return '';
  try {
    return el.getAttribute(name) ?? '';
  } catch {
    return '';
  }
}

function hasAttr(el: Element | null | undefined, name: string): boolean {
  if (!el || typeof el.hasAttribute !== 'function') return false;
  try {
    return el.hasAttribute(name);
  } catch {
    return false;
  }
}

function tagOf(el: Element | null | undefined): string {
  return String(el?.tagName ?? '').toLowerCase();
}

function inputType(el: Element): string {
  const tag = tagOf(el);
  if (tag === 'input') return (attr(el, 'type') || 'text').toLowerCase();
  return tag;
}

function isInteractive(el: Element): boolean {
  if (typeof el.getAttribute !== 'function') return false;
  if (INTERACTIVE_TAGS.has(tagOf(el))) return true;
  const role = attr(el, 'role').toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return hasAttr(el, 'data-log');
}

/** 누른 자리에서 가장 가까운 버튼·링크·입력 칸(혹은 data-log 표시) — 없으면 null. */
export function findInteractive(target: Element | null | undefined, maxDepth = 12): Element | null {
  let node: Element | null | undefined = target;
  for (let depth = 0; node && depth < maxDepth; depth += 1) {
    if (isInteractive(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/** data-log-private 안인가(사람이 쓴 글이 보이는 자리 — 이름을 읽지 않는다). */
export function inPrivateZone(el: Element | null | undefined): boolean {
  let node: Element | null | undefined = el;
  for (let depth = 0; node && depth < 40; depth += 1) {
    if (hasAttr(node, 'data-log-private')) return true;
    node = node.parentElement;
  }
  return false;
}

function firstLine(text: string | null | undefined): string {
  if (!text) return '';
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** innerText 만 읽는다 — textContent 는 textarea 의 처음 값까지 품는다(화면에 그려진 글자만 이름으로 쓴다). */
function renderedText(el: Element): string {
  const text = (el as HTMLElement).innerText;
  return typeof text === 'string' ? text : '';
}

/** 버튼·링크의 이름 — data-log-name › aria-label › aria-labelledby › alt › title › 보이는 글자 첫 줄(입력 칸은 placeholder). */
function targetName(el: Element): string {
  const explicit = attr(el, 'data-log-name');
  if (explicit.trim()) return maskText(explicit, 80);
  const aria = attr(el, 'aria-label');
  if (aria.trim()) return maskText(aria, 80);
  const labelledBy = attr(el, 'aria-labelledby');
  if (labelledBy.trim()) {
    const doc = el.ownerDocument;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => (id && doc ? doc.getElementById(id)?.textContent ?? '' : ''))
      .join(' ');
    const line = firstLine(text);
    if (line) return maskText(line, 80);
  }
  const alt = attr(el, 'alt');
  if (alt.trim()) return maskText(alt, 80);
  const title = attr(el, 'title');
  if (title.trim()) return maskText(title, 80);
  const tag = tagOf(el);
  if (tag === 'input') {
    const type = inputType(el);
    // 제출·버튼형 input 의 value 속성은 버튼 글자다. 글 입력 칸의 value 는 (React 가 속성까지 맞추므로) 절대 읽지 않는다.
    if (type === 'submit' || type === 'button' || type === 'reset') {
      const label = attr(el, 'value');
      if (label.trim()) return maskText(label, 80);
    }
    return maskText(attr(el, 'placeholder'), 80);
  }
  if (tag === 'textarea' || tag === 'select') return maskText(attr(el, 'placeholder'), 80);
  return maskText(firstLine(renderedText(el)), 80);
}

/** 가까운 조상의 data-testid · data-log · id — 버튼이 아닌 곳을 눌렀을 때의 자리 표시(글자는 읽지 않는다). */
export function contextLabel(el: Element | null | undefined, maxDepth = 8): string {
  let node: Element | null | undefined = el;
  for (let depth = 0; node && depth < maxDepth; depth += 1) {
    const testid = attr(node, 'data-testid');
    if (testid) return maskText(`testid:${testid}`, 60);
    const log = attr(node, 'data-log');
    if (log) return maskText(`log:${log}`, 60);
    const id = attr(node, 'id');
    if (id) return maskText(`#${id}`, 60);
    node = node.parentElement;
  }
  return '';
}

export interface DescribeOptions {
  /** 링크를 우리 화면/바깥으로 가르는 기준 주소(location.href). */
  base?: string;
  /** 화면 전체가 비공개 영역인가(/dev). */
  privateZone?: boolean;
}

/** 버튼·링크·칸 하나를 기록용으로 — tag · role · name · id · testid · log · href · type. */
export function describeTarget(el: Element, opts: DescribeOptions = {}): Record<string, ActionLogValue> {
  const tag = tagOf(el) || 'unknown';
  const out: Record<string, ActionLogValue> = { tag };
  const role = attr(el, 'role');
  if (role) out.role = clipText(role.toLowerCase(), 24);
  const isPrivate = !!opts.privateZone || inPrivateZone(el);
  const name = isPrivate ? maskText(attr(el, 'data-log-name'), 80) : targetName(el);
  if (name) out.name = name;
  if (isPrivate) out.private = true;
  const id = attr(el, 'id');
  if (id) out.id = maskText(id, 60);
  const testid = attr(el, 'data-testid');
  if (testid) out.testid = maskText(testid, 60);
  const log = attr(el, 'data-log');
  if (log) out.log = maskText(log, 60);
  if (tag === 'a' || tag === 'area') {
    const href = hrefForLog(attr(el, 'href'), opts.base);
    if (href) out.href = href;
  }
  if (tag === 'input' || tag === 'button') {
    const type = attr(el, 'type');
    if (type) out.type = clipText(type.toLowerCase(), 20);
  }
  return out;
}

/** 버튼이 아닌 곳을 눌렀을 때 — 글자는 읽지 않고 태그와 가까운 자리 표시만. */
export function describePlainTarget(el: Element | null | undefined): Record<string, ActionLogValue> {
  const out: Record<string, ActionLogValue> = { tag: tagOf(el) || 'unknown', plain: true };
  const ctx = contextLabel(el);
  if (ctx) out.ctx = ctx;
  return out;
}

/** 입력 칸 이름 — name › id › aria-label › placeholder(40자). 값은 읽지 않는다. */
export function fieldIdentity(el: Element): string {
  for (const key of ['name', 'id', 'aria-label', 'placeholder']) {
    const value = attr(el, key);
    if (value.trim()) return maskText(value, 40);
  }
  return '';
}

/** 값을 절대 읽지 않는 칸 — 비밀번호·이메일·전화·숨김·파일, 개인 정보 autocomplete. */
export function isSensitiveField(el: Element): boolean {
  if (SENSITIVE_INPUT_TYPES.has(inputType(el))) return true;
  return SENSITIVE_AUTOCOMPLETE.test(attr(el, 'autocomplete').toLowerCase());
}

/**
 * 이 칸의 값을 기록해도 되는가 — 검색칸(input[type=search] · [role=searchbox] · data-log-value="search")만.
 * 비밀번호·이메일·전화 칸이나 개인 정보 autocomplete 는 표시가 붙어 있어도 거절한다. 비공개 영역 안도 거절.
 */
export function isValueCapturable(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = tagOf(el);
  if (tag !== 'input' && tag !== 'textarea') return false;
  if (isSensitiveField(el)) return false;
  if (inPrivateZone(el)) return false;
  if (tag === 'input' && inputType(el) === 'search') return true;
  if (attr(el, 'role').toLowerCase() === 'searchbox') return true;
  return attr(el, 'data-log-value') === 'search';
}

/** 글을 치는 칸인가(Enter 를 '키' 로 남기지 않는 자리). */
export function isTextEntry(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = tagOf(el);
  if (tag === 'textarea') return true;
  if (tag === 'input') return TEXT_INPUT_TYPES.has(attr(el, 'type').toLowerCase());
  if ((el as HTMLElement).isContentEditable) return true;
  const role = attr(el, 'role').toLowerCase();
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

interface FieldLike {
  value?: unknown;
  checked?: unknown;
  files?: { length: number } | null;
  selectedOptions?: ArrayLike<{ label?: string; text?: string }>;
}

/** change 한 번을 기록용으로 — 칸 이름 · 종류 · 길이 · 체크 · 고른 항목, 값은 검색칸일 때만(가려서). */
export function describeFieldChange(el: Element, opts: DescribeOptions = {}): Record<string, ActionLogValue> {
  const tag = tagOf(el);
  const type = inputType(el);
  const field = el as unknown as FieldLike;
  const out: Record<string, ActionLogValue> = { field: fieldIdentity(el) || tag, type };
  const isPrivate = !!opts.privateZone || inPrivateZone(el);
  if (type === 'checkbox' || type === 'radio') {
    out.checked = field.checked === true;
  } else if (tag === 'select') {
    const options = field.selectedOptions;
    if (options && options.length > 1) out.selected = options.length;
    else if (options && options.length === 1 && !isPrivate) out.option = maskText(options[0].label || options[0].text || '', 40);
  } else if (type === 'file') {
    out.files = field.files?.length ?? 0;
  } else if (!isSensitiveField(el)) {
    const value = typeof field.value === 'string' ? field.value : '';
    out.length = value.length;
    if (!opts.privateZone && isValueCapturable(el)) out.value = maskText(value, 100);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 줄 · 묶음 · 저장분(outbox)
// ─────────────────────────────────────────────────────────────────────────────

function cleanScalar(value: unknown, max: number): ActionLogScalar | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return maskText(value, max);
  return undefined;
}

/**
 * props 를 넣을 수 있는 꼴로 — 문자열은 전부 maskText(300자), 배열은 10개·64자, 키 24개까지,
 * JSON 이 propsBytes 를 넘으면 긴 문자열부터 줄이고 그래도 넘으면 뒤 키부터 뺀다.
 */
export function cleanProps(props: ActionLogProps | null | undefined, maxBytes: number = ACTION_LOG_LIMITS.propsBytes): Record<string, ActionLogValue> {
  const out: Record<string, ActionLogValue> = {};
  if (!props || typeof props !== 'object') return out;
  let count = 0;
  for (const [rawKey, raw] of Object.entries(props)) {
    if (count >= 24) break;
    if (raw === undefined) continue;
    const key = clipText(rawKey, 40);
    let value: ActionLogValue | undefined;
    if (Array.isArray(raw)) {
      value = raw.slice(0, 10).map((item) => cleanScalar(item, 64) ?? null);
    } else {
      value = cleanScalar(raw, 300);
    }
    if (value === undefined) continue;
    out[key] = value;
    count += 1;
  }
  const size = () => byteLength(JSON.stringify(out));
  for (let guard = 0; size() > maxBytes && guard < 64; guard += 1) {
    let longestKey = '';
    let longestLength = 0;
    for (const [key, value] of Object.entries(out)) {
      if (typeof value === 'string' && value.length > longestLength) {
        longestKey = key;
        longestLength = value.length;
      }
    }
    if (longestLength <= 16) break;
    out[longestKey] = clipText(out[longestKey] as string, Math.floor(longestLength / 2));
  }
  const keys = Object.keys(out);
  while (keys.length && size() > maxBytes) delete out[keys.pop() as string];
  if (size() > maxBytes) return { truncated: true };
  return out;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** device_id · session_id 꼴(8~64자, 영숫자·-·_). */
export function isValidLogId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** 브라우저가 만든 임의 번호 — randomUUID(보안 문맥) › getRandomValues › Math.random. 계정·기기 정보에서 만들지 않는다. */
export function newLogId(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 32);
}

/** 저장분에서 읽은 줄이 넣을 수 있는 꼴인가(옛 형식·손상된 저장분이 400 으로 묶음을 막지 않게). */
export function isActionLogRow(value: unknown): value is ActionLogRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.occurred_at === 'string'
    && isValidLogId(row.device_id)
    && isValidLogId(row.session_id)
    && typeof row.seq === 'number' && Number.isInteger(row.seq) && row.seq >= 0
    && typeof row.event === 'string' && EVENT_SET.has(row.event)
    && typeof row.page === 'string' && row.page.length <= 200
    && typeof row.host === 'string' && row.host.length <= 100
    && typeof row.locale === 'string' && row.locale.length <= 16
    && !!row.props && typeof row.props === 'object' && !Array.isArray(row.props)
    && Object.keys(row).length === 9;
}

/** 한 번에 보낼 묶음 — 앞에서부터 maxRows 줄 · maxBytes 바이트까지(첫 줄은 무조건). */
export function takeBatch(rows: readonly ActionLogRow[], maxRows: number = ACTION_LOG_LIMITS.batchRows, maxBytes: number = ACTION_LOG_LIMITS.batchBytes): ActionLogRow[] {
  const batch: ActionLogRow[] = [];
  let bytes = 2;
  for (const row of rows) {
    if (batch.length >= maxRows) break;
    const size = byteLength(JSON.stringify(row)) + 1;
    if (batch.length > 0 && bytes + size > maxBytes) break;
    if (batch.length === 0 && size + 2 > maxBytes) break;
    batch.push(row);
    bytes += size;
  }
  return batch;
}

/** 저장분 상한 — 넘으면 오래된(앞) 줄부터 버린다. */
export function capOutbox<T>(rows: readonly T[], cap: number = ACTION_LOG_LIMITS.outboxRows): T[] {
  return rows.length > cap ? rows.slice(rows.length - cap) : rows.slice();
}

export type ActionLogOutcome = 'ok' | 'schema' | 'auth' | 'forbidden' | 'duplicate' | 'reject' | 'retry';

/**
 * PostgREST 응답 분류 — 이미 들어간 줄(23505 · 코드 없는 409)은 'duplicate'((session_id, seq) 유일 인덱스 — 받은 셈 친다),
 * 표·칸이 아직 없음(404 · PGRST205 · 42P01 · PGRST204 · 42703)은 'schema', 401 은 'auth', 403 은 'forbidden'(셋 다 잠시 멈춤),
 * 줄이 잘못됨(400 · 그 밖의 409 · 413 · 422)은 'reject'(반씩 나눠 그 줄만 버린다), 나머지는 다시 시도.
 */
export function classifyActionLogResponse(status: number, code = ''): ActionLogOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (code === '23505' || (status === 409 && !code)) return 'duplicate';
  if (status === 404 || code === 'PGRST205' || code === '42P01' || code === 'PGRST204' || code === '42703') return 'schema';
  if (status === 401) return 'auth';
  if (status === 403 || code === '42501') return 'forbidden';
  if (status === 400 || status === 409 || status === 413 || status === 422) return 'reject';
  return 'retry';
}

/** 이 탭(세션)의 저장분 키. */
export function actionLogOutboxKey(entryKey: string): string {
  return `${OUTBOX_PREFIX}${entryKey}`;
}

interface OutboxEntry {
  /** 주인 탭이 마지막으로 쓴 시각 */
  t: number;
  /** 주인 탭이 살아 있는가(pagehide 에 0) */
  live: 0 | 1;
  rows: ActionLogRow[];
  /** 줄마다 만들 때의 계정 번호(같은 사람일 때만 그 계정 토큰으로 보낸다) */
  subs?: (string | null)[];
  /** 줄마다 '보냈지만 응답을 확인 못 함'(1) — 다시 보내면 409 로 돌아올 수 있는 줄. 그런 줄끼리 따로 묶는다. */
  u?: (0 | 1)[];
}

export interface ActionLogAuth {
  sub: string | null;
  token: string | null;
}

export interface ActionLogResponseLike {
  status: number;
  text(): Promise<string>;
}

/** localStorage 와 같은 꼴 — 다른 탭의 키를 찾느라 length · key 도 쓴다. */
export interface ActionLogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface ActionLogCoreDeps {
  endpoint: string;
  anonKey: string;
  fetch: (url: string, init: RequestInit) => Promise<ActionLogResponseLike>;
  /** outbox 를 비춰 둘 localStorage(막혀 있으면 null — 메모리에서만). */
  storage: ActionLogStorage | null;
  /** 이 탭의 칸 이름(세션 번호). */
  entryKey: () => string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 지금 세션(getSession, 시간 제한). */
  currentAuth?: () => Promise<ActionLogAuth>;
  /** 마지막 auth 이벤트로 알고 있는 세션(기다릴 수 없을 때 — pagehide). */
  cachedAuth?: () => ActionLogAuth;
  /** 이 페이지에서 본 그 계정의 토큰(로그인 전 게스트 줄을 게스트 토큰으로 보내기 위해). */
  tokenForSub?: (sub: string) => string | null;
  refreshAuth?: () => Promise<ActionLogAuth | null>;
  /**
   * 토큰이 아직 쓸 만한가(만료 1분 전까지). pagehide 에서는 401 을 받아 다시 보낼 수 없으므로, 낡은 토큰이면
   * 보내지 않고 저장분에 남겨 다음 방문이 보내게 한다. 없으면 늘 쓸 만하다고 본다.
   */
  isTokenFresh?: (token: string) => boolean;
}

export interface ActionLogCore {
  push(row: ActionLogRow, sub?: string | null): void;
  flush(opts?: { keepalive?: boolean }): Promise<void>;
  /** 문서가 내려갈 때(pagehide) — keepalive 로 한 묶음을 바로 보내되, 응답을 못 받으니 저장분에 '확인 못 함' 으로 남긴다. */
  unload(): void;
  persistNow(): void;
  /** 살아 있다고 표시(하트비트마다). */
  touch(): void;
  /** 주인이 떠난다(pagehide) — 다른 탭·다음 방문이 남은 줄을 이어받을 수 있다. */
  release(): void;
  /** 돌아왔다(bfcache · 다시 보임) — 그사이 다른 탭이 칸을 가져갔으면 그때 저장한 줄은 그 탭 몫이다. */
  reclaim(): void;
  /** 이 탭 칸(새로고침 전 같은 탭)과 주인이 떠난 칸(옛 한 키 형식 포함)의 줄을 이어받는다. */
  adopt(): void;
  /** 이 칸의 주인이 지금 다른 탭에 살아 있는가(탭 복제로 세션 번호까지 복사된 경우). */
  liveElsewhere(key: string): boolean;
  /** 계정을 모를 때(null) 만든 줄에 계정을 정해 준다 — 로그인 상태가 처음 정해졌을 때('' 은 로그인 안 함). */
  assignSub(rows: readonly ActionLogRow[], sub: string): void;
  readonly queue: readonly ActionLogRow[];
  readonly paused: boolean;
}

type SendOutcome = 'ok' | 'retry' | 'pause';

/** 줄을 모아 보내는 부분 — 브라우저 의존성은 전부 deps 로 받는다(lib/actionLog.test.ts 가 가짜로 돌린다). */
export function createActionLogCore(deps: ActionLogCoreDeps): ActionLogCore {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const noAuth: ActionLogAuth = { sub: null, token: null };
  const cachedAuth = deps.cachedAuth ?? (() => noAuth);
  const currentAuth = deps.currentAuth ?? (async () => cachedAuth());
  const tokenForSub = deps.tokenForSub ?? (() => null);
  const refreshAuth = deps.refreshAuth ?? (async () => null);
  const L = ACTION_LOG_LIMITS;

  let queue: ActionLogRow[] = [];
  const subs = new WeakMap<ActionLogRow, string | null>();
  const inflight = new Set<ActionLogRow>();
  const inflightKeepalive = new Set<ActionLogRow>();
  /** 보냈는데 응답을 확인 못 한 줄(끊긴 요청 · keepalive · 이어받은 저장분의 u=1) — 다시 보내면 409 일 수 있다. */
  const unconfirmed = new WeakSet<ActionLogRow>();
  let persisted = new WeakSet<ActionLogRow>();
  let flushTimer: unknown = null;
  let persistTimer: unknown = null;
  let pauseTimer: unknown = null;
  let sending = false;
  let again = false;
  let paused = false;
  let pauses = 0;
  let failures = 0;
  let refreshed = false;
  let dropped = 0;
  let live = true;
  let keepaliveBytes = 0;

  const subOf = (row: ActionLogRow): string | null => subs.get(row) ?? null;
  /** 저장분에 '확인 못 함' 으로 적을 줄 — 이미 확인 못 한 줄과, 지금 응답을 기다리는 줄(이대로 문서가 사라지면 모른다). */
  const maybeStored = (row: ActionLogRow): boolean => unconfirmed.has(row) || inflight.has(row);

  // ── 저장분(localStorage) — 탭(세션)마다 자기 키 하나만 쓴다. 다른 탭의 키는 이어받을 때만 읽고 지운다. ──

  function parseEntry(value: unknown): OutboxEntry | null {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Partial<OutboxEntry>;
    if (!Array.isArray(entry.rows)) return null;
    return {
      t: typeof entry.t === 'number' ? entry.t : 0,
      live: entry.live === 1 ? 1 : 0,
      rows: entry.rows,
      subs: Array.isArray(entry.subs) ? entry.subs : undefined,
      u: Array.isArray(entry.u) ? entry.u : undefined,
    };
  }

  function readEntry(entryKey: string): OutboxEntry | null {
    if (!deps.storage) return null;
    try {
      const raw = deps.storage.getItem(actionLogOutboxKey(entryKey));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { v?: unknown } | null;
      return parsed && parsed.v === 1 ? parseEntry(parsed) : null;
    } catch {
      return null;
    }
  }

  function writeEntry(entryKey: string, entry: OutboxEntry): boolean {
    if (!deps.storage) return false;
    try {
      deps.storage.setItem(actionLogOutboxKey(entryKey), JSON.stringify({ v: 1, ...entry }));
      return true;
    } catch {
      return false; // 저장 공간 부족 등 — 메모리의 줄은 그대로 보낸다
    }
  }

  function removeItem(storageKey: string): void {
    try {
      deps.storage?.removeItem(storageKey);
    } catch {
      /* 지우지 못해도 다음 이어받기가 다시 본다 */
    }
  }

  /** 저장소에 있는 탭 칸 이름(세션 번호) 전부. */
  function entryKeys(): string[] {
    const out: string[] = [];
    if (!deps.storage) return out;
    try {
      for (let i = 0; i < deps.storage.length; i += 1) {
        const key = deps.storage.key(i);
        if (key && key.startsWith(OUTBOX_PREFIX)) out.push(key.slice(OUTBOX_PREFIX.length));
      }
    } catch {
      /* 목록을 못 읽으면 이 탭 칸만 */
    }
    return out;
  }

  function persistNow(): void {
    if (persistTimer !== null) {
      clearTimer(persistTimer);
      persistTimer = null;
    }
    if (!deps.storage) return;
    const key = deps.entryKey();
    const rows = capOutbox(queue, L.outboxRows);
    let ok = true;
    if (rows.length) {
      const entry: OutboxEntry = { t: now(), live: live ? 1 : 0, rows, subs: rows.map(subOf) };
      if (rows.some(maybeStored)) entry.u = rows.map((row) => (maybeStored(row) ? 1 : 0));
      ok = writeEntry(key, entry);
    } else if (live) {
      ok = writeEntry(key, { t: now(), live: 1, rows: [] }); // 빈 칸도 '살아 있음' 표시로 남긴다(탭 복제 판별)
    } else {
      removeItem(actionLogOutboxKey(key));
    }
    if (ok) persisted = new WeakSet(rows);
  }

  function schedulePersist(): void {
    if (persistTimer !== null || !deps.storage) return;
    persistTimer = setTimer(() => {
      persistTimer = null;
      persistNow();
    }, L.outboxWriteDelayMs);
  }

  function scheduleFlush(ms: number, override = false): void {
    if (paused) return;
    if (flushTimer !== null) {
      if (!override) return;
      clearTimer(flushTimer);
    }
    flushTimer = setTimer(() => {
      flushTimer = null;
      void flush();
    }, ms);
  }

  function remove(rows: readonly ActionLogRow[]): void {
    const gone = new Set(rows);
    queue = queue.filter((row) => !gone.has(row));
    schedulePersist();
  }

  /**
   * 잠시 멈춘다 — 표가 아직 없거나(배포 전) 넣을 권한이 없거나 버린 줄이 너무 많다. 저장분은 지키고, 3분 뒤(멈출 때마다 두 배,
   * 상한 30분) 다시 시도한다. 한 번의 일시 장애(404 · 401 · 403)로 방문의 나머지가 통째로 빠지지 않게.
   */
  function pause(): void {
    paused = true;
    if (flushTimer !== null) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
    persistNow();
    if (pauseTimer === null) {
      pauses += 1;
      const delay = Math.min(PAUSE_RETRY_MAX_MS, PAUSE_RETRY_MS * 2 ** Math.min(pauses - 1, 4));
      pauseTimer = setTimer(() => {
        pauseTimer = null;
        resume();
      }, delay);
    }
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    refreshed = false; // 세션을 새로 받아 볼 기회도 한 번 더
    dropped = 0;
    failures = 0;
    if (pending().length) void flush();
  }

  function pending(): ActionLogRow[] {
    return queue.filter((row) => !inflight.has(row));
  }

  /**
   * 앞에서부터 같은 계정으로 만든 줄끼리만 한 묶음(계정마다 다른 토큰으로 보낸다). '확인 못 함' 줄과 새 줄도 섞지 않는다 —
   * 확인 못 한 줄은 409 로 돌아오기 쉬워 반씩 나눠 보내게 되는데, 새 줄까지 그 나눔에 끌려 들어가지 않게.
   */
  function nextBatch(maxBytes: number = L.batchBytes): ActionLogRow[] {
    const candidates = pending();
    if (!candidates.length) return [];
    const sub = subOf(candidates[0]);
    const resend = unconfirmed.has(candidates[0]);
    const same: ActionLogRow[] = [];
    for (const row of candidates) {
      if (subOf(row) !== sub || unconfirmed.has(row) !== resend) break;
      same.push(row);
    }
    return takeBatch(same, L.batchRows, maxBytes);
  }

  async function post(rows: readonly ActionLogRow[], token: string | null, keepalive: boolean): Promise<{ status: number; code: string }> {
    const body = JSON.stringify(rows);
    const size = keepalive ? byteLength(body) : 0;
    keepaliveBytes += size;
    let timer: unknown = null;
    try {
      const controller = !keepalive && typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (controller) timer = setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await deps.fetch(deps.endpoint, {
        method: 'POST',
        headers: {
          apikey: deps.anonKey,
          Authorization: `Bearer ${token || deps.anonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body,
        keepalive,
        credentials: 'omit',
        signal: controller?.signal,
      });
      let code = '';
      if (res.status >= 400) {
        try {
          const parsed = JSON.parse(await res.text()) as { code?: unknown } | null;
          if (parsed && typeof parsed.code === 'string') code = parsed.code;
        } catch {
          /* 본문 없는 오류 */
        }
      }
      return { status: res.status, code };
    } catch {
      return { status: 0, code: '' };
    } finally {
      if (timer !== null) clearTimer(timer);
      keepaliveBytes -= size;
    }
  }

  /**
   * 이 묶음을 어느 토큰으로 — 만든 계정이 지금 계정이면 지금 토큰, 다른 계정이면 이 페이지에서 본 그 계정 토큰.
   * 로그인하지 않은 때 만든 줄('')과 계정을 모르는 줄(null — 로그인 상태가 정해지기 전, 다른 방문에서 이어받은 줄)은
   * anon 키로 보낸다. 나중 계정의 토큰으로 보내면 그 계정이 한 일처럼 찍힌다(심사 증거가 틀어진다).
   */
  function chooseToken(sub: string | null, current: ActionLogAuth): { token: string | null; current: boolean } {
    if (!sub) return { token: null, current: false };
    if (sub === current.sub) return { token: current.token, current: true };
    return { token: tokenForSub(sub), current: false };
  }

  async function sendRows(rows: ActionLogRow[], mode: { keepalive: boolean; sync: boolean }): Promise<SendOutcome> {
    const sub = subOf(rows[0]);
    let current: ActionLogAuth;
    if (mode.sync) {
      current = cachedAuth();
    } else {
      try {
        current = await currentAuth();
      } catch {
        current = cachedAuth();
      }
    }
    const choice = chooseToken(sub, current);
    let res = await post(rows, choice.token, mode.keepalive);
    let kind = classifyActionLogResponse(res.status, res.code);
    if (kind === 'auth' && choice.token) {
      // 401: 세션을 한 번만 새로 받아 다시, 그래도 안 되면 이 묶음은 anon 키로(계정 없이) 넣는다.
      if (choice.current && !refreshed && !mode.sync) {
        refreshed = true;
        let fresh: ActionLogAuth | null = null;
        try {
          fresh = await refreshAuth();
        } catch {
          fresh = null;
        }
        if (fresh?.token && fresh.sub === sub) {
          res = await post(rows, fresh.token, mode.keepalive);
          kind = classifyActionLogResponse(res.status, res.code);
        }
      }
      if (kind === 'auth') {
        res = await post(rows, null, mode.keepalive);
        kind = classifyActionLogResponse(res.status, res.code);
      }
    } else if (kind === 'forbidden' && choice.token) {
      res = await post(rows, null, mode.keepalive);
      kind = classifyActionLogResponse(res.status, res.code);
    }
    switch (kind) {
      case 'ok':
        remove(rows);
        return 'ok';
      case 'duplicate':
        // 묶음 가운데 하나라도 이미 들어가 있으면 묶음 전체가 409 다. 한 줄까지 좁혀 409 면 그 줄은 이미 저장됐다 — 받은 셈 친다.
        for (const row of rows) unconfirmed.add(row);
        if (rows.length === 1) {
          remove(rows);
          return 'ok';
        }
        return mode.keepalive ? 'retry' : bisect(rows, mode);
      case 'schema':
      case 'auth':
      case 'forbidden':
        // 표가 아직 없거나(배포 전) 넣을 권한이 없다 — 잠시 멈추고 저장분은 지킨다(pause 가 나중에 다시 시도한다).
        pause();
        return 'pause';
      case 'reject':
        return mode.keepalive ? 'retry' : bisect(rows, mode);
      default:
        // 끊김(0)·서버 오류(5xx)는 서버가 이미 넣었을 수도 있다 — 다시 보낼 때 409 로 돌아올 수 있는 줄로 표시한다.
        if (res.status === 0 || res.status >= 500) for (const row of rows) unconfirmed.add(row);
        return 'retry';
    }
  }

  /** 줄 하나가 묶음 전체를 막지 않게 반씩 나눠 보내고, 혼자서도 거절되는 줄만 버린다(페이지당 상한 — 넘으면 잠시 멈춤). */
  async function bisect(rows: ActionLogRow[], mode: { keepalive: boolean; sync: boolean }): Promise<SendOutcome> {
    if (rows.length === 1) {
      dropped += 1;
      remove(rows);
      if (dropped > MAX_DROPPED_ROWS) {
        pause();
        return 'pause';
      }
      return 'ok';
    }
    const mid = Math.ceil(rows.length / 2);
    const first = await sendRows(rows.slice(0, mid), mode);
    if (first !== 'ok') return first;
    return sendRows(rows.slice(mid), mode);
  }

  async function flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (paused) return;
    const keepalive = !!opts.keepalive;
    if (!keepalive) {
      if (sending) {
        again = true;
        return;
      }
      if (flushTimer !== null) {
        clearTimer(flushTimer);
        flushTimer = null;
      }
    }
    const batch = nextBatch(keepalive ? Math.max(0, L.batchBytes - keepaliveBytes) : L.batchBytes);
    if (!batch.length) return;
    for (const row of batch) {
      inflight.add(row);
      if (keepalive) inflightKeepalive.add(row);
    }
    if (!keepalive) sending = true;
    let outcome: SendOutcome = 'retry';
    try {
      outcome = await sendRows(batch, { keepalive, sync: false });
    } catch {
      outcome = 'retry';
    } finally {
      for (const row of batch) {
        inflight.delete(row);
        inflightKeepalive.delete(row);
      }
      if (!keepalive) sending = false;
    }
    if (outcome === 'pause') return;
    if (outcome === 'ok') {
      failures = 0;
      pauses = 0;
      const left = pending().length;
      if (again || left > 0) {
        again = false;
        scheduleFlush(left >= L.flushAtRows ? 50 : L.flushDelayMs);
      }
      return;
    }
    failures += 1;
    again = false;
    const backoff = Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5));
    scheduleFlush(Math.round(backoff * (0.75 + Math.random() * 0.5)), true);
  }

  function push(row: ActionLogRow, sub: string | null = null): void {
    queue.push(row);
    subs.set(row, sub);
    if (queue.length > L.outboxRows) queue = capOutbox(queue, L.outboxRows);
    schedulePersist();
    if (paused) return;
    if (pending().length >= L.flushAtRows && failures === 0) void flush();
    else if (!sending) scheduleFlush(L.flushDelayMs);
  }

  function unload(): void {
    // keepalive 요청은 문서가 사라져도 대개 끝까지 가지만 보장은 없다 — 브라우저가 무시·취소할 수 있고, 401 뒤 다시 보내기는
    // await 너머라 문서와 함께 끊긴다. 그래서 보낸 줄도 저장분에 남기고 '확인 못 함'(u) 으로 적는다. 다음 방문(같은 탭 새로고침 ·
    // 다른 탭의 이어받기)이 다시 보내고, 이미 들어간 줄은 409(23505)로 확인돼 지워진다.
    live = false;
    if (flushTimer !== null) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
    if (!paused) {
      const budget = L.batchBytes - keepaliveBytes;
      const batch = budget > 2000 ? nextBatch(budget) : [];
      // 낡은 토큰(숨긴 탭에서는 supabase-js 가 갱신을 멈춘다)이면 401 뒤 다시 보낼 기회가 없다 — 보내지 않고 남긴다.
      const token = batch.length ? chooseToken(subOf(batch[0]), cachedAuth()).token : null;
      const stale = !!token && !!deps.isTokenFresh && !deps.isTokenFresh(token);
      if (batch.length && !stale) {
        for (const row of batch) {
          inflight.add(row);
          inflightKeepalive.add(row);
          unconfirmed.add(row);
        }
        // bfcache 로 돌아오면 응답이 마저 온다 — 그때 'ok' 면 지워지고, 아니면 다시 보낼 수 있게 inflight 에서 뺀다.
        void sendRows(batch, { keepalive: true, sync: true })
          .catch(() => 'retry' as const)
          .finally(() => {
            for (const row of batch) {
              inflight.delete(row);
              inflightKeepalive.delete(row);
            }
          });
      }
    }
    for (const row of inflightKeepalive) unconfirmed.add(row);
    persistNow();
  }

  function touch(): void {
    persistNow();
  }

  function release(): void {
    live = false;
    persistNow();
  }

  function reclaim(): void {
    if (deps.storage && !readEntry(deps.entryKey())) {
      // 그사이 다른 탭이 이 칸을 이어받았다 — 그때 저장해 둔 줄은 그 탭이 보낸다.
      const handedOver = persisted;
      queue = queue.filter((row) => !handedOver.has(row));
    }
    live = true;
    persistNow();
    if (pending().length) scheduleFlush(L.flushDelayMs);
  }

  function adopt(): void {
    if (!deps.storage) return;
    const key = deps.entryKey();
    const t = now();
    const adopted: { row: ActionLogRow; sub: string | null; resend: boolean }[] = [];
    const orphaned = (entry: OutboxEntry) => entry.live === 0 || t - entry.t > ORPHAN_MS;
    const take = (entry: OutboxEntry) => {
      entry.rows.forEach((row, i) => {
        const sub = entry.subs?.[i];
        if (isActionLogRow(row)) adopted.push({ row, sub: typeof sub === 'string' ? sub : null, resend: entry.u?.[i] === 1 });
      });
    };
    for (const entryKey of entryKeys()) {
      const storageKey = actionLogOutboxKey(entryKey);
      const entry = readEntry(entryKey);
      if (!entry) {
        removeItem(storageKey); // 손상된 칸
        continue;
      }
      if (entryKey !== key && !orphaned(entry)) continue;
      take(entry);
      removeItem(storageKey);
    }
    // 옛 형식(모든 탭이 nextspot_action_outbox 하나를 나눠 쓰던 때) — 주인이 떠난 칸만 이어받고, 비면 키를 지운다.
    // 옛 코드로 아직 열려 있는 탭의 칸은 남겨 둔다(그 탭이 떠나면 다음 이어받기가 가져간다).
    try {
      const raw = deps.storage.getItem(OUTBOX_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { v?: unknown; s?: unknown } | null;
        const left: Record<string, OutboxEntry> = {};
        if (parsed && parsed.v === 1 && parsed.s && typeof parsed.s === 'object') {
          for (const [entryKey, value] of Object.entries(parsed.s as Record<string, unknown>)) {
            const entry = parseEntry(value);
            if (!entry) continue;
            if (entryKey !== key && !orphaned(entry)) left[entryKey] = entry;
            else take(entry);
          }
        }
        if (Object.keys(left).length) deps.storage.setItem(OUTBOX_KEY, JSON.stringify({ v: 1, s: left }));
        else deps.storage.removeItem(OUTBOX_KEY);
      }
    } catch {
      removeItem(OUTBOX_KEY); // 읽을 수 없는 옛 저장분
    }
    if (adopted.length) {
      adopted.sort((a, b) => (a.row.occurred_at < b.row.occurred_at ? -1 : a.row.occurred_at > b.row.occurred_at ? 1 : a.row.seq - b.row.seq));
      for (const { row, sub, resend } of adopted) {
        subs.set(row, sub);
        if (resend) unconfirmed.add(row);
      }
      queue = capOutbox([...adopted.map((a) => a.row), ...queue], L.outboxRows);
    }
    live = true;
    persistNow();
    if (pending().length) scheduleFlush(L.flushDelayMs);
  }

  function assignSub(rows: readonly ActionLogRow[], sub: string): void {
    for (const row of rows) if (subs.has(row) && subs.get(row) === null) subs.set(row, sub);
  }

  function liveElsewhere(key: string): boolean {
    const entry = readEntry(key);
    return !!entry && entry.live === 1 && now() - entry.t < LIVE_CLAIM_MS;
  }

  return {
    push,
    flush,
    unload,
    persistNow,
    touch,
    release,
    reclaim,
    adopt,
    liveElsewhere,
    assignSub,
    get queue() {
      return queue;
    },
    get paused() {
      return paused;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetch 감싸기 — API 호출의 방법 · 경로 · 상태 · 걸린 시간만(쿼리·본문은 절대 읽지 않는다)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiTarget {
  svc: 'api' | 'supabase';
  origin: string;
  pathPrefix: string;
}

/** 기록할 호출 대상 — Supabase 와 FastAPI(NEXT_PUBLIC_FASTAPI_URL). */
export function apiTargets(fastapiUrl: string = FASTAPI_URL, supabaseUrl: string = SUPABASE_URL): ApiTarget[] {
  const out: ApiTarget[] = [];
  for (const [svc, raw] of [['supabase', supabaseUrl], ['api', fastapiUrl]] as const) {
    try {
      const url = new URL(raw);
      out.push({ svc, origin: url.origin, pathPrefix: url.pathname.replace(/\/+$/, '') });
    } catch {
      /* 주소가 비었거나 잘못됐다 — 그 서비스는 기록하지 않는다 */
    }
  }
  return out;
}

export interface ApiCallInfo {
  svc: 'api' | 'supabase';
  method: string;
  path: string;
}

/** 이 fetch 가 기록할 API 호출인가 — 맞으면 서비스 · 방법 · 경로(쿼리 없이), 아니면 null. 이 기록 자체의 전송은 뺀다. */
export function describeApiCall(input: unknown, init: RequestInit | undefined, targets: readonly ApiTarget[], base?: string): ApiCallInfo | null {
  let raw = '';
  if (typeof input === 'string') raw = input;
  else if (typeof URL !== 'undefined' && input instanceof URL) raw = input.href;
  else if (input && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') raw = (input as { url: string }).url;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, base ?? 'http://localhost/');
  } catch {
    return null;
  }
  const target = targets.find((t) => t.origin === url.origin
    && (!t.pathPrefix || url.pathname === t.pathPrefix || url.pathname.startsWith(`${t.pathPrefix}/`)));
  if (!target) return null;
  // 이 기록의 전송과 기록 보기 화면의 조회(rpc/action_log_*)는 남기지 않는다.
  if (url.pathname.includes(ACTION_LOG_PATH) || url.pathname.includes('/rest/v1/rpc/action_log')) return null;
  const requestMethod = input && typeof input === 'object' ? (input as { method?: unknown }).method : undefined;
  const method = String(init?.method ?? (typeof requestMethod === 'string' ? requestMethod : 'GET')).toUpperCase().slice(0, 10);
  return { svc: target.svc, method, path: sanitizePath(url.pathname, 120) };
}

export interface LoggingFetchOptions {
  targets: readonly ApiTarget[];
  base?: () => string | undefined;
  onCall: (info: ApiCallInfo & { status: number; ms: number; page?: string }) => void;
  /** 요청을 시작하는 순간 true 면 이 호출은 남기지 않는다(응답이 화면을 옮긴 뒤 와도 시작한 화면 기준). */
  skip?: () => boolean;
  /** 요청을 시작한 화면(경로) — 응답이 화면을 옮긴 뒤 와도 그 줄은 시작한 화면에 붙는다. onCall 의 page 로 넘긴다. */
  page?: () => string;
  now?: () => number;
}

/** 원래 fetch 를 감싼다 — 응답·본문은 건드리지 않고 같은 Promise 를 그대로 돌려준다. 네트워크 오류는 status 0. */
export function createLoggingFetch(original: typeof fetch, opts: LoggingFetchOptions): typeof fetch {
  const now = opts.now ?? (() => Date.now());
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let info: ApiCallInfo | null = null;
    let page: string | undefined;
    try {
      info = opts.skip?.() ? null : describeApiCall(input, init, opts.targets, opts.base?.());
      if (info && opts.page) page = opts.page();
    } catch {
      info = null;
    }
    const started = now();
    const promise = original(input, init);
    if (info) {
      const call = info;
      const report = (status: number) => {
        try {
          const ms = Math.max(0, Math.round(now() - started));
          opts.onCall(page === undefined ? { ...call, status, ms } : { ...call, status, ms, page });
        } catch {
          /* 기록은 화면을 막지 않는다 */
        }
      };
      promise.then((res) => report(res.status), () => report(0));
    }
    return promise;
  };
  return wrapped as typeof fetch;
}

// ─────────────────────────────────────────────────────────────────────────────
// 브라우저에서 돌기
// ─────────────────────────────────────────────────────────────────────────────

/** 줄을 만들 때 덧붙이는 것 — page: 그 동작이 난 화면(타이머·응답처럼 늦게 남기는 줄이 옮겨 간 화면에 붙지 않게). */
export interface ActionLogAt {
  page?: string;
}

interface ActionLogRuntime {
  log(event: ActionLogEvent, props: ActionLogProps, at?: ActionLogAt): void;
}

let runtime: ActionLogRuntime | null = null;
let installTried = false;

function safeStorage(get: () => Storage): Storage | null {
  try {
    const storage = get();
    const probe = '__nextspot_action_probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null; // 사생활 보호 모드 등 — 이 페이지에서만 쓰는 번호로 간다
  }
}

function storedId(storage: Storage | null, key: string): string {
  if (storage) {
    try {
      const existing = storage.getItem(key);
      if (isValidLogId(existing)) return existing;
      const created = newLogId();
      storage.setItem(key, created);
      return created;
    } catch {
      /* 아래 메모리 번호 */
    }
  }
  return newLogId();
}

function readSession(storage: Storage | null): { id: string; seq: number; fresh: boolean } {
  if (storage) {
    try {
      const id = storage.getItem(SESSION_KEY);
      if (isValidLogId(id)) {
        const seq = Number.parseInt(storage.getItem(SEQ_KEY) ?? '', 10);
        return { id, seq: Number.isFinite(seq) && seq >= 0 ? seq : 0, fresh: false };
      }
    } catch {
      /* 새 세션 */
    }
  }
  return { id: newLogId(), seq: 0, fresh: true };
}

function writeSession(storage: Storage | null, id: string, seq: number): void {
  if (!storage) return;
  try {
    storage.setItem(SESSION_KEY, id);
    storage.setItem(SEQ_KEY, String(seq));
  } catch {
    /* 막혀 있으면 이 페이지에서만 */
  }
}

/** JWT 의 exp(초) — 서명은 보지 않는다(만료가 가까운지만 본다). 읽을 수 없으면 null. */
export function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = typeof atob === 'function' ? atob(base64) : '';
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isActivityViewer(pathname: string): boolean {
  return pathname === ACTIVITY_VIEWER_PATH || pathname.startsWith(`${ACTIVITY_VIEWER_PATH}/`);
}

function isPrivatePath(pathname: string): boolean {
  return pathname === PRIVATE_PATH_PREFIX || pathname.startsWith(`${PRIVATE_PATH_PREFIX}/`);
}

function referrerForLog(referrer: string): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol;
    return clipText(url.origin + sanitizePath(url.pathname, 140), 200);
  } catch {
    return null;
  }
}

/** 오류가 난 파일 — 우리 파일은 경로만, 바깥 파일은 origin + 경로(쿼리 없음). */
function errorFile(file: string | undefined, base: string): string | null {
  if (!file) return null;
  return hrefForLog(file, base);
}

function scrollerLabel(target: EventTarget | null): { el: Element | null; label: string } {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !target || target === doc || target === doc.documentElement || target === doc.body) {
    return { el: doc ? doc.scrollingElement ?? doc.documentElement : null, label: 'page' };
  }
  const el = target as Element;
  const testid = attr(el, 'data-testid');
  const id = attr(el, 'id');
  const mark = attr(el, 'data-log');
  const aria = attr(el, 'aria-label');
  let own = '';
  if (testid) own = `testid:${testid}`;
  else if (id) own = `#${id}`;
  else if (mark) own = `log:${mark}`;
  else if (aria) own = `aria:${aria}`;
  const label = own || [tagOf(el), contextLabel(el.parentElement)].filter(Boolean).join(' in ');
  return { el, label: maskText(label, 60) || tagOf(el) };
}

function scrollDepth(el: Element): { axis: 'y' | 'x'; depth: number } | null {
  const maxY = el.scrollHeight - el.clientHeight;
  const maxX = el.scrollWidth - el.clientWidth;
  if (maxY > 4) return { axis: 'y', depth: Math.round(Math.min(100, Math.max(0, (el.scrollTop / maxY) * 100))) };
  if (maxX > 4) return { axis: 'x', depth: Math.round(Math.min(100, Math.max(0, (Math.abs(el.scrollLeft) / maxX) * 100))) };
  return null;
}

function createRuntime(w: ActionLogWindow): ActionLogRuntime {
  const local = safeStorage(() => w.localStorage);
  const sessionStore = safeStorage(() => w.sessionStorage);
  const deviceId = storedId(local, DEVICE_KEY);
  const session = readSession(sessionStore);
  let sessionId = session.id;
  let seq = session.seq;
  let fresh = session.fresh;
  if (fresh) writeSession(sessionStore, sessionId, seq);

  // 계정 상태 — auth 이벤트로 따라간다. 토큰은 메모리에만 둔다(저장분에는 계정 번호만).
  let auth: ActionLogAuth = { sub: null, token: null };
  let authKnown = false;
  const unresolved: ActionLogRow[] = [];
  const tokensBySub = new Map<string, string>();
  const remember = (s: Session | null | undefined): ActionLogAuth => {
    const sub = s?.user?.id ?? null;
    const token = s?.access_token ?? null;
    if (sub && token) tokensBySub.set(sub, token);
    return { sub, token };
  };

  const transportFetch = (url: string, init: RequestInit) => {
    const original = w.__NEXTSPOT_ACTION_LOG_FETCH__ ?? w.fetch;
    return original.call(w, url, init);
  };

  const core = createActionLogCore({
    endpoint: `${SUPABASE_URL}${ACTION_LOG_PATH}`,
    anonKey: SUPABASE_ANON_KEY,
    fetch: transportFetch,
    storage: local,
    entryKey: () => sessionId,
    cachedAuth: () => auth,
    currentAuth: async () => {
      try {
        const { data } = await withTimeout(createPublicClient().auth.getSession(), 2000);
        return remember(data.session);
      } catch {
        return auth;
      }
    },
    tokenForSub: (sub) => tokensBySub.get(sub) ?? null,
    isTokenFresh: (token) => {
      const exp = jwtExpiry(token);
      return exp === null || exp * 1000 - Date.now() > 60_000;
    },
    refreshAuth: async () => {
      try {
        const { data } = await withTimeout(createPublicClient().auth.refreshSession(), 4000);
        return data.session ? remember(data.session) : null;
      } catch {
        return null;
      }
    },
  });

  // 탭 복제는 sessionStorage 까지 복사한다 — 원래 탭이 같은 세션 번호로 살아 있으면 새 세션을 연다(seq 가 겹치지 않게).
  let duplicated = false;
  if (!fresh && core.liveElsewhere(sessionId)) {
    sessionId = newLogId();
    seq = 0;
    fresh = true;
    duplicated = true;
    writeSession(sessionStore, sessionId, seq);
  }
  core.adopt();

  const nextSeq = (): number => {
    const value = seq;
    seq += 1;
    if (sessionStore) {
      try {
        sessionStore.setItem(SEQ_KEY, String(seq));
      } catch {
        /* 이 페이지에서만 센다 */
      }
    }
    return value;
  };

  const log = (event: ActionLogEvent, props: ActionLogProps, at?: ActionLogAt): void => {
    if (!EVENT_SET.has(event)) return;
    const pathname = (typeof at?.page === 'string' && at.page) || w.location.pathname || '/';
    if (isActivityViewer(pathname) && event !== 'page_view' && event !== 'session_start') return;
    const row: ActionLogRow = {
      occurred_at: new Date().toISOString(),
      device_id: deviceId,
      session_id: sessionId,
      seq: nextSeq(),
      event,
      page: clipText(sanitizePath(pathname, 200), 200),
      host: clipText(w.location.host || w.location.hostname || 'unknown', 100),
      locale: clipText(w.document?.documentElement?.lang || 'ko', 16) || 'ko',
      props: cleanProps(props),
    };
    // 줄마다 만든 때의 계정: 계정 번호 · 로그인 안 함('') · 아직 모름(null — 첫 auth 이벤트에서 정한다).
    core.push(row, authKnown ? auth.sub ?? '' : null);
    if (!authKnown && unresolved.length < 500) unresolved.push(row);
  };

  const rt: ActionLogRuntime = { log };
  if (fresh) log('session_start', sessionStartProps(w, duplicated));

  // ── 화면 조작 ────────────────────────────────────────────────────────────
  const doc = w.document;
  const opts = { capture: true, passive: true } as const;
  let lastInputAt = Date.now();
  const markInput = () => {
    lastInputAt = Date.now();
  };
  const guard = <E extends Event>(fn: (event: E) => void) => (event: E) => {
    try {
      fn(event);
    } catch {
      /* 기록은 화면을 막지 않는다 */
    }
  };
  const safely = (fn: () => void) => () => {
    try {
      fn();
    } catch {
      /* 기록은 화면을 막지 않는다 */
    }
  };
  const describeOpts = (): DescribeOptions => ({ base: w.location.href, privateZone: isPrivatePath(w.location.pathname) });

  doc.addEventListener('click', guard((event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const el = findInteractive(target);
    log('click', el ? describeTarget(el, describeOpts()) : describePlainTarget(target));
  }), opts);

  doc.addEventListener('change', guard((event: Event) => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || !FORM_FIELD_TAGS.has(tagOf(el))) return;
    log('input', describeFieldChange(el, describeOpts()));
  }), opts);

  doc.addEventListener('submit', guard((event: SubmitEvent) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    const privateZone = isPrivatePath(w.location.pathname) || inPrivateZone(form);
    const submitter = form.querySelector('button[type="submit"], input[type="submit"]');
    const identity = attr(form, 'id') || attr(form, 'name') || attr(form, 'aria-label') || attr(form, 'data-testid') || attr(form, 'data-log')
      || (submitter && !privateZone ? targetName(submitter) : '') || 'form';
    const props: ActionLogProps = { form: maskText(identity, 60), fields: form.elements.length };
    if (!privateZone) {
      for (const field of Array.from(form.elements)) {
        if (!isValueCapturable(field)) continue;
        const value = (field as HTMLInputElement).value;
        if (typeof value === 'string' && value.trim()) {
          props.q = maskText(value, 100);
          break;
        }
      }
    }
    log('submit', props);
  }), opts);

  doc.addEventListener('keydown', guard((event: KeyboardEvent) => {
    markInput();
    const el = event.target instanceof Element ? event.target : null;
    const isEscape = event.key === 'Escape';
    const isEnter = event.key === 'Enter' && !event.isComposing && !isTextEntry(el);
    if (!isEscape && !isEnter) return;
    const interactive = findInteractive(el);
    const target = interactive ? describeTarget(interactive, describeOpts()) : describePlainTarget(el);
    log('key', { key: event.key, tag: target.tag, name: target.name, testid: target.testid, ctx: target.ctx });
  }), opts);

  // 밀기(swipe) — 1.5초 안에 40px 넘게 끌었으면 방향 · 거리만(좌표는 남기지 않는다).
  const pointers = new Map<number, { x: number; y: number; t: number; target: EventTarget | null }>();
  doc.addEventListener('pointerdown', guard((event: PointerEvent) => {
    markInput();
    if (pointers.size > 8) pointers.clear();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, t: Date.now(), target: event.target });
  }), opts);
  doc.addEventListener('pointerup', guard((event: PointerEvent) => {
    const start = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const distance = Math.hypot(dx, dy);
    const ms = Date.now() - start.t;
    if (distance <= 40 || ms > 1500) return;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    const startEl = start.target instanceof Element ? start.target : null;
    log('swipe', { dir, dist: Math.round(distance), ms, pointer: event.pointerType || null, target: tagOf(startEl) || null, ctx: contextLabel(startEl) || null });
  }), opts);
  doc.addEventListener('pointercancel', guard((event: PointerEvent) => {
    pointers.delete(event.pointerId);
  }), opts);
  doc.addEventListener('wheel', markInput, opts);
  doc.addEventListener('touchstart', markInput, opts);

  // 스크롤 — 스크롤하는 상자마다 3초에 한 번, 깊이가 20 이상 움직였을 때만(깊이 = 위 0 … 끝 100).
  const scrollState = new WeakMap<Element, { depth: number; at: number }>();
  const scrollPending = new Set<EventTarget>();
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  const processScroll = () => {
    scrollTimer = null;
    const targets = [...scrollPending];
    scrollPending.clear();
    let wait = 0;
    for (const target of targets) {
      const { el, label } = scrollerLabel(target);
      if (!el) continue;
      const measured = scrollDepth(el);
      if (!measured) continue;
      const state = scrollState.get(el) ?? { depth: 0, at: 0 };
      if (Math.abs(measured.depth - state.depth) < 20) continue;
      const since = Date.now() - state.at;
      if (since < 3000) {
        scrollPending.add(target);
        wait = Math.max(wait, 3000 - since);
        continue;
      }
      scrollState.set(el, { depth: measured.depth, at: Date.now() });
      log('scroll', { scroller: label, axis: measured.axis, depth: measured.depth });
    }
    if (scrollPending.size && !scrollTimer) scrollTimer = setTimeout(safely(processScroll), Math.max(400, wait));
  };
  doc.addEventListener('scroll', guard((event: Event) => {
    markInput();
    if (scrollPending.size > 32) return;
    scrollPending.add(event.target ?? doc);
    if (!scrollTimer) scrollTimer = setTimeout(safely(processScroll), 400);
  }), opts);

  // ── 보임 · 떠남 ────────────────────────────────────────────────────────────
  let hiddenAt = 0;
  let unloading = false;
  doc.addEventListener('visibilitychange', guard(() => {
    if (unloading) return; // pagehide 에서 이미 남기고 보냈다
    if (doc.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      log('visibility', { state: 'hidden' });
      core.persistNow();
      void core.flush({ keepalive: true });
    } else {
      const hiddenS = hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : null;
      hiddenAt = 0;
      log('visibility', { state: 'visible', hidden_s: hiddenS });
      core.reclaim();
    }
  }));
  w.addEventListener('pagehide', guard((event: PageTransitionEvent) => {
    log('visibility', { state: 'pagehide', persisted: event.persisted });
    unloading = true;
    core.unload();
  }));
  w.addEventListener('pageshow', guard((event: PageTransitionEvent) => {
    if (!event.persisted) return;
    unloading = false; // bfcache 에서 돌아왔다
    // 그사이 같은 탭의 다른 페이지(예: OAuth 왕복)가 같은 세션 번호로 순번을 더 썼으면, 이어 쓰면 (session_id, seq) 가
    // 겹치고 그 페이지가 남긴 저장분 칸을 덮는다 — 새 세션을 연다(그때 저장한 줄은 reclaim 이 그 칸 몫으로 넘긴다).
    const stored = readSession(sessionStore);
    if (!stored.fresh && (stored.id !== sessionId || stored.seq > seq)) {
      sessionId = newLogId();
      seq = 0;
      writeSession(sessionStore, sessionId, seq);
      log('session_start', { ...sessionStartProps(w, false), restored: true });
    }
    log('visibility', { state: 'pageshow' });
    core.reclaim();
  }));
  doc.addEventListener('freeze', guard(() => core.persistNow()));
  doc.addEventListener('resume', guard(() => core.reclaim()));
  w.addEventListener('online', guard(() => {
    void core.flush();
  }));

  // ── 하트비트 — 보이는 동안 30초마다(입력이 10분 없으면 5분마다). 화면을 열어 둔 시간을 재는 근거다. ──
  let lastBeatAt = 0;
  setInterval(safely(() => {
    core.touch();
    if (doc.visibilityState !== 'visible') return;
    const idle = Date.now() - lastInputAt;
    if (idle >= IDLE_HEARTBEAT_AFTER_MS && Date.now() - lastBeatAt < IDLE_HEARTBEAT_EVERY_MS) return;
    lastBeatAt = Date.now();
    log('heartbeat', { active: idle < HEARTBEAT_MS, idle_s: Math.min(86_400, Math.round(idle / 1000)) });
  }), HEARTBEAT_MS);

  // ── 오류 — 같은 오류는 10초에 한 번, 페이지당 30개까지. ──
  const errorSeen = new Map<string, number>();
  let errorCount = 0;
  const logError = (kind: 'error' | 'rejection', message: string, file?: string, line?: number, col?: number) => {
    if (errorCount >= 30) return;
    const masked = maskText(message, 200);
    if (/ResizeObserver loop/i.test(masked)) return; // 브라우저가 내는 무해한 경고
    const path = errorFile(file, w.location.href);
    const key = `${kind}|${masked}|${path}|${line ?? ''}`;
    const at = Date.now();
    const last = errorSeen.get(key);
    if (last !== undefined && at - last < 10_000) return;
    errorSeen.set(key, at);
    if (errorSeen.size > 64) errorSeen.clear();
    errorCount += 1;
    log('error', { kind, message: masked || null, file: path, line: line ?? null, col: col ?? null });
  };
  w.addEventListener('error', guard((event: ErrorEvent) => {
    logError('error', event.message || String(event.error ?? ''), event.filename, event.lineno, event.colno);
  }));
  w.addEventListener('unhandledrejection', guard((event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    const frame = reason instanceof Error && reason.stack ? /(https?:\/\/[^\s)]+):(\d+):(\d+)/.exec(reason.stack) : null;
    logError('rejection', message, frame?.[1], frame ? Number(frame[2]) : undefined, frame ? Number(frame[3]) : undefined);
  }));

  // ── API 호출 — window.fetch 를 한 번만 감싼다. 원래 fetch 는 이 기록의 전송에 쓴다. ──
  if (!w.__NEXTSPOT_ACTION_LOG_FETCH__ && typeof w.fetch === 'function') {
    const original = w.fetch;
    w.__NEXTSPOT_ACTION_LOG_FETCH__ = original;
    w.fetch = createLoggingFetch(original.bind(w), {
      targets: apiTargets(),
      base: () => w.location.href,
      skip: () => isActivityViewer(w.location.pathname || '/'),
      page: () => w.location.pathname || '/',
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      onCall: (info) => log('api', { svc: info.svc, method: info.method, path: info.path, status: info.status, ms: info.ms }, { page: info.page }),
    });
  }

  // ── 쿼리만 바뀐 화면 이동 — 경로가 바뀌면 ActionLogger 가 page_view 를 남기지만, 같은 경로에서 쿼리(검색 조건 등)만
  // 바뀌면 usePathname 이 그대로라 남지 않는다. history.pushState · replaceState 를 한 번만 감싸고 popstate(뒤로·앞으로)도
  // 보아, 경로는 같고 정리한 쿼리가 달라졌을 때만 page_view(nav='query') 한 줄을 남긴다(경로가 바뀐 경우는 ActionLogger 몫).
  // useSearchParams 를 쓰지 않는 까닭: 정적 export 에서 Suspense 경계를 요구해 셸 전체의 프리렌더를 흔든다.
  let lastPath = w.location.pathname || '/';
  let lastQuery = sanitizeQuery(w.location.search);
  const noteLocation = (how: 'push' | 'replace' | 'pop') => {
    const path = w.location.pathname || '/';
    const query = sanitizeQuery(w.location.search);
    if (path === lastPath && query !== lastQuery) {
      log('page_view', { from: sanitizePath(path, 140), nav: 'query', how, query, prev_query: lastQuery });
    }
    lastPath = path;
    lastQuery = query;
  };
  const history = w.history as (History & { __nextspotActionLog?: boolean }) | undefined;
  if (history && !history.__nextspotActionLog && typeof history.pushState === 'function' && typeof history.replaceState === 'function') {
    history.__nextspotActionLog = true;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    history.pushState = function pushState(this: History, ...args: Parameters<History['pushState']>) {
      const result = originalPush.apply(this, args);
      safely(() => noteLocation('push'))();
      return result;
    };
    history.replaceState = function replaceState(this: History, ...args: Parameters<History['replaceState']>) {
      const result = originalReplace.apply(this, args);
      safely(() => noteLocation('replace'))();
      return result;
    };
    w.addEventListener('popstate', guard(() => noteLocation('pop')));
  }

  // ── 로그인 상태 — 종류 · 익명 여부 · 로그인 수단만(이메일·토큰은 담지 않는다). ──
  let initialLogged = false;
  // 로그인 상태가 처음 정해지면, 그 전에 만든 줄(session_start · 첫 page_view 등)을 그 상태로 묶는다.
  const resolveAuth = () => {
    if (authKnown) return;
    authKnown = true;
    core.assignSub(unresolved, auth.sub ?? '');
    unresolved.length = 0;
  };
  const authProps = (kind: string, s: Session | null): ActionLogProps => ({
    kind,
    anonymous: s ? s.user?.is_anonymous === true : null,
    provider: s && typeof s.user?.app_metadata?.provider === 'string' ? clipText(s.user.app_metadata.provider, 24) : null,
  });
  try {
    createPublicClient().auth.onAuthStateChange(guardAuth((event: AuthChangeEvent, s: Session | null) => {
      if (event === 'SIGNED_OUT') {
        // 나간 계정의 줄로 남긴다(바뀌기 전 계정 번호로 묶인다).
        if (auth.sub) log('auth', authProps('signed_out', null));
        auth = remember(null);
        resolveAuth();
        return;
      }
      const previous = auth;
      auth = remember(s);
      resolveAuth();
      if (event === 'INITIAL_SESSION') {
        if (!initialLogged) log('auth', authProps('initial', s));
        initialLogged = true;
      } else if (event === 'SIGNED_IN') {
        // supabase-js 는 탭에 돌아올 때도 같은 세션으로 SIGNED_IN 을 다시 낸다 — 계정이 바뀐 때만 남긴다.
        if (previous.sub !== auth.sub) log('auth', authProps('signed_in', s));
      } else if (event === 'USER_UPDATED') {
        log('auth', authProps('user_updated', s));
      }
    }));
  } catch {
    /* 인증 클라이언트를 못 만들면 anon 키로만 보낸다 */
  }

  return rt;
}

function guardAuth(fn: (event: AuthChangeEvent, session: Session | null) => void) {
  return (event: AuthChangeEvent, session: Session | null) => {
    try {
      fn(event, session);
    } catch {
      /* 기록은 로그인 흐름을 막지 않는다 */
    }
  };
}

function sessionStartProps(w: ActionLogWindow, duplicated: boolean): ActionLogProps {
  const nav = w.navigator as Navigator & { standalone?: boolean };
  let timezone: string | null = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timezone = null;
  }
  let standalone = nav?.standalone === true;
  try {
    standalone = standalone || (typeof w.matchMedia === 'function' && w.matchMedia('(display-mode: standalone)').matches);
  } catch {
    /* 그대로 */
  }
  const languages = Array.isArray(nav?.languages) && nav.languages.length ? nav.languages : nav?.language ? [nav.language] : [];
  return {
    referrer: referrerForLog(w.document?.referrer ?? ''),
    landing: clipText(sanitizePath(w.location.pathname, 140) + sanitizeQuery(w.location.search, 120), 200),
    viewport: `${w.innerWidth}x${w.innerHeight}`,
    screen: w.screen ? `${w.screen.width}x${w.screen.height}` : null,
    dpr: Math.round((w.devicePixelRatio || 1) * 100) / 100,
    timezone,
    languages: languages.slice(0, 3).map((l) => clipText(String(l), 16)),
    standalone,
    touch: (nav?.maxTouchPoints ?? 0) > 0,
    duplicated: duplicated || undefined,
  };
}

/** 한 번만 설치한다(여러 번 불러도 같다). 기록하지 않는 환경이면 아무것도 하지 않는다. */
export function installActionLog(): void {
  const w = browserWindow();
  if (!w) return;
  if (runtime) return;
  if (w.__NEXTSPOT_ACTION_LOG_RUNTIME__) {
    // 개발 중 모듈이 다시 읽혀도(HMR) 리스너를 두 번 달지 않는다.
    runtime = w.__NEXTSPOT_ACTION_LOG_RUNTIME__;
    return;
  }
  if (installTried) return;
  installTried = true;
  try {
    if (!shouldRecordActionLog()) return;
    runtime = createRuntime(w);
    w.__NEXTSPOT_ACTION_LOG_RUNTIME__ = runtime;
  } catch {
    runtime = null;
  }
}

/**
 * 기록 한 줄(모아 두었다가 보낸다). 기록하지 않는 환경이면 아무것도 하지 않고, 절대 던지지 않는다.
 * at.page — 동작이 난 화면을 미리 잡아 둔 경우(타이머 뒤에 남기는 줄). 없으면 지금 화면.
 */
export function logAction(event: ActionLogEvent, props: ActionLogProps = {}, at?: ActionLogAt): void {
  try {
    if (!runtime) installActionLog();
    runtime?.log(event, props, at);
  } catch {
    /* 기록은 화면을 막지 않는다 */
  }
}

function recording(): boolean {
  if (!runtime) installActionLog();
  return runtime !== null;
}

/** 지금 화면 경로 — 늦게 남기는 줄이 동작한 화면에 붙도록 미리 잡아 둔다. */
function currentPage(): string | undefined {
  try {
    return browserWindow()?.location?.pathname || undefined;
  } catch {
    return undefined;
  }
}

const typingSearches = new Map<string, { timer: ReturnType<typeof setTimeout> | null; last: string }>();

/** 검색을 실제로 낸 순간(Enter · 음성 · 제출) — 검색어는 가려서. source 는 어느 검색칸인지. */
export function logSearch(query: string, source: string, via: 'enter' | 'voice' | 'submit' = 'enter'): void {
  if (!recording()) return;
  const q = maskText(query, 100);
  if (!q) return;
  const state = typingSearches.get(source);
  if (state?.timer) clearTimeout(state.timer);
  typingSearches.set(source, { timer: null, last: q });
  logAction('search', { q, source, via });
}

/**
 * 치는 대로 걸러 주는 검색칸(제출 단계가 없다) — 입력이 delayMs 동안 멈추면 그 검색어를 한 번 남긴다.
 * 같은 검색어를 연달아 남기지 않는다. 기록하지 않는 환경에서는 타이머도 만들지 않는다.
 */
export function logSearchTyping(query: string, source: string, delayMs = 1500): void {
  if (!recording()) return;
  const state = typingSearches.get(source) ?? { timer: null, last: '' };
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const q = maskText(query, 100);
  if (q) {
    const page = currentPage(); // 친 화면 — 멈춘 사이 화면을 옮겨도 그 화면의 검색으로 남긴다
    state.timer = setTimeout(() => {
      state.timer = null;
      if (q === state.last) return;
      state.last = q;
      logAction('search', { q, source, via: 'typing' }, { page });
    }, delayMs);
  }
  typingSearches.set(source, state);
}

/** 음성으로 알아들은 최종 문장 — 음성 비서('assistant')와 검색 마이크('search')만. 녹음은 남기지 않는다. */
export function logVoice(text: string, source: 'assistant' | 'search', phase: 'final' = 'final'): void {
  if (!recording()) return;
  const masked = maskText(text, 200);
  if (!masked) return;
  logAction('voice', { text: masked, source, phase });
}

interface KakaoMapLike {
  getLevel(): number;
}

const noop = () => {};

/**
 * Kakao 지도의 확대 단계만 남긴다(idle · zoom_changed, 지도마다 2초에 한 번 + 마지막 상태). 중심·좌표는 남기지 않는다.
 * 지도를 만든 바로 뒤에 한 번 부르고, 돌려받은 함수를 effect 정리(언마운트·지도 교체)에서 부른다 — 리스너를 떼고 남은
 * 마지막 상태 타이머도 지운다. 기록하지 않는 환경이면 리스너도 달지 않는다(그때도 함수는 돌려준다).
 */
export function trackMapActions(map: KakaoMapLike | null | undefined, name: string): () => void {
  try {
    if (!map || !recording()) return noop;
    const events = browserWindow()?.kakao?.maps?.event;
    if (!events) return noop;
    let lastAt = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let pendingKind = 'idle';
    let pendingPage: string | undefined;
    let disposed = false;
    const fire = (kind: string, page: string | undefined) => {
      lastAt = Date.now();
      let level: number | null = null;
      try {
        level = map.getLevel();
      } catch {
        level = null;
      }
      logAction('map', { kind, level, map: name }, { page });
    };
    const handler = (kind: 'idle' | 'zoom') => () => {
      if (disposed) return;
      const page = currentPage(); // 지도를 움직인 화면(마지막 상태 줄이 2초 뒤에 나가도)
      const elapsed = Date.now() - lastAt;
      if (elapsed >= 2000) {
        fire(kind, page);
        return;
      }
      pendingKind = kind;
      pendingPage = page;
      if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          if (!disposed) fire(pendingKind, pendingPage);
        }, 2000 - elapsed);
      }
    };
    const onIdle = handler('idle');
    const onZoom = handler('zoom');
    events.addListener(map, 'idle', onIdle);
    events.addListener(map, 'zoom_changed', onZoom);
    return () => {
      if (disposed) return;
      disposed = true;
      if (trailing) clearTimeout(trailing);
      trailing = null;
      try {
        events.removeListener(map, 'idle', onIdle);
        events.removeListener(map, 'zoom_changed', onZoom);
      } catch {
        /* 지도가 이미 사라졌다 */
      }
    };
  } catch {
    return noop; // 지도는 그대로
  }
}
