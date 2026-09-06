// 관리자 화면의 '조회 결과' 판정 — 순수 함수 모음(렌더 없음).
//
// 왜 별도 모듈인가: 이 저장소에는 React 렌더 테스트 러너가 없다. 그런데 여기서 한 칸만
// 틀리면 '조회 실패' 가 화면에 0건·빈 목록·기본값으로 그려지고, 관리자는 그것을
// '문제 없음' 으로 읽는다. 판정을 렌더에서 떼어 lib/*.test.ts(node:assert)로 고정한다.
//
// 역할 분담: lib/adminMetricState.ts 는 대시보드 '수치 지표'(혼잡도·수락률 등)의 같은
// 원칙을 담당한다. 이 모듈은 목록 조회·설정 조회처럼 '건수' 와 '저장 가능 여부' 로
// 드러나는 쪽을 담당한다.

/** 조회 하나의 진행 상태. 실패는 반드시 '성공했는데 결과가 없음' 과 다른 값이어야 한다. */
export type LoadStatus = 'loading' | 'failed' | 'ok';

// ── 목록 건수 표시 ───────────────────────────────────────────────────────────
/**
 * 건수 배지에 넣을 문자열.
 *
 * 실패했을 때 숫자를 내보내지 않는 것이 이 함수의 존재 이유다 — 조회에 실패한 순간
 * 우리가 아는 사실은 '몇 건인지 모른다' 이지 '0건' 이 아니다. 대기 중인 문의가 쌓여
 * 있는데 화면이 'New: 0' 이라고 말하면 관리자는 그 화면을 확인하지 않는다.
 */
export function countLabel(status: LoadStatus, count: number): string {
  if (status === 'loading') return '…';
  if (status === 'failed') return '조회 실패';
  return count.toLocaleString();
}

/**
 * 목록이 비어 보이는 자리에 넣을 문구.
 *
 * '아직 없다' 와 '못 불러왔다' 는 관리자에게 완전히 다른 사실이다. 전자는 할 일이 없다는
 * 뜻이고 후자는 지금 당장 확인해야 한다는 뜻인데, 예전 코드는 둘 다 같은 회색 한 줄이었다.
 */
export function emptyOrFailedText(status: LoadStatus, emptyText: string, loadingText = '불러오는 중...'): string {
  if (status === 'loading') return loadingText;
  if (status === 'failed') return '조회에 실패해 표시할 수 없습니다 — 데이터가 없다는 뜻이 아닙니다.';
  return emptyText;
}

// ── 시스템 설정: 저장 가드 ───────────────────────────────────────────────────
/**
 * 설정 조회 결과.
 *
 * - `missing`: 서버가 null 을 돌려준 경우 = system_settings 행이 아직 없다(마이그레이션
 *   미적용 환경). 덮어쓸 실제 설정 자체가 없고 백엔드 PUT 도 404 로 사실을 말해 주므로
 *   저장 시도는 안전하다.
 * - `failed`: 조회 자체가 실패 = 실제 설정값이 무엇인지 **모른다**. 위와 전혀 다른 사실이다.
 */
export type SettingsLoad =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'missing' }
  | { status: 'ok' };

export interface SaveGuard {
  allowed: boolean;
  /** 막힌 이유(허용이면 null). 버튼 옆에 그대로 띄워 '왜 못 누르는지' 를 알린다. */
  reason: string | null;
}

/**
 * 저장 버튼을 눌러도 되는지 판정한다.
 *
 * failed 에서 막는 이유: 조회에 실패하면 화면에 남아 있는 값은 서버 값이 아니라 프런트
 * 기본값이다. 그 상태로 PUT 을 보내면 **읽지도 못한 실제 설정이 기본값으로 덮인다** —
 * 관리자는 아무것도 바꾸지 않았다고 믿는데 점검 모드가 꺼지고 공지 문구가 갈린다.
 * 되돌릴 수 없는 쓰기이므로, 다시 불러와 성공할 때까지 막는 쪽이 옳다.
 */
export function settingsSaveGuard(load: SettingsLoad, saving: boolean): SaveGuard {
  if (load.status === 'loading') {
    return { allowed: false, reason: '설정을 불러오는 중입니다.' };
  }
  if (load.status === 'failed') {
    return {
      allowed: false,
      reason: '설정을 불러오지 못해 저장할 수 없습니다. 지금 보이는 값은 서버 값이 아니라 기본값이라, 저장하면 실제 설정을 덮어씁니다.',
    };
  }
  if (saving) {
    return { allowed: false, reason: '저장 중입니다.' };
  }
  return { allowed: true, reason: null };
}

// ── 리포트 화면: 데이터 출처 배지 ────────────────────────────────────────────
/**
 * 리포트 페이지 상단 배지의 상태.
 *
 * `partial` 이 따로 있는 이유: 이 화면은 두 출처(혼잡 로그 · 추천 이력)를 각각 조회하고
 * 한쪽만 실패할 수 있다. 그때 'DB 실시간 반영' 이라고 말하면 실패한 차트의 빈자리가
 * 실측 결과로 읽힌다.
 */
export type ReportSourceState = 'loading' | 'failed' | 'partial' | 'live' | 'empty';

export function reportSourceState(input: { loading: boolean; failed: boolean; live: boolean }): ReportSourceState {
  if (input.loading) return 'loading';
  if (input.failed) return input.live ? 'partial' : 'failed';
  return input.live ? 'live' : 'empty';
}

export function reportSourceLabel(state: ReportSourceState): string {
  switch (state) {
    case 'loading': return '불러오는 중';
    case 'failed': return '조회 실패';
    case 'partial': return '일부 조회 실패';
    case 'live': return 'DB 실시간 반영';
    default: return '데이터 없음';
  }
}

// ── PostgREST 전량 조회 ──────────────────────────────────────────────────────
export interface PaginateOptions {
  /** 한 요청이 받을 행 수. PostgREST 의 db-max-rows(이 프로젝트는 1000)를 넘기면 의미가 없다. */
  pageSize: number;
  /** 무한 루프 방지 상한. 도달하면 목록이 잘린 것이므로 throw 한다. */
  maxPages: number;
}

/**
 * `.range()` 페이지네이션으로 전량을 받는다.
 *
 * 왜 필요한가: PostgREST 는 단일 응답을 1000행으로 캡한다. `.range(0, 1999)` 처럼 더 넓게
 * 요청해도 서버가 1000행에서 잘라 200 으로 돌려주므로 **오류 없이 조용히** 누락된다
 * (2026-09-07 프로덕션 GET 확인: facilities 요청에 `Content-Range: 0-999/1664`).
 *
 * 호출부는 fetchPage 안에서 반드시 유일키까지 포함한 `.order()` 를 걸어야 한다.
 * 정렬이 전순서가 아니면 페이지 경계에서 같은 행이 중복되거나 누락된다.
 *
 * 잘린 목록을 정상인 척 돌려주지 않는다 — 상한에 닿으면 throw 한다.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  { pageSize, maxPages }: PaginateOptions,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`pageSize 는 1 이상의 정수여야 합니다: ${pageSize}`);
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`maxPages 는 1 이상의 정수여야 합니다: ${maxPages}`);
  }
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const batch = await fetchPage(from, from + pageSize - 1);
    rows.push(...batch);
    // 서버가 요청한 만큼을 채우지 못했다면 마지막 페이지다.
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`목록이 상한(${maxPages * pageSize}행)을 넘었습니다. 페이지네이션 설정을 확인하세요.`);
}
