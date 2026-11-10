import { View } from 'react-native';

import type { PhotoCredit } from '~/features/explore/port/photoCredit';
import { useT } from '~/lib/i18n/I18nProvider';
import { openExternalUrl } from '~/lib/platform/links';

import { Pressable } from './Pressable';
import { Text } from './Text';

export type CreditLineProps = {
  /** creditForDisplayedPhoto 의 결과 — 무엇을 붙일지는 그 판정 한 곳이 정하고, 여기서는 그리기만 한다. */
  credit: PhotoCredit;
  /** 좁은 카드(대기 보드 3열): 작가 한 줄 + 라이선스 한 줄, 최소 24. 기본은 한 줄 24. */
  stacked?: boolean;
  /** 자리 여백(웹 호출부 음수 여백 대신 부르는 쪽이 정한다). */
  className?: string;
};

// 웹 components/PhotoCreditLink.tsx 의 이식 — 10px/14px muk-soft 밑줄, 글자 줄 14 + 위아래 5 누르는 자리 = 24(WCAG 2.5.8).
// 누르는 자리는 보이는 글자 폭만큼(self-start). 경주시 줄은 이 줄이 유일한 출처라 말줄임하지 않고 접힌다.
const TEXT = 'text-[10px] leading-[14px] text-muk-soft';

export function CreditLine({ credit, stacked = false, className = '' }: CreditLineProps) {
  const t = useT();
  const linked = credit.sourceUrl.length > 0;
  const underline = linked ? 'underline' : '';
  const open = () => void openExternalUrl(credit.sourceUrl);

  if (credit.kind === 'city') {
    const label = t('common.cityPhotoCredit');
    const box = stacked ? 'min-h-[24px] self-start' : 'min-h-[24px] self-start justify-center py-[5px]';
    const text = <Text className={`${TEXT} ${underline}`}>{label}</Text>;
    return linked ? (
      <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={open} noFeedback className={`${box} ${className}`}>
        {text}
      </Pressable>
    ) : (
      <View className={`${box} ${className}`}>{text}</View>
    );
  }

  const full = credit.license ? `${credit.label} · ${credit.license}` : credit.label;
  const body = stacked ? (
    <View className="min-h-[24px] self-start">
      <Text className={`${TEXT} ${underline}`} numberOfLines={1}>
        {credit.label}
      </Text>
      {credit.license ? (
        <Text className={`${TEXT} ${underline}`} numberOfLines={1}>
          {credit.license}
        </Text>
      ) : null}
    </View>
  ) : (
    <View className="h-[24px] flex-row items-center self-start py-[5px]">
      <Text className={`${TEXT} ${underline} shrink`} numberOfLines={1}>
        {credit.label}
      </Text>
      {credit.license ? <Text className={`${TEXT} ${underline}`}>{` · ${credit.license}`}</Text> : null}
    </View>
  );
  return linked ? (
    <Pressable accessibilityRole="link" accessibilityLabel={full} onPress={open} noFeedback className={`self-start ${className}`}>
      {body}
    </Pressable>
  ) : (
    <View accessibilityLabel={full} className={`self-start ${className}`}>
      {body}
    </View>
  );
}
