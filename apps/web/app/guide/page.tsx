'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import GuideContent from '@/components/guide/GuideContent';
import { useT } from '@/lib/i18n/I18nProvider';

export default function GuidePage() {
  const t = useT();
  return (
    <main className="min-h-screen bg-hanji text-muk">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 md:px-10">
        <span className="shrink-0 font-semibold">NextSpot <span className="ml-2 hidden text-sm font-normal text-muk-soft sm:inline">{t('guide.label')}</span></span>
        <Link href="/main" className="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs hover:bg-hanji-deep sm:text-sm"><ArrowLeft size={16} />{t('guide.back')}</Link>
      </header>
      <GuideContent />
    </main>
  );
}
