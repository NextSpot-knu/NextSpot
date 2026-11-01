import { Users } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Icon, ModalSheet, Pressable, Text, cn, toast } from '~/components/ui';
import { apiClient } from '~/lib/core/apiClient';
import { haptic } from '~/lib/platform/haptics';
import { trackEvent } from '~/lib/platform/analytics';
import { colors } from '~/lib/theme/tokens';

import { congestionReportErrorKey, rewardBadge, type ReportLevel } from './reportCore';
import { useT } from '~/lib/i18n/I18nProvider';

const OPTIONS: { value: ReportLevel; emoji: string; labelKey: string; descKey: string; active: string }[] = [
  { value: '한산', emoji: '🍃', labelKey: 'congestion.quiet', descKey: 'report.quietDesc', active: 'border-jade bg-jade/10' },
  { value: '보통', emoji: '🙂', labelKey: 'congestion.moderate', descKey: 'report.moderateDesc', active: 'border-gold bg-gold/10' },
  { value: '혼잡', emoji: '🔥', labelKey: 'congestion.busy', descKey: 'report.busyDesc', active: 'border-terracotta bg-terracotta/10' },
];

/**
 * 혼잡 제보 버튼 + 바닥 시트(웹 components/CongestionReportButton.tsx). 한산/보통/혼잡 한 번 탭으로 전송.
 * 게스트(익명 세션)는 서버가 403 을 줘서 '로그인 후 제보할 수 있어요' 로 안내한다.
 * ModalSheet 는 app/_layout.tsx 의 BottomSheetModalProvider 안에서만 쓸 수 있다.
 */
export function CongestionReportButton({
  facility,
  isFirst = false,
  onReported,
}: {
  facility: { id: string; name: string };
  isFirst?: boolean;
  onReported?: (level: ReportLevel) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReportLevel | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      toast.success(badge ? `${message} · ${badge}` : message);
      setOpen(false);
    } catch (err) {
      toast.error(t(congestionReportErrorKey(err)));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('report.triggerAria', { name: facility.name })}
        onPress={() => {
          haptic('selection');
          setSelected(null);
          setOpen(true);
        }}
        className={cn(
          'min-h-[44px] flex-row items-center gap-[6px] rounded-full border px-[12px] py-[8px]',
          isFirst ? 'border-jade/35 bg-jade/10' : 'border-line bg-hanji-deep',
        )}
      >
        <Icon icon={Users} size="sm" color={isFirst ? 'jade' : 'muk-soft'} />
        <Text className={cn('shrink text-[12px] leading-[16px]', isFirst ? 'text-jade' : 'text-muk-soft')} weight="bold">
          {isFirst ? t('report.triggerFirst') : t('report.trigger')}
        </Text>
      </Pressable>
      <ModalSheet open={open} onClose={() => !submitting && setOpen(false)} handleLabel={t('common.close')} closeLabel={t('common.close')}>
        <View className="gap-[16px] pt-[4px]">
          <View>
            <Text className="font-serif text-[18px] leading-[24px]" weight="bold">{t('report.title')}</Text>
            <Text className="mt-[4px] text-[12px] leading-[16px] text-muk-soft" numberOfLines={1}>{facility.name}</Text>
          </View>
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
                    'min-h-[88px] flex-1 items-center justify-center gap-[6px] rounded-2xl border-2 bg-white/60 px-[4px] py-[12px]',
                    active ? opt.active : 'border-line',
                    submitting && !active ? 'opacity-60' : '',
                  )}
                >
                  <Text className="text-[24px] leading-[30px]" accessibilityElementsHidden>{opt.emoji}</Text>
                  <Text className="text-[14px] leading-[18px]" weight="bold">{t(opt.labelKey)}</Text>
                  <Text className="text-center text-[10px] leading-[13px] text-muk-soft">{t(opt.descKey)}</Text>
                </Pressable>
              );
            })}
          </View>
          <View className="min-h-[20px] items-center justify-center" accessibilityLiveRegion="polite">
            {submitting && (
              <View className="flex-row items-center gap-[8px]">
                <ActivityIndicator size="small" color={colors['gold-deep']} />
                <Text className="text-[12px] text-gold-deep" weight="bold">{t('report.submitting')}</Text>
              </View>
            )}
          </View>
          <Text className="text-center text-[10px] leading-[14px] text-muk-soft">{t('report.footer')}</Text>
        </View>
      </ModalSheet>
    </>
  );
}
