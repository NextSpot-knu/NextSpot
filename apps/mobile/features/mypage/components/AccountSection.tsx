// 마이페이지 계정 섹션 — 웹 components/AccountSection.tsx(docs/archive/OAUTH_PLAN.md F5)의 앱판.
//  · 연결된 계정 : 연결된 프로바이더·이메일 뱃지
//  · 게스트      : '계속하기' 유도 + 프로바이더 버튼. 버튼은 visibleProviders(Platform.OS) 만 — iOS 는 없고(계획 M3) 안드로이드는 구글만.
//                  보일 버튼이 없으면 섹션 전체를 그리지 않는다(iOS 게스트에게 빈 유도 문구가 남지 않게).
import { Check, Link2 } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { Card, Icon, Pressable, Text, toast } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';

import { visibleProviders, type OAuthProvider } from '../accountCore';
import { router } from 'expo-router';
import { continueWithProvider, type Profile } from '../actions';

const PROVIDER_LABEL: Record<OAuthProvider, string> = { kakao: 'auth.providerKakao', google: 'auth.providerGoogle' };
const CONTINUE_LABEL: Record<OAuthProvider, string> = { kakao: 'auth.continueKakao', google: 'auth.continueGoogle' };

export function AccountSection({ profile }: { profile: Profile }) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  if (profile.isMember) {
    const badge = 'self-start rounded-full border border-jade/30 bg-jade/10 px-[12px] py-[6px]';
    return (
      <Card className="mb-[16px] gap-[12px]">
        <View className="flex-row items-center gap-[8px]">
          <Icon icon={Check} size="lg" color="jade" />
          <Text className="text-base" weight="bold" accessibilityRole="header">{t('auth.linkedTitle')}</Text>
        </View>
        <View className="flex-row flex-wrap gap-[8px]">
          {profile.providers.length === 0 && profile.email ? (
            <View className={badge}>
              <Text className="text-sm text-jade" weight="semibold">{t('auth.linkedEmail', { email: profile.email })}</Text>
            </View>
          ) : null}
          {profile.providers.map((p) => (
            <View key={p} className={badge}>
              <Text className="text-sm text-jade" weight="semibold">{t('auth.linkedVia', { provider: t(PROVIDER_LABEL[p]) })}</Text>
            </View>
          ))}
        </View>
      </Card>
    );
  }

  const providers = visibleProviders(Platform.OS);
  if (providers.length === 0) return null;

  const onContinue = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    const { error, delivered } = await continueWithProvider(provider);
    setBusy(false);
    if (delivered) router.replace('/auth/callback');
    else if (error) toast.error(t('auth.linkError'));
  };

  return (
    <Card className="mb-[16px] gap-[12px] border-gold/35 bg-gold/10">
      <View className="gap-[4px]">
        <View className="flex-row items-center gap-[8px]">
          <Icon icon={Link2} size="lg" color="gold-deep" />
          <Text className="text-base" weight="bold" accessibilityRole="header">{t('auth.guestTitle')}</Text>
        </View>
        <Text className="text-xs leading-[18px] text-muk-soft">{t('auth.guestDesc')}</Text>
      </View>
      <View className="gap-[8px]">
        {providers.map((p) => (
          <Pressable
            key={p}
            accessibilityRole="button"
            accessibilityLabel={t(CONTINUE_LABEL[p])}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={() => { void onContinue(p); }}
            className={`min-h-[48px] items-center justify-center rounded-xl border px-[12px] py-[12px] ${p === 'kakao' ? 'border-transparent bg-[#FEE500]' : 'border-line bg-white'} ${busy ? 'opacity-50' : ''}`}
          >
            <Text className={`text-sm ${p === 'kakao' ? 'text-[#191600]' : 'text-muk'}`} weight="bold" numberOfLines={2}>
              {t(CONTINUE_LABEL[p])}
            </Text>
          </Pressable>
        ))}
      </View>
    </Card>
  );
}
