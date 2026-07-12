// 코스 공유 딥링크 인코딩 — course/page.tsx 의 ?s= 쿼리 파라미터 포맷을 정의한다.
//
// 설계: 좌표(lat/lng)는 URL에 싣지 않는다. 정류지 facility id만 압축 인코딩해 짧은 URL을
// 유지하고, 수신 측(course/page.tsx 공유 모드)이 createPublicClient() 로 facilities 테이블을
// 조회해 이름/좌표를 그 시점 데이터로 복원한다(id 로 복원 = 짧은 URL + 데이터 신선성).
// 도착 오프셋(분)과 예측 혼잡도는 '공유 시점 스냅샷'이므로 재계산 없이 URL에 그대로 실어
// 복원한다 — 공유 모드 배너가 "공유 시점 기준"임을 명시하므로 시점 스냅샷 표기는 정직하다.
//
// 포맷: 정류지 1개당 '<facilityId>.<offsetMin 정수 분>.<congestion 0~100 정수>'
//       (facility id 는 UUID라 '.' 을 포함하지 않으므로 split('.') 3-파트 파싱이 안전하다)
//       정류지들은 콤마(,)로 이어붙인다. 예: "a1..-1111.12.40,b2..-2222.35.10"

export interface ShareStop {
  id: string;
  offsetMin: number; // 도착까지 남은 분(공유 시점 기준 오프셋, 반올림해 인코딩)
  congestion: number; // 예측 혼잡도 0~1(인코딩 시 0~100 정수로 축약)
}

export interface ParsedShareStop {
  id: string;
  offsetMin: number; // 분 단위, 정수로 복원
  congestion: number; // 0~1 로 복원
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 정류지 배열 → 's' 쿼리 파라미터 값(콤마 구분 문자열). URL 에 넣을 때는 encodeURIComponent 로 감쌀 것. */
export function encodeStops(stops: ShareStop[]): string {
  return stops
    .map((s) => `${s.id}.${Math.round(s.offsetMin)}.${Math.round(clamp01(s.congestion) * 100)}`)
    .join(',');
}

/**
 * 's' 쿼리 파라미터 값 → 정류지 배열. useSearchParams().get('s') 는 이미 디코딩된 문자열을
 * 반환하므로 여기서 별도 decodeURIComponent 는 필요 없다. 형식이 어긋난 조각은 조용히 걸러낸다
 * (깨진 공유 링크 하나가 전체 파싱을 막지 않도록).
 */
export function parseShareParam(s: string | null | undefined): ParsedShareStop[] {
  if (!s) return [];
  return s
    .split(',')
    .map((chunk): ParsedShareStop | null => {
      const parts = chunk.split('.');
      if (parts.length !== 3) return null;
      const [id, offsetRaw, congRaw] = parts;
      const offsetMin = Number(offsetRaw);
      const cong100 = Number(congRaw);
      if (!id || !Number.isFinite(offsetMin) || !Number.isFinite(cong100)) return null;
      return { id, offsetMin, congestion: clamp01(cong100 / 100) };
    })
    .filter((x): x is ParsedShareStop => x !== null);
}
