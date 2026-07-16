'use client';

import dynamic from 'next/dynamic';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Menu, Bell, Bookmark, User,
  Edit2, ChevronRight, LogOut,
  Settings as SettingsIcon, Ticket, X, Footprints, Sparkles, Hourglass, Store, FlaskConical
} from 'lucide-react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import { apiClient, isAuthError, fetchLabPendingCount } from '@/lib/api-client';
import { getVisitCount } from '@/lib/visits';
import { clearUserScopedData } from '@/lib/userData';
const TasteRadar = dynamic(() => import('@/components/TasteRadar'), { ssr: false });
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { CongestionAlertToggle } from '@/components/CongestionAlertToggle';
import { AccountSection } from '@/components/AccountSection';
import { useT } from '@/lib/i18n/I18nProvider';

// 2026년 최저시급(고용노동부 고시, 원/시간) — '아낀 시간'을 기회비용으로 환산하는 기준.
// 화면에도 '최저시급 기준'을 명시한다(정직성 — 임의 환산이 아님을 알림).
const MIN_WAGE_KRW_PER_HOUR = 10320;

interface UserProfile {
  name: string;
  email: string;
  role: string;
  routes: number;
  saved: number;
  rating: number;
  avatar: string | null;
}

export default function MyPage() {
  const router = useRouter();
  const t = useT();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // 프로필 수정 인라인 모달 — 표시 이름을 이 기기(localStorage)에만 저장한다(백엔드 없음).
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [nameInput, setNameInput] = useState('');
  // 방문한 곳 수 — 방문 확인 루프(nextspot_visit_history)의 실데이터. 하드코딩 0 통계와 분리한 새 실통계.
  const [visitCount, setVisitCount] = useState(0);
  useEffect(() => {
    try { setVisitCount(getVisitCount()); } catch { /* localStorage 차단 무시 */ }
  }, []);

  // 아낀 대기 시간(분) — 임팩트 API의 누적 집계(수락 추천들의 대기 절약 합, score_breakdown 실저장값).
  // 백엔드 미가용/무세션이면 타일을 숨긴다(null 유지 — 가짜 0 적립을 보여주지 않는 정직성).
  // 첫 실패는 익명 세션 부트스트랩 레이스일 수 있어 2.5초 유예 1회 재시도(waiting/impact 와 동일 패턴).
  const [waitSaved, setWaitSaved] = useState<number | null>(null);
  useEffect(() => {
    let retried = false;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiClient.get('/api/v1/impact/summary');
        if (alive) setWaitSaved(Math.max(0, Math.round(Number(d?.waitSavedMinutes) || 0)));
      } catch {
        if (!retried) { retried = true; setTimeout(() => { void load(); }, 2500); }
      }
    };
    void load();
    return () => { alive = false; };
  }, []);

  // 나의 실험실 미응답 건수 — 실데이터(GET /api/v1/lab/pending/count)만 표시한다.
  // 조회 실패(서버 장애·401)면 null 을 유지해 카드를 아예 숨긴다 — 가짜 숫자·가짜 배지 금지(감사 계약 11).
  // 0건이면 다듬을 기록이 없다는 뜻이므로 역시 노출하지 않는다.
  // 첫 실패는 익명 세션 부트스트랩 레이스일 수 있어 2.5초 유예 1회 재시도(위 impact 타일과 동일 패턴).
  const [labPendingCount, setLabPendingCount] = useState<number | null>(null);
  useEffect(() => {
    let retried = false;
    let alive = true;
    const load = async () => {
      try {
        const count = await fetchLabPendingCount();
        if (alive) setLabPendingCount(Math.max(0, Math.round(Number(count) || 0)));
      } catch (err) {
        // 401 은 서버 장애가 아니다 — 재시도해도 성공할 수 없으므로 카드를 숨긴 채 종료(무한 재시도 금지).
        if (isAuthError(err)) return;
        if (!retried) { retried = true; setTimeout(() => { void load(); }, 2500); }
      }
    };
    void load();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const fetchProfile = async () => {
      setIsLoading(true);
      try {
        // TODO: 실제 API 호출 로직으로 교체 예정
        // const response = await fetch('/api/user/profile');
        // const data = await response.json();
        // setProfile(data);

        // 프로필명/이메일은 하드코딩 실명 대신 로그인 세션에서 파생한다.
        // 비로그인·목 세션이면 user 가 null 이므로 명확한 플레이스홀더로 폴백(회귀 없이 데모 무중단).
        let displayName = t('mypage.guestName');
        let displayEmail = 'guest@nextspot.app';
        let avatar: string | null = null;
        try {
          const supabase = createPublicClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (user?.email) {
            displayEmail = user.email;
            // 이메일 앞부분(@ 이전)을 표시 이름으로 사용
            displayName = user.email.split('@')[0];
          }
          // OAuth 연동 사용자면 public.users 의 nickname/avatar_url(트리거·백필로 채워짐)을 우선 사용한다.
          if (user) {
            const { data: profileRow } = await supabase
              .from('users')
              .select('nickname, avatar_url')
              .eq('id', user.id)
              .single();
            if (profileRow?.nickname) displayName = profileRow.nickname;
            if (profileRow?.avatar_url) avatar = profileRow.avatar_url;
          }
        } catch (authErr) {
          console.warn('Failed to fetch session user in mypage', authErr);
        }

        // 사용자가 프로필 수정에서 지정한 표시 이름이 있으면 세션·게스트 파생값보다 우선한다(이 기기 한정).
        try {
          const storedName = localStorage.getItem('nextspot_display_name');
          if (storedName && storedName.trim()) {
            displayName = storedName.trim();
          }
        } catch {
          /* localStorage 차단 환경 — 파생 이름 유지 */
        }

        // 저장한 장소 수는 localStorage 북마크에서 실제 값을 파생한다(가짜 통계 제거).
        let savedCount = 0;
        try {
          const raw = localStorage.getItem('nextspot_saved_facilities');
          if (raw) {
            const arr = JSON.parse(raw);
            savedCount = Array.isArray(arr) ? arr.length : 0;
          }
        } catch {
          /* 파싱 실패 시 0 */
        }

        // 실제 소스가 있는 항목만 채운다(경로수·평점은 소스가 없어 0 → 통계에서 미표시).
        setProfile({
          name: displayName,
          email: displayEmail,
          role: 'Explorer',
          routes: 0,
          saved: savedCount,
          rating: 0,
          avatar,
        });
      } catch (error) {
        console.warn('Failed to fetch profile', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchProfile();
  }, []);

  // 프로필 수정 모달 열기 — 현재 표시 이름을 입력값 초기값으로 채운다.
  const handleOpenEdit = () => {
    setNameInput(profile?.name ?? '');
    setIsEditOpen(true);
  };

  // 표시 이름 저장 — 공백만 입력하면 무시하고, localStorage 에 저장 후 낙관적 업데이트한다.
  const handleSaveProfile = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem('nextspot_display_name', trimmed);
    } catch {
      /* localStorage 차단 환경 — 화면 상태만 갱신 */
    }
    setProfile((prev) => (prev ? { ...prev, name: trimmed } : prev));
    setIsEditOpen(false);
    toast.success(t('mypage.editNameSaved'));
  };

  // 로그아웃: 세션을 종료하고 이 기기에 남은 개인 데이터(저장 장소·취향·방문 등)를 지운 뒤 루트로 이동.
  // (localStorage 는 기기 단위라 지우지 않으면 다음 사용자에게 데이터가 샌다 — lib/userData.)
  const handleSignOut = async () => {
    try {
      const supabase = createPublicClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('Sign out failed', err);
    } finally {
      clearUserScopedData();
      toast.success(t('mypage.signedOut'));
      router.push('/');
    }
  };



  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex justify-between items-center p-5 z-10 relative">
        <button
          type="button"
          aria-label={t('mypage.menuAria')}
          onClick={() => router.push('/mypage/settings')}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <Menu size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">NextSpot</h1>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <button
            type="button"
            aria-label={t('mypage.bellAria')}
            onClick={() => router.push('/mypage/settings')}
            className="text-muk-soft hover:text-muk transition-colors"
          >
            <Bell size={24} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative z-10 px-6 overflow-y-auto pb-[calc(80px+env(safe-area-inset-bottom))] md:pb-6 no-scrollbar">
        {isLoading || !profile ? (
          // 프로필 블록 + 취향 레이더 + 통계 형태의 스켈레톤(스피너 대체) — 실제 콘텐츠와 동일한 중앙정렬 폭으로 폭 점프 최소화.
          <div className="flex flex-col mt-4 md:max-w-4xl md:mx-auto md:w-full" aria-hidden>
            {/* Profile 스켈레톤 */}
            <div className="bg-white border border-line rounded-3xl p-6 flex flex-col items-center shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4 animate-pulse">
              <div className="w-20 h-20 rounded-full bg-hanji-deep mb-4" />
              <div className="h-6 bg-hanji-deep w-1/3 rounded-md mb-2" />
              <div className="h-4 bg-hanji-deep w-1/2 rounded-md mb-4" />
              <div className="h-6 bg-hanji-deep w-24 rounded-full" />
            </div>
            {/* 취향 레이더 스켈레톤 */}
            <div className="bg-white border border-line rounded-3xl p-6 flex flex-col items-center shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4 animate-pulse">
              <div className="h-4 bg-hanji-deep w-2/5 rounded-md mb-4" />
              <div className="w-40 h-40 rounded-full bg-hanji-deep/60" />
            </div>
            {/* 통계 스켈레톤 */}
            <div className="bg-white border border-line rounded-2xl p-4 flex items-center justify-center gap-3 shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-6 animate-pulse">
              <div className="h-6 bg-hanji-deep w-24 rounded-md" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col animate-fade-in mt-4 md:max-w-4xl md:mx-auto md:w-full">

            {/* PC(md+) 2단: 왼쪽=프로필+통계 / 오른쪽=AI 취향 프로필. 모바일은 세로 스택(순서 유지). */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:items-start mb-4 md:mb-6">
              {/* 왼쪽 열 — 프로필 + 통계. min-w-0: 긴 이메일 파생 이름이 grid 트랙을 밀어내지 않게. */}
              <div className="flex flex-col gap-4 min-w-0">
                {/* Profile Section */}
                <div className="bg-white border border-line rounded-3xl p-6 flex flex-col items-center shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-gold to-terracotta p-0.5 mb-4">
                    <div className="w-full h-full rounded-full overflow-hidden bg-hanji">
                      {/* OAuth 연동 시 프로바이더 아바타, 아니면 기본 아이콘 */}
                      {profile.avatar ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={profile.avatar} alt={profile.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gold">
                          <User size={40} />
                        </div>
                      )}
                    </div>
                  </div>
                  <h2 className="text-2xl font-bold font-serif text-muk mb-1 break-words max-w-full text-center">{profile.name}</h2>
                  <p className="text-sm text-muk-soft mb-4 break-all max-w-full text-center">{profile.email}</p>

                  <div className="px-4 py-1 rounded-full bg-gold/15 border border-gold/30 text-gold-deep text-xs font-semibold mb-6">
                    {profile.role}
                  </div>

                  <button
                    type="button"
                    onClick={handleOpenEdit}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-line bg-hanji hover:bg-hanji-deep text-muk text-sm font-medium transition-colors"
                  >
                    <Edit2 size={14} />
                    <span>{t('mypage.editProfile')}</span>
                  </button>
                </div>

                {/* 통계 — 실제 소스가 있는 항목만 표시(가짜 경로수·평점 제거). 저장 + 방문(방문 확인 루프)
                    + 아낀 시간(임팩트 API 누적, 로드 성공 시에만 3열로 확장 — 실패 시 가짜 0 미노출). */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => router.push('/saved')}
                    aria-label={`${t('mypage.statSaved')} ${profile.saved}`}
                    className="bg-white border border-line rounded-2xl p-4 flex items-center justify-center gap-3 max-[420px]:gap-1.5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors hover:bg-hanji-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
                  >
                    <Bookmark size={20} className="text-terracotta shrink-0" fill="currentColor" />
                    <span className="text-xl font-bold text-muk">{profile.saved}</span>
                    <span className="text-xs text-muk-soft font-medium whitespace-nowrap">{t('mypage.statSaved')}</span>
                  </button>
                  <div className="bg-white border border-line rounded-2xl p-4 flex items-center justify-center gap-3 max-[420px]:gap-1.5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
                    <Footprints size={20} className="text-jade shrink-0" />
                    <span className="text-xl font-bold text-muk">{visitCount}</span>
                    <span className="text-xs text-muk-soft font-medium whitespace-nowrap">{t('mypage.statVisited')}</span>
                  </div>
                </div>

                {/* 아낀 시간 가치 배너 — 절약 시간을 기회비용(최저시급 환산)으로 번역해 체감시킨다.
                    환산 기준은 화면에 명시(정직성). 탭하면 임팩트 카드 상세로.
                    0분이어도 숨기지 않는다(PM 지시): 신규 사용자에게 배너 자체가 '쓸수록 시간이 줄어든다'는
                    가치 제안이다. 다만 0분에 기회비용(0원)을 환산해 보여주면 무의미하므로 격려 문구로 대체한다.
                    ⚠️ null(임팩트 API 실패)일 때만 숨긴다 — 근거 없는 0 적립을 지어내지 않는 정직성. */}
                {waitSaved !== null && (
                  <button
                    type="button"
                    onClick={() => router.push('/mypage/impact')}
                    aria-label={waitSaved > 0 ? t('mypage.savedBanner', { n: waitSaved }) : t('mypage.savedBannerZero')}
                    className="w-full mt-3 bg-gradient-to-r from-gold/15 via-hanji-deep/60 to-jade/10 border border-gold/30 rounded-2xl px-4 py-3.5 flex items-center gap-3 text-left shadow-[0_2px_14px_rgba(43,35,32,0.06)] hover:from-gold/25 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                  >
                    <Hourglass size={22} className="text-gold-deep shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-muk leading-snug">
                        {waitSaved > 0 ? t('mypage.savedBanner', { n: waitSaved }) : t('mypage.savedBannerZero')}
                      </span>
                      <span className="block text-[11px] text-muk-soft mt-0.5">
                        {waitSaved > 0
                          ? t('mypage.savedValue', { won: (Math.round((waitSaved * MIN_WAGE_KRW_PER_HOUR) / 60 / 10) * 10).toLocaleString() })
                          : t('mypage.savedValueZero')}
                      </span>
                    </span>
                  </button>
                )}
              </div>

              {/* 오른쪽 열 — AI 취향 프로필(8차원 선호 벡터 레이더). 과거 개발자용 float 배열 카드는 제거. */}
              <div className="min-w-0">
                <TasteRadar />
              </div>
            </div>

            {/* 계정 — 게스트면 소셜 연동 유도, 연동됐으면 프로바이더 뱃지(OAUTH_PLAN F5). */}
            <AccountSection />

            {/* 혼잡 알림 — 실제 동작하는 옵트인 토글(권한 상태 반영, useCongestionAlerts 기반).
                로컬 state 만 바꾸던 가짜 스위치 제거. */}
            <div className="mb-4">
              <CongestionAlertToggle />
            </div>

            {/* 나의 실험실 진입 카드 — 거절한 추천의 이유를 되짚어 다음 추천을 조율한다.
                건수가 실제로 조회된 경우(> 0)에만 노출한다: 조회 실패(null)면 카드 자체를 숨겨
                '0건'이나 임의 숫자를 지어내지 않는다. */}
            {labPendingCount !== null && labPendingCount > 0 && (
              <button
                type="button"
                onClick={() => router.push('/mypage/lab')}
                aria-label={t('lab.cardCta', { count: labPendingCount })}
                className="group w-full mb-4 rounded-3xl border border-jade/35 bg-gradient-to-r from-jade/12 via-white to-gold/10 p-5 text-left shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors hover:border-jade/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-jade/15 text-jade">
                      <FlaskConical size={22} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-muk">{t('lab.cardTitle')}</p>
                      <p className="mt-0.5 text-xs text-muk-soft leading-relaxed">{t('lab.cardDesc')}</p>
                      <p className="mt-1.5 text-xs font-semibold text-jade">
                        {t('lab.cardCta', { count: labPendingCount })}
                      </p>
                    </div>
                  </div>
                  <ChevronRight size={20} className="shrink-0 text-jade transition-transform group-hover:translate-x-0.5" />
                </div>
              </button>
            )}

            {/* 관광객 계정과 분리된 사장님 콘솔 진입점. 실제 전환이 아니라 별도 비즈니스
                게이트로 이동하므로 문구에도 '사장님 콘솔'을 명시한다. */}
            <button
              type="button"
              onClick={() => router.push('/merchant')}
              className="group w-full mb-4 rounded-3xl border border-gold/35 bg-gradient-to-r from-gold/15 via-white to-terracotta/10 p-5 text-left shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors hover:border-gold/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gold/15 text-gold-deep">
                    <Store size={22} />
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-muk">비즈니스 계정으로 전환</p>
                    <p className="mt-0.5 text-xs text-muk-soft">가게 성과·타임세일·좌석 상태를 관리하는 사장님 콘솔</p>
                  </div>
                </div>
                <ChevronRight size={20} className="shrink-0 text-gold-deep transition-transform group-hover:translate-x-0.5" />
              </div>
            </button>

            {/* Menu List */}
            <div className="bg-white border border-line rounded-3xl overflow-hidden shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-6">

              {/* 기타 메뉴 */}
              {(() => {
                const menus = [
                  // 분산 코스 추천은 주 내비게이션 바로 승격됨(홈-저장-분산코스-마이).
                  { id: 'impact', icon: Sparkles, labelKey: 'mypage.menuImpact', path: '/mypage/impact' },
                  { id: 'coupons', icon: Ticket, labelKey: 'mypage.menuCoupons', path: '/mypage/coupons' },
                  { id: 'settings', icon: SettingsIcon, labelKey: 'mypage.menuSettings', path: '/mypage/settings' },
                ];
                return menus.map((menu, index) => {
                const Icon = menu.icon;
                return (
                  <button
                    key={menu.id}
                    type="button"
                    onClick={() => router.push(menu.path)}
                    className={`w-full flex items-center justify-between p-5 hover:bg-hanji transition-colors ${index !== menus.length - 1 ? 'border-b border-line' : ''}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-hanji-deep flex items-center justify-center">
                        <Icon size={20} className="text-muk-soft" />
                      </div>
                      <span className="text-muk font-medium">{t(menu.labelKey)}</span>
                    </div>
                    <ChevronRight size={20} className="text-muk-soft" />
                  </button>
                );
                });
              })()}
            </div>

            {/* Sign Out Button */}
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl border border-line bg-transparent hover:bg-hanji-deep text-muk-soft font-semibold transition-colors mb-4"
            >
              <LogOut size={18} className="text-terracotta" />
              <span className="text-terracotta">{t('mypage.signOut')}</span>
            </button>

            {/* 보조 링크 — 개인정보·고객지원은 메인 메뉴에서 분리해 작게 배치 */}
            <div className="flex items-center justify-center gap-3 text-xs text-muk-soft pb-2">
              <button type="button" onClick={() => router.push('/mypage/privacy')} className="hover:text-muk transition-colors">
                {t('mypage.menuPrivacy')}
              </button>
              <span className="text-line">·</span>
              <button type="button" onClick={() => router.push('/mypage/support')} className="hover:text-muk transition-colors">
                {t('mypage.menuHelp')}
              </button>
            </div>

          </div>
        )}
      </main>

      {/* 프로필 수정 인라인 모달 — 표시 이름만 이 기기에 저장(백엔드 없음). */}
      {isEditOpen && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-muk/40 backdrop-blur-sm px-6 animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-label={t('mypage.editNameTitle')}
          onClick={() => setIsEditOpen(false)}
        >
          <div
            className="w-full max-w-[360px] bg-white border border-line rounded-3xl p-6 shadow-[0_8px_32px_rgba(43,35,32,0.18)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Edit2 size={18} className="text-gold" />
                <h2 className="text-lg font-bold font-serif text-muk">{t('mypage.editNameTitle')}</h2>
              </div>
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={() => setIsEditOpen(false)}
                className="text-muk-soft hover:text-muk transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <label htmlFor="displayName" className="block text-sm font-semibold text-muk-soft mb-2">
              {t('mypage.editNameLabel')}
            </label>
            <input
              id="displayName"
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveProfile(); }}
              placeholder={t('mypage.editNamePlaceholder')}
              maxLength={20}
              autoFocus
              className="w-full bg-hanji border border-line text-muk placeholder:text-muk-soft/70 rounded-xl p-3.5 outline-none focus:border-gold transition-colors"
            />
            <p className="text-xs text-muk-soft mt-2">{t('mypage.editNameHint')}</p>

            <div className="flex gap-3 mt-6">
              <button
                type="button"
                onClick={() => setIsEditOpen(false)}
                className="flex-1 py-3 rounded-xl border border-line bg-hanji hover:bg-hanji-deep text-muk-soft font-semibold transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={!nameInput.trim()}
                className="flex-1 py-3 rounded-xl bg-gold hover:bg-gold-deep disabled:opacity-50 disabled:hover:bg-gold text-white font-bold transition-colors"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
