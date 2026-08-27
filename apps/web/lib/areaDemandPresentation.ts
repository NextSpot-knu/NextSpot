export interface ParkingDemandEvidence {
  level: number;
  mode: 'live' | 'forecast';
  observedAt?: string | null;
  radiusM?: number | null;
}

export interface TourismDemandEvidence {
  referenceName?: string | null;
  distanceM?: number | null;
  forecastDate?: string | null;
  relativeIndex?: number | null;
}

/**
 * 단위가 다른 주차 점유와 관광지 자체 상대지수를 단일 quiet/busy 등급으로 노출하지 않는 UI 계약.
 * 종합 수치는 백엔드 순위 계산에만 남고, 관광 통계가 포함된 화면에는 독립 근거만 표시한다.
 */
export function areaDemandDisclosure(
  parking?: ParkingDemandEvidence | null,
  tourism?: TourismDemandEvidence | null,
) {
  return {
    evidenceCount: Number(!!parking) + Number(!!tourism),
    showQualitativeLevel: !!parking && !tourism,
  };
}
