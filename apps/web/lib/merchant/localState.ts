// 사장님 콘솔의 **기기 로컬 상태**만 담당한다 — 인증은 더 이상 여기 없다.
//
// 예전에는 번들에 박힌 단일 비밀번호로 게이트를 열고, 공유 토큰(X-Merchant-Token)을
// localStorage 세션으로 들고 다녔다. 그 방식은 코드 주석 스스로 "실제 보안 경계가 아니다" 라고
// 적을 만큼 약했고, 통과하면 **전체 시설 중 아무 가게나** 다룰 수 있었다.
//
// 이제 인증은 Supabase JWT 하나이고(lib/account.tsx · app/core/authz.py), 다룰 수 있는 가게는
// facility_owners 가 정한다. 여기 남는 것은 "이 기기에서 마지막으로 고른 가게" 뿐이다 —
// 권한이 아니라 편의용 값이라 위조돼도 서버가 403 으로 막는다.

const FACILITY_KEY = "nextspot_merchant_facility";
// 구 비밀번호 세션 키. 남아 있으면 지우기만 한다(권한으로 쓰지 않는다).
const LEGACY_SESSION_KEY = "nextspot_merchant_session";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export interface MerchantFacility {
  id: string;
  name: string;
  type: string;
  couponRate: number;
}

/** 마지막으로 선택한 가게를 저장한다(가게 전환 시 화면 라벨용). */
export function saveMerchantFacility(facility: MerchantFacility): void {
  if (!hasWindow()) return;
  try {
    localStorage.setItem(FACILITY_KEY, JSON.stringify(facility));
  } catch {
    /* localStorage 차단(시크릿 등) 환경 — 무시 */
  }
}

/** 저장된 가게. 없거나 손상된 값이면 null. */
export function getMerchantFacility(): MerchantFacility | null {
  if (!hasWindow()) return null;
  try {
    const raw = localStorage.getItem(FACILITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string" && typeof parsed.name === "string") {
      return parsed as MerchantFacility;
    }
    return null;
  } catch {
    return null;
  }
}

/** 선택한 가게 해제 — 대시보드의 '다른 가게 선택'에서 사용. */
export function clearMerchantFacility(): void {
  if (!hasWindow()) return;
  try {
    localStorage.removeItem(FACILITY_KEY);
  } catch {
    /* 무시 */
  }
}

/**
 * 구 비밀번호 세션 흔적 제거.
 *
 * 이전 버전을 쓰던 브라우저에는 아직 세션 플래그가 남아 있다. 값 자체는 이제 아무 권한도
 * 주지 않지만, 남겨 두면 '로그인된 것처럼 보이는' 흔적이라 콘솔 진입 시 한 번 지운다.
 */
export function clearLegacyMerchantSession(): void {
  if (!hasWindow()) return;
  try {
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    /* 무시 */
  }
}
