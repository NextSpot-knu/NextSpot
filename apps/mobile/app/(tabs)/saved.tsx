// 저장 탭 — 웹 apps/web/app/saved/page.tsx 의 앱판. 저장한 장소를 점수 순으로 보여 주고(분류 필터), 지금 출발하면의 출발·도착·이용 시각을
// 카드마다 말한다. 카드를 누르면 추천 카드 시트(features/saved/sheetSlot), 삭제·전체 초기화는 여기서 한다.
// 로컬 저장을 먼저 그리고 Supabase 와 동기화해 갱신한다(기기 변경 복원). '한산해지면 알림 받기' 줄과 골든타임 알림은 F1(D10 ①).
// D16: (a) 떠날 때 필터·선택·스크롤 초기화 (b) 방문마다 다시 받기 (c) 재진입에는 스켈레톤 없음.
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Star } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { pushMypageSub, useOpenMypageHome } from '~/components/navigation/useOpenMypage';
import { Button, Chip, GlowPair, Icon, NowChip, Screen, Skeleton, Text, confirmDestructive, toast } from '~/components/ui';
import { submitFeedback } from '~/lib/core/apiClient';
import { clearSavedAll, loadSavedLocal, removeBookmark, syncSaved } from '~/lib/core/savedFacilities';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { shadows } from '~/lib/theme/tokens';
import { SavedCard } from '~/features/saved/SavedCard';
import { SavedEmpty } from '~/features/saved/SavedEmpty';
import {
  CATEGORY_LABEL_TO_KEY,
  categoryView,
  isRealRecommendationId,
  sortBookmarks,
  type SavedBookmark,
} from '~/features/saved/savedList';
import { SavedSheetSlot } from '~/features/saved/sheetSlot';

const TAB_EDGES = ['top', 'left', 'right'] as const;
const SKELETON_TINT = 'rgba(241,231,211,0.6)';

function toBookmarks(list: unknown[]): SavedBookmark[] {
  return sortBookmarks(list as SavedBookmark[]);
}

export default function SavedScreen() {
  const t = useT();
  const router = useRouter();
  const openMypageHome = useOpenMypageHome();
  const { gap } = useNavInsets();
  const [bookmarks, setBookmarks] = useState<SavedBookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SavedBookmark | null>(null);
  const [category, setCategory] = useState('all');
  const [now, setNow] = useState(() => new Date());
  const aliveRef = useRef(true);
  const scrollRef = useRef<ScrollView>(null);
  // 세대 — 동기화가 날아가는 동안 삭제·전체 초기화·새 동기화가 있으면 그 늦은 결과로 목록을 덮지 않는다(지운 장소가 되살아나지 않게).
  const genRef = useRef(0);

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
    const gen = ++genRef.current;
    setNow(new Date());
    setBookmarks(toBookmarks(loadSavedLocal()));
    try {
      const merged = toBookmarks(await syncSaved());
      if (aliveRef.current && gen === genRef.current) setBookmarks(merged);
    } catch {
      /* 로컬 목록 유지 */
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
      // 떠날 때 화면 상태를 되돌린다 — 웹은 탭을 옮기면 화면이 새로 마운트된다(D16 a).
      return () => {
        setCategory('all');
        setSelected(null);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      };
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
      genRef.current += 1; // 진행 중인 동기화 결과는 버린다
      setBookmarks((prev) => prev.filter((x) => x.id !== b.id));
      void removeBookmark(b.id); // 로컬 + Supabase 삭제
      setSelected((cur) => (cur?.id === b.id ? null : cur));
      haptic('confirm');
      toast.success(message);
    },
    [notifyUnsaved],
  );

  // 되돌릴 수 없는 동작 — 웹처럼 화면 아래 토스트에 [취소][초기화](8초). OS 대화상자는 쓰지 않는다(G4a-12).
  const clearAll = useCallback(async () => {
    const ok = await confirmDestructive({
      id: 'saved-clear-confirm',
      title: t('saved.clearConfirm'),
      message: t('saved.clearConfirmDesc'),
      confirmLabel: t('saved.clearAction'),
      cancelLabel: t('common.cancel'),
      duration: 8000,
    });
    if (!ok || !aliveRef.current) return;
    genRef.current += 1;
    setBookmarks([]);
    setSelected(null);
    void clearSavedAll(); // 로컬 + Supabase 전체 삭제(앱 v1 은 경주만 — 지역 필터 없음)
    haptic('success');
    toast.success(t('saved.clearedSuccess'));
  }, [t]);

  const view = categoryView(bookmarks, category);

  return (
    <View className="flex-1 bg-hanji">
      {/* 웹 페이지 바탕의 노을·금빛 광원(Glow preset saved 300/100) — 스크롤과 무관하게 고정.
          자르기는 광원 전용 상자에 준다: 루트에 overflow hidden 을 주면 웹 빌드에서 넘친 광원 때문에 루트가 가로로 스크롤될 수 있다(scrollIntoView). */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
        <GlowPair preset="saved" />
      </View>
      <Screen edges={TAB_EDGES} className="bg-transparent" contentClassName="px-0" maxWidth={false}>
        {/* 머리 — 웹 header p-5 border-b: 로고 28(폭 130). 스크롤 밖에 남는다. */}
        <View
          className="items-center justify-center border-b border-line p-[20px]"
          accessible
          accessibilityRole="header"
          accessibilityLabel={t('common.appName')}
        >
          <Image source={require('~/assets/images/nextspot-logo.png')} style={{ height: 28, width: 130 }} contentFit="contain" />
        </View>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: gap }}
        >
          {loading ? (
            <View className="gap-[16px]" accessible accessibilityLabel={t('common.loading')} accessibilityState={{ busy: true }}>
              {[0, 1, 2].map((i) => (
                <View key={i} className="gap-[12px] rounded-2xl border border-line bg-white p-[16px]" style={{ boxShadow: shadows.card }}>
                  <View className="flex-row items-center gap-[8px]">
                    <Skeleton width={64} height={20} />
                    <Skeleton width={12} height={12} radius={9999} />
                  </View>
                  <Skeleton width="66%" height={20} />
                  <Skeleton height={64} radius={16} style={{ backgroundColor: SKELETON_TINT }} />
                </View>
              ))}
            </View>
          ) : bookmarks.length === 0 ? (
            <View className="flex-1 justify-center">
              <SavedEmpty
                title={t('saved.emptyTitle')}
                body={t('saved.emptyBody')}
                ctaLabel={t('saved.browseMap')}
                onCta={() => router.navigate('/')}
              />
            </View>
          ) : (
            <View className="gap-[16px]">
              <View className="gap-[12px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
                <View className="flex-row flex-wrap items-center gap-[8px]">
                  <View className="flex-row items-center gap-[4px] self-start rounded-full border border-gold/30 bg-gold/15 px-[10px] py-[4px]">
                    <Icon icon={Star} size={11} color="gold-deep" fill="rgba(193,154,62,0.6)" />
                    <Text className="text-[11px] text-gold-deep" weight="bold">
                      {t('saved.title')}
                    </Text>
                  </View>
                  <NowChip />
                </View>
                <Text className="text-[22px] leading-[25.3px]" weight="black" accessibilityRole="header" style={{ letterSpacing: -0.55 }}>
                  {t('saved.heroTitle')}
                </Text>
                <Text className="text-[13px] leading-[21.1px] text-muk-soft">{t('saved.heroDesc')}</Text>
                <View className="flex-row flex-wrap items-center gap-[8px] pt-[2px]">
                  <View
                    className="flex-row items-center gap-[6px] rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]"
                    style={{ boxShadow: shadows.goldSoft }}
                  >
                    <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no">
                      ⭐
                    </Text>
                    <Text className="text-[13px] text-gold-deep" weight="black">
                      {t('saved.heroCount', { n: bookmarks.length })}
                    </Text>
                  </View>
                  <Button
                    variant="dangerSoft"
                    shape="full"
                    size={44}
                    labelSize={12}
                    paddingX={16}
                    className="ml-auto"
                    label={t('saved.clearAll')}
                    onPress={() => void clearAll()}
                  />
                </View>
              </View>

              {view.available.length > 1 ? (
                <ScrollView
                  horizontal
                  nestedScrollEnabled
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}
                  className="grow-0"
                >
                  {['all', ...view.available].map((cat) => {
                    const label = cat === 'all' ? t('saved.filterAll') : t(`category.${CATEGORY_LABEL_TO_KEY[cat]}`);
                    const count = cat === 'all' ? bookmarks.length : view.counts[cat];
                    return (
                      <Chip
                        key={cat}
                        variant="savedFilter"
                        label={label}
                        count={count}
                        selected={view.effective === cat}
                        onPress={() => {
                          haptic('selection');
                          setCategory(cat);
                        }}
                      />
                    );
                  })}
                </ScrollView>
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
        </ScrollView>
      </Screen>
      <SavedSheetSlot
        bookmark={selected}
        onClose={() => setSelected(null)}
        onRemove={(b) => remove(b, t('saved.removedFromSaved', { name: b.name }))}
        onViewProfile={openMypageHome}
        onViewLab={() => pushMypageSub('lab')}
      />
    </View>
  );
}
