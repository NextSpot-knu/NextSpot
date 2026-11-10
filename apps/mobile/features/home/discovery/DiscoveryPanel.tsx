// ✨ 경주 테마(G2-14 · D12) — 날씨 줄의 ✨ 알약 · 테마 고르기 판 · 켜진 테마 판. 웹 /main page.tsx 4113-4126 · 4307-4405 를 옮겼다.
//
// 세 조각 모두 화면 상태를 가지지 않는다 — 열림·켜진 테마·선택은 HomeScreen 이 갖고, 여기서는 그리기와 누름만 넘긴다.
// 판은 웹처럼 위 묶음(검색 · 날씨 줄 · 검색 결과 아래)의 한 칸이다. 웹 `backdrop-blur` 는 bg-white/95 위라 거의 보이지 않아 옮기지 않았다.
// 줄 높이: 웹 text-sm = 14/20 · text-xs = 12/16(Tailwind v4 짝 줄 높이), text-[10·11px] 은 본문 1.5 를 물려받는다(15 · 16.5),
// leading-relaxed = 1.625 · leading-snug = 1.375 — Text 기본 1.5 와 다른 것만 적었다.
import { ChevronDown, ChevronUp, X } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';

import { Glass, Icon, Pressable, RingSpinner, Text } from '~/components/ui';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { colors } from '~/lib/theme/tokens';

import { CHIP_HIT_SLOP } from '../ToolChips';
import { DISCOVERY_THEMES, getDiscoveryTheme, type ActiveDiscovery, type DiscoveryResultItem, type DiscoveryTheme } from './discoveryModel';

/** 웹 shadow-[0_8px_28px_rgba(43,35,32,0.13)] — 두 판이 같이 쓴다. */
const PANEL_SHADOW = '0px 8px 28px rgba(43, 35, 32, 0.13)';
/** 웹 결과 칸 min-w-[148px]. */
const RESULT_MIN_WIDTH = 148;

/** 날씨 줄 끝의 ✨ 알약(웹 :4113-4126 — liquid-glass h-8 px-3 12px extrabold · ✨ 14 · ▾ 14 gold-deep). 키 낮은 폰은 글자를 숨긴다(sr-only). */
export function DiscoveryChip({ open, compact, onToggle }: { open: boolean; compact: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('discovery.entry')}
      accessibilityHint={t('discovery.entryHint')}
      accessibilityState={{ expanded: open }}
      hitSlop={CHIP_HIT_SLOP}
      onPress={onToggle}
      className="min-w-0 shrink rounded-full"
    >
      <Glass className="h-[32px] min-w-0 flex-row items-center gap-[6px] px-[12px]">
        <Text className="text-[14px] leading-none" weight="extrabold" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">✨</Text>
        {compact ? null : (
          <Text className="min-w-0 shrink text-[12px]" weight="extrabold" numberOfLines={1}>{t('discovery.entry')}</Text>
        )}
        <Icon icon={open ? ChevronUp : ChevronDown} size={14} color="gold-deep" />
      </Glass>
    </Pressable>
  );
}

/** 판 머리의 ✕(웹 rounded-full p-2 · X 16 muk-soft). */
function CloseButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      className="rounded-full p-[8px]"
    >
      <Icon icon={X} size={16} color="muk-soft" />
    </Pressable>
  );
}

/** 테마 고르기 판(웹 :4307-4336) — 제목 · 부제 · ✕, 아래 테마 칩 가로 줄. */
export function DiscoveryThemePanel({ onPick, onClose }: { onPick: (theme: DiscoveryTheme) => void; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <View
      className="rounded-[24px] border border-gold/30 bg-white/95 p-[16px]"
      style={{ boxShadow: PANEL_SHADOW }}
    >
      <View className="flex-row items-start justify-between gap-[12px]">
        <View className="min-w-0 flex-1">
          <Text className="text-[14px] leading-[20px]" weight="extrabold">{t('discovery.title')}</Text>
          <Text className="mt-[4px] text-[11px] leading-[17.875px] text-muk-soft">{t('discovery.subtitle')}</Text>
        </View>
        <CloseButton label={t('discovery.close')} onPress={onClose} />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="mt-[12px]"
        contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
      >
        {DISCOVERY_THEMES.map((theme) => (
          <Pressable
            key={theme.id}
            accessibilityRole="button"
            onPress={() => onPick(theme)}
            className="shrink-0 rounded-full border border-line bg-hanji px-[12px] py-[8px]"
          >
            <Text className="text-[12px] leading-[16px]" weight="bold" numberOfLines={1}>
              {`${theme.emoji} ${t(`discovery.theme.${theme.id}`)}`}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * 켜진 테마 판(웹 :4338-4405) — 테마 · '{기준} 기준 대안' · 근거 한 줄 · ✕(일반 추천으로), 아래는 비교 중 줄 또는 대안 3칸.
 * 칸을 누르면 그 장소가 카드에 오른다(웹 setSelectedFacility + panToVisible — 이용 이벤트 없음).
 */
export function DiscoveryActivePanel({
  active,
  loading,
  items,
  selectedId,
  comparisonText,
  onSelect,
  onClear,
}: {
  active: ActiveDiscovery;
  loading: boolean;
  items: readonly DiscoveryResultItem[];
  selectedId: string | null;
  comparisonText: (id: string) => string | undefined;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const theme = getDiscoveryTheme(active.themeId);
  return (
    <View
      className="rounded-[24px] border border-jade/25 bg-white/95 p-[16px]"
      style={{ boxShadow: PANEL_SHADOW }}
    >
      <View className="flex-row items-start justify-between gap-[12px]">
        <View className="min-w-0 flex-1">
          <Text className="text-[10px] text-jade" weight="extrabold">{`${theme.emoji} ${t(`discovery.theme.${theme.id}`)}`}</Text>
          <Text className="mt-[4px] text-[14px] leading-[20px]" weight="extrabold" numberOfLines={1}>
            {t('discovery.activeTitle', { anchor: active.anchorName })}
          </Text>
          <Text className="mt-[4px] text-[10px] leading-[16.25px] text-muk-soft">{t('discovery.activeBody')}</Text>
        </View>
        <CloseButton label={t('discovery.clear')} onPress={onClear} />
      </View>
      {loading ? (
        <View className="mt-[12px] flex-row items-center gap-[8px] rounded-[16px] bg-hanji-deep px-[12px] py-[10px]">
          <RingSpinner size={12} borderWidth={2} trackColor={`${colors.jade}4d`} headColor="jade" />
          <Text className="min-w-0 flex-1 text-[11px] text-muk-soft" weight="semibold">
            {t('discovery.loading', { anchor: active.anchorName })}
          </Text>
        </View>
      ) : items.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mt-[12px]"
          contentContainerStyle={{ flexGrow: 1, gap: 8, paddingBottom: 4 }}
        >
          {items.map((item) => {
            const selected = item.id === selectedId;
            const comparison = comparisonText(item.id);
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => onSelect(item.id)}
                className={`rounded-[16px] border px-[12px] py-[10px] ${selected ? 'border-jade bg-jade/10' : 'border-line bg-hanji'}`}
                style={{ flexGrow: 1, flexShrink: 0, flexBasis: 0, minWidth: RESULT_MIN_WIDTH }}
              >
                <Text className="text-[11px] text-jade" weight="extrabold">{t('discovery.alternativeRank', { rank: item.rank })}</Text>
                <Text className="mt-[2px] text-[12px] leading-[16px]" weight="extrabold" numberOfLines={1}>{item.name}</Text>
                {item.matchKey ? (
                  <Text className="mt-[4px] text-[11px] text-jade" weight="semibold">{t(item.matchKey)}</Text>
                ) : null}
                <Text className="mt-[4px] text-[11px] text-muk-soft" weight="semibold">{t('discovery.walkMinutes', { n: item.walkMinutes })}</Text>
                {comparison ? (
                  <Text className="mt-[4px] text-[11px] leading-[15.125px] text-muk-soft" numberOfLines={2}>{comparison}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}
