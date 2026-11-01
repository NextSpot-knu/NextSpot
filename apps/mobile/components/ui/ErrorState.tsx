import { RotateCw } from 'lucide-react-native';
import { ActivityIndicator } from 'react-native';

import { colors } from '~/lib/theme/tokens';

import { Card } from './Card';
import { cn } from './cn';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';

export type ErrorStateProps = {
  /** 무엇이 안 됐는지 한 문장(해요체). 예: t('course.loadFailed'). */
  message: string;
  onRetry: () => void;
  /** 다시 시도 버튼 글자 — 웹과 같은 키 t('common.retry') 를 넘긴다(이 컴포넌트는 문구를 갖지 않는다). */
  retryLabel: string;
  /** 다시 불러오는 중 — 버튼이 돌림표로 바뀌고 눌리지 않는다. */
  retrying?: boolean;
  className?: string;
};

const ERROR_BORDER = 'rgba(193, 85, 59, 0.25)'; // colors.terracotta(#c1553b) 25%

/**
 * 조회 실패를 빈 상태와 구분해서 보여 주는 블록(웹 components/ErrorState.tsx).
 * 웹과 다른 점: 다시 시도 버튼 바탕을 금(#c19a3e, 흰 글자 3.7:1)에서 금 진(4.5:1 이상)으로, 높이를 44pt 로.
 */
export function ErrorState({ message, onRetry, retryLabel, retrying = false, className }: ErrorStateProps) {
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
        className="min-h-[44px] flex-row items-center gap-[6px] rounded-full bg-gold-deep px-[18px]"
      >
        {retrying ? (
          <ActivityIndicator size="small" color={colors.white} />
        ) : (
          <Icon icon={RotateCw} size="sm" color="white" />
        )}
        <Text className="text-[13px] text-white" weight="bold">
          {retryLabel}
        </Text>
      </Pressable>
    </Card>
  );
}
