// 이용 기록·제품 분석의 순수 로직 — 환경(저장소·시계·전송)은 주입한다(테스트: analytics.test.ts).
//
// 웹 원본(기준 커밋 e07ea61):
//   apps/web/lib/usageEvents.ts — 익명 이용 기록(public.usage_events). 같은 이벤트 목록·행 모양·2초 묶음·20건 상한·
//                                첫 실패 뒤 그 실행에서는 그만 보내기.
//   apps/web/lib/analytics.ts   — POST /api/v1/events/track. 같은 이벤트별 속성 허용 목록·유모차(stroller) 422 재시도.
// 다른 것: 켜는 조건(운영 호스트 → 빌드 설정), 화면 경로·언어를 읽는 곳(location·<html lang> → 주입),
// 보내는 수단(supabase-js·fetch/sendBeacon → 주입). 앱 연결은 analytics.ts 가 한다.

/** DB CHECK(supabase/migrations/20261023090000_usage_events.sql)·웹 USAGE_EVENTS 와 같은 목록 — 하나를 더하면 셋 다 고친다. */
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

/**
 * 기록을 켤지 — 빌드 설정(env.usageEventsEnabled: 운영 빌드 + EXPO_PUBLIC_USAGE_EVENTS 1·true)과 공개 지역을 함께 본다.
 * 둘 다 매번 묻는다(지역은 실행 중에 바뀔 수 있다). 규칙은 이 한 곳 — analytics.ts 는 이것만 쓴다.
 */
export function usageGate(buildEnabled: () => boolean, publicRegion: () => boolean): () => boolean {
  return () => buildEnabled() && publicRegion();
}

/**
 * 앱 화면 경로 → 웹 경로. usage_events.page 를 웹과 같은 값으로 모아야 앱·웹 화면별 집계가 한 줄에 선다.
 * 하단 탭: 홈 '/' → '/main'(웹 BottomNav 의 path), 나머지 탭은 이름이 같다. 모르는 경로는 그대로 둔다.
 */
const APP_TO_WEB_PATH: Record<string, string> = {
  '/': '/main',
  '/index': '/main',
};

export function webPagePath(appPath: string): string {
  const path = appPath.split(/[?#]/)[0] || '/';
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return APP_TO_WEB_PATH[trimmed] ?? trimmed;
}

export const FLUSH_DELAY_MS = 2000;
export const MAX_BATCH = 20;

export interface UsageRow {
  anon_id: string;
  session_id: string | null;
  event: UsageEvent;
  page: string;
  locale: string | null;
  props: UsageProps;
}

export type InsertUsageEvents = (rows: UsageRow[]) => PromiseLike<{ error: unknown }>;

export interface UsageRecorderDeps {
  /** 지금 기록해도 되는가(빌드 설정·공개 지역). 매 이벤트마다 묻는다. */
  enabled(): boolean;
  /** 전송 수단. 아직 없으면 null — 기록하지 않는다. */
  insert(): InsertUsageEvents | null;
  anonId(): string | null;
  sessionId(): string | null;
  page(): string;
  locale(): string | null;
  schedule(fn: () => void, ms: number): () => void;
}

const USAGE_EVENT_SET = new Set<string>(USAGE_EVENTS);

export function createUsageRecorder(deps: UsageRecorderDeps) {
  const queue: UsageRow[] = [];
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  let sender: InsertUsageEvents | null = null;

  async function flush(): Promise<void> {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
    const rows = queue.splice(0, MAX_BATCH);
    if (rows.length === 0 || !sender) return;
    try {
      const { error } = await sender(rows);
      if (error) stopped = true;
    } catch {
      stopped = true;
    }
  }

  function trackEvent(event: UsageEvent, props: UsageProps = {}): void {
    if (stopped || !USAGE_EVENT_SET.has(event)) return;
    try {
      if (!deps.enabled()) return;
      sender = deps.insert();
      if (!sender) return;
      const anonId = deps.anonId();
      if (!anonId) return; // 번호 없이는 기록하지 않는다
      const locale = deps.locale();
      queue.push({
        anon_id: anonId,
        session_id: deps.sessionId(),
        event,
        page: deps.page().slice(0, 120),
        locale: locale ? locale.slice(0, 8) : null,
        props,
      });
    } catch {
      return; // 기록은 화면 흐름을 막지 않는다
    }
    if (queue.length >= MAX_BATCH) void flush();
    else if (!cancelTimer) cancelTimer = deps.schedule(() => void flush(), FLUSH_DELAY_MS);
  }

  return {
    trackEvent,
    flush,
    /** 테스트용 */
    get pending() {
      return queue.length;
    },
    get stopped() {
      return stopped;
    },
  };
}

/** 추천 카드 이벤트의 공통 속성 — 웹 usageCardProps 와 같다. */
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

// --- POST /api/v1/events/track (웹 analytics.ts) ---

export const EVENT_PROPS: Record<string, ReadonlySet<string>> = {
  context_applied: new Set(['categories', 'max_walk_minutes', 'available_minutes', 'required_attributes', 'exclude_visited']),
  recommendation_compared: new Set(['count']),
  recommendation_explained: new Set(['question', 'llm_status']),
  navigation_started: new Set(['facility_type', 'navigation_mode', 'walk_minutes']),
  trip_resumed: new Set(['facility_type']),
  replan_requested: new Set(['facility_type']),
  arrival_confirmed: new Set(['facility_type']),
  visit_confirmed: new Set(['facility_type', 'rating']),
  voice_tool_executed: new Set(['tool', 'status', 'facility_type', 'max_walk_minutes']),
};

/** JSON 본문을 보낸다. 앱 API 클라이언트가 X-NextSpot-Client 헤더를 붙인다. */
export type PostTrack = (payload: string) => PromiseLike<{ ok: boolean; status: number }>;

export interface TrackerDeps {
  enabled(): boolean;
  post(): PostTrack | null;
  /** 이 실행의 서버가 'stroller' 조건을 모른다고 이미 확인했는가(웹 strollerSupport 와 같은 저장 키). */
  serverSkipsStroller(): boolean;
  markServerSkipsStroller(): void;
}

function swallow(p: PromiseLike<unknown>): void {
  Promise.resolve(p).catch(() => {
    /* 계측 실패는 무해 무시 */
  });
}

export function createTracker(deps: TrackerDeps) {
  function trackStrollerContext(post: PostTrack, event: string, props: Record<string, unknown>): boolean {
    const attributes = props.required_attributes;
    if (event !== 'context_applied' || !Array.isArray(attributes) || !attributes.includes('stroller')) return false;
    const stripped = { ...props, required_attributes: attributes.filter((a) => a !== 'stroller') };
    if (deps.serverSkipsStroller()) {
      swallow(post(JSON.stringify({ event, props: stripped })));
      return true;
    }
    swallow(
      Promise.resolve(post(JSON.stringify({ event, props }))).then(async (response) => {
        if (response.status !== 422) return;
        const retry = await post(JSON.stringify({ event, props: stripped }));
        if (retry.ok) deps.markServerSkipsStroller();
      }),
    );
    return true;
  }

  /** 익명 분석 이벤트 1건(fire-and-forget). 허용 목록에 없는 이벤트·속성은 버린다. */
  function track(event: string, props?: Record<string, unknown>): void {
    try {
      if (!deps.enabled()) return;
      const post = deps.post();
      if (!post) return;
      const allowed = EVENT_PROPS[event];
      if (!allowed) return;
      const safeProps = Object.fromEntries(Object.entries(props ?? {}).filter(([key]) => allowed.has(key)));
      if (trackStrollerContext(post, event, safeProps)) return;
      swallow(post(JSON.stringify({ event, props: safeProps })));
    } catch {
      /* 계측은 부가 기능 — 어떤 예외도 화면으로 전파하지 않는다 */
    }
  }

  return { track };
}
