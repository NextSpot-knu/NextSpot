// 마이 탭 — 웹 app/mypage/page.tsx. 머리(메뉴 · 로고 · 언어 · 종, 스크롤 밖 고정) · 임팩트 카드 · 프로필(이름 바꾸기) · 저장/방문 통계 · 줄인 대기 배너 ·
// 콘솔 입구 · 취향 레이더 · 계정 연결 · 나의 실험실 카드 · 메뉴 4개 · 역할 변경 신청 · 로그아웃 · 개인정보/고객지원 링크.
// 사장님·관제 콘솔·사업자 전환은 시스템 브라우저로 웹을 연다(계획 §3.3 · D7 ①). 앱에서 뺀 것: 개발자 콘솔 · 지역 전환 ·
// 혼잡 알림 토글(D10 ① — v1.1) · 다크 모드. 이 화면은 웹처럼 하단 탭 막대 위에서 끝난다(바닥 여백 NAV_GAP).
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import {
  Bell, Bookmark, ChevronRight, Edit2, Footprints, FlaskConical, Hourglass, LogOut, Menu, MessageSquare,
  Settings as SettingsIcon, Sparkles, Ticket, User, type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { LanguageSwitcher } from '~/components/LanguageSwitcher';
import { useNavInsets } from '~/components/navigation/navMetrics';
import { Button, Card, Gradient, Icon, IconButton, Pressable, Screen, Skeleton, Text, toast } from '~/components/ui';
import { canEnterAdminConsole, canEnterMerchantConsole, useAccount } from '~/lib/core/account';
import { SHOW_CONSOLE_ENTRIES, consoleEntryUrls } from '~/lib/core/consoleEntries';
import { useT } from '~/lib/i18n/I18nProvider';
import { WEB_ORIGIN } from '~/lib/platform/shareUrls';
import { CONTENT_MAX_WIDTH } from '~/lib/theme/tokens';
import { roleRequestEntryState } from '@/lib/accountRoles';

import { loadProfile, saveNickname, signOutAndClear, type Profile } from '~/features/mypage/actions';
import { wageValueKrw } from '~/features/mypage/accountCore';
import { fetchImpactSummary, fetchLabPendingCount, fetchMyInquiries } from '~/features/mypage/api';
import { AccountSection } from '~/features/mypage/components/AccountSection';
import { AdminLinkCard, ConsolePreviewCard, MerchantLinkCard, RoleRequestCard } from '~/features/mypage/components/ConsoleCards';
import { ImpactSummaryCard } from '~/features/mypage/components/ImpactSummaryCard';
import { PROFILE_EDIT_TOASTER, ProfileEditModal } from '~/features/mypage/components/ProfileEditModal';
import { TasteRadar } from '~/features/mypage/components/TasteRadar';
import { countUnseenReplies, repliedIds } from '~/features/mypage/inquiryCore';
import { useQuiet } from '~/features/mypage/useQuiet';

const fetchUnseenReplies = async () => countUnseenReplies(repliedIds(await fetchMyInquiries()));

export default function MypageScreen() {
  const t = useT();
  const router = useRouter();
  const { gap } = useNavInsets();
  const { width } = useWindowDimensions();
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
    // 웹은 로그아웃 뒤 '/' 로 간다 — 앱엔 랜딩이 없어 홈 탭이 대응(G5b-18, R3: 탭 전환이라 navigate).
    router.navigate('/');
  };

  const onSaveName = async (name: string) => {
    try {
      await saveNickname(name);
      setProfile((prev) => (prev ? { ...prev, name } : prev));
      setEditing(false);
      toast.success(t('mypage.editNameSaved'));
    } catch (err) {
      console.warn('[mypage] 이름 저장 실패', err);
      // RN Modal 은 별도 창 — 모달 안 채널에 띄워야 보인다(G5b-17).
      toast.error(t('mypage.editNameFailed'), { toasterId: PROFILE_EDIT_TOASTER });
    }
  };

  const menus: readonly { id: string; icon: LucideIcon; label: string; path: string; badge?: number }[] = [
    { id: 'impact', icon: Sparkles, label: t('mypage.menuImpact'), path: '/mypage/impact' },
    { id: 'coupons', icon: Ticket, label: t('mypage.menuCoupons'), path: '/mypage/coupons' },
    { id: 'inquiries', icon: MessageSquare, label: t('mypage.menuInquiries'), path: '/mypage/inquiries', badge: unseen && unseen > 0 ? unseen : undefined },
    { id: 'settings', icon: SettingsIcon, label: t('mypage.menuSettings'), path: '/mypage/settings' },
  ];

  const consoleUrls = consoleEntryUrls(account);
  const hasConsoleRole = canEnterMerchantConsole(account) || canEnterAdminConsole(account);
  // 웹 max-[420px]:gap-1.5 — 390 폭 폰에서 통계 칸 안 간격이 6.
  const statGap = width <= 420 ? 6 : 12;

  return (
    <Screen edges={['top', 'left', 'right']} contentClassName="">
      {/* 머리 — 웹 header p-5(72): 메뉴 · 로고 · 언어 알약 + 종. 스크롤 밖에 고정. */}
      <View className="flex-row items-center justify-between p-[20px]">
        <IconButton icon={Menu} size="xl" box={24} color="muk-soft" accessibilityLabel={t('mypage.menuAria')} onPress={() => go('/mypage/settings')} />
        <View accessible accessibilityRole="header" accessibilityLabel={t('common.appName')}>
          <Image source={require('~/assets/images/nextspot-logo.png')} style={{ height: 28, width: 130 }} contentFit="contain" />
        </View>
        <View className="flex-row items-center gap-[8px]">
          <LanguageSwitcher />
          <IconButton icon={Bell} size="xl" box={24} color="muk-soft" accessibilityLabel={t('mypage.bellAria')} onPress={() => go('/mypage/settings')} />
        </View>
      </View>

      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: gap }}
      >
        <View className="w-full self-center" style={{ maxWidth: CONTENT_MAX_WIDTH }}>
          <View className="mt-[16px]">
            <ImpactSummaryCard summary={impact} />
          </View>

          {profileFailed && !profile ? (
            <Card className="mt-[16px] mb-[16px] items-center gap-[12px]">
              <Text className="text-center text-sm" weight="semibold">{t('common.error')}</Text>
              <Button variant="secondary" label={t('common.retry')} onPress={() => { setProfileFailed(false); void loadProfile().then(setProfile, () => setProfileFailed(true)); }} />
            </Card>
          ) : !profile ? (
            // 웹 로딩: 프로필 · 레이더 · 통계 세 블록만(나머지는 프로필이 온 뒤).
            <View className="mt-[16px]" accessible accessibilityLabel={t('common.loading')} accessibilityState={{ busy: true }}>
              <Card padded={false} className="mb-[16px] items-center rounded-3xl" style={{ padding: 24 }}>
                <View className="mb-[16px]"><Skeleton width={80} height={80} radius={40} /></View>
                <View className="mb-[8px] w-full items-center"><Skeleton width="33%" height={24} /></View>
                <View className="mb-[16px] w-full items-center"><Skeleton width="50%" height={16} /></View>
                <Skeleton width={96} height={24} radius={12} />
              </Card>
              <Card padded={false} className="mb-[16px] items-center rounded-3xl" style={{ padding: 24 }}>
                <View className="mb-[16px] w-full items-center"><Skeleton width="40%" height={16} /></View>
                <Skeleton width={160} height={160} radius={80} />
              </Card>
              <Card padded={false} className="mb-[24px] items-center justify-center" style={{ padding: 16 }}>
                <Skeleton width={96} height={24} />
              </Card>
            </View>
          ) : (
            <View className="mt-[16px]">
              <Card padded={false} className="mb-[16px] items-center rounded-3xl" style={{ padding: 24 }}>
                {/* 웹: 금 → 주칠 그라데이션 고리(p-0.5) 안에 한지 원 */}
                <View className="mb-[16px] h-[80px] w-[80px] overflow-hidden rounded-full">
                  <Gradient colors={['#c19a3e', '#c1553b']} start={{ x: 0, y: 1 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
                  <View className="m-[2px] h-[76px] w-[76px] items-center justify-center overflow-hidden rounded-full bg-hanji">
                    {profile.avatar ? (
                      <Image source={{ uri: profile.avatar }} style={{ width: 76, height: 76 }} accessibilityLabel={profileName} />
                    ) : (
                      <Icon icon={User} size={40} color="gold" />
                    )}
                  </View>
                </View>
                <Text className="mb-[4px] max-w-full text-center text-2xl" weight="bold" accessibilityRole="header">{profileName}</Text>
                {profileEmail ? <Text className="mb-[16px] max-w-full text-center text-sm text-muk-soft">{profileEmail}</Text> : null}
                <View className="mb-[24px] rounded-full border border-gold/30 bg-gold/15 px-[16px] py-[4px]">
                  <Text className="text-xs text-gold-deep" weight="semibold">{t('mypage.roleTraveler')}</Text>
                </View>
                <Button variant="hanji" labelWeight="medium" shape="xl" paddingX={20} icon={Edit2} label={t('mypage.editProfile')} onPress={() => setEditing(true)} />
              </Card>

              <View className="mb-[16px] flex-row gap-[12px]">
                <Card
                  onPress={() => go('/saved')}
                  accessibilityLabel={`${t('mypage.statSaved')} ${profile.saved}`}
                  padded={false}
                  className="flex-1 flex-row items-center justify-center"
                  style={{ padding: 16, gap: statGap }}
                >
                  <Icon icon={Bookmark} size={20} color="terracotta" fill="currentColor" />
                  <Text className="text-xl" weight="bold" style={{ fontVariant: ['tabular-nums'] }}>{profile.saved}</Text>
                  <Text className="shrink text-xs text-muk-soft" weight="medium" numberOfLines={1}>{t('mypage.statSaved')}</Text>
                </Card>
                <Card
                  accessible
                  accessibilityLabel={`${t('mypage.statVisited')} ${profile.visited}`}
                  padded={false}
                  className="flex-1 flex-row items-center justify-center"
                  style={{ padding: 16, gap: statGap }}
                >
                  <Icon icon={Footprints} size={20} color="jade" />
                  <Text className="text-xl" weight="bold" style={{ fontVariant: ['tabular-nums'] }}>{profile.visited}</Text>
                  <Text className="shrink text-xs text-muk-soft" weight="medium" numberOfLines={1}>{t('mypage.statVisited')}</Text>
                </Card>
              </View>

              {waitSaved > 0 ? (
                <Card
                  onPress={() => go('/mypage/impact')}
                  accessibilityLabel={t('mypage.savedBanner', { n: waitSaved })}
                  padded={false}
                  className="mb-[16px] mt-[12px] flex-row items-center gap-[12px] overflow-hidden border-gold/30 bg-hanji"
                  style={{ paddingHorizontal: 16, paddingVertical: 14 }}
                >
                  <Gradient name="savedBanner" style={StyleSheet.absoluteFill} pointerEvents="none" />
                  <Icon icon={Hourglass} size={22} color="gold-deep" />
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm leading-[19.25px]" weight="bold">{t('mypage.savedBanner', { n: waitSaved })}</Text>
                    <Text className="mt-[2px] text-[11px] text-muk-soft">{t('mypage.savedValue', { won: wageValueKrw(waitSaved).toLocaleString() })}</Text>
                  </View>
                </Card>
              ) : null}

              {/* 콘솔 입구 — 계정 판정이 끝난 뒤에만(웹 ConsoleEntries). 역할이 없으면 두 콘솔의 미리보기 하나. */}
              {accountStatus !== 'loading' ? (
                hasConsoleRole ? (
                  <View className="mb-[16px] gap-[12px]">
                    {canEnterMerchantConsole(account) ? <MerchantLinkCard url={`${WEB_ORIGIN}/merchant`} /> : null}
                    {canEnterAdminConsole(account) ? <AdminLinkCard url={`${WEB_ORIGIN}/admin/dashboard`} /> : null}
                  </View>
                ) : SHOW_CONSOLE_ENTRIES ? (
                  <View className="mb-[16px]">
                    <ConsolePreviewCard merchantUrl={consoleUrls.merchant} adminUrl={consoleUrls.admin} />
                  </View>
                ) : null
              ) : null}
            </View>
          )}

          {profile ? (
            <>
              <TasteRadar />
              {/* 웹: 위 그리드 아래 간격 mb-4 가 레이더 mb-4 에 더해진다 */}
              <View className="h-[16px]" />

              <AccountSection profile={profile} />

              {labCount !== null && labCount > 0 ? (
                <Card
                  onPress={() => go('/mypage/lab')}
                  accessibilityLabel={t('lab.cardCta', { count: labCount })}
                  padded={false}
                  className="mb-[16px] flex-row items-center justify-between gap-[16px] overflow-hidden rounded-3xl border-jade/35 bg-hanji"
                  style={{ padding: 20 }}
                >
                  <Gradient name="labCard" style={StyleSheet.absoluteFill} pointerEvents="none" />
                  <View className="min-w-0 flex-1 flex-row items-center gap-[16px]">
                    <View className="h-[44px] w-[44px] items-center justify-center rounded-2xl bg-jade/15">
                      <Icon icon={FlaskConical} size={22} color="jade" />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text weight="bold">{t('lab.cardTitle')}</Text>
                      <Text className="mt-[2px] text-xs leading-[19.5px] text-muk-soft">{t('lab.cardDesc')}</Text>
                      <Text className="mt-[6px] text-xs text-jade" weight="semibold">{t('lab.cardCta', { count: labCount })}</Text>
                    </View>
                  </View>
                  <Icon icon={ChevronRight} size={20} color="jade" />
                </Card>
              ) : null}

              <Card padded={false} className="mb-[24px] overflow-hidden rounded-3xl">
                {menus.map((menu, index) => (
                  <Pressable
                    key={menu.id}
                    accessibilityRole="button"
                    accessibilityLabel={menu.badge ? `${menu.label}, ${t('inquiries.newReplyBadge')} ${menu.badge}` : menu.label}
                    onPress={() => go(menu.path)}
                    className={`flex-row items-center justify-between p-[20px] ${index > 0 ? 'border-t border-line' : ''}`}
                  >
                    <View className="min-w-0 flex-1 flex-row items-center gap-[16px]">
                      <View className="h-[40px] w-[40px] items-center justify-center rounded-full bg-hanji-deep">
                        <Icon icon={menu.icon} size={20} color="muk-soft" />
                      </View>
                      <Text className="shrink leading-[24px]" weight="medium" numberOfLines={2}>{menu.label}</Text>
                      {menu.badge ? (
                        <View className="rounded-full bg-terracotta px-[8px] py-[2px]">
                          <Text className="text-[11px] text-white" weight="bold">{t('inquiries.newReplyBadge')} {menu.badge}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Icon icon={ChevronRight} size={20} color="muk-soft" />
                  </Pressable>
                ))}
              </Card>

              {roleEntry !== 'hidden' ? (
                <View className="mb-[16px]">
                  <RoleRequestCard pending={roleEntry === 'pending'} url={`${WEB_ORIGIN}/account/business`} />
                </View>
              ) : null}

              {showSignOut ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('mypage.signOut')}
                  onPress={() => { void onSignOut(); }}
                  className="mb-[16px] min-h-[58px] flex-row items-center justify-center gap-[8px] rounded-2xl border border-line"
                >
                  <Icon icon={LogOut} size={18} color="terracotta" />
                  <Text className="text-terracotta" weight="semibold">{t('mypage.signOut')}</Text>
                </Pressable>
              ) : null}

              <View className="flex-row items-center justify-center gap-[12px] pb-[8px]">
                <Pressable accessibilityRole="link" onPress={() => go('/mypage/privacy')} className="min-h-[44px] justify-center px-[4px]">
                  <Text className="text-xs text-muk-soft">{t('mypage.menuPrivacy')}</Text>
                </Pressable>
                <Text className="text-xs text-line" accessibilityElementsHidden importantForAccessibility="no">·</Text>
                <Pressable accessibilityRole="link" onPress={() => go('/mypage/support')} className="min-h-[44px] justify-center px-[4px]">
                  <Text className="text-xs text-muk-soft">{t('mypage.menuHelp')}</Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>

      <ProfileEditModal visible={editing} initialName={profile?.name ?? t('mypage.guestName')} onClose={() => setEditing(false)} onSave={onSaveName} />
    </Screen>
  );
}
