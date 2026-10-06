// 혼잡 예측 모델이 학습돼 있는가 — 세션당 한 번 GET /predict/model-info 로 묻고 그 답을 함께 쓴다.
//
// 왜 필요한가: 추천 카드는 '상세 정보 펼치기' 마다 GET /predict/day 를 불렀는데, 모델이 학습되지 않은
// 배포 환경(현재 상시 상태 — model-info trained:false)에서는 그 호출이 **언제나** 503 이다. 펼칠 때마다
// 실패 요청이 하나씩 쌓였고(심사 시뮬레이션 2026-10-06 콘솔 503), 무료 플랜 API 에 쓸모없는 부하만 됐다.
// 학습 여부는 모델이 바뀌어야 바뀌므로 한 번 물으면 충분하다.
//
// 판정 함수는 lib/merchant/api.ts 의 fetchPredictModelInfo 를 옮겨 온 것이다(사장님 콘솔이 같은 질문을
// 한다). 그 파일은 사장님 콘솔 담당이 이 모듈로 옮겨 쓸 수 있게 그대로 둔다.

const BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || 'http://localhost:8000';
/** model-info 는 가벼운 메타 응답이다 — 4초를 넘기면 학습 안 됨으로 본다(예측 막대를 그리지 않을 뿐). */
const MODEL_INFO_TIMEOUT_MS = 4000;
const SESSION_KEY = 'nextspot_predict_model_trained';

/** GET /predict/model-info 의 일부. */
export interface PredictModelInfo {
  trained: boolean;
  /** 미학습 시 서버가 쓰는 폴백 이름(예: "degraded_rules"). 없으면 null. */
  fallbackState: string | null;
}

/** 응답 본문 → 판정. 모양이 어긋나면 null(=모름, 지어내지 않는다). */
export function parsePredictModelInfo(body: unknown): PredictModelInfo | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { trained?: unknown; fallback_state?: unknown; fallbackState?: unknown };
  if (typeof b.trained !== 'boolean') return null;
  const fallback = b.fallback_state ?? b.fallbackState;
  return { trained: b.trained, fallbackState: typeof fallback === 'string' ? fallback : null };
}

/** 모델 학습 여부를 서버에 직접 묻는다. 못 물어봤으면 null. */
export async function fetchPredictModelInfo(): Promise<PredictModelInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_INFO_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/predict/model-info`, { signal: controller.signal });
    if (!res.ok) return null;
    return parsePredictModelInfo(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readSession(): boolean | null {
  try {
    const value = sessionStorage.getItem(SESSION_KEY);
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch {
    return null;
  }
}

function writeSession(trained: boolean): void {
  try {
    sessionStorage.setItem(SESSION_KEY, String(trained));
  } catch {
    // 저장이 막힌 브라우저(사생활 보호 창 등)는 이 페이지 안에서만 기억한다.
  }
}

let pending: Promise<boolean> | null = null;

/**
 * 예측 모델이 학습돼 있으면 true. 세션당 한 번만 묻는다 — 같은 페이지에서는 같은 약속을 돌려주고,
 * 답(true/false)은 sessionStorage 에 남겨 새로고침에도 다시 묻지 않는다. 묻지 못했으면(네트워크·모양
 * 오류) false 로 보되 저장하지 않는다 — 다음 페이지 로드에서 다시 묻는다.
 */
export function isPredictModelTrained(
  fetchInfo: () => Promise<PredictModelInfo | null> = fetchPredictModelInfo,
): Promise<boolean> {
  if (pending) return pending;
  const stored = readSession();
  if (stored !== null) {
    pending = Promise.resolve(stored);
    return pending;
  }
  pending = fetchInfo()
    .then((info) => {
      if (!info) return false;
      writeSession(info.trained);
      return info.trained;
    })
    .catch(() => false);
  return pending;
}

/** 테스트 전용 — 세션 판정을 비운다. */
export function resetPredictModelGateForTest(): void {
  pending = null;
}
