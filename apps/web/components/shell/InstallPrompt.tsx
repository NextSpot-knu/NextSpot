'use client';

// PWA 설치 유도 배너 — manifest.webmanifest 는 설치 가능 상태가 완비돼 있지만 beforeinstallprompt
// 리스너가 앱 어디에도 없어(감사 확인) 브라우저의 자동 설치 배너가 나타나지 않는다. 이 컴포넌트가
// 이벤트를 직접 캡처해 자체 UI(한지 카드)로 설치를 유도한다.
//
// 노출 조건(재방문자 대상 — 첫 방문에 바로 들이밀지 않는다):
//   1) localStorage nextspot_visit_count >= 2  — 이 컴포넌트가 세션(탭)당 1회만 증가시켜 관리한다
//      (sessionStorage 가드로 같은 세션 내 리마운트/페이지 이동 시 중복 카운트 방지).
//   2) localStorage nextspot_install_snooze 가 없거나 만료됨 — '나중에' 선택 시 now+30일 저장.
//   3) matchMedia('(display-mode: standalone)') / navigator.standalone 이 아직 아님
//      — 이미 설치돼 홈 화면에서 실행 중이면 영구 미노출(재평가 불필요, 매 마운트마다 확인).
//
// 플랫폼 분기:
//   - Android/Chrome 등: beforeinstallprompt 를 캡처(e.preventDefault)해 두었다가 배너의
//     '설치' 탭 시 deferredPrompt.prompt() 로 네이티브 설치 다이얼로그를 띄운다.
//   - iOS Safari: beforeinstallprompt 자체가 없는 플랫폼이라 조건 충족 시 배너를 바로 띄우고,
//     '설치' 탭 시 프로그래밍적 설치 대신 '공유 → 홈 화면에 추가' 안내 시트(3단계 텍스트 도식)를 연다.
//
// 팔레트·포털·모션 관례는 FestivalBanner/VisitCheckCard 를 따른다(한지 웜톤 + body 포털 + framer-motion).

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Share, SquarePlus, Smartphone } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';

const VISIT_COUNT_KEY = 'nextspot_visit_count';
const SNOOZE_KEY = 'nextspot_install_snooze';
// sessionStorage 가드 — 같은 탭 세션에서 nextspot_visit_count 를 두 번 이상 올리지 않기 위함.
const SESSION_COUNTED_KEY = 'nextspot_visit_counted_session';
const MIN_VISITS = 2;
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000; // 30일

// 표준 lib.dom.d.ts 에 아직 없는 이벤트 — 필요한 멤버만 최소 선언.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isStandalone(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

// iOS 사파리만 대상 — Chrome/Firefox/Edge for iOS 는 UA 상 iOS 이지만 공유 시트 동선이 달라
// '공유 버튼 → 홈 화면에 추가' 안내가 그대로 맞지 않을 수 있어 제외한다.
function isIosSafari(): boolean {
  try {
    const ua = window.navigator.userAgent;
    const isIosUa = /iphone|ipad|ipod/i.test(ua);
    // iPadOS 13+ 는 데스크톱 사파리로 위장(UA 에 iPad 미포함) → 터치 지원으로 보정.
    const isIpadOs13 = /macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
    const isOtherIosBrowser = /crios|fxios|edgios|opios/i.test(ua);
    return (isIosUa || isIpadOs13) && !isOtherIosBrowser;
  } catch {
    return false;
  }
}

function readSnoozeUntil(): number {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeSnooze(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    /* localStorage 차단 환경 — 스누즈 없이도 무해(다음 방문에 다시 노출될 뿐) */
  }
}

// 방문 카운트를 세션당 1회만 증가시키고 최신 값을 반환한다.
function bumpVisitCountOncePerSession(): number {
  try {
    const already = sessionStorage.getItem(SESSION_COUNTED_KEY);
    const current = Number(localStorage.getItem(VISIT_COUNT_KEY) || '0') || 0;
    if (already) return current;
    const next = current + 1;
    localStorage.setItem(VISIT_COUNT_KEY, String(next));
    sessionStorage.setItem(SESSION_COUNTED_KEY, '1');
    return next;
  } catch {
    return 0;
  }
}

export function InstallPrompt() {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [variant, setVariant] = useState<'android' | 'ios'>('android');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosSheet, setShowIosSheet] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 이미 홈 화면에서 실행 중(standalone) — 설치를 다시 권할 이유가 없다. 영구 미노출.
    if (isStandalone()) return;

    const count = bumpVisitCountOncePerSession();
    const snoozeUntil = readSnoozeUntil();
    const snoozed = snoozeUntil > 0 && Date.now() < snoozeUntil;
    const eligible = count >= MIN_VISITS && !snoozed;
    if (!eligible) return;

    // Android/Chrome 계열 — 네이티브 이벤트 캡처(자동 미니배너 억제 후 우리 UI 로 대체).
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVariant('android');
      setVisible(true);
    };
    // 설치가 이미 끝나면(다른 경로 포함) 배너를 즉시 치운다.
    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setVisible(false);
      setShowIosSheet(false);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    // iOS Safari — beforeinstallprompt 가 없는 플랫폼이라 조건 충족 시 바로 안내 배너를 노출.
    if (isIosSafari()) {
      setVariant('ios');
      setVisible(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleLater = useCallback(() => {
    writeSnooze();
    setVisible(false);
    setShowIosSheet(false);
  }, []);

  const handleInstall = useCallback(async () => {
    if (variant === 'ios') {
      // iOS 는 프로그래밍적 설치가 없다 — 공유 시트 사용법 안내로 대체.
      setShowIosSheet(true);
      return;
    }
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch {
      /* 사용자가 네이티브 다이얼로그를 닫는 등 — 무해 */
    } finally {
      setDeferredPrompt(null);
      setVisible(false);
    }
  }, [variant, deferredPrompt]);

  if (!mounted || !visible) return null;

  return createPortal(
    <>
      <AnimatePresence>
        <motion.div
          key="install-prompt"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ type: 'spring', bounce: 0.25, duration: 0.5 }}
          className="fixed z-[54] left-1/2 -translate-x-1/2 bottom-[calc(88px+env(safe-area-inset-bottom))] w-full max-w-sm px-4"
        >
          <div className="relative bg-white/95 backdrop-blur-2xl border border-line rounded-3xl p-4 shadow-[0_8px_30px_rgba(43,35,32,0.16)]">
            {/* 상단 장식 라인 */}
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-gold/60 to-transparent" />

            <div className="flex items-start gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- 정적 export, 로컬 아이콘 에셋(unoptimized) */}
              <img
                src="/icon-192.png"
                alt={t('install.iconAlt')}
                width={40}
                height={40}
                className="w-10 h-10 shrink-0 rounded-xl border border-line shadow-sm"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-muk leading-snug break-keep">{t('install.title')}</p>
                <p className="text-[11px] text-muk-soft mt-0.5 leading-snug break-keep">{t('install.subtitle')}</p>
              </div>
            </div>

            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={handleLater}
                className="flex-1 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-2.5 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {t('install.later')}
              </button>
              <button
                type="button"
                onClick={handleInstall}
                className="flex-1 bg-gradient-to-r from-gold to-terracotta hover:from-gold-deep hover:to-terracotta text-white font-bold py-2.5 rounded-2xl transition-all active:scale-95 text-xs shadow-[0_4px_14px_rgba(193,85,59,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {t('install.install')}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>

      {/* iOS 안내 시트 — '공유 → 홈 화면에 추가' 3단계를 아이콘+텍스트 도식으로 보여준다. */}
      <AnimatePresence>
        {showIosSheet && (
          <motion.div
            key="install-ios-sheet"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center"
          >
            <button
              type="button"
              aria-label={t('common.close')}
              tabIndex={-1}
              onClick={() => setShowIosSheet(false)}
              className="absolute inset-0 bg-muk/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: 40, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', bounce: 0.25, duration: 0.5 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="install-ios-sheet-title"
              className="relative w-full max-w-sm bg-hanji border border-line rounded-t-3xl sm:rounded-3xl shadow-[0_-8px_40px_rgba(43,35,32,0.2)] sm:shadow-[0_20px_60px_rgba(43,35,32,0.25)] overflow-hidden"
            >
              <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-transparent via-gold/60 to-transparent" />

              <div className="flex items-start justify-between gap-3 p-6 pb-4">
                <div>
                  <h2 id="install-ios-sheet-title" className="text-lg font-serif font-bold text-muk leading-tight">
                    {t('install.iosSheetTitle')}
                  </h2>
                  <p className="text-[11px] text-muk-soft mt-1 font-medium">{t('install.iosSheetSubtitle')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowIosSheet(false)}
                  aria-label={t('common.close')}
                  className="p-1.5 rounded-full text-muk-soft hover:text-muk hover:bg-hanji-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="px-6 pb-6 flex flex-col gap-3">
                {[
                  { icon: Share, text: t('install.iosStep1') },
                  { icon: SquarePlus, text: t('install.iosStep2') },
                  { icon: Smartphone, text: t('install.iosStep3') },
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-2xl border border-line bg-white/70 p-3">
                    <span className="w-8 h-8 shrink-0 rounded-full bg-gold/10 border border-gold/25 flex items-center justify-center text-gold-deep text-xs font-bold">
                      {i + 1}
                    </span>
                    <step.icon size={18} className="shrink-0 text-muk-soft" aria-hidden />
                    <p className="text-sm text-muk leading-snug break-keep">{step.text}</p>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => setShowIosSheet(false)}
                  className="mt-1 w-full bg-gradient-to-r from-gold to-terracotta hover:from-gold-deep hover:to-terracotta text-white font-bold py-2.5 rounded-2xl transition-all active:scale-95 text-xs shadow-[0_4px_14px_rgba(193,85,59,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t('install.iosConfirm')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
}

export default InstallPrompt;
