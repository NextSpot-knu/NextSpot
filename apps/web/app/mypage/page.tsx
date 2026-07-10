'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Menu, Bell, Home, Bookmark, User,
  Edit2, ChevronRight, LogOut,
  Settings as SettingsIcon, BellRing, Route, Ticket, X
} from 'lucide-react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import TasteRadar from '@/components/TasteRadar';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT } from '@/lib/i18n/I18nProvider';

interface UserProfile {
  name: string;
  email: string;
  role: string;
  routes: number;
  saved: number;
  rating: number;
  alertEnabled: boolean;
}

export default function MyPage() {
  const router = useRouter();
  const t = useT();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // 프로필 수정 인라인 모달 — 표시 이름을 이 기기(localStorage)에만 저장한다(백엔드 없음).
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [nameInput, setNameInput] = useState('');

  useEffect(() => {
    // API Fetch Mockup
    // ⚠️ 백엔드 데이터 하드코딩 금지 원칙 준수 (실제로는 API에서 가져옴)
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
        try {
          const supabase = createPublicClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (user?.email) {
            displayEmail = user.email;
            // 이메일 앞부분(@ 이전)을 표시 이름으로 사용
            displayName = user.email.split('@')[0];
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
          alertEnabled: true,
        });
      } catch (error) {
        console.warn('Failed to fetch profile', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchProfile();
  }, []);

  const handleUpdateProfile = async (updatedData: Partial<UserProfile>) => {
    // TODO: 프로필 수정 / 설정 변경 API 연동 로직
    /*
    try {
      await fetch('/api/user/profile', {
        method: 'PATCH', // or PUT
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedData)
      });
      // 업데이트 성공 처리
    } catch (error) {
      console.warn(error);
    }
    */
    
    // 로컬 상태 즉시 업데이트 (Optimistic UI)
    if (profile) {
      setProfile({ ...profile, ...updatedData });
    }
  };

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

  // 로그아웃: 세션을 종료한 뒤 루트로 이동한다(목/비로그인 세션이어도 안전하게 폴백).
  const handleSignOut = async () => {
    try {
      const supabase = createPublicClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('Sign out failed', err);
    } finally {
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
          // 프로필 블록 + 취향 레이더 + 통계 형태의 스켈레톤(스피너 대체) — 실제 레이아웃을 암시한다.
          <div className="flex flex-col mt-4" aria-hidden>
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
          <div className="flex flex-col animate-fade-in mt-4">
            
            {/* Profile Section */}
            <div className="bg-white border border-line rounded-3xl p-6 flex flex-col items-center shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4">
              <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-gold to-terracotta p-0.5 mb-4">
                <div className="w-full h-full rounded-full overflow-hidden bg-hanji">
                  {/* 기본 아바타 */}
                  <div className="w-full h-full flex items-center justify-center text-gold">
                    <User size={40} />
                  </div>
                </div>
              </div>
              <h2 className="text-2xl font-bold font-serif text-muk mb-1">{profile.name}</h2>
              <p className="text-sm text-muk-soft mb-4">{profile.email}</p>

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

            {/* AI 취향 프로필 — 8차원 선호 벡터 레이더 시각화 (관광객용 친화 시각화).
                과거 개발자용 원시 float 배열 카드는 제거하고 TasteRadar 만 남긴다. */}
            <TasteRadar />

            {/* 통계 — 실제 소스가 있는 '저장한 장소'만 표시(가짜 경로수·평점 제거). */}
            <div className="mb-6 mt-4">
              <div className="bg-white border border-line rounded-2xl p-4 flex items-center justify-center gap-3 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
                <Bookmark size={20} className="text-terracotta" fill="currentColor" />
                <span className="text-xl font-bold text-muk">{profile.saved}</span>
                <span className="text-xs text-muk-soft font-medium">{t('mypage.statSaved')}</span>
              </div>
            </div>

            {/* Menu List */}
            <div className="bg-white border border-line rounded-3xl overflow-hidden shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-6">

              {/* 이상 혼잡 알림 토글 */}
              <div className="flex items-center justify-between p-5 border-b border-line">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-hanji-deep flex items-center justify-center">
                    <BellRing size={20} className="text-muk-soft" />
                  </div>
                  <span className="text-muk font-medium">{t('mypage.alertMenu')}</span>
                </div>
                {/* 토글 스위치 */}
                <button
                  onClick={() => handleUpdateProfile({ alertEnabled: !profile.alertEnabled })}
                  className={`w-12 h-6 rounded-full p-1 transition-colors ${profile.alertEnabled ? 'bg-gold' : 'bg-muk-soft/40'}`}
                >
                  <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${profile.alertEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* 기타 메뉴 */}
              {(() => {
                const menus = [
                  { id: 'course', icon: Route, labelKey: 'mypage.menuCourse', path: '/course' },
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
