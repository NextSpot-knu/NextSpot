// 저장 카드 한 장 — 순위 배지 · 분류 · 혼잡 글자 · 이름 · 삭제 · 타임라인(출발 → 도착 → 이용). 웹 saved/page.tsx 의 카드.
// 카드 전체는 누르면 상세 시트가 열리고, 삭제는 카드 안의 별도 버튼(44pt)이다. 골든타임은 시각만(알림은 F1 — D10 ①).
import { Trash2 } from 'lucide-react-native';
import { View } from 'react-native';

import { GoldenHourBadge } from '~/components/GoldenHourBadge';
import { Gradient, Icon, Pressable, RankBadge, Text } from '~/components/ui';
import { colors, shadows } from '~/lib/theme/tokens';
import { useT } from '~/lib/i18n/I18nProvider';

import { CATEGORY_LABEL_TO_KEY, clockText, timelineOf, trafficLabelKey, type SavedBookmark } from './savedList';

// 웹 renderTrafficIndicator — '여유'는 Tailwind v4 emerald-500(#00bc7d), '한산'은 비취.
const DOT: Record<SavedBookmark['trafficStatus'], string> = {
  orange: 'bg-terracotta',
  yellow: 'bg-gold',
  green: 'bg-emerald-500-web',
  blue: 'bg-jade',
  unknown: 'bg-line',
};

// 웹 `w-12`(48) 노드 — 점(ring-4 hanji) · 시각 10/bold · 라벨 10.
function TimelineNode({ dot, time, label }: { dot: string; time: string; label: string }) {
  return (
    <View className="items-center" style={{ width: 48 }}>
      <View className={`mb-[6px] h-[8px] w-[8px] rounded-full ${dot}`} style={{ boxShadow: `0px 0px 0px 4px ${colors.hanji}` }} />
      <Text className="text-[10px] leading-[15px]" weight="bold">
        {time}
      </Text>
      <Text className="mt-[2px] text-[10px] leading-[15px] text-muk-soft">{label}</Text>
    </View>
  );
}

// 연결선 위 알약 — 웹 `absolute top-[-10px] left-[25%|50%|75%] -translate-x-1/2`. 폭 0 앵커는 글자가 두 줄이 되므로(R2) 폭 120 + marginLeft -60.
function LinePill({ left, className, textClass, children }: { left: '25%' | '50%' | '75%'; className: string; textClass: string; children: string }) {
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: -10, left, width: 120, marginLeft: -60, alignItems: 'center', zIndex: 10 }}
    >
      <View className={`rounded border bg-hanji px-[6px] py-[2px] ${className}`}>
        <Text className={textClass} weight="medium">
          {children}
        </Text>
      </View>
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
  const minutes = t('saved.minutes', { n: Math.max(1, Math.round(tl.timeToService)) });
  const summary = [
    t('saved.rankSuffix', { rank }),
    bookmark.name,
    category,
    labelKey ? t(labelKey) : null,
    t('saved.totalTime') + ' ' + minutes,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    // 두 겹 — 바깥은 그림자, 안쪽은 overflow hidden(안드로이드는 같은 View 의 overflow 가 그림자를 자른다).
    <View className="rounded-2xl" style={{ boxShadow: shadows.card }}>
      <View className={`overflow-hidden rounded-2xl border ${selected ? 'border-gold bg-gold/15' : 'border-line bg-white'}`}>
        <Pressable accessibilityRole="button" accessibilityLabel={summary} onPress={onOpen} className="min-h-[44px] px-[16px] pt-[16px]">
          {/* 웹 absolute top-3 left-3 — 카드 안쪽 모서리 */}
          <RankBadge rank={rank} size={32} style={{ position: 'absolute', top: 12, left: 12 }} />
          {/* 오른쪽 위 삭제 버튼(44 + 여백 4) 자리 — 이름 줄 오른쪽 여백 48 (R2: 52 아님) */}
          <View className="pl-[36px] pr-[48px]">
            <View className="mb-[4px] mt-[4px] flex-row flex-wrap items-center gap-[8px]">
              <View className="rounded-md bg-hanji-deep px-[8px] py-[2px]">
                <Text className="text-[12px] leading-[16px] text-muk-soft" weight="semibold">
                  {category}
                </Text>
              </View>
              {labelKey ? (
                <View className="flex-row items-center gap-[4px]">
                  <View className={`h-[12px] w-[12px] rounded-full ${DOT[bookmark.trafficStatus]}`} />
                  <Text className="text-[10px] leading-[15px] text-muk-soft">{t(labelKey)}</Text>
                </View>
              ) : null}
            </View>
            <Text className="text-[18px] leading-[28px]" weight="bold">
              {bookmark.name}
            </Text>
          </View>

          <View className="mt-[16px] gap-[12px] rounded-2xl border border-line bg-hanji px-[16px] py-[12px]">
            <View className="mb-[4px] flex-row items-center justify-between px-[4px]">
              <Text className="text-[10px] leading-[15px] text-muk-soft" weight="semibold">
                {t('saved.totalTime')}
              </Text>
              <Text className="text-[14px] leading-[20px] text-gold-deep" weight="extrabold">
                {minutes}
              </Text>
            </View>
            <View className="flex-row items-start justify-between">
              {/* 연결선 — 금빛 가로 그라데이션 */}
              <Gradient
                colors={['rgba(193,154,62,0.2)', 'rgba(193,154,62,0.45)', 'rgba(193,154,62,0.2)']}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{ position: 'absolute', top: 3, left: 16, right: 16, height: 2, borderRadius: 1 }}
              />
              <LinePill
                left={tl.service ? '25%' : '50%'}
                className="border-jade/25"
                textClass="text-[10px] leading-[15px] text-jade"
              >
                {t('saved.travelLabel', { n: Math.max(1, Math.ceil(tl.travelMins)) })}
              </LinePill>
              {tl.service && tl.waitMins !== null ? (
                <LinePill left="75%" className="border-gold/25" textClass="text-[11px] leading-[16.5px] text-gold-deep">
                  {t('saved.waitLabel', { n: tl.waitMins })}
                </LinePill>
              ) : null}
              <TimelineNode dot="bg-muk" time={clockText(now)} label={t('saved.depart')} />
              <TimelineNode dot="bg-jade" time={clockText(tl.arrival)} label={t('saved.arrive')} />
              {tl.service ? <TimelineNode dot="bg-gold" time={clockText(tl.service)} label={secondLabel} /> : null}
            </View>
          </View>
        </Pressable>
        {/* 골든타임 배지(알림 받기 버튼 포함)는 카드 Pressable 밖 형제 — 안에 두면 읽기 화면이 묶어 버려 버튼에 닿지 못한다(F1). */}
        <View className="px-[16px] pb-[16px]">
          <GoldenHourBadge facilityId={bookmark.id} className="mt-[8px]" />
        </View>
        {/* 삭제 — 카드 눌림과 별개의 버튼(중첩 Pressable 이 아니라 형제). 웹 폰 44×44 · 위 16 · 오른쪽 20 · 아이콘 16 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('saved.deleteAria', { name: bookmark.name })}
          onPress={onDelete}
          className="absolute right-[20px] top-[16px] h-[44px] w-[44px] items-center justify-center rounded-xl bg-terracotta/10"
        >
          <Icon icon={Trash2} size={16} color="terracotta" />
        </Pressable>
      </View>
    </View>
  );
}
