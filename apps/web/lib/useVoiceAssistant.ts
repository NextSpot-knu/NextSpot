// 음성 비서 훅 — 단일 카드(추천) 1개를 TTS로 안내하고 STT로 응답을 받아 콜백에 위임한다.
//
// 부모(페이지)가 "현재 카드(item)"와 콜백(onAccept/onNext)을 제공하면, 이 훅이 TTS 발화 →
// STT 듣기 → 의도 분류(옵션 interpret → 백엔드 키워드 분류기) → 콜백 위임의 상태머신을 관리한다. "다음" 의도는
// onNext가 부모 상태를 바꾸면 notifyItem으로 새 카드가 자동 발화되므로 훅이 직접 다음을 말하지 않는다.
//
// 정적 export(SSR) 안전: 모든 Web Speech 접근은 이벤트/이펙트 내부 + typeof window 가드.
// 폴백 우선: TTS/STT 미지원·마이크 거부 시 graceful(데모 무중단).
import { useEffect, useRef, useState } from "react";

// TTS 는 브라우저 내장 speechSynthesis 만 사용한다.
// (대회용 Google Cloud Text-to-Speech 연동은 제거됨 — 로컬 전용·외부 의존성 0.)

export type VoiceState = "idle" | "speaking" | "listening" | "thinking";

/** 백엔드(키워드 분류기)가 해석한 음성 1턴 결과 */
export interface VoiceTurn {
  action: string; // accept|next|reject|details|select|filter|stop|unknown
  targetId?: string | null; // select 일 때 고른 시설 id
  matchIds?: string[]; // filter 일 때 선호에 맞는 후보 id들
  spoken?: string | null; // 백엔드 생성 한국어 응답
}

export interface VoiceAssistantOptions<T> {
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
  /** 사용자 발화를 백엔드로 해석(미제공 시 unknown 처리). 카드 정보로 후보를 만들어 백엔드 호출. */
  interpret?: (utterance: string, item: T) => Promise<VoiceTurn>;
}

export interface VoiceAssistant<T> {
  active: boolean;
  voiceState: VoiceState;
  liveTranscript: string;
  caption: string;
  ttsSupported: boolean;
  sttSupported: boolean;
  /** 오브 탭: 비활성이면 시작(제스처 게이트), 발화중이면 바지인, 그 외 정지 */
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
  const recRef = useRef<any>(null);
  const activeRef = useRef(false); // active 상태 동기 미러(비동기 콜백에서 stale 방지)
  const listenTimerRef = useRef<number | null>(null); // window.setTimeout 핸들
  const followupRef = useRef<number | null>(null); // window.setTimeout 핸들
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const stateRef = useRef<VoiceState>("idle");
  const startingRef = useRef(false);
  const repromptRef = useRef(0);
  const itemRef = useRef<T | null>(null);
  const koVoiceWarnedRef = useRef(false);
  const speakSeqRef = useRef(0); // 발화 시퀀스 — 취소/대체 시 이전 발화의 onEnd 체인 무효화

  const setVoiceState = (s: VoiceState) => { stateRef.current = s; setVoiceStateRaw(s); };
  const setActiveBoth = (v: boolean) => { activeRef.current = v; setActive(v); };

  // ── 지원 감지 + 한국어 보이스 캐싱(마운트 1회) ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    const synthOk = "speechSynthesis" in window;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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

  // 한국어 보이스 중 '가장 자연스러운' 것을 점수화해 고른다.
  // Edge의 "Microsoft …(Natural)" / Chrome의 "Google …" / WaveNet 등 neural 보이스가
  // OS 기본 보이스보다 훨씬 자연스럽다. (localService=false = 클라우드 보이스, 대개 고품질)
  const pickKoVoice = () => {
    const ko = (voicesRef.current || []).filter((v) => /^ko(-|_|$)/i.test(v.lang || ""));
    if (!ko.length) return null;
    const score = (v: SpeechSynthesisVoice) => {
      const n = (v.name || "").toLowerCase();
      let s = 0;
      if (/natural|neural|online/.test(n)) s += 5; // Edge Azure neural(최고 품질)
      if (/google/.test(n)) s += 3; // Chrome Google 보이스
      if (/wavenet|studio|chirp/.test(n)) s += 3; // Google Cloud 계열
      if (v.localService === false) s += 2; // 클라우드 보이스 우대
      if (v.lang === "ko-KR") s += 1;
      return s;
    };
    return ko.slice().sort((a, b) => score(b) - score(a))[0];
  };

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
      u.lang = "ko-KR"; u.rate = 1.05; u.pitch = 1.0;
      const v = pickKoVoice();
      if (v) u.voice = v;
      else if (!koVoiceWarnedRef.current && voicesRef.current.length) {
        koVoiceWarnedRef.current = true;
        console.warn("[voice] 한국어 TTS 보이스를 찾지 못해 시스템 기본 보이스로 발화합니다.");
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
      const msg = "수락하려면 '응', 넘기려면 '다음'이라고 말해 주세요.";
      setVoiceState("speaking"); setCaption(msg);
      speak(msg, () => scheduleListen());
    } else {
      finish(); // 무응답 반복 → 조용히 종료(카드는 유지, 오브로 재개 가능)
    }
  };

  // 사용자 발화 1턴을 처리. 의도/필터는 전적으로 백엔드 분류기(interpret 콜백)가 판단한다.
  // 훅 안에 하드코딩 키워드 분류는 두지 않는다 — interpret 미제공/실패 시 'unknown'으로 재질문(엉뚱한 동작 방지).
  const handleIntent = async (alts: string[]) => {
    if (stateRef.current === "idle") return;
    const item = itemRef.current;
    if (!item) { finish(); return; }
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

    const action = (turn.action || "unknown").toLowerCase();
    switch (action) {
      case "stop":
      case "cancel":
        finish(turn.spoken || "음성 안내를 마칠게요.");
        break;
      case "accept": {
        const msg = turn.spoken || "알겠어요, 여기로 안내할게요!";
        setVoiceState("speaking"); setCaption(msg);
        speak(msg, () => { o.onAccept(item); finish(); });
        break;
      }
      case "select":
        // 백엔드가 선호에 맞는 시설을 골랐다. onSelect가 카드를 바꾸면(또는 spoken을 사유로 갱신)
        // notifyItem이 새 카드를 narrate. 별도 발화 안 함(이중 방지).
        try { recRef.current?.abort?.(); } catch { /* noop */ }
        if (turn.targetId && o.onSelect) o.onSelect(turn.targetId, turn.spoken || undefined);
        else o.onNext(item);
        break;
      case "filter":
        // 백엔드가 선호로 후보를 좁혔다(예: 양식→양식 식당들). onFilter가 추천 풀을 실시간 필터링→재추천하면
        // notifyItem이 새 #1을 narrate. 별도 발화 안 함(이중 방지).
        try { recRef.current?.abort?.(); } catch { /* noop */ }
        if (turn.matchIds && turn.matchIds.length && o.onFilter) o.onFilter(turn.matchIds, turn.spoken || undefined);
        else o.onNext(item);
        break;
      case "details": {
        const msg = turn.spoken || (o.getDetail && o.getDetail(item)) || `${o.getName(item)} 정보를 다시 안내할게요. 여기로 안내할까요?`;
        setVoiceState("speaking"); setCaption(msg);
        speak(msg, () => scheduleListen());
        break;
      }
      case "next":
      case "reject":
      case "negative":
        // 다음 카드로. notifyItem이 새 카드를 narrate(이중 발화 방지 — spoken 별도 발화 안 함).
        try { recRef.current?.abort?.(); } catch { /* noop */ }
        o.onNext(item);
        break;
      default: // unknown
        if (turn.spoken) { setVoiceState("speaking"); setCaption(turn.spoken); speak(turn.spoken, () => scheduleListen()); }
        else reprompt();
    }
  };

  const startListening = () => {
    if (typeof window === "undefined") return;
    if (stateRef.current === "idle") return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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
      rec.lang = "ko-KR";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 3;
      rec.onresult = (e: any) => {
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
      rec.onerror = (e: any) => {
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
    const sentence = reason ? `${name}. ${reason} 여기로 안내할까요?` : `${name}. 여기로 안내할까요?`;
    setVoiceState("speaking");
    setCaption(sentence);
    speak(sentence, () => scheduleListen());
  };

  // 부모가 카드 변경 시 호출. 잠금 해제 + 음소거 아님 + 활성일 때만 자동 발화.
  const notifyItem = (item: T | null) => {
    itemRef.current = item;
    if (!item) {
      if (stateRef.current !== "idle") finish(); // 카드 사라짐 → 종료
      return;
    }
    if (!activeRef.current) return; // 세션 비활성: 대기(오브 표시만)
    speakItem(item);
  };

  // 제스처 게이트: onClick 콜백 동기 스택에서 첫 발화 → 자동재생 정책 통과.
  const onOrbClick = () => {
    if (typeof window === "undefined") return;
    if (!active) {
      const item = itemRef.current;
      if (!item || !("speechSynthesis" in window)) return;
      setActiveBoth(true);
      repromptRef.current = 0;
      try { const w = new SpeechSynthesisUtterance(" "); w.volume = 0; window.speechSynthesis.speak(w); } catch { /* noop */ }
      speakItem(item);
      return;
    }
    if (stateRef.current === "speaking") { // 바지인
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      startListening();
      return;
    }
    stop();
  };

  return {
    active, voiceState, liveTranscript, caption, ttsSupported, sttSupported,
    onOrbClick, notifyItem, stop,
  };
}
