// 저장 카드 한 장 — 순위 배지 · 분류 · 혼잡 글자 · 이름 · 삭제 · 타임라인(출발 → 도착 → 이용). 웹 saved/page.tsx 의 카드.
// 카드 전체는 누르면 상세 시트가 열리고, 삭제는 카드 안의 별도 버튼(44pt)이다. 골든타임은 시각만(알림 없음 — 계획 §3.1).
import { Trash2 } from 'lucide-react-native';
import { View } from 'react-native';

import { Icon, Pressable, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { GoldenHourLabel } from '~/features/waiting/GoldenHourLabel';

import { CATEGORY_LABEL_TO_KEY, clockText, timelineOf, trafficLabelKey, type SavedBookmark } from './savedList';

const DOT: Record<SavedBookmark['trafficStatus'], string> = {
  orange: 'bg-terracotta',
  yellow: 'bg-gold',
  green: 'bg-jade',
  blue: 'bg-jade',
  unknown: 'bg-line',
};

function TimelineNode({ dot, time, label }: { dot: string; time: string; label: string }) {
  return (
    <View className="min-w-[48px] items-center">
      <View className={`mb-[6px] h-[8px] w-[8px] rounded-full ${dot}`} />
      <Text className="text-[12px]" weight="bold">
        {time}
      </Text>
      <Text className="mt-[2px] text-[11px] text-muk-soft">{label}</Text>
    </View>
  );
}

export interface SavedCardProps {
  bookmark: SavedBookmark;
  rank: number;
  now: Date;
  selected: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

export function SavedCard({ bookmark, rank, now, selected, onOpen, onDelete }: SavedCardProps) {
  const t = useT();
  const tl = timelineOf(bookmark, now);
  const labelKey = trafficLabelKey(bookmark.trafficStatus);
  const categoryKey = CATEGORY_LABEL_TO_KEY[bookmark.category];
  const category = categoryKey ? t(`category.${categoryKey}`) : bookmark.category;
  const secondLabel = bookmark.category === '음식점' || bookmark.category === '카페' ? t('saved.dine') : t('saved.view');
  const summary = [
    t('saved.rankSuffix', { rank }),
    bookmark.name,
    category,
    labelKey ? t(labelKey) : null,
    t('saved.totalTime') + ' ' + t('saved.minutes', { n: Math.max(1, Math.round(tl.timeToService)) }),
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <View
      className={`overflow-hidden rounded-2xl border ${selected ? 'border-gold bg-gold/15' : 'border-line bg-white'}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        onPress={onOpen}
        className="min-h-[44px] p-[16px]"
      >
        <View
          className={`absolute left-[12px] top-[12px] z-10 h-[32px] w-[32px] items-center justify-center rounded-full border-2 border-white ${
            rank === 1 ? 'bg-gold-deep' : 'bg-gold'
          }`}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <Text className="text-[13px] text-white" weight="extrabold">
            {rank}
          </Text>
        </View>
        {/* 오른쪽 위 삭제 버튼 자리 — 카드 본문과 겹치지 않게 이름 줄에 오른쪽 여백을 둔다. */}
        <View className="pl-[36px] pr-[48px] pt-[4px]">
          <View className="mb-[4px] flex-row flex-wrap items-center gap-[8px]">
            <View className="rounded-md bg-hanji-deep px-[8px] py-[2px]">
              <Text className="text-[12px] text-muk-soft" weight="semibold">
                {category}
              </Text>
            </View>
            {labelKey ? (
              <View className="flex-row items-center gap-[4px]">
                <View className={`h-[12px] w-[12px] rounded-full ${DOT[bookmark.trafficStatus]}`} />
                <Text className="text-[11px] text-muk-soft">{t(labelKey)}</Text>
              </View>
            ) : null}
          </View>
          <Text className="text-[18px] leading-[24px]" weight="bold" numberOfLines={2}>
            {bookmark.name}
          </Text>
        </View>

        <View className="mt-[16px] gap-[10px] rounded-2xl border border-line bg-hanji px-[16px] py-[12px]">
          <View className="flex-row items-center justify-between">
            <Text className="text-[11px] text-muk-soft" weight="semibold">
              {t('saved.totalTime')}
            </Text>
            <Text className="text-[14px] text-gold-deep" weight="extrabold">
              {t('saved.minutes', { n: Math.max(1, Math.round(tl.timeToService)) })}
            </Text>
          </View>
          <View className="flex-row flex-wrap items-center gap-[6px]">
            <View className="rounded border border-jade/25 bg-hanji px-[6px] py-[2px]">
              <Text className="text-[11px] text-jade" weight="medium">
                {t('saved.travelLabel', { n: Math.max(1, Math.ceil(tl.travelMins)) })}
              </Text>
            </View>
            {tl.waitMins !== null ? (
              <View className="rounded border border-gold/25 bg-hanji px-[6px] py-[2px]">
                <Text className="text-[11px] text-gold-deep" weight="medium">
                  {t('saved.waitLabel', { n: tl.waitMins })}
                </Text>
              </View>
            ) : null}
          </View>
          <View className="flex-row items-start justify-between">
            <TimelineNode dot="bg-muk" time={clockText(now)} label={t('saved.depart')} />
            <TimelineNode dot="bg-jade" time={clockText(tl.arrival)} label={t('saved.arrive')} />
            {tl.service ? <TimelineNode dot="bg-gold" time={clockText(tl.service)} label={secondLabel} /> : null}
          </View>
        </View>
        <GoldenHourLabel facilityId={bookmark.id} className="mt-[8px]" />
      </Pressable>
      {/* 삭제 — 카드 눌림과 별개의 버튼(중첩 Pressable 이 아니라 형제). 보이는 상자 44pt. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('saved.deleteAria', { name: bookmark.name })}
        onPress={onDelete}
        className="absolute right-[8px] top-[8px] h-[44px] w-[44px] items-center justify-center rounded-xl bg-terracotta/10"
      >
        <Icon icon={Trash2} size="lg" color="terracotta" />
      </Pressable>
    </View>
  );
}
