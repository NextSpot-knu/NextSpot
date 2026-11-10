// 홈 주차장 탭의 아래 판(G2-25 5번 · H2b) — 웹 apps/web/app/main/page.tsx 4637-4690 의 휴대폰 모양을 옮겼다(`parking-tab-web`).
// 자료는 useParkingLots 가 만든다. 이 컴포넌트는 세 판 중 하나를 그린다(웹과 같은 조건):
//   · 불러오는 중 + 목록 없음 → 흰 95% 상자 '공식 주차장 정보를 불러오고 있어요.'(누름 없음)
//   · 다 받았는데 목록 없음 → 같은 상자에 '찾지 못했어요' 또는 실패 문구 + 실패면 먹 알약 '다시 시도'
//   · 고른 주차장 → 카드: 하늘 eyebrow(공영주차장 · 출처: 경주시) · 이름 18 bold · 거리 12 · ✕ · (실시간이면) 잔여면 jade 상자 ·
//     검정 '자동차 길안내'(카카오맵 자동차 길찾기 — 웹 openDrivingDirections 와 같은 주소).
// 자리: 웹 `absolute inset-x-0 px-4 bottom-[clearance]` → 탭 화면 안 bottom NAV_GAP, 좌우 16 + 안전 영역(H3a 스택과 같다).
// 주차장 탭에서는 카드 스택·예측 띠가 없다(웹 activeFilter !== '주차장' 조건) — 이 판이 그 자리를 쓴다. 넣는 곳은 H3b.
import { Car, X } from 'lucide-react-native';
import { View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NAV_GAP } from '~/components/navigation/navMetrics';
import { Icon } from '~/components/ui/Icon';
import { Pressable } from '~/components/ui/Pressable';
import { Text } from '~/components/ui/Text';
import { useT } from '~/lib/i18n/I18nProvider';
import { openDrivingDirections } from '~/lib/platform/links';

import { liveSpacesOf, parkingDistanceText, type ParkingLot } from './parkingModel';

/** 웹 shadow-lg(v4) — 0 10 15 −3 / 0 4 6 −4 검정 .1. */
const SHADOW_LG = '0px 10px 15px -3px rgba(0, 0, 0, 0.1), 0px 4px 6px -4px rgba(0, 0, 0, 0.1)';
/** 선택 카드 그림자 — 웹 shadow-[0_8px_30px_rgba(43,35,32,0.16)]. */
const CARD_SHADOW = '0px 8px 30px rgba(43, 35, 32, 0.16)';
const SIDE = 16;

export interface ParkingPanelProps {
  lots: readonly ParkingLot[];
  loading: boolean;
  error: boolean;
  selected: ParkingLot | null;
  /** ✕ — 선택만 푼다(웹 setSelectedParkingLot(null)). */
  onClose: () => void;
  /** '다시 시도'(useParkingLots.reload). */
  onRetry: () => void;
  /** 판 높이 — 홈이 지도 mapPadding(구글 로고)·카메라 띠 아래끝을 잴 때(판 위끝 = 화면 높이 − NAV_GAP − 높이). */
  onLayout?: (event: LayoutChangeEvent) => void;
}

export function ParkingPanel({ lots, loading, error, selected, onClose, onRetry, onLayout }: ParkingPanelProps) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const empty = lots.length === 0;
  const mode: 'loading' | 'empty' | 'card' | null =
    loading && empty ? 'loading' : !loading && empty ? 'empty' : selected ? 'card' : null;
  if (!mode) return null;

  return (
    <View
      pointerEvents="box-none"
      onLayout={onLayout}
      style={{
        position: 'absolute',
        left: SIDE + insets.left,
        right: SIDE + insets.right,
        bottom: NAV_GAP,
        zIndex: 20,
      }}
    >
      {mode === 'loading' ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          className="rounded-2xl border border-line bg-white/95 px-[20px] py-[16px]"
          style={{ boxShadow: SHADOW_LG }}
        >
          <Text className="text-sm text-muk" weight="semibold">
            {t('map.parkingLoading')}
          </Text>
        </View>
      ) : null}

      {mode === 'empty' ? (
        <View
          accessibilityLiveRegion="polite"
          className="rounded-2xl border border-line bg-white/95 px-[20px] py-[16px]"
          style={{ boxShadow: SHADOW_LG }}
        >
          <Text className="text-sm text-muk" weight="semibold">
            {t(error ? 'map.parkingLoadFailed' : 'map.parkingEmpty')}
          </Text>
          {error ? (
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              className="mt-[12px] self-start rounded-full bg-muk px-[16px] py-[8px]"
            >
              <Text className="text-xs text-white" weight="bold">
                {t('common.retry')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {mode === 'card' && selected ? <ParkingCard lot={selected} onClose={onClose} /> : null}
    </View>
  );
}

function ParkingCard({ lot, onClose }: { lot: ParkingLot; onClose: () => void }) {
  const t = useT();
  const live = liveSpacesOf(lot);
  return (
    <View
      testID="parking-card"
      className="rounded-3xl border border-line bg-white/95 p-[20px]"
      style={{ boxShadow: CARD_SHADOW }}
    >
      <View className="flex-row items-start justify-between gap-[12px]">
        <View className="min-w-0 flex-1">
          <Text className="text-[10px] text-sky-700-web" weight="bold">
            {t('map.parkingEyebrow')}
          </Text>
          <Text role="heading" className="mt-[4px] text-lg text-muk" weight="bold">
            {lot.name}
          </Text>
          <Text className="mt-[4px] text-xs text-muk-soft">
            {t('map.parkingDistance', { n: parkingDistanceText(lot.distanceM) })}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          hitSlop={5}
          onPress={onClose}
          className="rounded-full p-[8px]"
        >
          <Icon icon={X} size={18} color="muk-soft" />
        </Pressable>
      </View>
      {/* 잔여면 실시간 값이 있을 때만 상자를 그린다 — 없다는 사실은 관광객에게 할 일을 주지 않는다. */}
      {live ? (
        <View className="mt-[16px] rounded-2xl border border-jade/25 bg-jade/10 px-[16px] py-[12px]">
          <Text className="text-sm text-jade" weight="extrabold">
            {t('map.parkingLiveSpaces', { available: live.available, total: live.total })}
          </Text>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => void openDrivingDirections({ name: lot.name, latitude: lot.latitude, longitude: lot.longitude })}
        className="mt-[16px] w-full flex-row items-center justify-center gap-[8px] rounded-2xl bg-muk px-[16px] py-[12px]"
      >
        <Icon icon={Car} size={16} color="white" />
        <Text className="text-sm text-white" weight="bold">
          {t('map.parkingDirections')}
        </Text>
      </Pressable>
    </View>
  );
}
