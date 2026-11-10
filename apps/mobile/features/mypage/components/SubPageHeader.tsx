// 마이 하위 화면 머리 — 웹 app/mypage/{coupons,impact,lab,privacy,settings}/page.tsx 의 `<header className="flex items-center gap-3 p-5">`
// (ChevronLeft 24 muk-soft + h1 text-xl bold tracking-wide) 와 inquiries·support 의 `p-5 border-b` + ArrowLeft + `mr-4`(G5b-02).
// 높이 68(20 + 28 + 20), 내 문의·고객지원은 테두리까지 69.
//
// · 뒤로 = 늘 마이 첫 화면(웹 router.push(MYPAGE_BACK)) — 딥링크로 들어와도 홈이 아니라 /mypage(G5b-02 2번). 하드웨어 뒤로는 Stack pop.
//   router.dismissTo: 같은 Stack 의 index 까지 pop(없으면 이 화면을 index 로 바꿔치기). navigate 는 pop 없이 index 를 하나 더 쌓는다(B6 검토 H1).
// · 두 가지 자리: 고정 머리(Stack 의 header — 위 안전 영역을 여기서 비운다, insetTop) / 스크롤 머리(내 문의·고객지원 —
//   화면 스크롤 내용 맨 앞에 두어 함께 올라간다, G5b-R02 — 위 안전 영역은 Screen edges 'top' 이 비운다).
import { useRouter } from 'expo-router';
import { ArrowLeft, ChevronLeft } from 'lucide-react-native';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '~/components/ui/IconButton';
import { Text } from '~/components/ui/Text';

export type SubPageHeaderProps = {
  title: string;
  /** 뒤로 버튼 읽기 이름(웹 coupons.backAria · impact.backAria · settings.backAria · privacy.backAria). */
  backLabel: string;
  /** 'bordered' = 내 문의·고객지원 모양(ArrowLeft · 아래 테두리 · 간격 16). 기본은 ChevronLeft · 간격 12. */
  variant?: 'plain' | 'bordered';
  /** 위 안전 영역을 머리가 비운다(Stack 고정 머리). 스크롤 머리는 false(Screen 이 비운다). */
  insetTop?: boolean;
};

/** 마이 첫 화면 경로(웹 lib/navigation.ts MYPAGE_BACK). */
const MYPAGE_HOME = '/mypage';

export function SubPageHeader({ title, backLabel, variant = 'plain', insetTop = false }: SubPageHeaderProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const bordered = variant === 'bordered';
  return (
    <View className="bg-hanji" style={insetTop ? { paddingTop: insets.top } : undefined}>
      <View
        className={
          bordered
            ? 'flex-row items-center gap-[16px] border-b border-line p-[20px]'
            : 'flex-row items-center gap-[12px] p-[20px]'
        }
      >
        <IconButton
          icon={bordered ? ArrowLeft : ChevronLeft}
          size="xl"
          box={24}
          color="muk-soft"
          accessibilityLabel={backLabel}
          onPress={() => router.dismissTo(MYPAGE_HOME)}
        />
        {/* 웹 h1 text-xl(20/28) font-bold tracking-wide(0.025em = 0.5px). */}
        <Text weight="bold" accessibilityRole="header" className="min-w-0 shrink text-[20px] leading-[28px] tracking-[0.5px]">
          {title}
        </Text>
      </View>
    </View>
  );
}
