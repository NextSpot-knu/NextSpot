// 주차 실측 기반 혼잡 추정 — 미리보기·적재 결과를 **운영자가 읽을 수 있는 말**로 옮긴다.
//
// 왜 순수 모듈인가: 이 화면의 어려운 부분은 렌더가 아니라 **판정**이다.
//   · 서버는 실패를 코드로 준다(`migration_not_applied`, `parking_snapshot_stale` …).
//     코드를 그대로 띄우면 이 저장소를 아는 사람만 읽을 수 있고, 그런 사람은 이 버튼을
//     누를 일이 없다(같은 이유로 lib/adminGuardrailWarnings.ts 를 만들었다).
//   · '적재했다' 와 '이미 있어서 안 넣었다' 와 '넣을 값이 없다' 는 **서로 다른 사실**인데
//     셋 다 성공 응답으로 온다. 하나로 뭉개면 버튼이 거짓말을 한다.
//
// ⚠️ 이 값들은 **추정치**다. 화면 어디서도 실측으로 읽히면 안 된다 — 그래서 문구에 항상
// '추정' 을 남기고, 무엇에서 파생됐는지(공영주차 실측)를 함께 적는다.

/** POST 응답의 `status`. 서버가 이 셋만 돌려준다. */
export type EstimateRecordStatus = 'recorded' | 'already_recorded' | 'no_estimates';

export interface EstimateSummary {
  status?: string;
  inserted?: number;
  estimatedFacilities?: number;
  facilityCount?: number;
  skippedNoParking?: number;
  gridCellsCovered?: number;
  gridCellsTotal?: number;
  levelMin?: number | null;
  levelMax?: number | null;
  radiusM?: number;
  stale?: boolean;
  derivedFrom?: {
    observedAt?: string;
    bucketAt?: string;
    ageSeconds?: number;
    lotCount?: number;
  };
}

export interface EstimateNotice {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  detail: string;
}

/** 서버 실패 코드 → 무엇이 잘못됐고 **무엇을 하면 되는지**. */
export function describeEstimateFailure(code: string | null, status: number | null): EstimateNotice {
  switch (code) {
    case 'migration_not_applied':
      return {
        tone: 'warn',
        title: '마이그레이션이 아직 적용되지 않았어요',
        detail:
          'supabase/migrations/20260908120000_parking_derived_congestion_source.sql 을 SQL Editor 에 붙여넣은 뒤 다시 시도해 주세요. 서버는 정상입니다.',
      };
    case 'no_parking_snapshot':
    case 'no_parking_lots':
      return {
        tone: 'error',
        title: '주차 실측 데이터가 없어요',
        detail: '경주 ITS 수집 결과가 비어 있습니다. 수집 파이프라인 상태를 먼저 확인해 주세요.',
      };
    case 'parking_snapshot_stale':
      return {
        tone: 'error',
        title: '주차 실측이 너무 오래됐어요',
        detail:
          '수집은 10분 주기인데 최신 스냅샷이 1시간을 넘었습니다 — 수집이 연속으로 실패했다는 뜻이라, 그 값을 지금 시각으로 적재하지 않습니다.',
      };
    case 'parking_snapshot_in_future':
    case 'snapshot_timestamp_unparsable':
      return {
        tone: 'error',
        title: '주차 실측의 시각을 신뢰할 수 없어요',
        detail: '스냅샷 시각이 미래이거나 형식이 깨졌습니다. 수집 파이프라인을 확인해 주세요.',
      };
    case 'duplicate_check_failed':
      return {
        tone: 'error',
        title: '중복 확인에 실패해 적재를 멈췄어요',
        detail:
          '확인 없이 넣으면 같은 관측이 두 배로 쌓이고, 그 뒤에는 어느 쪽이 두 번째인지 구분할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      };
    default:
      // 모르는 코드를 **숨기지 않는다** — 숨기면 새 실패가 조용히 사라진다.
      return {
        tone: 'error',
        title: '추정치를 적재하지 못했어요',
        detail: code
          ? `서버가 알려준 사유: ${code}${status ? ` (HTTP ${status})` : ''}`
          : status
            ? `HTTP ${status}`
            : '알 수 없는 오류입니다.',
      };
  }
}

/** 적재 성공 응답 → 실제로 무슨 일이 있었는지. 셋을 뭉개지 않는다. */
export function describeEstimateResult(summary: EstimateSummary): EstimateNotice {
  const inserted = summary.inserted ?? 0;
  switch (summary.status) {
    case 'already_recorded':
      return {
        tone: 'ok',
        title: '이미 적재된 시각이에요',
        detail:
          '같은 10분 버킷에 이미 추정치가 있어 아무것도 넣지 않았습니다. 다음 수집(최대 10분) 뒤에 다시 누르면 새 값이 쌓입니다.',
      };
    case 'no_estimates':
      return {
        tone: 'warn',
        title: '만들 추정치가 없었어요',
        detail:
          '반경 안에 주차장이 있는 시설이 하나도 없습니다. 값이 없는 곳에 값을 만들지 않으므로 아무것도 넣지 않았습니다.',
      };
    default:
      return {
        tone: 'ok',
        title: `추정치 ${inserted.toLocaleString()}건을 적재했어요`,
        detail: '관제 화면의 혼잡 카드·히트맵에 반영됩니다. 추천 순위와 모델 학습에는 쓰이지 않습니다.',
      };
  }
}

/**
 * 미리보기 요약 한 줄 — **커버리지 숫자만 말하지 않는다.**
 *
 * "1,653곳 중 834곳" 만 보면 관측이 실제보다 두껍게 들린다. 실시간 잔여를 보고하는 ITS
 * 주차장은 소수이고 그나마 한곳에 몰려 있어, 그 몇 개의 관측을 수백 곳에 펼친 값이다.
 * 그래서 **주차장 개수를 항상 같이** 말한다.
 */
export function summarizeEstimatePreview(summary: EstimateSummary): string[] {
  const lines: string[] = [];
  const lots = summary.derivedFrom?.lotCount;
  const estimated = summary.estimatedFacilities ?? 0;
  const total = summary.facilityCount;

  lines.push(
    total
      ? `활성 시설 ${total.toLocaleString()}곳 중 ${estimated.toLocaleString()}곳에 추정치가 붙습니다`
      : `${estimated.toLocaleString()}곳에 추정치가 붙습니다`,
  );
  if (typeof lots === 'number') {
    lines.push(`근거는 실시간 잔여를 보고하는 주차장 ${lots}곳입니다 — 이 관측을 넓게 펼친 값입니다`);
  }
  if (typeof summary.levelMin === 'number' && typeof summary.levelMax === 'number') {
    const spread = summary.levelMax - summary.levelMin;
    lines.push(
      `추정 혼잡도 범위 ${Math.round(summary.levelMin * 100)}~${Math.round(summary.levelMax * 100)}%` +
        // 폭이 좁으면 '구역별 혼잡' 이 아니라 사실상 상수 하나다. 그 사실을 숨기지 않는다.
        (spread < 0.15 ? ' · 폭이 좁아 구역 간 변별력이 거의 없습니다' : ''),
    );
  }
  if (summary.skippedNoParking) {
    lines.push(`반경 밖이라 제외된 시설 ${summary.skippedNoParking.toLocaleString()}곳 (값을 만들지 않습니다)`);
  }
  return lines;
}

/** 원본 스냅샷이 얼마나 오래됐나 — 사람이 읽는 형태로. */
export function formatSnapshotAge(ageSeconds: number | null | undefined): string | null {
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) return null;
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}
