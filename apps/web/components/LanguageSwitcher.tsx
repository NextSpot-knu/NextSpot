'use client';

// 언어 스위처 — 관광객 앱 어디서든 마운트 가능(예: 마이페이지/설정). locale 변경은 즉시 반영된다.
// 지도 위에 떠도 글자가 비치지 않게 불투명 바탕(계획 B3 — 언어·시계는 오른쪽 위, 불투명).
import { Globe } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { LOCALES, type Locale } from '@/lib/i18n/config';

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 text-sm text-muk shadow-[0_2px_14px_rgba(43,35,32,0.08)] ${className}`}
    >
      <Globe size={16} className="text-muk-soft" aria-hidden />
      <span className="sr-only">언어 선택</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="cursor-pointer self-stretch bg-transparent py-1.5 pr-1 font-medium text-muk outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60"
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
