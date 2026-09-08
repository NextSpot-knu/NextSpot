// 운영자 공지 배너의 '닫기' 를 기기에 기억한다.
//
// 왜 필요한가: 닫기 상태가 컴포넌트 state 라 **새로고침하면 배너가 다시 떴다.** 관광객 앱은
// 화면을 자주 오가므로 같은 문장을 계속 다시 닫아야 했다.
//
// ⚠️ 여기서 가장 중요한 결정: **공지 내용으로 키를 만든다.** 단순 불리언("한 번 닫았음")으로
// 기억하면, 한 번 닫은 사용자는 그 뒤에 올라온 **진짜 공지(축제 통제·점검 예정)를 영영 못
// 본다.** 공지 채널을 스스로 막아 버리는 셈이고, 그건 이 저장소가 계속 잡아 온 '화면이
// 사실을 말하지 않는' 결함과 같은 모양이다. 그래서 문구가 바뀌면 다시 보여 준다.
//
// 문구를 그대로 저장하는 이유(해시 대신): 해시는 충돌하면 **새 공지를 조용히 숨긴다** — 드물지만
// 실패 방향이 나쁘다. 서버가 `notice_text` 를 500자로 제한하므로(admin.py) 원문을 담아도 부담이
// 없고, 저장된 값을 눈으로 보면 왜 안 뜨는지 바로 알 수 있다.
//
// 저장소 접근은 전부 try/catch 다 — 사파리 프라이빗·저장소 차단 브라우저에서 throw 하면
// 그 자리에서 배너 렌더가 통째로 죽는다.

const STORAGE_KEY = 'nextspot_notice_dismissed';

/** 이 기기에서 마지막으로 닫은 공지 문구. 없으면 null. */
export function readDismissedNotice(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 이 문구를 닫은 것으로 기록한다. 실패는 무시한다(다음 방문에 다시 뜰 뿐이다). */
export function writeDismissedNotice(noticeText: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, noticeText);
  } catch {
    /* 저장소가 막힌 브라우저 — 기억하지 못할 뿐, 배너는 정상 동작한다 */
  }
}

/**
 * 지금 공지를 보여 줘야 하는가.
 *
 * 빈 공지는 애초에 보여 줄 것이 없다. 닫은 문구와 **정확히 같을 때만** 숨긴다 —
 * 한 글자라도 다르면 새 공지로 보고 다시 띄운다.
 */
export function shouldShowNotice(noticeText: string, dismissed: string | null): boolean {
  if (noticeText === '') return false;
  return dismissed !== noticeText;
}
