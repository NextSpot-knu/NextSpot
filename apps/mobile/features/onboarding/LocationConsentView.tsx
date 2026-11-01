// 위치정보 이용 동의(법적) — 첫 실행 두 번째 단계. 계획 §6.2 ① · §8.2 위치정보법 · M20('필요'로 가정).
//
// 이 화면은 OS 위치 권한 안내(HIG 버튼 하나, 홈 흐름의 몫)와 다르다. 법적 동의라 버튼이 둘이다:
//   · '동의' — '만 14세 이상이에요' 를 확인해야 눌린다(위치정보법 제25조① — 14세 미만은 법정대리인 동의 필요,
//     앱은 그 절차가 없어 14세 미만에게서는 동의를 받지 않는다).
//   · '동의 안 함' — 언제나 눌린다. 앱은 위치를 요청하지 않고 황리단길 중심으로 추천한다.
// 어느 쪽이든 기록(약관 판·시각)을 남기고 다음 단계로 간다. 위치 사용 여부는 features/auth/consent 의
// hasLocationConsent() 가 정한다. 약관 요약 문구는 법무 검토 전 초안이다(LOCATION_TERMS_VERSION).
// 화면에는 OS 권한 창을 띄우는 코드가 없다(expo-location 을 import 하지 않는다).
import { Check } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Icon, Pressable, Text, cn, toast } from '~/components/ui';
import { setLocationConsent, type ConsentDecision } from '~/features/auth/consent';
import { useT } from '~/lib/i18n/I18nProvider';

import { passFirstRunStep } from './firstRun';

const TERMS_ITEMS = [
  { title: 'app.consent.purposeTitle', body: 'app.consent.purposeBody' },
  { title: 'app.consent.whenTitle', body: 'app.consent.whenBody' },
  { title: 'app.consent.retentionTitle', body: 'app.consent.retentionBody' },
  { title: 'app.consent.declineTitle', body: 'app.consent.declineBody' },
] as const;

export function LocationConsentView({ onDone }: { onDone: (decision: ConsentDecision) => void }) {
  const t = useT();
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const decide = (decision: ConsentDecision) => {
    if (busy) return;
    if (decision === 'granted' && !ageConfirmed) return;
    setBusy(true);
    let saved = false;
    try {
      saved = setLocationConsent(decision, decision === 'granted' ? true : ageConfirmed);
    } catch {
      saved = false;
    }
    if (!saved) {
      // 저장하지 못하면 동의는 없는 것으로 다룬다(hasLocationConsent 가 false). 진행은 막지 않는다.
      toast.error(t('app.consent.saveFailed'));
      // 이번 실행은 동의 없이 넘어간다(같은 화면에 갇히지 않게). 다음 실행에 다시 묻는다.
      passFirstRunStep('consent');
    }
    onDone(saved ? decision : 'declined');
  };

  return (
    <View className="gap-[16px]">
      <View>
        <Text className="text-2xl text-muk" weight="bold" accessibilityRole="header">
          {t('app.consent.title')}
        </Text>
        <Text className="mt-[8px] text-sm leading-[22px] text-muk-soft">{t('app.consent.lead')}</Text>
      </View>

      <Card className="gap-[14px]">
        {TERMS_ITEMS.map((item) => (
          <View key={item.title}>
            <Text className="text-sm text-muk" weight="bold">
              {t(item.title)}
            </Text>
            <Text className="mt-[4px] text-sm leading-[20px] text-muk-soft">{t(item.body)}</Text>
          </View>
        ))}
      </Card>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: ageConfirmed }}
        accessibilityLabel={t('app.consent.ageConfirm')}
        onPress={() => setAgeConfirmed((v) => !v)}
        className={cn(
          'min-h-[48px] flex-row items-center gap-[12px] rounded-2xl border px-[14px] py-[12px]',
          ageConfirmed ? 'border-jade bg-jade/10' : 'border-line bg-white',
        )}
      >
        <View
          className={cn(
            'h-[22px] w-[22px] items-center justify-center rounded-md border',
            ageConfirmed ? 'border-jade bg-jade' : 'border-muk-soft bg-white',
          )}
        >
          {ageConfirmed && <Icon icon={Check} size={14} strokeWidth={3} color="white" />}
        </View>
        <Text className="flex-1 text-sm text-muk" weight="semibold">
          {t('app.consent.ageConfirm')}
        </Text>
      </Pressable>
      <Text className="-mt-[8px] text-xs leading-[18px] text-muk-soft">{t('app.consent.ageHint')}</Text>

      <View className="flex-row gap-[10px]">
        <Button
          className="flex-1"
          variant="secondary"
          label={t('app.consent.decline')}
          disabled={busy}
          onPress={() => decide('declined')}
        />
        <Button
          className="flex-1"
          label={t('app.consent.agree')}
          disabled={busy || !ageConfirmed}
          accessibilityHint={ageConfirmed ? undefined : t('app.consent.ageConfirm')}
          onPress={() => decide('granted')}
        />
      </View>
    </View>
  );
}
