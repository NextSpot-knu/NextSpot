// 뒤로 원 — 웹 대기·대안·코스 맨 위의 44px 흰 원(`w-11 h-11 rounded-full bg-white/90 border border-line` + ArrowLeft 18).
// 목적지는 모두 지도(웹 /main = 앱 홈 '/'). 라벨은 화면마다 다르니(waiting.backAria · recommend.backToMap · course.backToMap) 받는다.
// 자리(코스의 지도 위 absolute top/left 16 등)는 부르는 쪽이 style 로 준다.
import type { StyleProp, ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';

import { cn } from './cn';
import { Icon } from './Icon';
import { Pressable } from './Pressable';

export type BackCircleButtonProps = {
  /** 필수 — 글자가 없다(예: t('waiting.backAria')). */
  accessibilityLabel: string;
  /** 기본 router.navigate('/'). */
  onPress?: () => void;
  /** 지도 위에 떠 있는 코스 모양 — 그림자 0.15(그 밖 0.1). */
  floating?: boolean;
  /** 웹 코스는 <Link>, 대기·대안은 <button>. */
  accessibilityRole?: 'button' | 'link';
  className?: string;
  style?: StyleProp<ViewStyle>;
};

export function BackCircleButton({
  accessibilityLabel,
  onPress,
  floating = false,
  accessibilityRole = 'button',
  className,
  style,
}: BackCircleButtonProps) {
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress ?? (() => router.navigate('/'))}
      className={cn('h-[44px] w-[44px] items-center justify-center rounded-full border border-line bg-white/90', className)}
      style={[{ boxShadow: floating ? '0px 2px 10px rgba(43, 35, 32, 0.15)' : '0px 2px 10px rgba(43, 35, 32, 0.1)' }, style]}
    >
      <Icon icon={ArrowLeft} size={18} color="muk" />
    </Pressable>
  );
}
