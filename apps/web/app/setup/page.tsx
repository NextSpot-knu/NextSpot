'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, MapPin } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { track } from '@/lib/analytics';
import { EMPTY_TRAVEL_CONTEXT, saveTravelContext, type PlaceCategory, type RequiredAttribute, type TravelContext, CUISINES, type CuisinePreference } from '@/lib/travelContext';
import { useT } from '@/lib/i18n/I18nProvider';

const CATEGORIES: PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];
const WALKS = [5, 10, 20] as const;
const AVAILABLE = [30, 60, 120] as const;

export default function SetupPage() {
  const router = useRouter();
  const t = useT();
  const [context, setContext] = useState<TravelContext>(EMPTY_TRAVEL_CONTEXT);
  const [saving, setSaving] = useState(false);

  const toggleCategory = (category: PlaceCategory) => setContext((current) => ({
    ...current,
    categories: current.categories.includes(category)
      ? current.categories.filter((item) => item !== category)
      : [...current.categories, category],
  }));
  const toggleAttribute = (attribute: RequiredAttribute) => setContext((current) => ({
    ...current,
    requiredAttributes: current.requiredAttributes.includes(attribute)
      ? current.requiredAttributes.filter((item) => item !== attribute)
      : [...current.requiredAttributes, attribute],
  }));

  const finish = (value: TravelContext) => {
    if (saving) return;
    setSaving(true);
    saveTravelContext(value);
    track('context_applied', {
      categories: value.categories,
      max_walk_minutes: value.maxWalkMinutes ?? null,
      available_minutes: value.availableMinutes ?? null,
      required_attributes: value.requiredAttributes,
      exclude_visited: value.excludeVisited,
    });
    router.push('/main');
    if (value.categories.length) {
      void (async () => {
        try {
          const supabase = createPublicClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) await supabase.from('users').update({ preferred_categories: value.categories }).eq('id', user.id);
        } catch { /* local context remains the source for this trip */ }
      })();
    }
  };

  return (
    <main className="min-h-screen bg-hanji text-muk px-5 py-8 sm:py-10">
      <div className="mx-auto max-w-md">
        <header className="flex items-center justify-between mb-8">
          <button
            type="button"
            onClick={() => router.push('/')}
            aria-label={t('common.back')}
            className="toss-pressable flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-white text-muk-soft transition-colors hover:border-gold/35 hover:text-muk focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <ArrowLeft size={20} />
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => finish(EMPTY_TRAVEL_CONTEXT)}
            className="rounded-lg px-2 py-2 text-sm font-medium text-muk-soft underline underline-offset-4 decoration-line/80 transition-colors hover:text-muk focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-50"
          >
            {t('setup.skip')}
          </button>
        </header>
        <div className="mb-8">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-jade/10 px-3 py-1 text-xs font-bold text-jade">
            <MapPin size={13} /> {t('setup.fieldBadge')}
          </span>
          <h1 className="mt-3 text-2xl font-serif font-bold leading-snug break-keep">{t('setup.contextTitle')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muk-soft">{t('setup.contextDesc')}</p>
        </div>

        <Section step={1} title={t('setup.categoriesTitle')}>
          <div className="grid grid-cols-2 gap-2.5">{CATEGORIES.map((category) => <Chip key={category} active={context.categories.includes(category)} onClick={() => toggleCategory(category)}>{t(`category.${category}`)}</Chip>)}</div>
        </Section>
        {/* 음식 취향 — v2 재작성 때 빠졌다가 복원. 한 번 더 누르면 해제된다(선택 사항이라
            강제하지 않는다). 값은 lib/travelContext 의 CUISINE_INTENT 를 거쳐 추천 점수의
            cuisineIntent 로 들어간다. */}
        <Section step={2} title={t('setup.step2')}>
          <div className="grid grid-cols-2 gap-2.5">{CUISINES.map((cuisine) => <Chip key={cuisine} active={context.cuisine === cuisine} onClick={() => setContext((current) => ({ ...current, cuisine: current.cuisine === cuisine ? undefined : cuisine }))}>{t(CUISINE_LABEL_KEY[cuisine])}</Chip>)}</div>
        </Section>
        <Section step={3} title={t('setup.walkTitle')}>
          <div className="grid grid-cols-3 gap-2.5">{WALKS.map((minutes) => <Chip key={minutes} active={context.maxWalkMinutes === minutes} onClick={() => setContext((current) => ({ ...current, maxWalkMinutes: minutes }))}>{t('setup.minutes', { n: minutes })}</Chip>)}</div>
        </Section>
        <Section step={4} title={t('setup.availableTitle')}>
          <div className="grid grid-cols-3 gap-2.5">{AVAILABLE.map((minutes) => <Chip key={minutes} active={context.availableMinutes === minutes} onClick={() => setContext((current) => ({ ...current, availableMinutes: minutes }))}>{minutes === 120 ? t('setup.twoHoursPlus') : t('setup.minutes', { n: minutes })}</Chip>)}</div>
        </Section>
        <Section step={5} title={t('setup.requirementsTitle')}>
          <div className="space-y-2.5">
            <Toggle active={context.requiredAttributes.includes('indoor')} onClick={() => toggleAttribute('indoor')} label={t('setup.indoorOnly')} />
            <Toggle active={context.requiredAttributes.includes('accessible')} onClick={() => toggleAttribute('accessible')} label={t('setup.accessibleOnly')} />
            <Toggle active={context.excludeVisited} onClick={() => setContext((current) => ({ ...current, excludeVisited: !current.excludeVisited }))} label={t('setup.excludeVisited')} />
          </div>
        </Section>
        <button
          type="button"
          disabled={saving}
          onClick={() => finish(context)}
          className="toss-pressable mt-4 flex min-h-[52px] w-full items-center justify-center rounded-2xl bg-gold text-base font-bold text-white shadow-[0_8px_20px_rgba(193,154,62,0.30)] transition-colors hover:bg-gold-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep focus-visible:ring-offset-2 focus-visible:ring-offset-hanji disabled:opacity-60 disabled:hover:bg-gold"
        >
          {saving ? t('setup.saving') : t('setup.start')}
        </button>
      </div>
    </main>
  );
}

// 취향 라벨의 i18n 키. v1 온보딩이 쓰던 키를 그대로 재사용한다(사전에 그대로 남아 있다).
const CUISINE_LABEL_KEY: Record<CuisinePreference, string> = {
  '한식': 'setup.foodKorean',
  '분식·국밥': 'setup.foodSnack',
  '양식': 'setup.foodWestern',
  '카페·디저트': 'setup.foodDessert',
};

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gold/15 text-[11px] font-bold text-gold-deep">{step}</span>
        <h2 className="text-sm font-bold text-muk">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`toss-pressable min-h-11 rounded-2xl border px-3 py-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${active ? 'border-gold bg-gold/15 text-gold-deep shadow-[0_2px_10px_rgba(193,154,62,0.18)]' : 'border-line bg-white text-muk-soft hover:bg-hanji-deep hover:text-muk'}`}
    >
      {children}
    </button>
  );
}

function Toggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`toss-pressable flex min-h-11 w-full items-center justify-between rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/50 ${active ? 'border-jade bg-jade/10 text-muk' : 'border-line bg-white text-muk-soft hover:bg-hanji-deep hover:text-muk'}`}
    >
      <span>{label}</span>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${active ? 'border-jade bg-jade text-white' : 'border-line bg-transparent text-transparent'}`}>
        <Check size={13} strokeWidth={3} />
      </span>
    </button>
  );
}
