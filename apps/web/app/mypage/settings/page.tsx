'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft, Globe, BellRing, Database, Trash2, Info } from 'lucide-react';
import { toast } from 'sonner';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { CongestionAlertToggle } from '@/components/CongestionAlertToggle';
import { useT } from '@/lib/i18n/I18nProvider';

// 앱 정보 표시용 버전 — package.json 과 동기(정적 export 라 런타임 import 대신 상수 단일 정의점).
const APP_VERSION = '0.1.0';

export default function SettingsPage() {
  const router = useRouter();
  const t = useT();

  // 저장 데이터 초기화 — 되돌릴 수 없는 파괴적 동작이라 네이티브 confirm() 대신
  // 전역 sonner 토스트의 action/cancel 로 인페이지 확인을 받는다(saved 페이지 clearAll 과 동일 패턴).
  const handleResetData = () => {
    toast(t('settings.resetConfirm'), {
      description: t('settings.resetConfirmDesc'),
      duration: 8000,
      action: {
        label: t('settings.resetAction'),
        onClick: () => {
          try {
            localStorage.removeItem('nextspot_saved_facilities');
            localStorage.removeItem('nextspot_setup_prefs');
          } catch {
            /* localStorage 차단 환경 — 조용히 무시 */
          }
          toast.success(t('settings.resetSuccess'));
        },
      },
      cancel: {
        label: t('common.cancel'),
        onClick: () => {},
      },
    });
  };

  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center gap-3 p-5 z-10 relative">
        <button
          type="button"
          aria-label={t('settings.backAria')}
          onClick={() => router.push('/mypage')}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">{t('settings.title')}</h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col gap-4 relative z-10 px-6 overflow-y-auto pb-[calc(80px+env(safe-area-inset-bottom))] md:pb-6 no-scrollbar">

        {/* 언어 */}
        <section className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-jade/10 flex items-center justify-center">
              <Globe size={20} className="text-jade" />
            </div>
            <div className="flex flex-col">
              <h2 className="text-muk font-bold">{t('settings.langTitle')}</h2>
              <p className="text-xs text-muk-soft">{t('settings.langDesc')}</p>
            </div>
          </div>
          <div className="flex justify-start">
            <LanguageSwitcher />
          </div>
        </section>

        {/* 혼잡 알림 */}
        <section className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
              <BellRing size={20} className="text-gold" />
            </div>
            <div className="flex flex-col">
              <h2 className="text-muk font-bold">{t('settings.alertTitle')}</h2>
              <p className="text-xs text-muk-soft">{t('settings.alertDesc')}</p>
            </div>
          </div>
          <CongestionAlertToggle />
        </section>

        {/* 데이터 관리 */}
        <section className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-terracotta/10 flex items-center justify-center">
              <Database size={20} className="text-terracotta" />
            </div>
            <div className="flex flex-col">
              <h2 className="text-muk font-bold">{t('settings.dataTitle')}</h2>
              <p className="text-xs text-muk-soft">{t('settings.resetDataDesc')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResetData}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-terracotta/30 bg-terracotta/10 px-4 py-3 text-sm font-semibold text-terracotta transition-colors hover:bg-terracotta/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
          >
            <Trash2 size={16} />
            <span>{t('settings.resetData')}</span>
          </button>
        </section>

        {/* 앱 정보 */}
        <section className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-muk/5 flex items-center justify-center">
              <Info size={20} className="text-muk-soft" />
            </div>
            <h2 className="text-muk font-bold">{t('settings.appInfoTitle')}</h2>
          </div>
          <div className="flex items-center justify-between rounded-2xl bg-hanji px-4 py-3 border border-line">
            <div className="flex flex-col">
              <span className="text-muk font-semibold font-serif">{t('common.appName')}</span>
              <span className="text-xs text-muk-soft">{t('settings.appDesc')}</span>
            </div>
            <span className="text-xs font-medium text-muk-soft">{t('settings.version', { version: APP_VERSION })}</span>
          </div>
        </section>
      </main>

      {/* 은은한 노을 광원 */}
      <div className="absolute top-1/4 right-1/4 w-[300px] h-[300px] bg-sunset-1/10 rounded-full blur-[100px] pointer-events-none z-0"></div>
    </div>
  );
}
