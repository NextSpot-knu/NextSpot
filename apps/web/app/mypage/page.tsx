'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Menu, Bell, Home, Bookmark, User, 
  Edit2, ChevronRight, LogOut, Shield, 
  HelpCircle, Settings as SettingsIcon, BellRing, Star, Sparkles
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { createPublicClient } from '@/lib/supabase';
import TasteRadar from '@/components/TasteRadar';

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
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [userVector, setUserVector] = useState<number[] | null>(null);

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
        let displayName = '게스트 탐험가';
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

        // UI 확인을 위한 임시 목업 상태 (통계 수치는 API 연동 전 목업, 이름/이메일은 세션 파생)
        setProfile({
          name: displayName,
          email: displayEmail,
          role: 'Explorer',
          routes: 24,
          saved: 7,
          rating: 4.9,
          alertEnabled: true,
        });

        // 8차원 사용자 선호도 벡터 조회
        try {
          const data = await apiClient.get('/api/v1/users/me/vector');
          if (data && data.vector) {
            setUserVector(data.vector);
          }
        } catch (vectorErr) {
          console.warn("Failed to fetch vector in mypage", vectorErr);
          // Fallback mockup vector
          setUserVector([0.45, 0.12, 0.35, 0.05, 0.61, 0.22, 0.10, 0.45]);
        }
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

  // 미구현 항목 공통 안내: 죽은 버튼이 무반응으로 보이지 않도록 '준비 중' 토스트를 띄운다.
  const handleComingSoon = () => {
    toast.info('준비 중인 기능이에요');
  };

  // 로그아웃: 세션을 종료한 뒤 루트로 이동한다(목/비로그인 세션이어도 안전하게 폴백).
  const handleSignOut = async () => {
    try {
      const supabase = createPublicClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('Sign out failed', err);
    } finally {
      toast.success('로그아웃되었습니다');
      router.push('/');
    }
  };



  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex justify-between items-center p-5 z-10 relative">
        <button
          type="button"
          aria-label="메뉴"
          onClick={handleComingSoon}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <Menu size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">NextSpot</h1>
        <button
          type="button"
          aria-label="알림"
          onClick={handleComingSoon}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <Bell size={24} />
        </button>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative z-10 px-6 overflow-y-auto pb-[120px] no-scrollbar">
        {isLoading || !profile ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin"></div>
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
                onClick={handleComingSoon}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-line bg-hanji hover:bg-hanji-deep text-muk text-sm font-medium transition-colors"
              >
                <Edit2 size={14} />
                <span>프로필 수정</span>
              </button>
            </div>

            {/* 8-Dimensional User Vector Embedding Card */}
            <div className="bg-white border border-line rounded-3xl p-6 shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4">
              <h3 className="text-sm font-bold text-gold-deep mb-3 tracking-wider flex items-center gap-2">
                <Sparkles size={16} />
                <span>8차원 선호도 벡터 임베딩 (실시간 강화학습 수치)</span>
              </h3>
              {userVector ? (
                <div className="space-y-3">
                  <div className="text-[11px] text-muk-soft bg-hanji p-3 rounded-xl border border-line font-mono select-all break-all leading-relaxed">
                    [{userVector.map(v => v.toFixed(4)).join(', ')}]
                  </div>
                  <div className="grid grid-cols-8 gap-1">
                    {userVector.map((val, idx) => (
                      <div key={idx} className="flex flex-col items-center gap-1">
                        <div className="w-full bg-hanji-deep rounded h-16 border border-line relative overflow-hidden">
                          <div
                            className="bg-gradient-to-t from-gold to-sunset-1 absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-500"
                            style={{ height: `${Math.max(0, Math.min(100, (val + 1) * 50))}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-muk-soft font-mono">D{idx+1}</span>
                        <span className="text-[8px] font-bold text-gold-deep font-mono">{val.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex justify-center py-4">
                  <div className="w-5 h-5 border-2 border-gold border-t-transparent rounded-full animate-spin"></div>
                </div>
              )}
            </div>

            {/* AI 취향 프로필 — 8차원 선호 벡터 레이더 시각화 (개인화 엔진 가시화) */}
            <TasteRadar />

            {/* Stats Section */}
            <div className="grid grid-cols-3 gap-3 mb-6">
              <div className="bg-white border border-line rounded-2xl p-4 flex flex-col items-center justify-center shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
                <div className="text-xl font-bold text-muk mb-1">{profile.routes}</div>
                <div className="text-xs text-muk-soft font-medium">경로</div>
              </div>
              <div className="bg-white border border-line rounded-2xl p-4 flex flex-col items-center justify-center shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
                <Bookmark size={20} className="text-terracotta mb-2" fill="currentColor" />
                <div className="text-xl font-bold text-muk mb-1">{profile.saved}</div>
                <div className="text-xs text-muk-soft font-medium">저장</div>
              </div>
              <div className="bg-white border border-line rounded-2xl p-4 flex flex-col items-center justify-center shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
                <Star size={20} className="text-gold mb-2" fill="currentColor" />
                <div className="text-xl font-bold text-muk mb-1">{profile.rating}</div>
                <div className="text-xs text-muk-soft font-medium">평점</div>
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
                  <span className="text-muk font-medium">이상 혼잡 알림</span>
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
              {[
                { id: 'privacy', icon: Shield, label: '개인정보', path: '#' },
                { id: 'help', icon: HelpCircle, label: '고객지원', path: '/mypage/support' },
                { id: 'settings', icon: SettingsIcon, label: '설정', path: '#' },
              ].map((menu, index) => {
                const Icon = menu.icon;
                return (
                  <button
                    key={menu.id}
                    type="button"
                    onClick={() => {
                      // 라우트가 없는(path:'#') 미구현 메뉴는 '준비 중' 안내, 나머지는 실제 이동.
                      if (menu.path === '#') { handleComingSoon(); return; }
                      router.push(menu.path);
                    }}
                    className={`w-full flex items-center justify-between p-5 hover:bg-hanji transition-colors ${index !== 2 ? 'border-b border-line' : ''}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-hanji-deep flex items-center justify-center">
                        <Icon size={20} className="text-muk-soft" />
                      </div>
                      <span className="text-muk font-medium">{menu.label}</span>
                    </div>
                    <ChevronRight size={20} className="text-muk-soft" />
                  </button>
                );
              })}
            </div>

            {/* Sign Out Button */}
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl border border-line bg-transparent hover:bg-hanji-deep text-muk-soft font-semibold transition-colors mb-4"
            >
              <LogOut size={18} className="text-terracotta" />
              <span className="text-terracotta">로그아웃</span>
            </button>

          </div>
        )}
      </main>


    </div>
  );
}
