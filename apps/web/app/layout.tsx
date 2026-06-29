import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import { Toaster } from "sonner";
import PageTransition from "@/components/PageTransition";
import BottomNav from "@/components/BottomNav";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const notoSansKr = Noto_Sans_KR({ variable: "--font-noto-sans-kr", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NextSpot",
  description: "오버투어리즘 없는 스마트한 경주 여행",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${notoSansKr.variable} h-full antialiased`}>
      <head>
        <Script
          id="kakao-maps-sdk"
          src={`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || ""}&autoload=false&libraries=services,clusterer`}
          strategy="beforeInteractive"
        />
      </head>
      <body className="min-h-full flex flex-col font-sans bg-[#0b101e]">
        <PageTransition>{children}</PageTransition>
        <BottomNav />
        <Toaster position="bottom-center" theme="dark" richColors toastOptions={{
          style: { background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', color: '#f1f5f9' },
          className: 'backdrop-blur-md'
        }} />
      </body>
    </html>
  );
}