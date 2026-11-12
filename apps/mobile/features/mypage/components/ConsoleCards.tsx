// 콘솔 입구 카드 — 웹 마이페이지의 MerchantConsoleEntry · AdminConsoleEntry · ConsolePreviewEntry · 역할 변경 신청 카드와 같은 모양(D7 ①, G5b-08·11).
// 누르면 앱 안 이동 대신 시스템 브라우저로 운영 웹을 연다(openExternalUrl) — 그래서 웹의 꺾쇠 자리에는 ExternalLink 하나만 둔다.
import { ExternalLink, Eye, Hourglass, ShieldCheck, Store, UserCog, type LucideIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card, Gradient, Icon, Pressable, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { openExternalUrl } from '~/lib/platform/links';

const open = (url: string) => () => { void openExternalUrl(url); };

/** 사장님 콘솔 카드(그라데이션 merchantCard · 44 타일) — 설정(`compact`: 40 원 · 간격 12)에서도 쓴다. */
export function MerchantLinkCard({ url, compact = false }: { url: string; compact?: boolean }) {
  const t = useT();
  return (
    <Card
      onPress={open(url)}
      accessibilityLabel={`${t('console.openMerchant')}. ${t('console.openMerchantDesc')}. ${t('app.mypage.openOnWeb')}`}
      padded={false}
      className="overflow-hidden rounded-3xl border-gold/35 bg-hanji"
      style={{ padding: 20 }}
    >
      <Gradient name="merchantCard" style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View className="flex-row items-center justify-between gap-[16px]">
        <View className="min-w-0 flex-1 flex-row items-center" style={{ gap: compact ? 12 : 16 }}>
          <View
            className={compact
              ? 'h-[40px] w-[40px] items-center justify-center rounded-full bg-gold/15'
              : 'h-[44px] w-[44px] items-center justify-center rounded-2xl bg-gold/15'}
          >
            <Icon icon={Store} size={compact ? 20 : 22} color="gold-deep" />
          </View>
          <View className="min-w-0 flex-1">
            <Text weight="bold">{t('console.openMerchant')}</Text>
            <Text className={`text-xs text-muk-soft ${compact ? '' : 'mt-[2px]'}`}>{t('console.openMerchantDesc')}</Text>
          </View>
        </View>
        <Icon icon={ExternalLink} size={18} color="gold-deep" />
      </View>
    </Card>
  );
}

/** 제목 줄에 아이콘이 들어가는 카드(관제 · 역할 변경 신청 · 심사중) — rounded-3xl p-5. */
function TitledLinkCard({
  url, icon, title, desc, surface, label,
}: { url: string; icon: LucideIcon; title: string; desc: string; surface: string; label: string }) {
  return (
    <Card
      onPress={open(url)}
      accessibilityLabel={label}
      padded={false}
      className={`flex-row items-center justify-between gap-[12px] rounded-3xl ${surface}`}
      style={{ padding: 20 }}
    >
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-[8px]">
          <Icon icon={icon} size={17} color="gold-deep" />
          <Text className="min-w-0 shrink" weight="bold">{title}</Text>
        </View>
        <Text className="mt-[2px] text-xs text-muk-soft">{desc}</Text>
      </View>
      <Icon icon={ExternalLink} size={18} color="muk-soft" />
    </Card>
  );
}

export function AdminLinkCard({ url }: { url: string }) {
  const t = useT();
  return (
    <TitledLinkCard
      url={url}
      icon={ShieldCheck}
      surface="border-gold/30 bg-gold/5"
      title={t('console.openAdmin')}
      desc={t('console.openAdminDesc')}
      label={`${t('console.openAdmin')}. ${t('console.openAdminDesc')}. ${t('app.mypage.openOnWeb')}`}
    />
  );
}

export function RoleRequestCard({ pending, url }: { pending: boolean; url: string }) {
  const t = useT();
  const title = t(pending ? 'account.roleRequestPendingEntry' : 'account.roleRequestEntry');
  const desc = t(pending ? 'account.roleRequestPendingEntryDesc' : 'account.roleRequestEntryDesc');
  return (
    <TitledLinkCard
      url={url}
      icon={pending ? Hourglass : UserCog}
      surface={pending ? 'border-gold/40 bg-gold/5' : 'border-line bg-white'}
      title={title}
      desc={desc}
      label={`${title}. ${desc}. ${t('app.mypage.openOnWeb')}`}
    />
  );
}

/**
 * 콘솔 미리보기 — 사장님·관리자 권한이 없는 사람에게 두 콘솔의 예시 화면(?demo=1)을 연다(웹 ConsolePreviewEntry).
 * 버튼 글자는 웹처럼 줄을 바꾼다(grid-cols-2 · 한 줄 제한 없음 — en 'Operations dashboard' 가 두 줄, G5b-08).
 */
export function ConsolePreviewCard({ merchantUrl, adminUrl }: { merchantUrl: string; adminUrl: string }) {
  const t = useT();
  const button = 'min-h-[44px] flex-1 flex-row items-center justify-center gap-[6px] rounded-xl border border-gold/40 bg-white px-[12px]';
  return (
    <View className="rounded-3xl border border-gold/30 bg-gold/5" style={{ padding: 20 }}>
      <View className="flex-row items-center gap-[8px]">
        <Icon icon={Eye} size={17} color="gold-deep" />
        <Text weight="bold" accessibilityRole="header">{t('demo.previewTitle')}</Text>
      </View>
      <Text className="mt-[2px] text-xs text-muk-soft">{t('demo.previewDesc')}</Text>
      <View className="mt-[12px] flex-row gap-[8px]">
        <Pressable accessibilityRole="link" accessibilityLabel={t('demo.previewMerchant')} className={button} onPress={open(merchantUrl)}>
          <Icon icon={Store} size={16} color="gold-deep" />
          <Text className="shrink text-center text-sm text-gold-deep" weight="bold">{t('demo.previewMerchant')}</Text>
        </Pressable>
        <Pressable accessibilityRole="link" accessibilityLabel={t('demo.previewAdmin')} className={button} onPress={open(adminUrl)}>
          <Icon icon={ShieldCheck} size={16} color="gold-deep" />
          <Text className="shrink text-center text-sm text-gold-deep" weight="bold">{t('demo.previewAdmin')}</Text>
        </Pressable>
      </View>
    </View>
  );
}
