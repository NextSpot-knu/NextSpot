'use client';

// 운영자 공개 설정(점검 모드·공지·혼잡 경계) 컨텍스트 — 부팅 시 **1회** 조회한다.
//
// 배경: 관리자 콘솔에 점검 모드·공지·혼잡 경계 설정이 있는데 관광객 앱이 그것을 한 번도
// 읽지 않았다. 설정은 저장되지만 아무 화면도 바뀌지 않는 상태였다.
//
// ⚠️ 이 조회의 실패는 **아무것도 아니어야 한다.**
//    GET /api/v1/system/public-settings 는 아직 배포되지 않았을 수 있고(라우터 동시 작업),
//    Render 무료 플랜 콜드 스타트로 타임아웃이 날 수도 있다. 그때 점검 화면을 띄우면
//    멀쩡한 서비스를 우리 손으로 내리는 것이다. 404·500·타임아웃·형식 이상은 전부
//    FALLBACK_PUBLIC_SETTINGS(= 평소 화면)로 떨어진다. 판정은 lib/publicSettings.ts 에 있다.
//
// 조회를 한 번만 하는 이유: 점검·공지는 분 단위로 바뀌는 값이 아니고, 폴링을 걸면
// 관광객 수만큼 백엔드를 계속 두드린다. 운영자가 점검을 켜면 새로 들어오는 방문자부터
// 안내를 받는다(이미 열려 있는 탭은 다음 로드에서).

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { X, Wrench, Megaphone } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';
import {
  FALLBACK_PUBLIC_SETTINGS,
  isTouristPath,
  parsePublicSettings,
  type PublicSettings,
} from '@/lib/publicSettings';

const PublicSettingsContext = createContext<PublicSettings>(FALLBACK_PUBLIC_SETTINGS);

/** 운영자 설정. 프로바이더 밖에서 불려도 폴백을 돌려준다(화면을 깨뜨리지 않는다). */
export function usePublicSettings(): PublicSettings {
  return useContext(PublicSettingsContext);
}

/** '혼잡' 등급 경계(0..1). 설정을 못 받았으면 DEFAULT_BUSY_THRESHOLD. */
export function useBusyThreshold(): number {
  return useContext(PublicSettingsContext).busyThreshold;
}

export default function PublicSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PublicSettings>(FALLBACK_PUBLIC_SETTINGS);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const pathname = usePathname();
  const t = useT();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 타임아웃을 기본(10초)보다 짧게 잡는다 — 이 값은 화면을 **더 그리기 위한** 것이라
        // 없어도 앱이 정상 동작한다. 콜드 스타트를 오래 기다릴 이유가 없다.
        const data = await apiClient.get('/api/v1/system/public-settings', { timeoutMs: 4000 });
        if (alive) setSettings(parsePublicSettings(data));
      } catch {
        // 조용히 폴백. 404(미배포)를 콘솔 경고로 시끄럽게 만들지 않는다 — 지금 정상 상태다.
      }
    })();
    return () => { alive = false; };
  }, []);

  const value = useMemo(() => settings, [settings]);

  // 콘솔(관리자·상인·개발)에는 그리지 않는다. 점검을 푸는 쪽이 점검 화면에 갇히면 안 된다.
  const tourist = isTouristPath(pathname);
  const showMaintenance = tourist && settings.maintenanceMode;
  const showNotice = tourist && !settings.maintenanceMode && !noticeDismissed && settings.noticeText !== '';

  return (
    <PublicSettingsContext.Provider value={value}>
      {showMaintenance ? (
        <MaintenanceScreen noticeText={settings.noticeText} />
      ) : (
        <>
          {showNotice && (
            // fixed 오버레이로 띄운다 — 인플로우로 넣으면 body 의 flex 레이아웃(왼쪽 내비 레일)이
            // 밀려 모든 페이지의 상단 간격이 어긋난다.
            <div
              role="status"
              className="fixed inset-x-0 top-0 z-[75] px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)]"
            >
              <div className="mx-auto flex max-w-2xl items-start gap-2 rounded-2xl border border-gold/40 bg-white/95 px-3 py-2.5 shadow-[0_2px_14px_rgba(43,35,32,0.14)] backdrop-blur">
                <Megaphone size={15} className="mt-0.5 shrink-0 text-gold-deep" aria-hidden />
                <p className="min-w-0 flex-1 whitespace-pre-line text-[12px] font-medium leading-snug text-muk">
                  {settings.noticeText}
                </p>
                <button
                  type="button"
                  onClick={() => setNoticeDismissed(true)}
                  aria-label={t('systemNotice.dismiss')}
                  className="-mr-1 shrink-0 rounded-full p-1 text-muk-soft transition-colors hover:text-muk focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
          {children}
        </>
      )}
    </PublicSettingsContext.Provider>
  );
}

/** 전면 점검 안내 — 관광객 앱의 모든 화면을 대신한다.
 *
 * 공지 문구가 함께 설정돼 있으면 같이 보여 준다(언제 끝나는지 같은 맥락이 거기 담긴다).
 * 없으면 지어내지 않고 기본 안내만 남긴다. */
function MaintenanceScreen({ noticeText }: { noticeText: string }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-hanji px-6 text-muk">
      <div className="w-full max-w-sm space-y-3 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-gold/30 bg-gold/10 text-gold-deep">
          <Wrench size={24} aria-hidden />
        </span>
        <h1 className="font-serif text-xl font-bold">{t('systemNotice.maintenanceTitle')}</h1>
        <p className="text-sm leading-relaxed text-muk-soft">{t('systemNotice.maintenanceBody')}</p>
        {noticeText !== '' && (
          <p className="whitespace-pre-line rounded-2xl border border-line bg-white px-4 py-3 text-[12px] leading-relaxed text-muk">
            {noticeText}
          </p>
        )}
      </div>
    </div>
  );
}
