// 홈이 다른 에이전트의 화면을 꽂는 자리 — 추천 카드 시트.
//
// TODO(features/recommendation-card): 이 파일의 RecommendationSheetSlot 을 그쪽의 실제 시트로 바꾼다.
// 홈은 props 계약만 지킨다 — 웹 app/main/page.tsx 가 <RecommendationCard …/> 에 넘기는 값 중 지도 쪽이 아는 것(0d145a1).
// 카드 안의 동작(길안내·나중에·관심 없음·혼잡 제보·진행 중 여행·방문 확인)은 카드 쪽이 맡는다.
// 임시 구현은 이름·순위·걷는 시간·'대신 갈 곳 보기'·닫기만 그리는 작은 카드다.
import { View } from 'react-native';

import { Button, Card, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import type { CongestionEstimate, RecommendationResponse } from '~/lib/core/apiClient';
import type { RequiredAttribute } from '~/lib/core/travelContextTypes';

import { walkingMinutes, distanceM, type HomeFacility } from './homeModel';

/** 카드를 연 방식 — 웹 FacilityRecord.pickKind(+ 추천 1위로 자동으로 연 것). */
export type PickKind = 'recommended' | 'pin' | 'search' | 'place';

export interface RecommendationSheetSlotProps {
  /** 지금 열린 장소(지도 시설 — 웹 selectedFacility). */
  facility: HomeFacility;
  pickKind: PickKind;
  /**
   * 서버 추천 목록(POST /recommendations/by-type)에서 이 장소의 항목. 목록 밖(검색·핀으로 직접 연 곳)이면 null.
   * 카드는 이 값으로 사유·SPOT·대기·도착 영업 여부를 그린다(웹은 recToSpot(rec) 로 변환해 넘겼다).
   */
  recommendation: RecommendationResponse | null;
  /** 추천 목록에서의 순위(관심 없음·저장 제외, 1부터). 목록 밖이거나 '선택한 장소' 면 null — 웹 listRank. */
  rank: number | null;
  totalCandidates: number | null;
  /** 지도 위치(경주 밖·거부면 황리단길 중심). */
  userLocation: { lat: number; lng: number };
  /** 위 좌표가 정말 내 위치인가. */
  userLocationKnown: boolean;
  /** 추정 피드의 최신 값(60분 안만). 실측 '지금' 이 있으면 카드가 알아서 감춘다(lib/congestionEstimate). */
  congestionEstimate: CongestionEstimate | null;
  /** 걸려 있는 조건 칩 — 웹 cardConditions(✕ 로 풀 수 있다). 앱 홈은 ♿ 👶 실내만 둔다. */
  conditions: RequiredAttribute[];
  onRemoveCondition: (key: RequiredAttribute) => void;
  /** '대신 갈 곳 보기' — 직접 고른 장소(순위 밖)이고 대안을 고를 수 있는 종류일 때만 있다(웹 onSeeInstead). */
  onSeeInstead?: () => void;
  /** 이 카드를 접는다(웹은 지도 빈 곳을 누르면 selectedFacility=null). */
  onDismiss: () => void;
  /** 다음 추천으로(웹 handleReject·handlePutOff 뒤 동작). 다음이 없으면 undefined. */
  onAdvance?: () => void;
  /** 카드가 거절·저장한 장소 id 를 알려 주면 홈이 추천 목록과 핀 순위에서 뺀다. */
  onExcludeFacility: (facilityId: string) => void;
  /** 카드 높이가 바뀌면(3단 스냅) 홈이 지도 가려진 띠를 다시 계산한다. */
  onHeightChange?: (height: number) => void;
}

export function RecommendationSheetSlot(props: RecommendationSheetSlotProps) {
  const t = useT();
  const { facility, rank, userLocation, onSeeInstead, onDismiss } = props;
  const walk = walkingMinutes(distanceM(
    { latitude: userLocation.lat, longitude: userLocation.lng },
    { latitude: facility.latitude, longitude: facility.longitude },
  ));
  return (
    <Card
      className="gap-[8px]"
      onLayout={(e: { nativeEvent: { layout: { height: number } } }) => props.onHeightChange?.(e.nativeEvent.layout.height)}
    >
      <View className="flex-row items-start justify-between gap-[8px]">
        <View className="min-h-[44px] flex-1 justify-center">
          <Text className="text-[16px]" weight="bold" numberOfLines={2}>
            {facility.name}
          </Text>
          <Text className="text-[12px] text-muk-soft">
            {rank ? `#${rank}  ` : ''}
            {`🚶 ${walk}'`}
          </Text>
        </View>
        <Button variant="ghost" label={t('common.close')} onPress={onDismiss} />
      </View>
      {onSeeInstead ? (
        <Button variant="secondary" label={t('waiting.seeInstead')} accessibilityLabel={t('card.seeInsteadAria', { name: facility.name })} onPress={onSeeInstead} />
      ) : null}
    </Card>
  );
}
