'use client';

// 서비스 지역 컨텍스트 — 화면이 `useRegion().pack` 으로 지금 지역의 중심·경계·프리셋·기능 표를 읽는다.
//
// 판정은 전부 lib/regionState.ts decideRegion 이 한다(순수 함수 — 테스트가 잠근다). 여기는 그 결정을 실행만 한다:
//   · GET /api/v1/internal/regions 는 내부 계정(developer)일 때만 부른다 — (1) 내부 지역을 골라 둔 기록을 확인할 때,
//     (2) 지역 스위처가 목록을 청할 때, (3) 내부 지역을 보는 동안 5분마다·탭 복귀 때. 관광객·게스트는 0번이다.
//   · 지역이 정해지면 lib/regionRuntime 에 적는다 — api-client 가 그 값으로 지역 헤더를 싣고(경주는 없음),
//     analytics·usageEvents 는 내부 지역에서 조용해진다. useLayoutEffect 로 적어서 자식 화면의 첫 요청(useEffect)보다 먼저다.
//   · 자식은 key 가 붙은 묶음 안에서 그린다. 경주의 key 는 늘 같아서 경주 화면은 **다시 마운트되지 않는다**.
//     지역이 바뀌면 key 가 바뀌어 화면 상태(목록·캐시된 state)가 통째로 새로 시작한다 — 두 지역의 상태가 섞이지 않는다.
//   · 내부 계정이 아니라고 확인되면 남은 내부 지역 선택·캐시를 지운다.
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useAccount } from './account';
import { canSeeInternalRegions } from './accountRoles';
import { getInternalRegions, httpStatus, type InternalRegionView } from './api-client';
import { useI18n } from './i18n/I18nProvider';
import {
  buildInternalPack,
  GYEONGJU_PACK,
  internPack,
  packDisplayName,
  purgeRegionCaches,
  type RegionBounds,
  type RegionPack,
} from './regionPacks';
import { PUBLIC_REGION_ID, setActiveRegion } from './regionRuntime';
import { clearInternalRegionVisits } from './visits';
import {
  decideRegion,
  isPublicOnlyPath,
  normalizeStoredRegion,
  REGION_REVALIDATE_MS,
  REGION_STORAGE_KEY,
  regionsFetchFailure,
  type RegionsFetchState,
} from './regionState';

/** 스위처가 고를 수 있는 내부 지역 하나(서버 응답 + 만들어 둔 묶음). */
export interface AvailableRegion {
  id: string;
  pack: RegionPack;
  view: InternalRegionView;
  /** 활성 장소가 0곳이면 고를 수 없다. */
  selectable: boolean;
}

export interface RegionContextValue {
  /** 지금 지역의 묶음. 경주는 GYEONGJU_PACK(= lib/region.ts REGION 값). */
  pack: RegionPack;
  regionId: string;
  /** 공개 지역(경주)인가. */
  isPublic: boolean;
  /** 지금 로케일의 지역 이름 — 내부 지역 문구의 {region} 에 넣는다. 경주는 i18n region.name.gyeongju. */
  regionName: string;
  /** false 면 아직 그리지 않는 중(내부 계정의 내부 지역 선택을 확인하는 동안). */
  ready: boolean;
  /** 이 계정에 스위처를 보여 줄 수 있는가(화면용 힌트 — 실제 허락은 서버). */
  canSwitch: boolean;
  /** 서버가 허락한 내부 지역(목록을 받기 전에는 빈 배열). */
  availableRegions: AvailableRegion[];
  /** 지역을 바꾼다. 경주는 PUBLIC_REGION_ID. */
  setRegion: (id: string) => void;
  /** 스위처가 목록을 청한다(내부 계정이 아니면 아무것도 하지 않는다). */
  requestRegions: () => void;
}

const FALLBACK: RegionContextValue = {
  pack: GYEONGJU_PACK,
  regionId: PUBLIC_REGION_ID,
  isPublic: true,
  regionName: GYEONGJU_PACK.addressToken,
  ready: true,
  canSwitch: false,
  availableRegions: [],
  setRegion: () => {},
  requestRegions: () => {},
};

const RegionContext = createContext<RegionContextValue | null>(null);

// 정적 export 의 프리렌더(서버)에서는 useLayoutEffect 대신 useEffect — 서버에서는 어느 쪽도 돌지 않는다.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function readStoredRegion(): string | null {
  try {
    return normalizeStoredRegion(window.localStorage.getItem(REGION_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredRegion(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(REGION_STORAGE_KEY, id);
    else window.localStorage.removeItem(REGION_STORAGE_KEY);
  } catch {
    /* 저장소 차단 — 이번 탭에서만 기억한다 */
  }
}

function purgeAllRegionTraces(): void {
  writeStoredRegion(null);
  // 내부 지역에서 수락한 대기 방문 · 여정(내부 지역 장소 이름 · 좌표)도 지운다. 경주 여정은 그대로다.
  clearInternalRegionVisits();
  try {
    purgeRegionCaches(window.localStorage);
    purgeRegionCaches(window.sessionStorage);
  } catch {
    /* 저장소 차단 — 지울 것도 없다 */
  }
}

/** /internal/regions 를 한 번 묻는다. 상태를 만지지 않고 결과만 돌려준다(null = 반영하지 않음). */
async function loadRegions(key: string, mode: 'first' | 'revalidate'): Promise<ServerAnswer | null> {
  try {
    const res = await getInternalRegions({ timeoutMs: 10000 });
    const views = Array.isArray(res?.regions) ? res.regions : [];
    return { accountId: key, state: { status: 'ok', regionIds: views.map((v) => v.id) }, views };
  } catch (err) {
    const failure = regionsFetchFailure(httpStatus(err));
    // 재확인이 일시적으로 실패하면 지금 보던 지역을 유지한다(서버는 어차피 매 요청 역할을 다시 본다). 거절만 반영한다.
    if (mode === 'revalidate' && failure.status === 'failed') return null;
    return { accountId: key, state: failure, views: [] };
  }
}

interface ServerAnswer {
  /** 이 답을 받은 계정 — 계정이 바뀌면 답은 무효다. */
  accountId: string;
  state: RegionsFetchState;
  views: InternalRegionView[];
}

export function RegionProvider({ children }: { children: ReactNode }) {
  const { account, status, unreachable } = useAccount();
  const { locale, t } = useI18n();
  // 관제·사장님·개발자 콘솔·랜딩·서비스 소개는 경주 전용이다 — 내부 지역을 골라 둔 계정도 거기서는 경주로 본다.
  const publicOnlyRoute = isPublicOnlyPath(usePathname());
  const canSee = canSeeInternalRegions(account);
  // 내부 지역을 물어볼 수 있는 계정의 id. 내부 계정이 아니면 null — 이 값이 null 이면 아무 요청도 나가지 않는다.
  const fetchKey = canSee && status === 'ready' && account ? account.id : null;

  // 저장된 선택. 첫 렌더에서 바로 읽어도 프리렌더와 어긋나지 않는다 — 계정이 'ready' 가 되기 전(첫 렌더는 늘 'loading')에는
  // decideRegion 이 이 값을 보지 않는다. 계정이 바뀌면 다시 읽는다(로그아웃·계정 전환 때 userData 가 지웠을 수 있다).
  const accountId = account?.id ?? null;
  const [stored, setStored] = useState<string | null>(readStoredRegion);
  const [storedFor, setStoredFor] = useState<string | null>(accountId);
  if (storedFor !== accountId) {
    setStoredFor(accountId);
    setStored(readStoredRegion());
  }
  const [answer, setAnswer] = useState<ServerAnswer | null>(null);
  const [listWanted, setListWanted] = useState(false);
  const inflightRef = useRef<string | null>(null);

  const effectiveAnswer = answer && fetchKey && answer.accountId === fetchKey ? answer : null;

  // 서버가 허락한 지역 중 묶음을 만들 수 있는 것만 고를 수 있다.
  const availableRegions = useMemo<AvailableRegion[]>(() => {
    if (!effectiveAnswer || effectiveAnswer.state.status !== 'ok') return [];
    const out: AvailableRegion[] = [];
    for (const view of effectiveAnswer.views) {
      // 값이 같으면 이전 묶음 객체를 그대로 쓴다 — 재확인마다 `pack` 이 바뀌어 화면 효과가 다시 돌지 않게(internPack).
      const built = buildInternalPack(view);
      const pack = built ? internPack(built) : null;
      if (pack) out.push({ id: pack.id, pack, view, selectable: (view.facilityCount ?? 0) > 0 });
    }
    return out;
  }, [effectiveAnswer]);

  const serverState: RegionsFetchState = useMemo(() => {
    if (!effectiveAnswer) return { status: 'idle' };
    if (effectiveAnswer.state.status !== 'ok') return effectiveAnswer.state;
    return {
      status: 'ok',
      regionIds: availableRegions.filter((r) => r.selectable).map((r) => r.id),
      // 볼 수 있지만 활성 장소가 0곳인 지역 — 고른 지역이 여기 있으면 '권한 없음' 이 아니라 '빈 지역' 으로 안내한다.
      emptyRegionIds: availableRegions.filter((r) => !r.selectable).map((r) => r.id),
    };
  }, [effectiveAnswer, availableRegions]);

  const decision = decideRegion({
    accountStatus: status,
    canSee,
    unreachable,
    stored,
    server: serverState,
  });

  // 같은 계정으로 겹쳐 묻지 않는다. 답은 then 에서만 상태로 옮긴다.
  const fetchRegions = useCallback((key: string, mode: 'first' | 'revalidate') => {
    if (inflightRef.current === key) return;
    inflightRef.current = key;
    void loadRegions(key, mode)
      .then((next) => {
        // 답이 그대로면(재확인의 대부분) 이전 상태 객체를 둔다 — 다시 그릴 이유가 없다.
        if (next) setAnswer((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      })
      .finally(() => {
        if (inflightRef.current === key) inflightRef.current = null;
      });
  }, [setAnswer]);

  // (1) 저장된 내부 지역 확인 · (2) 스위처의 목록 요청 — 내부 계정(fetchKey)일 때만, 아직 답이 없을 때만.
  const needsFirstAnswer = !!fetchKey && !effectiveAnswer && (decision.shouldValidate || listWanted);
  useEffect(() => {
    if (!needsFirstAnswer || !fetchKey) return;
    fetchRegions(fetchKey, 'first');
  }, [needsFirstAnswer, fetchKey, fetchRegions]);

  // (3) 내부 지역을 보는 동안 5분마다·탭 복귀 때 다시 확인한다.
  const viewingInternal = decision.ready && decision.regionId !== PUBLIC_REGION_ID && !publicOnlyRoute;
  useEffect(() => {
    if (!viewingInternal || !fetchKey) return;
    const revalidate = () => fetchRegions(fetchKey, 'revalidate');
    const timer = window.setInterval(revalidate, REGION_REVALIDATE_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') revalidate();
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [viewingInternal, fetchKey, fetchRegions]);

  // 내부가 아니라고 확인됐거나 서버가 거절했으면 흔적(저장된 선택·내부 지역 캐시)을 지운다. 같은 계정 상태에서는 한 번만.
  // 메모리의 stored 는 그대로 둬도 된다 — 이 상태에서 decideRegion 은 경주를 고르고, 계정이 바뀌면 저장소에서 다시 읽는다.
  const purgedForRef = useRef<string | null>(null);
  const purgeKey = decision.purge ? `${status}:${accountId ?? '-'}:${decision.notice ?? ''}` : null;
  useEffect(() => {
    if (!purgeKey || purgedForRef.current === purgeKey) return;
    purgedForRef.current = purgeKey;
    purgeAllRegionTraces();
  }, [purgeKey]);

  // 안내는 한 번만 띄운다.
  const noticeShownRef = useRef<string | null>(null);
  const noticeKey = decision.notice ? `${decision.notice}:${accountId ?? '-'}` : null;
  useEffect(() => {
    if (!noticeKey || noticeShownRef.current === noticeKey) return;
    noticeShownRef.current = noticeKey;
    toast(t(
      decision.notice === 'reset' ? 'region.resetNotice' : decision.notice === 'empty' ? 'region.emptyNotice' : 'region.unavailable',
    ));
  }, [noticeKey, decision.notice, t]);

  // 자식의 첫 요청보다 먼저 지역을 적는다. 그리기 전(ready=false)에는 공개 지역 — 내부 헤더는 확인된 뒤에만 나간다.
  const renderReady = decision.ready || publicOnlyRoute;
  const activeId = decision.ready && !publicOnlyRoute ? decision.regionId : PUBLIC_REGION_ID;
  useIsoLayoutEffect(() => {
    setActiveRegion(activeId);
  }, [activeId]);

  const pack = useMemo<RegionPack>(() => {
    if (activeId === PUBLIC_REGION_ID) return GYEONGJU_PACK;
    return availableRegions.find((r) => r.id === activeId)?.pack ?? GYEONGJU_PACK;
  }, [activeId, availableRegions]);

  const setRegion = useCallback(
    (id: string) => {
      const next = normalizeStoredRegion(id);
      if (next && !availableRegions.some((r) => r.id === next && r.selectable)) return;
      writeStoredRegion(next ?? PUBLIC_REGION_ID);
      setStored(next);
    },
    [availableRegions, setStored],
  );

  const requestRegions = useCallback(() => {
    if (canSee) setListWanted(true);
  }, [canSee, setListWanted]);

  const regionName = pack.id === PUBLIC_REGION_ID ? t('region.name.gyeongju') : packDisplayName(pack, locale);

  const value = useMemo<RegionContextValue>(
    () => ({
      pack,
      regionId: pack.id,
      isPublic: pack.id === PUBLIC_REGION_ID,
      regionName,
      ready: renderReady,
      canSwitch: canSee,
      availableRegions,
      setRegion,
      requestRegions,
    }),
    [pack, regionName, renderReady, canSee, availableRegions, setRegion, requestRegions],
  );

  return (
    <RegionContext.Provider value={value}>
      {renderReady ? (
        <Fragment key={pack.id === PUBLIC_REGION_ID ? PUBLIC_REGION_ID : `region:${pack.id}`}>{children}</Fragment>
      ) : (
        <RegionPending label={t('common.loading')} />
      )}
    </RegionContext.Provider>
  );
}

/** 내부 계정의 내부 지역 선택을 서버가 확인하는 동안(보통 1초 안쪽)만 보인다. */
function RegionPending({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-screen flex-1 items-center justify-center bg-hanji text-sm text-muk-soft">
      {label}
    </div>
  );
}

/** 지금 지역의 위치 값(id · 중심 · 경계) — 화면 효과의 의존성으로 쓴다. */
export interface RegionGeo {
  id: string;
  center: { lat: number; lng: number };
  bounds: RegionBounds;
}

/**
 * 지금 지역의 id · 중심 · 경계만 담은 객체. 숫자가 같으면 같은 객체다 — 재확인에서 장소 수 · 구역 수만 바뀌어 묶음(pack)이
 * 새 객체가 돼도 이 값은 그대로라, 위치 재요청(/course) · 구역 재조회(/waiting) 같은 효과가 다시 돌지 않는다.
 */
export function useRegionGeo(): RegionGeo {
  const { pack } = useRegion();
  const { id } = pack;
  const { lat, lng } = pack.center;
  const { minLat, maxLat, minLng, maxLng } = pack.bounds;
  return useMemo(
    () => ({ id, center: { lat, lng }, bounds: { minLat, maxLat, minLng, maxLng } }),
    [id, lat, lng, minLat, maxLat, minLng, maxLng],
  );
}

/** 지금 지역. 프로바이더 밖(관제·콘솔·테스트)에서는 경주 묶음을 돌려준다. */
export function useRegion(): RegionContextValue {
  return useContext(RegionContext) ?? FALLBACK;
}
