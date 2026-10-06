// 권역 주차 수요 전망 곡선 — GET /api/v1/area-demand/forecast 를 앞으로 몇 시간의 정시마다
// 훑어 "KST 정시 → 수요(0~1)" 맵으로 만든다. /waiting 보드의 '한산해지는 시각'이 이 곡선을 읽는다.
//
// 이 엔드포인트는 공개 GET 이고(인증 불필요), 과거 동일 시간대 표본이 모자라면 숫자를 만들지 않고
// `available=false` 로 정직하게 빈손을 돌려준다. 그래서 여기서도 없는 시각은 맵에 넣지 않는다 —
// 모르는 시간대를 0 으로 채우면 '한산해지는 시각'이 거짓으로 당겨진다.
//
// 서버 창: 도착이 지금+30분 ~ 지금+6시간 안이어야 한다(밖이면 422). 여기서는 양끝에 2분씩 여유
// (응답 지연·폰 시계 오차)를 두고 [지금+32분, 지금+6시간−2분] 안으로 정시를 **당겨** 묻는다.
// 전망은 분 해상도라 13:17 에 물어도 13시 전망이다 — 다만 당긴 시각이 30분 이상 움직이면 다른
// 정시로 반올림되므로 그 정시는 건너뛴다(forecastArrivalTimes). 그래서 'now' 모드는 몇 분이든
// 6점이 정상이고(분 58·59 에는 다음 정시가 서버 창 밖이라 한 칸 밀린다), 먼 프리셋은 0점이다.
// 적게 나와도 괜찮다 — 호출부는 내장 시간대 곡선으로 계속 동작한다.
//
// 호출 순서: 첫 시각 1개를 먼저 기다린 뒤(서버의 격자 캐시·백테스트 캐시를 데운다) 나머지를
// 최대 3개 동시로 묻는다. 예전에는 동시 요청이 503 을 내서 순차로 불렀는데, 그 원인(공유 HTTP/2
// 전송)은 bd44110 에서 고쳐졌다. 선행 1회가 없으면 차가운 동시 요청마다 서버 스레드가 백테스트를
// 기다리며 묶인다. 같은 이유로 선행이 전망을 돌려주지 못했으면(시간 초과·오류·미가용 — 캐시가 데워졌다는
// 증거가 없다) 나머지는 하나씩 묻는다.
//
// noRetry: 곡선은 부가 정보다. 전송 계층의 700ms 네트워크 재시도를 끄는 이유는 Cloudflare 가
// 막은 묶음 요청이 3개의 동시 재시도로 되돌아오지 않게 하려는 것이다(B4).

import { apiClient } from "@/lib/api-client";
import { REGION } from "@/lib/region";

/** KST 정시(0~23) → 권역 수요(0~1). 표본이 없는 시각은 아예 키가 없다. */
export type AreaDemandCurve = Record<number, number>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** 서버 창(30분~6시간)에 양끝 2분 여유를 둔 값. */
const WINDOW_MIN_MS = 32 * MINUTE_MS;
const WINDOW_MAX_MS = 6 * HOUR_MS - 2 * MINUTE_MS;
/** 당긴 시각이 이만큼 움직이면 다른 정시로 반올림된다 — 그 정시는 묻지 않는다. */
const MAX_SHIFT_MS = 30 * MINUTE_MS;
const MAX_POINTS = 6;
const CANDIDATES = 7;
/** 선행 1회 뒤 동시에 묻는 최대 수. */
const FAN_OUT = 3;

interface ForecastResponse {
  available?: boolean;
  forecast?: { level?: number | null } | null;
}

export interface ForecastArrival {
  /** 곡선 키 — 당기기 전 정시의 KST 시(0~23). */
  hourKst: number;
  /** 실제로 묻는 도착 시각(서버 창 안으로 당긴 값). */
  at: Date;
}

/**
 * baseAt 이후(정시면 그 정시부터) 정시들을 서버 창 안으로 당겨 최대 6개 고른다. 순수 함수.
 * - 'now' 12:45 → 13(13:17 에 묻는다), 14…18.   - 12:58/12:59 → 14…19(13 은 반올림이 14 가 된다).
 * - 프리셋 15:00 을 12:10 에 열면 → 15, 16, 17, 18.   - 6시간보다 먼 프리셋 → [].
 */
export function forecastArrivalTimes(baseAt: Date, nowMs: number): ForecastArrival[] {
  const lo = nowMs + WINDOW_MIN_MS;
  const hi = nowMs + WINDOW_MAX_MS;
  // KST 는 UTC 와 정시 단위로 어긋나므로 UTC 에서 올림한 정시가 곧 KST 정시다.
  const first = Math.ceil(baseAt.getTime() / HOUR_MS) * HOUR_MS;
  const out: ForecastArrival[] = [];
  for (let i = 0; i < CANDIDATES && out.length < MAX_POINTS; i++) {
    const t = first + i * HOUR_MS;
    const at = Math.min(hi, Math.max(lo, t));
    if (Math.abs(at - t) >= MAX_SHIFT_MS) continue;
    out.push({ hourKst: new Date(t + KST_OFFSET_MS).getUTCHours(), at: new Date(at) });
  }
  return out;
}

/** 기준 시각별로 모아 둔 곡선에서 지금 기준의 것만 꺼낸다. 다른 기준의 곡선은 절대 쓰지 않는다. */
export function curveForBase(curves: Record<string, AreaDemandCurve>, baseKey: string): AreaDemandCurve | null {
  const curve = Object.prototype.hasOwnProperty.call(curves, baseKey) ? curves[baseKey] : undefined;
  return curve && Object.keys(curve).length > 0 ? curve : null;
}

/**
 * 새로 받은 곡선을 기준 시각별 맵에 넣는다. 순수 함수 — 바뀔 것이 없으면 prev 를 그대로 돌려준다.
 * - 빈 재조회(예: 프리셋을 바꿨다 돌아왔는데 전망 서버가 5xx)는 같은 기준의 좋은 곡선을 지우지 않는다.
 * - 그 기준에 아직 아무것도 없으면 빈 곡선도 넣는다('알고 보니 없음' — 다시 묻지 않고 내장 곡선을 쓴다).
 * - 다른 기준의 곡선은 건드리지 않는다.
 */
export function mergeAreaCurve(
  prev: Record<string, AreaDemandCurve>,
  baseKey: string,
  curve: AreaDemandCurve,
): Record<string, AreaDemandCurve> {
  const known = Object.prototype.hasOwnProperty.call(prev, baseKey);
  if (Object.keys(curve).length === 0 && known) return prev;
  return { ...prev, [baseKey]: curve };
}

/**
 * 기준 시각(baseAt)부터 앞으로 6시간의 정시 권역 수요를 모은다.
 * 실패·미가용은 조용히 건너뛴다 — 부분만 채워진 곡선도 그대로 쓸모가 있다.
 */
export async function fetchAreaDemandCurve(
  lat: number,
  lng: number,
  baseAt: Date = new Date(),
  signal?: AbortSignal,
  nowMs: number = Date.now(),
): Promise<AreaDemandCurve> {
  const curve: AreaDemandCurve = {};
  const points = forecastArrivalTimes(baseAt, nowMs);
  if (points.length === 0 || signal?.aborted) return curve;

  /** 전망 값을 받았으면(available=true) 참. 실패·미가용은 거짓 — 그 시각만 비워 두고 계속한다. */
  const fetchOne = async ({ hourKst, at }: ForecastArrival): Promise<boolean> => {
    try {
      const data: ForecastResponse = await apiClient.get("/api/v1/area-demand/forecast", {
        params: { lat: String(lat), lng: String(lng), arrivalAt: at.toISOString() },
        timeoutMs: 8000,
        signal,
        noRetry: true,
      });
      const level = data?.forecast?.level;
      if (data?.available && typeof level === "number" && Number.isFinite(level)) {
        curve[hourKst] = Math.min(1, Math.max(0, level));
      }
      return data?.available === true;
    } catch {
      /* 표본 부족·일시 장애 — 이 시각만 비워 두고 계속 진행한다 */
      return false;
    }
  };

  // 선행 1회: 서버 캐시를 데운다. 선행이 전망을 돌려줬을 때만(캐시가 데워졌다는 증거) 나머지를 최대
  // 3개씩 동시에 묻는다. 선행이 시간 초과·오류·미가용이면 서버가 아직 그 계산을 붙들고 있거나 캐시가
  // 차갑다 — 동시 요청마다 스레드가 묶이므로 하나씩 묻는다(예전 순차 루프와 같은 부하).
  const leadWarm = await fetchOne(points[0]);
  const rest = points.slice(1);
  let next = 0;
  const worker = async () => {
    while (next < rest.length) {
      if (signal?.aborted) return;
      const point = rest[next++];
      await fetchOne(point);
    }
  };
  const width = leadWarm ? Math.min(FAN_OUT, rest.length) : Math.min(1, rest.length);
  await Promise.all(Array.from({ length: width }, worker));
  return curve;
}

// ── 세션 공용 권역 곡선(교차 레인 계약 3 · 계획 3.2 예산) ─────────────────────────────────────────
//
// /main 의 혼잡 예측 시간 줄(B3)과 /waiting 이 **같은 곡선**을 쓴다: 경주 중심(REGION.center) 기준 '지금' 곡선을
// 한 세션(탭)에 한 번만 묻고 모듈 안에 들고 있는다. 심사 한 번의 차가운 여정에서 Render 호출을 12회 안에 두려는
// 예산이다. 기준 정시(KST)가 바뀌면 새로 묻는다(다른 시각의 곡선을 쓰지 않는다 — curveForBase 와 같은 원칙).
// 실패하거나 빈 곡선이면 담아 두지 않는다 — 다음에 다시 묻는다(서버가 깨어난 뒤 곡선이 생길 수 있다).
// 이 함수의 모양(인자·반환)은 다른 레인이 가져다 쓴다 — 바꾸지 말고 옵션을 더한다.

type CurveFetcher = typeof fetchAreaDemandCurve;
const sessionCurves = new Map<string, Promise<AreaDemandCurve>>();

/** 지금 정시 기준 경주 중심 권역 곡선 — 같은 정시 안에서는 요청 한 번을 공유한다. */
export function sessionAreaDemandCurve(nowMs: number = Date.now(), fetcher: CurveFetcher = fetchAreaDemandCurve): Promise<AreaDemandCurve> {
  const key = String(Math.floor(nowMs / HOUR_MS));
  const cached = sessionCurves.get(key);
  if (cached) return cached;
  const pending = fetcher(REGION.center.lat, REGION.center.lng, new Date(nowMs), undefined, nowMs).then(
    (curve) => {
      if (Object.keys(curve).length === 0) sessionCurves.delete(key);
      return curve;
    },
    (error: unknown) => {
      sessionCurves.delete(key);
      throw error;
    },
  );
  sessionCurves.set(key, pending);
  return pending;
}

/** 테스트 전용 — 모듈 캐시를 비운다. */
export function resetSessionAreaDemandCurve(): void {
  sessionCurves.clear();
}
