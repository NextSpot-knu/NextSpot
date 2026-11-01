// 설정 — 웹 app/mypage/settings/page.tsx. 언어 · (사장님·관제 역할이면 웹에서 열기) · 저장 데이터 초기화 · 계정 삭제 · 앱 정보.
// 앱에서 빠진 것: 화면 테마(다크 모드 없음) · 혼잡 알림 토글(v1 제외 — 계획 §3.2).
// 계정 삭제는 가입 계정이 '계정 삭제', 게스트가 '내 데이터 삭제' — 같은 DELETE /api/v1/account/me 를 부른다(계획 §7.3):
// 확인 → 서버 삭제 → 로컬 로그아웃·개인 데이터 삭제 → 새 게스트 세션. 서버가 실패하면 아무것도 지우지 않는다.
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Database, ExternalLink, Globe, Info, Store, Trash2, UserX } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Text, Screen, toast } from '~/components/ui';
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
