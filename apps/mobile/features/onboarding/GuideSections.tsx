// 서비스 소개 본문 — 첫 실행 소개와 (나중에) 마이페이지 '서비스 소개' 모달이 같이 쓴다.
//
// 웹 원본: apps/web/app/page.tsx(폰 첫 화면: 배지·가치 문장·가치 칩·데이터 출처),
//          apps/web/components/guide/GuideContent.tsx(문제 → 해결 · 이런 분께 · 자주 묻는 질문) (기준 커밋 0d145a1)
// 뺀 것: 데스크톱 히어로·콘솔 링크·기능 바로가기(FeatureShortcuts — 탭이 그 역할)·12주 실증·사업 모델·팀·생태계 절
//        (공모전 심사용 절 — 대회 종료), 반딧불이 애니메이션, '데이터' 접힘 절(출처 한 줄로 대신).
// FAQ 1번은 웹 문구('웹에서 바로 쓸 수 있고…')가 앱과 맞지 않아 앱 키(app.intro.faq1Q/A)로 바꿨다.
import { CheckCircle2, Clock, MapPin, Route, type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Card, Icon, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { splitLeadingEmoji } from '~/lib/i18n/leadingEmoji';

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

/** 맨 앞 이모지는 장식이라 따로 숨기고(TalkBack 이 '핀 모양 핀' 처럼 읽지 않게), 나머지만 읽히는 글자로 그린다. */
function EmojiLine({ text, className, weight }: { text: string; className: string; weight: 'medium' | 'semibold' }) {
  const { emoji, rest } = splitLeadingEmoji(text);
  if (!emoji) {
    return (
      <Text className={className} weight={weight}>
        {text}
      </Text>
    );
  }
  return (
    <View className="flex-row items-start gap-[6px]">
      <Text className={className} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {emoji}
      </Text>
      <Text className={`min-w-0 shrink ${className}`} weight={weight}>
        {rest}
      </Text>
    </View>
  );
}

/** 첫 화면 머리 — 배지 · 가치 문장 · 부제 · 가치 네 줄. */
export function GuideHero() {
  const t = useT();
  return (
    <View className="items-center">
      <View className="rounded-full border border-gold/30 bg-white px-[14px] py-[6px]">
        <EmojiLine text={t('landing.badge')} className="text-xs text-gold-deep" weight="semibold" />
      </View>
      <Text className="mt-[20px] text-center text-[28px] leading-[38px] text-muk" weight="bold" accessibilityRole="header">
        {t('landing.tagline')}
      </Text>
      <Text className="mt-[12px] text-center text-sm leading-[22px] text-muk-soft">{t('landing.subline')}</Text>
      <View className="mt-[20px] w-full gap-[8px]">
        {(['value1', 'value2', 'value3', 'value4'] as const).map((key) => (
          <View key={key} className="rounded-2xl border border-line bg-white px-[14px] py-[10px]">
            <EmojiLine text={t(`landing.${key}`)} className="text-sm text-muk" weight="medium" />
          </View>
        ))}
      </View>
    </View>
  );
}

/** 문제 → 해결 · 이런 분께 · 자주 묻는 질문. */
export function GuideSections() {
  const t = useT();
  return (
    <View className="gap-[16px]">
      <Card className="gap-[10px]">
        <Text className="text-xs text-muk-soft" weight="bold">
          {t('guide.problemLabel')}
        </Text>
        <Text className="text-base text-muk" weight="bold" accessibilityRole="header">
          {t('guide.problemTitle')}
        </Text>
        {PROBLEMS.map(({ key, icon }) => (
          <View key={key} className="flex-row items-center gap-[10px]">
            <Icon icon={icon} size={18} color="terracotta" />
            <Text className="flex-1 text-sm text-muk">{t(`guide.${key}`)}</Text>
          </View>
        ))}
      </Card>
      <Card className="gap-[10px]">
        <Text className="text-xs text-jade" weight="bold">
          {t('guide.solutionLabel')}
        </Text>
        <Text className="text-base text-muk" weight="bold" accessibilityRole="header">
          {t('guide.solutionTitle')}
        </Text>
        {SOLUTIONS.map(({ key, icon }) => (
          <View key={key} className="flex-row items-center gap-[10px]">
            <Icon icon={icon} size={18} color="jade" />
            <Text className="flex-1 text-sm text-muk">{t(`guide.${key}`)}</Text>
          </View>
        ))}
        <Text className="mt-[4px] text-sm text-gold-deep" weight="bold">
          {t('guide.resultLine')}
        </Text>
      </Card>

      <View className="gap-[10px]">
        <Text className="text-base text-muk" weight="bold" accessibilityRole="header">
          {t('guide.audienceTitle')}
        </Text>
        {AUDIENCE.map((key) => (
          <View key={key} className="flex-row items-start gap-[8px]">
            <Icon icon={CheckCircle2} size={18} color="jade" />
            <Text className="flex-1 text-sm leading-[20px] text-muk">{t(`guide.${key}`)}</Text>
          </View>
        ))}
      </View>

      <View className="gap-[12px]">
        <Text className="text-base text-muk" weight="bold" accessibilityRole="header">
          {t('guide.faqTitle')}
        </Text>
        {FAQ.map(({ q, a }) => (
          <View key={q} className="rounded-2xl border border-line bg-white px-[14px] py-[12px]">
            <Text className="text-sm text-muk" weight="bold">
              {t(q)}
            </Text>
            <Text className="mt-[4px] text-sm leading-[20px] text-muk-soft">{t(a)}</Text>
          </View>
        ))}
      </View>

      <Text className="text-center text-xs text-muk-soft">{t('landing.dataAttribution')}</Text>
    </View>
  );
}
