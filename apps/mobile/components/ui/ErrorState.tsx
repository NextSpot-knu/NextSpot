import { useEffect } from 'react';
import { AccessibilityInfo, ActivityIndicator } from 'react-native';

import { colors } from '~/lib/theme/tokens';

import { Card } from './Card';
import { cn } from './cn';
import { Pressable } from './Pressable';
import { Text } from './Text';

export type ErrorStateProps = {
  /** 무엇이 안 됐는지 한 문장(해요체). 예: t('map.parkingLoadFailed'). */
  message: string;
  onRetry: () => void;
  /** 다시 시도 버튼 글자 — 웹과 같은 키 t('common.retry') 를 넘긴다(이 컴포넌트는 문구를 갖지 않는다). */
  retryLabel: string;
  /** 다시 불러오는 중 — 버튼이 돌림표를 보이고 눌리지 않는다. */
  retrying?: boolean;
  className?: string;
};

const ERROR_BORDER = 'rgba(193, 85, 59, 0.25)'; // colors.terracotta(#c1553b) 25%
// 웹 버튼은 글자 12/16 + py-2 라 보이는 높이 32 — 위아래 6 을 탭 영역으로 넓혀 44 를 채운다(웹 .tap-target 과 같은 뜻).
const RETRY_HIT_SLOP = { top: 6, bottom: 6, left: 0, right: 0 } as const;

/**
 * 알림 낭독 — role="alert" 만으로는 VoiceOver·TalkBack 이 나타날 때 읽지 않는다(웹 aria role=alert 와 다르다).
 * 메시지가 바뀔 때만 다시 알린다. 대기 오류 같은 화면 전용 오류 블록(BoardError)도 같이 쓴다.
 */
export function useAnnounce(message: string | null | undefined): void {
  useEffect(() => {
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
}

/**
 * 조회 실패를 빈 상태와 구분해서 보여 주는 블록(웹 components/ErrorState.tsx와 같은 모양).
 * 아이콘 없는 알약(px 16·py 8, 12px bold), 바탕은 금 단색 토큰 button-gold(흰 글자 4.5:1 이상 — 결정 D2).
 * 대기 보드 오류는 웹도 화면 전용이라 이 컴포넌트에 variant 를 두지 않는다.
 */
export function ErrorState({ message, onRetry, retryLabel, retrying = false, className }: ErrorStateProps) {
  useAnnounce(message);
  return (
    <Card
      className={cn('items-center gap-[12px]', className)}
      padded={false}
      // 테두리 주칠 25%(웹 border-terracotta/25). Card 의 border-line 과 클래스로 겨루지 않게 style 로 준다.
      style={{ padding: 32, borderColor: ERROR_BORDER }}
      accessibilityRole="alert"
    >
      <Text className="text-[30px] leading-[36px]" accessibilityElementsHidden importantForAccessibility="no">
        ⚠️
      </Text>
      <Text className="text-center text-[14px] leading-[20px]" weight="semibold">
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
        accessibilityState={{ busy: retrying, disabled: retrying }}
        disabled={retrying}
        onPress={onRetry}
        hitSlop={RETRY_HIT_SLOP}
        className="flex-row items-center justify-center gap-[6px] rounded-full bg-button-gold"
        style={{ paddingHorizontal: 16, paddingVertical: 8 }}
      >
        {retrying ? <ActivityIndicator size="small" color={colors.white} /> : null}
        <Text className="text-[12px] leading-[16px] text-white" weight="bold">
          {retryLabel}
        </Text>
      </Pressable>
    </Card>
  );
}
