// 대기 보드 데이터 훅 — 웹 apps/web/app/waiting/page.tsx 의 조회 흐름을 옮겼다(가정 시각 프리셋·내부 지역·구역 줄 제외).
//
// 같은 것: 익명 세션 먼저 확인 → 4유형을 **하나씩 차례로**(서버가 동시 요청에 503 을 낸다) 45초 제한으로 묻고, 도착하는 섹터부터
// 그린다 → 실패한 유형만 2초 뒤 한 번 더 → 전부 실패했을 때만 오류 화면. 503 은 0.5초 뒤, 그 밖의 전멸은 2.5초 뒤 자동 1회.
// 캐시가 이미 그려져 있으면 이후 조회는 조용히 돌고 실패해도 화면을 갈아치우지 않는다(스테일-우선).
// 세션이 나중에 생기면(SIGNED_IN) 실패 화면을 스스로 다시 채운다(웹 I22).
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureAnonymousSession } from '~/lib/core/anonymousSession';
import { isServiceUnavailable, loadSharedCongestionEstimates, recommendByType } from '~/lib/core/apiClient';
import { createPublicClient } from '~/lib/core/supabase';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { REGION } from '@/lib/region';
import { arrivalHourOf, boardWaitBaseMs, estimateWait, type WaitEstimate } from '@/lib/waitEstimate';

import { sessionAreaDemandCurve } from './api';
import { usableCurve, type AreaDemandCurve } from './areaCurve';
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

/** 마지막 성공에서 이만큼 지나 화면에 돌아오면 조용히 새로고침한다. */
const REFRESH_AFTER_MS = 5 * 60 * 1000;
const USER_LOCATION = { lat: REGION.center.lat, lng: REGION.center.lng };

interface Run {
  id: number;
  controller: AbortController;
}

type Settled = PromiseSettledResult<Awaited<ReturnType<typeof recommendByType>>>;

export interface WaitingBoard {
  /** 다 찬(캐시 포함) 보드. */
  sectors: Sector[] | null;
  /** 로딩 중에 먼저 도착한 섹터(다 차면 null). */
  partial: Sector[] | null;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  estimateLevels: Record<string, number>;
  waitOf: (row: BoardRow) => WaitEstimate;
}

export function useWaitingBoard(): WaitingBoard {
  const { locale } = useI18n();
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  // 캐시는 첫 렌더에서 한 번 읽는다(화면이 빈 로더를 거치지 않게).
  const [initial] = useState(() => loadBoardCache());
  const [sectors, setSectors] = useState<Sector[] | null>(initial?.sectors ?? null);
  const [partial, setPartial] = useState<Sector[] | null>(null);
  const [loading, setLoading] = useState(initial === null);
  const [failed, setFailed] = useState(false);

  const hasResultsRef = useRef(initial !== null);
  const failedRef = useRef(false);
  const retriedRef = useRef(false);
  const unavailableRetriedRef = useRef(false);
  const lastOkRef = useRef<number>(initial?.savedAt ?? 0);
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
      const stale = () => signal.aborted || runRef.current !== thisRun;
      if (stale()) return;

      setPartial(null);
      const silent = hasResultsRef.current;
      setLoading(!silent);
      setFailed(false);
      failedRef.current = false;
      const showFailed = () => {
        setFailed(true);
        failedRef.current = true;
        setSectors(null);
        setPartial(null);
        setLoading(false);
        hasResultsRef.current = false;
      };
      const keepCached = () => {
        setPartial(null);
        setLoading(false);
      };

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
          const value = await recommendByType(type, USER_LOCATION, [], PER_TYPE_LIMIT, undefined, undefined, signal, 45000, null, BOARD_FILLS_WEAKER_TIERS);
          results.push({ status: 'fulfilled', value });
        } catch (reason) {
          results.push({ status: 'rejected', reason });
        }
        // 도착하는 대로 그린다. 앞 유형이 하나라도 실패했으면 마지막 커밋까지 기다린다(끼어들지 않게).
        if (!silent && !stale() && results.every((r) => r.status === 'fulfilled')) {
          const shown = results
            .map((r, i) => (r.status === 'fulfilled' ? buildSector(BOARD_TYPES[i], r.value, localeRef.current) : null))
            .filter((s): s is Sector => s !== null);
          if (shown.length > 0) setPartial(shown);
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
            const value = await recommendByType(BOARD_TYPES[i], USER_LOCATION, [], PER_TYPE_LIMIT, undefined, undefined, signal, 45000, null, BOARD_FILLS_WEAKER_TIERS);
            results[i] = { status: 'fulfilled', value };
          } catch {
            /* 실패 유지 — 나머지 섹터로 보드는 뜬다 */
          }
        }
      }

      if (stale()) return;
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
      setPartial(null);
      setLoading(false);
      hasResultsRef.current = true;
      lastOkRef.current = Date.now();
      saveBoardCache(next);
    },
    [later],
  );

  useEffect(() => {
    void fetchBoard();
    const timers = timersRef.current;
    return () => {
      runRef.current?.controller.abort();
      timers.forEach(clearTimeout);
    };
  }, [fetchBoard]);

  // 화면으로 돌아왔을 때 마지막 성공이 오래됐으면 조용히 새로고침(스테일-우선 — 이미 그려진 보드는 그대로).
  useFocusEffect(
    useCallback(() => {
      if (hasResultsRef.current && Date.now() - lastOkRef.current > REFRESH_AFTER_MS) void fetchBoard();
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

  const retry = useCallback(() => {
    ensureAnonymousSession.resetBackoff();
    retriedRef.current = false;
    unavailableRetriedRef.current = false;
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

  const [curve, setCurve] = useState<AreaDemandCurve | null>(null);
  useEffect(() => {
    let alive = true;
    void sessionAreaDemandCurve()
      .then((c) => {
        if (alive) setCurve(usableCurve(c));
      })
      .catch(() => {
        /* 곡선 없음 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 'now' 기준 시각은 상태로 고정한다 — 렌더 중 new Date() 는 숫자를 흔든다. 30초마다 갱신(도착 시각은 분까지 말한다),
  // 대기·순서·한산 시각은 5분 박자(boardWaitBaseMs)로만 다시 센다.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  const waitBaseMs = boardWaitBaseMs(nowMs);

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
        areaCurve: curve,
      }),
      arrivalHour: arrivalHourOf(new Date(nowMs), row.expectedTravel),
    }),
    [estimateLevels, curve, waitBaseMs, nowMs],
  );

  return { sectors, partial, loading, failed, retry, estimateLevels, waitOf };
}
