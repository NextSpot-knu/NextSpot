// 저장 탭 — 웹 apps/web/app/saved/page.tsx 의 앱판. 저장한 장소를 점수 순으로 보여 주고(분류 필터), 지금 출발하면의 출발·도착·이용 시각을
// 카드마다 말한다. 카드를 누르면 추천 카드 시트(features/saved/sheetSlot), 삭제·전체 초기화는 여기서 한다.
// 로컬 저장을 먼저 그리고 Supabase 와 동기화해 갱신한다(기기 변경 복원). 알림(한산해지면 알려 주기)은 앱 v1 에 없다.
import { useFocusEffect, useRouter } from 'expo-router';
import { Compass, Star } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import { Button, Chip, EmptyState, Icon, Screen, Skeleton, Text, toast } from '~/components/ui';
import { submitFeedback } from '~/lib/core/apiClient';
import { clearSavedAll, loadSavedLocal, removeBookmark, syncSaved } from '~/lib/core/savedFacilities';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { NowChip } from '~/features/waiting/NowChip';
import { SavedCard } from '~/features/saved/SavedCard';
import {
  CATEGORY_LABEL_TO_KEY,
  categoryView,
  isRealRecommendationId,
  sortBookmarks,
  type SavedBookmark,
} from '~/features/saved/savedList';
import { SavedSheetSlot } from '~/features/saved/sheetSlot';

const TAB_EDGES = ['top', 'left', 'right'] as const;

function toBookmarks(list: unknown[]): SavedBookmark[] {
  return sortBookmarks(list as SavedBookmark[]);
}

export default function SavedScreen() {
  const t = useT();
  const router = useRouter();
  const [bookmarks, setBookmarks] = useState<SavedBookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SavedBookmark | null>(null);
  const [category, setCategory] = useState('all');
  const [now, setNow] = useState(() => new Date());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, []);

  // 화면에 올 때마다: 로컬로 먼저 그리고(오프라인·빠른 표시) 동기화 결과로 갱신. 동기화는 실패해도 로컬을 돌려준다.
  const load = useCallback(async () => {
    setNow(new Date());
    setBookmarks(toBookmarks(loadSavedLocal()));
    try {
      const merged = toBookmarks(await syncSaved());
      if (aliveRef.current) setBookmarks(merged);
    } catch {
      /* 로컬 목록 유지 */
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // 저장 해제 → unsaved. '취향에 안 맞는다'는 거절이 아니라 목록 정리라 학습이 없다. 전송 실패는 삭제와 무관(로컬이 정본).
  const notifyUnsaved = useCallback((b: SavedBookmark | undefined) => {
    if (!b || !isRealRecommendationId(b.recommendationId)) return;
    submitFeedback(b.recommendationId, 'unsaved').catch(() => {
      /* 로컬 삭제에는 영향 없음 */
    });
  }, []);

  const remove = useCallback(
    (b: SavedBookmark, message: string) => {
      notifyUnsaved(b);
      setBookmarks((prev) => prev.filter((x) => x.id !== b.id));
      void removeBookmark(b.id); // 로컬 + Supabase 삭제
      setSelected((cur) => (cur?.id === b.id ? null : cur));
      haptic('confirm');
      toast.success(message);
    },
    [notifyUnsaved],
  );

  const clearAll = useCallback(() => {
    // 되돌릴 수 없는 동작 — 네이티브 확인창(웹은 토스트 action 이었다).
    Alert.alert(t('saved.clearConfirm'), t('saved.clearConfirmDesc'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('saved.clearAction'),
        style: 'destructive',
        onPress: () => {
          setBookmarks([]);
          setSelected(null);
          void clearSavedAll(); // 로컬 + Supabase 전체 삭제(앱 v1 은 경주만 — 지역 필터 없음)
          haptic('success');
          toast.success(t('saved.clearedSuccess'));
        },
      },
    ]);
  }, [t]);

  const view = categoryView(bookmarks, category);

  return (
    <View className="flex-1">
    <Screen edges={TAB_EDGES} scroll contentClassName="px-[16px] pb-[24px] pt-[16px]">
      {loading ? (
        <View className="gap-[16px]" accessible accessibilityLabel={t('common.loading')} accessibilityState={{ busy: true }}>
          {[0, 1, 2].map((i) => (
            <View key={i} className="gap-[12px] rounded-2xl border border-line bg-white p-[16px]">
              <Skeleton width={96} height={20} />
              <Skeleton width="66%" height={20} />
              <Skeleton height={64} radius={16} />
            </View>
          ))}
        </View>
      ) : bookmarks.length === 0 ? (
        <View className="flex-1 justify-center py-[24px]">
          <EmptyState
            icon={Star}
            title={t('saved.emptyTitle')}
            description={t('saved.emptyBody')}
            action={{ label: t('saved.browseMap'), onPress: () => router.navigate('/') }}
          />
        </View>
      ) : (
        <View className="gap-[16px]">
          <View className="gap-[12px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
            <View className="flex-row flex-wrap items-center gap-[8px]">
              <View className="flex-row items-center gap-[4px] self-start rounded-full border border-gold/30 bg-gold/15 px-[10px] py-[4px]">
                <Icon icon={Star} size="xs" color="gold-deep" />
                <Text className="text-[11px] text-gold-deep" weight="bold">
                  {t('saved.title')}
                </Text>
              </View>
              <NowChip />
            </View>
            <Text className="text-[22px] leading-[26px]" weight="black" accessibilityRole="header">
              {t('saved.heroTitle')}
            </Text>
            <Text className="text-[13px] leading-[19px] text-muk-soft">{t('saved.heroDesc')}</Text>
            <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
              <View className="flex-row items-center gap-[6px] rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]">
                <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no">
                  ⭐
                </Text>
                <Text className="text-[13px] text-gold-deep" weight="black">
                  {t('saved.heroCount', { n: bookmarks.length })}
                </Text>
              </View>
              <Button variant="secondary" label={t('saved.clearAll')} onPress={clearAll} />
            </View>
          </View>

          {view.available.length > 1 ? (
            <View className="flex-row flex-wrap gap-[6px] px-[4px]">
              {['all', ...view.available].map((cat) => {
                const label = cat === 'all' ? t('saved.filterAll') : t(`category.${CATEGORY_LABEL_TO_KEY[cat]}`);
                const count = cat === 'all' ? bookmarks.length : view.counts[cat];
                return (
                  <Chip
                    key={cat}
                    label={`${label} ${count}`}
                    selected={view.effective === cat}
                    onPress={() => {
                      haptic('selection');
                      setCategory(cat);
                    }}
                  />
                );
              })}
            </View>
          ) : null}

          <View className="gap-[16px]">
            {view.visible.map((bookmark, index) => (
              <SavedCard
                key={bookmark.id}
                bookmark={bookmark}
                rank={index + 1}
                now={now}
                selected={selected?.id === bookmark.id}
                onOpen={() => setSelected(bookmark)}
                onDelete={() => remove(bookmark, t('saved.deleteSuccess'))}
              />
            ))}
          </View>
        </View>
      )}

    </Screen>
      <SavedSheetSlot
        bookmark={selected}
        onClose={() => setSelected(null)}
        onRemove={(b) => remove(b, t('saved.removedFromSaved', { name: b.name }))}
        onViewProfile={() => router.push('/mypage' as never)}
        onViewLab={() => router.push('/mypage/lab' as never)}
      />
    </View>
  );
}
