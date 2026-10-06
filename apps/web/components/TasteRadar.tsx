'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Fingerprint, ThumbsUp, ThumbsDown, ArrowRight, ChevronDown } from 'lucide-react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { apiClient } from '@/lib/api-client';
import { loadTravelContext } from '@/lib/travelContext';
import { useT } from '@/lib/i18n/I18nProvider';
import { hasTasteFeedback, tasteBadge } from '@/lib/tasteBadge';

// 8차원 선호 벡터의 차원 정의 — apps/api/app/services/spot/preference.py 와 1:1 대응
// dim0-3: 카테고리(음식점/카페/관광지/문화시설) / dim4: 맛·평점 / dim5: 감성·인스타 / dim6: 접근성·무장애 / dim7: 한적함
// 화면 글자는 4로케일 사전(taste.axis.* · taste.tag.*)에서 — 예전에는 한국어 배열이라 en/ja/zh 에서도 한국어였다(I55).
const DIMENSION_IDS = ['restaurant', 'cafe', 'attraction', 'culture', 'taste', 'mood', 'access', 'quiet'] as const;
const AXIS_KEYS = DIMENSION_IDS.map((id) => `taste.axis.${id}`);
const TAG_KEYS = DIMENSION_IDS.map((id) => `taste.tag.${id}`);

// ⚠️ 표시 전용 폴백 상수: 백엔드 preference.py CATEGORY_VECTORS 를 그대로 재현.
// SPOT 점수 산정은 백엔드가 단일 소스이며, 이 값은 무세션(데모) 상태에서
// 온보딩 선택만으로 '내 취향 프로필'을 미리 그려주기 위한 Cold Start 시각화에만 쓰인다.
const CATEGORY_BASE_VECTORS: Record<string, number[]> = {
  restaurant: [1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],
  cafe:       [0.0, 1.0, 0.0, 0.0, 0.1, 0.3, 0.0, 0.0],
  attraction: [0.0, 0.0, 1.0, 0.0, 0.0, 0.1, 0.2, 0.0],
  culture:    [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2],
};


// L2 정규화 (preference.py get_category_average_vector 와 동일한 후처리)
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// 온보딩 선택에서 표시용 벡터 유도: 선택 카테고리들의 기저 벡터 평균 → L2 정규화.
//
// 저장 형태를 직접 파싱하지 않고 loadTravelContext() 를 쓴다. 예전에는 이 함수가
// `{ category: '음식점', food: '카페·디저트' }` 라는 **v1 단수형 한국어 라벨**을 읽었는데,
// 지금 그 키에 저장되는 것은 v2 의 `{ categories: PlaceCategory[] }`(영문 키 배열)다.
// 그래서 이 Cold Start 시각화는 아무에게도 뜨지 않는 죽은 코드였다. loadTravelContext 는
// v1·v2 를 모두 흡수하므로 형태 판단을 한 곳에만 둔다.
function deriveOnboardingVector(): number[] | null {
  const keys = loadTravelContext().categories;
  if (keys.length === 0) return null;

  const sum = new Array(8).fill(0);
  keys.forEach((key) => {
    CATEGORY_BASE_VECTORS[key].forEach((v, i) => { sum[i] += v; });
  });
  return l2Normalize(sum.map((v) => v / keys.length));
}

// 선호 미설정 시의 균등 벡터 (preference.py 의 디폴트 1/√8 과 동일)
const UNIFORM_VECTOR = new Array(8).fill(1 / Math.sqrt(8));

// 벡터 출처: learned=백엔드 실시간 학습 벡터 / onboarding=온보딩 기반 Cold Start / default=균등(미설정)
type VectorSource = 'learned' | 'onboarding' | 'default';

interface TasteState {
  vector: number[];
  source: VectorSource;
}

export default function TasteRadar() {
  const t = useT();
  const [taste, setTaste] = useState<TasteState | null>(null);
  // '자세히' — 수락 +10% · 거절 −5% 와 8가지 축(기능설명서 2-⑤)은 원할 때만. 앞면은 관광객 말 한 줄.
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadVector = async () => {
      // 1순위: 백엔드 학습 벡터 (Supabase 세션 필요 — 무세션 데모에서는 401로 폴백)
      try {
        const data = await apiClient.get('/api/v1/users/me/vector');
        if (Array.isArray(data?.vector) && data.vector.length === 8) {
          if (!cancelled) setTaste({ vector: data.vector, source: 'learned' });
          return;
        }
      } catch {
        // 무세션(401)·네트워크 실패 → 클라이언트 폴백으로 계속 진행
      }
      if (cancelled) return;

      // 2순위: 온보딩 선호 기반 Cold Start 벡터 / 3순위: 균등 벡터 + 설정 유도 CTA
      const onboarding = deriveOnboardingVector();
      if (onboarding) setTaste({ vector: onboarding, source: 'onboarding' });
      else setTaste({ vector: UNIFORM_VECTOR, source: 'default' });
    };

    loadVector();
    return () => { cancelled = true; };
  }, []);

  const badge = taste
    ? tasteBadge(taste.source, taste.vector, { uniform: UNIFORM_VECTOR, onboarding: deriveOnboardingVector() }, hasTasteFeedback())
    : null;

  return (
    <div data-testid="taste-radar" className="bg-white border border-line rounded-3xl p-6 shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4">
      {/* 섹션 헤더 + 벡터 출처 배지 */}
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-bold text-gold-deep tracking-wider flex items-center gap-2">
          <Fingerprint size={16} />
          <span>{t('taste.title')}</span>
        </h3>
        {/* '실시간 학습 반영' 은 벡터가 정말 움직인 뒤에만(lib/tasteBadge — 새 게스트에게 붙던 리뷰 10-07 지적). */}
        {badge && (
          <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border ${
            badge === 'learned'
              ? 'bg-gold/15 border-gold/30 text-gold-deep'
              : 'bg-hanji-deep border-line text-muk-soft'
          }`}>
            {badge === 'learned' ? t('taste.badgeLearned') : t('taste.badgeOnboarding')}
          </span>
        )}
      </div>
      <p className="text-xs text-muk-soft mb-2">{t('taste.subtitle')}</p>

      {!taste ? (
        <div className="flex justify-center py-10">
          <div className="w-5 h-5 border-2 border-gold border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <>
          {/* 8축 레이더 차트 (벡터 0~1 → 0~100 스케일) */}
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart
                data={AXIS_KEYS.map((key, i) => ({
                  label: t(key),
                  value: Math.round(Math.max(0, Math.min(1, taste.vector[i] ?? 0)) * 100),
                }))}
                outerRadius="72%"
              >
                {/* 축 글자·격자는 테마 토큰으로 — 하드코딩한 밝은 테마 색은 어두운 카드(18~06시 자동)에서 거의 안 보였다. */}
                <PolarGrid stroke="var(--nextspot-line)" />
                <PolarAngleAxis dataKey="label" tick={{ fill: 'var(--nextspot-muk-soft)', fontSize: 11, style: { fill: 'var(--nextspot-muk-soft)' } }} />
                <Tooltip
                  formatter={(value) => [`${value} / 100`, t('taste.tooltipLabel')]}
                  contentStyle={{
                    borderRadius: '8px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #e6dcc6',
                    color: '#2b2320',
                    fontSize: '12px',
                  }}
                />
                <Radar
                  name={t('taste.radarName')}
                  dataKey="value"
                  stroke="#c19a3e"
                  strokeWidth={2}
                  fill="#c19a3e"
                  fillOpacity={0.22}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {taste.source === 'default' ? (
            /* 선호 미설정: 균등 벡터 + 온보딩 유도 CTA */
            <Link
              href="/setup"
              className="mt-3 flex items-center justify-between px-4 py-3 rounded-xl bg-gold/15 border border-gold/30 hover:bg-gold/25 transition-colors"
            >
              <span className="text-sm text-muk font-medium break-keep">
                {t('taste.setupCta')}
              </span>
              <ArrowRight size={16} className="text-gold-deep shrink-0 ml-2" />
            </Link>
          ) : (
            /* 상위 2개 성향 태그 (가장 높은 두 차원) */
            <div className="mt-1 flex items-center justify-center gap-2 flex-wrap">
              {taste.vector
                .map((value, idx) => ({ value, idx }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 2)
                .map(({ idx }) => (
                  <span
                    key={idx}
                    className="px-3 py-1.5 rounded-full bg-jade/15 border border-jade/30 text-jade text-xs font-semibold"
                  >
                    {t(TAG_KEYS[idx])}
                  </span>
                ))}
            </div>
          )}

          {/* 피드백이 프로필에 반영된다는 한 줄(관광객 말) + '자세히' 뒤의 수락 +10% / 거절 −5% · 8가지 축(I55).
              '벡터'·'8차원' 같은 엔진 말은 앞면에 쓰지 않는다. */}
          <div className="mt-4 px-4 py-3 rounded-xl bg-hanji border border-line">
            <p className="text-[12px] text-muk-soft text-center leading-relaxed break-keep">{t('taste.learnHint')}</p>
            <div className="mt-1 flex justify-center">
              <button
                type="button"
                onClick={() => setDetailsOpen((v) => !v)}
                aria-expanded={detailsOpen}
                aria-controls="taste-details"
                className="toss-pressable inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-[12px] font-bold text-gold-deep hover:bg-gold/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {t('taste.detailsToggle')}
                <ChevronDown size={13} className={`transition-transform ${detailsOpen ? 'rotate-180' : ''}`} aria-hidden />
              </button>
            </div>
            {detailsOpen && (
              <div id="taste-details" className="mt-1 space-y-1.5">
                <div className="flex items-center justify-center gap-4 text-xs">
                  <span className="flex items-center gap-1.5 text-jade">
                    <ThumbsUp size={13} />
                    <span className="font-semibold">+10%</span>
                  </span>
                  <span className="text-muk-soft">·</span>
                  <span className="flex items-center gap-1.5 text-terracotta">
                    <ThumbsDown size={13} />
                    <span className="font-semibold">−5%</span>
                  </span>
                </div>
                <p className="text-[11px] text-muk-soft text-center leading-relaxed break-keep">{t('taste.detailsBody')}</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
