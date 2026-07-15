// 사장님 콘솔(머천트) 인증 — 데모/프로토타입용 단일 비밀번호 게이트(apps/web/lib/admin-auth.ts 패턴 미러).
//
// ⚠️ 보안 주의: 이 방식은 클라이언트 측 데모 게이트일 뿐 실제 사업자 인증이 아니다.
//    비밀번호가 번들에 포함되며, 누구나 우회할 수 있다. 실서비스는 사업자등록번호 확인 등
//    실제 사업자 인증 연동이 필요하다(게이트 화면에 이 사실을 정직하게 라벨로 안내한다).
//    진짜 권한이 필요한 백엔드 작업은 서버(require_merchant, X-Merchant-Token)가 별도로 검증한다.

const SESSION_KEY = "nextspot_merchant_session";
const FACILITY_KEY = "nextspot_merchant_facility";

// 데모 기본값 유지 + 빌드 타임 env 로 오버라이드 가능.
const MERCHANT_PASSWORD = process.env.NEXT_PUBLIC_MERCHANT_PASSWORD || "merchant";

// 백엔드 apps/api MERCHANT_API_TOKEN 의 기본값과 동일한 문자열.
// MVP 스코프: 이번 사이클은 신규 env 를 MERCHANT_API_TOKEN(백엔드)·NEXT_PUBLIC_MERCHANT_PASSWORD(프런트)
// 2종으로 제한한다 — 별도의 NEXT_PUBLIC_MERCHANT_API_TOKEN env 오버라이드는 두지 않는다.
// 따라서 배포 환경에서 백엔드 MERCHANT_API_TOKEN 을 기본값에서 바꾸면, 이 상수도 함께 갱신해야
// 사장님 콘솔이 계속 인증된다(2단계에서 env 오버라이드 도입 검토 — docs/HANDOVER.md 참고).
const SESSION_TOKEN = "nextspot-merchant-local";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export interface MerchantFacility {
  id: string;
  name: string;
  type: string;
  couponRate: number;
}

/** 비밀번호로 로그인. 일치하면 세션을 저장하고 true, 아니면 false. */
export function signInWithMerchantPassword(password: string): boolean {
  if (password !== MERCHANT_PASSWORD) return false;
  if (hasWindow()) {
    try {
      localStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* localStorage 차단(시크릿 등) 환경 — 무시 */
    }
  }
  return true;
}

/** 현재 사장님 세션 여부(동기). */
export function isMerchantAuthed(): boolean {
  if (!hasWindow()) return false;
  try {
    return localStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

/** 백엔드 호출용 토큰(X-Merchant-Token 헤더 값). 세션이 없으면 null. */
export function getMerchantToken(): string | null {
  return isMerchantAuthed() ? SESSION_TOKEN : null;
}

/** 선택한 내 가게(시설)를 저장한다. */
export function saveMerchantFacility(facility: MerchantFacility): void {
  if (!hasWindow()) return;
  try {
    localStorage.setItem(FACILITY_KEY, JSON.stringify(facility));
  } catch {
    /* 무시 */
  }
}

/** 저장된 내 가게(시설) — 없거나 손상된 값이면 null. */
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

/** 로그아웃 — 세션+선택 시설 모두 제거. */
export function signOutMerchant(): void {
  if (!hasWindow()) return;
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(FACILITY_KEY);
  } catch {
    /* 무시 */
  }
}

/** 시설만 바꾸고 싶을 때(세션은 유지) — 대시보드의 '다른 가게 선택'에서 사용. */
export function clearMerchantFacility(): void {
  if (!hasWindow()) return;
  try {
    localStorage.removeItem(FACILITY_KEY);
  } catch {
    /* 무시 */
  }
}
