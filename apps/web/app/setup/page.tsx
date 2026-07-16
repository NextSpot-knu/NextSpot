'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, MapPin, Building, Utensils, Coffee, Pizza, Soup, Sun, Sunset, Moon, ArrowRight, Plane, Clock, Compass, Link2 } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { getAuthState, linkOAuth, type OAuthProvider } from '@/lib/auth';
import { useT } from '@/lib/i18n/I18nProvider';

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
  const t = useT();

  // step 0: 여행 시점(tripStatus) — 기존 1~3(카테고리/음식/시간대) 앞에 추가.
  const [step, setStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false); // 최종 제출(Supabase 쓰기) 중 이중 제출 방지
  // 온보딩 완료 후 게스트에게 1회 소셜 계정 연동을 제안하는 오버레이(OAUTH_PLAN F4).
  const [showAccountOffer, setShowAccountOffer] = useState(false);
  const [offerBusy, setOfferBusy] = useState(false);
  const [preferences, setPreferences] = useState({
    tripStatus: '',
    category: '',
    food: '',
    visitTime: ''
  });

  const totalSteps = 4;

  // 건너뛰기 클릭 시 미선택 필드를 채울 기본값(하위호환: 기존 category/food/visitTime 형식 그대로 유지).
  const DEFAULT_PREFERENCES: typeof preferences = {
    tripStatus: 'browsing',
    category: '음식점',
    food: '한식',
    visitTime: '오전',
  };

  const stepKey = (step === 0 ? 'tripStatus' : step === 1 ? 'category' : step === 2 ? 'food' : 'visitTime') as keyof typeof preferences;
  const canProceed = !!preferences[stepKey];

  // 최종 저장(localStorage + Supabase 병합) 공통 로직 — '다음' 마지막 단계와 '건너뛰기' 양쪽에서 재사용.
  const finalize = async (finalPreferences: typeof preferences) => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    // 온보딩 선호(여행 시점·관심 카테고리·음식 취향·방문 시간대)를 저장 → main 추천의 선호 일치율·음식 의도에 반영(localStorage).
    try { localStorage.setItem('nextspot_setup_prefs', JSON.stringify(finalPreferences)); } catch { /* noop */ }

    // B3 온보딩 단일화: setup 의 관심 카테고리도 explore/recommend 온보딩과 동일하게 Supabase
    // users.preferred_categories(캐노니컬 키)로 수렴시킨다. localStorage 는 음식/시간/여행시점 의도 전용으로 유지.
    try {
      const supabase = createPublicClient();
      const { data: { user } } = await supabase.auth.getUser();
      const categoryKey = CATEGORY_LABEL_TO_KEY[finalPreferences.category];
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

    // 게스트(익명)면 계정 연동을 1회 제안한다. 이미 연동됐거나 세션 판별 실패면 바로 main 으로.
    try {
      const state = await getAuthState();
      if (state.status === 'guest') {
        setShowAccountOffer(true);
        return; // 오버레이의 '연동' 또는 '나중에'가 이후 이동을 담당.
      }
    } catch {
      /* 상태 판별 실패 시 제안 없이 진행 */
    }
    router.push('/main');
  };

  // 연동 제안 — 성공 시 브라우저가 리다이렉트되고 콜백이 /main 으로 복귀시킨다. 실패만 토스트로 안내.
  const handleOfferLink = async (provider: OAuthProvider) => {
    if (offerBusy) return;
    setOfferBusy(true);
    const { error } = await linkOAuth(provider, '/main');
    if (error) {
      setOfferBusy(false);
      toast.error(t('auth.linkError'));
    }
  };

  const handleNext = async () => {
    // 현재 단계 선택값이 비어 있으면 진행 차단(빈 온보딩으로 그대로 넘어가는 UX 결함 방지).
    if (!canProceed) return;
    if (step < totalSteps - 1) {
      setStep(step + 1);
      return;
    }

    // 마지막 단계 제출: Supabase 쓰기 대기 동안 버튼 재클릭으로 중복 저장되는 것을 막는다.
    await finalize(preferences);
  };

  // canProceed 게이트를 우회해 지금까지 선택값 + 미선택 필드는 기본값으로 즉시 저장하고 이동.
  const handleSkip = () => {
    if (isSubmitting) return;
    const finalPreferences = {
      tripStatus: preferences.tripStatus || DEFAULT_PREFERENCES.tripStatus,
      category: preferences.category || DEFAULT_PREFERENCES.category,
      food: preferences.food || DEFAULT_PREFERENCES.food,
      visitTime: preferences.visitTime || DEFAULT_PREFERENCES.visitTime,
    };
    finalize(finalPreferences);
  };

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1);
    } else {
      router.push('/');
    }
  };

  const setPreference = (key: keyof typeof preferences, value: string) => {
    setPreferences(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex flex-col min-h-screen bg-hanji text-muk relative overflow-hidden">
      {/* 은은한 금빛 광원 (기존 콜드 blue 글로우 대체) */}
      <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-gold/10 rounded-full blur-[120px] pointer-events-none z-0"></div>

      {/* Header & Progress */}
      <div className="z-10 w-full max-w-md mx-auto pt-8 px-6">
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={handleBack}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-white border border-line text-muk hover:bg-hanji-deep transition-colors shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
          >
            <ArrowLeft size={20} />
          </button>

          {/* 상단 건너뛰기 — canProceed 게이트 우회, 미선택 필드는 기본값으로 저장 후 /main 이동 */}
          <button
            onClick={handleSkip}
            disabled={isSubmitting}
            className="text-sm text-muk-soft hover:text-muk underline-offset-4 hover:underline transition-colors disabled:opacity-40"
          >
            {t('setup.skip')}
          </button>
        </div>

        <div className="w-full h-1.5 bg-line rounded-full mb-6 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-gold to-terracotta transition-all duration-500 ease-out"
            style={{ width: `${((step + 1) / totalSteps) * 100}%` }}
          />
        </div>

        <p className="text-sm text-muk-soft mb-12">
          {t('setup.intro')}
        </p>
      </div>

      {/* Content Area */}
      <div className="flex-1 w-full max-w-md mx-auto relative z-10 flex flex-col">
        {step === 0 && (
          <div className="animate-slide-up flex-1">
            <h2 className="text-2xl font-serif font-bold mb-8 text-center break-keep text-muk whitespace-pre-line">
              {t('setup.step0')}
            </h2>
            <div className="flex flex-col gap-4">
              {[
                { id: 'ongoing', key: 'tripOngoing', icon: Plane },
                { id: 'upcoming', key: 'tripUpcoming', icon: Clock },
                { id: 'browsing', key: 'tripBrowsing', icon: Compass },
              ].map(option => {
                const Icon = option.icon;
                const isSelected = preferences.tripStatus === option.id;
                return (
                  <button
                    key={option.id}
                    onClick={() => setPreference('tripStatus', option.id)}
                    className={`flex items-center p-6 rounded-2xl border transition-all shadow-[0_2px_14px_rgba(43,35,32,0.06)] ${
                      isSelected
                        ? 'bg-gold/15 border-gold text-muk'
                        : 'bg-white border-line text-muk-soft hover:bg-hanji-deep hover:text-muk'
                    }`}
                  >
                    <div className="w-12 h-12 flex items-center justify-center rounded-full bg-hanji-deep mr-4">
                      <Icon size={24} className={isSelected ? 'text-gold' : ''} />
                    </div>
                    <div className="text-left flex-1">
                      <div className="font-semibold text-lg">{t(`setup.${option.key}`)}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="animate-slide-up flex-1">
            <h2 className="text-2xl font-serif font-bold mb-8 text-center break-keep text-muk whitespace-pre-line">
              {t('setup.step1')}
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
                    className={`flex flex-col items-center justify-center p-6 rounded-2xl border transition-all shadow-[0_2px_14px_rgba(43,35,32,0.06)] ${
                      isSelected
                        ? 'bg-gold/15 border-gold text-muk'
                        : 'bg-white border-line text-muk-soft hover:bg-hanji-deep hover:text-muk'
                    }`}
                  >
                    <Icon size={32} className="mb-3" />
                    <span className="font-semibold">{t(`category.${option.id}`)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="animate-slide-up flex-1">
            <h2 className="text-2xl font-serif font-bold mb-8 text-center break-keep text-muk whitespace-pre-line">
              {t('setup.step2')}
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {[
                { id: 'korean', key: 'foodKorean', label: '한식', icon: Soup },
                { id: 'snack', key: 'foodSnack', label: '분식·국밥', icon: Utensils },
                { id: 'western', key: 'foodWestern', label: '양식', icon: Pizza },
                { id: 'dessert', key: 'foodDessert', label: '카페·디저트', icon: Coffee }
              ].map(option => {
                const Icon = option.icon;
                const isSelected = preferences.food === option.label;
                return (
                  <button
                    key={option.id}
                    onClick={() => setPreference('food', option.label)}
                    className={`flex flex-col items-center justify-center p-6 rounded-2xl border transition-all shadow-[0_2px_14px_rgba(43,35,32,0.06)] ${
                      isSelected
                        ? 'bg-gold/15 border-gold text-muk'
                        : 'bg-white border-line text-muk-soft hover:bg-hanji-deep hover:text-muk'
                    }`}
                  >
                    <Icon size={32} className="mb-3" />
                    <span className="font-semibold">{t(`setup.${option.key}`)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="animate-slide-up flex-1">
            <h2 className="text-2xl font-serif font-bold mb-8 text-center break-keep text-muk whitespace-pre-line">
              {t('setup.step3')}
            </h2>
            <div className="flex flex-col gap-4">
              {[
                { id: 'morning', label: '오전', labelKey: 'timeMorning', subKey: 'timeMorningSub', sub: '한적한 아침', icon: Sun },
                { id: 'afternoon', label: '오후', labelKey: 'timeAfternoon', subKey: 'timeAfternoonSub', sub: '활기찬 한낮', icon: Sunset },
                { id: 'evening', label: '저녁', labelKey: 'timeEvening', subKey: 'timeEveningSub', sub: '노을·야경', icon: Moon },
              ].map(option => {
                const Icon = option.icon;
                const isSelected = preferences.visitTime === option.label;
                return (
                  <button
                    key={option.id}
                    onClick={() => setPreference('visitTime', option.label)}
                    className={`flex items-center p-6 rounded-2xl border transition-all shadow-[0_2px_14px_rgba(43,35,32,0.06)] ${
                      isSelected
                        ? 'bg-gold/15 border-gold text-muk'
                        : 'bg-white border-line text-muk-soft hover:bg-hanji-deep hover:text-muk'
                    }`}
                  >
                    <div className="w-12 h-12 flex items-center justify-center rounded-full bg-hanji-deep mr-4">
                      <Icon size={24} className={isSelected ? 'text-gold' : ''} />
                    </div>
                    <div className="text-left flex-1">
                      <div className="font-semibold text-lg">{t(`setup.${option.labelKey}`)}</div>
                      <div className="text-sm opacity-60 mt-1">{t(`setup.${option.subKey}`)}</div>
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
            className="w-full flex items-center justify-center py-4 rounded-xl bg-gold hover:bg-gold-deep disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
          >
            {step === totalSteps - 1 ? (isSubmitting ? t('setup.saving') : t('setup.start')) : t('setup.next')}
            {step !== totalSteps - 1 && <ArrowRight size={20} className="ml-2" />}
          </button>

          {/* 하단 건너뛰기 — 상단과 동일한 handleSkip, canProceed 게이트 우회 */}
          <button
            onClick={handleSkip}
            disabled={isSubmitting}
            className="w-full text-center text-sm text-muk-soft hover:text-muk mt-3 py-1 transition-colors disabled:opacity-40"
          >
            {t('setup.skip')}
          </button>
        </div>
      </div>

      {/* 계정 연동 제안 오버레이 — 온보딩 완료 게스트에게 1회. '나중에'는 그대로 /main 진입(무마찰 유지). */}
      {showAccountOffer && (
        <div className="absolute inset-0 z-50 flex items-end sm:items-center justify-center bg-muk/40 backdrop-blur-sm px-6 animate-fade-in">
          <div className="w-full max-w-[380px] bg-white border border-line rounded-3xl p-6 shadow-[0_8px_32px_rgba(43,35,32,0.18)] mb-6 sm:mb-0">
            <div className="flex items-center gap-2 mb-1">
              <Link2 size={20} className="text-gold-deep" />
              <h2 className="text-lg font-bold font-serif text-muk">{t('auth.offerTitle')}</h2>
            </div>
            <p className="text-sm text-muk-soft mb-5">{t('auth.offerDesc')}</p>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={offerBusy}
                onClick={() => handleOfferLink('kakao')}
                className="flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm bg-[#FEE500] text-[#191600] hover:brightness-95 transition-all disabled:opacity-50"
              >
                {t('auth.continueKakao')}
              </button>
              <button
                type="button"
                disabled={offerBusy}
                onClick={() => handleOfferLink('google')}
                className="flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm bg-white text-muk border border-line hover:bg-hanji-deep transition-all disabled:opacity-50"
              >
                {t('auth.continueGoogle')}
              </button>
            </div>

            <button
              type="button"
              disabled={offerBusy}
              onClick={() => router.push('/main')}
              className="w-full text-center text-sm text-muk-soft hover:text-muk mt-4 py-1 transition-colors disabled:opacity-40"
            >
              {t('auth.offerLater')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
