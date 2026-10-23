// 익명 이용 기록 — 어떤 화면을 열고 추천 카드에서 무엇을 눌렀는지를 우리 DB(public.usage_events)에 쌓는다.
// 외부 분석 업체를 쓰지 않는다(2026-10-23 PM). 이름·계정·위치·검색어는 담지 않는다 — 브라우저가 만든 익명 번호뿐.
//
// 운영 주소에서만 보낸다: 로컬·Vercel 미리보기·자동화(navigator.webdriver — Playwright e2e·우리 점검 스크립트)·
// 추적 거부(Do Not Track)는 세지 않는다. 기록은 화면 흐름을 막지 않는다 — 모았다가 한 번에 보내고, 실패하면
// 조용히 버리며 그 탭에서는 더 보내지 않는다(표가 아직 없거나 권한이 없을 때 매 동작마다 실패하지 않게).
import { createPublicClient } from '@/lib/supabase';

/** DB CHECK(supabase/migrations/20261023090000_usage_events.sql)와 같은 목록 — 하나를 더하면 둘 다 고친다. */
export const USAGE_EVENTS = [
  'page_view',
  'rec_shown',
  'rec_accept',
  'rec_drive',
  'rec_next',
  'rec_later',
  'visit_arrived',
  'visit_congestion',
  'congestion_report',
] as const;
export type UsageEvent = (typeof USAGE_EVENTS)[number];
export type UsageProps = Record<string, string | number | boolean | null>;

const PRODUCTION_HOST = 'nextspot-nu.vercel.app';
const ANON_ID_KEY = 'nextspot_anon_id';
const SESSION_ID_KEY = 'nextspot_session_id';
const FLUSH_DELAY_MS = 2000;
const MAX_BATCH = 20;

interface UsageRow {
  anon_id: string;
  session_id: string | null;
  event: UsageEvent;
  page: string;
  locale: string | null;
  props: UsageProps;
}

const queue: UsageRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function shouldRecord(): boolean {
  if (stopped || typeof window === 'undefined') return false;
  if (navigator.webdriver || navigator.doNotTrack === '1') return false;
  return window.location.hostname === PRODUCTION_HOST;
}

function storedId(storage: Storage, key: string): string | null {
  try {
    let value = storage.getItem(key);
    if (!value) {
      value = crypto.randomUUID();
      storage.setItem(key, value);
    }
    return value;
  } catch {
    return null; // 저장소 차단(사생활 보호 모드 등) — 번호 없이는 기록하지 않는다
  }
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const rows = queue.splice(0, MAX_BATCH);
  if (rows.length === 0) return;
  try {
    const { error } = await createPublicClient().from('usage_events').insert(rows);
    if (error) stopped = true;
  } catch {
    stopped = true;
  }
}

/** 추천 카드 이벤트의 공통 속성 — 장소 id·종류와 목록 순위(검색·직접 연 곳은 null). */
export function usageCardProps(
  facility: { id?: unknown; type?: unknown } | null | undefined,
  rank: number | null,
): UsageProps {
  return {
    facility_id: facility?.id != null ? String(facility.id).slice(0, 64) : null,
    type: typeof facility?.type === 'string' ? facility.type.slice(0, 24) : null,
    rank,
  };
}

/** 이벤트 하나를 모아 둔다(2초 안에 모인 것을 한 번에 보낸다). 속성에는 장소 종류·id·순위 같은 짧은 값만. */
export function trackEvent(event: UsageEvent, props: UsageProps = {}): void {
  if (!shouldRecord()) return;
  const anonId = storedId(window.localStorage, ANON_ID_KEY);
  if (!anonId) return;
  queue.push({
    anon_id: anonId,
    session_id: storedId(window.sessionStorage, SESSION_ID_KEY),
    event,
    page: window.location.pathname.slice(0, 120),
    locale: document.documentElement.lang ? document.documentElement.lang.slice(0, 8) : null,
    props,
  });
  if (queue.length >= MAX_BATCH) void flush();
  else if (!flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

// 탭을 떠날 때 남은 것을 보낸다(브라우저가 중간에 끊으면 그 몇 건은 잃는다 — 실적 집계에는 충분하다).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flush());
}
