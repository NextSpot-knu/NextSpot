'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, MapPin, Building, Utensils, Coffee, Pizza, Soup, Sun, Sunset, Moon, ArrowRight } from 'lucide-react';

export default function SetupPage() {
  const router = useRouter();

  const [step, setStep] = useState(1);
  const [preferences, setPreferences] = useState({
    category: '',
    food: '',
    visitTime: ''
  });

  const totalSteps = 3;

  const stepKey = (step === 1 ? 'category' : step === 2 ? 'food' : 'visitTime') as keyof typeof preferences;
  const canProceed = !!preferences[stepKey];

  const handleNext = () => {
    // 현재 단계 선택값이 비어 있으면 진행 차단(빈 온보딩으로 그대로 넘어가는 UX 결함 방지).
    if (!canProceed) return;
    if (step < totalSteps) {
      setStep(step + 1);
    } else {
      // 온보딩 선호(관심 카테고리·음식 취향·방문 시간대)를 저장 → main 추천의 선호 일치율·음식 의도에 반영(localStorage).
      // (카테고리 학습은 explore/recommend 온보딩이 Supabase users.preferred_categories 로 별도 담당.)
      try { localStorage.setItem('nextspot_setup_prefs', JSON.stringify(preferences)); } catch { /* noop */ }
      router.push('/main');
    }
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
    <div className="flex flex-col min-h-screen bg-[url('/bg.png')] bg-cover bg-center text-white relative overflow-hidden">
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
            disabled={!canProceed}
            className="w-full flex items-center justify-center py-4 rounded-xl bg-[#0a3d91] hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
          >
            {step === totalSteps ? '시작하기' : '다음'}
            {step !== totalSteps && <ArrowRight size={20} className="ml-2" />}
          </button>
        </div>
      </div>
    </div>
  );
}
