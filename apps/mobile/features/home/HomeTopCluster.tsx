// 홈 상단 묶음(G2-10) — 왼쪽 위 열(언어 알약 아래 출처 알약) + 오른쪽 위 KST 시계. 모두 지도 위 유리(Liquid Glass).
// 웹 원본: apps/web/app/main/page.tsx 3975-4009 · LanguageSwitcher.tsx · SourceCredit.tsx(compact).
//   바깥  absolute inset-x-3 top-[safe+0.5rem] flex justify-between gap-2, 왼쪽 열 max-w-[220px] gap-1
//   언어  rounded-full border px-3 text-sm — Globe 16 + 현재 언어 14 medium + ▾ 14(실측 117×32)
//   출처  rounded-full px-2.5 py-[3px] text-[10px] leading-none font-semibold(실측 135×18)
//   시계  rounded-2xl px-3 py-2 gap-2 — Clock3 16 gold + 날짜 10 semibold + (KST 10 bold gold-deep tracking-wider + 시각 13 extrabold)(실측 121×45)
//
// 연결(H3b): HomeScreen 루트(지도 위 층)에 `<HomeTopCluster />` 를 두고, 검색 줄 시작을 `insets.top + 68` 로 내린다(G2-10 5번).
// 공지 배너가 이 묶음만 덮는지는 G2-R01 에서 확인한다. 이 컴포넌트는 터치를 자기 알약에서만 받는다(pointerEvents box-none).
import { Clock3, ChevronDown, Globe } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LOCALES, type Locale } from '@/lib/i18n/config';
import { Glass, Icon, SelectField, Text } from '~/components/ui';
import { useI18n } from '~/lib/i18n/I18nProvider';

import { clockLabels } from './kstClock';

const OPTIONS = LOCALES.map((l) => ({ value: l.code, label: l.label }));
const CLOCK_REFRESH_MS = 30_000;

/** 앱이 앞에 있는가 — 돌아오면 true 로 바뀌어 시계가 바로 갱신된다. */
function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/** 언어 알약 — 유리 판 위에 투명 SelectField(웹 빌드 <select>, 네이티브 가운데 목록)를 겹쳐 열기·읽기 이름을 맡긴다. */
function LanguagePill() {
  const { locale, setLocale, t } = useI18n();
  const label = OPTIONS.find((o) => o.value === locale)?.label ?? '';
  return (
    <View>
      <Glass className="min-h-[32px] flex-row items-center gap-[6px] px-[12px]">
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="flex-row items-center gap-[6px]"
        >
          <Icon icon={Globe} size={16} color="muk-soft" />
          <Text className="text-[14px]" weight="medium">
            {label}
          </Text>
          <Icon icon={ChevronDown} size={14} color="muk-soft" />
        </View>
      </Glass>
      {/* 같은 크기의 투명 SelectField — iOS 는 알파 0.01 미만 뷰의 터치를 버려 0.011 로 둔다. */}
      <SelectField<Locale>
        variant="pill"
        value={locale}
        options={OPTIONS}
        onChange={setLocale}
        accessibilityLabel={t('common.languageSelect')}
        leading={<Globe size={16} color="transparent" />}
        style={{ position: 'absolute', top: 0, left: 0, opacity: 0.011 }}
      />
    </View>
  );
}

function SourcePill() {
  const { t } = useI18n();
  return (
    <Glass className="self-start px-[10px] py-[3px]">
      <Text className="text-[10px] text-muk-soft" weight="semibold" style={{ lineHeight: 10 }}>
        {t('credit.tourapi')}
      </Text>
    </Glass>
  );
}

function ClockCard() {
  const { locale } = useI18n();
  const active = useAppActive();
  const [now, setNow] = useState(() => new Date());
  // 30초마다, 그리고 앱으로 돌아올 때 바로 갱신한다(웹 setInterval 30s).
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), CLOCK_REFRESH_MS);
    return () => clearInterval(id);
  }, [active]);
  const labels = useMemo(() => clockLabels(now, locale), [now, locale]);
  return (
    <Glass
      shape="panel"
      className="flex-row items-center gap-[8px] px-[12px] py-[8px]"
      accessible
      accessibilityLabel={`${labels.date} ${labels.time} KST`}
    >
      <Icon icon={Clock3} size={16} color="gold" />
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="items-end">
        <Text className="text-[10px] text-muk-soft" weight="semibold" style={{ lineHeight: 10 }}>
          {labels.date}
        </Text>
        <View className="mt-[4px] flex-row items-baseline">
          <Text
            className="mr-[4px] text-[10px] text-gold-deep"
            weight="bold"
            style={{ lineHeight: 10, letterSpacing: 1 }}
          >
            KST
          </Text>
          <Text className="text-[13px]" weight="extrabold" style={{ lineHeight: 13, letterSpacing: -0.325 }}>
            {labels.time}
          </Text>
        </View>
      </View>
    </Glass>
  );
}

export function HomeTopCluster() {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      className="absolute flex-row items-start justify-between gap-[8px]"
      style={{ top: insets.top + 8, left: 12, right: 12, zIndex: 30 }}
    >
      <View className="min-w-0 items-start gap-[4px]" style={{ maxWidth: 220 }}>
        <LanguagePill />
        <SourcePill />
      </View>
      <ClockCard />
    </View>
  );
}
