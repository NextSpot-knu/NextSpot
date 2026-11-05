// 마이 탭 — 웹 app/mypage/page.tsx. 임팩트 카드 · 프로필(이름 바꾸기) · 저장/방문 통계 · 줄인 대기 배너 · 취향 레이더 · 계정 연결 ·
// 나의 실험실 카드 · 메뉴 4개 · 역할 변경 신청 · 로그아웃 · 개인정보/고객지원 링크.
// 사장님·관제 역할에는 '웹에서 열기' 링크만(계획 §3.3). 앱에서 뺀 것: 콘솔 미리보기(데모) · 개발자 콘솔 · 지역 전환 · 혼잡 알림 토글 · 언어 칩 줄
// (언어는 설정에 있다) · 다크 모드.
import { useRouter } from 'expo-router';
import {
  Bookmark, ChevronRight, ExternalLink, Footprints, FlaskConical, Hourglass, LogOut, MessageSquare,
  Settings as SettingsIcon, ShieldCheck, Sparkles, Store, Ticket, User, UserCog, type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Image, View } from 'react-native';

import { Button, Card, Icon, IconButton, Pressable, Screen, Skeleton, Text, toast } from '~/components/ui';
import { canEnterAdminConsole, canEnterMerchantConsole, useAccount } from '~/lib/core/account';
import { useT } from '~/lib/i18n/I18nProvider';
import { openExternalUrl } from '~/lib/platform/links';
import { WEB_ORIGIN } from '~/lib/platform/shareUrls';
import { roleRequestEntryState } from '@/lib/accountRoles';

import { loadProfile, saveNickname, signOutAndClear, type Profile } from '~/features/mypage/actions';
import { wageValueKrw } from '~/features/mypage/accountCore';
import { fetchImpactSummary, fetchLabPendingCount, fetchMyInquiries } from '~/features/mypage/api';
import { AccountSection } from '~/features/mypage/components/AccountSection';
import { ImpactSummaryCard } from '~/features/mypage/components/ImpactSummaryCard';
import { ProfileEditModal } from '~/features/mypage/components/ProfileEditModal';
import { TasteRadar } from '~/features/mypage/components/TasteRadar';
import { countUnseenReplies, repliedIds } from '~/features/mypage/inquiryCore';
import { useQuiet } from '~/features/mypage/useQuiet';

const fetchUnseenReplies = async () => countUnseenReplies(repliedIds(await fetchMyInquiries()));

export default function MypageScreen() {
  const t = useT();
  const router = useRouter();
  const { account, status: accountStatus } = useAccount();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [editing, setEditing] = useState(false);

  // 계정이 바뀌면(로그인·로그아웃·삭제) 프로필을 다시 읽는다.
  const accountKey = `${account?.id ?? ''}:${account?.isAnonymous ?? ''}`;
  useEffect(() => {
    let alive = true;
    setProfileFailed(false);
    loadProfile().then(
      (p) => { if (alive) setProfile(p); },
      () => { if (alive) setProfileFailed(true); },
    );
    return () => { alive = false; };
  }, [accountKey]);

  const impact = useQuiet(fetchImpactSummary);
  const labCount = useQuiet(fetchLabPendingCount);
  const unseen = useQuiet(fetchUnseenReplies);

  const go = useCallback((path: string) => router.push(path as never), [router]);
  const roleEntry = roleRequestEntryState(account, accountStatus);
  const waitSaved = impact?.waitSavedMinutes ?? 0;

  const profileName = profile?.name ?? t('mypage.guestName');
  const profileEmail = profile?.email
    || (profile?.linkedProvider
      ? t('auth.linkedVia', { provider: t(profile.linkedProvider === 'kakao' ? 'auth.providerKakao' : 'auth.providerGoogle') })
      : '');
  const showSignOut = Boolean(profile?.isMember) || (account !== null && !account.isAnonymous);

  const onSignOut = async () => {
    await signOutAndClear();
    toast.success(t('mypage.signedOut'));
  };

  const onSaveName = async (name: string) => {
    try {
      await saveNickname(name);
      setProfile((prev) => (prev ? { ...prev, name } : prev));
      setEditing(false);
      toast.success(t('mypage.editNameSaved'));
    } catch (err) {
      console.warn('[mypage] 이름 저장 실패', err);
      toast.error(t('mypage.editNameFailed'));
    }
  };

  const menus: readonly { id: string; icon: LucideIcon; label: string; path: string; badge?: number }[] = [
    { id: 'impact', icon: Sparkles, label: t('mypage.menuImpact'), path: '/mypage/impact' },
    { id: 'coupons', icon: Ticket, label: t('mypage.menuCoupons'), path: '/mypage/coupons' },
    { id: 'inquiries', icon: MessageSquare, label: t('mypage.menuInquiries'), path: '/mypage/inquiries', badge: unseen && unseen > 0 ? unseen : undefined },
    { id: 'settings', icon: SettingsIcon, label: t('mypage.menuSettings'), path: '/mypage/settings' },
  ];

  return (
    <Screen scroll edges={['top', 'left', 'right']} contentClassName="px-[16px] pb-[24px] gap-0">
      <View className="min-h-[56px] flex-row items-center justify-between">
        <Text className="text-xl" weight="bold" accessibilityRole="header">{t('nav.mypage')}</Text>
        <IconButton icon={SettingsIcon} accessibilityLabel={t('mypage.menuAria')} color="muk-soft" box={44} onPress={() => go('/mypage/settings')} />
      </View>

      <ImpactSummaryCard summary={impact} />

      {profileFailed && !profile ? (
        <Card className="mb-[16px] items-center gap-[12px]">
          <Text className="text-center text-sm" weight="semibold">{t('common.error')}</Text>
          <Button variant="secondary" label={t('common.retry')} onPress={() => { setProfileFailed(false); void loadProfile().then(setProfile, () => setProfileFailed(true)); }} />
        </Card>
      ) : !profile ? (
        <Card className="mb-[16px] items-center gap-[10px]" accessible accessibilityLabel={t('common.loading')} accessibilityState={{ busy: true }} padded={false} style={{ padding: 24 }}>
          <Skeleton width={80} height={80} radius={40} />
          <Skeleton width="33%" height={24} />
          <Skeleton width="50%" height={16} />
          <Skeleton width={96} height={24} radius={12} />
        </Card>
      ) : (
        <>
          <Card className="mb-[16px] items-center" padded={false} style={{ padding: 24 }}>
            <View className="mb-[16px] h-[80px] w-[80px] items-center justify-center overflow-hidden rounded-full border-2 border-gold bg-hanji">
              {profile.avatar ? (
                <Image source={{ uri: profile.avatar }} style={{ width: 76, height: 76 }} accessibilityLabel={profileName} />
              ) : (
                <Icon icon={User} size={40} color="gold" />
              )}
            </View>
            <Text className="mb-[4px] max-w-full text-center text-2xl" weight="bold" accessibilityRole="header">{profileName}</Text>
            {profileEmail ? <Text className="mb-[16px] max-w-full text-center text-sm text-muk-soft">{profileEmail}</Text> : null}
            <View className="mb-[24px] rounded-full border border-gold/30 bg-gold/15 px-[16px] py-[4px]">
              <Text className="text-xs text-gold-deep" weight="semibold">{t('mypage.roleTraveler')}</Text>
            </View>
            <Button variant="secondary" label={t('mypage.editProfile')} onPress={() => setEditing(true)} />
          </Card>

          <View className="mb-[16px] flex-row gap-[12px]">
            <Card
              onPress={() => go('/saved')}
              accessibilityLabel={`${t('mypage.statSaved')} ${profile.saved}`}
              className="min-h-[64px] flex-1 flex-row items-center justify-center gap-[8px]"
            >
              <Icon icon={Bookmark} size="lg" color="terracotta" />
              <Text className="text-xl" weight="bold">{profile.saved}</Text>
              <Text className="shrink text-xs text-muk-soft" weight="medium" numberOfLines={1}>{t('mypage.statSaved')}</Text>
            </Card>
            <Card
              accessible
              accessibilityLabel={`${t('mypage.statVisited')} ${profile.visited}`}
              className="min-h-[64px] flex-1 flex-row items-center justify-center gap-[8px]"
            >
              <Icon icon={Footprints} size="lg" color="jade" />
              <Text className="text-xl" weight="bold">{profile.visited}</Text>
              <Text className="shrink text-xs text-muk-soft" weight="medium" numberOfLines={1}>{t('mypage.statVisited')}</Text>
            </Card>
          </View>
        </>
      )}

      {waitSaved > 0 ? (
        <Card
          onPress={() => go('/mypage/impact')}
          accessibilityLabel={t('mypage.savedBanner', { n: waitSaved })}
          className="mb-[16px] flex-row items-center gap-[12px] border-gold/30 bg-gold/10"
        >
          <Icon icon={Hourglass} size="xl" color="gold-deep" />
          <View className="min-w-0 flex-1">
            <Text className="text-sm leading-[19px]" weight="bold">{t('mypage.savedBanner', { n: waitSaved })}</Text>
            <Text className="mt-[2px] text-[11px] text-muk-soft">{t('mypage.savedValue', { won: wageValueKrw(waitSaved).toLocaleString() })}</Text>
          </View>
        </Card>
      ) : null}

      {accountStatus !== 'loading' ? (
        <View className="mb-[16px] gap-[12px]">
          {canEnterMerchantConsole(account) ? (
            <WebLinkCard icon={Store} title={t('console.openMerchant')} desc={t('console.openMerchantDesc')} cta={t('app.mypage.openOnWeb')} url={`${WEB_ORIGIN}/merchant`} />
          ) : null}
          {canEnterAdminConsole(account) ? (
            <WebLinkCard icon={ShieldCheck} title={t('console.openAdmin')} desc={t('console.openAdminDesc')} cta={t('app.mypage.openOnWeb')} url={`${WEB_ORIGIN}/admin/dashboard`} />
          ) : null}
        </View>
      ) : null}

      <TasteRadar />

      {profile ? <AccountSection profile={profile} /> : null}

      {labCount !== null && labCount > 0 ? (
        <Card
          onPress={() => go('/mypage/lab')}
          accessibilityLabel={t('lab.cardCta', { count: labCount })}
          className="mb-[16px] flex-row items-center gap-[12px] border-jade/35 bg-jade/10"
        >
          <View className="h-[44px] w-[44px] items-center justify-center rounded-2xl bg-jade/15">
            <Icon icon={FlaskConical} size="xl" color="jade" />
          </View>
          <View className="min-w-0 flex-1">
            <Text weight="bold">{t('lab.cardTitle')}</Text>
            <Text className="mt-[2px] text-xs leading-[18px] text-muk-soft">{t('lab.cardDesc')}</Text>
            <Text className="mt-[6px] text-xs text-jade" weight="semibold">{t('lab.cardCta', { count: labCount })}</Text>
          </View>
          <Icon icon={ChevronRight} size="lg" color="jade" />
        </Card>
      ) : null}

      <Card padded={false} className="mb-[16px] overflow-hidden">
        {menus.map((menu, index) => (
          <Pressable
            key={menu.id}
            accessibilityRole="button"
            accessibilityLabel={menu.badge ? `${menu.label}, ${t('inquiries.newReplyBadge')} ${menu.badge}` : menu.label}
            onPress={() => go(menu.path)}
            className={`min-h-[64px] flex-row items-center justify-between px-[16px] py-[12px] ${index > 0 ? 'border-t border-line' : ''}`}
          >
            <View className="min-w-0 flex-1 flex-row items-center gap-[16px]">
              <View className="h-[40px] w-[40px] items-center justify-center rounded-full bg-hanji-deep">
                <Icon icon={menu.icon} size="lg" color="muk-soft" />
              </View>
              <Text className="shrink" weight="medium" numberOfLines={2}>{menu.label}</Text>
              {menu.badge ? (
                <View className="rounded-full bg-terracotta px-[8px] py-[2px]">
                  <Text className="text-[11px] text-white" weight="bold">{t('inquiries.newReplyBadge')} {menu.badge}</Text>
                </View>
              ) : null}
            </View>
            <Icon icon={ChevronRight} size="lg" color="muk-soft" />
          </Pressable>
        ))}
      </Card>

      {roleEntry !== 'hidden' ? (
        <View className="mb-[0px]">
        <WebLinkCard
          pending={roleEntry === 'pending'}
          icon={roleEntry === 'pending' ? Hourglass : UserCog}
          title={t(roleEntry === 'pending' ? 'account.roleRequestPendingEntry' : 'account.roleRequestEntry')}
          desc={t(roleEntry === 'pending' ? 'account.roleRequestPendingEntryDesc' : 'account.roleRequestEntryDesc')}
          cta={t('app.mypage.openOnWeb')}
          url={`${WEB_ORIGIN}/account/business`}
        />
        </View>
      ) : null}

      {showSignOut ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mypage.signOut')}
          onPress={() => { void onSignOut(); }}
          className="my-[16px] min-h-[52px] flex-row items-center justify-center gap-[8px] rounded-2xl border border-line"
        >
          <Icon icon={LogOut} size="lg" color="terracotta" />
          <Text className="text-terracotta" weight="semibold">{t('mypage.signOut')}</Text>
        </Pressable>
      ) : <View className="h-[16px]" />}

      <View className="flex-row items-center justify-center gap-[12px]">
        <Pressable accessibilityRole="link" onPress={() => go('/mypage/privacy')} className="min-h-[44px] justify-center px-[8px]">
          <Text className="text-xs text-muk-soft">{t('mypage.menuPrivacy')}</Text>
        </Pressable>
        <Text className="text-xs text-line" accessibilityElementsHidden importantForAccessibility="no">·</Text>
        <Pressable accessibilityRole="link" onPress={() => go('/mypage/support')} className="min-h-[44px] justify-center px-[8px]">
          <Text className="text-xs text-muk-soft">{t('mypage.menuHelp')}</Text>
        </Pressable>
      </View>

      <ProfileEditModal visible={editing} initialName={profile?.name ?? t('mypage.guestName')} onClose={() => setEditing(false)} onSave={onSaveName} />
    </Screen>
  );
}

/** '웹에서 열기' 카드 — 웹에만 있는 화면(사장님·관제 콘솔 · 사업자 전환 신청)으로 시스템 브라우저를 연다. */
function WebLinkCard({
  icon, title, desc, cta, url, pending = false,
}: { icon: LucideIcon; title: string; desc: string; cta: string; url: string; pending?: boolean }) {
  return (
    <Card
      onPress={() => { void openExternalUrl(url); }}
      accessibilityLabel={`${title}. ${desc}. ${cta}`}
      className={`mb-[0px] flex-row items-center gap-[12px] ${pending ? 'border-gold/40 bg-gold/5' : 'border-gold/30'}`}
    >
      <Icon icon={icon} size="xl" color="gold-deep" />
      <View className="min-w-0 flex-1">
        <Text weight="bold">{title}</Text>
        <Text className="mt-[2px] text-xs leading-[18px] text-muk-soft">{desc}</Text>
      </View>
      <View className="items-center gap-[2px]">
        <Icon icon={ExternalLink} size="md" color="gold-deep" />
        <Text className="text-[10px] text-gold-deep" weight="semibold">{cta}</Text>
      </View>
    </Card>
  );
}
