// 지역 결정 규칙 — 순수 함수만 둔다(React·네트워크 없음 → tsx 로 바로 테스트한다).
//
// RegionProvider(lib/regionContext.tsx)는 여기 decideRegion 이 돌려준 값대로만 움직인다:
// 언제 GET /api/v1/internal/regions 를 부를지(shouldValidate), 무엇을 그릴지(regionId·ready), 기기 캐시를 지울지(purge),
// 어떤 안내를 띄울지(notice).
//
// 지켜야 할 약속(regionState.test.ts 가 잠근다):
//   · 관광객·게스트·계정 확인 중(loading)은 **요청 0번**, 경주를 **바로** 그린다(ready=true, 기다리지 않는다).
//   · 내부 지역을 고른 기록이 있어도 계정이 내부가 아니라고 확인되면 그 기록과 내부 지역 캐시를 지운다.
//   · 내부 계정이 내부 지역을 골라 둔 경우에만 첫 응답까지 기다린다(ready=false) — 경주를 먼저 그렸다가 바꾸지 않는다.
//   · 서버가 401·403 을 주거나 목록에 그 지역이 없으면 경주로 돌아가고 기록을 지운 뒤 안내한다.
//
// 이 판정은 화면용이다. 내부 지역 데이터는 서버가 매 요청 DB 역할로 다시 확인해야만 나온다(app/core/region.py).
import type { AccountStatus } from './accountRoles';
import { PUBLIC_REGION_ID } from './regionRuntime';

/** 사용자가 고른 지역을 기억하는 localStorage 키(로그아웃·계정 전환 때 lib/userData.ts 가 지운다). */
export const REGION_STORAGE_KEY = 'nextspot_region';

/** 내부 지역 재확인 간격 — 내부 지역을 보고 있는 동안만. */
export const REGION_REVALIDATE_MS = 5 * 60_000;

/** GET /internal/regions 의 결과를 판정에 필요한 만큼만 줄인 것. */
export type RegionsFetchState =
  | { status: 'idle' }
  | {
      status: 'ok';
      /** 고를 수 있는 지역(활성 장소가 있는 곳). */
      regionIds: readonly string[];
      /** 서버가 이 계정에 허락했지만 지금 활성 장소가 0곳인 지역 — 권한 문제가 아니다(안내가 다르다). */
      emptyRegionIds?: readonly string[];
    }
  | { status: 'denied' }
  | { status: 'failed' };

export interface DecideRegionInput {
  accountStatus: AccountStatus;
  /** 계정이 내부 지역을 볼 수 있다는 화면용 힌트(accountRoles.canSeeInternalRegions). */
  canSee: boolean;
  /** 마지막 계정 조회가 서버에 닿지 못했는가(account.tsx 의 unreachable) — 이때는 계정을 모르는 것으로 본다. */
  unreachable?: boolean;
  /** localStorage 에 남은 선택(없으면 null). */
  stored: string | null;
  /** 이 계정으로 받은 /internal/regions 결과. */
  server: RegionsFetchState;
}

export type RegionNotice = 'reset' | 'empty' | 'unavailable' | null;

export interface RegionDecision {
  /** 지금 그릴 지역. */
  regionId: string;
  /** false 면 아직 그리지 않는다(내부 계정의 내부 지역 선택을 서버가 확인하기 전). */
  ready: boolean;
  /** 지금 /internal/regions 를 불러야 하는가. */
  shouldValidate: boolean;
  /** 저장된 선택과 내부 지역 캐시를 지워야 하는가. */
  purge: boolean;
  /** 사용자에게 띄울 안내. */
  notice: RegionNotice;
}

/**
 * 경주 전용 화면인가 — 랜딩('/'), 서비스 소개(/guide), 관제(/admin), 사장님 콘솔(/merchant), 개발자 콘솔(/dev).
 * 이 화면들은 내부 지역을 고른 계정에게도 경주로 그리고 지역 헤더를 싣지 않는다(S3 범위 밖 — 경주 숫자 그대로).
 */
export function isPublicOnlyPath(pathname: string | null | undefined): boolean {
  if (!pathname || pathname === '/') return true;
  return /^\/(admin|merchant|dev|guide)(\/|$)/.test(pathname);
}

/** 저장된 값을 정리한다 — 빈 값·공개 지역은 null(= 경주). */
export function normalizeStoredRegion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === PUBLIC_REGION_ID) return null;
  return trimmed;
}

/** 실패한 /internal/regions 호출을 판정 상태로 옮긴다 — 401·403 은 거절, 나머지는 일시 실패. */
export function regionsFetchFailure(status: number | undefined): RegionsFetchState {
  return status === 401 || status === 403 ? { status: 'denied' } : { status: 'failed' };
}

const PUBLIC_NOW: RegionDecision = {
  regionId: PUBLIC_REGION_ID,
  ready: true,
  shouldValidate: false,
  purge: false,
  notice: null,
};

/** 계정이 '내부가 아니다' 로 확정됐는가. loading·연결 실패는 아직 모른다. */
function resolvedAsNonInternal(input: DecideRegionInput): boolean {
  if (input.canSee) return false;
  if (input.accountStatus === 'ready') return true;
  return input.accountStatus === 'error' && !input.unreachable;
}

export function decideRegion(input: DecideRegionInput): RegionDecision {
  const stored = normalizeStoredRegion(input.stored);

  // 계정 확인 중 — 아무것도 묻지 않고 경주를 그린다(관광객의 첫 화면을 막지 않는다).
  if (input.accountStatus === 'loading') return PUBLIC_NOW;

  if (!input.canSee) {
    // 내부가 아니라고 확정됐으면 남은 내부 지역 흔적을 지운다. 연결 실패 중에는 판단을 미룬다.
    return resolvedAsNonInternal(input) ? { ...PUBLIC_NOW, purge: true } : PUBLIC_NOW;
  }

  // 내부 계정이지만 프로필 조회가 'ready' 가 아니면(드물다) 묻지 않는다.
  if (input.accountStatus !== 'ready') return PUBLIC_NOW;

  // 경주를 고른(또는 아무것도 고르지 않은) 내부 계정 — 그대로 경주. 목록은 스위처가 열릴 때 따로 받는다.
  if (!stored) return PUBLIC_NOW;

  switch (input.server.status) {
    case 'idle':
      return { regionId: PUBLIC_REGION_ID, ready: false, shouldValidate: true, purge: false, notice: null };
    case 'ok':
      if (input.server.regionIds.includes(stored)) {
        return { regionId: stored, ready: true, shouldValidate: false, purge: false, notice: null };
      }
      // 볼 수는 있지만 지금 장소가 0곳인 지역(지역 경비가 끄거나 적재가 비었다) — 경주로 돌아가되 '권한이 없다' 고
      // 말하지 않는다. 선택은 지운다(빈 지역을 다시 열 때마다 안내가 반복되지 않게 — 채워지면 스위처에서 다시 고른다).
      if (input.server.emptyRegionIds?.includes(stored)) {
        return { ...PUBLIC_NOW, purge: true, notice: 'empty' };
      }
      return { ...PUBLIC_NOW, purge: true, notice: 'reset' };
    case 'denied':
      return { ...PUBLIC_NOW, purge: true, notice: 'reset' };
    case 'failed':
    default:
      // 일시 실패 — 경주로 보여 주되 선택은 남긴다(다음 방문 때 다시 확인한다).
      return { ...PUBLIC_NOW, notice: 'unavailable' };
  }
}
