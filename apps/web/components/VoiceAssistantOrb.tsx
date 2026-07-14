"use client";

// 음성 비서 오버레이 UI(오브 + 자막). 고정 위치는 없음 — 부모가 배치한다(재사용성).
// 상태는 useVoiceAssistant 훅이 제공한다. 아이콘은 스파크(4점 별) 모티브.
import React, { useId } from "react";
import type { VoiceState } from "@/lib/useVoiceAssistant";
import { useT } from "@/lib/i18n/I18nProvider";

// 스파크 아이콘(오목한 4점 별, 파랑→보라→핑크 그라데이션).
// 인스턴스마다 useId 로 고유 그라데이션 id 를 부여(중복 id 충돌 방지).
function SparkIcon({ size = 24, className = "" }: { size?: number; className?: string }) {
  const gid = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gid} x1="2" y1="3" x2="22" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4285F4" />
          <stop offset="0.5" stopColor="#9B72CB" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
      </defs>
      {/* 각 변이 중심(12,12)으로 휘어 스파크(4점 별) 형태가 된다. */}
      <path d="M12 2 Q12 12 22 12 Q12 12 12 22 Q12 12 2 12 Q12 12 12 2 Z" fill={`url(#${gid})`} />
    </svg>
  );
}

interface Props {
  active: boolean;
  voiceState: VoiceState;
  liveTranscript: string;
  caption: string;
  sttSupported: boolean;
  onOrb: () => void;
}

export default function VoiceAssistantOrb({
  active, voiceState, liveTranscript, caption, sttSupported, onOrb,
}: Props) {
  const t = useT();
  return (
    <div className="flex flex-col items-end gap-2 select-none pointer-events-auto">
      {/* 자막 / 안내 pill (스크린리더 라이브 영역) */}
      {active && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="max-w-[15rem] md:max-w-[17rem] border border-white/10 rounded-2xl px-3.5 py-2.5 shadow-xl bg-[#0b1022]/95 backdrop-blur"
        >
          <div className="flex items-center gap-1.5 mb-1">
            <SparkIcon size={18} />
            <span className="text-[10px] font-bold tracking-wide bg-gradient-to-r from-sky-400 to-purple-400 bg-clip-text text-transparent">
              {t("recommend.assistantName")}
            </span>
          </div>
          <p className="text-[11px] leading-snug text-slate-200 min-h-[1.1rem]">
            {voiceState === "listening"
              ? liveTranscript
                ? `“${liveTranscript}”`
                : t("recommend.listening")
              : voiceState === "thinking"
              ? t("recommend.interpreting")
              : voiceState === "speaking"
              ? caption || t("recommend.speakingDefault")
              : t("recommend.canRespondByVoice")}
          </p>
          {!sttSupported && (
            <p className="text-[10px] text-amber-300/90 mt-1">{t("recommend.sttUnsupportedHint")}</p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onOrb}
        aria-label={active ? t("recommend.stopAria") : t("recommend.listenCta")}
        className={`relative w-14 h-14 rounded-full flex items-center justify-center text-xl shadow-lg transition-all active:scale-95 border ${
          voiceState === "listening"
            ? "bg-emerald-500/20 border-emerald-400/60 shadow-emerald-500/20"
            : voiceState === "speaking"
            ? "bg-purple-500/20 border-purple-400/60 shadow-purple-500/20"
            : voiceState === "thinking"
            ? "bg-sky-500/20 border-sky-400/60"
            : "bg-gradient-to-br from-sky-500/30 to-purple-600/30 border-white/20"
        }`}
      >
        {!active && <span className="absolute inset-0 rounded-full border border-sky-400/40 animate-ping" />}
        {!active ? (
          <SparkIcon size={34} />
        ) : voiceState === "speaking" ? (
          <span className="flex items-end gap-0.5 h-5">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="w-1 bg-purple-300 rounded-full animate-pulse"
                style={{ height: `${8 + (i % 2) * 8}px`, animationDelay: `${i * 120}ms` }}
              />
            ))}
          </span>
        ) : voiceState === "listening" ? (
          <span className="relative flex items-center justify-center">
            <span className="absolute w-9 h-9 rounded-full bg-emerald-400/20 animate-ping" />
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          </span>
        ) : voiceState === "thinking" ? (
          <span className="w-5 h-5 border-2 border-sky-300 border-t-transparent rounded-full animate-spin" />
        ) : (
          <SparkIcon size={32} />
        )}
      </button>

      {!active && (
        <span className="inline-flex items-center gap-1 text-[10px] text-slate-200 bg-black/60 border border-white/10 rounded-full px-2.5 py-1 animate-pulse whitespace-nowrap">
          <SparkIcon size={15} /> {t("recommend.listenCta")}
        </span>
      )}
    </div>
  );
}
