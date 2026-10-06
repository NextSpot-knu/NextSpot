// 음성 비서 훅 — 단일 카드(추천) 1개를 TTS로 안내하고 STT로 응답을 받아 콜백에 위임한다.
//
// 부모(페이지)가 "현재 카드(item)"와 콜백(onAccept/onNext)을 제공하면, 이 훅이 TTS 발화 →
// STT 듣기 → 의도 분류(옵션 interpret → 백엔드 키워드 분류기) → 콜백 위임의 상태머신을 관리한다. "다음" 의도는
// onNext가 부모 상태를 바꾸면 notifyItem으로 새 카드가 자동 발화되므로 훅이 직접 다음을 말하지 않는다.
//
// 정적 export(SSR) 안전: 모든 Web Speech 접근은 이벤트/이펙트 내부 + typeof window 가드.
// 폴백 우선: TTS/STT 미지원·마이크 거부 시 graceful(데모 무중단).
import { useEffect, useRef, useState } from "react";
import type { VoiceAppCommand } from './voiceCommands';
import { pickVoice } from './speechLocale';

// TTS 는 브라우저 내장 speechSynthesis 만 사용한다.
// (대회용 Google Cloud Text-to-Speech 연동은 제거됨 — 로컬 전용·외부 의존성 0.)

export type VoiceState = "idle" | "speaking" | "listening" | "thinking";

/** 백엔드(키워드 분류기)가 해석한 음성 1턴 결과 */
export interface VoiceTurn {
  action: string; // accept|next|reject|details|select|filter|command|stop|unknown
  targetId?: string | null; // select 일 때 고른 시설 id
  matchIds?: string[]; // filter 일 때 선호에 맞는 후보 id들
  spoken?: string | null; // 백엔드 생성 한국어 응답
  // filter 매치 0건일 때 백엔드가 제안한 '유사 대안' 후보 id — spoken 이 "…안내해드릴까요?"로 물었고,
  // 다음 턴 accept 는 현재 카드 수락이 아니라 이 후보 선택(select)으로 처리한다(2턴 흐름).
  suggestionId?: string | null;
  command?: VoiceAppCommand | null;
}

/** 비서가 스스로 말하는 문장들 — 화면 언어로(계획 B5 · I21). 기본값은 예전 한국어 문장이다. */
export interface VoiceMessages {
  reprompt: string;
  acceptAck: string;
  end: string;
  similar: string;
  noMatch: string;
  applied: string;
  keepGoing: string;
  /** 무응답 두 번 뒤 닫을 때의 인사(계획 B2 · I09 — 말없이 꺼지지 않는다). */
  closing: string;
  /** 카드 없이 켰을 때 첫 질문. */
  greet: string;
}

export const DEFAULT_VOICE_MESSAGES: VoiceMessages = {
  reprompt: "수락하려면 '응', 넘기려면 '다음'이라고 말해 주세요.",
  acceptAck: "알겠어요, 여기로 안내할게요!",
  end: "음성 안내를 마칠게요.",
  similar: "비슷한 곳이 있어요. 안내해드릴까요?",
  noMatch: "다른 메뉴도 말씀해 주시면 바로 찾아드릴게요.",
  applied: "요청한 조건을 적용했어요.",
  keepGoing: "지금 추천을 그대로 이어갈게요.",
  closing: "필요하실 때 다시 불러 주세요.",
  greet: "무엇을 찾아 드릴까요? 예: “카페 보여줘”",
};

/** 카드 하나를 읽는 기본 문장 — 이유가 이미 이름을 말하면 이름을 다시 붙이지 않는다(계획 B2 · I46). */
function defaultCardSentence(name: string, reason: string): string {
  if (!reason) return `${name}. 여기로 안내할까요?`;
  return reason.includes(name) ? `${reason} 여기로 안내할까요?` : `${name}. ${reason} 여기로 안내할까요?`;
}

export interface VoiceAssistantOptions<T> {
  /** TTS·STT 언어(BCP-47). 기본 ko-KR — lib/voice/speechLocale.speechLangFor(locale). */
  lang?: string;
  /** 비서가 말하는 문장(일부만 줘도 된다 — 나머지는 한국어 기본값). */
  messages?: Partial<VoiceMessages>;
  /** 카드 하나를 읽는 문장. 기본은 '{이름}. {이유} 여기로 안내할까요?'(이름 한 번). */
  cardSentence?: (name: string, reason: string) => string;
  /** 서버가 만든 응답 문장(spoken)을 그대로 읽을지. 서버는 한국어만 말하므로 다른 언어 화면은 false. 기본 true. */
  useServerSpoken?: boolean;
  /** 세션을 켤 때 — 다른 마이크(지도 검색)를 끄는 데 쓴다(두 마이크가 동시에 듣지 않게, 계획 B2 · I84). */
  onSessionStart?: () => void;
  getName: (item: T) => string;
  getReason: (item: T) => string;
  /** 자세히 안내 문장(없으면 reason 재발화) */
  getDetail?: (item: T) => string;
  /** "수락" 의도 → 길안내 등 */
  onAccept: (item: T) => void;
  /** "다음/별로" 의도 → 다음 카드(부모가 현재 카드를 교체) */
  onNext: (item: T) => void;
  /** 백엔드가 고른 시설로 전환(선호 매칭). spoken을 새 카드의 사유로 쓰면 자연스럽다. */
  onSelect?: (id: string, spoken?: string) => void;
  /** 백엔드가 선호로 후보를 좁힘(예: '양식'→양식 식당들). 추천 풀을 실시간 필터링해 재추천. */
  onFilter?: (matchIds: string[], spoken?: string) => void;
  /** 검증된 앱 명령을 실행. 후보 없음이면 false를 반환해 현재 상태와 카드를 유지한다. */
  onCommand?: (command: VoiceAppCommand) => boolean;
  /** 사용자 발화를 백엔드로 해석(미제공 시 unknown 처리). 카드 정보로 후보를 만들어 백엔드 호출. 카드 없이 켠 세션은 item=null. */
  interpret?: (utterance: string, item: T | null) => Promise<VoiceTurn>;
}

export interface VoiceAssistant<T> {
  active: boolean;
  voiceState: VoiceState;
  liveTranscript: string;
  caption: string;
  ttsSupported: boolean;
  sttSupported: boolean;
  /** 알약 탭: 꺼져 있으면 시작(제스처 게이트), 켜져 있으면 어떤 상태든 정지('음성 안내 정지' 라는 이름 그대로) */
  onOrbClick: () => void;
  /** 카드가 새로 떴을 때 부모가 호출(null이면 카드 사라짐 → 정지). 잠금 해제 상태면 자동 발화. */
  notifyItem: (item: T | null) => void;
  stop: () => void;
}

export function useVoiceAssistant<T>(opts: VoiceAssistantOptions<T>): VoiceAssistant<T> {
  // 콜백은 매 렌더 새로 생성되어 최신 클로저(부모 상태)를 담으므로 ref로 최신값 유지.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [active, setActive] = useState(false);
  const [voiceState, setVoiceStateRaw] = useState<VoiceState>("idle");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [caption, setCaption] = useState("");
  const [ttsSupported, setTtsSupported] = useState(true);
  const [sttSupported, setSttSupported] = useState(true);

  // SpeechRecognition 인스턴스 — lib.dom 에 타입이 없어 any 유지(런타임 전용 Web Speech 객체)
  const recRef = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(false); // active 상태 동기 미러(비동기 콜백에서 stale 방지)
  const listenTimerRef = useRef<number | null>(null); // window.setTimeout 핸들
  const followupRef = useRef<number | null>(null); // window.setTimeout 핸들
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const stateRef = useRef<VoiceState>("idle");
  const startingRef = useRef(false);
  const repromptRef = useRef(0);
  const itemRef = useRef<T | null>(null);
  // 유사 대안 제안(2턴): 직전 턴의 suggestionId. 다음 턴 accept 를 이 후보 select 로 처리하고,
  // 어떤 액션이든 1턴 소비 후 반드시 클리어한다(오래된 제안이 엉뚱한 턴에 발동하는 것 방지).
  const pendingSuggestionRef = useRef<string | null>(null);
  const voiceWarnedRef = useRef(false);
  const speakSeqRef = useRef(0); // 발화 시퀀스 — 취소/대체 시 이전 발화의 onEnd 체인 무효화

  const setVoiceState = (s: VoiceState) => { stateRef.current = s; setVoiceStateRaw(s); };
  const setActiveBoth = (v: boolean) => { activeRef.current = v; setActive(v); };

  // ── 지원 감지 + 한국어 보이스 캐싱(마운트 1회) ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    const synthOk = "speechSynthesis" in window;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setTtsSupported(synthOk);
    setSttSupported(!!SR);
    if (!synthOk) return; // 브라우저 보이스 캐싱은 speechSynthesis 있을 때만
    const loadVoices = () => { voicesRef.current = window.speechSynthesis.getVoices() || []; };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // ── 탭 숨김/언마운트 정리 ──
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onHide = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      try { recRef.current?.abort?.(); } catch { /* noop */ }
      if (listenTimerRef.current) clearTimeout(listenTimerRef.current);
      if (followupRef.current) clearTimeout(followupRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 지금 언어의 보이스 중 '가장 자연스러운' 것(lib/voice/speechLocale.pickVoice — Natural/Google/클라우드 우대).
  const lang = () => optsRef.current.lang || "ko-KR";
  const msg = (key: keyof VoiceMessages) => optsRef.current.messages?.[key] ?? DEFAULT_VOICE_MESSAGES[key];
  // 서버 문장(한국어)을 읽어도 되는 화면인가. 아니면 위 msg 의 화면 언어 문장으로 대신한다.
  const serverSpoken = (spoken: string | null | undefined) =>
    optsRef.current.useServerSpoken === false ? null : (spoken || null);

  // 진행 중 발화 정리(Cloud 오디오 + 브라우저 합성). seq 증가로 in-flight fetch/콜백 무효화.
  const cancelSpeech = () => {
    speakSeqRef.current++;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  };

  // 브라우저 내장 TTS(폴백). seq로 취소된 발화의 onEnd 체인 방지.
  const browserSpeak = (text: string, onEnd: (() => void) | undefined, seq: number) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) { onEnd?.(); return; }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.slice(0, 300));
      u.lang = lang(); u.rate = 1.05; u.pitch = 1.0;
      const v = pickVoice(voicesRef.current, lang());
      if (v) u.voice = v;
      else if (!voiceWarnedRef.current && voicesRef.current.length) {
        voiceWarnedRef.current = true;
        console.warn(`[voice] ${lang()} TTS 보이스를 찾지 못해 시스템 기본 보이스로 발화합니다.`);
      }
      u.onend = () => { if (seq === speakSeqRef.current) onEnd?.(); };
      u.onerror = () => { if (seq === speakSeqRef.current) onEnd?.(); };
      window.speechSynthesis.speak(u);
    } catch { onEnd?.(); }
  };

  // 브라우저 내장 TTS 로 발화. onEnd는 정확히 1회. 첫 발화는 오브 탭(제스처) 직후라 자동재생 정책 통과.
  const speak = (text: string, onEnd?: () => void) => {
    if (typeof window === "undefined") { onEnd?.(); return; }
    const seq = ++speakSeqRef.current;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    browserSpeak(text, onEnd, seq);
  };

  const clearTimers = () => {
    if (listenTimerRef.current) { clearTimeout(listenTimerRef.current); listenTimerRef.current = null; }
    if (followupRef.current) { clearTimeout(followupRef.current); followupRef.current = null; }
  };

  const stop = () => {
    cancelSpeech();
    try { recRef.current?.abort?.(); } catch { /* noop */ }
    clearTimers();
    startingRef.current = false;
    repromptRef.current = 0;
    pendingSuggestionRef.current = null;
    stateRef.current = "idle";
    setVoiceStateRaw("idle");
    setActiveBoth(false);
    setLiveTranscript("");
    setCaption("");
  };

  // 종료 멘트를 끝까지 들려준 뒤 idle(이후 아무것도 발화를 끊지 않음).
  const finish = (text?: string) => {
    try { recRef.current?.abort?.(); } catch { /* noop */ }
    clearTimers();
    startingRef.current = false;
    repromptRef.current = 0;
    pendingSuggestionRef.current = null;
    stateRef.current = "idle";
    setVoiceStateRaw("idle");
    setActiveBoth(false);
    setLiveTranscript("");
    setCaption("");
    if (text) speak(text);
    else cancelSpeech();
  };

  const scheduleListen = () => {
    if (followupRef.current) clearTimeout(followupRef.current);
    if (stateRef.current === "idle") return;
    followupRef.current = window.setTimeout(() => {
      followupRef.current = null;
      if (stateRef.current !== "idle") startListening();
    }, 500); // 스피커 잔향 self-trigger 방지
  };

  const reprompt = () => {
    if (stateRef.current === "idle") return;
    if (repromptRef.current < 1) {
      repromptRef.current += 1;
      const text = msg("reprompt");
      setVoiceState("speaking"); setCaption(text);
      speak(text, () => scheduleListen());
    } else {
      // 무응답 반복 → 인사하고 닫는다(말없이 꺼지면 고장으로 보인다). 카드는 그대로, 알약으로 다시 부른다.
      finish(msg("closing"));
    }
  };

  // 사용자 발화 1턴을 처리. 의도/필터는 전적으로 백엔드 분류기(interpret 콜백)가 판단한다.
  // 훅 안에 하드코딩 키워드 분류는 두지 않는다 — interpret 미제공/실패 시 'unknown'으로 재질문(엉뚱한 동작 방지).
  const handleIntent = async (alts: string[]) => {
    if (stateRef.current === "idle") return;
    // 카드 없이 켠 세션도 명령·음식 요청은 받는다(item=null). 수락·다음·자세히는 카드가 있어야 뜻이 있다.
    const item = itemRef.current;
    setVoiceState("thinking");
    repromptRef.current = 0;
    const o = optsRef.current;
    const utterance = alts[0] || "";

    let turn: VoiceTurn;
    try {
      turn = o.interpret ? await o.interpret(utterance, item) : { action: "unknown" };
    } catch {
      turn = { action: "unknown" }; // 해석/네트워크 실패 → 키워드 추측 없이 재질문
    }
    if ((stateRef.current as VoiceState) === "idle") return; // 해석 대기(await) 중 취소/정지됐으면 중단
    if (itemRef.current !== item) return; // 해석 중 카드가 바뀌었으면(새 카드 narrate 중) 이 턴 폐기(stale)
    const spokenText = serverSpoken(turn.spoken);
    const needsItem = ["accept", "next", "reject", "negative", "details"].includes((turn.action || "").toLowerCase());
    if (!item && needsItem && !pendingSuggestionRef.current) { reprompt(); return; }

    // 유사 대안 제안은 정확히 1턴만 유효 — 어떤 액션이든 여기서 소비(클리어)하고,
    // 이번 턴이 새 제안(filter 0건 + suggestionId)이면 아래 filter 분기가 다시 채운다.
    const pendingSuggestion = pendingSuggestionRef.current;
    pendingSuggestionRef.current = null;

    const action = (turn.action || "unknown").toLowerCase();
    switch (action) {
      case "stop":
      case "cancel":
        finish(spokenText || msg("end"));
        break;
      case "accept": {
        // 직전 턴에 "대신 ○○로 안내해드릴까요?" 제안이 있었으면, 이 accept 는 현재 카드 수락이
        // 아니라 그 제안 후보의 선택이다 — select 경로 재사용(onSelect가 카드를 바꾸면 notifyItem이 narrate).
        if (pendingSuggestion && o.onSelect) {
          try { recRef.current?.abort?.(); } catch { /* noop */ }
          o.onSelect(pendingSuggestion, spokenText || undefined);
          break;
        }
        const text = spokenText || msg("acceptAck");
        setVoiceState("speaking"); setCaption(text);
        speak(text, () => { if (item) o.onAccept(item); finish(); });
        break;
      }
      case "select":
        // 백엔드가 선호에 맞는 시설을 골랐다. onSelect가 카드를 바꾸면(또는 spoken을 사유로 갱신)
        // notifyItem이 새 카드를 narrate. 별도 발화 안 함(이중 방지).
        try { recRef.current?.abort?.(); } catch { /* noop */ }
        if (turn.targetId && o.onSelect) o.onSelect(turn.targetId, spokenText || undefined);
        else if (item) o.onNext(item);
        else reprompt();
        break;
      case "filter":
        // 백엔드가 선호로 후보를 좁혔다(예: 양식→양식 식당들). onFilter가 추천 풀을 실시간 필터링→재추천하면
        // notifyItem이 새 #1을 narrate. 별도 발화 안 함(이중 방지).
        try { recRef.current?.abort?.(); } catch { /* noop */ }
        if (turn.matchIds && turn.matchIds.length && o.onFilter) {
          o.onFilter(turn.matchIds, spokenText || undefined);
        } else if (turn.suggestionId) {
          // 매치 0건 + 유사 대안 제안: 백엔드 spoken("대신 ○○…안내해드릴까요?")을 읽고 답을 기다린다.
          // 다음 턴 accept 가 이 후보 select 로 이어진다(기존 0건 흐름과 동일한 상태 전이 — 카드 유지 + listen 재개).
          pendingSuggestionRef.current = turn.suggestionId;
          const text = spokenText || msg("similar");
          setVoiceState("speaking"); setCaption(text);
          speak(text, () => scheduleListen());
        } else {
          // 의미상 맞는 후보가 없으면 무관한 다음 순위를 추천하지 않고 현재 카드를 유지한다.
          // '없어요' 대신 다음에 할 일을 말한다(계획 B2 · I09 — 부정적인 빈 응답 금지).
          const text = msg("noMatch");
          setVoiceState("speaking"); setCaption(text);
          speak(text, () => scheduleListen());
        }
        break;
      case "command": {
        try { recRef.current?.abort?.(); } catch { /* noop */ }
        const applied = turn.command && o.onCommand ? o.onCommand(turn.command) : false;
        if (applied) finish(spokenText || msg("applied"));
        else {
          const text = msg("keepGoing");
          setVoiceState("speaking"); setCaption(text);
          speak(text, () => scheduleListen());
        }
        break;
      }
      case "details": {
        if (!item) { reprompt(); break; }
        const text = spokenText
          || (o.getDetail && o.getDetail(item))
          || (o.cardSentence ?? defaultCardSentence)(o.getName(item), "");
        setVoiceState("speaking"); setCaption(text);
        speak(text, () => scheduleListen());
        break;
      }
      case "next":
      case "reject":
      case "negative":
        // 다음 카드로. notifyItem이 새 카드를 narrate(이중 발화 방지 — spoken 별도 발화 안 함).
        try { recRef.current?.abort?.(); } catch { /* noop */ }
        if (item) o.onNext(item);
        break;
      default: // unknown
        if (spokenText) { setVoiceState("speaking"); setCaption(spokenText); speak(spokenText, () => scheduleListen()); }
        else reprompt();
    }
  };

  const startListening = () => {
    if (typeof window === "undefined") return;
    if (stateRef.current === "idle") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      // STT 미지원: 듣기 불가 → idle로 정리(listening 고착 방지). 발화는 이미 끝났고 버튼으로 응답.
      setSttSupported(false);
      finish();
      return;
    }
    if (startingRef.current) return;
    startingRef.current = true;
    try { recRef.current?.abort?.(); } catch { /* noop */ }
    try {
      const rec = new SR();
      rec.lang = lang();
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 3;
      rec.onresult = (e: SpeechRecognitionEvent) => {
        let interim = "";
        let finalAlts: string[] | null = null;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            finalAlts = [];
            for (let j = 0; j < r.length; j++) finalAlts.push(r[j].transcript);
          } else {
            interim += r[0]?.transcript || "";
          }
        }
        if (interim) setLiveTranscript(interim);
        if (finalAlts) {
          if (stateRef.current !== "listening") return;
          if (listenTimerRef.current) { clearTimeout(listenTimerRef.current); listenTimerRef.current = null; }
          setLiveTranscript(finalAlts[0] || "");
          handleIntent(finalAlts);
        }
      };
      rec.onerror = (e: SpeechRecognitionErrorEvent) => {
        startingRef.current = false;
        if (listenTimerRef.current) { clearTimeout(listenTimerRef.current); listenTimerRef.current = null; }
        const err = e?.error;
        if (err === "not-allowed" || err === "service-not-allowed") {
          setSttSupported(false);
          finish(); // 마이크 거부 → 종료(버튼 응답 유도), 권한 루프 방지
          return;
        }
        if (stateRef.current === "listening") reprompt(); // no-speech/aborted
      };
      rec.onend = () => { startingRef.current = false; };
      recRef.current = rec;
      setVoiceState("listening");
      setLiveTranscript("");
      rec.start();
      if (listenTimerRef.current) clearTimeout(listenTimerRef.current);
      listenTimerRef.current = window.setTimeout(() => {
        try { recRef.current?.stop?.(); } catch { /* noop */ }
        if (stateRef.current === "listening") reprompt();
      }, 7000);
    } catch {
      startingRef.current = false;
      reprompt();
    }
  };

  const speakItem = (item: T) => {
    itemRef.current = item;
    const o = optsRef.current;
    const reason = (o.getReason(item) || "").slice(0, 220).trim();
    const name = o.getName(item);
    // 이름은 한 번만 — 이유 문장이 이미 이름을 말하면 앞에 다시 붙이지 않는다(계획 B2 · I46).
    const sentence = (o.cardSentence ?? defaultCardSentence)(name, reason);
    setVoiceState("speaking");
    setCaption(sentence);
    speak(sentence, () => scheduleListen());
  };

  // 카드 없이 켠 세션 — 무엇을 찾을지 먼저 묻고 듣는다(♿·밤처럼 카드가 없는 화면에서도 비서가 죽은 버튼이 아니다).
  const greet = () => {
    const text = msg("greet");
    setVoiceState("speaking");
    setCaption(text);
    speak(text, () => scheduleListen());
  };

  // 부모가 카드 변경 시 호출. 잠금 해제 + 음소거 아님 + 활성일 때만 자동 발화.
  const notifyItem = (item: T | null) => {
    const hadItem = itemRef.current !== null;
    itemRef.current = item;
    if (!item) {
      // 보던 카드가 사라졌으면 종료. 카드 없이 시작한 세션(인사 → 듣기)은 이어간다.
      if (hadItem && stateRef.current !== "idle") finish();
      return;
    }
    if (!activeRef.current) return; // 세션 비활성: 대기(알약 표시만)
    speakItem(item);
  };

  // 제스처 게이트: onClick 콜백 동기 스택에서 첫 발화 → 자동재생 정책 통과.
  // 켜져 있을 때 누르면 어떤 상태든 멈춘다 — 이름이 '음성 안내 정지' 인데 말하는 중에 누르면 듣기로 넘어가던
  // 동작은 고장처럼 보였다(계획 B2 · I84).
  const onOrbClick = () => {
    if (typeof window === "undefined") return;
    if (!activeRef.current) {
      if (!("speechSynthesis" in window)) return;
      optsRef.current.onSessionStart?.();
      setActiveBoth(true);
      repromptRef.current = 0;
      try { const w = new SpeechSynthesisUtterance(" "); w.volume = 0; window.speechSynthesis.speak(w); } catch { /* noop */ }
      const item = itemRef.current;
      if (item) speakItem(item);
      else greet();
      return;
    }
    stop();
  };

  return {
    active, voiceState, liveTranscript, caption, ttsSupported, sttSupported,
    onOrbClick, notifyItem, stop,
  };
}
