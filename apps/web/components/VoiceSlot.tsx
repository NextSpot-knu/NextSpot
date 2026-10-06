"use client";

// AI 음성 비서의 자리(계획 B2 · P7 + I27). 예전 VoiceAssistantOrb(지도 구석의 보라색 아이콘 원 + 10px 반투명 글씨)를
// 대신한다 — 심사위원이 그것이 음성 기능인지 알아보지 못했고, 휴대폰에서는 자막이 시계 밑에 깔렸다.
//   · VoicePill: 글자가 있는 먹빛 알약 '🎙 AI 음성 비서'. 접근 이름은 예전 그대로 'AI 음성 추천 듣기'
//     (켜져 있으면 '음성 안내 정지') — e2e/voice-controls.spec.ts 가 이 이름으로 누른다.
//   · VoiceCaptionBar: 말하는 동안의 자막 막대. 부모가 absolute 로 띄워 아래 내용을 밀지 않는다(레이아웃 이동 없음).
//     상태 칩(말하는 중 · 듣는 중 · 이해하는 중) · 15px 자막 · 명령어 안내 · '그만' 버튼.
// 위치는 부모가 정한다: 데스크톱은 추천 패널 위 44px 칸, 휴대폰은 카드 오른쪽 위(미리보기·펼침 모두).
// 상태는 lib/voice/useVoiceAssistant 훅이 준다.
import type { VoiceState } from "@/lib/voice/useVoiceAssistant";
import { useT } from "@/lib/i18n/I18nProvider";

interface PillProps {
  active: boolean;
  voiceState: VoiceState;
  onClick: () => void;
  /** /main?focus=voice — 소개 화면의 바로가기로 들어왔을 때 알약에 고리를 둘러 찾기 쉽게. */
  ringed?: boolean;
  className?: string;
}

export function VoicePill({ active, voiceState, onClick, ringed = false, className = "" }: PillProps) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={active ? t("recommend.stopAria") : t("recommend.listenCta")}
      aria-pressed={active}
      data-testid="voice-pill"
      data-voice-state={voiceState}
      className={`pointer-events-auto inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-muk px-3.5 text-[13px] font-extrabold text-hanji shadow-[0_4px_14px_rgba(43,35,32,0.22)] transition-transform active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 ${ringed ? "ring-4 ring-gold ring-offset-2 ring-offset-hanji" : ""} ${className}`}
    >
      <span aria-hidden>🎙</span>
      <span>{t("voice.pill")}</span>
      {active && (
        <span aria-hidden className="ml-0.5 flex h-3 items-end gap-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`w-0.5 rounded-full bg-gold ${voiceState === "speaking" ? "animate-pulse" : ""}`}
              style={{ height: `${6 + (i % 2) * 5}px`, animationDelay: `${i * 120}ms` }}
            />
          ))}
        </span>
      )}
    </button>
  );
}

interface CaptionProps {
  voiceState: VoiceState;
  liveTranscript: string;
  caption: string;
  sttSupported: boolean;
  /** 명령어 안내 한 줄(recommend.voiceHint) — 화면 언어의 말로. */
  hint: string;
  onStop: () => void;
  className?: string;
}

export function VoiceCaptionBar({ voiceState, liveTranscript, caption, sttSupported, hint, onStop, className = "" }: CaptionProps) {
  const t = useT();
  const stateWord = voiceState === "listening"
    ? t("voice.stateListening")
    : voiceState === "thinking"
      ? t("voice.stateThinking")
      : t("voice.stateSpeaking");
  const text = voiceState === "listening"
    ? (liveTranscript ? `“${liveTranscript}”` : t("recommend.listening"))
    : voiceState === "thinking"
      ? (liveTranscript ? `“${liveTranscript}”` : t("recommend.interpreting"))
      : caption || t("recommend.speakingDefault");
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="voice-caption"
      className={`pointer-events-auto rounded-2xl border border-gold/40 bg-muk px-4 py-3 text-hanji shadow-[0_10px_30px_rgba(43,35,32,0.30)] ${className}`}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-gold/25 px-2.5 py-0.5 text-[12px] font-extrabold text-gold">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-gold ${voiceState === "thinking" ? "" : "animate-pulse"}`} />
          {stateWord}
        </span>
        <span className="text-[12px] font-bold opacity-80">🎙 {t("voice.pill")}</span>
        <button
          type="button"
          onClick={onStop}
          className="ml-auto rounded-full border border-hanji/40 px-3 py-1 text-[12px] font-extrabold text-hanji hover:bg-hanji/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
        >
          {t("voice.stop")}
        </button>
      </div>
      <p className="mt-2 break-keep text-[15px] font-semibold leading-snug">{text}</p>
      <p className="mt-1.5 text-[12px] font-medium leading-snug opacity-75">{hint}</p>
      {!sttSupported && <p className="mt-1 text-[11px] font-medium text-gold">{t("recommend.sttUnsupportedHint")}</p>}
    </div>
  );
}
