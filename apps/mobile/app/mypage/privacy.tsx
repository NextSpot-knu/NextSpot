// 개인정보 처리 안내 — 웹 app/mypage/privacy/page.tsx 의 같은 privacy.* 문구를 앱 화면으로. 공개 웹 주소 링크를 함께 둔다
// (스토어 개인정보 처리방침 URL 과 같은 내용을 앱 밖에서도 읽을 수 있게).
import { BarChart3, ExternalLink, FileText, HardDrive, Mail, Scale, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Button, Card, Icon, Screen, Text } from '~/components/ui';
import { openExternalUrl } from '~/lib/platform/links';
import { WEB_ORIGIN } from '~/lib/platform/shareUrls';
import { useT } from '~/lib/i18n/I18nProvider';

// 이 안내문을 마지막으로 고친 날 — 웹 PRIVACY_UPDATED_AT 과 같이 바꾼다.
const PRIVACY_UPDATED_AT = '2026-10-31';

const SECTIONS: readonly { id: string; icon: LucideIcon; titleKey: string; bodyKey: string }[] = [
  { id: 'collect', icon: FileText, titleKey: 'privacy.collectTitle', bodyKey: 'privacy.collectBody' },
  { id: 'storage', icon: HardDrive, titleKey: 'privacy.storageTitle', bodyKey: 'privacy.storageBody' },
  { id: 'usage', icon: BarChart3, titleKey: 'privacy.usageTitle', bodyKey: 'privacy.usageBody' },
  { id: 'abuse', icon: ShieldAlert, titleKey: 'privacy.abuseTitle', bodyKey: 'privacy.abuseBody' },
  { id: 'thirdParty', icon: ShieldCheck, titleKey: 'privacy.thirdPartyTitle', bodyKey: 'privacy.thirdPartyBody' },
  { id: 'terms', icon: Scale, titleKey: 'privacy.termsTitle', bodyKey: 'privacy.termsBody' },
  { id: 'contact', icon: Mail, titleKey: 'privacy.contactTitle', bodyKey: 'privacy.contactBody' },
];

const PRIVACY_WEB_URL = `${WEB_ORIGIN}/mypage/privacy`;

export default function PrivacyScreen() {
  const t = useT();
  return (
    <Screen scroll edges={['left', 'right', 'bottom']} contentClassName="px-[16px] py-[16px] gap-[16px]">
      <Text className="px-[4px] text-sm leading-[22px] text-muk-soft">{t('privacy.intro')}</Text>
      {SECTIONS.map((s) => (
        <Card key={s.id} className="gap-[10px]">
          <View className="flex-row items-center gap-[12px]">
            <View className="h-[36px] w-[36px] items-center justify-center rounded-full bg-gold/10">
              <Icon icon={s.icon} size="lg" color="gold-deep" />
            </View>
            <Text className="min-w-0 flex-1" weight="bold" accessibilityRole="header">{t(s.titleKey)}</Text>
          </View>
          <Text className="text-sm leading-[22px] text-muk-soft">{t(s.bodyKey)}</Text>
        </Card>
      ))}
      <Button
        variant="secondary"
        icon={ExternalLink}
        label={t('app.mypage.privacyWebLink')}
        accessibilityHint={PRIVACY_WEB_URL}
        block
        onPress={() => { void openExternalUrl(PRIVACY_WEB_URL); }}
      />
      <Text className="px-[16px] py-[8px] text-center text-xs text-muk-soft">{t('privacy.footer', { date: PRIVACY_UPDATED_AT })}</Text>
    </Screen>
  );
}
