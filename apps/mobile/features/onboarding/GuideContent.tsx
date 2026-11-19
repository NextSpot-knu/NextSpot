// 서비스 소개 본문 — 소개 모달(GuideModal)과 /guide 화면이 같이 쓴다.
//
// 웹 원본: apps/web/components/guide/GuideContent.tsx · GuideHero.tsx · guide.module.css(모바일 ≤767px 값) (기준 커밋 0d145a1)
// 순서(웹 그대로): 윗줄(힌트 + 언어) → 히어로(eyebrow · 제목 · 본문 · 주 행동 + '이렇게 써 보세요') → 문제 → 해결 →
// 이런 분께 → 자주 묻는 질문 → 지역과 함께(생태계) → 데이터(접힘).
// 앱 결정(docs/MOBILE_WEB_PARITY.md §3.2):
//   · '계획' 접힘(12주 실증·사업 모델)은 옮기지 않는다 — 공모전 전용이라 웹에서도 지운다(D8 ①, W1).
//   · FAQ 1번은 앱 문구(app.intro.faq1Q/A) — 웹 '웹에서 바로 쓸 수 있고'는 앱에서 사실이 아니다(D6 ①).
//   · 콘솔 데모·로그인 링크는 운영 웹을 외부 브라우저로 연다(D7 ①). SHOW_CONSOLE_ENTRIES 가 false 면 숨긴다.
// 글자 굵기 650·750 은 bold, 800 은 extrabold(토큰 규칙). 줄 높이는 웹 값을 px 로 적는다(Text 기본 1.5× 를 쓰지 않게).
import {
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  Clock,
  Compass,
  Home,
  Landmark,
  MapPin,
  Route,
  Store,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { LanguageSwitcher } from '~/components/LanguageSwitcher';
import { Icon, Pressable, Text } from '~/components/ui';
import { SHOW_CONSOLE_ENTRIES } from '~/lib/core/consoleEntries';
import { useT } from '~/lib/i18n/I18nProvider';
import { WEB_ORIGIN } from '~/lib/platform/shareUrls';
import { openExternalUrl } from '~/lib/platform/links';
import { colors } from '~/lib/theme/tokens';

import { FeatureShortcuts } from './FeatureShortcuts';
import { GuideDataSection } from './GuideDataSection';
import { startFromGuide } from './guideNav';
import { SectionHead } from './GuideSectionHead';

const PROBLEMS: { key: string; icon: LucideIcon }[] = [
  { key: 'problemWait', icon: Clock },
  { key: 'problemRoute', icon: Route },
  { key: 'problemMiss', icon: MapPin },
];
const SOLUTIONS: { key: string; icon: LucideIcon }[] = [
  { key: 'solutionTiming', icon: Clock },
  { key: 'solutionAlternative', icon: MapPin },
  { key: 'solutionRoute', icon: Route },
];
const AUDIENCE = ['audience1', 'audience2', 'audience3', 'audience4', 'audience5'] as const;
const FAQ: { q: string; a: string }[] = [
  { q: 'app.intro.faq1Q', a: 'app.intro.faq1A' },
  { q: 'guide.faq2Q', a: 'guide.faq2A' },
  { q: 'guide.faq3Q', a: 'guide.faq3A' },
  { q: 'guide.faq4Q', a: 'guide.faq4A' },
  { q: 'guide.faq5Q', a: 'guide.faq5A' },
  { q: 'guide.faq6Q', a: 'guide.faq6A' },
  { q: 'guide.faq7Q', a: 'guide.faq7A' },
];
const ROLES: { key: string; icon: LucideIcon }[] = [
  { key: 'tourist', icon: Compass },
  { key: 'merchant', icon: Store },
  { key: 'admin', icon: Landmark },
  { key: 'resident', icon: Home },
];
/** 웹 GuideContent 의 콘솔 링크(데모·로그인) — 앱은 운영 웹 주소로 연다. */
const CONSOLE_DEMO = { merchant: '/merchant?demo=1', admin: '/admin/dashboard?demo=1' } as const;
const CONSOLE_LOGIN = { merchant: '/login?next=/merchant', admin: '/admin/login' } as const;

const openWeb = (path: string) => void openExternalUrl(`${WEB_ORIGIN}${path}`);

/** 히어로 바탕 — radial-gradient(circle at 82% 30%, gold 15%, transparent 38%) + (16% 85%, jade 8%, transparent 34%). */
function HeroGlow() {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!size || size.w !== width || size.h !== height) setSize({ w: width, h: height });
  };
  // circle 의 기본 크기는 farthest-corner — 중심에서 가장 먼 모서리까지가 100%.
  const far = (cx: number, cy: number, w: number, h: number) =>
    Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy));
  return (
    <View pointerEvents="none" onLayout={onLayout} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      {size && (
        <Svg width={size.w} height={size.h}>
          <Defs>
            <RadialGradient
              id="guideHeroGold"
              gradientUnits="userSpaceOnUse"
              cx={size.w * 0.82}
              cy={size.h * 0.3}
              r={0.38 * far(size.w * 0.82, size.h * 0.3, size.w, size.h)}
            >
              <Stop offset={0} stopColor={colors.gold} stopOpacity={0.15} />
              <Stop offset={1} stopColor={colors.gold} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient
              id="guideHeroJade"
              gradientUnits="userSpaceOnUse"
              cx={size.w * 0.16}
              cy={size.h * 0.85}
              r={0.34 * far(size.w * 0.16, size.h * 0.85, size.w, size.h)}
            >
              <Stop offset={0} stopColor={colors.jade} stopOpacity={0.08} />
              <Stop offset={1} stopColor={colors.jade} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width={size.w} height={size.h} fill="url(#guideHeroJade)" />
          <Rect x={0} y={0} width={size.w} height={size.h} fill="url(#guideHeroGold)" />
        </Svg>
      )}
    </View>
  );
}

/** 문제·해결 카드 — 웹 .problemCard / .solutionCard(모바일 padding 22/18 · 반경 18). */
function AnswerCard({ tone, items }: { tone: 'problem' | 'solution'; items: { key: string; icon: LucideIcon }[] }) {
  const t = useT();
  const dark = tone === 'solution';
  return (
    <View className={dark ? 'rounded-[18px] bg-muk px-[18px] py-[22px]' : 'rounded-[18px] border border-line bg-hanji-deep px-[18px] py-[22px]'}>
      <Text
        className={dark ? 'mb-[8px] text-[11px] leading-[16.5px] text-gold' : 'mb-[8px] text-[11px] leading-[16.5px] text-gold-deep'}
        weight="extrabold"
        style={{ letterSpacing: 0.99 }}
      >
        {t(dark ? 'guide.solutionLabel' : 'guide.problemLabel')}
      </Text>
      <Text
        className={dark ? 'text-[21px] leading-[27.3px] text-hanji' : 'text-[21px] leading-[27.3px] text-muk'}
        weight="bold"
        accessibilityRole="header"
        style={{ letterSpacing: -0.735 }}
      >
        {t(dark ? 'guide.solutionTitle' : 'guide.problemTitle')}
      </Text>
      <View className="mt-[18px] gap-[10px]">
        {items.map(({ key, icon }) => (
          <View
            key={key}
            className={
              dark
                ? 'flex-row items-center gap-[10px] rounded-[15px] px-[13px] py-[12px]'
                : 'flex-row items-center gap-[10px] rounded-[15px] border border-line bg-hanji px-[13px] py-[12px]'
            }
            style={dark ? { backgroundColor: 'rgba(250, 245, 236, 0.09)' } : undefined}
          >
            <Icon icon={icon} size={20} color={dark ? 'gold' : 'gold-deep'} />
            <Text className={dark ? 'min-w-0 flex-1 text-[12px] leading-[18px] text-hanji' : 'min-w-0 flex-1 text-[12px] leading-[18px] text-muk'} weight="bold">
              {t(`guide.${key}`)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export type GuideContentProps = {
  /** 이동하기 전에 부른다(모달이면 닫기). */
  onNavigate?: () => void;
  /** '데이터' 절을 펼친 채로 시작(랜딩 데이터 출처 줄). */
  dataOpen?: boolean;
  /** 펼친 '데이터' 절의 y — 모달이 그 자리로 스크롤한다. */
  onDataLayout?: (y: number) => void;
};

export function GuideContent({ onNavigate, dataOpen = false, onDataLayout }: GuideContentProps) {
  const t = useT();
  const { width } = useWindowDimensions();
  // 웹 clamp(40px, 12.5vw, 56px) — 줄 높이 1.08, 자간 −.065em.
  const heroSize = Math.min(56, Math.max(40, width * 0.125));

  return (
    <View className="bg-hanji">
      {/* 윗줄 — 힌트 + 언어 선택(웹 .topline 모바일 padding 16/20 · 10px). */}
      <View className="flex-row items-center justify-between gap-[16px] px-[20px] py-[16px]">
        <Text className="max-w-[180px] shrink text-[10px] leading-[15px] text-muk-soft">{t('guide.hint')}</Text>
        <LanguageSwitcher />
      </View>

      {/* 히어로 — padding 28/20/46, 복사 칸과 '이렇게 써 보세요' 칸 사이 36. */}
      <View className="px-[20px] pb-[46px] pt-[28px]">
        <HeroGlow />
        <View>
          <Text className="mb-[17px] max-w-[520px] text-[11px] leading-[17.05px] text-gold-deep" weight="extrabold" style={{ letterSpacing: 0.44 }}>
            {t('guide.eyebrow')}
          </Text>
          <Text
            className="text-muk"
            weight="extrabold"
            accessibilityRole="header"
            // 큰 글자 설정에서 48px 표시 제목이 넘치지 않게 배율 상한 1.2(검토 L6).
            maxFontSizeMultiplier={1.2}
            style={{ fontSize: heroSize, lineHeight: heroSize * 1.08, letterSpacing: -heroSize * 0.065 }}
          >
            {t('guide.heroTitle')}
          </Text>
          <Text className="mb-[26px] mt-[22px] max-w-[570px] text-[15px] leading-[26.25px] text-muk-soft">{t('guide.heroBody')}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onNavigate?.();
              startFromGuide();
            }}
            className="min-h-[50px] w-full flex-row items-center justify-center gap-[10px] rounded-full bg-muk px-[26px] py-[13px]"
          >
            <Text className="text-[15px] leading-[22.5px] text-hanji" weight="bold">
              {t('guide.explore')}
            </Text>
            <Icon icon={ArrowRight} size={18} color="hanji" />
          </Pressable>
        </View>
        <View className="mt-[36px]">
          <FeatureShortcuts onNavigate={onNavigate} />
        </View>
      </View>

      {/* 문제 → 해결 — 절 padding 8/20/48, 바깥 판 padding 12 · 반경 24. */}
      <View className="px-[20px] pb-[48px] pt-[8px]">
        <View
          className="rounded-[24px] border border-line p-[12px]"
          accessibilityLabel={t('guide.answerLabel')}
          style={{ backgroundColor: 'rgba(250, 245, 236, 0.92)', boxShadow: '0px 24px 80px rgba(43, 35, 32, 0.10)' }}
        >
          <AnswerCard tone="problem" items={PROBLEMS} />
          <View
            className="h-[50px] flex-row items-center justify-center gap-[10px]"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text className="text-[11px] leading-[16.5px] text-gold-deep" weight="extrabold" style={{ letterSpacing: 1.32 }}>
              NextSpot
            </Text>
            <Icon icon={ArrowDown} size={22} color="gold-deep" />
          </View>
          <AnswerCard tone="solution" items={SOLUTIONS} />
          <Text className="px-[8px] pb-[3px] pt-[15px] text-center text-[15px] leading-[22.5px] text-gold-deep" weight="bold" style={{ letterSpacing: -0.3 }}>
            {t('guide.resultLine')}
          </Text>
        </View>
      </View>

      {/* 이런 분께 */}
      <View className="px-[20px] py-[48px]">
        <SectionHead kicker={t('guide.audienceKicker')} title={t('guide.audienceTitle')} />
        <View className="mt-[28px] gap-[10px]">
          {AUDIENCE.map((key) => (
            <View key={key} className="flex-row items-start gap-[10px] rounded-2xl border border-line bg-hanji-deep px-[18px] py-[16px]">
              <View className="mt-[3px]">
                <Icon icon={CheckCircle2} size={18} color="jade" />
              </View>
              <Text className="min-w-0 flex-1 text-[15px] leading-[24px] text-muk" weight="bold">
                {t(`guide.${key}`)}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* 자주 묻는 질문 — 카드가 아니라 위·아래 선으로 나눈 목록(웹 dl). */}
      <View className="px-[20px] py-[48px]">
        <SectionHead kicker={t('guide.faqKicker')} title={t('guide.faqTitle')} />
        <View className="mt-[28px] border-t border-line">
          {FAQ.map(({ q, a }) => (
            <View key={q} className="border-b border-line px-[4px] py-[16px]">
              <Text className="text-[16px] leading-[24px] text-muk" weight="bold">
                {t(q)}
              </Text>
              <Text className="mt-[6px] text-[15px] leading-[26.25px] text-muk-soft">{t(a)}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* 지역과 함께(생태계) */}
      <View className="px-[20px] py-[48px]">
        <SectionHead kicker={t('guide.navImpact')} title={t('guide.impactTitle')} />
        <Text className="mt-[18px] max-w-[660px] text-[15px] leading-[27px] text-muk-soft">{t('guide.impactBody')}</Text>
        <View className="mt-[34px] gap-[14px]">
          {ROLES.map(({ key, icon }) => (
            <View key={key} className="rounded-[17px] border border-line bg-hanji-deep px-[18px] py-[20px]">
              <Icon icon={icon} size={22} color="gold-deep" />
              <Text className="mt-[14px] text-[17px] leading-[23.8px] text-muk" weight="bold" accessibilityRole="header" style={{ letterSpacing: -0.425 }}>
                {t(`guide.${key}`)}
              </Text>
              <Text className="mt-[7px] text-[15px] leading-[26.25px] text-muk-soft">{t(`guide.${key}Body`)}</Text>
            </View>
          ))}
        </View>
        {SHOW_CONSOLE_ENTRIES && (
          <>
            <View className="mt-[32px] gap-[12px]">
              {(['merchant', 'admin'] as const).map((k) => (
                <Pressable
                  key={k}
                  accessibilityRole="link"
                  onPress={() => openWeb(CONSOLE_DEMO[k])}
                  className="min-h-[44px] w-full flex-row items-center justify-center gap-[8px] rounded-full bg-hanji px-[24px] py-[11px]"
                  style={{ borderWidth: 1.5, borderColor: colors.line }}
                >
                  <Text className="text-[15px] leading-[22.5px] text-muk" weight="bold">
                    {t(k === 'merchant' ? 'dataTab.merchantCta' : 'dataTab.adminCta')}
                  </Text>
                  <Icon icon={ArrowRight} size={16} color="muk" />
                </Pressable>
              ))}
            </View>
            <View className="mt-[22px]">
              <Text className="text-[13px] leading-[22.1px] text-muk-soft">{t('dataTab.roleNote')}</Text>
              <View className="mt-[4px] flex-row flex-wrap items-center">
                <Pressable accessibilityRole="link" onPress={() => openWeb(CONSOLE_LOGIN.merchant)} hitSlop={{ top: 11, bottom: 11 }}>
                  <Text className="text-[13px] leading-[22.1px] text-muk-soft underline">{t('guide.consoleLoginMerchant')}</Text>
                </Pressable>
                <Text className="text-[13px] leading-[22.1px] text-muk-soft">{' · '}</Text>
                <Pressable accessibilityRole="link" onPress={() => openWeb(CONSOLE_LOGIN.admin)} hitSlop={{ top: 11, bottom: 11 }}>
                  <Text className="text-[13px] leading-[22.1px] text-muk-soft underline">{t('guide.consoleLoginAdmin')}</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}
      </View>

      <GuideDataSection initiallyOpen={dataOpen} onContentLayout={onDataLayout} />
    </View>
  );
}
