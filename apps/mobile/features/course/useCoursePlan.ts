// 코스 계획 상태 — 웹 course/page.tsx 의 fetchCourse·디바운스·스테일-우선 캐시·고정(pin)·재계획 토스트를 훅 하나로 옮겼다(기준 커밋 0d145a1).
// 가정 시각 프리셋(D11 ①)은 서명 밖 별도 필드로 대조한다(웹과 같다). 빠진 것: 내부 검증 지역 분기, 공유 모드(useSharedCourse 가 따로).
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAssumedPreset } from '~/components/AssumedTimeSelect';
import { toast } from '~/components/ui';
import { isAuthError } from '~/lib/core/apiClient';
import { assumedAtIsoForPreset, getStoredAssumedPreset } from '~/lib/core/assumedTime';
import { createPublicClient } from '~/lib/core/supabase';
import { useT } from '~/lib/i18n/I18nProvider';
import { describeReplan } from '@/lib/coursePlanDiff';

import { fetchCoursePlan, isNoSessionError } from './api';
import {
  COURSE_CACHE_KEY,
  buildPinList,
  newSequenceItem,
  parseCache,
  pinsToggled,
  pinsWithout,
  pinsWithoutDuplicate,
  planSignature,
  sequenceAdded,
  sequenceMoved,
  sequenceTypesOf,
  serializeCache,
  slotKeysOf,
  slotKeysStale,
} from './model';
import { decideCourseFocusRefresh, shouldRecoverOnAuthEvent } from './refreshPolicy';
import type { CourseCoords } from './useCourseLocation';
import { loadTravelContext, saveTravelContext, widenTimeBudget } from './travelContext';
import type { CourseStop, SequenceItem, SlotOutcome } from './types';

function readCache(): string | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage?.getItem(COURSE_CACHE_KEY) ?? null;
  } catch {
    return null;
  }
}
function writeCache(value: string): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(COURSE_CACHE_KEY, value);
  } catch {
    /* 저장소 차단 — 캐시 없이도 동작은 같다 */
  }
}

export interface CoursePlanState {
  stops: CourseStop[];
  slotOutcomes: SlotOutcome[];
  loading: boolean;
  /** 첫 응답(또는 캐시)을 한 번이라도 받았는가 — 전면 스켈레톤은 첫 로드에만 쓴다. */
  hasLoadedOnce: boolean;
  error: string | null;
  needsAuth: boolean;
  sequence: SequenceItem[];
  selectedTypes: string[];
  pins: Record<string, string>;
  renderedSlotKeys: string[];
  slotsStale: boolean;
  retry(): void;
  widenTimeAndReplan(): void;
  toggleType(id: string): void;
  addType(type: string): void;
  removeItem(uid: string): void;
  reorder(next: SequenceItem[]): void;
  moveItem(from: number, to: number): void;
  resetOrder(): void;
  togglePin(slotIdx: number, facilityId: string): void;
  swapTo(slotIdx: number, facilityId: string): void;
  unpinSlot(slotIdx: number): void;
  unpinAll(): void;
  /** 탭을 떠날 때 짜기 입력(순서·종류·고정)을 비운다(D16 a). 이미 비었으면 아무 상태도 바꾸지 않는다 — 안 그러면 탭을 옮길 때마다 재조회가 나간다. */
  resetInputs(): void;
}

/** 세션이 아직 없을 때 로그인 안내를 내기 전에 기다리는 시간(웹 page.tsx:323 — 익명 세션이 늦게 올 수 있다). */
export const NO_SESSION_GRACE_MS = 2500;

export function useCoursePlan(coords: CourseCoords, enabled: boolean): CoursePlanState {
  const t = useT();
  const assumedPreset = useAssumedPreset();
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [sequence, setSequence] = useState<SequenceItem[]>([]);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [stops, setStops] = useState<CourseStop[]>([]);
  const [slotOutcomes, setSlotOutcomes] = useState<SlotOutcome[]>([]);
  // 이 응답을 만든 요청의 자리 키 — 화면의 행은 이것으로 자리를 찾는다(입력이 먼저 바뀌어도 옛 행이 새 키를 들지 않게).
  const [renderedSlotKeys, setRenderedSlotKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const fetchGenRef = useRef(0);
  const dispatchedRef = useRef(false);
  const prevPlanRef = useRef<{ planId: string; ids: string[] } | null>(null);
  const userReplanRef = useRef(false);
  const hasRenderedResultsRef = useRef(false);
  const renderedSignatureRef = useRef<string | null>(null);
  // 포커스 재계획 판정용 — 마지막 요청에 쓴 여행 조건 · 진행 중 여부 · 로그인 필요 상태.
  const requestedContextKeyRef = useRef<string | null>(null);
  const renderedPresetRef = useRef<string | null>(null);
  // 세션 없음 유예를 이미 썼는가 — 한 번 기다린 뒤에도 없으면 안내를 그린다. 성공하면 다시 켠다.
  const graceUsedRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 코스 탭이 보이는가 — 가려진 동안에는 입력·가정 시각이 바뀌어도 백그라운드 재조회를 보내지 않는다(돌아올 때 포커스 재조회 한 번이 맡는다).
  const focusedRef = useRef(true);
  const inFlightRef = useRef(false);
  const needsAuthRef = useRef(false);
  // 요청이 날아가는 동안 SIGNED_IN 이 왔는가 — 그 요청이 옛 토큰으로 401 을 받으면 needsAuth 에 멈추지 않고 한 번 다시 짠다.
  const signedInDuringFlightRef = useRef(false);
  const markUserReplan = () => {
    userReplanRef.current = true;
  };

  const slotKeys = useMemo(() => slotKeysOf(sequence), [sequence]);
  const slotsStale = useMemo(() => slotKeysStale(renderedSlotKeys, slotKeys), [renderedSlotKeys, slotKeys]);

  // 마운트 시 캐시 하이드레이션 — 입력이 모두 비어 있던 평소 조건에서 만든 계획만 되살린다.
  useEffect(() => {
    if (!enabled) return;
    const cached = parseCache(readCache(), planSignature(loadTravelContext(), [], [], []), Date.now(), getStoredAssumedPreset());
    if (!cached) return;
    hasRenderedResultsRef.current = true;
    renderedPresetRef.current = cached.preset ?? 'now';
    renderedSignatureRef.current = cached.contextSignature;
    prevPlanRef.current = { planId: cached.planId, ids: cached.stops.map((s) => s.facility.id) };
    setStops(cached.stops);
    setSlotOutcomes(cached.slotOutcomes);
    setRenderedSlotKeys(cached.renderedSlotKeys);
    setLoading(false);
    setHasLoadedOnce(true);
    // 마운트 1회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 재조회 결과가 실제로 무엇이 달라졌는지 정직하게 말한다(planId 로 판정 — coursePlanDiff). 사용자가 한 일이 아니면 침묵. */
  const announceReplan = useCallback(
    (planId: string, nextStops: CourseStop[]) => {
      const next = { planId, ids: nextStops.map((s) => s.facility.id) };
      const prev = prevPlanRef.current;
      prevPlanRef.current = next;
      if (!userReplanRef.current) return;
      userReplanRef.current = false;
      const message = describeReplan(prev, next);
      if (message) toast(t(message.key, message.vars), { id: 'course-replan' });
    },
    [t],
  );

  const fetchCourse = useCallback(async () => {
    if (!enabled) return;
    dispatchedRef.current = true;
    const gen = ++fetchGenRef.current;
    const pinList = buildPinList(pins, slotKeys);
    const context = loadTravelContext();
    requestedContextKeyRef.current = JSON.stringify(context);
    inFlightRef.current = true;
    signedInDuringFlightRef.current = false;
    const types = sequence.length > 0 ? [] : selectedTypes;
    const signature = planSignature(context, sequenceTypesOf(sequence), types, pinList);
    // 화면에 같은 조건의 계획이 이미 있으면 조용한 새로고침 — 로더 없이, 실패해도 보이는 계획을 유지한다(스테일-우선).
    const silentRefresh =
      hasRenderedResultsRef.current && renderedPresetRef.current === assumedPreset && renderedSignatureRef.current === signature;
    const assumedAt = assumedAtIsoForPreset(assumedPreset);
    let deferred = false;
    if (!silentRefresh) setLoading(true);
    setError(null);
    setNeedsAuth(false);
    needsAuthRef.current = false;
    try {
      const plan = await fetchCoursePlan({
        userLat: coords.lat,
        userLng: coords.lng,
        context,
        ...(sequence.length > 0 ? { sequence: sequenceTypesOf(sequence) } : selectedTypes.length > 0 ? { types: selectedTypes } : {}),
        ...(pinList.length > 0 ? { pins: pinList } : {}),
        ...(assumedAt ? { assumedAt } : {}),
      });
      if (gen !== fetchGenRef.current) return; // 구세대 응답 폐기
      graceUsedRef.current = false;
      announceReplan(plan.planId, plan.stops);
      setStops(plan.stops);
      setSlotOutcomes(plan.slotOutcomes);
      setRenderedSlotKeys(slotKeys);
      hasRenderedResultsRef.current = plan.stops.length > 0;
      renderedSignatureRef.current = signature;
      renderedPresetRef.current = assumedPreset;
      // 빈 계획도 저장한다 — 낡은 코스가 다음 방문에 되살아나지 않게(하이드레이션이 0개를 거른다).
      writeCache(
        serializeCache({
          stops: plan.stops,
          slotOutcomes: plan.slotOutcomes,
          renderedSlotKeys: slotKeys,
          planId: plan.planId,
          savedAt: Date.now(),
          contextSignature: signature,
          preset: assumedPreset,
        }),
      );
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      if (isAuthError(err) && signedInDuringFlightRef.current) {
        // 로그인이 막 끝났는데 이 요청은 로그인 전 토큰이었다 — 안내 화면에 서지 말고 새 세션으로 한 번 더(플래그는 다음 요청 시작에 꺼진다).
        signedInDuringFlightRef.current = false;
        setTimeout(() => void fetchCourseRef.current(), 0);
        return;
      }
      if (isNoSessionError(err) && !graceUsedRef.current) {
        // 세션이 없다 — 웹처럼 2.5초 기다린 뒤 한 번 더 본다(그 사이 익명 세션이 생기면 그대로 계획이 나온다). 그동안은 로더를 유지한다.
        graceUsedRef.current = true;
        deferred = true;
        if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
        graceTimerRef.current = setTimeout(() => {
          graceTimerRef.current = null;
          if (gen === fetchGenRef.current) void fetchCourseRef.current();
        }, NO_SESSION_GRACE_MS);
        return;
      }
      if (silentRefresh) return;
      hasRenderedResultsRef.current = false;
      setStops([]);
      setSlotOutcomes([]);
      // 401 은 서버 장애가 아니다 — 성공할 수 없는 '다시 시도' 대신 정직한 안내.
      if (isAuthError(err)) {
        needsAuthRef.current = true;
        setNeedsAuth(true);
      } else setError(t('course.fetchError'));
    } finally {
      if (gen === fetchGenRef.current && !deferred) {
        inFlightRef.current = false;
        setLoading(false);
        setHasLoadedOnce(true);
      }
    }
  }, [enabled, coords.lat, coords.lng, selectedTypes, sequence, pins, slotKeys, announceReplan, assumedPreset, t]);

  const fetchCourseRef = useRef(fetchCourse);
  fetchCourseRef.current = fetchCourse;

  // 화면이 닫힐 때 유예 타이머를 치운다.
  useEffect(
    () => () => {
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    },
    [],
  );

  // 로그인이 필요해 멈췄던 화면 — 로그인(SIGNED_IN)되면 스스로 다시 짠다(대기 보드의 자가 회복과 같다).
  useEffect(() => {
    if (!enabled) return;
    const { data } = createPublicClient().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session && inFlightRef.current) signedInDuringFlightRef.current = true;
      if (!shouldRecoverOnAuthEvent(event, !!session, needsAuthRef.current)) return;
      // 콜백 안에서 바로 요청하지 않는다(supabase-js 인증 잠금 안이라 세션 읽기가 막힐 수 있다).
      setTimeout(() => void fetchCourseRef.current(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [enabled]);

  // 탭에 돌아올 때마다 — 웹이 탭 이동마다 새로 마운트되며 계획을 다시 받는 것과 같다(D16 b). 같은 조건이면 로더 없이 조용히.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (!enabled) return () => {
        focusedRef.current = false;
      };
      const decision = decideCourseFocusRefresh({
        contextKey: JSON.stringify(loadTravelContext()),
        requestedContextKey: requestedContextKeyRef.current,
        inFlight: inFlightRef.current,
      });
      if (decision === 'replan') void fetchCourseRef.current();
      return () => {
        focusedRef.current = false;
      };
    }, [enabled]),
  );

  // 재조회 디바운스 — 칩 연타·순서 이동마다 즉시 보내지 않고 마지막 변경 500ms 뒤 한 번. 첫 요청은 지연 없이.
  useEffect(() => {
    // 가려진 탭은 보내지 않는다 — 대기 탭에서 가정 시각을 바꾸거나 떠날 때 입력을 비워도 POST 가 나가지 않는다(웹은 언마운트라 없다).
    if (!focusedRef.current && dispatchedRef.current) return undefined;
    const timer = setTimeout(() => {
      void fetchCourse();
    }, dispatchedRef.current ? 500 : 0);
    return () => clearTimeout(timer);
  }, [fetchCourse]);

  const widenTimeAndReplan = useCallback(() => {
    const next = widenTimeBudget(loadTravelContext());
    if (!next) return;
    saveTravelContext(next);
    void fetchCourse();
  }, [fetchCourse]);

  return {
    stops,
    slotOutcomes,
    loading,
    hasLoadedOnce,
    error,
    needsAuth,
    sequence,
    selectedTypes,
    pins,
    renderedSlotKeys,
    slotsStale,
    retry: () => {
      void fetchCourse();
    },
    widenTimeAndReplan,
    toggleType: (id) => {
      markUserReplan();
      setSelectedTypes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    },
    addType: (type) => {
      markUserReplan();
      setSequence((prev) => sequenceAdded(prev, newSequenceItem(type)));
    },
    removeItem: (uid) => {
      markUserReplan();
      setSequence((prev) => prev.filter((s) => s.uid !== uid));
      setPins((prev) => pinsWithout(prev, uid));
    },
    reorder: (next) => {
      markUserReplan();
      setSequence(next);
    },
    moveItem: (from, to) => {
      markUserReplan();
      setSequence((prev) => sequenceMoved(prev, from, to));
    },
    resetOrder: () => {
      markUserReplan();
      setSequence([]);
      setPins({});
    },
    togglePin: (slotIdx, facilityId) => {
      const key = renderedSlotKeys[slotIdx];
      if (!key) return;
      markUserReplan();
      setPins((prev) => pinsToggled(prev, key, facilityId));
    },
    // 대안으로 갈아끼우기 = 그 자리에 고정을 꽂고 다시 짜는 것 — 카드만 바꿔치면 뒤 정류지의 도착 시각이 낡은 값이 된다.
    swapTo: (slotIdx, facilityId) => {
      const key = renderedSlotKeys[slotIdx];
      if (!key) return;
      markUserReplan();
      setPins((prev) => pinsWithoutDuplicate(prev, key, facilityId));
    },
    unpinSlot: (slotIdx) => {
      const key = renderedSlotKeys[slotIdx];
      if (!key) return;
      markUserReplan();
      setPins((prev) => pinsWithout(prev, key));
    },
    unpinAll: () => {
      markUserReplan();
      setPins({});
    },
    // 비었으면 같은 참조를 돌려줘 상태가 안 바뀐다 → fetchCourse 의 deps 도 그대로 → 탭 전환만으로 POST 가 나가지 않는다.
    resetInputs: () => {
      userReplanRef.current = false; // 떠나기 직전에 눌렀다면 '코스가 바뀌었어요' 토스트가 다른 탭에서 뜨지 않게
      setSelectedTypes((prev) => (prev.length > 0 ? [] : prev));
      setSequence((prev) => (prev.length > 0 ? [] : prev));
      setPins((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    },
  };
}
