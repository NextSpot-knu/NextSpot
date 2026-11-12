// 자유 입력 칸 위에 두는 외부 AI 전송 안내 + 처음 쓸 때의 허용 묻기(App Store 5.1.2(i) — 알리고 명시적으로 허락받기).
//   · 아직 안 정함: 받는 곳·목적 안내 + '허용 안 함' · '허용' 두 버튼. 고르기 전에는 입력 칸을 쓰지 않는다(부모가 allowed 로 막는다).
//   · 허용함: 한 줄 안내(보낼 때마다 무엇이 어디로 가는지 보이게).
//   · 허용 안 함: 입력 칸이 꺼진 이유 + 설정으로 가는 링크. 칩·선택지는 그대로 쓴다.
import { useRouter, type Href } from 'expo-router';
import { Sparkles } from 'lucide-react-native';
import { View } from 'react-native';

import { Button, Icon, Pressable, Text, cn, toast } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';

import { useAiConsent } from './useAiConsent';

export const AI_SETTINGS_ROUTE = '/mypage/settings';

export function AiConsentNotice({ className }: { className?: string }) {
  const t = useT();
  const router = useRouter();
  const { status, allow, decline } = useAiConsent();

  if (status === 'granted') {
    return (
      <View className={cn('flex-row items-start gap-[6px]', className)} accessibilityLiveRegion="polite">
        <Icon icon={Sparkles} size="xs" color="muk-soft" />
        <Text className="flex-1 text-[11px] leading-[15px] text-muk-soft">{t('app.aiConsent.notice')}</Text>
      </View>
    );
  }

  if (status === 'declined') {
    return (
      <View className={cn('gap-[4px] rounded-xl bg-hanji-deep px-[12px] py-[8px]', className)} accessibilityLiveRegion="polite">
        <Text className="text-[12px] leading-[17px] text-muk-soft">{t('app.aiConsent.declinedHint')}</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('app.aiConsent.openSettings')}
          onPress={() => router.push(AI_SETTINGS_ROUTE as Href, { withAnchor: true })}
          className="min-h-[44px] justify-center self-start"
        >
          <Text className="text-[12px] leading-[17px] text-gold-deep" weight="semibold">{t('app.aiConsent.openSettings')}</Text>
        </Pressable>
      </View>
    );
  }

  const choose = (granted: boolean) => {
    const ok = granted ? allow() : decline();
    if (!ok) toast.error(t('common.error'));
  };

  return (
    <View className={cn('gap-[8px] rounded-xl border border-gold/40 bg-gold/10 px-[12px] py-[10px]', className)}>
      <View className="flex-row items-start gap-[6px]">
        <Icon icon={Sparkles} size="sm" color="gold-deep" />
        <Text className="flex-1 text-[13px] leading-[18px] text-muk" weight="bold" accessibilityRole="header">
          {t('app.aiConsent.promptTitle')}
        </Text>
      </View>
      <Text className="text-[12px] leading-[17px] text-muk-soft">{t('app.aiConsent.promptBody')}</Text>
      <View className="flex-row gap-[8px]">
        <Button className="flex-1" variant="secondary" label={t('app.aiConsent.decline')} onPress={() => choose(false)} />
        <Button className="flex-1" label={t('app.aiConsent.allow')} onPress={() => choose(true)} />
      </View>
    </View>
  );
}
