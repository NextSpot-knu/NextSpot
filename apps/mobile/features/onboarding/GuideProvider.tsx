// 서비스 소개 모달 — 앱 어디서나 openGuide()(guideEntry)로 연다. app/_layout.tsx 에 한 번 둔다.
//
// 웹 원본: apps/web/components/guide/GuideProvider.tsx(전체화면 <dialog> + 끈적한 머리 + GuideContent) (기준 커밋 0d145a1)
//   머리: border-b line · bg hanji/95 · px 20 · py 12 — 'NextSpot'(14 600) + 간격 8 + '서비스 소개'(400 muk-soft),
//   오른쪽 닫기 44×44 원 테두리 line + X 20(라벨 guide.close). Esc·X 로 닫히고 닫아도 원래 화면 그대로.
// 앱: RN Modal(전체화면, fade). 머리는 ScrollView 밖이라 늘 위에 있다(웹 sticky top-0 과 같은 결과).
//   · 내용 루트는 ModalSheetHost — 안에서 여는 시트(축제 등)가 Modal 창 뒤로 깔리지 않게(검토 R1 G1-04, B3).
//   · 안드로이드 뒤로 = onRequestClose = 닫기.
//   · '데이터' 절로 열면(openGuideData) 그 절을 펼치고 그 자리로 스크롤한다(웹 requestGuideDataSection + scrollIntoView).
// 언어 선택(LanguageSwitcher → SelectField)은 네이티브에서 가운데 RN Modal 목록이라 이 Modal 위에 그대로 뜬다.
import { X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, Text } from '~/components/ui';
import { ModalSheetHost } from '~/components/ui/Sheet';
import { useT } from '~/lib/i18n/I18nProvider';

import { GuideContent } from './GuideContent';
import { registerGuideOpener, type GuideFocus } from './guideEntry';

export function GuideModal({ open, focus, onClose }: { open: boolean; focus: GuideFocus | null; onClose: () => void }) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const scrolledRef = useRef(false);
  const headerHeight = useRef(69);

  useEffect(() => {
    if (open) scrolledRef.current = false;
  }, [open]);

  const onDataLayout = useCallback(
    (y: number) => {
      if (focus !== 'data' || scrolledRef.current) return;
      scrolledRef.current = true;
      // 펼친 절이 그려진 다음 프레임에 — 웹 requestAnimationFrame + scrollIntoView({ behavior: 'smooth', block: 'start' }).
      // 웹은 끈적한 머리가 스크롤 영역 안에 겹쳐 있어 절 윗줄(접힘 줄)이 머리 밑에 들어간다 — 앱 머리는 스크롤 밖이라
      // 머리 높이만큼 더 내려 같은 자리(데이터 kicker 가 머리 바로 아래)에서 멈춘다.
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: y + headerHeight.current, animated: true }));
    },
    [focus],
  );

  return (
    <Modal
      visible={open}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <ModalSheetHost>
        <View className="flex-1 bg-hanji" style={{ paddingTop: insets.top }} accessibilityViewIsModal accessibilityLabel={t('guide.title')}>
          <View
            className="flex-row items-center justify-between border-b border-line px-[20px] py-[12px]"
            style={{ backgroundColor: 'rgba(250, 245, 236, 0.95)' }}
            onLayout={(e) => {
              headerHeight.current = e.nativeEvent.layout.height;
            }}
          >
            <View className="min-w-0 shrink flex-row items-baseline gap-[8px]">
              <Text className="text-[14px] leading-[21px] text-muk" weight="semibold">
                NextSpot
              </Text>
              <Text className="text-[14px] leading-[21px] text-muk-soft" weight="regular" numberOfLines={1}>
                {t('guide.label')}
              </Text>
            </View>
            <IconButton
              icon={X}
              size="lg"
              box={44}
              color="muk"
              accessibilityLabel={t('guide.close')}
              onPress={onClose}
              className="rounded-full border border-line"
            />
          </View>
          <ScrollView ref={scrollRef} contentContainerStyle={{ paddingBottom: insets.bottom }} keyboardShouldPersistTaps="handled">
            {open && <GuideContent onNavigate={onClose} dataOpen={focus === 'data'} onDataLayout={onDataLayout} />}
          </ScrollView>
        </View>
      </ModalSheetHost>
    </Modal>
  );
}

/** 루트에 하나 — openGuide()·openGuideData() 를 받아 모달을 연다(guideEntry 에 여는 함수를 등록). */
export function GuideProvider() {
  const [state, setState] = useState<{ open: boolean; focus: GuideFocus | null }>({ open: false, focus: null });
  useEffect(() => registerGuideOpener((focus) => setState({ open: true, focus })), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return <GuideModal open={state.open} focus={state.focus} onClose={close} />;
}
