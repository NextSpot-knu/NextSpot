// 운영자 공지 배너 — 웹 apps/web/components/shell/PublicSettingsProvider.tsx:101-127(G2-33, R1 정정).
// 화면 위에 겹쳐 띄운다(레이아웃을 밀지 않는다). 루트 app/_layout 의 ProvidersWithLabels 가 renderNotice 로 넘긴다.
//   카드: rounded-2xl border-gold/40 bg-white/95 px-3 py-2.5 shadow-[0_2px_14px_rgba(43,35,32,0.14)] backdrop-blur max-w-2xl gap-2
//   Megaphone 15 gold-deep mt-0.5 · 글 12 medium muk leading-snug · 닫기 X 14 muk-soft(상자 22, 탭 영역 44 는 hitSlop)
import { Megaphone, X } from 'lucide-react-native';
import { Platform, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '~/components/ui/Icon';
import { IconButton } from '~/components/ui/IconButton';
import { Text } from '~/components/ui/Text';
import type { PublicSettingsLabels } from '~/lib/core/publicSettings';

/** 웹 max-w-2xl. */
const MAX_WIDTH = 672;
/** 웹 shadow-[0_2px_14px_rgba(43,35,32,0.14)] — 토큰 shadows 에 같은 값이 없다(요청 목록). */
const SHADOW = '0px 2px 14px rgba(43, 35, 32, 0.14)';
/** 웹 backdrop-blur(8px) — 웹 빌드만(네이티브는 95% 바탕이라 흐림 없이도 읽힌다). */
const WEB_BLUR = Platform.OS === 'web' ? ({ backdropFilter: 'blur(8px)' } as unknown as ViewStyle) : null;

export type AppNoticeBannerProps = {
  noticeText: string;
  labels: PublicSettingsLabels;
  onDismiss: () => void;
};

export function AppNoticeBanner({ noticeText, labels, onDismiss }: AppNoticeBannerProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 px-[12px]"
      style={{ top: insets.top + 8 }}
    >
      <View
        role="status"
        accessibilityLiveRegion="polite"
        className="w-full flex-row items-start gap-[8px] self-center rounded-2xl border border-gold/40 bg-white/95 px-[12px] py-[10px]"
        style={[{ maxWidth: MAX_WIDTH, boxShadow: SHADOW }, WEB_BLUR]}
      >
        <View style={{ marginTop: 2 }}>
          <Icon icon={Megaphone} size={15} color="gold-deep" />
        </View>
        <Text weight="medium" className="min-w-0 flex-1 text-[12px] leading-[16.5px] text-muk">
          {noticeText}
        </Text>
        <View style={{ marginRight: -4 }}>
          <IconButton icon={X} size="sm" box={22} color="muk-soft" accessibilityLabel={labels.dismiss} onPress={onDismiss} />
        </View>
      </View>
    </View>
  );
}
