// '이렇게 써 보세요' — 핵심 기능으로 바로 가는 줄(서비스 소개 히어로 아래 칸).
//
// 웹 원본: apps/web/components/guide/FeatureShortcuts.tsx, guide.module.css .shortcuts~.shortcutConsole(모바일 :475-496)
// (기준 커밋 0d145a1). 보일 줄은 featureShortcutRows.ts(앱에 없는 예측 지도·음성 비서는 숨김 — D6 ①),
// 콘솔 두 버튼은 운영 웹을 외부 브라우저로 연다(D7 ① — lib/core/consoleEntries).
import { Building2, ChevronRight, Compass, Landmark, RefreshCw, Store, type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Icon, Pressable, Text } from '~/components/ui';
import { useAccount } from '~/lib/core/account';
import { consoleEntryUrls, SHOW_CONSOLE_ENTRIES } from '~/lib/core/consoleEntries';
import { useT } from '~/lib/i18n/I18nProvider';
import { openExternalUrl } from '~/lib/platform/links';
import { colors } from '~/lib/theme/tokens';

import { appFeatureShortcuts, type FeatureShortcutKey } from './featureShortcutRows';
import { goHomeFromGuide } from './guideNav';

const ICONS: Record<FeatureShortcutKey, LucideIcon> = {
  // forecast·voice 는 앱에서 숨기지만(appFeatureShortcuts) 키 표는 웹과 같게 둔다.
  forecast: Compass,
  card: Compass,
  live: RefreshCw,
  voice: Compass,
  console: Building2,
};

/** 줄 머리 — 아이콘 상자 40 · 번호 13 · 이름 15/750 · 설명 13. */
function RowText({ keyName, index }: { keyName: FeatureShortcutKey; index: number }) {
  const t = useT();
  return (
    <>
      <View
        className="h-[40px] w-[40px] items-center justify-center rounded-xl"
        style={{ backgroundColor: 'rgba(193, 154, 62, 0.18)' }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon icon={ICONS[keyName]} size={20} color="gold-deep" />
      </View>
      <View className="min-w-0 flex-1 gap-[2px]">
        <View className="flex-row items-baseline gap-[7px]">
          <Text
            className="text-[13px] leading-[17.55px] text-gold-deep"
            weight="extrabold"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {index + 1}
          </Text>
          <Text className="min-w-0 shrink text-[15px] leading-[20.25px] text-muk" weight="bold" style={{ letterSpacing: -0.3 }}>
            {t(`featureMap.${keyName}.label`)}
          </Text>
        </View>
        <Text className="text-[13px] leading-[18.85px] text-muk-soft">{t(`featureMap.${keyName}.desc`)}</Text>
      </View>
    </>
  );
}

export function FeatureShortcuts({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { account } = useAccount();
  const rows = appFeatureShortcuts(SHOW_CONSOLE_ENTRIES);
  const urls = consoleEntryUrls(account);
  const consoles: { id: string; icon: LucideIcon; label: string; url: string }[] = [
    { id: 'merchant', icon: Store, label: t('nav.merchantConsole'), url: urls.merchant },
    { id: 'admin', icon: Landmark, label: t('nav.adminDashboard'), url: urls.admin },
  ];

  return (
    <View
      className="rounded-[22px] border border-line p-[14px]"
      style={{ backgroundColor: 'rgba(250, 245, 236, 0.94)', boxShadow: '0px 24px 80px rgba(43, 35, 32, 0.10)' }}
    >
      <View className="flex-row flex-wrap items-baseline justify-between px-[6px] pb-[14px] pt-[2px]" style={{ rowGap: 4, columnGap: 12 }}>
        <Text className="text-[20px] leading-[26px] text-muk" weight="extrabold" accessibilityRole="header" style={{ letterSpacing: -0.6 }}>
          {t('featureMap.title')}
        </Text>
        <Text className="text-[13px] leading-[19.5px] text-muk-soft">{t('featureMap.hint')}</Text>
      </View>
      <View className="gap-[8px]">
        {rows.map((key, index) => {
          if (key === 'console') {
            return (
              <View
                key={key}
                className="min-h-[68px] flex-row flex-wrap items-center gap-[12px] rounded-[18px] border border-line bg-hanji-deep px-[12px] py-[10px]"
              >
                <RowText keyName={key} index={index} />
                <View className="w-full flex-row flex-wrap gap-[6px] pl-[52px]">
                  {consoles.map((c) => (
                    <Pressable
                      key={c.id}
                      accessibilityRole="link"
                      onPress={() => {
                        onNavigate?.();
                        void openExternalUrl(c.url);
                      }}
                      hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
                      className="min-h-[32px] flex-row items-center gap-[6px] rounded-full bg-hanji px-[12px] py-[5px]"
                      style={{ borderWidth: 1.5, borderColor: colors.line }}
                    >
                      <Icon icon={c.icon} size={15} color="gold-deep" />
                      <Text className="text-[13px] leading-[19.5px] text-muk" weight="bold" numberOfLines={1}>
                        {c.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            );
          }
          return (
            <Pressable
              key={key}
              accessibilityRole="link"
              accessibilityLabel={`${t(`featureMap.${key}.label`)}, ${t(`featureMap.${key}.desc`)}`}
              onPress={() => {
                onNavigate?.();
                goHomeFromGuide();
              }}
              className="min-h-[68px] flex-row items-center gap-[12px] rounded-[18px] border border-line bg-hanji-deep px-[12px] py-[10px]"
            >
              <RowText keyName={key} index={index} />
              <Icon icon={ChevronRight} size={18} color="muk-soft" />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
