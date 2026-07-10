'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft, FileText, HardDrive, ShieldCheck, Scale, Mail } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';

export default function PrivacyPage() {
  const router = useRouter();
  const t = useT();

  // 개인정보/약관 섹션 — 아이콘 + 제목 + 본문 키를 한 곳에서 정의(정적 렌더).
  const sections = [
    { id: 'collect', icon: FileText, titleKey: 'privacy.collectTitle', bodyKey: 'privacy.collectBody' },
    { id: 'storage', icon: HardDrive, titleKey: 'privacy.storageTitle', bodyKey: 'privacy.storageBody' },
    { id: 'thirdParty', icon: ShieldCheck, titleKey: 'privacy.thirdPartyTitle', bodyKey: 'privacy.thirdPartyBody' },
    { id: 'terms', icon: Scale, titleKey: 'privacy.termsTitle', bodyKey: 'privacy.termsBody' },
    { id: 'contact', icon: Mail, titleKey: 'privacy.contactTitle', bodyKey: 'privacy.contactBody' },
  ];

  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center gap-3 p-5 z-10 relative">
        <button
          type="button"
          aria-label={t('privacy.backAria')}
          onClick={() => router.push('/mypage')}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">{t('privacy.title')}</h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col gap-4 relative z-10 px-6 overflow-y-auto pb-[calc(80px+env(safe-area-inset-bottom))] md:pb-6 no-scrollbar">

        {/* 안내 문단 */}
        <p className="text-sm text-muk-soft leading-relaxed px-1">
          {t('privacy.intro')}
        </p>

        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <section
              key={section.id}
              className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
            >
              <div className="flex items-center gap-3 mb-2.5">
                <div className="w-9 h-9 rounded-full bg-gold/10 flex items-center justify-center shrink-0">
                  <Icon size={18} className="text-gold-deep" />
                </div>
                <h2 className="text-muk font-bold">{t(section.titleKey)}</h2>
              </div>
              <p className="text-sm text-muk-soft leading-relaxed">{t(section.bodyKey)}</p>
            </section>
          );
        })}

        {/* 푸터 */}
        <p className="text-xs text-muk-soft/80 text-center px-4 py-2">
          {t('privacy.footer')}
        </p>
      </main>

      {/* 은은한 노을 광원 */}
      <div className="absolute top-1/4 left-1/4 w-[300px] h-[300px] bg-sunset-1/10 rounded-full blur-[100px] pointer-events-none z-0"></div>
    </div>
  );
}
