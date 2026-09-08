// 관리자 API 조회 실패 → 관리자가 **지금 무엇을 하면 되는지** 아는 문장.
//
// 왜 필요한가: 실패 문구가 서버가 던진 원문 한 줄이었다. 관리자 화면에는 이런 게 떴다.
//
//   조회: 인증 헤더(Authorization 또는 X-Forwarded-Authorization)가 누락되었거나 …
//   추천 이력: 알 수 없는 오류
//   추천 이력: 지표 조회에 실패했습니다.
//
// 셋 다 사실이지만 셋 다 **행동을 지시하지 않는다.** 첫 줄은 다시 로그인하면 풀리고,
// 둘째 줄은 서버가 자느라 8초 안에 못 깨어난 것이라 한 번 더 누르면 되고, 셋째 줄은
// 우리가 고쳐야 하는 서버 장애다 — 관리자가 할 일이 전부 다른데 화면은 구분해 주지 않았다.
// (특히 둘째 줄: 타임아웃은 DOMException 으로 튀어나오는데 DOMException 은 Error 가
//  아니라서 lib/errors.ts 의 errorMessage 가 undefined 를 돌려준다 → '알 수 없는 오류'.)
//
// 판정을 렌더에서 떼어 여기 두는 이유는 이 저장소의 다른 관리자 판정들과 같다
// (lib/adminLoadState.ts, lib/adminGuardrailWarnings.ts): React 렌더 테스트 러너가 없어서
// 화면 분기는 아무도 검사해 주지 않는다. 한 칸 틀리면 '권한 없음' 이 '다시 시도' 로 보이고,
// 관리자는 될 리 없는 버튼을 계속 누른다.
//
// ⚠️ 상태 코드를 삼키지 않는다. 매핑에 없는 상태는 숨기는 대신 숫자를 그대로 보여준다
// (adminGuardrailWarnings 가 모르는 경고 코드를 원문 노출하는 것과 같은 이유).

/** 요청이 실패한 방식. HTTP 상태만으로는 갈라지지 않는 것들이 있다. */
export type AdminFailureKind =
  | 'no-session'  // 요청을 보내지도 못했다 — 로컬에 Supabase 세션이 없다
  | 'timeout'     // 우리가 건 타임아웃에 걸렸다(서버는 아직 답하는 중일 수도 있다)
  | 'network'     // 연결 자체가 안 됐다(오프라인·CORS·DNS)
  | 'http';       // 서버가 답은 했고 상태 코드가 있다

export interface AdminFailureInput {
  kind?: AdminFailureKind | null;
  /** 서버가 준 HTTP 상태. 없으면 null — **0 으로 채우지 않는다**(0 은 상태가 아니다). */
  status?: number | null;
  /** 서버/예외가 준 원문. 관리자에게 보여줄 문장이 아니라 근거로 붙인다. */
  message?: string | null;
}

export interface AdminFailureNotice {
  /** 무슨 일이 일어났는가(관리자 언어). */
  title: string;
  /** 지금 무엇을 하면 되는가. */
  action: string;
  /** 로그인으로 보낼 경로. 재시도로 풀리지 않는 실패에만 붙는다. */
  href: string | null;
  /** '다시 시도' 버튼을 보일 것인가. 401/403 에 붙이면 될 리 없는 버튼이 된다. */
  retryable: boolean;
  /** 원문 근거(HTTP 상태 · 서버 detail). 숨기지 않되 앞세우지도 않는다. */
  detail: string | null;
}

/** 관리자 진입 경로. /admin/login 이 '미로그인'과 '권한 부족'을 각각 안내한다. */
export const ADMIN_LOGIN_PATH = '/admin/login';

function normalizeMessage(message: string | null | undefined): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDetail(status: number | null, message: string | null): string | null {
  if (status !== null && message) return `HTTP ${status} · ${message}`;
  if (status !== null) return `HTTP ${status}`;
  return message;
}

/**
 * 메시지 문자열에서 실패 종류를 짐작한다 — **HTTP 상태가 없는 경로 전용.**
 *
 * Supabase(PostgREST) 클라이언트는 오류를 `{message, code, details}` 로 돌려주고 HTTP 상태를
 * 넘겨주지 않는다. 그래도 '시간 초과' 만은 갈라내야 한다: lib/supabase.ts 가 6초에 abort 하므로
 * 그 실패는 다시 누르면 풀릴 수 있는 종류인데, 뭉뚱그리면 '알 수 없는 오류' 로 끝난다.
 *
 * 짐작이므로 확신할 수 없으면 null 을 돌려 일반 문구로 떨어뜨린다 — 틀린 지시보다 낫다.
 */
export function kindFromMessage(message: string | null | undefined): AdminFailureKind | null {
  const text = normalizeMessage(message);
  if (!text) return null;
  if (/abort|시간이? 초과|timeout|timed out/i.test(text)) return 'timeout';
  if (/failed to fetch|networkerror|network error|load failed|fetch failed|err_/i.test(text)) return 'network';
  return null;
}

/**
 * 실패 하나를 '읽고 행동할 수 있는' 안내로 바꾼다.
 *
 * 우선순위가 중요하다: 세션·권한(401/403)이 먼저다. 이 둘은 **재시도로 절대 풀리지 않기**
 * 때문에 '다시 시도' 를 붙이면 안 된다. 그 다음이 우리가 건 타임아웃/연결 실패(재시도 가능),
 * 마지막이 서버 상태 코드다.
 */
export function describeAdminFailure(input: AdminFailureInput): AdminFailureNotice {
  const status =
    typeof input.status === 'number' && Number.isFinite(input.status) ? input.status : null;
  const message = normalizeMessage(input.message);
  const detail = buildDetail(status, message);
  const kind = input.kind ?? null;

  // 세션이 아예 없는 것과 서버가 401 을 준 것은 원인이 다르지만 관리자가 할 일은 같다.
  if (kind === 'no-session' || status === 401) {
    return {
      title: '관리자 로그인이 만료됐어요',
      action: '다시 로그인해 주세요.',
      href: ADMIN_LOGIN_PATH,
      retryable: false,
      detail,
    };
  }
  if (status === 403) {
    return {
      title: '이 계정에는 관리자 권한이 없어요',
      action: '관리자 권한이 있는 계정으로 로그인하거나, 담당자에게 권한을 요청해 주세요.',
      href: ADMIN_LOGIN_PATH,
      retryable: false,
      detail,
    };
  }
  if (kind === 'timeout') {
    return {
      title: '서버 응답이 늦어요 (콜드 스타트일 수 있어요)',
      action: '서버가 잠들어 있었다면 첫 요청이 깨웁니다 — 30초쯤 뒤에 다시 시도해 주세요.',
      href: null,
      retryable: true,
      detail,
    };
  }
  if (kind === 'network') {
    return {
      title: '서버에 연결하지 못했어요',
      action: '네트워크 상태를 확인한 뒤 다시 시도해 주세요.',
      href: null,
      retryable: true,
      detail,
    };
  }
  if (status !== null && status >= 500) {
    return {
      title: `서버 오류예요 (HTTP ${status})`,
      action: '서버 쪽 문제입니다 — 다시 시도해 보고, 계속되면 개발팀에 위 상태 코드를 알려 주세요.',
      href: null,
      retryable: true,
      detail,
    };
  }
  if (status !== null) {
    // 매핑에 없는 상태(404·422·429…). 지어내지 말고 숫자를 그대로 넘긴다.
    return {
      title: `요청이 거부됐어요 (HTTP ${status})`,
      action: '다시 시도해 보고, 계속되면 개발팀에 위 상태 코드를 알려 주세요.',
      href: null,
      retryable: true,
      detail,
    };
  }
  return {
    title: '알 수 없는 이유로 불러오지 못했어요',
    action: '다시 시도해 보고, 계속되면 개발팀에 아래 내용을 알려 주세요.',
    href: null,
    retryable: true,
    detail,
  };
}

/**
 * 안내를 한 줄로 압축한다(CSV 주석·title 속성처럼 줄바꿈을 못 쓰는 자리용).
 * 여기서도 detail 을 버리지 않는다 — 파일로 빠져나간 수치의 유일한 출처 표시다.
 */
export function adminFailureLine(notice: AdminFailureNotice): string {
  const base = `${notice.title} — ${notice.action}`;
  return notice.detail ? `${base} (${notice.detail})` : base;
}
