import { Users } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Gradient,
  Icon,
  MODAL_SHEET_CLOSE_BOX,
  ModalSheet,
  Pressable,
  RingSpinner,
  Text,
  cn,
  reportToast,
} from '~/components/ui';
import { apiClient } from '~/lib/core/apiClient';
import { haptic } from '~/lib/platform/haptics';
import { trackEvent } from '~/lib/platform/analytics';
import { colors } from '~/lib/theme/tokens';

import { congestionReportErrorKey, rewardBadge, type ReportLevel } from './reportCore';
import { useT } from '~/lib/i18n/I18nProvider';

// 선택 강조 — 웹 activeBg(테두리 · 바탕 · 이름 글자색). 고르지 않은 칸은 border-line + text-muk-soft.
const OPTIONS: { value: ReportLevel; emoji: string; labelKey: string; descKey: string; active: string; activeText: string }[] = [
  { value: '한산', emoji: '🍃', labelKey: 'congestion.quiet', descKey: 'report.quietDesc', active: 'border-jade bg-jade/10', activeText: 'text-jade' },
  { value: '보통', emoji: '🙂', labelKey: 'congestion.moderate', descKey: 'report.moderateDesc', active: 'border-gold bg-gold/10', activeText: 'text-gold-deep' },
  { value: '혼잡', emoji: '🔥', labelKey: 'congestion.busy', descKey: 'report.busyDesc', active: 'border-terracotta bg-terracotta/10', activeText: 'text-terracotta' },
];

// 시트 모양 — 웹 대화 시트(bg-hanji border-line p-6 max-w-sm, 막 bg-muk/40, 그림자 0 -8px 40px). docs/MOBILE_WEB_PARITY.md §4.2 F8.
const SHEET_PADDING = { x: 24, top: 24, bottom: 24 } as const;
const SHEET_SHADOW = '0px -8px 40px rgba(43, 35, 32, 0.2)';
const SHEET_BACKDROP = { color: colors.muk, opacity: 0.4 } as const;
const SHEET_MAX_WIDTH = 384;
/** 머리 줄 오른쪽 빈자리 — 시트가 겹쳐 그리는 X 상자 + 웹 gap-3(12). */
const HEADER_RIGHT = MODAL_SHEET_CLOSE_BOX.muted + 12;

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
// 위 3px 금 장식선 — 웹 from-transparent via-gold/60 to-transparent. 'transparent' 는 iOS 에서 검정을 거쳐 섞여 금 0% 로 쓴다.
const ACCENT_COLORS = [rgba(colors.gold, 0), rgba(colors.gold, 0.6), rgba(colors.gold, 0)] as const;

/** 트리거 높이 클래스 — className 에 이 종류가 있으면 기본 높이(py 8 + hitSlop 5)를 빼고 그것으로 바꿔 끼운다. */
const HEIGHT_CLASS = /^(min-h|h|py|pt|pb)-/;
/** 기본 트리거: 보이는 높이 34(글자 16 + py 8·8 + 테두리 1·1) — 탭 영역은 hitSlop 5 로 44. */
const TRIGGER_HIT_SLOP = 5;

/**
 * 혼잡 제보 버튼 + 바닥 시트(웹 components/CongestionReportButton.tsx). 한산/보통/혼잡 한 번 탭으로 전송.
 * 게스트(익명 세션)는 서버가 403 을 줘서 '로그인 후 제보할 수 있어요' 로 안내한다.
 * 결과는 이름 붙은 토스트 채널 'report'(화면 아래 96 · 청록/주칠 알약 — 웹 자체 토스트)로 알린다. 실패하면 시트는 열린 채.
 * ModalSheet 는 app/_layout.tsx 의 BottomSheetModalProvider 안에서만 쓸 수 있다.
 */
export function CongestionReportButton({
  facility,
  isFirst = false,
  onReported,
  className,
}: {
  facility: { id: string; name: string };
  isFirst?: boolean;
  onReported?: (level: ReportLevel) => void;
  /**
   * 트리거 자리·크기(웹 className). 높이 클래스(min-h-* · h-* · py-*)를 주면 기본 높이를 덧붙이지 않고 바꿔 끼운다
   * — 대안 화면은 웹 `min-h-11` 그대로 "min-h-[44px]". 색·글자 클래스는 넘기지 않는다(같은 속성 두 클래스가 된다).
   */
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReportLevel | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const customHeight = (className ?? '').split(/\s+/).some((c) => HEIGHT_CLASS.test(c));

  const submit = async (level: ReportLevel) => {
    if (submitting) return;
    trackEvent('congestion_report', { facility_id: String(facility.id).slice(0, 64), level });
    setSelected(level);
    haptic('confirm');
    setSubmitting(true);
    try {
      const response = (await apiClient.post('/api/v1/reports/congestion', { facilityId: facility.id, level })) as
        | { reward?: { couponIssued?: boolean; nextRewardIn?: number } }
        | null;
      onReported?.(level);
      haptic('success');
      const badge = rewardBadge(response?.reward);
      const message = t('report.success', { name: facility.name });
      reportToast(badge ? `${message} · ${badge}` : message, 'success');
      setOpen(false);
    } catch (err) {
      // 실패하면 시트는 열어 둔다(웹과 같다) — 다시 고를 수 있게.
      reportToast(t(congestionReportErrorKey(err)), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* 트리거 — 웹 px-3 py-2 rounded-full border text-xs font-bold + Users 14(gap-1.5) */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('report.triggerAria', { name: facility.name })}
        onPress={() => {
          haptic('selection');
          setSelected(null);
          setOpen(true);
        }}
        hitSlop={customHeight ? undefined : TRIGGER_HIT_SLOP}
        className={cn(
          'flex-row items-center gap-[6px] rounded-full border px-[12px]',
          customHeight ? className : cn('py-[8px]', className),
          isFirst ? 'border-jade/35 bg-jade/10' : 'border-line bg-hanji-deep',
        )}
      >
        <Icon icon={Users} size={14} color={isFirst ? 'jade' : 'muk-soft'} />
        <Text className={cn('shrink text-[12px] leading-[16px]', isFirst ? 'text-jade' : 'text-muk-soft')} weight="bold">
          {isFirst ? t('report.triggerFirst') : t('report.trigger')}
        </Text>
      </Pressable>
      <ModalSheet
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!submitting}
        handleLabel={t('common.close')}
        closeLabel={t('common.close')}
        background="hanji"
        bordered
        shadow={SHEET_SHADOW}
        showHandle={false}
        closeButton="muted"
        backdrop={SHEET_BACKDROP}
        maxWidth={SHEET_MAX_WIDTH}
        contentPadding={SHEET_PADDING}
      >
        {/* 웹 flex-col gap-5 */}
        <View className="gap-[20px]">
          {/* 위 3px 금 장식선 — 웹은 판 맨 위(absolute top-0). 내용 여백만큼 위·옆으로 뺀다. 장식이라 읽지 않는다. */}
          <Gradient
            colors={ACCENT_COLORS}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              position: 'absolute',
              top: -SHEET_PADDING.top,
              left: -SHEET_PADDING.x,
              right: -SHEET_PADDING.x,
              height: 3,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
            }}
          />

          {/* 머리 — 오른쪽은 시트가 겹쳐 그리는 X(muted) 자리 */}
          <View style={{ paddingRight: HEADER_RIGHT }}>
            {/* 웹 text-lg font-serif font-bold leading-tight(1.25) */}
            <Text accessibilityRole="header" className="font-serif text-[18px] leading-[22.5px] text-muk" weight="bold">
              {t('report.title')}
            </Text>
            {/* 웹 text-xs text-muk-soft mt-1 font-medium truncate max-w-[220px] */}
            <Text className="mt-[4px] max-w-[220px] text-[12px] leading-[16px] text-muk-soft" weight="medium" numberOfLines={1}>
              {facility.name}
            </Text>
          </View>

          {/* 3지선다 — 웹 grid-cols-3 gap-2.5. 누르는 순간 제출(두 번째 확인 없음). */}
          <View accessibilityRole="radiogroup" accessibilityLabel={t('report.selectAria')} className="flex-row gap-[10px]">
            {OPTIONS.map((opt) => {
              const active = selected === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active, disabled: submitting }}
                  accessibilityLabel={`${t(opt.labelKey)}. ${t(opt.descKey)}`}
                  disabled={submitting}
                  onPress={() => void submit(opt.value)}
                  className={cn(
                    // 웹 flex-col items-center gap-1.5 py-4 rounded-2xl border-2 bg-white/60, disabled:opacity-60(보내는 동안 세 칸 모두)
                    'flex-1 items-center gap-[6px] rounded-2xl border-2 bg-white/60 py-[16px]',
                    active ? opt.active : 'border-line',
                    submitting && 'opacity-60',
                  )}
                >
                  {/* 웹 text-2xl leading-none */}
                  <Text className="text-[24px] leading-[24px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    {opt.emoji}
                  </Text>
                  {/* 웹 text-sm(14/20) font-bold — 고른 칸은 그 색, 아니면 muk-soft */}
                  <Text className={cn('text-center text-[14px] leading-[20px]', active ? opt.activeText : 'text-muk-soft')} weight="bold">
                    {t(opt.labelKey)}
                  </Text>
                  {/* 웹 text-[10px] font-medium — 줄 높이는 본문 1.5 를 물려받는다(15) */}
                  <Text className="text-center text-[10px] leading-[15px] text-muk-soft" weight="medium">
                    {t(opt.descKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* 웹 h-5 role=status — '제보 중…' 줄(14px 링 스피너 border-gold/30 + border-t-gold-deep, gap-2, text-xs bold gold-deep) */}
          <View className="h-[20px] items-center justify-center" accessibilityLiveRegion="polite">
            {submitting && (
              <View className="flex-row items-center gap-[8px]">
                <RingSpinner size={14} borderWidth={2} trackColor={rgba(colors.gold, 0.3)} headColor="gold-deep" />
                <Text className="text-[12px] leading-[16px] text-gold-deep" weight="bold">{t('report.submitting')}</Text>
              </View>
            )}
          </View>

          {/* 웹 text-[10px] text-muk-soft/80 text-center leading-relaxed(1.625) */}
          <Text className="text-center text-[10px] leading-[16.25px] text-muk-soft/80">{t('report.footer')}</Text>
        </View>
      </ModalSheet>
    </>
  );
}
