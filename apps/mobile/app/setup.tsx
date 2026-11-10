// 첫 설정 5문항 — 장소 유형 · 음식 취향 · 도보 시간 · 남은 여행 시간 · 필수 조건. 추천 맥락이 여기서 정해진다.
//
// 웹 원본: apps/web/app/setup/page.tsx (기준 커밋 0d145a1)
// 바꾼 것:
//   · grid → 두 개(세 개)씩 줄 + 자식 flex-1(그리드와 같은 폭 — G1-18). 선택 칩 그림자 0 2 10 .18.
//   · sticky 하단 버튼 → 내용 위에 겹친 아래 바(위가 투명한 한지 그라데이션, 경계선 없음 — 웹 from-hanji from-70%, G1-17).
//     내용 끝에 바 높이만큼 빈 칸을 둬 마지막 토글이 가리지 않는다. 저장 중에는 돌림표 없이 '저장 중...' + 투명도 0.6.
//   · 저장은 웹과 같은 형식(setupPrefs.ts). 끝나면 이 기기에서 첫 설정을 지났다고 적고(첫 실행 게이트) 홈으로 replace
//     (뒤로 = 설정으로 돌아가지 않는다 — 웹 push 와 다른 점, G1-19).
//   · 뒤로 버튼은 늘 있다(웹). 돌아갈 화면이 있으면 back, 첫 실행 중이라 없으면 랜딩(/intro?view=landing — 게이트 예외,
//     안드로이드 뒤로 키도 같다 — G1-15, 검토 R1). 위 여백 32(웹 py-8).
//   · 질문 제목의 \n 은 공백으로(웹 h2 는 white-space normal — G1-16). 칩·토글 상태는 웹 aria-pressed 와 같은 selected.
import { useRouter, type Href } from 'expo-router';
import { ArrowLeft, Check, MapPin } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Icon, IconButton, Pressable, Screen, Text, cn } from '~/components/ui';
import { Gradient } from '~/components/ui/Gradient';
import {
  getFirstRunStep,
  LANDING_VIEW_ROUTE,
  markSetupSeen,
  nextFirstRunRoute,
  noteFirstRunNavigation,
} from '~/features/onboarding/firstRun';
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
import { colors, CONTENT_MAX_WIDTH } from '~/lib/theme/tokens';

export default function SetupScreen() {
  const router = useRouter();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [context, setContext] = useState<TravelContext>(EMPTY_TRAVEL_CONTEXT);
  const [saving, setSaving] = useState(false);

  // 뒤로 — 돌아갈 화면이 있으면 그곳(마이 → 취향 다시 고르기 등), 첫 실행 중이라 없으면 랜딩.
  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    noteFirstRunNavigation(LANDING_VIEW_ROUTE);
    router.replace(LANDING_VIEW_ROUTE as Href);
  };

  // 안드로이드 뒤로 키 — 첫 실행 중 스택이 이 화면 하나면 앱을 닫지 않고 랜딩으로(버튼과 같은 곳).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack() || getFirstRunStep() === null) return false;
      noteFirstRunNavigation(LANDING_VIEW_ROUTE);
      router.replace(LANDING_VIEW_ROUTE as Href);
      return true;
    });
    return () => sub.remove();
  }, [router]);

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
      <Screen scroll edges={['top', 'left', 'right']} contentClassName="px-[20px] pt-[32px]">
        <View className="mb-[32px] flex-row items-center justify-between">
          <IconButton
            icon={ArrowLeft}
            accessibilityLabel={t('common.back')}
            onPress={goBack}
            className="rounded-xl border border-line bg-white"
            box={44}
            color="muk-soft"
          />
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => finish(EMPTY_TRAVEL_CONTEXT)}
            className="min-h-[44px] justify-center px-[8px]"
            style={saving ? { opacity: 0.5 } : undefined}
          >
            {/* 밑줄 색 — 웹 decoration-line/80. 안드로이드는 textDecorationColor 를 무시한다(Z Fold7 확인, G1-18). */}
            <Text
              className="text-sm text-muk-soft"
              weight="medium"
              style={{ textDecorationLine: 'underline', textDecorationColor: 'rgba(230, 220, 198, 0.8)' }}
            >
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
          <Text className="mt-[12px] text-2xl leading-[33px] text-muk" weight="bold" accessibilityRole="header">
            {t('setup.contextTitle')}
          </Text>
          <Text className="mt-[8px] text-sm leading-[22.75px] text-muk-soft">{t('setup.contextDesc')}</Text>
        </View>

        <Section step={1} title={t('setup.categoriesTitle')}>
          <ChipGrid columns={2}>
            {CATEGORIES.map((category) => (
              <ChoiceChip
                key={category}
                active={context.categories.includes(category)}
                label={t(`category.${category}`)}
                onPress={() => setContext((c) => ({ ...c, categories: toggleIn(c.categories, category) }))}
              />
            ))}
          </ChipGrid>
        </Section>
        {/* 음식 취향 — 한 번 더 누르면 해제(선택 사항). */}
        <Section step={2} title={t('setup.step2')}>
          <ChipGrid columns={2}>
            {CUISINES.map((cuisine) => (
              <ChoiceChip
                key={cuisine}
                active={context.cuisine === cuisine}
                label={t(CUISINE_LABEL_KEY[cuisine])}
                onPress={() => setContext((c) => ({ ...c, cuisine: c.cuisine === cuisine ? undefined : cuisine }))}
              />
            ))}
          </ChipGrid>
        </Section>
        <Section step={3} title={t('setup.walkTitle')}>
          <ChipGrid columns={3}>
            {WALKS.map((minutes) => (
              <ChoiceChip
                key={minutes}
                active={context.maxWalkMinutes === minutes}
                label={t('setup.minutes', { n: minutes })}
                onPress={() => setContext((c) => ({ ...c, maxWalkMinutes: minutes }))}
              />
            ))}
          </ChipGrid>
        </Section>
        <Section step={4} title={t('setup.availableTitle')}>
          <ChipGrid columns={3}>
            {AVAILABLE.map((minutes) => (
              <ChoiceChip
                key={minutes}
                active={context.availableMinutes === minutes}
                label={minutes === 120 ? t('setup.twoHoursPlus') : t('setup.minutes', { n: minutes })}
                onPress={() => setContext((c) => ({ ...c, availableMinutes: minutes }))}
              />
            ))}
          </ChipGrid>
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
        {/* 아래 바 자리(mt 16 + pt 20 + 버튼 52 + pb 16 + 아래 안전 영역) — 마지막 토글이 바 밑에 숨지 않게. */}
        <View style={{ height: BAR_SPACE + insets.bottom }} />
      </Screen>
      {/* 시작하기 — 늘 보이게 내용 위에 겹친다. 위로 갈수록 투명한 한지(웹 bg-gradient-to-t from-hanji from-70% to-hanji/0). */}
      <View
        pointerEvents="box-none"
        className="absolute bottom-0 left-0 right-0 px-[20px] pt-[20px]"
        style={{ paddingBottom: insets.bottom + 16 }}
      >
        <Gradient
          colors={['rgba(250, 245, 236, 0)', colors.hanji, colors.hanji]}
          locations={[0, 0.3, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>
          <Button
            block
            size={52}
            labelSize={16}
            shadow="ctaLg"
            showSpinner={false}
            disabledOpacity={0.6}
            label={saving ? t('setup.saving') : t('setup.start')}
            loading={saving}
            onPress={() => finish(context)}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * 내용 끝 빈 칸(안전 영역 제외) — 바(mt 16 + pt 20 + 버튼 52 + pb 16) + 16.
 * 웹 sticky 바는 흐름 안에 있어 맨 끝에서는 main 아래 여백 위에 멈춘다 — 앱 바는 늘 아래에 붙고, 맨 끝 마지막 토글 자리는
 * 웹과 같게 둔다(390×844 하네스 실측: +16 에서 마지막 토글 y 가 같다).
 */
const BAR_SPACE = 16 + 20 + 52 + 16 + 16;

/** 웹 grid grid-cols-2/3 gap-2.5 — 두 개(세 개)씩 줄 + 자식 flex-1(반올림으로 넘치지 않고 오른쪽 끝이 맞는다, G1-18). */
function ChipGrid({ columns, children }: { columns: 2 | 3; children: ReactNode[] }) {
  const rows: ReactNode[][] = [];
  children.forEach((child, i) => {
    if (i % columns === 0) rows.push([]);
    rows[rows.length - 1]!.push(child);
  });
  return (
    <View className="gap-[10px]">
      {rows.map((row, r) => (
        <View key={r} className="flex-row gap-[10px]">
          {row.map((child, c) => (
            <View key={c} className="min-w-0 flex-1">
              {child}
            </View>
          ))}
          {/* 마지막 줄이 모자라면 빈 칸으로 채워 폭을 맞춘다. */}
          {Array.from({ length: columns - row.length }, (_, k) => (
            <View key={`pad-${k}`} className="flex-1" />
          ))}
        </View>
      ))}
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
          {title.replace(/\s*\n\s*/g, ' ')}
        </Text>
      </View>
      {children}
    </View>
  );
}

// 고른 칩은 먹색으로 채우고 ✓ 를 붙인다(웹 PH10).
function ChoiceChip({ active, onPress, label }: { active: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      className={cn(
        'min-h-[44px] flex-row items-center justify-center gap-[6px] rounded-2xl border px-[12px] py-[12px]',
        active ? 'border-muk bg-muk' : 'border-line bg-white',
      )}
      style={active ? { boxShadow: '0px 2px 10px rgba(43, 35, 32, 0.18)' } : undefined}
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
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
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
