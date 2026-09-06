import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR, Noto_Serif_KR } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import PageTransition from "@/components/shell/PageTransition";
import BottomNav from "@/components/shell/BottomNav";
import ServiceWorkerRegister from "@/components/shell/ServiceWorkerRegister";
import SessionBootstrap from "@/components/shell/SessionBootstrap";
import InstallPrompt from "@/components/shell/InstallPrompt";
import LlmDebugToast from "@/components/shell/LlmDebugToast";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
// 계정 권한(역할·소유 가게) 단일 출처 — 콘솔 진입점 게이팅에 쓴다(lib/account.tsx).
import { AccountProvider } from "@/lib/account";
import MotionProvider from "@/components/shell/MotionProvider";
import ThemeProvider from "@/components/shell/ThemeProvider";
import ThemeToaster from "@/components/shell/ThemeToaster";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// 본문 한글 산세(Noto Sans KR) + 제목 한글 명조(Noto Serif KR) — 경주 관광 헤리티지 톤.
const notoSansKr = Noto_Sans_KR({ variable: "--font-noto-sans-kr", weight: ["400", "500", "700"], subsets: ["latin"] });
const notoSerifKr = Noto_Serif_KR({ variable: "--font-noto-serif-kr", weight: ["500", "700"], subsets: ["latin"] });
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://nextspot-nu.vercel.app";

export const metadata: Metadata = {
  // 정적 export에서도 OG/Twitter 이미지가 localhost가 아닌 실제 서비스 절대 URL로 생성되게 한다.
  metadataBase: new URL(siteUrl),
  title: "NextSpot",
  description: "오버투어리즘 없는 스마트한 경주 여행",
  // PWA: 관광객은 이동 중 모바일 사용이 기본 — 홈 화면 설치를 지원한다(정적 export 호환).
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "NextSpot" },
  // 공유 개통 1단계: 카카오톡/인스타 등에서 링크 미리보기가 뜨도록 OG/Twitter 카드를 채운다.
  // 정적 export 호환 — 문자열 리터럴만 사용(동적 함수/서버 로직 없음).
  openGraph: {
    title: "NextSpot",
    description: "오버투어리즘 없는 스마트한 경주 여행",
    siteName: "NextSpot",
    locale: "ko_KR",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "NextSpot",
    description: "오버투어리즘 없는 스마트한 경주 여행",
    images: ["/og.png"],
  },
};

export const viewport = {
  // 경주 관광 톤 — 한지 아이보리(관광객 라이트 방향). 브라우저/PWA 상태바 색.
  themeColor: "#faf5ec",
  // 노치/홈 인디케이터 안전영역 활성화 — 하단 내비·플로팅 카드의 env(safe-area-inset-*) 가 실제로 동작한다.
  viewportFit: "cover" as const,
};

// React가 하이드레이션되기 전에 적용해 야간 첫 화면이 밝게 번쩍이는 현상을 막는다.
// 자동 판정은 관광객의 기기 시간대가 아니라 서비스 현장인 Asia/Seoul을 기준으로 한다.
const themeBootstrapScript = `(function(){try{var p=location.pathname;var enabled=!/^\\\/(admin|merchant)(\\\/|$)/.test(p);var saved=localStorage.getItem('nextspot_theme');var mode=saved==='light'||saved==='dark'?saved:'auto';var h=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).find(function(x){return x.type==='hour';}).value);var dark=enabled&&(mode==='dark'||(mode==='auto'&&(h>=18||h<6)));document.documentElement.classList.toggle('nextspot-dark',dark);document.documentElement.dataset.nextspotTheme=enabled?(dark?'dark':'light'):'system';}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning lang="ko" className={`${geistSans.variable} ${geistMono.variable} ${notoSansKr.variable} ${notoSerifKr.variable} h-full antialiased`}>
      <head>
        <Script id="nextspot-theme" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        <Script
          id="kakao-maps-sdk"
          src={`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || ""}&autoload=false&libraries=services,clusterer`}
          strategy="beforeInteractive"
        />
      </head>
      <body className="min-h-full flex font-sans bg-hanji">
        {/* PWA 오프라인 복원력 — /sw.js 등록(프로덕션 유사 환경 전용, 자체 가드). */}
        <ServiceWorkerRegister />
        {/* 무마찰 익명 세션 부트스트랩 — 로그인 UI 없이 방문자마다 실제 per-device 세션 생성.
            익명 로그인 비활성 프로젝트에선 조용히 목업 방문자 동작으로 폴백(무회귀). 자체 가드. */}
        <SessionBootstrap />
        {/* 왼쪽 세로 내비게이션 레일(인플로우) — 숨김 경로에서 null 이면 콘텐츠가 전체폭을 차지. */}
        <ThemeProvider>
          <I18nProvider>
            <AccountProvider>
            <MotionProvider>
            <BottomNav />
            {/* PWA 설치 유도 배너 — beforeinstallprompt 캡처는 useT() 로 i18n 문구를 쓰므로 I18nProvider 내부에 마운트. */}
            <InstallPrompt />
            <PageTransition>{children}</PageTransition>
            <LlmDebugToast />
            </MotionProvider>
            </AccountProvider>
          </I18nProvider>
          <ThemeToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
