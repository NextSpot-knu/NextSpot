// 설정 — 웹 app/mypage/settings/page.tsx. 언어 · (사장님·관제 역할이면 웹에서 열기) · 저장 데이터 초기화 · 계정 삭제 · 앱 정보.
// 앱에서 빠진 것: 화면 테마(다크 모드 없음) · 혼잡 알림 토글(v1 제외 — 계획 §3.2).
// 계정 삭제는 가입 계정이 '계정 삭제', 게스트가 '내 데이터 삭제' — 같은 DELETE /api/v1/account/me 를 부른다(계획 §7.3):
// 확인 → 서버 삭제 → 로컬 로그아웃·개인 데이터 삭제 → 새 게스트 세션. 서버가 실패하면 아무것도 지우지 않는다.
// 위치정보 이용 동의(계획 §6.2 ① · M20): 지금 결정을 보이고, 동의했으면 철회(setLocationConsent('declined')),
// 아니면 동의 화면(LOCATION_CONSENT_ROUTE)으로 — 동의 화면 문구의 '나중에 마이페이지 설정에서 바꿀 수 있어요' 약속.
// 외부 AI 전송(App Store 5.1.2(i), features/aiConsent): 지금 상태를 보이고, 허용했으면 철회('허용 안 함'으로 적는다),
// 아니면 같은 안내 창(promptAiConsent)을 다시 띄워 고르게 한다.
import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import { Database, ExternalLink, Globe, Info, MapPin, Sparkles, Store, Trash2, UserX } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Text, Screen, toast } from '~/components/ui';
import { promptAiConsent, setAiConsent, useAiConsent } from '~/features/aiConsent';
import { getLocationConsent, setLocationConsent } from '~/features/auth/consent';
import { LOCATION_CONSENT_ROUTE } from '~/features/auth/locationAccess';
import { useLocationConsent } from '~/features/auth/useLocationConsent';
import { canEnterMerchantConsole, useAccount } from '~/lib/core/account';
import { useT } from '~/lib/i18n/I18nProvider';
import { openExternalUrl } from '~/lib/platform/links';
import { WEB_ORIGIN } from '~/lib/platform/shareUrls';

import { deleteAccountOrGuestData, resetSavedAndPrefs } from '~/features/mypage/actions';
import { confirmDestructive } from '~/features/mypage/confirm';
import { LanguageSwitcher } from '~/features/mypage/components/LanguageSwitcher';
import { SectionCard } from '~/features/mypage/components/parts';

export default function SettingsScreen() {
  const t = useT();
  const router = useRouter();
  const { account, status } = useAccount();
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const locationConsent = useLocationConsent();
  // 기록이 없으면(저장 실패 · 약관 판 변경) 아직 고르지 않은 것 — 어느 쪽이든 동의가 없으면 위치를 쓰지 않는다.
  const consentRecord = getLocationConsent();
  const consentStatus = locationConsent
    ? t('app.settings.locationConsentGranted')
    : consentRecord?.decision === 'declined'
      ? t('app.settings.locationConsentDeclined')
      : t('app.settings.locationConsentNone');
  const ai = useAiConsent();
  const aiStatus = ai.status === 'granted'
    ? t('app.settings.aiConsentGranted')
    : ai.status === 'declined'
      ? t('app.settings.aiConsentDeclined')
      : t('app.settings.aiConsentNone');
  const version = Constants.expoConfig?.version ?? '';
  // 계정 판정이 끝나기 전에는 가입/게스트 문구를 정하지 않는다(깜빡임 방지).
  const accountKnown = status !== 'loading' && account !== null;
  const isMember = accountKnown && !account.isAnonymous;

  const onReset = async () => {
    if (resetting) return;
    const ok = await confirmDestructive({
      title: t('settings.resetConfirm'),
      message: t('settings.resetConfirmDesc'),
      confirmLabel: t('settings.resetAction'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setResetting(true);
    try {
      await resetSavedAndPrefs();
      toast.success(t('settings.resetSuccess'));
    } catch (err) {
      console.warn('[settings] 초기화 실패', err);
      toast.error(t('common.error'));
    } finally {
      setResetting(false);
    }
  };

  const onWithdrawLocation = async () => {
    const ok = await confirmDestructive({
      title: t('app.settings.locationConsentWithdrawConfirm'),
      message: t('app.settings.locationConsentWithdrawConfirmDesc'),
      confirmLabel: t('app.settings.locationConsentWithdraw'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    // 철회는 '동의 안 함' 결정으로 적는다 — 첫 실행 단계를 다시 막지 않고, 위치를 쓰는 화면은 구독으로 바로 멈춘다.
    if (setLocationConsent('declined', false)) toast.success(t('app.settings.locationConsentWithdrawn'));
    else toast.error(t('common.error'));
  };

  const onWithdrawAi = async () => {
    const ok = await confirmDestructive({
      title: t('app.settings.aiConsentWithdrawConfirm'),
      message: t('app.settings.aiConsentWithdrawConfirmDesc'),
      confirmLabel: t('app.settings.aiConsentWithdraw'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    if (setAiConsent('declined')) toast.success(t('app.settings.aiConsentWithdrawn'));
    else toast.error(t('common.error'));
  };

  const onGiveAi = () => {
    // 설정에서는 이미 '허용 안 함'을 골랐어도 같은 안내 창으로 다시 묻는다(고르지 않고 닫으면 예전 값 그대로).
    void promptAiConsent(t, { force: true });
  };

  const onDelete = async () => {
    if (deleting) return;
    const ok = await confirmDestructive(
      isMember
        ? { title: t('settings.deleteAccountConfirm'), message: t('settings.deleteAccountConfirmDesc'), confirmLabel: t('settings.deleteAccountAction'), cancelLabel: t('common.cancel') }
        : { title: t('app.mypage.deleteDataConfirm'), message: t('app.mypage.deleteDataConfirmDesc'), confirmLabel: t('app.mypage.deleteDataAction'), cancelLabel: t('common.cancel') },
    );
    if (!ok) return;
    setDeleting(true);
    const result = await deleteAccountOrGuestData();
    setDeleting(false);
    if (result === 'ok') {
      toast.success(isMember ? t('settings.deleteAccountSuccess') : t('app.mypage.deleteDataSuccess'));
      router.navigate('/');
    } else {
      toast.error(isMember ? t('settings.deleteAccountFailed') : t('app.mypage.deleteDataFailed'));
    }
  };

  return (
    <Screen scroll edges={['left', 'right', 'bottom']} contentClassName="px-[16px] py-[16px] gap-[16px]">
      <SectionCard icon={Globe} tone="jade" title={t('settings.langTitle')} desc={t('settings.langDesc')}>
        <LanguageSwitcher />
      </SectionCard>

      {canEnterMerchantConsole(account) ? (
        <SectionCard icon={Store} tone="gold-deep" title={t('console.openMerchant')} desc={t('console.openMerchantDesc')}>
          <Button
            variant="secondary"
            icon={ExternalLink}
            label={t('app.mypage.openOnWeb')}
            block
            onPress={() => { void openExternalUrl(`${WEB_ORIGIN}/merchant`); }}
          />
        </SectionCard>
      ) : null}

      <SectionCard
        icon={MapPin}
        tone="jade"
        title={t('app.settings.locationConsentTitle')}
        desc={t('app.settings.locationConsentDesc')}
      >
        <View className="gap-[10px]">
          <Text className="text-sm text-muk" weight="semibold" accessibilityLiveRegion="polite">
            {consentStatus}
          </Text>
          {locationConsent ? (
            <Button
              variant="secondary"
              label={t('app.settings.locationConsentWithdraw')}
              block
              onPress={() => { void onWithdrawLocation(); }}
            />
          ) : (
            <Button
              variant="secondary"
              label={t('app.settings.locationConsentGive')}
              block
              onPress={() => router.push(LOCATION_CONSENT_ROUTE as Href)}
            />
          )}
        </View>
      </SectionCard>

      <SectionCard
        icon={Sparkles}
        tone="gold-deep"
        title={t('app.settings.aiConsentTitle')}
        desc={t('app.settings.aiConsentDesc')}
      >
        <View className="gap-[10px]">
          <Text className="text-sm text-muk" weight="semibold" accessibilityLiveRegion="polite">
            {aiStatus}
          </Text>
          {ai.allowed ? (
            <Button
              variant="secondary"
              label={t('app.settings.aiConsentWithdraw')}
              block
              onPress={() => { void onWithdrawAi(); }}
            />
          ) : (
            <Button
              variant="secondary"
              label={t('app.settings.aiConsentGive')}
              block
              onPress={onGiveAi}
            />
          )}
        </View>
      </SectionCard>

      <SectionCard icon={Database} tone="terracotta" title={t('settings.dataTitle')} desc={t('settings.resetDataDesc')}>
        <Button variant="secondary" icon={Trash2} label={t('settings.resetData')} loading={resetting} disabled={resetting} block onPress={() => { void onReset(); }} />
      </SectionCard>

      {accountKnown ? (
        <SectionCard
          danger
          icon={UserX}
          tone="terracotta"
          title={isMember ? t('settings.deleteAccountTitle') : t('app.mypage.deleteDataTitle')}
          desc={isMember ? t('settings.deleteAccountDesc') : t('app.mypage.deleteDataDesc')}
        >
          <Button
            variant="secondary"
            icon={Trash2}
            label={deleting ? t('common.loading') : isMember ? t('settings.deleteAccount') : t('app.mypage.deleteData')}
            loading={deleting}
            disabled={deleting}
            block
            onPress={() => { void onDelete(); }}
          />
        </SectionCard>
      ) : null}

      <SectionCard icon={Info} tone="muk-soft" title={t('settings.appInfoTitle')}>
        <View className="flex-row items-center justify-between gap-[12px] rounded-2xl border border-line bg-hanji px-[16px] py-[12px]">
          <View className="min-w-0 flex-1">
            <Text weight="semibold">{t('common.appName')}</Text>
            <Text className="text-xs text-muk-soft">{t('settings.appDesc')}</Text>
          </View>
          {version ? <Text className="text-xs text-muk-soft" weight="medium">{t('settings.version', { version })}</Text> : null}
        </View>
      </SectionCard>
    </Screen>
  );
}
