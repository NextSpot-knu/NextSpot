'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, MapPin, Building, Utensils, Coffee, Pizza, Soup, Sun, Sunset, Moon, ArrowRight } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';

// setup 은 카테고리를 한국어 라벨로 저장하지만, explore/recommend 온보딩과 main 추천은 캐노니컬 키를
// 쓴다. 두 온보딩 경로를 하나의 소스(Supabase users.preferred_categories)로 수렴시키기 위한 라벨→키 매핑.
const CATEGORY_LABEL_TO_KEY: Record<string, string> = {
  '음식점': 'restaurant',
  '카페': 'cafe',
  '관광지': 'attraction',
  '문화시설': 'culture',
};

export default function SetupPage() {
  const router = useRouter();

  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false); // 최종 제출(Supabase 쓰기) 중 이중 제출 방지
  const [preferences, setPreferences] = useState({
    category: '',
    food: '',
    visitTime: ''
  });

  const totalSteps = 3;

  const stepKey = (step === 1 ? 'category' : step === 2 ? 'food' : 'visitTime') as keyof typeof preferences;
  const canProceed = !!preferences[stepKey];

  const handleNext = async () => {
    // 현재 단계 선택값이 비어 있으면 진행 차단(빈 온보딩으로 그대로 넘어가는 UX 결함 방지).
    if (!canProceed) return;
    if (step < totalSteps) {
      setStep(step + 1);
      return;
    }

    // 마지막 단계 제출: Supabase 쓰기 대기 동안 버튼 재클릭으로 중복 저장되는 것을 막는다.
    if (isSubmitting) return;
    setIsSubmitting(true);

    // 온보딩 선호(관심 카테고리·음식 취향·방문 시간대)를 저장 → main 추천의 선호 일치율·음식 의도에 반영(localStorage).
    try { localStorage.setItem('nextspot_setup_prefs', JSON.stringify(preferences)); } catch { /* noop */ }

    // B3 온보딩 단일화: setup 의 관심 카테고리도 explore/recommend 온보딩과 동일하게 Supabase
    // users.preferred_categories(캐노니컬 키)로 수렴시킨다. localStorage 는 음식/시간 의도 전용으로 유지.
    try {
      const supabase = createPublicClient();
      const { data: { user } } = await supabase.auth.getUser();
      const categoryKey = CATEGORY_LABEL_TO_KEY[preferences.category];
      // 로그인 세션 + 매핑 가능한 카테고리일 때만 DB 반영(비로그인/목 세션은 조용히 건너뜀 → localStorage 만 저장, 회귀 없음).
      if (user && categoryKey) {
        const { data: profile } = await supabase
          .from('users')
          .select('preferred_categories')
          .eq('id', user.id)
          .single();
        // 기존 preferred_categories 를 조회해 합집합으로 병합(1개 선택이 기존 학습을 덮어써 날리지 않도록).
        const existing: string[] = Array.isArray(profile?.preferred_categories) ? profile.preferred_categories : [];
        const merged = existing.includes(categoryKey) ? existing : [...existing, categoryKey];
        const { error } = await supabase
          .from('users')
          .update({ preferred_categories: merged })
          .eq('id', user.id);
        if (error) console.warn('setup preferred_categories 병합 저장 실패(목 세션에서 흔함):', error);
      }
    } catch (err) {
      // 저장이 실패해도 온보딩 흐름을 끊지 않는다(데모 무중단).
      console.warn('setup 카테고리 Supabase 반영 건너뜀:', err);
    }

    // 저장 성공/실패와 무관하게 최종적으로 main 으로 이동.
    router.push('/main');
  };

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1);
    } else {
      router.push('/');
    }
  };

  const setPreference = (key: keyof typeof preferences, value: string) => {
    setPreferences(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-b from-[#0b101e] via-[#0d1526] to-[#070b16] text-white relative overflow-hidden">
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-[#0b101e]/70 z-0"></div>

      {/* Background Glow */}
      <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-blue-500/10 rounded-full blur-[120px] pointer-events-none z-0"></div>

      {/* Header & Progress */}
      <div className="z-10 w-full max-w-md mx-auto pt-8 px-6">
        <button
          onClick={handleBack}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors mb-6"
        >
          <ArrowLeft size={20} />
        </button>

        <div className="w-full h-1.5 bg-gray-800 rounded-full mb-6 overflow-hidden">
          <div
            className="h-full bg-blue-600 transition-all duration-500 ease-out"
            style={{ width: `${(step / totalSteps) * 100}%` }}
          />
        </div>

        <p className="text-sm text-gray-400 mb-12">
          환영합니다! 맞춤형 경주 여행 추천을 위해 취향을 알려주세요.
        </p>
      </div>

      {/* Content Area */}
      <div className="flex-1 w-full max-w-md mx-auto relative z-10 flex flex-col">
        {step === 1 && (
          <div className="animate-slide-up flex-1">
            <h2 className="text-2xl font-bold mb-8 text-center break-keep">
              어떤 장소에<br/>가장 관심이 있으세요?
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {[
                { id: 'restaurant', label: '음식점', icon: Utensils },
                { id: 'cafe', label: '카페', icon: Coffee },
                { id: 'attraction', label: '관광지', icon: MapPin },
                { id: 'culture', label: '문화시설', icon: Building }
              ].map(option => {
                const Icon = option.icon;
                const isSelected = preferences.category === option.label;
                return (
                  <button
                    key={option.id}
                    onClick={() => setPreference('category', option.label)}
                    className={`flex flex-col items-center justify-center p-6 rounded-2xl border backdrop-blur-md transition-all ${
                      isSelected
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-white/5 border-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200'
                    }`}
                  >
                    <Icon size={32} className="mb-3" />
                    <span className="font-semibold">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="animate-slide-up flex-1">
            <h2 className="text-2xl font-bold mb-8 text-center break-keep">
              어떤 음식을<br/>좋아하세요?
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {[
                { id: 'korean', label: '한식', icon: Soup },
                { id: 'snack', label: '분식·국밥', icon: Utensils },
                { id: 'western', label: '양식', icon: Pizza },
                { id: 'dessert', label: '카페·디저트', icon: Coffee }
              ].map(option => {
                const Icon = option.icon;
                const isSelected = preferences.food === option.label;
                return (
                  <button
                    key={option.id}
                    onClick={() => setPreference('food', option.label)}
                    className={`flex flex-col items-center justify-center p-6 rounded-2xl border backdrop-blur-md transition-all ${
                      isSelected
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-white/5 border-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200'
                    }`}
                  >
                    <Icon size={32} className="mb-3" />
                    <span className="font-semibold">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="animate-slide-up flex-1">
            <h2 className="text-2xl font-bold mb-8 text-center break-keep">
              주로 언제<br/>여행을 즐기세요?
            </h2>
            <div className="flex flex-col gap-4">
              {[
                { id: 'morning', label: '오전', sub: '한적한 아침', icon: Sun },
                { id: 'afternoon', label: '오후', sub: '활기찬 한낮', icon: Sunset },
                { id: 'evening', label: '저녁', sub: '노을·야경', icon: Moon },
              ].map(option => {
                const Icon = option.icon;
                const isSelected = preferences.visitTime === option.label;
                return (
                  <button
                    key={option.id}
                    onClick={() => setPreference('visitTime', option.label)}
                    className={`flex items-center p-6 rounded-2xl border backdrop-blur-md transition-all ${
                      isSelected
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-white/5 border-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200'
                    }`}
                  >
                    <div className="w-12 h-12 flex items-center justify-center rounded-full bg-white/5 mr-4">
                      <Icon size={24} className={isSelected ? 'text-yellow-400' : ''} />
                    </div>
                    <div className="text-left flex-1">
                      <div className="font-semibold text-lg">{option.label}</div>
                      <div className="text-sm opacity-60 mt-1">{option.sub}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Action Button */}
        <div className="mt-8 pb-8">
          <button
            onClick={handleNext}
            disabled={!canProceed || isSubmitting}
            className="w-full flex items-center justify-center py-4 rounded-xl bg-[#0a3d91] hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
          >
            {step === totalSteps ? (isSubmitting ? '저장 중...' : '시작하기') : '다음'}
            {step !== totalSteps && <ArrowRight size={20} className="ml-2" />}
          </button>
        </div>
      </div>
    </div>
  );
}
