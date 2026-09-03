// Web Speech API(STT) 앰비언트 타입 선언.
//
// 왜 필요한가: TypeScript 5.9 의 lib.dom.d.ts 는 결과 타입(SpeechRecognitionAlternative /
// SpeechRecognitionResult / SpeechRecognitionResultList)만 선언하고, 정작 인식기 본체인
// `SpeechRecognition` 과 이벤트 타입(SpeechRecognitionEvent / SpeechRecognitionErrorEvent),
// 그리고 웹킷 접두 생성자(`webkitSpeechRecognition`)는 선언하지 않는다. 그래서 STT 를 쓰는
// 코드가 전부 `(window as any).SpeechRecognition` / `(e: any)` 로 빠져 있었다.
//
// 이 파일은 타입 선언만 있고 런타임 코드가 없다(.d.ts) — 동작은 1비트도 바뀌지 않는다.
// 선언 범위는 이 저장소가 실제로 쓰는 표면으로 한정했다(전체 스펙 미러가 목적이 아니다):
//   lib/voice/useSpeechSearch.ts · lib/voice/useVoiceAssistant.ts · app/explore/recommend/page.tsx
//
// 표준화 상태: Web Speech API 는 W3C 정식 표준이 아니라 Community Group 리포트라
// lib.dom 에 본체가 없다. 브라우저 지원도 갈려서(webkit 접두 필요) 런타임 감지는 그대로
// 유지해야 한다 — 이 선언이 있다고 해서 `window.SpeechRecognition` 이 항상 존재하지는
// 않는다. 그래서 아래 Window 확장은 두 생성자를 **optional** 로 둔다.

/** 인식 결과 이벤트 — results 는 lib.dom 이 이미 선언한 SpeechRecognitionResultList 를 재사용한다. */
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

/**
 * 인식 실패 이벤트. `error` 는 스펙상 문자열 열거값이다.
 * 호출부가 분기하는 코드: 'not-allowed'·'service-not-allowed'(권한 거부) / 'aborted'(사용자 취소,
 * 정상 흐름이라 무시) / 그 외는 일반 실패로 묶는다.
 */
type SpeechRecognitionErrorCode =
  | "aborted"
  | "audio-capture"
  | "bad-grammar"
  | "language-not-supported"
  | "network"
  | "no-speech"
  | "not-allowed"
  | "service-not-allowed";

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: SpeechRecognitionErrorCode;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;

  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
  onstart: ((event: Event) => void) | null;
  onspeechend: ((event: Event) => void) | null;
  onnomatch: ((event: SpeechRecognitionEvent) => void) | null;

  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
  prototype: SpeechRecognition;
}

interface Window {
  /** 미지원 브라우저에서는 undefined — 반드시 런타임 감지 후 사용할 것. */
  SpeechRecognition?: SpeechRecognitionConstructor;
  /** Chromium/Safari 계열의 접두 구현. 위와 동일하게 optional. */
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
