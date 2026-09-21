'use client';

// 404 화면 — App Router 규약 파일(파일명 고정). 정적 export(output:'export')에서는 빌드 시
// `out/404.html` 로 떨어져 Vercel 이 없는 경로에 그대로 내어 준다.
//
// 왜 브랜드 화면인가: 여기는 잘못 입력한 주소·옛 링크·데모 중 오타가 도착하는 자리다. 기본
// Next 404 가 뜨면 방금까지 보던 한지 톤의 서비스가 아니라 프레임워크가 보인다. 이 화면의 일은
// 사과 한 줄과 **돌아갈 길 하나**를 주는 것이고, 그 길은 지도(/main)다 — 이 서비스의 출발점.
//
// I18nProvider 는 루트 레이아웃(app/layout.tsx)이 children 을 감싸므로 여기서도 살아 있다.
// (app/error.tsx 가 t() 를 안 쓰는 건 그 경우엔 Provider 트리 자체가 무너졌을 수 있어서다 —
//  404 는 정상 렌더 경로라 사정이 다르다.)

import Link from 'next/link';
import { Compass, MapPin } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';
import NextSpotMascot from '@/components/NextSpotMascot';

export default function NotFound() {
  const t = useT();

  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-hanji px-6 py-16 text-muk">
      {/* 배경 노을·금빛 광원 — /waiting·/course 와 같은 톤(같은 서비스 안이라는 신호). */}
      <div className="pointer-events-none absolute left-[-10%] top-[-20%] h-[520px] w-[520px] rounded-full bg-sunset-1/10 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-10%] right-[-10%] h-[520px] w-[520px] rounded-full bg-gold/10 blur-[120px]" />

      <div className="relative z-10 mx-auto flex w-full max-w-md flex-col items-center text-center">
        <NextSpotMascot variant="avatar" className="mb-6 w-24" />

        {/* 큰 404 — 장식이지만 '무슨 화면인지'를 즉시 말해 주는 유일한 기호라 남긴다. */}
        <p className="font-serif text-[64px] font-black leading-none tracking-tight text-gold-deep/85 tabular-nums">
          404
        </p>

        <h1 className="mt-4 font-serif text-[22px] font-black leading-snug tracking-tight text-muk">
          {t('notFound.title')}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muk-soft">
          {t('notFound.body')}
        </p>

        {/* 주 행동 = 지도로 돌아가기. /course·/waiting 과 동일한 금빛 그라데이션 CTA 문법. */}
        <Link
          href="/main"
          className="toss-pressable mt-8 inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-gold to-terracotta px-7 text-[15px] font-bold text-white shadow-[0_4px_14px_rgba(193,85,59,0.25)] transition-colors hover:from-gold-deep hover:to-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          <MapPin size={18} aria-hidden />
          {t('notFound.backToMap')}
        </Link>

        {/* 보조 행동 — 지도가 아니라 분산 코스를 찾던 사람을 위한 두 번째 문. */}
        <Link
          href="/course"
          className="toss-pressable mt-3 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-line bg-white/90 px-5 text-[13px] font-bold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.06)] hover:border-gold/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          <Compass size={16} className="text-gold-deep" aria-hidden />
          {t('notFound.exploreCourse')}
        </Link>

        <p className="mt-10 text-[11px] leading-relaxed text-muk-soft/80">
          {t('notFound.brandLine')}
        </p>
      </div>
    </main>
  );
}
