import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR, Noto_Serif_KR } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import { Toaster } from "sonner";
import PageTransition from "@/components/PageTransition";
import BottomNav from "@/components/BottomNav";
import { I18nProvider } from "@/lib/i18n/I18nProvider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// 본문 한글 산세(Noto Sans KR) + 제목 한글 명조(Noto Serif KR) — 경주 관광 헤리티지 톤.
const notoSansKr = Noto_Sans_KR({ variable: "--font-noto-sans-kr", weight: ["400", "500", "700"], subsets: ["latin"] });
const notoSerifKr = Noto_Serif_KR({ variable: "--font-noto-serif-kr", weight: ["500", "700"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NextSpot",
  description: "오버투어리즘 없는 스마트한 경주 여행",
  // PWA: 관광객은 이동 중 모바일 사용이 기본 — 홈 화면 설치를 지원한다(정적 export 호환).
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "NextSpot" },
};

export const viewport = {
  // 경주 관광 톤 — 한지 아이보리(관광객 라이트 방향). 브라우저/PWA 상태바 색.
  themeColor: "#faf5ec",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${geistSans.variable} ${geistMono.variable} ${notoSansKr.variable} ${notoSerifKr.variable} h-full antialiased`}>
      <head>
        <Script
          id="kakao-maps-sdk"
          src={`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || ""}&autoload=false&libraries=services,clusterer`}
          strategy="beforeInteractive"
        />
      </head>
      <body className="min-h-full flex font-sans bg-hanji">
        {/* 왼쪽 세로 내비게이션 레일(인플로우) — 숨김 경로에서 null 이면 콘텐츠가 전체폭을 차지. */}
        <I18nProvider>
          <BottomNav />
          <PageTransition>{children}</PageTransition>
        </I18nProvider>
        {/* 한지 라이트 토스트 — 앱의 웜 팔레트와 통일(과거 InduSpot 콜드 슬레이트 제거). richColors 는 성공/에러 의미색 유지. */}
        <Toaster position="bottom-center" theme="light" richColors toastOptions={{
          style: { background: '#faf5ec', border: '1px solid #e6dcc6', color: '#2b2320' },
          className: 'backdrop-blur-md'
        }} />
      </body>
    </html>
  );
}