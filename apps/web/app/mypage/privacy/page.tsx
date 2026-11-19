'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft, FileText, HardDrive, BarChart3, MousePointerClick, ShieldAlert, ShieldCheck, Scale, Mail } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';

// 이 안내문을 마지막으로 고친 날 — 문구를 바꾸면 함께 바꾼다(푸터 '최종 업데이트 · {date}', e2e/mypage.spec.ts 가 잠근다).
// 2026-11-12: '접속·조작 기록' 절 추가(lib/actionLog). ⚠️ 이 절과 함께 고친 문장은 법률 검토 대기 중이다 — 화면에는 적지 않는다.
const PRIVACY_UPDATED_AT = '2026-11-12';

export default function PrivacyPage() {
  const router = useRouter();
  const t = useT();

  // 개인정보/약관 섹션 — 아이콘 + 제목 + 본문 키를 한 곳에서 정의(정적 렌더).
  const sections = [
    { id: 'collect', icon: FileText, titleKey: 'privacy.collectTitle', bodyKey: 'privacy.collectBody' },
    { id: 'storage', icon: HardDrive, titleKey: 'privacy.storageTitle', bodyKey: 'privacy.storageBody' },
    // 익명 이용 기록(lib/usageEvents · public.usage_events, 2026-10-23). 제목은 웹 전용 anonUsageTitle —
    // privacy.usageTitle 은 앱(apps/mobile)이 그대로 쓴다. 아래 접속·조작 기록과 헷갈리지 않게 '익명' 을 붙였다.
    { id: 'usage', icon: BarChart3, titleKey: 'privacy.anonUsageTitle', bodyKey: 'privacy.usageBody' },
    // 접속·조작 기록(lib/actionLog · public.action_logs, 2026-11-12) — 계정·IP 원본(1년)·화면 조작, 검색어·음성 문장은 가려서.
    // 법률 검토 대기 중(코드 주석으로만 둔다).
    { id: 'actionLog', icon: MousePointerClick, titleKey: 'privacy.actionLogTitle', bodyKey: 'privacy.actionLogBody' },
    // 게스트 방문 확인 답의 네트워크 대역 해시(30일) · 원본 IP 는 메모리에만(D3, 2026-10-31). Turnstile 은 제3자 항목에.
    // 웹은 abuseWebBody — 'IP 원본은 저장하지 않는다' 를 이 답으로 좁혔다(접속·조작 기록이 IP 를 남긴다). 앱은 privacy.abuseBody 그대로.
    { id: 'abuse', icon: ShieldAlert, titleKey: 'privacy.abuseTitle', bodyKey: 'privacy.abuseWebBody' },
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
      <main className="flex-1 flex flex-col gap-4 relative z-10 px-6 overflow-y-auto pb-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] md:pb-6 no-scrollbar">

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
          {t('privacy.footer', { date: PRIVACY_UPDATED_AT })}
        </p>
      </main>

      {/* 은은한 노을 광원 */}
      <div className="absolute top-1/4 left-1/4 w-[300px] h-[300px] bg-sunset-1/10 rounded-full blur-[100px] pointer-events-none z-0"></div>
    </div>
  );
}
