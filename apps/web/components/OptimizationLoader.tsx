"use client";

import { Route, Sparkles, Timer } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

type OptimizationLoaderProps = {
  mode: "waiting" | "course" | "shared";
};

const ICONS = [Sparkles, Timer, Route];

export default function OptimizationLoader({ mode }: OptimizationLoaderProps) {
  const t = useT();

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-gold/25 bg-white/90 px-5 py-5 shadow-[0_8px_30px_rgba(43,35,32,0.08)]"
      role="status"
      aria-live="polite"
    >
      <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-gold/15 blur-2xl" aria-hidden />
      <div className="relative flex items-center gap-3">
        <div className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gold/10 text-gold-deep">
          <span className="absolute inset-0 rounded-full border border-gold/40 animate-ping motion-reduce:animate-none" />
          <Sparkles size={20} aria-hidden />
        </div>
        <div>
          <p className="text-sm font-bold text-muk">{t(`optimization.${mode}.title`)}</p>
          <p className="mt-0.5 text-xs text-muk-soft">{t("optimization.hint")}</p>
        </div>
      </div>
      <div className="relative mt-4 grid grid-cols-3 gap-2" aria-hidden>
        {ICONS.map((Icon, index) => (
          <div
            key={index}
            className="flex min-w-0 flex-col items-center gap-1.5 rounded-xl bg-hanji/70 px-2 py-2.5 text-center animate-pulse motion-reduce:animate-none"
            style={{ animationDelay: `${index * 450}ms`, animationDuration: "1.8s" }}
          >
            <Icon size={15} className="text-gold-deep" />
            <span className="text-[10px] leading-tight text-muk-soft">{t(`optimization.${mode}.step${index + 1}`)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
