// 지도 검색바 음성 받아쓰기(STT) 훅 — 마이크 탭 → 한 발화(단발)를 텍스트로 받아 검색어에 넣는다.
// 음성 비서(useVoiceAssistant)와 달리 TTS·대화·의도분류가 없다: 받아쓰기만 담당해 기존 마커 필터
// (searchQuery)를 그대로 재사용한다. 지도 오브(VoiceAssistantOrb)와는 별개의 컨트롤.
//
// 정적 export(SSR) 안전: 모든 Web Speech 접근은 이펙트/이벤트 콜백 내부 + typeof window 가드.
// 폴백 우선: 미지원 브라우저는 supported=false → 호출부가 마이크를 '준비 중' 비활성으로 유지(크래시 없음).
// (STT 패턴은 lib/useVoiceAssistant.ts / app/explore/recommend 와 일관되게 맞춤 — 해당 파일은 건드리지 않음.)
import { useEffect, useRef, useState } from "react";

export interface SpeechSearch {
  /** 브라우저가 Web Speech STT 를 지원하는지(런타임 감지, 마운트 후 확정) */
  supported: boolean;
  /** 현재 마이크로 듣는 중인지 — 마이크에 듣기 상태 표시용 */
  listening: boolean;
  /** 마이크 탭: 비활성이면 듣기 시작, 듣는 중이면 취소(토글) */
  start: () => void;
  /** 진행 중 인식 중단(마이크 릴리스) */
  stop: () => void;
}

/**
 * onTranscript 는 최종 인식 문장을 받는다(단발). 보통 setSearchQuery 를 넘겨 마커 필터를 트리거한다.
 */
export function useSpeechSearch(onTranscript: (text: string) => void): SpeechSearch {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);

  const recRef = useRef<any>(null);
  const listeningRef = useRef(false); // listening 동기 미러(비동기 콜백 stale 방지)
  const onTranscriptRef = useRef(onTranscript); // 매 렌더 최신 클로저 유지
  onTranscriptRef.current = onTranscript;

  const setListeningBoth = (v: boolean) => { listeningRef.current = v; setListening(v); };

  // ── 지원 감지(마운트 1회) ── 정적 export 에서 window 없이 통과, 클라이언트에서만 확정.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSupported(!!SR);
  }, []);

  // ── 언마운트 정리 ── 진행 중 인식 중단(마이크 릴리스).
  useEffect(() => {
    return () => { try { recRef.current?.abort?.(); } catch { /* noop */ } };
  }, []);

  const stop = () => {
    try { recRef.current?.stop?.(); } catch { /* noop */ }
    setListeningBoth(false);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (listeningRef.current) { stop(); return; } // 듣는 중 다시 탭 → 취소(토글)
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; } // 미지원 → 조용히 비활성 유지
    try { recRef.current?.abort?.(); } catch { /* noop */ }
    try {
      const rec = new SR();
      rec.lang = "ko-KR";
      rec.interimResults = false; // 단발 받아쓰기 — 최종 문장만 검색어로 반영
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e: any) => {
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) transcript += r[0]?.transcript || "";
        }
        transcript = transcript.trim();
        if (transcript) onTranscriptRef.current(transcript);
      };
      // 에러(마이크 거부·no-speech 등)/종료 시 듣기 상태 해제 — 마이크가 '듣는 중'으로 고착되지 않게.
      rec.onerror = () => { setListeningBoth(false); };
      rec.onend = () => { setListeningBoth(false); };
      recRef.current = rec;
      setListeningBoth(true);
      rec.start();
    } catch {
      setListeningBoth(false); // start 예외(중복 시작 등) → 안전 복구
    }
  };

  return { supported, listening, start, stop };
}
