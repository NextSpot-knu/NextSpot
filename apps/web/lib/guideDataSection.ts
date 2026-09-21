// 홈 푸터의 "데이터 출처: …" 줄 → 서비스 소개 모달의 '데이터' 절을 펼쳐서 보여주기 위한 신호.
//
// 왜 모듈 변수인가: GuideProvider 의 열기 API 는 `(trigger) => void` 하나뿐이고, 모달 본문
// (GuideContent)은 dynamic import 라 클릭 직후가 아니라 몇 프레임 뒤에 마운트된다. 푸터가
// 요청을 남기고(requestGuideDataSection) 본문이 마운트 시 한 번 소비(consume)하는 구조라야
// 그 시차를 넘길 수 있다. URL·전역 상태를 늘리지 않는 가장 작은 방법이다.
//
// 소비는 1회성이다 — 다음에 그냥 '서비스 소개' 버튼으로 열면 데이터 절은 접힌 채로 뜬다.

let pending = false;

/** 다음에 열리는 서비스 소개 모달에서 '데이터' 절을 펼쳐 달라고 요청한다. */
export function requestGuideDataSection(): void {
  pending = true;
}

/** 요청이 있었는지 확인하고 즉시 비운다(중복 스크롤 방지). */
export function consumeGuideDataSectionRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}
