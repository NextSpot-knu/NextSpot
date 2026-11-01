// 첫 설정 5문항 — 장소 유형 · 음식 취향 · 도보 시간 · 남은 여행 시간 · 필수 조건. 추천 맥락이 여기서 정해진다.
//
// 웹 원본: apps/web/app/setup/page.tsx (기준 커밋 0d145a1)
// 바꾼 것:
//   · grid → flex-row flex-wrap + 자식 폭(디자인 규칙 5). sticky 하단 버튼 → 스크롤 밖 하단 고정 영역.
//   · 저장은 웹과 같은 형식(setupPrefs.ts). 끝나면 이 기기에서 첫 설정을 지났다고 적고(첫 실행 게이트) 홈으로 replace.
//   · 뒤로 버튼은 돌아갈 화면이 있을 때만(첫 실행 중에는 소개·동의로 되돌아가지 않는다).
import { useRouter, type Href } from 'expo-router';
import { ArrowLeft, Check, MapPin } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Icon, IconButton, Pressable, Screen, Text, cn } from '~/components/ui';
import { markSetupSeen, nextFirstRunRoute, noteFirstRunNavigation } from '~/features/onboarding/firstRun';
import {
  AVAILABLE,
  CATEGORIES,
  CUISINE_LABEL_KEY,
  CUISINES,
  EMPTY_TRAVEL_CONTEXT,
  WALKS,
  contextAppliedProps,
  saveTravelContextTo,
  toggleIn,
  type TravelContext,
} from '~/features/onboarding/setupPrefs';
import { createPublicClient } from '~/lib/core/supabase';
import { useT } from '~/lib/i18n/I18nProvider';
import { track } from '~/lib/platform/analytics';
import { CONTENT_MAX_WIDTH } from '~/lib/theme/tokens';

export default function SetupScreen() {
  const router = useRouter();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [context, setContext] = useState<TravelContext>(EMPTY_TRAVEL_CONTEXT);
  const [saving, setSaving] = useState(false);
  const canGoBack = router.canGoBack();

  const finish = (value: TravelContext) => {
    if (saving) return;
    setSaving(true);
    saveTravelContextTo((globalThis as { localStorage?: Storage }).localStorage ?? null, value);
    track('context_applied', contextAppliedProps(value));
    markSetupSeen();
    const next = nextFirstRunRoute();
    noteFirstRunNavigation(next);
    router.replace(next as Href);
    if (value.categories.length) {
      // 계정에도 관심 분야를 남긴다(다른 기기·추천 학습). 실패해도 이번 여행은 기기 저장값으로 충분하다.
      void (async () => {
        try {
          const supabase = createPublicClient();
          const {
            data: { user },
          } = await supabase.auth.getUser();
          if (user) await supabase.from('users').update({ preferred_categories: value.categories }).eq('id', user.id);
        } catch {
          /* 기기 저장값이 이번 여행의 기준이다 */
        }
      })();
    }
  };

  return (
    <View className="flex-1 bg-hanji">
      <Screen scroll edges={['top', 'left', 'right']} contentClassName="px-[20px] pb-[24px] pt-[16px]">
        <View className="mb-[32px] flex-row items-center justify-between">
          {canGoBack ? (
            <IconButton
              icon={ArrowLeft}
              accessibilityLabel={t('common.back')}
              onPress={() => router.back()}
              className="rounded-xl border border-line bg-white"
              box={44}
              color="muk-soft"
            />
          ) : (
            <View />
          )}
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => finish(EMPTY_TRAVEL_CONTEXT)}
            className="min-h-[44px] justify-center px-[8px]"
          >
            <Text className="text-sm text-muk-soft underline" weight="medium">
              {t('setup.skip')}
            </Text>
          </Pressable>
        </View>

        <View className="mb-[32px]">
          <View className="flex-row self-start items-center gap-[6px] rounded-full bg-jade/10 px-[12px] py-[4px]">
            <Icon icon={MapPin} size={13} color="jade" />
            <Text className="text-xs text-jade" weight="bold">
              {t('setup.fieldBadge')}
            </Text>
          </View>
          <Text className="mt-[12px] text-2xl leading-[32px] text-muk" weight="bold" accessibilityRole="header">
            {t('setup.contextTitle')}
          </Text>
          <Text className="mt-[8px] text-sm leading-[22px] text-muk-soft">{t('setup.contextDesc')}</Text>
        </View>

        <Section step={1} title={t('setup.categoriesTitle')}>
          <View className="flex-row flex-wrap gap-[10px]">
            {CATEGORIES.map((category) => (
              <ChoiceChip
                key={category}
                width="half"
                active={context.categories.includes(category)}
                label={t(`category.${category}`)}
                onPress={() => setContext((c) => ({ ...c, categories: toggleIn(c.categories, category) }))}
              />
            ))}
          </View>
        </Section>
        {/* 음식 취향 — 한 번 더 누르면 해제(선택 사항). */}
        <Section step={2} title={t('setup.step2')}>
          <View className="flex-row flex-wrap gap-[10px]">
            {CUISINES.map((cuisine) => (
              <ChoiceChip
                key={cuisine}
                width="half"
                active={context.cuisine === cuisine}
                label={t(CUISINE_LABEL_KEY[cuisine])}
                onPress={() => setContext((c) => ({ ...c, cuisine: c.cuisine === cuisine ? undefined : cuisine }))}
              />
            ))}
          </View>
        </Section>
        <Section step={3} title={t('setup.walkTitle')}>
          <View className="flex-row flex-wrap gap-[10px]">
            {WALKS.map((minutes) => (
              <ChoiceChip
                key={minutes}
                width="third"
                active={context.maxWalkMinutes === minutes}
                label={t('setup.minutes', { n: minutes })}
                onPress={() => setContext((c) => ({ ...c, maxWalkMinutes: minutes }))}
              />
            ))}
          </View>
        </Section>
        <Section step={4} title={t('setup.availableTitle')}>
          <View className="flex-row flex-wrap gap-[10px]">
            {AVAILABLE.map((minutes) => (
              <ChoiceChip
                key={minutes}
                width="third"
                active={context.availableMinutes === minutes}
                label={minutes === 120 ? t('setup.twoHoursPlus') : t('setup.minutes', { n: minutes })}
                onPress={() => setContext((c) => ({ ...c, availableMinutes: minutes }))}
              />
            ))}
          </View>
        </Section>
        <Section step={5} title={t('setup.requirementsTitle')}>
          <View className="gap-[10px]">
            <Toggle
              active={context.requiredAttributes.includes('indoor')}
              onPress={() => setContext((c) => ({ ...c, requiredAttributes: toggleIn(c.requiredAttributes, 'indoor') }))}
              label={t('setup.indoorOnly')}
            />
            <Toggle
              active={context.requiredAttributes.includes('accessible')}
              onPress={() => setContext((c) => ({ ...c, requiredAttributes: toggleIn(c.requiredAttributes, 'accessible') }))}
              label={t('setup.accessibleOnly')}
            />
            {/* 유모차는 휠체어와 따로 고른다(웹 P1-6). */}
            <Toggle
              active={context.requiredAttributes.includes('stroller')}
              onPress={() => setContext((c) => ({ ...c, requiredAttributes: toggleIn(c.requiredAttributes, 'stroller') }))}
              label={t('setup.strollerOnly')}
            />
            <Toggle
              active={context.excludeVisited}
              onPress={() => setContext((c) => ({ ...c, excludeVisited: !c.excludeVisited }))}
              label={t('setup.excludeVisited')}
            />
          </View>
        </Section>
      </Screen>
      {/* 시작하기 — 다섯 질문이 한 화면을 넘어도 늘 보이게 스크롤 밖 아래에 둔다(웹 sticky bottom). */}
      <View
        className="border-t border-line bg-hanji px-[20px] pt-[12px]"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>
          <Button
            block
            label={saving ? t('setup.saving') : t('setup.start')}
            loading={saving}
            onPress={() => finish(context)}
            className="min-h-[52px]"
          />
        </View>
      </View>
    </View>
  );
}

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <View className="mb-[32px]">
      <View className="mb-[12px] flex-row items-center gap-[10px]">
        <View className="h-[24px] w-[24px] items-center justify-center rounded-full bg-gold/15">
          <Text className="text-[11px] text-gold-deep" weight="bold">
            {step}
          </Text>
        </View>
        <Text className="flex-1 text-sm text-muk" weight="bold" accessibilityRole="header">
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

// 고른 칩은 먹색으로 채우고 ✓ 를 붙인다(웹 PH10).
function ChoiceChip({
  active,
  onPress,
  label,
  width,
}: {
  active: boolean;
  onPress: () => void;
  label: string;
  width: 'half' | 'third';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      className={cn(
        'min-h-[44px] flex-row items-center justify-center gap-[6px] rounded-2xl border px-[12px] py-[12px]',
        width === 'half' ? 'w-[48%]' : 'w-[31%]',
        active ? 'border-muk bg-muk' : 'border-line bg-white',
      )}
    >
      {active && <Icon icon={Check} size={15} strokeWidth={3} color="hanji" />}
      <Text className={cn('text-sm', active ? 'text-hanji' : 'text-muk-soft')} weight="semibold">
        {label}
      </Text>
    </Pressable>
  );
}

function Toggle({ active, onPress, label }: { active: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: active }}
      accessibilityLabel={label}
      onPress={onPress}
      className={cn(
        'min-h-[44px] w-full flex-row items-center justify-between rounded-2xl border px-[16px] py-[12px]',
        active ? 'border-jade bg-jade/10' : 'border-line bg-white',
      )}
    >
      <Text className={cn('flex-1 text-sm', active ? 'text-muk' : 'text-muk-soft')} weight="semibold">
        {label}
      </Text>
      <View
        className={cn(
          'h-[20px] w-[20px] items-center justify-center rounded-full border',
          active ? 'border-jade bg-jade' : 'border-line bg-white',
        )}
      >
        {active && <Icon icon={Check} size={13} strokeWidth={3} color="white" />}
      </View>
    </Pressable>
  );
}
