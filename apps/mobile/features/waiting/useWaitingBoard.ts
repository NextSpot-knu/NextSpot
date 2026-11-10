// 대기 보드 데이터 훅 — 웹 apps/web/app/waiting/page.tsx 의 조회 흐름을 옮겼다(내부 지역·구역 줄 제외).
//
// 같은 것: 익명 세션 먼저 확인 → 4유형을 **하나씩 차례로**(서버가 동시 요청에 503 을 낸다) 45초 제한으로 묻고, 도착하는 섹터부터
// 그린다 → 실패한 유형만 2초 뒤 한 번 더 → 전부 실패했을 때만 오류 화면. 503 은 0.5초 뒤, 그 밖의 전멸은 2.5초 뒤 자동 1회.
// 캐시가 이미 그려져 있으면 이후 조회는 조용히 돌고 실패해도 화면을 갈아치우지 않는다(스테일-우선).
// 세션이 나중에 생기면(SIGNED_IN) 실패 화면을 스스로 다시 채운다(웹 I22).
// 가정 시각 프리셋(D11 ①, G5a-05): 고른 시각을 by-type `assumed_at`·대기 기준 시각·권역 곡선·캐시에 쓴다. 바꾸면 로더부터 다시.
// 화면에 돌아올 때(D16 ⓑ, G5a-24): 웹은 라우트가 다시 마운트되며 캐시를 먼저 그린 뒤 로더 없이 다시 받는다 — 앱은 포커스마다 같게.
// '다시 시도'(D16 ⓓ, G5a-23): 웹처럼 백오프만 풀고 다시 받는다. 자동 재시도 표식은 되돌리지 않는다.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAssumedPreset } from '~/components/AssumedTimeSelect';
import { ensureAnonymousSession } from '~/lib/core/anonymousSession';
import { isServiceUnavailable, loadSharedCongestionEstimates, recommendByType } from '~/lib/core/apiClient';
import { assumedAtIsoForPreset } from '~/lib/core/assumedTime';
import { createPublicClient } from '~/lib/core/supabase';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { REGION } from '@/lib/region';
import { arrivalHourOf, boardWaitBaseMs, estimateWait, type WaitEstimate } from '@/lib/waitEstimate';

import { fetchAreaDemandCurve, sessionAreaDemandCurve } from './api';
import { curveForBase, mergeAreaCurve, usableCurve, type AreaDemandCurve } from './areaCurve';
import {
  BOARD_FILLS_WEAKER_TIERS,
  BOARD_TYPES,
  PER_TYPE_LIMIT,
  buildSector,
  estimateLevelOf,
  type BoardRow,
  type Sector,
} from './boardData';
import { loadBoardCache, saveBoardCache } from './boardCache';

const USER_LOCATION = { lat: REGION.center.lat, lng: REGION.center.lng };

interface Run {
  id: number;
  controller: AbortController;
}

type Settled = PromiseSettledResult<Awaited<ReturnType<typeof recommendByType>>>;

export interface WaitingBoard {
  /** 다 찬(캐시 포함) 보드. */
  sectors: Sector[] | null;
  /** 로딩 중에 먼저 도착한 섹터(다 차면 null). 지금 프리셋의 것만 — 옛 프리셋 조각이 새 배지 아래 보이지 않는다. */
  partial: Sector[] | null;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  estimateLevels: Record<string, number>;
  waitOf: (row: BoardRow) => WaitEstimate;
}

export function useWaitingBoard(): WaitingBoard {
  const { locale } = useI18n();
  const preset = useAssumedPreset();
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  // 조회 도중 프리셋이 바뀌면 옛 조회는 남은 유형을 묻지 않고 결과도 버린다.
  const presetRef = useRef(preset);
  useEffect(() => {
    presetRef.current = preset;
  }, [preset]);

  // 캐시는 첫 렌더에서 한 번 읽는다(화면이 빈 로더를 거치지 않게). 다른 가정 시각의 캐시는 안 쓴다.
  const [initial] = useState(() => loadBoardCache(preset));
  const [sectors, setSectors] = useState<Sector[] | null>(initial?.sectors ?? null);
  const [partialBoard, setPartialBoard] = useState<{ preset: string; sectors: Sector[] } | null>(null);
  const [loading, setLoading] = useState(initial === null);
  const [failed, setFailed] = useState(false);

  const hasResultsRef = useRef(initial !== null);
  const renderedPresetRef = useRef<string | null>(initial !== null ? preset : null);
  const failedRef = useRef(false);
  const loadingRef = useRef(initial === null);
  const retriedRef = useRef(false);
  const unavailableRetriedRef = useRef(false);
  const runRef = useRef<Run | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);

  const fetchBoard = useCallback(
    async (continued?: Run) => {
      let run = continued;
      if (!run) {
        runRef.current?.controller.abort();
        run = { id: (runRef.current?.id ?? 0) + 1, controller: new AbortController() };
        runRef.current = run;
      }
      const thisRun = run;
      const signal = thisRun.controller.signal;
      const stale = () => signal.aborted || runRef.current !== thisRun || presetRef.current !== preset;
      if (stale()) return;

      setPartialBoard(null);
      // 화면에 같은 가정 시각의 결과가 이미 있으면 조용한 새로고침(로더 생략) — 스테일-우선.
      const silent = hasResultsRef.current && renderedPresetRef.current === preset;
      setLoading(!silent);
      loadingRef.current = !silent;
      setFailed(false);
      failedRef.current = false;
      const showFailed = () => {
        setFailed(true);
        failedRef.current = true;
        setSectors(null);
        setPartialBoard(null);
        setLoading(false);
        loadingRef.current = false;
        hasResultsRef.current = false;
        renderedPresetRef.current = null;
      };
      const keepCached = () => {
        setPartialBoard(null);
        setLoading(false);
        loadingRef.current = false;
      };
      const assumedAt = () => assumedAtIsoForPreset(preset);

      // 세션부터. 없으면 보드 요청을 보내지 않고 다음 가입 창 뒤에 한 번만 다시 묻는다(로더 유지).
      const session = await ensureAnonymousSession();
      if (stale()) return;
      if (!session) {
        if (!retriedRef.current) {
          retriedRef.current = true;
          later(() => void fetchBoard(thisRun), Math.min(5000, Math.max(2500, ensureAnonymousSession.retryInMs())));
          return;
        }
        if (silent) return keepCached();
        return showFailed();
      }

      const results: Settled[] = [];
      for (const type of BOARD_TYPES) {
        if (stale()) return;
        try {
          const value = await recommendByType(type, USER_LOCATION, [], PER_TYPE_LIMIT, undefined, undefined, signal, 45000, assumedAt(), BOARD_FILLS_WEAKER_TIERS);
          results.push({ status: 'fulfilled', value });
        } catch (reason) {
          results.push({ status: 'rejected', reason });
        }
        // 도착하는 대로 그린다. 앞 유형이 하나라도 실패했으면 마지막 커밋까지 기다린다(끼어들지 않게).
        if (!silent && !stale() && results.every((r) => r.status === 'fulfilled')) {
          const shown = results
            .map((r, i) => (r.status === 'fulfilled' ? buildSector(BOARD_TYPES[i], r.value, localeRef.current) : null))
            .filter((s): s is Sector => s !== null);
          if (shown.length > 0) setPartialBoard({ preset, sectors: shown });
        }
      }

      // 두 번째 패스: 실패한 유형만, 2초 뒤, 여전히 하나씩.
      if (results.some((r) => r.status === 'rejected')) {
        if (stale()) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        for (let i = 0; i < BOARD_TYPES.length; i++) {
          if (results[i].status !== 'rejected') continue;
          if (stale()) return;
          try {
            const value = await recommendByType(BOARD_TYPES[i], USER_LOCATION, [], PER_TYPE_LIMIT, undefined, undefined, signal, 45000, assumedAt(), BOARD_FILLS_WEAKER_TIERS);
            results[i] = { status: 'fulfilled', value };
          } catch {
            /* 실패 유지 — 나머지 섹터로 보드는 뜬다 */
          }
        }
      }

      if (stale()) return; // 다른 프리셋으로 바뀌었다 — 이 결과는 그리지도 캐시하지도 않는다
      const next: Sector[] = [];
      let anyOk = false;
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return;
        anyOk = true;
        const sector = buildSector(BOARD_TYPES[i], r.value, localeRef.current);
        if (sector) next.push(sector);
      });

      if (!anyOk) {
        const allUnavailable = results.every((r) => r.status === 'rejected' && isServiceUnavailable(r.reason));
        if (allUnavailable && !unavailableRetriedRef.current) {
          unavailableRetriedRef.current = true;
          later(() => void fetchBoard(thisRun), 500);
          return;
        }
        // 첫 진입 직행 시 세션 부트스트랩이 끝나기 전 401 로 전멸할 수 있다 — 유예 후 자동 1회.
        if (!allUnavailable && !retriedRef.current) {
          retriedRef.current = true;
          later(() => void fetchBoard(thisRun), 2500);
          return;
        }
        if (silent) return keepCached();
        return showFailed();
      }

      setSectors(next);
      setPartialBoard(null);
      setLoading(false);
      loadingRef.current = false;
      hasResultsRef.current = true;
      renderedPresetRef.current = preset;
      saveBoardCache(next, preset);
    },
    [later, preset],
  );

  // 프리셋이 바뀌면 fetchBoard 가 바뀌어 이 효과가 이전 조회를 끊고(정리) 새 가정 시각으로 다시 시작한다.
  useEffect(() => {
    void fetchBoard();
    const timers = timersRef.current;
    return () => {
      runRef.current?.controller.abort();
      timers.forEach(clearTimeout);
    };
  }, [fetchBoard]);

  // 화면으로 돌아올 때마다 조용히 다시 받는다(D16 ⓑ — 웹은 방문마다 마운트되며 캐시를 먼저 그린 뒤 로더 없이 다시 받는다.
  // 서버에 사용자별 180초 캐시가 있어 탭을 오가도 노출 행이 곧바로 쌓이지 않는다). 첫 포커스는 건너뛴다 — 마운트 효과가 이미 보냈다.
  // 결과가 없는 채 실패 화면이면 웹처럼 로더부터 다시 받고, 이미 받는 중이면 건드리지 않는다.
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      if (hasResultsRef.current || (failedRef.current && !loadingRef.current)) void fetchBoard();
    }, [fetchBoard]),
  );

  // 자가 회복: 익명 세션이 나중에 생기면 실패 화면을 스스로 다시 채운다.
  useEffect(() => {
    const { data } = createPublicClient().auth.onAuthStateChange((event, session) => {
      if (event !== 'SIGNED_IN' || !session || !failedRef.current) return;
      retriedRef.current = false;
      later(() => void fetchBoard(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [fetchBoard, later]);

  // 웹 '다시 시도' = 백오프를 풀고 다시 받는다(G5a-23). 자동 재시도 표식은 되돌리지 않는다.
  const retry = useCallback(() => {
    ensureAnonymousSession.resetBackoff();
    void fetchBoard();
  }, [fetchBoard]);

  // ── 보조 피드: 시설별 혼잡 추정 · 권역 수요 곡선. 둘 다 실패해도 내장 시간대 곡선으로 계속한다. ──
  const [estimateLevels, setEstimateLevels] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const feed = await loadSharedCongestionEstimates();
        if (!alive || !feed?.available) return;
        const next: Record<string, number> = {};
        for (const [id, raw] of Object.entries(feed.estimates ?? {})) {
          const level = estimateLevelOf(raw);
          if (level !== null) next[id] = level;
        }
        setEstimateLevels(next);
      } catch {
        /* 추정 피드 없음 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 가정 시각이 가리키는 절대 시각 — 대기·한산 시각 계산의 기준점. 'now' 면 null.
  const assumedIso = assumedAtIsoForPreset(preset);
  const baseAtMs = assumedIso ? new Date(assumedIso).getTime() : null;
  const baseKey = baseAtMs === null ? 'now' : String(baseAtMs);

  // 권역 수요 곡선은 기준 시각별로 따로 둔다 — 프리셋을 바꿔도 오늘 곡선이 토요일 카드에 남지 않는다. 받은 기준으로 돌아가면 다시 받지 않는다.
  const [areaCurves, setAreaCurves] = useState<Record<string, AreaDemandCurve>>({});
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const curve =
          baseAtMs !== null
            ? await fetchAreaDemandCurve(controller.signal, Date.now(), new Date(baseAtMs))
            : await sessionAreaDemandCurve();
        if (alive) setAreaCurves((prev) => mergeAreaCurve(prev, baseKey, usableCurve(curve) ?? {}));
      } catch {
        /* 곡선 없음 */
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [baseAtMs, baseKey]);
  const areaCurve = curveForBase(areaCurves, baseKey);

  // 'now' 기준 시각은 상태로 고정한다 — 렌더 중 new Date() 는 숫자를 흔든다. 30초마다 갱신(도착 시각은 분까지 말한다),
  // 대기·순서·한산 시각은 5분 박자(boardWaitBaseMs)로만 다시 센다. 가정 시각이면 그 시각이 기준이다.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  const effectiveBaseMs = baseAtMs ?? nowMs;
  const waitBaseMs = baseAtMs ?? boardWaitBaseMs(nowMs);

  const waitOf = useCallback(
    (row: BoardRow): WaitEstimate => ({
      ...estimateWait({
        facilityType: row.type,
        serverWaitMinutes: row.expectedWait,
        rankingWaitMinutes: row.rankingWait,
        baselineWaitMinutes: row.baselineWait,
        capacity: row.capacity,
        measuredLevel: row.congestionLevel,
        estimateLevel: estimateLevels[row.facilityId] ?? null,
        areaDemandLevel: row.areaDemandLevel,
        tourismRelativeIndex: row.areaDemandTourismEvidence?.relativeIndex ?? null,
        tourismDistanceM: row.areaDemandTourismEvidence?.distanceM ?? null,
        travelMinutes: row.expectedTravel,
        baseAt: new Date(waitBaseMs),
        areaCurve,
      }),
      arrivalHour: arrivalHourOf(new Date(effectiveBaseMs), row.expectedTravel),
    }),
    [estimateLevels, areaCurve, waitBaseMs, effectiveBaseMs],
  );

  const partial = partialBoard?.preset === preset ? partialBoard.sectors : null;
  return { sectors, partial, loading, failed, retry, estimateLevels, waitOf };
}
