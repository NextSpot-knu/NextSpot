// 저장 장소를 눌렀을 때 뜨는 상세 — 웹 saved/page.tsx 470-535 의 포커스 오버레이(딤 베일 + 아래 가운데 카드)를 옮긴다(G4a-13 · G3-R02).
//
// 카드는 홈과 같은 RecommendationCard 의 '저장 변형'(G3-R02): 바로 전체 카드(compactPeek=false), 비교 첫 줄 없음(showCompare=false),
// 순위 배지는 'AI 추천'(showListRank=false), '다시 안볼래요' 는 서버 거절이 아니라 저장 목록에서 빼기(rejectIsRemoval).
// 킵·자동차 길안내는 넘기지 않는다(웹도 onPutOff · onDrive 없이 부른다 — 바닥 줄은 [다시 안볼래요][바로 갈래요] / [빈 칸][혼잡 제보]).
//   · onAccept(바로 갈래요) — 서버 수락·여정 기록·길안내는 카드가 이미 했다. 여기서는 상세만 닫는다(길안내를 두 번 열지 않는다).
//   · onReject → onRemove(저장에서 빼기). 화면이 unsaved 피드백·삭제·토스트를 처리하고 상세를 닫는다.
// 틀(§4.3 '저장 상세'): 베일은 화면 루트 전체(로고·머리도 덮는다), 도크는 탭 막대 위 NAV_GAP 에서 가운데 최대 폭 400 · 좌우 16.
//   높이 상한은 카드 자신의 값(창 − 탭 막대 − NAV_GAP − 위 안전 영역 − 160)이 걸리므로 바깥 스크롤은 두지 않는다.
// 닫기: 베일 누르기 · 안드로이드 뒤로 키 · 웹 빌드 Esc.
// 화면(app/(tabs)/saved.tsx)은 이 파일의 `SavedSheetSlot` 과 props 만 안다 — 화면 루트(Screen 밖)에 둔다.
import { useEffect, useMemo } from 'react';
import { BackHandler, Platform, Pressable as RNPressable, StyleSheet, View } from 'react-native';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { RecommendationCard } from '~/features/recommendation-card';
import { useT } from '~/lib/i18n/I18nProvider';

import { candidateFromBookmark, type SavedBookmark } from './savedList';

/** 웹 bg-hanok/40(한옥 #efe7d8 40%) — 테마와 무관한 딤. */
const VEIL = 'rgba(239, 231, 216, 0.4)';
/** 웹 backdrop-blur-[2px] — 웹 빌드만(react-native-web 이 넘긴다). 안드로이드는 흐림 없이 딤만. */
const VEIL_BLUR = Platform.OS === 'web' ? ({ backdropFilter: 'blur(2px)' } as object) : null;
/** 웹 max-w-[400px] px-4. */
const DOCK_MAX_WIDTH = 400;
const DOCK_SIDE = 16;
const NO_CANDIDATES: readonly never[] = [];

export interface SavedSheetSlotProps {
  /** 열린 장소. null 이면 닫힘. */
  bookmark: SavedBookmark | null;
  onClose: () => void;
  /** 저장에서 빼기 — 웹 onReject. 화면이 unsaved 피드백·삭제·토스트를 처리하고 상세를 닫는다. */
  onRemove: (bookmark: SavedBookmark) => void;
  onViewProfile?: () => void;
  onViewLab?: () => void;
}

export function SavedSheetSlot({ bookmark, onClose, onRemove, onViewProfile, onViewLab }: SavedSheetSlotProps) {
  const t = useT();
  const nav = useNavInsets();
  const candidate = useMemo(() => (bookmark ? candidateFromBookmark(bookmark) : null), [bookmark]);
  const open = candidate !== null;

  // 안드로이드 뒤로 키 · 웹 빌드 Esc — 열려 있는 동안 상세만 닫는다(화면을 떠나지 않는다).
  useEffect(() => {
    if (!open) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    const doc = Platform.OS === 'web' ? (globalThis as { document?: Document }).document : undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    doc?.addEventListener('keydown', onKey);
    return () => {
      sub.remove();
      doc?.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!candidate || !bookmark) return null;
  return (
    <>
      <RNPressable
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: VEIL, zIndex: 20 }, VEIL_BLUR]}
      />
      {/* 도크 — 양옆 빈 자리 탭은 베일로 떨어져 닫힌다(box-none). */}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: nav.gap, alignItems: 'center', zIndex: 30 }}
      >
        <View pointerEvents="box-none" style={{ width: '100%', maxWidth: DOCK_MAX_WIDTH, paddingHorizontal: DOCK_SIDE }}>
          <RecommendationCard
            selected={candidate}
            candidates={NO_CANDIDATES}
            compactPeek={false}
            showCompare={false}
            showListRank={false}
            rejectIsRemoval
            onAccept={onClose}
            onReject={() => onRemove(bookmark)}
            onViewProfile={onViewProfile}
            onViewLab={onViewLab}
          />
        </View>
      </View>
    </>
  );
}
