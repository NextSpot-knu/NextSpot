// 개인정보 처리 안내 — 앱판. 웹 app/mypage/privacy/page.tsx 의 privacy.* 중 앱에도 맞는 절만 쓰고, 웹 전용 문장
// (브라우저 저장소 · Do Not Track · Cloudflare Turnstile)은 앱 전용 app.privacy.* 로 바꿨다. 위치정보 · 외부 AI ·
// 처리 위탁과 국외 이전 · 보관 기간과 파기 · 데이터 삭제 · 만 14세 미만 절을 더했다(위치 동의 화면의 '보관 기간과
// 처리 방법은 개인정보 처리방침에서 안내해요' 약속). 문안은 초안 — 법무 검토 전(docs/MOBILE_PRIVACY_DRAFT.md).
// '웹에서 전체 안내 보기' 버튼은 숨겼다(D18 — 더 짧은 웹을 '전체'라 가리키는 모양이라, 웹 문안을 법무 검토 초안에 맞출 때까지). 문안은 바꾸지 않는다(L1).
import {
  BarChart3,
  Clock,
  FileText,
  Globe2,
  HardDrive,
  Mail,
  MapPin,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Icon, Text } from '~/components/ui';
import { SubScreen } from '~/features/mypage/components/parts';
import { LocationTermsModal } from '~/features/onboarding/LocationConsentView';
import { useT } from '~/lib/i18n/I18nProvider';

// 이 안내문을 마지막으로 고친 날.
const PRIVACY_UPDATED_AT = '2026-11-02';

const SECTIONS: readonly { id: string; icon: LucideIcon; titleKey: string; bodyKey: string }[] = [
  { id: 'collect', icon: FileText, titleKey: 'privacy.collectTitle', bodyKey: 'app.privacy.collectBody' },
  { id: 'location', icon: MapPin, titleKey: 'app.privacy.locationTitle', bodyKey: 'app.privacy.locationBody' },
  { id: 'ai', icon: Sparkles, titleKey: 'app.privacy.aiTitle', bodyKey: 'app.privacy.aiBody' },
  { id: 'storage', icon: HardDrive, titleKey: 'privacy.storageTitle', bodyKey: 'app.privacy.storageBody' },
  { id: 'usage', icon: BarChart3, titleKey: 'privacy.usageTitle', bodyKey: 'app.privacy.usageBody' },
  { id: 'abuse', icon: ShieldAlert, titleKey: 'privacy.abuseTitle', bodyKey: 'privacy.abuseBody' },
  { id: 'thirdParty', icon: ShieldCheck, titleKey: 'privacy.thirdPartyTitle', bodyKey: 'app.privacy.thirdPartyBody' },
  { id: 'processors', icon: Globe2, titleKey: 'app.privacy.processorsTitle', bodyKey: 'app.privacy.processorsBody' },
  { id: 'retention', icon: Clock, titleKey: 'app.privacy.retentionTitle', bodyKey: 'app.privacy.retentionBody' },
  { id: 'deletion', icon: Trash2, titleKey: 'app.privacy.deletionTitle', bodyKey: 'app.privacy.deletionBody' },
  { id: 'children', icon: UserRound, titleKey: 'app.privacy.childrenTitle', bodyKey: 'app.privacy.childrenBody' },
  { id: 'terms', icon: Scale, titleKey: 'privacy.termsTitle', bodyKey: 'privacy.termsBody' },
  { id: 'contact', icon: Mail, titleKey: 'privacy.contactTitle', bodyKey: 'privacy.contactBody' },
];

export default function PrivacyScreen() {
  const t = useT();
  const [termsOpen, setTermsOpen] = useState(false);
  return (
    <SubScreen glow="left" topGap={0}>
      <Text className="px-[4px] text-sm leading-[22.75px] text-muk-soft">{t('privacy.intro')}</Text>
      {SECTIONS.map((s) => (
        <Card key={s.id} padded={false} className="rounded-3xl" style={{ padding: 20 }}>
          <View className="mb-[10px] flex-row items-center gap-[12px]">
            <View className="h-[36px] w-[36px] items-center justify-center rounded-full bg-gold/10">
              <Icon icon={s.icon} size={18} color="gold-deep" />
            </View>
            <Text className="min-w-0 flex-1" weight="bold" accessibilityRole="header">{t(s.titleKey)}</Text>
          </View>
          <Text className="text-sm leading-[22.75px] text-muk-soft">{t(s.bodyKey)}</Text>
          {s.id === 'location' ? (
            <Button variant="ghost" label={t('app.privacy.locationTermsLink')} onPress={() => setTermsOpen(true)} />
          ) : null}
        </Card>
      ))}
      <Text className="px-[16px] py-[8px] text-center text-xs text-muk-soft/80">{t('privacy.footer', { date: PRIVACY_UPDATED_AT })}</Text>
      <LocationTermsModal open={termsOpen} onClose={() => setTermsOpen(false)} />
    </SubScreen>
  );
}
