'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, ChevronDown, ChevronUp, MapPin } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { track } from '@/lib/analytics';
import { EMPTY_TRAVEL_CONTEXT, saveTravelContext, type PlaceCategory, type RequiredAttribute, type TravelContext } from '@/lib/travelContext';
import { useT } from '@/lib/i18n/I18nProvider';

const CATEGORIES: PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];
const WALKS = [5, 10, 20] as const;
const AVAILABLE = [30, 60, 120] as const;

export default function SetupPage() {
  const router = useRouter();
  const t = useT();
  const [context, setContext] = useState<TravelContext>(EMPTY_TRAVEL_CONTEXT);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const finish = async (value: TravelContext) => {
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
    if (value.categories.length) {
      try {
        const supabase = createPublicClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) await supabase.from('users').update({ preferred_categories: value.categories }).eq('id', user.id);
      } catch { /* local context remains the source for this trip */ }
    }
    router.push('/main');
  };

  return (
    <main className="min-h-screen bg-hanji text-muk px-5 py-7">
      <div className="mx-auto max-w-md">
        <header className="flex items-center justify-between mb-7">
          <button type="button" onClick={() => router.push('/')} aria-label={t('common.back')} className="-ml-2 p-2 text-muk-soft hover:text-muk"><ArrowLeft size={20} /></button>
          <button type="button" disabled={saving} onClick={() => void finish(EMPTY_TRAVEL_CONTEXT)} className="text-sm text-muk-soft disabled:opacity-50">{t('setup.skip')}</button>
        </header>
        <div className="mb-7">
          <span className="inline-flex items-center gap-1 text-xs font-bold tracking-wide text-jade"><MapPin size={14} /> {t('setup.fieldBadge')}</span>
          <h1 className="mt-3 max-w-sm text-[28px] font-serif font-bold leading-tight break-keep">{t('setup.contextTitle')}</h1>
          <p className="mt-3 text-sm leading-6 text-muk-soft">{t('setup.contextDesc')}</p>
        </div>

        <Section title={t('setup.categoriesTitle')}>
          <div className="grid grid-cols-2 gap-2">{CATEGORIES.map((category) => <Chip key={category} active={context.categories.includes(category)} onClick={() => toggleCategory(category)}>{t(`category.${category}`)}</Chip>)}</div>
        </Section>
        <Section title={t('setup.walkTitle')}>
          <div className="grid grid-cols-3 gap-2">{WALKS.map((minutes) => <Chip key={minutes} active={context.maxWalkMinutes === minutes} onClick={() => setContext((current) => ({ ...current, maxWalkMinutes: minutes }))}>{t('setup.minutes', { n: minutes })}</Chip>)}</div>
        </Section>

        <button
          type="button"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((current) => !current)}
          className="mb-5 flex w-full items-center justify-between border-y border-line py-4 text-left"
        >
          <span>
            <span className="block text-sm font-bold text-muk">{showAdvanced ? t('setup.advancedHide') : t('setup.advancedShow')}</span>
            <span className="mt-1 block text-xs text-muk-soft">{t('setup.advancedHint')}</span>
          </span>
          {showAdvanced ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {showAdvanced && (
          <div>
            <Section title={t('setup.availableTitle')}>
              <div className="grid grid-cols-3 gap-2">{AVAILABLE.map((minutes) => <Chip key={minutes} active={context.availableMinutes === minutes} onClick={() => setContext((current) => ({ ...current, availableMinutes: minutes }))}>{minutes === 120 ? t('setup.twoHoursPlus') : t('setup.minutes', { n: minutes })}</Chip>)}</div>
            </Section>
            <Section title={t('setup.requirementsTitle')}>
              <div className="space-y-2">
                <Toggle active={context.requiredAttributes.includes('indoor')} onClick={() => toggleAttribute('indoor')} label={t('setup.indoorOnly')} />
                <Toggle active={context.requiredAttributes.includes('accessible')} onClick={() => toggleAttribute('accessible')} label={t('setup.accessibleOnly')} />
                <Toggle active={context.excludeVisited} onClick={() => setContext((current) => ({ ...current, excludeVisited: !current.excludeVisited }))} label={t('setup.excludeVisited')} />
              </div>
            </Section>
          </div>
        )}

        <div className="sticky bottom-0 -mx-5 bg-gradient-to-t from-hanji via-hanji to-transparent px-5 pb-[calc(12px+env(safe-area-inset-bottom))] pt-5">
          <button type="button" disabled={saving} onClick={() => void finish(context)} className="w-full border border-muk bg-muk py-4 text-white font-bold transition-colors hover:bg-jade disabled:opacity-50">{saving ? t('setup.saving') : t('setup.start')}</button>
        </div>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mb-7 border-t border-line pt-4"><h2 className="mb-3 text-sm font-bold">{title}</h2>{children}</section>; }
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" aria-pressed={active} onClick={onClick} className={`border px-3 py-3 text-sm font-semibold transition-colors ${active ? 'border-jade bg-jade text-white' : 'border-line bg-transparent hover:border-muk-soft'}`}>{children}</button>; }
function Toggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) { return <button type="button" aria-pressed={active} onClick={onClick} className={`w-full flex items-center justify-between border px-4 py-3 text-left text-sm font-semibold transition-colors ${active ? 'border-jade bg-jade text-white' : 'border-line bg-transparent hover:border-muk-soft'}`}><span>{label}</span>{active && <Check size={17} />}</button>; }
