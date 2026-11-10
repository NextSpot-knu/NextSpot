// 위치기반서비스 이용약관 동의(법적 동의) — 첫 실행 두 번째 단계. 계획 §6.2 ① · §8.2 위치정보법 제19조① · M20('필요'로 가정).
//
// 이 화면은 약관 동의 화면이다. OS 위치 권한 안내(HIG 버튼 하나, 홈 흐름의 몫)와 다르고, 그렇게 보이지 않게 만든다:
//   · 제목·문구는 '약관 동의' — OS 권한 창이나 '위치 허용'을 말하지 않는다(심사자가 권한 사전 안내로 읽지 않게).
//   · 약관 요약 + '전문 보기'(LocationTermsModal — 같은 약관 전문) + 체크 두 개(약관 동의 · 만 14세 이상).
//   · '동의하고 계속' — 두 체크가 모두 있어야 눌린다(위치정보법 제25조① — 14세 미만은 법정대리인 동의가 필요하고,
//     앱은 그 절차가 없어 14세 미만에게서는 동의를 받지 않는다).
//   · '동의하지 않고 계속' — 언제나 눌린다. 앱은 위치를 요청하지 않고 황리단길 중심으로 추천한다.
// 어느 쪽이든 기록(약관 판·시각)을 남기고 다음 단계로 간다. 위치 사용 여부는 features/auth/consent 의
// hasLocationConsent() 가 정한다. 약관 문구는 법무 검토 전 초안이다(LOCATION_TERMS_VERSION, docs/MOBILE_PRIVACY_DRAFT.md).
// 화면에는 OS 권한 창을 띄우는 코드가 없다(expo-location 을 import 하지 않는다).
import { Check } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Icon, Pressable, Text, cn, toast } from '~/components/ui';
import { setLocationConsent, type ConsentDecision } from '~/features/auth/consent';
import { useT } from '~/lib/i18n/I18nProvider';

import { passFirstRunStep } from './firstRun';

const SUMMARY_ITEMS = [
  { title: 'app.consent.purposeTitle', body: 'app.consent.purposeBody' },
  { title: 'app.consent.whenTitle', body: 'app.consent.whenBody' },
  { title: 'app.consent.retentionTitle', body: 'app.consent.retentionBody' },
  { title: 'app.consent.declineTitle', body: 'app.consent.declineBody' },
] as const;

/** 약관 전문의 조항 — 순서가 조 번호다. 문구는 app.locationTerms.* (초안, 법무 검토 전). */
export const LOCATION_TERMS_ARTICLES = [
  { title: 'app.locationTerms.serviceTitle', body: 'app.locationTerms.serviceBody' },
  { title: 'app.locationTerms.collectTitle', body: 'app.locationTerms.collectBody' },
  { title: 'app.locationTerms.useTitle', body: 'app.locationTerms.useBody' },
  { title: 'app.locationTerms.shareTitle', body: 'app.locationTerms.shareBody' },
  { title: 'app.locationTerms.withdrawTitle', body: 'app.locationTerms.withdrawBody' },
  { title: 'app.locationTerms.childTitle', body: 'app.locationTerms.childBody' },
  { title: 'app.locationTerms.rightsTitle', body: 'app.locationTerms.rightsBody' },
  { title: 'app.locationTerms.limitTitle', body: 'app.locationTerms.limitBody' },
] as const;

/** 약관 시행일(초안) — 문구를 바꾸면 features/auth/consentCore 의 LOCATION_TERMS_VERSION 과 같이 올린다. */
export const LOCATION_TERMS_EFFECTIVE = '2026-11-02';

/** 위치기반서비스 이용약관 전문 — 동의 화면의 '전문 보기'와 개인정보 안내 화면이 함께 쓴다. */
export function LocationTermsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View
        className="flex-1 bg-hanji"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}
      >
        <View className="flex-row items-center justify-between gap-[12px] border-b border-line px-[16px] py-[8px]">
          <Text className="min-w-0 flex-1 text-lg text-muk" weight="bold" accessibilityRole="header">
            {t('app.locationTerms.fullTitle')}
          </Text>
          <Button variant="ghost" label={t('common.close')} onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
          <Text className="text-sm leading-[22px] text-muk-soft">{t('app.locationTerms.intro')}</Text>
          {LOCATION_TERMS_ARTICLES.map((a) => (
            <View key={a.title} className="gap-[6px]">
              <Text className="text-sm text-muk" weight="bold" accessibilityRole="header">{t(a.title)}</Text>
              <Text className="text-sm leading-[22px] text-muk-soft">{t(a.body)}</Text>
            </View>
          ))}
          <Text className="text-xs text-muk-soft">{t('app.locationTerms.effective', { date: LOCATION_TERMS_EFFECTIVE })}</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function CheckRow({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onToggle}
      className={cn(
        'min-h-[48px] flex-row items-center gap-[12px] rounded-2xl border px-[14px] py-[12px]',
        checked ? 'border-jade bg-jade/10' : 'border-line bg-white',
      )}
    >
      <View
        className={cn(
          'h-[22px] w-[22px] items-center justify-center rounded-md border',
          checked ? 'border-jade bg-jade' : 'border-muk-soft bg-white',
        )}
      >
        {checked && <Icon icon={Check} size={14} strokeWidth={3} color="white" />}
      </View>
      <Text className="flex-1 text-sm text-muk" weight="semibold">
        {label}
      </Text>
    </Pressable>
  );
}

export function LocationConsentView({ onDone }: { onDone: (decision: ConsentDecision) => void }) {
  const t = useT();
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canAgree = termsAgreed && ageConfirmed;

  const decide = (decision: ConsentDecision) => {
    if (busy) return;
    if (decision === 'granted' && !canAgree) return;
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
          {t('app.locationTerms.consentTitle')}
        </Text>
        <Text className="mt-[8px] text-sm leading-[22px] text-muk-soft">{t('app.locationTerms.consentLead')}</Text>
      </View>

      <Card className="gap-[14px]">
        {SUMMARY_ITEMS.map((item) => (
          <View key={item.title}>
            <Text className="text-sm text-muk" weight="bold">
              {t(item.title)}
            </Text>
            <Text className="mt-[4px] text-sm leading-[20px] text-muk-soft">{t(item.body)}</Text>
          </View>
        ))}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('app.locationTerms.viewFull')}
          onPress={() => setTermsOpen(true)}
          className="min-h-[44px] justify-center self-start"
        >
          <Text className="text-sm text-gold-deep underline" weight="semibold">
            {t('app.locationTerms.fullTitle')} · {t('app.locationTerms.viewFull')}
          </Text>
        </Pressable>
      </Card>

      <View className="gap-[8px]">
        <CheckRow checked={termsAgreed} label={t('app.locationTerms.agreeCheck')} onToggle={() => setTermsAgreed((v) => !v)} />
        <CheckRow checked={ageConfirmed} label={t('app.consent.ageConfirm')} onToggle={() => setAgeConfirmed((v) => !v)} />
        <Text className="text-xs leading-[18px] text-muk-soft">{t('app.locationTerms.ageHint')}</Text>
      </View>

      <View className="gap-[4px]">
        {/* 주 버튼은 설정 '시작하기' 와 같은 52 · 16px(결정 D3 A — 모양만 웹 첫 실행 화면에 맞춘다, G1-14). */}
        <Button
          block
          size={52}
          labelSize={16}
          label={t('app.locationTerms.agreeContinue')}
          disabled={busy || !canAgree}
          accessibilityHint={canAgree ? undefined : t('app.locationTerms.agreeCheck')}
          onPress={() => decide('granted')}
        />
        <Button
          block
          variant="ghost"
          label={t('app.locationTerms.declineContinue')}
          disabled={busy}
          onPress={() => decide('declined')}
        />
      </View>

      <LocationTermsModal open={termsOpen} onClose={() => setTermsOpen(false)} />
    </View>
  );
}
