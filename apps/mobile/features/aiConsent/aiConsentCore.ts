// 외부 AI 전송 허용 기록 — 순수 모듈(저장소 주입, 테스트: aiConsentCore.test.ts).
//
// 왜: App Store 심사 지침 5.1.2(i) — 개인 데이터를 제3자 AI 에 보내기 전에 알리고 명시적으로 허락을 받는다.
// 앱이 사용자가 입력한 문장을 서버(우리 API)를 거쳐 외부 LLM(Upstage Solar — apps/api/app/core/config.py
// LLM_BASE_URL·LLM_MODEL, 전체 스위치 LLM_ENABLED)으로 보내는 길은 셋이다:
//   1. 홈 검색 0건 폴백 GET /api/v1/search/keyword — 관광공사 검색도 0건이면 서버가 검색어를 LLM 으로 다시 쓴다(search.py).
//   2. 여행 중 '상황 변경' 자유 문장 POST /api/v1/travel-context/parse(travel_context_parser.py).
//   3. 나의 실험실 '직접 설명하기' POST /api/v1/lab/{id}/reason/classify(lab.py).
// 셋 다 이 기록이 'granted' 일 때만 보낸다. API 에는 LLM 만 끄는 옵션이 없어, 거절하면 1 은 /search/keyword 를 아예
// 부르지 않고(카카오 장소 검색 /search/places 만), 2·3 은 자유 입력 칸을 끄고 칩만 쓴다.
//
// 기기 단위로 둔다(위치 동의와 같다 — USER_SCOPED_KEYS 에 넣지 않는다). 받는 곳·목적이 바뀌면 판(AI_CONSENT_VERSION)을
// 올려 다시 묻는다(예전 판 기록은 '아직 안 정함').

export const AI_CONSENT_KEY = 'nextspot_ai_consent';
/** 안내 문구(받는 곳 · 목적)의 판. 문구나 받는 업체가 바뀌면 올린다. */
export const AI_CONSENT_VERSION = '2026-11-v1';

export type AiConsentDecision = 'granted' | 'declined';
export type AiConsentStatus = AiConsentDecision | 'unknown';

export interface AiConsentRecord {
  decision: AiConsentDecision;
  version: string;
  /** ISO 시각. */
  decidedAt: string;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isRecord(v: unknown): v is AiConsentRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<AiConsentRecord>;
  return (
    (r.decision === 'granted' || r.decision === 'declined') &&
    typeof r.version === 'string' &&
    typeof r.decidedAt === 'string'
  );
}

/** 현재 판의 기록. 없거나 손상·옛 판이면 null. */
export function readAiConsent(store: Store | null): AiConsentRecord | null {
  if (!store) return null;
  try {
    const raw = store.getItem(AI_CONSENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== AI_CONSENT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 'granted' · 'declined' · 'unknown'(아직 안 정함). 저장소를 못 읽으면 'unknown' — 보내지 않는 쪽으로 닫힌다. */
export function aiConsentStatusIn(store: Store | null): AiConsentStatus {
  return readAiConsent(store)?.decision ?? 'unknown';
}

/** 외부 AI 로 보내도 되는가. 'granted' 일 때만 true. */
export function canSendToAiIn(store: Store | null): boolean {
  return aiConsentStatusIn(store) === 'granted';
}

/** 결정을 적는다. 저장하고 다시 읽어 같은 값이면 true. */
export function writeAiConsent(store: Store | null, decision: AiConsentDecision, now: Date): boolean {
  if (!store) return false;
  const record: AiConsentRecord = { decision, version: AI_CONSENT_VERSION, decidedAt: now.toISOString() };
  try {
    store.setItem(AI_CONSENT_KEY, JSON.stringify(record));
    return readAiConsent(store)?.decision === decision;
  } catch {
    return false;
  }
}

/** 기록을 지운다 — 다음 사용 때 다시 묻는다. */
export function clearAiConsentIn(store: Store | null): void {
  if (!store) return;
  try {
    store.removeItem(AI_CONSENT_KEY);
  } catch {
    /* 무시 */
  }
}
