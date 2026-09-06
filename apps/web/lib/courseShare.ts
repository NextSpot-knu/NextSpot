// 코스 공유 딥링크 인코딩 — course/page.tsx 의 ?s= 쿼리 파라미터 포맷을 정의한다.
//
// 설계: 좌표(lat/lng)는 URL에 싣지 않는다. 정류지 facility id만 압축 인코딩해 짧은 URL을
// 유지하고, 수신 측(course/page.tsx 공유 모드)이 createPublicClient() 로 facilities 테이블을
// 조회해 이름/좌표를 그 시점 데이터로 복원한다(id 로 복원 = 짧은 URL + 데이터 신선성).
//
// 포맷: '<공유시각 epoch 분>~<정류지들>'
//   - 공유 시각을 실어야 수신 측이 '몇 분 지난 링크인지' 알고 도착 오프셋을 경과 시간만큼
//     보정할 수 있다(없으면 2시간 지난 링크의 '12분 뒤 도착'이 현재 시각 기준 절대시각으로
//     재계산되어 방금 계산된 것처럼 보이는 왜곡이 생긴다).
//   - 정류지 1개당 '<facilityId>.<offsetMin 정수 분>.<congestion 0~100 정수 | '-'>', 콤마(,) 구분.
//     (facility id 는 UUID라 '.' 을 포함하지 않으므로 split('.') 3-파트 파싱이 안전하다)
//   - 혼잡도 미상은 '-' 다. 모델이 학습되지 않았거나(degraded_rules) 예측이 없는 정류지가 있으면
//     그 칸이 비는데, 예전에는 그런 코스를 **아예 공유할 수 없었다** — 공유 버튼은 그대로 보이면서
//     코스가 빠진 맨 URL 을 조용히 공유했다. 프로덕션 모델이 미학습이면 이건 '가끔' 이 아니라
//     '항상' 이다(2026-09-06 실측: /predict/model-info trained=false).
//   - '-' 를 고른 이유: 빈 문자열로 두면 Number('') === 0 이라 **옛 번들이 '한산 0%' 라는 없는
//     값을 지어낸다.** '-' 는 NaN 이라 옛 파서가 그 조각을 조용히 버린다 — 최악이라도 '정류지가
//     빠진 짧은 코스'(전부 빠지면 지금과 같은 일반 모드)이지, 거짓 숫자를 보여 주지는 않는다.
//   - 하위호환: '~' 가 없는 옛 포맷은 공유 시각 미상(sharedAtMin=null)으로 파싱된다.

export interface ShareStop {
  id: string;
  offsetMin: number; // 도착까지 남은 분(공유 시점 기준 오프셋, 반올림해 인코딩)
  congestion: number | null; // 예측 혼잡도 0~1(0~100 정수로 축약). 미상은 null → '-'.
}

export interface ParsedShareStop {
  id: string;
  offsetMin: number; // 분 단위, 정수로 복원
  congestion: number | null; // 0~1 로 복원. '-' 였으면 null(모르는 것을 0 으로 채우지 않는다).
}

export interface ParsedShare {
  stops: ParsedShareStop[];
  sharedAtMin: number | null; // 공유 생성 시각(epoch 분). 옛 포맷/파싱 실패 시 null.
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 정류지 배열 → 's' 쿼리 파라미터 값. URL 에 넣을 때는 encodeURIComponent 로 감쌀 것. */
export function encodeStops(stops: ShareStop[]): string {
  const body = stops
    .map((s) => {
      const cong = s.congestion == null ? '-' : String(Math.round(clamp01(s.congestion) * 100));
      return `${s.id}.${Math.round(s.offsetMin)}.${cong}`;
    })
    .join(',');
  const sharedAtMin = Math.floor(Date.now() / 60_000);
  return `${sharedAtMin}~${body}`;
}

/**
 * 's' 쿼리 파라미터 값 → { 정류지 배열, 공유 시각 }. useSearchParams().get('s') 는 이미 디코딩된
 * 문자열을 반환하므로 별도 decodeURIComponent 는 필요 없다. 형식이 어긋난 조각은 조용히 걸러낸다
 * (깨진 공유 링크 하나가 전체 파싱을 막지 않도록).
 */
export function parseShareParam(s: string | null | undefined): ParsedShare {
  if (!s) return { stops: [], sharedAtMin: null };

  // 공유 시각 프리픽스 분리('~' 1회 분할). 없으면 옛 포맷 — 시각 미상으로 처리.
  let sharedAtMin: number | null = null;
  let body = s;
  const sep = s.indexOf('~');
  if (sep > 0) {
    const tRaw = Number(s.slice(0, sep));
    if (Number.isFinite(tRaw) && tRaw > 0) sharedAtMin = Math.floor(tRaw);
    body = s.slice(sep + 1);
  }

  const stops = body
    .split(',')
    .map((chunk): ParsedShareStop | null => {
      const parts = chunk.split('.');
      if (parts.length !== 3) return null;
      const [id, offsetRaw, congRaw] = parts;
      const offsetMin = Number(offsetRaw);
      if (!id || !Number.isFinite(offsetMin)) return null;
      if (congRaw === '-') return { id, offsetMin, congestion: null };
      const cong100 = Number(congRaw);
      // 빈 문자열은 Number('') === 0 이라 여기서 걸러야 한다 — 안 그러면 '한산 0%' 가 만들어진다.
      if (congRaw === '' || !Number.isFinite(cong100)) return null;
      return { id, offsetMin, congestion: clamp01(cong100 / 100) };
    })
    .filter((x): x is ParsedShareStop => x !== null);

  return { stops, sharedAtMin };
}
