// 위치정보 이용 동의 기록 — 순수 모듈(저장소 주입, 테스트: consent.test.ts). 계획 §6.2 ① · §8.2 위치정보법 · M20.
//
// 법무 확인 전에는 '동의 필요'로 가정한다(M20). 이 기록은 OS 위치 권한과 **다르다**:
//   · 이것(법적 동의): 첫 실행에 '동의' · '동의 안 함' 두 버튼 + 만 14세 이상 확인. 동의하지 않으면 앱은 위치를 아예
//     요청하지 않는다(OS 권한 창도 띄우지 않는다) — 황리단길 중심으로 추천한다.
//   · OS 권한 안내 화면(HIG 버튼 하나)과 requestForegroundPermissionsAsync 는 홈 흐름의 몫이다. 그쪽은 반드시
//     hasLocationConsent() 가 true 일 때만 진행한다.
// 동의는 약관 판(TERMS_VERSION)에 묶인다. 약관이 바뀌면 판을 올려 다시 묻는다(예전 판 동의는 '동의 없음').
// 기기 단위로 둔다(사용자 데이터 격리 USER_SCOPED_KEYS 에 넣지 않는다) — 첫 실행 화면에서 받는 것이라 계정 전환과 무관하다.
// 서버 쪽 확인자료 기록(위치정보법 제16조②)은 별도 작업(계획 §7.5)이다 — 여기는 기기 안 기록뿐이다.

export const LOCATION_CONSENT_KEY = 'nextspot_location_consent';
/**
 * 동의 화면 문구(약관 요약·전문 app.locationTerms.*)의 판. 문구를 바꾸면 올린다.
 * draft2(2026-11-02): 약관 동의 화면으로 바꾸고 전문(LocationTermsModal)을 붙였다 — draft1 동의는 다시 묻는다.
 */
export const LOCATION_TERMS_VERSION = '2026-11-draft2';
/** 위치정보법 제25조① — 만 14세 미만은 법정대리인 동의가 필요하다. 앱은 14세 이상 확인을 받은 '동의'만 인정한다. */
export const MIN_CONSENT_AGE = 14;

export type ConsentDecision = 'granted' | 'declined';

export interface LocationConsentRecord {
  decision: ConsentDecision;
  /** 만 14세 이상임을 확인했는가 — 'granted' 면 반드시 true. */
  ageConfirmed: boolean;
  termsVersion: string;
  /** ISO 시각. */
  decidedAt: string;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isRecord(v: unknown): v is LocationConsentRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<LocationConsentRecord>;
  return (
    (r.decision === 'granted' || r.decision === 'declined') &&
    typeof r.ageConfirmed === 'boolean' &&
    typeof r.termsVersion === 'string' &&
    typeof r.decidedAt === 'string'
  );
}

/** 저장된 결정(현재 약관 판의 것만). 없거나 모양이 틀리거나 판이 다르면 null — 다시 물어야 한다. */
export function readLocationConsent(store: Store | null): LocationConsentRecord | null {
  if (!store) return null;
  try {
    const raw = store.getItem(LOCATION_CONSENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.termsVersion !== LOCATION_TERMS_VERSION) return null;
    // 14세 확인 없는 '동의'는 위조·손상으로 본다.
    if (parsed.decision === 'granted' && !parsed.ageConfirmed) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 위치를 써도 되는가. **저장소를 못 읽으면 false**(동의 없음 쪽으로 닫는다).
 */
export function hasLocationConsentIn(store: Store | null): boolean {
  return readLocationConsent(store)?.decision === 'granted';
}

/** 동의·거절을 이미 했는가(첫 실행 단계 판정). */
export function hasLocationConsentDecisionIn(store: Store | null): boolean {
  return readLocationConsent(store) !== null;
}

/**
 * 결정을 적는다. 'granted' 는 ageConfirmed=true 일 때만 받는다 — 아니면 예외(화면이 버튼을 막아야 하는 경우라 조용히
 * 넘기지 않는다). 저장 실패면 false(호출부는 동의를 받지 못한 것으로 다룬다).
 */
export function writeLocationConsent(
  store: Store | null,
  decision: ConsentDecision,
  ageConfirmed: boolean,
  now: Date,
): boolean {
  if (decision === 'granted' && !ageConfirmed) {
    throw new Error('location consent requires age confirmation (14+)');
  }
  if (!store) return false;
  const record: LocationConsentRecord = {
    decision,
    ageConfirmed,
    termsVersion: LOCATION_TERMS_VERSION,
    decidedAt: now.toISOString(),
  };
  try {
    store.setItem(LOCATION_CONSENT_KEY, JSON.stringify(record));
    return readLocationConsent(store)?.decision === decision;
  } catch {
    return false;
  }
}

/** 기록을 지운다(설정의 '동의 철회' → 다음 실행에 다시 묻는다. 철회만 하려면 writeLocationConsent('declined')). */
export function clearLocationConsentIn(store: Store | null): void {
  if (!store) return;
  try {
    store.removeItem(LOCATION_CONSENT_KEY);
  } catch {
    /* 무시 */
  }
}
