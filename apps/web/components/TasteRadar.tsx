'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Fingerprint, ThumbsUp, ThumbsDown, ArrowRight } from 'lucide-react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { apiClient } from '@/lib/api-client';

// 8차원 선호 벡터의 차원 정의 — apps/api/app/services/spot/preference.py 와 1:1 대응
// dim0-3: 카테고리(음식점/카페/관광지/문화시설) / dim4: 맛·평점 / dim5: 감성·인스타 / dim6: 접근성·무장애 / dim7: 한적함
const DIMENSION_LABELS = ['음식점', '카페', '관광지', '문화시설', '맛·평점', '감성·인스타', '접근성', '한적함'];

// 상위 성향 태그용 한국어 라벨 (차원 인덱스 순서 동일)
const DIMENSION_TAGS = ['#맛집탐방', '#카페투어', '#관광명소', '#문화예술', '#맛·평점', '#감성인스타', '#무장애여행', '#한적함'];

// ⚠️ 표시 전용 폴백 상수: 백엔드 preference.py CATEGORY_VECTORS 를 그대로 재현.
// SPOT 점수 산정은 백엔드가 단일 소스이며, 이 값은 무세션(데모) 상태에서
// 온보딩 선택만으로 '내 취향 프로필'을 미리 그려주기 위한 Cold Start 시각화에만 쓰인다.
const CATEGORY_BASE_VECTORS: Record<string, number[]> = {
  restaurant: [1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],
  cafe:       [0.0, 1.0, 0.0, 0.0, 0.1, 0.3, 0.0, 0.0],
  attraction: [0.0, 0.0, 1.0, 0.0, 0.0, 0.1, 0.2, 0.0],
  culture:    [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2],
};

// setup 온보딩(localStorage 'nextspot_setup_prefs')은 한국어 라벨로 저장됨 → 백엔드 카테고리 키 매핑
const CATEGORY_LABEL_TO_KEY: Record<string, string> = {
  '음식점': 'restaurant',
  '카페': 'cafe',
  '관광지': 'attraction',
  '문화시설': 'culture',
};

// L2 정규화 (preference.py get_category_average_vector 와 동일한 후처리)
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// 온보딩 선택(localStorage)에서 표시용 벡터 유도: 선택 카테고리들의 기저 벡터 평균 → L2 정규화
function deriveOnboardingVector(): number[] | null {
  try {
    const raw = localStorage.getItem('nextspot_setup_prefs');
    if (!raw) return null;
    const prefs = JSON.parse(raw) as { category?: string; food?: string };

    const keys: string[] = [];
    const catKey = prefs.category ? CATEGORY_LABEL_TO_KEY[prefs.category] : undefined;
    if (catKey) keys.push(catKey);
    // setup 2단계 음식 취향이 '카페·디저트'면 카페 성향도 함께 반영
    if (prefs.food === '카페·디저트' && !keys.includes('cafe')) keys.push('cafe');
    if (keys.length === 0) return null;

    const sum = new Array(8).fill(0);
    keys.forEach((key) => {
      CATEGORY_BASE_VECTORS[key].forEach((v, i) => { sum[i] += v; });
    });
    return l2Normalize(sum.map((v) => v / keys.length));
  } catch {
    return null;
  }
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
  const [taste, setTaste] = useState<TasteState | null>(null);

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

  return (
    <div className="bg-[#131a28]/60 backdrop-blur-xl border border-white/5 rounded-3xl p-6 shadow-lg mb-4">
      {/* 섹션 헤더 + 벡터 출처 배지 */}
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-bold text-sky-400 uppercase tracking-wider flex items-center gap-2">
          <Fingerprint size={16} />
          <span>AI 취향 프로필</span>
        </h3>
        {taste && taste.source !== 'default' && (
          <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border ${
            taste.source === 'learned'
              ? 'bg-blue-900/40 border-blue-500/30 text-blue-300'
              : 'bg-white/5 border-white/10 text-gray-400'
          }`}>
            {taste.source === 'learned' ? '실시간 학습 반영' : '온보딩 선호 기반 (아직 학습 전)'}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-2">추천 엔진이 이해한 나의 여행 성향 8차원</p>

      {!taste ? (
        <div className="flex justify-center py-10">
          <div className="w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <>
          {/* 8축 레이더 차트 (벡터 0~1 → 0~100 스케일) */}
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart
                data={DIMENSION_LABELS.map((label, i) => ({
                  label,
                  value: Math.round(Math.max(0, Math.min(1, taste.vector[i] ?? 0)) * 100),
                }))}
                outerRadius="72%"
              >
                <PolarGrid stroke="rgba(255,255,255,0.08)" />
                <PolarAngleAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip
                  formatter={(value) => [`${value} / 100`, '선호 강도']}
                  contentStyle={{
                    borderRadius: '8px',
                    backgroundColor: '#0f172a',
                    border: '1px solid #1e293b',
                    color: '#e2e8f0',
                    fontSize: '12px',
                  }}
                />
                <Radar
                  name="취향 프로필"
                  dataKey="value"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  fill="#38bdf8"
                  fillOpacity={0.25}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {taste.source === 'default' ? (
            /* 선호 미설정: 균등 벡터 + 온보딩 유도 CTA */
            <Link
              href="/setup"
              className="mt-3 flex items-center justify-between px-4 py-3 rounded-xl bg-blue-600/15 border border-blue-500/30 hover:bg-blue-600/25 transition-colors"
            >
              <span className="text-sm text-blue-200 font-medium break-keep">
                선호를 설정하면 나만의 프로필이 만들어져요
              </span>
              <ArrowRight size={16} className="text-blue-300 shrink-0 ml-2" />
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
                    className="px-3 py-1.5 rounded-full bg-sky-900/40 border border-sky-500/30 text-sky-300 text-xs font-semibold"
                  >
                    {DIMENSION_TAGS[idx]}
                  </span>
                ))}
            </div>
          )}

          {/* 피드백 학습 루프 설명 (수락 +10% / 거절 −5% 벡터 보정) */}
          <div className="mt-4 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/5">
            <div className="flex items-center justify-center gap-4 text-xs mb-1.5">
              <span className="flex items-center gap-1.5 text-emerald-300">
                <ThumbsUp size={13} />
                <span className="font-semibold">수락 +10%</span>
              </span>
              <span className="text-gray-600">·</span>
              <span className="flex items-center gap-1.5 text-rose-300">
                <ThumbsDown size={13} />
                <span className="font-semibold">거절 −5%</span>
              </span>
            </div>
            <p className="text-[11px] text-gray-500 text-center leading-relaxed break-keep">
              추천에 남긴 피드백이 벡터를 보정해, 쓰면 쓸수록 추천이 나에게 맞춰져요.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
