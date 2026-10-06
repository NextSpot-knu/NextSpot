// 사장님 콘솔 ② 성적표 — 어떤 타일을 어떤 순서·문구로 그릴지 정하는 순수 함수(PM 결정 4.18).
//
// 왜 따로 떼었나: 예전 성적표는 0 이어도 세 타일을 늘 그려 '쿠폰 사용 0 / 0' · '추천 수락 1 / 3120' 이 첫 줄이었다.
// 사장님은 그걸 '장사가 안 된다' 나 '고장' 으로 읽는다. 무엇을 보이고 무엇을 숨길지는 렌더 조건이라
// 화면과 어긋나기 쉽다 — 그래서 판정을 여기 두고 scorecard.test.ts 로 잠근다.
//
// 규칙:
//   · 0 인 숫자는 타일로 세우지 않는다.
//   · 맨 앞은 '손님 추천에 노출 N회'(두 칸 폭) — 우리 가게가 손님 추천에 몇 번 올랐는지가 가장 큰 사실이다.
//   · '추천 수락 a / b' 비율 대신 '길안내 시작 N건' — 분모(노출)는 이미 맨 앞 타일이 말한다.
//   · 쿠폰을 한 번도 안 줬으면 쿠폰 타일 대신 '첫 타임세일을 열어 보세요' 한 줄(다음 행동).
//   · 도착 확인은 서버가 숫자(>0)를 줄 때만(지금은 데모만 — 실계정 집계는 심사 뒤 서버에서).
// 사장님 콘솔은 한국어 전용이라 문구는 여기 한국어로 둔다(i18n 대상 아님).

import type { MerchantStats } from './api';

export type ScorecardTileKey = 'exposed' | 'accepted' | 'coupons' | 'reports' | 'arrivals';

export interface ScorecardTile {
  key: ScorecardTileKey;
  label: string;
  value: string;
  sub?: string;
  /** 두 칸을 쓰는 맨 앞 타일인가. */
  hero?: boolean;
}

export interface Scorecard {
  tiles: ScorecardTile[];
  /** 쿠폰을 한 번도 발급하지 않았을 때 '첫 타임세일을 열어 보세요' 줄을 보일지. */
  showFirstTimesalePrompt: boolean;
}

export const FIRST_TIMESALE_PROMPT = '첫 타임세일을 열어 보세요 — 우리 가게를 고른 손님에게 할인 쿠폰이 발급돼요.';

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** 모든 숫자가 0 인가(화면은 이때 타일 대신 '이렇게 시작해 보세요' 를 보인다). */
export function scorecardIsEmpty(stats: MerchantStats): boolean {
  return (
    !positive(stats.coupons_issued) &&
    !positive(stats.coupons_used) &&
    !positive(stats.congestion_reports) &&
    !positive(stats.recommendations_exposed) &&
    !positive(stats.recommendations_accepted) &&
    !positive(stats.visit_confirmations)
  );
}

export function scorecardTiles(stats: MerchantStats): Scorecard {
  const tiles: ScorecardTile[] = [];
  if (positive(stats.recommendations_exposed)) {
    tiles.push({
      key: 'exposed',
      label: '손님 추천에 노출',
      value: `${stats.recommendations_exposed.toLocaleString('ko-KR')}회`,
      sub: '관광객 추천 목록에 우리 가게가 오른 횟수',
      hero: true,
    });
  }
  if (positive(stats.recommendations_accepted)) {
    tiles.push({
      key: 'accepted',
      label: '길안내 시작',
      value: `${stats.recommendations_accepted.toLocaleString('ko-KR')}건`,
      sub: '추천을 보고 우리 가게로 길안내를 시작한 손님',
    });
  }
  if (positive(stats.coupons_issued)) {
    tiles.push({
      key: 'coupons',
      label: '쿠폰 사용',
      value: `${stats.coupons_used} / ${stats.coupons_issued}`,
      sub: `사용 ${stats.coupons_used} · 발급 ${stats.coupons_issued}`,
    });
  }
  if (positive(stats.congestion_reports)) {
    tiles.push({
      key: 'reports',
      label: '혼잡 제보',
      value: `${stats.congestion_reports.toLocaleString('ko-KR')}건`,
      sub: '손님이 보내 준 현장 소식',
    });
  }
  if (positive(stats.visit_confirmations)) {
    tiles.push({
      key: 'arrivals',
      label: '도착 확인',
      value: `${stats.visit_confirmations.toLocaleString('ko-KR')}건`,
      sub: '추천을 보고 실제로 도착한 손님',
    });
  }
  return { tiles, showFirstTimesalePrompt: !positive(stats.coupons_issued) && tiles.length > 0 };
}
