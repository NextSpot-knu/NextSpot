// 사장님 콘솔 ② 성적표 — 어떤 타일을 어떤 순서·문구로 그릴지 정하는 순수 함수(PM 결정 4.18, P1-2).
//
// 왜 따로 떼었나: 예전 성적표는 0 이어도 세 타일을 늘 그려 '쿠폰 사용 0 / 0' · '추천 수락 1 / 3120' 이 첫 줄이었다.
// 사장님은 그걸 '장사가 안 된다' 나 '고장' 으로 읽는다. 무엇을 보이고 무엇을 숨길지는 렌더 조건이라
// 화면과 어긋나기 쉽다 — 그래서 판정을 여기 두고 scorecard.test.ts 로 잠근다.
//
// 규칙:
//   · 0 인 숫자는 타일로 세우지 않는다. 단, 직전 같은 길이 기간에 숫자가 있었으면 0 도 세운다(P1-2) —
//     '도착 확인 0건 · 직전 7일 5건' 은 고장이 아니라 사장님이 알아야 할 변화다. 숨기면 줄어든 사실이 사라진다.
//   · 맨 앞은 추천 노출(두 칸 폭). 서버가 무엇을 셌는지(exposure_basis)에 따라 이름이 다르다(P1-2):
//       card_shown — '손님 화면에 뜬 추천 카드': 관광객 화면에 카드로 실제로 그려진 횟수.
//       list_rows  — '추천 목록에 포함된 횟수': 계산된 추천 목록에 들어간 횟수. /main 이 미리 받아 두는 목록까지
//                    들어가 손님이 봤는지는 이 숫자로 알 수 없다 — 그래서 '노출' 이라고 부르지 않는다.
//                    서버가 기준을 말하지 않으면(구 API) 이쪽이다 — 구 API 는 언제나 행 수를 셌다.
//   · '추천 수락 a / b' 비율 대신 '길안내 시작 N건' — 분모(노출)는 이미 맨 앞 타일이 말한다.
//   · 순서는 손님이 지나는 길 그대로 — 노출 → 길안내 시작 → 도착 확인 → 쿠폰 → 혼잡 제보.
//   · 타일 아래 한 줄(detail): 사람 수(표본) · 직전 같은 기간 값과 차이 · 일부 기간만 센 숫자면 언제부터인지.
//     차이는 건수로만 말한다 — 1건이 3건이 되면 +200% 라, 작은 가게일수록 비율이 숫자를 부풀린다.
//     서버가 비교값을 주지 않으면(null — 그 기간에는 기록이 없었다) 비교를 지어내지 않는다.
//   · 두 칸 격자에서 맨 앞 타일 뒤의 타일 수가 홀수면 마지막 타일도 두 칸을 쓴다(반 칸 옆 빈칸을 두지 않는다).
//   · 쿠폰을 한 번도 안 줬으면 쿠폰 타일 대신 '타임세일을 열어 보세요' 한 줄(다음 행동). 단 진행 중인 타임세일이
//     **없다고 확인됐을 때만** — 세일이 돌고 있는데 열어 보라고 하면 오른쪽 '진행 중' 배너와 서로 다른 말을 한다
//     (쿠폰은 손님이 추천을 받아들여야 발급되므로, 막 연 세일 옆에서도 쿠폰 수는 한동안 0 이다).
//     '첫' 은 붙이지 않는다 — 지난 세일 이력은 이 화면이 모르고, 예전에 세일을 열었던 가게에 '첫' 은 사실이 아니다.
//   · 도착 확인은 서버가 숫자를 줄 때만(null = 기록을 못 읽음 · 구 API).
// 사장님 콘솔은 한국어 전용이라 문구는 여기 한국어로 둔다(i18n 대상 아님).

import type { ExposureBasis, MerchantMetricKey, MerchantStats } from './api';

export type ScorecardTileKey = 'exposed' | 'accepted' | 'coupons' | 'reports' | 'arrivals';

export interface ScorecardTile {
  key: ScorecardTileKey;
  label: string;
  value: string;
  /** 표본·비교 한 줄 — 예: '4명 · 직전 7일 3건(+2)'. 서버가 사람 수·비교값을 주지 않으면 없다. */
  detail?: string;
  /** 숫자의 뜻 한 줄 — 이름만으로 모자랄 때만(목록 기준 노출 · 쿠폰의 사용/발급). */
  sub?: string;
  /** 두 칸을 쓰는 맨 앞 타일인가(숫자도 한 단계 크다). */
  hero?: boolean;
  /** 두 칸을 쓰는 마지막 타일인가(맨 앞 타일 뒤가 홀수 개일 때 — 숫자 크기는 그대로). */
  wide?: boolean;
}

export interface Scorecard {
  tiles: ScorecardTile[];
  /** 쿠폰 발급이 없고 진행 중인 세일도 없을 때 '타임세일을 열어 보세요' 줄을 보일지. */
  showTimesalePrompt: boolean;
}

export interface ScorecardOptions {
  /** ③ 에 진행 중인 타임세일이 있는가. 모르면(null·생략 — 아직 불러오는 중이거나 실패) 프롬프트를 감춘다. */
  saleActive?: boolean | null;
}

export const TIMESALE_PROMPT = '타임세일을 열어 보세요 — 우리 가게를 고른 손님에게 할인 쿠폰이 발급돼요.';

/** 노출 타일의 이름 — 서버가 센 기준마다 다르다(파일 머리말). */
export const EXPOSURE_LABEL: Record<ExposureBasis, string> = {
  card_shown: '손님 화면에 뜬 추천 카드',
  list_rows: '추천 목록에 포함된 횟수',
};

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const fmt = (n: number) => n.toLocaleString('ko-KR');

/** 지표 하나를 한 모양으로 — 서버가 metrics 를 주면 그것을, 아니면(구 API·데모) 예전 칸을 읽는다. */
export interface ScorecardMetric {
  current: number | null;
  /** null = 비교할 수 없음(0 이 아니다). */
  previous: number | null;
  people: number | null;
  countedSince: string | null;
}

const FLAT_FIELD: Record<MerchantMetricKey, keyof MerchantStats> = {
  exposures: 'recommendations_exposed',
  accepts: 'recommendations_accepted',
  arrivals: 'visit_confirmations',
  coupons_issued: 'coupons_issued',
  coupons_used: 'coupons_used',
  congestion_reports: 'congestion_reports',
};

export function scorecardMetric(stats: MerchantStats, key: MerchantMetricKey): ScorecardMetric {
  const metric = stats.metrics?.[key];
  if (!metric) {
    return { current: finite(stats[FLAT_FIELD[key]]), previous: null, people: null, countedSince: null };
  }
  return {
    current: finite(metric.current),
    previous: finite(metric.previous),
    people: finite(metric.people),
    countedSince: typeof metric.counted_since === 'string' && metric.counted_since ? metric.counted_since : null,
  };
}

/** 서버가 노출을 무엇으로 셌는가. 말하지 않으면(구 API) 행 수다. */
export function exposureBasis(stats: MerchantStats): ExposureBasis {
  return stats.exposure_basis === 'card_shown' ? 'card_shown' : 'list_rows';
}

/** ISO 시각 → '10월 24일'(한국 날짜). 못 읽으면 null. */
function kstMonthDay(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + 9 * 3_600_000);
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
}

/** 직전 같은 기간과의 차이 — '직전 7일 3건(+2)'. 비교할 수 없으면 null. */
function compareText(metric: ScorecardMetric, days: number, unit: string): string | null {
  if (metric.current === null || metric.previous === null) return null;
  const diff = metric.current - metric.previous;
  const change = diff === 0 ? '같음' : `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}`;
  return `직전 ${days}일 ${fmt(metric.previous)}${unit}(${change})`;
}

function detailLine(metric: ScorecardMetric, days: number, unit: string): string | undefined {
  const parts: string[] = [];
  if (positive(metric.people)) parts.push(`${fmt(metric.people)}명`);
  const compare = compareText(metric, days, unit);
  if (compare) parts.push(compare);
  const since = metric.countedSince ? kstMonthDay(metric.countedSince) : null;
  if (since) parts.push(`${since}부터 집계`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 타일로 세울 숫자인가 — 이번 기간에 있거나, 이번엔 0 이어도 직전 기간에 있었으면(줄어든 사실을 숨기지 않는다). */
const worthATile = (metric: ScorecardMetric) =>
  positive(metric.current) || (metric.current === 0 && positive(metric.previous));

export function scorecardTiles(stats: MerchantStats, { saleActive = null }: ScorecardOptions = {}): Scorecard {
  const days = stats.window_days;
  const tiles: ScorecardTile[] = [];
  const exposures = scorecardMetric(stats, 'exposures');
  const accepts = scorecardMetric(stats, 'accepts');
  const arrivals = scorecardMetric(stats, 'arrivals');
  const reports = scorecardMetric(stats, 'congestion_reports');
  const issued = scorecardMetric(stats, 'coupons_issued');
  const used = scorecardMetric(stats, 'coupons_used');

  if (worthATile(exposures)) {
    const basis = exposureBasis(stats);
    tiles.push({
      key: 'exposed',
      label: EXPOSURE_LABEL[basis],
      value: `${fmt(exposures.current ?? 0)}회`,
      detail: detailLine(exposures, days, '회'),
      // 카드 기준은 이름이 곧 뜻이다. 목록 기준은 이름만으로 '손님이 봤다' 로 읽히지 않게 한 줄을 더한다.
      sub: basis === 'list_rows' ? '앱이 미리 받아 둔 목록도 들어가요 — 손님이 실제로 봤는지는 이 숫자로 알 수 없어요' : undefined,
      hero: true,
    });
  }
  if (worthATile(accepts)) {
    tiles.push({
      key: 'accepted',
      label: '길안내 시작',
      value: `${fmt(accepts.current ?? 0)}건`,
      detail: detailLine(accepts, days, '건'),
    });
  }
  if (worthATile(arrivals)) {
    tiles.push({
      key: 'arrivals',
      label: '도착 확인',
      value: `${fmt(arrivals.current ?? 0)}건`,
      detail: detailLine(arrivals, days, '건'),
    });
  }
  if (positive(issued.current)) {
    // 쿠폰은 0 이면 세우지 않는다('0 / 0' 금지) — 그 자리는 아래 '타임세일을 열어 보세요' 가 맡는다.
    const usedNow = used.current ?? 0;
    const previous =
      issued.previous !== null && used.previous !== null
        ? `직전 ${days}일 사용 ${fmt(used.previous)} · 발급 ${fmt(issued.previous)}`
        : undefined;
    tiles.push({
      key: 'coupons',
      label: '쿠폰 사용',
      value: `${usedNow} / ${issued.current}`,
      sub: `사용 ${usedNow} · 발급 ${issued.current}`,
      detail: previous,
    });
  }
  if (worthATile(reports)) {
    tiles.push({
      key: 'reports',
      label: '혼잡 제보',
      value: `${fmt(reports.current ?? 0)}건`,
      detail: detailLine({ ...reports, people: null }, days, '건'),
    });
  }
  const halfWidth = tiles.filter((t) => !t.hero);
  if (halfWidth.length % 2 === 1) halfWidth[halfWidth.length - 1].wide = true;
  return {
    tiles,
    showTimesalePrompt: !positive(issued.current) && tiles.length > 0 && saleActive === false,
  };
}

/** 보여 줄 타일이 하나도 없는가(화면은 이때 타일 대신 '이렇게 시작해 보세요' 를 보인다). */
export function scorecardIsEmpty(stats: MerchantStats): boolean {
  return scorecardTiles(stats).tiles.length === 0;
}

// =========================================================================
// 브리핑 자리의 요약 — AI 브리핑이 없을 때(LLM 꺼짐·모델 없음·실패) 그 자리에 성적표 숫자로 쓴 두 문장.
// LLM 을 쓰지 않는다. 숫자는 전부 서버가 센 성적표 그대로이고, 판단·권유·칭찬을 덧붙이지 않는다.
// 손님 흐름(노출·길안내·도착)이 하나도 없으면 null — 빈 카드나 제목만 남은 카드를 세우지 않는다.
// =========================================================================

export interface ScorecardSummary {
  /** 카드 제목 — 어느 기간의 숫자인지부터 말한다. */
  title: string;
  text: string;
}

export function scorecardSummary(stats: MerchantStats): ScorecardSummary | null {
  const days = stats.window_days;
  const exposures = scorecardMetric(stats, 'exposures');
  const accepts = scorecardMetric(stats, 'accepts');
  const arrivals = scorecardMetric(stats, 'arrivals');
  // '있었어요' 로 묶는 것은 실제로 일어난 일만 — '도착 확인 0건이 있었어요' 같은 문장을 만들지 않는다.
  const actions = [
    positive(accepts.current) ? `길안내 시작 ${fmt(accepts.current)}건` : null,
    positive(arrivals.current) ? `도착 확인 ${fmt(arrivals.current)}건` : null,
  ].filter((part): part is string => part !== null);
  const acted = actions.length > 0;
  if (!positive(exposures.current) && !acted) return null;

  const sentences: string[] = [];

  if (positive(exposures.current)) {
    const seen =
      exposureBasis(stats) === 'card_shown'
        ? `손님 화면에 추천 카드로 ${fmt(exposures.current)}번 떴`
        : `추천 목록에 ${fmt(exposures.current)}번 들어갔`;
    sentences.push(
      acted
        ? `최근 ${days}일 동안 우리 가게가 ${seen}고, ${actions.join(' · ')}이 있었어요.`
        : `최근 ${days}일 동안 우리 가게가 ${seen}어요. 길안내를 시작한 손님은 아직 없어요.`,
    );
  } else {
    sentences.push(`최근 ${days}일 동안 ${actions.join(' · ')}이 있었어요.`);
  }

  // 비교는 한 가지만 — 도착 확인이 손님을 데려왔다는 가장 직접적인 숫자라 먼저 본다. 둘 다 0 인 비교는 말하지 않는다.
  const comparable = (m: ScorecardMetric) =>
    m.current !== null && m.previous !== null && (m.current > 0 || m.previous > 0);
  const pick = comparable(arrivals)
    ? { name: '도착 확인', metric: arrivals }
    : comparable(accepts)
      ? { name: '길안내 시작', metric: accepts }
      : null;
  if (pick) {
    const current = pick.metric.current as number;
    const previous = pick.metric.previous as number;
    const diff = current - previous;
    sentences.push(
      diff === 0
        ? `${pick.name}은 직전 ${days}일과 같아요(${fmt(current)}건).`
        : `${pick.name}은 직전 ${days}일(${fmt(previous)}건)보다 ${fmt(Math.abs(diff))}건 ${diff > 0 ? '늘었어요' : '줄었어요'}.`,
    );
  }
  return { title: `최근 ${days}일 한눈에`, text: sentences.join(' ') };
}

// =========================================================================
// '숫자는 이렇게 셉니다' — 성적표 아래 접어 둔 설명. 서버가 실제로 그렇게 셌을 때만 그 문장을 넣는다
// (구 API 는 같은 날 중복을 합치지도, 내부 계정을 빼지도 않았다 — 그 응답에 이 문장을 붙이면 거짓이다).
// =========================================================================

export function scorecardNotes(stats: MerchantStats): string[] {
  const notes: string[] = [];
  if (exposureBasis(stats) === 'card_shown') {
    const exposures = scorecardMetric(stats, 'exposures');
    const since = exposures.countedSince ? kstMonthDay(exposures.countedSince) : null;
    notes.push(
      '추천 카드는 손님 화면에 우리 가게가 추천 순위와 함께 뜬 횟수예요. 손님이 검색해 직접 연 카드는 세지 않아요.' +
        (since ? ` 이 기록은 ${since}부터 쌓였어요.` : ''),
    );
  } else {
    notes.push(
      '추천 목록 횟수는 손님에게 계산된 추천 목록에 우리 가게가 들어간 횟수예요. 앱이 미리 받아 둔 목록도 들어가서, 손님 화면에 실제로 보였는지는 알 수 없어요.',
    );
  }
  if (stats.metrics) {
    notes.push('길안내 시작·도착 확인은 같은 손님이 같은 날 여러 번 눌러도 한 번으로 세요. 도착 확인은 손님이 앱에서 도착을 눌러야 쌓여요.');
    // 사람 수의 단위는 지표마다 다르다 — 카드 기록(usage_events)에는 계정이 없어 익명 기기로 세고, 목록 행·길안내·도착은
    // 추천 기록의 계정(관광객 게스트 세션 포함)으로 센다(merchant.py 응답 metrics 주석). 한 단위로 뭉뚱그리면 틀린 말이 된다.
    notes.push(
      (exposureBasis(stats) === 'card_shown'
        ? '사람 수는 추천 카드는 기기 기준, 길안내 시작·도착 확인은 앱 계정(게스트 포함) 기준이에요.'
        : '사람 수는 앱 계정(게스트 포함) 기준이에요.') + ' 직전 기간 기록이 없으면 비교하지 않아요.',
    );
  }
  if (stats.internal_accounts_excluded) {
    notes.push('관리자·개발자 계정의 길안내·도착·쿠폰·제보는 세지 않아요.');
  }
  return notes;
}
