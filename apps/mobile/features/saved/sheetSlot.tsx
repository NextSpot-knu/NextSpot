// 저장 장소를 눌렀을 때 뜨는 추천 카드 시트의 자리.
//
// TODO(통합): features/recommendation-card 가 만들어지면 이 파일의 본문을 그 시트로 바꾼다. 화면(app/(tabs)/saved.tsx)은
// 이 파일의 `SavedSheetSlot` 과 props 만 알면 되도록 해 두었다 — props 이름·뜻은 웹 saved/page.tsx 가 RecommendationCard 에
// 넘기던 것과 같다(card = title·matchPercentage·spotScore·preferencePercent·expectedWait·expectedTravel·timeToService·
// facilityType·facility, 그리고 onAccept → onDirections, onReject → onRemove).
//   · onRemove 는 웹의 '관심 없음' 과 같다 — 거절(rejected)이 아니라 '저장에서 뺀다'(unsaved)는 정리 동작이다.
// 아래 임시 본문은 같은 두 행동(길찾기 · 저장에서 빼기)만 하는 최소 시트라, 통합 전에도 화면 흐름을 끝까지 쓸 수 있다.
import { Button, ModalSheet, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { View } from 'react-native';

import type { SavedBookmark, SavedCardInput } from './savedList';

export interface SavedSheetSlotProps {
  /** 열린 장소. null 이면 닫힘. */
  bookmark: SavedBookmark | null;
  /** 상세 카드가 받는 값(savedCardInput 의 결과). bookmark 가 null 이면 null. */
  card: SavedCardInput | null;
  /** 상세 카드의 reason 문구(번역된 한 문장 — recommend.fallbackTravelOnly). */
  reason: string;
  onClose: () => void;
  /** 길찾기(카카오맵) — 웹 onAccept. 화면이 좌표 유무로 주소를 정한다. */
  onDirections: (bookmark: SavedBookmark) => void;
  /** 저장에서 빼기 — 웹 onReject. 화면이 unsaved 피드백·삭제·토스트를 처리하고 시트를 닫는다. */
  onRemove: (bookmark: SavedBookmark) => void;
}

export function SavedSheetSlot({ bookmark, card, reason, onClose, onDirections, onRemove }: SavedSheetSlotProps) {
  const t = useT();
  return (
    <ModalSheet open={bookmark !== null} onClose={onClose} handleLabel={t('common.close')} closeLabel={t('common.close')}>
      {bookmark && card ? (
        <View className="gap-[12px] px-[16px] pb-[16px]">
          <Text className="text-[18px]" weight="bold" accessibilityRole="header">
            {card.title}
          </Text>
          {card.facility.address ? <Text className="text-[13px] text-muk-soft">{card.facility.address}</Text> : null}
          <Text className="text-[13px] leading-[19px] text-muk-soft">{reason}</Text>
          <Button label={t('course.directions')} onPress={() => onDirections(bookmark)} />
          <Button
            variant="secondary"
            label={t('saved.deleteAria', { name: bookmark.name })}
            onPress={() => onRemove(bookmark)}
          />
        </View>
      ) : null}
    </ModalSheet>
  );
}
