'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Globe, BellRing, Database, Trash2, Info, Store, ChevronRight, UserX, Monitor, Sun, Moon } from 'lucide-react';
import { toast } from 'sonner';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { CongestionAlertToggle } from '@/components/CongestionAlertToggle';
import { useT } from '@/lib/i18n/I18nProvider';
import { deleteMyAccount } from '@/lib/api-client';
import { getAuthState } from '@/lib/auth';
import { createPublicClient } from '@/lib/supabase';
import { clearUserScopedData } from '@/lib/userData';
import { clearSavedAll } from '@/lib/savedFacilities';
import { useTheme } from '@/components/ThemeProvider';
import type { ThemeMode } from '@/lib/theme';

// 앱 정보 표시용 버전 — package.json 과 동기(정적 export 라 런타임 import 대신 상수 단일 정의점).
const APP_VERSION = '0.1.0';

export default function SettingsPage() {
  const router = useRouter();
  const t = useT();
  const { mode: themeMode, resolvedTheme, setMode: setThemeMode } = useTheme();
  const [hasAccount, setHasAccount] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let alive = true;
    void getAuthState().then((state) => {
      if (alive) setHasAccount(state.status === 'linked');
    });
    return () => { alive = false; };
  }, []);

  // 저장 데이터 초기화 — 되돌릴 수 없는 파괴적 동작이라 네이티브 confirm() 대신
  // 전역 sonner 토스트의 action/cancel 로 인페이지 확인을 받는다(saved 페이지 clearAll 과 동일 패턴).
  const handleResetData = () => {
    toast(t('settings.resetConfirm'), {
      description: t('settings.resetConfirmDesc'),
      duration: 8000,
      action: {
        label: t('settings.resetAction'),
        onClick: () => { void (async () => {
          await clearSavedAll();
          try {
            localStorage.removeItem('nextspot_setup_prefs');
          } catch {
            /* localStorage 차단 환경 — 조용히 무시 */
          }
          toast.success(t('settings.resetSuccess'));
        })(); },
      },
      cancel: {
        label: t('common.cancel'),
        onClick: () => {},
      },
    });
  };

  const handleDeleteAccount = () => {
    if (deleting) return;
    toast(t('settings.deleteAccountConfirm'), {
      description: t('settings.deleteAccountConfirmDesc'),
      duration: 10000,
      action: {
        label: t('settings.deleteAccountAction'),
        onClick: () => { void (async () => {
          setDeleting(true);
          try {
            await deleteMyAccount();
            await createPublicClient().auth.signOut({ scope: 'local' });
            clearUserScopedData();
            toast.success(t('settings.deleteAccountSuccess'));
            router.replace('/');
          } catch {
            setDeleting(false);
            toast.error(t('settings.deleteAccountFailed'));
          }
        })(); },
      },
      cancel: { label: t('common.cancel'), onClick: () => {} },
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

        {/* 화면 테마 — 자동은 경주 현지 시각 18:00~06:00에 다크모드. */}
        <section className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gold/10">
              {resolvedTheme === 'dark' ? <Moon size={20} className="text-gold" /> : <Sun size={20} className="text-gold" />}
            </div>
            <div className="flex min-w-0 flex-col">
              <h2 className="font-bold text-muk">{t('theme.title')}</h2>
              <p className="text-xs leading-relaxed text-muk-soft">{t('theme.description')}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('theme.title')}>
            {([
              ['auto', Monitor, 'theme.auto'],
              ['light', Sun, 'theme.light'],
              ['dark', Moon, 'theme.dark'],
            ] as const).map(([value, Icon, label]) => {
              const selected = themeMode === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setThemeMode(value as ThemeMode)}
                  className={`toss-pressable flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-3 text-xs font-bold transition-colors ${selected ? 'border-gold bg-gold/15 text-gold-deep' : 'border-line bg-hanji text-muk-soft hover:border-gold/45 hover:text-muk'}`}
                >
                  <Icon size={17} aria-hidden />
                  <span>{t(label)}</span>
                </button>
              );
            })}
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

        {/* 비즈니스 계정 — 사장님 전용 게이트(/merchant)로 이동. */}
        <button
          type="button"
          onClick={() => router.push('/merchant')}
          className="group w-full rounded-3xl border border-gold/35 bg-gradient-to-r from-gold/15 via-hanji to-terracotta/10 p-5 text-left shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors hover:border-gold/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15">
                <Store size={20} className="text-gold-deep" />
              </div>
              <div className="min-w-0">
                <h2 className="font-bold text-muk">비즈니스 계정으로 전환</h2>
                <p className="text-xs text-muk-soft">NextSpot 사장님 콘솔로 이동합니다</p>
              </div>
            </div>
            <ChevronRight size={20} className="shrink-0 text-gold-deep transition-transform group-hover:translate-x-0.5" />
          </div>
        </button>

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

        {hasAccount && (
          <section className="rounded-3xl border border-terracotta/35 bg-white p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-terracotta/10">
                <UserX size={20} className="text-terracotta" />
              </div>
              <div>
                <h2 className="font-bold text-muk">{t('settings.deleteAccountTitle')}</h2>
                <p className="text-xs text-muk-soft">{t('settings.deleteAccountDesc')}</p>
              </div>
            </div>
            <button type="button" disabled={deleting} onClick={handleDeleteAccount} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-terracotta/30 px-4 py-3 text-sm font-semibold text-terracotta disabled:opacity-50">
              <Trash2 size={16} />
              {deleting ? t('common.loading') : t('settings.deleteAccount')}
            </button>
          </section>
        )}

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
