// 첫 화면(폰 랜딩) 가운데 열 — 마스코트 · 지역 배지 · 로고 · 가치 문장 · 부제 · 가치 칩 · '바로 시작' · 축제 배너 ·
// 데이터 출처 줄 · '로그인 / 회원가입'·'서비스 소개' · 콘솔 입구 줄.
//
// 웹 원본: apps/web/app/page.tsx:240-373(폰 배치, lg 미만) (기준 커밋 0d145a1). 값은 docs/parity/findings-G1.md G1-02·05·06·07
// + 검토 R1 정정(로고 header 라벨, '바로 시작' Button size 52, 배지 굵기 bold·간격 4).
//   열: flex-1 items-center justify-center px 24 pb 32 pt 56(호출하는 화면의 Screen contentClassName 이 준다).
//   마스코트 80×100(full, 그림자 0 10 28 .14) — 화면 높이 ≤700 이면 56, ≤660 이면 숨김.
//   '서비스 소개' 는 openGuide(), 데이터 출처 줄은 '데이터' 절을 펼친 채로 연다(openGuideData — G1-06).
//   콘솔 줄은 운영 웹을 외부 브라우저로 연다(D7 ① — lib/core/consoleEntries, 끄면 숨김).
import { Image } from 'expo-image';
import { ChevronRight, CircleHelp, Landmark, Store, type LucideIcon } from 'lucide-react-native';
import { Fragment } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { NextSpotMascot } from '~/components/NextSpotMascot';
import { Button, Icon, Pressable, Text } from '~/components/ui';
import { FestivalBanner } from '~/features/home/FestivalBanner';
import { useAccount } from '~/lib/core/account';
import { consoleEntryUrls, SHOW_CONSOLE_ENTRIES } from '~/lib/core/consoleEntries';
import { useT } from '~/lib/i18n/I18nProvider';
import { splitLeadingEmoji } from '~/lib/i18n/leadingEmoji';
import { openExternalUrl } from '~/lib/platform/links';
import { colors } from '~/lib/theme/tokens';

import { openGuide, openGuideData } from './guideEntry';

const LOGO = require('../../assets/images/nextspot-logo.png');
/** 로고 원본 505×109 — 웹 h-14(56) w-auto. */
const LOGO_HEIGHT = 56;
const LOGO_WIDTH = (LOGO_HEIGHT * 505) / 109;

/** 밑줄 색 — 웹 decoration-line(#e6dcc6). 안드로이드는 textDecorationColor 를 무시해 글자색 밑줄이 된다(Z Fold7 확인, G1-18). */
const UNDERLINE_LINE = { textDecorationLine: 'underline', textDecorationColor: colors.line } as const;

/** 맨 앞 이모지는 장식이라 읽기 화면에서 숨기고 나머지만 읽힌다(TalkBack 이 이모지 이름을 읽지 않게). */
function EmojiText({ text, className, weight, gap }: { text: string; className: string; weight: 'bold' | 'semibold'; gap: number }) {
  const { emoji, rest } = splitLeadingEmoji(text);
  if (!emoji) {
    return (
      <Text className={className} weight={weight}>
        {text}
      </Text>
    );
  }
  return (
    <View className="flex-row items-center" style={{ columnGap: gap }}>
      <Text className={className} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {emoji}
      </Text>
      <Text className={`min-w-0 shrink ${className}`} weight={weight}>
        {rest}
      </Text>
    </View>
  );
}

export type LandingHeroProps = {
  /** '바로 시작'(웹 go()) — 화면 빈 곳을 눌러도 같은 동작이다(호출하는 화면이 감싼다). */
  onStart: () => void;
  /** '로그인 / 회원가입'(웹 router.push('/login')). */
  onLogin: () => void;
};

export function LandingHero({ onStart, onLogin }: LandingHeroProps) {
  const t = useT();
  const { height } = useWindowDimensions();
  const { account } = useAccount();
  const consoles = consoleEntryUrls(account);
  // 웹 [@media(max-height:700px)]:w-14 · [@media(max-height:660px)]:hidden
  const mascotWidth = height <= 660 ? 0 : height <= 700 ? 56 : 80;
  const consoleLinks: { id: string; icon: LucideIcon; label: string; url: string }[] = [
    { id: 'merchant', icon: Store, label: t('nav.merchantShort'), url: consoles.merchant },
    { id: 'admin', icon: Landmark, label: t('nav.adminShort'), url: consoles.admin },
  ];

  return (
    <View className="w-full items-center">
      {mascotWidth > 0 && <NextSpotMascot variant="full" size={mascotWidth} shadow="0px 10px 28px rgba(43, 35, 32, 0.14)" />}

      {/* 서비스 지역 배지 — mt 12 · px 12 · py 6 · gold/15 · 테두리 gold/30 · 12px bold gold-deep */}
      <View className="mt-[12px] rounded-full border border-gold/30 bg-gold/15 px-[12px] py-[6px]">
        <EmojiText text={t('landing.badge')} className="text-[12px] leading-[16px] text-gold-deep" weight="bold" gap={4} />
      </View>

      {/* 로고(웹 <h1><img alt="NextSpot"></h1>) */}
      <View className="mt-[12px]" accessible accessibilityRole="header" accessibilityLabel="NextSpot">
        <Image source={LOGO} style={{ width: LOGO_WIDTH, height: LOGO_HEIGHT }} contentFit="contain" accessible={false} />
      </View>

      {/* 가치 문장 22px 900 · 줄높이 1.25 · 자간 tight(−0.025em) */}
      <Text
        className="mt-[16px] max-w-[448px] text-center text-[22px] leading-[27.5px] text-muk"
        weight="black"
        style={{ letterSpacing: -0.55 }}
      >
        {t('landing.tagline')}
      </Text>
      <Text className="mt-[10px] max-w-[384px] text-center text-[15px] leading-[24.4px] text-muk-soft">{t('landing.subline')}</Text>

      {/* 가치 칩 — 내용 폭 알약, 가운데 줄바꿈(웹 fractal-glass 는 흐림 없이 흰 70% 판, UI 규칙 7). */}
      <View className="mt-[16px] max-w-[448px] flex-row flex-wrap items-center justify-center gap-[8px]">
        {(['value1', 'value2', 'value3', 'value4'] as const).map((key) => (
          <View
            key={key}
            className="rounded-2xl border px-[14px] py-[8px]"
            style={{
              borderColor: 'rgba(230, 220, 198, 0.7)',
              backgroundColor: 'rgba(255, 255, 255, 0.7)',
              boxShadow: '0px 1px 2px rgba(43, 35, 32, 0.05)',
            }}
          >
            <EmojiText text={t(`landing.${key}`)} className="text-[14px] leading-[19.25px] text-muk" weight="semibold" gap={4} />
          </View>
        ))}
      </View>

      {/* '바로 시작' — 내용 폭 알약, 17px, ChevronRight 20(검토 R1 3절 Button 표). */}
      <Button
        className="mt-[24px]"
        label={t('landing.ctaStart')}
        size={52}
        labelSize={17}
        shape="full"
        paddingX={40}
        shadow="ctaHero"
        trailing={<Icon icon={ChevronRight} size={20} color="white" />}
        onPress={onStart}
      />

      {/* 지금 경주에서 열리는 축제 — 진행 중일 때만(없으면 아무것도 그리지 않는다, G1-05). */}
      <FestivalBanner variant="banner" className="mt-[16px]" />

      {/* 데이터 출처 — 누르면 서비스 소개의 '데이터' 절이 펼쳐진 채로 열린다(G1-06). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t('landing.dataAttribution')}, ${t('dataTab.footerHint')}`}
        onPress={openGuideData}
        className="mt-[8px] min-h-[44px] flex-row items-center gap-[4px] rounded-lg px-[12px]"
      >
        <Text className="shrink text-center text-[13px] leading-[19.5px] text-muk" weight="semibold" style={UNDERLINE_LINE}>
          {t('landing.dataAttribution')}
        </Text>
        <Icon icon={ChevronRight} size={14} color="muk" />
      </Pressable>

      {/* 로그인(선택) · 서비스 소개 — 한 줄 */}
      <View className="mt-[4px] flex-row flex-wrap items-center justify-center" style={{ columnGap: 4 }}>
        <Pressable accessibilityRole="button" onPress={onLogin} className="min-h-[44px] justify-center rounded-lg px-[12px]">
          <Text className="text-[14px] leading-[20px] text-muk-soft" weight="semibold" style={UNDERLINE_LINE}>
            {t('landing.ctaLogin')}
          </Text>
        </Pressable>
        <Text className="text-[14px] leading-[20px] text-muk-soft" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          ·
        </Text>
        {/* 웹 GuideButton compact — CircleHelp 20 + '서비스 소개' 12px medium, 라벨 'NextSpot 알아보기'. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('guide.title')}
          onPress={openGuide}
          className="min-h-[44px] flex-row items-center justify-center gap-[8px] rounded-xl px-[12px]"
        >
          <Icon icon={CircleHelp} size={20} color="muk-soft" />
          <Text className="text-[12px] leading-[16px] text-muk-soft" weight="medium">
            {t('guide.label')}
          </Text>
        </Pressable>
      </View>

      {/* 콘솔 입구 — 13px 600 muk-soft, 줄마다 min-h 40 · px 8 · 밑줄(G1-07, D7 ①). */}
      {SHOW_CONSOLE_ENTRIES && (
        <View className="mt-[4px] flex-row flex-wrap items-center justify-center" style={{ columnGap: 4 }}>
          {consoleLinks.map((c, i) => (
            <Fragment key={c.id}>
              {i > 0 && (
                <Text className="text-[13px] leading-[19.5px] text-muk-soft" weight="semibold" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  ·
                </Text>
              )}
              <Pressable
                accessibilityRole="link"
                onPress={() => void openExternalUrl(c.url)}
                hitSlop={{ top: 2, bottom: 2 }}
                className="min-h-[40px] flex-row items-center gap-[4px] rounded-lg px-[8px]"
              >
                <Icon icon={c.icon} size={14} color="muk-soft" />
                <Text className="text-[13px] leading-[19.5px] text-muk-soft" weight="semibold" style={UNDERLINE_LINE}>
                  {c.label}
                </Text>
              </Pressable>
            </Fragment>
          ))}
        </View>
      )}
    </View>
  );
}
