// 분산 코스 화면의 순수 판정·변환 — 화면·네트워크 없이 테스트할 수 있게 웹 course/page.tsx 에서 떼어 냈다(model.test.ts).
// 웹 원본: apps/web/app/course/page.tsx (기준 커밋 0d145a1). 바꾼 것은 PORTING.md 의 features/course 행.
import type { ParsedShareStop } from '@/lib/courseShare';

import {
  MAX_SEQUENCE,
  TYPE_OPTIONS,
  type CoursePlan,
  type CourseStop,
  type SequenceItem,
  type SlotOutcome,
} from './types';

// ── 시간 표기 ────────────────────────────────────────────────────────────────

/** 도착 오프셋(분) → 예상 시각(HH:MM, 24h). baseMs 는 코스 기준 시각(없으면 지금). */
export function hhmm(offsetMin: number, baseMs: number | null = null, nowMs: number = Date.now()): string {
  const clock = new Date((baseMs ?? nowMs) + offsetMin * 60_000);
  return `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
}

/** 도착 시간 문구의 키·치환값 — 8분 미만이면 '지금 바로', 아니면 '약 N분 뒤'. 문장은 화면이 t() 로 만든다. */
export function arrivalParts(offsetMin: number): { key: 'course.arrivalNow' | 'course.arrivalAfter'; vars?: { min: number } } {
  return offsetMin < 8 ? { key: 'course.arrivalNow' } : { key: 'course.arrivalAfter', vars: { min: Math.round(offsetMin) } };
}

/** 걷는 시간 표기 — 올림, 최소 1분(웹 displayWalkingMinutes 와 같다). 모르면 null. */
export function walkMinutesOf(travelMinutes: number | null | undefined): number | null {
  return typeof travelMinutes === 'number' && Number.isFinite(travelMinutes)
    ? Math.max(1, Math.ceil(Math.max(0, travelMinutes)))
    : null;
}

export function typeEmoji(type: string): string {
  return TYPE_OPTIONS.find((o) => o.id === type)?.emoji ?? '📍';
}

// ── 자리 키·고정(pin) ────────────────────────────────────────────────────────

/** 고정을 붙들어 두는 키. 순서 모드에서는 피커 칸의 uid(순서를 바꿔도 고정이 따라온다), 자동 모드는 자리 번호 키. */
export function slotKeysOf(sequence: readonly SequenceItem[]): string[] {
  return sequence.length > 0 ? sequence.map((item) => item.uid) : ['auto-0', 'auto-1', 'auto-2'];
}

/** 표시 중인 자리 키가 현재 입력의 자리 키와 다른가(= 보이는 행이 지나간 계획의 것인가). */
export function slotKeysStale(rendered: readonly string[], current: readonly string[]): boolean {
  if (rendered.length !== current.length) return true;
  return rendered.some((key, i) => key !== current[i]);
}

/** 서버로 보낼 고정 목록('자리 번호 → 시설'). 모르는 키는 걸러진다. */
export function buildPinList(pins: Record<string, string>, slotKeys: readonly string[]): { order: number; facilityId: string }[] {
  return Object.entries(pins)
    .map(([key, facilityId]) => ({ order: slotKeys.indexOf(key) + 1, facilityId }))
    .filter((p) => p.order > 0);
}

/** 같은 가게가 다른 자리에 고정돼 있으면 그 자리를 비운다 — 서버는 한 가게가 두 자리에 고정되면 두 자리를 모두 죽인다. */
export function pinsWithoutDuplicate(pins: Record<string, string>, key: string, facilityId: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(pins)) {
    if (k !== key && v === facilityId) continue;
    next[k] = v;
  }
  next[key] = facilityId;
  return next;
}

export function pinsWithout(pins: Record<string, string>, key: string): Record<string, string> {
  if (!(key in pins)) return pins;
  const next = { ...pins };
  delete next[key];
  return next;
}

/** 이 자리를 고정하거나 푼다. */
export function pinsToggled(pins: Record<string, string>, key: string, facilityId: string): Record<string, string> {
  return pins[key] === facilityId ? pinsWithout(pins, key) : pinsWithoutDuplicate(pins, key, facilityId);
}

/** 사용자가 짠 자리 번호(1부터)를 찾는다 — stop.order 는 채운 것만으로 다시 매긴 번호라 다를 수 있다. 결과가 없으면(구 API) 같다고 본다. */
export function requestedSlotIndex(stop: CourseStop, outcomes: readonly SlotOutcome[]): number {
  const hit = outcomes.find((o) => o.status === 'filled' && o.facilityId === stop.facility.id);
  return (hit ? hit.order : stop.order) - 1;
}

export type StopRowEntry =
  | { slotOrder: number; stop: CourseStop; outcome: null }
  | { slotOrder: number; stop: null; outcome: SlotOutcome };

/** 못 채운 자리를 요청한 순서 그대로 정류지 사이에 끼운 행 목록. */
export function buildRows(stops: readonly CourseStop[], outcomes: readonly SlotOutcome[]): StopRowEntry[] {
  const dropped = outcomes.filter((o) => o.status !== 'filled');
  return [
    ...stops.map((stop): StopRowEntry => ({ slotOrder: requestedSlotIndex(stop, outcomes) + 1, stop, outcome: null })),
    ...dropped.map((outcome): StopRowEntry => ({ slotOrder: outcome.order, stop: null, outcome })),
  ].sort((a, b) => a.slotOrder - b.slotOrder);
}

// ── 자리 사유 문구 키 ────────────────────────────────────────────────────────

const SLOT_REASON_KEY: Record<string, string> = {
  no_candidate_of_type: 'course.slotNoCandidate',
  closed_at_arrival: 'course.slotClosedAtArrival',
  late_night_unconfirmed: 'course.slotLateNight',
  over_time_budget: 'course.slotOverTimeBudget',
  pin_unavailable: 'course.slotPinUnavailable',
};

/** 그 자리의 사유 문구 키. 자동 모드(requestedType=null)의 '없어요' 는 종류를 말하지 않는 문장을 쓴다. */
export function slotReasonKey(outcome: SlotOutcome): string | undefined {
  if (outcome.status === 'no_candidate_of_type' && !outcome.requestedType) return 'course.slotNoCandidateAny';
  return SLOT_REASON_KEY[outcome.status];
}

// ── 순서 피커 ────────────────────────────────────────────────────────────────

let uidCounter = 0;
export function newSequenceItem(type: string, nowMs: number = Date.now()): SequenceItem {
  uidCounter += 1;
  return { uid: `${type}-${nowMs}-${uidCounter}`, type };
}

export function sequenceAdded(sequence: readonly SequenceItem[], item: SequenceItem): SequenceItem[] {
  return sequence.length >= MAX_SEQUENCE ? [...sequence] : [...sequence, item];
}

/** from 칸을 to 자리로 옮긴다(범위 밖이면 그대로). 끌어서 놓기와 앞·뒤 버튼이 같은 함수를 쓴다. */
export function sequenceMoved(sequence: readonly SequenceItem[], from: number, to: number): SequenceItem[] {
  if (from === to || from < 0 || to < 0 || from >= sequence.length || to >= sequence.length) return [...sequence];
  const next = [...sequence];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function sequenceTypesOf(sequence: readonly SequenceItem[]): string[] {
  return sequence.map((s) => s.type);
}

// ── 계획 정리·캐시 ───────────────────────────────────────────────────────────

/** 서버 응답을 안전한 모양으로 — 배열이 아니면 빈 배열. */
export function normalizePlan(raw: unknown): CoursePlan {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CoursePlan>;
  return {
    stops: Array.isArray(r.stops) ? r.stops : [],
    slotOutcomes: Array.isArray(r.slotOutcomes) ? r.slotOutcomes : [],
    planId: typeof r.planId === 'string' ? r.planId : '',
  };
}

/** 계획을 바꾸는 입력의 서명 — 캐시된 계획이 '지금의 입력' 에서 만든 것인지 대조한다. 좌표·세션 id 는 넣지 않는다(웹과 같은 이유). */
export function planSignature(
  context: unknown,
  sequenceTypes: readonly string[],
  types: readonly string[],
  pins: readonly { order: number; facilityId: string }[],
): string {
  return JSON.stringify({ context, sequence: sequenceTypes, types, pins });
}

export const COURSE_CACHE_KEY = 'nextspot_course_plan_v1';
export const COURSE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CourseCacheEntry {
  stops: CourseStop[];
  slotOutcomes: SlotOutcome[];
  renderedSlotKeys: string[];
  planId: string;
  savedAt: number;
  contextSignature: string;
  /** 이 계획을 만든 가정 시각 프리셋 id(웹 cached.preset) — 없으면 'now'. */
  preset?: string;
}

export function serializeCache(entry: CourseCacheEntry): string {
  return JSON.stringify(entry);
}

/** 캐시 읽기 — 손상·낡음·다른 조건이면 null(평소 로딩 경로). 빈 계획은 되살리지 않는다. */
export function parseCache(
  raw: string | null | undefined,
  expectedSignature: string,
  nowMs: number = Date.now(),
  expectedPreset: string = 'now',
): CourseCacheEntry | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<CourseCacheEntry>;
    if (!Array.isArray(c.stops) || c.stops.length === 0) return null;
    if (typeof c.savedAt !== 'number' || nowMs - c.savedAt > COURSE_CACHE_MAX_AGE_MS) return null;
    if (c.contextSignature !== expectedSignature) return null;
    // 다른 가정 시각의 계획은 안 보여준다(웹 page.tsx:431).
    if ((c.preset ?? 'now') !== expectedPreset) return null;
    return {
      stops: c.stops,
      slotOutcomes: Array.isArray(c.slotOutcomes) ? c.slotOutcomes : [],
      renderedSlotKeys: Array.isArray(c.renderedSlotKeys) ? c.renderedSlotKeys : [],
      planId: typeof c.planId === 'string' ? c.planId : '',
      savedAt: c.savedAt,
      contextSignature: c.contextSignature,
      preset: c.preset ?? 'now',
    };
  } catch {
    return null;
  }
}

// ── 공유 모드 복원 ───────────────────────────────────────────────────────────

export interface SharedFacilityRow {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
}

/**
 * 공유 링크의 정류지 + 시설 조회 결과 → 정류지. 이름·좌표는 조회 시점 최신, 오프셋·혼잡은 공유 시점 스냅샷이다.
 * 오프셋은 공유 뒤 경과 분만큼 깎고 0 으로 막는다. 못 찾은 시설은 빼고 번호를 다시 매긴다.
 */
export function rebuildSharedStops(
  parsed: readonly ParsedShareStop[],
  rows: readonly SharedFacilityRow[],
  elapsedMin: number,
): CourseStop[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return parsed
    .map((p): CourseStop | null => {
      const f = byId.get(p.id);
      if (!f) return null;
      return {
        order: 0,
        facility: { id: f.id, name: f.name, type: f.type, latitude: f.latitude, longitude: f.longitude },
        arrivalOffsetMin: Math.max(0, p.offsetMin - elapsedMin),
        predictedCongestion: p.congestion,
        spotScore: 0,
        reason: '',
      };
    })
    .filter((s): s is CourseStop => s !== null)
    .map((s, i) => ({ ...s, order: i + 1 }));
}

// ── 간트 ─────────────────────────────────────────────────────────────────────

export const DWELL_LAST_MIN = 45;

export interface GanttSegment {
  stop: CourseStop;
  startPct: number;
  widthPct: number;
}

/** 시간축(0..total)에 각 정류지를 도착~다음 도착 구간으로 놓는다. 마지막은 기본 체류시간, 막대는 최소 10분 폭. */
export function ganttLayout(stops: readonly CourseStop[]): { segments: GanttSegment[]; totalMin: number } {
  const raw = stops.map((s, i) => {
    const start = Math.max(0, s.arrivalOffsetMin);
    const rawEnd = i < stops.length - 1 ? stops[i + 1].arrivalOffsetMin : s.arrivalOffsetMin + DWELL_LAST_MIN;
    return { stop: s, start, end: Math.max(rawEnd, start + 10) };
  });
  const totalMin = Math.max(...raw.map((x) => x.end), 30);
  return {
    totalMin,
    segments: raw.map((x) => ({
      stop: x.stop,
      startPct: (x.start / totalMin) * 100,
      widthPct: ((x.end - x.start) / totalMin) * 100,
    })),
  };
}
