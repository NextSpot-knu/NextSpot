// 수요 압력 — '지금 붐비는 정도' × '이 업종을 찾는 사람이 얼마나 많은가'.
//
// 배경: 관리자 인프라 상세의 카드가 "예상 수요 (온보딩 데이터 기반)" 라고 적어 놓고 실제로는
// 최신 congestion_logs 한 건을 등급으로 환산한 값만 그렸다. 바로 위 '현재 상태' 와 **같은
// 숫자를 같은 라벨로 두 번** 그린 것이라, 카드가 한 칸을 차지할 이유 자체가 없었다.
//
// 두 항을 곱하는 이유: 혼잡만으로는 '지금 사람이 많다' 까지만 말한다. 거기에 그 업종을
// 선호로 고른 사용자 비율을 곱하면 '앞으로도 사람이 몰릴 압력' 이 된다 — 관리자가 분산
// 안내를 어디에 먼저 쏠지 정할 때 필요한 것은 뒤쪽이다.
//
// 정직성 규칙(이 파일이 존재하는 이유):
//   · 두 항 중 하나라도 없으면 **숫자를 만들지 않는다.** 관측이 없으면 0 이 아니라 '모름'
//     이고, 선호 표본이 없으면 0% 가 아니라 '모름' 이다.
//   · 값과 함께 **근거를 반환한다.** 근거 없이 숫자만 두면 이번 감사에서 반복해 나온
//     '지어낸 수치' 와 화면상 구분되지 않는다.

/** GET /api/v1/preference-stats/categories 응답.
 *
 * 이 값을 부르는 곳은 관리자 화면이고, lib/admin-api.ts 는 **snake_case ↔ camelCase 변환을
 * 하지 않는다**(그 파일 상단 주석의 결정). 그래서 파서는 서버가 보낸 그대로인
 * sample_size / total_users 를 읽는다 — 카멜을 기대하면 조용히 null 이 되어
 * '조회 실패' 로 오해된다. */
export interface CategoryShares {
  /** 선호를 한 개 이상 고른 사용자 수(= shares 의 분모). 0 이면 shares 는 비어 있다. */
  sampleSize: number;
  /** 전체 사용자 수. 표본이 전체에서 얼마나 되는지 밝히는 데 쓴다. */
  totalUsers: number;
  /** 업종 코드 → 비율(0..1). */
  shares: Record<string, number>;
}

/** 시설 업종 코드 — DB facilities.type · users.preferred_categories 와 같은 enum. */
export type CategoryCode = 'restaurant' | 'cafe' | 'attraction' | 'culture';

const CATEGORY_CODES: readonly string[] = ['restaurant', 'cafe', 'attraction', 'culture'];

/** facilities.type 원문 → 업종 코드. 알 수 없는 값은 null(추측하지 않는다). */
export function toCategoryCode(raw: unknown): CategoryCode | null {
  return typeof raw === 'string' && CATEGORY_CODES.includes(raw) ? (raw as CategoryCode) : null;
}

/** 응답 파싱. 형식이 어긋나면 null — '표본 0' 과 '조회 실패' 를 섞지 않기 위해서다. */
export function parseCategoryShares(raw: unknown): CategoryShares | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const sampleSize = body.sample_size;
  const totalUsers = body.total_users;
  if (typeof sampleSize !== 'number' || !Number.isFinite(sampleSize)) return null;
  if (typeof totalUsers !== 'number' || !Number.isFinite(totalUsers)) return null;
  const shares: Record<string, number> = {};
  if (typeof body.shares === 'object' && body.shares !== null) {
    for (const [key, value] of Object.entries(body.shares as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) shares[key] = value;
    }
  }
  return { sampleSize, totalUsers, shares };
}

/** 수요 압력 판정 결과. 그릴 수 없으면 **왜** 못 그리는지까지 돌려준다. */
export type DemandPressure =
  | {
      status: 'ok';
      /** 혼잡 × 선호(0..1). */
      value: number;
      /** 근거 1 — 지금 관측된 혼잡(0..1). */
      congestion: number;
      /** 근거 2 — 이 업종을 선호로 고른 사용자 비율(0..1). */
      share: number;
      /** 근거 3 — 그 비율이 몇 명 위에 선 값인가. */
      sampleSize: number;
      totalUsers: number;
    }
  | {
      status: 'hidden';
      /** no_observation: 관측 혼잡이 없다 · no_sample: 선호 표본이 없다(조회 실패 포함)
       *  · unknown_category: 업종을 특정할 수 없다. 어느 경우든 카드를 그리지 않는다. */
      reason: 'no_observation' | 'no_sample' | 'unknown_category';
    };

/**
 * 수요 압력을 계산한다.
 *
 * @param congestion 관측된 현재 혼잡(0..1). 관측이 없으면 null 을 넘긴다 — 0 을 넘기면
 *                   '한산' 이라는 없는 사실이 만들어진다.
 * @param category   이 시설의 업종 코드. 특정할 수 없으면 null.
 * @param shares     업종별 선호 비율. 조회 실패면 null.
 */
export function demandPressure(
  congestion: number | null,
  category: CategoryCode | null,
  shares: CategoryShares | null,
): DemandPressure {
  if (congestion === null || !Number.isFinite(congestion)) {
    return { status: 'hidden', reason: 'no_observation' };
  }
  if (category === null) return { status: 'hidden', reason: 'unknown_category' };
  // sampleSize 0 은 '아무도 이 업종을 안 골랐다' 가 아니라 '아무도 온보딩에 답하지 않았다' 다.
  // 그 상태의 0% 를 그리면 관측 결과인 척하는 숫자가 된다 — 카드를 통째로 내린다.
  if (shares === null || shares.sampleSize <= 0) return { status: 'hidden', reason: 'no_sample' };
  const share = shares.shares[category];
  if (typeof share !== 'number' || !Number.isFinite(share)) {
    return { status: 'hidden', reason: 'no_sample' };
  }
  return {
    status: 'ok',
    value: congestion * share,
    congestion,
    share,
    sampleSize: shares.sampleSize,
    totalUsers: shares.totalUsers,
  };
}

/** 화면에 그대로 붙이는 근거 한 줄. 숫자만 두지 않기 위한 것이므로 값과 함께 쓴다. */
export function demandPressureBasis(p: Extract<DemandPressure, { status: 'ok' }>): string {
  return (
    `관측 혼잡 ${Math.round(p.congestion * 100)}% × 이 업종 선호 ${Math.round(p.share * 100)}%` +
    ` (온보딩 응답 ${p.sampleSize}명 / 전체 ${p.totalUsers}명)`
  );
}
