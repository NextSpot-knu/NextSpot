'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiClient } from '@/lib/api-client';
import { SPOT_WEIGHTS } from 'shared-types';

// 기본 가중치는 공유 상수(packages/shared-types/spot.ts)에서 유도 — 백엔드 score.py 와 단일 정의점.
// (이전 하드코딩 45:30:25 는 실제 엔진과 스왑·불일치 상태였음.)
const DEFAULT_WEIGHTS = {
    pref: Math.round(SPOT_WEIGHTS.preference * 100),
    time: Math.round(SPOT_WEIGHTS.time * 100),
    inc: Math.round(SPOT_WEIGHTS.incentive * 100),
};

export default function SPOTSimulator() {
    // 슬라이더 및 입력 필드 동기화 상태 (기본값 = 공유 상수 유도)
    const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS });
    const [userVector, setUserVector] = useState<number[] | null>(null);

    useEffect(() => {
        const fetchUserVector = async () => {
            try {
                const data = await apiClient.get('/api/v1/users/me/vector');
                if (data && data.vector) {
                    setUserVector(data.vector);
                }
            } catch (err) {
                console.error("Failed to fetch user vector in simulator", err);
                // Fallback mockup vector
                setUserVector([0.45, 0.12, 0.35, 0.05, 0.61, 0.22, 0.10, 0.45]);
            }
        };
        fetchUserVector();
    }, []);

    // 1. 1000개의 모의 시설 데이터 정적 생성 (최초 1회만 연산)
    const mockFacilities = useMemo(() => {
        return Array.from({ length: 1000 }, () => {
            // 선호도 (양봉 분포: 30% 확률로 취향 일치, 70% 확률로 불일치)
            const pref = Math.random() < 0.3 ? 0.8 + Math.random() * 0.2 : Math.random() * 0.2;
            // 시간비용 (비대칭 연속: 80%가 가까운 거리)
            const time = Math.random() < 0.8 ? 0.1 + Math.random() * 0.3 : 0.4 + Math.random() * 0.6;
            // 인센티브 (0점 스파이크: 60% 혼잡 0점, 40% 한산 보너스)
            const inc = Math.random() < 0.6 ? 0 : 0.2 + Math.random() * 0.6;
            return { pref, time, inc };
        });
    }, []);

    // 2. 가중치 입력 핸들러 (슬라이더 & 텍스트 박스 동기화 및 비율 자동 정규화)
    const handleWeightChange = (key: 'pref' | 'time' | 'inc', rawValue: string) => {
        let value = Number(rawValue);
        if (isNaN(value)) return; // 숫자가 아니면 무시

        // 입력값의 한계 설정 (0 ~ 100)
        value = Math.max(0, Math.min(100, value));

        setWeights(prev => {
            const newWeights = { ...prev, [key]: value };
            const totalW = newWeights.pref + newWeights.time + newWeights.inc;

            // 총합이 0이 되는 것을 방지 (모두 0을 입력했을 경우 기본값 복귀)
            if (totalW === 0) return { ...DEFAULT_WEIGHTS };

            // 입력한 값은 고정하고, 나머지 두 값의 비율을 유지하며 총합 100으로 정규화
            const otherKeys = (Object.keys(newWeights) as Array<'pref' | 'time' | 'inc'>).filter(k => k !== key);
            const remainingTotal = 100 - value;
            const prevOtherTotal = prev[otherKeys[0]] + prev[otherKeys[1]];

            if (prevOtherTotal === 0) {
                // 나머지가 0이었으면 균등 분배
                newWeights[otherKeys[0]] = remainingTotal / 2;
                newWeights[otherKeys[1]] = remainingTotal / 2;
            } else {
                // 기존 비율 유지하며 나머지 값 분배
                newWeights[otherKeys[0]] = (prev[otherKeys[0]] / prevOtherTotal) * remainingTotal;
                newWeights[otherKeys[1]] = (prev[otherKeys[1]] / prevOtherTotal) * remainingTotal;
            }

            return {
                pref: Number(newWeights.pref.toFixed(1)),
                time: Number(newWeights.time.toFixed(1)),
                inc: Number(newWeights.inc.toFixed(1))
            };
        });
    };

    // 3. 점수 재연산 및 차트 데이터 렌더링
    const { chartData, analysisText } = useMemo(() => {
        const totalW = weights.pref + weights.time + weights.inc;
        // 방어 로직: 총합이 0일 경우 예외 처리
        const wp = totalW > 0 ? weights.pref / totalW : 0;
        const wt = totalW > 0 ? weights.time / totalW : 0;
        const wi = totalW > 0 ? weights.inc / totalW : 0;

        const bins = Array.from({ length: 10 }, (_, i) => ({
            name: `${i * 10}점대`,
            count: 0,
        }));

        mockFacilities.forEach((f) => {
            // Raw Score 계산 (시간은 패널티 차감)
            const raw = f.pref * wp - f.time * wt + f.inc * wi;
            // 0~100 스케일 정규화 (Min-Max Scaling)
            const normalized = Math.max(0, Math.min(100, ((raw + wt) / (wp + wt + wi)) * 100));
            const binIndex = Math.min(Math.floor(normalized / 10), 9);
            bins[binIndex].count += 1;
        });

        // 상태 요약 텍스트 분석
        let analysis = "현재 이상적인 다봉 분포가 형성되어 있습니다. 저점(무관한 시설)과 고점(추천 시설)이 명확히 구분됩니다.";
        if (wp > 0.6) analysis = "선호도 가중치가 과도하게 높습니다. 취향 일치 여부에만 의존하는 양극화(U자 분포)가 심화됩니다.";
        if (wt > 0.6) analysis = "시간 비용 패널티가 너무 가혹합니다. 점수 전체가 왼쪽으로 깎여나가 근거리 시설만 강제 추천됩니다.";
        if (wi > 0.5) analysis = "인센티브 가중치가 높아 원본 시설의 혼잡도에 의존하는 경향이 짙어집니다.";

        return { chartData: bins, analysisText: analysis };
    }, [weights, mockFacilities]);

    return (
        <div className="w-full bg-hanok-panel p-6 rounded-xl shadow-sm border border-hanok-line">
            <div className="mb-6 border-b border-hanok-line pb-4">
                <h2 className="text-xl font-bold text-hanok-ink">SPOT 추천 알고리즘 튜닝 센터</h2>
                <p className="text-sm text-hanok-muted mt-1">
                    가중치(총합 100)를 입력하거나 슬라이더를 조작하여 1,000개 모의 시설의 점수 군집화를 분석하십시오.
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* 왼쪽 패널: 슬라이더 및 입력 필드 컨트롤 */}
                <div className="flex flex-col gap-6 lg:col-span-1 border-r border-hanok-line pr-6">
                    <SyncControl
                        label="선호도 일치율 (W_pref)"
                        value={weights.pref}
                        colorClass="text-gold bg-gold/10 border-gold/30"
                        accentClass="accent-gold"
                        onChange={(v) => handleWeightChange('pref', v)}
                    />
                    <SyncControl
                        label="시간비용 패널티 (W_time)"
                        value={weights.time}
                        colorClass="text-red-400 bg-red-500/10 border-red-500/30"
                        accentClass="accent-red-600"
                        onChange={(v) => handleWeightChange('time', v)}
                    />
                    <SyncControl
                        label="혼잡 분산 보너스 (W_inc)"
                        value={weights.inc}
                        colorClass="text-green-400 bg-green-500/10 border-green-500/30"
                        accentClass="accent-green-600"
                        onChange={(v) => handleWeightChange('inc', v)}
                    />

                    <div className="mt-4 p-4 bg-hanok rounded-lg border border-hanok-line">
                        <h4 className="text-xs font-bold text-hanok-muted mb-2 uppercase tracking-wide">실시간 분석 리포트</h4>
                        <p className="text-sm text-hanok-ink font-medium leading-relaxed">{analysisText}</p>
                    </div>

                    <div className="mt-4 p-4 bg-hanok-panel text-hanok-ink rounded-lg border border-hanok-line font-mono">
                        <h4 className="text-xs font-bold text-jade mb-2 uppercase tracking-wide">사용자 선호도 벡터 (실시간)</h4>
                        {userVector ? (
                            <div className="space-y-2">
                                <div className="text-[10px] text-hanok-muted break-all leading-normal select-all bg-hanok p-2 rounded border border-hanok-line">
                                    [{userVector.map(v => v.toFixed(3)).join(', ')}]
                                </div>
                                <div className="grid grid-cols-8 gap-1 h-3 mt-2">
                                    {userVector.map((v, i) => (
                                        <div key={i} className="bg-hanok-card rounded overflow-hidden h-full relative" title={`Dim ${i+1}: ${v.toFixed(4)}`}>
                                            <div className="bg-jade absolute bottom-0 left-0 right-0" style={{ height: `${Math.max(0, Math.min(100, (v + 1) * 50))}%` }} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="text-[11px] text-hanok-muted">벡터 조회 중...</div>
                        )}
                    </div>
                </div>

                {/* 오른쪽 패널: 히스토그램 (Area Chart) */}
                <div className="lg:col-span-2 h-[400px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <defs>
                                <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.4} />
                                    <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3a2f24" />
                            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#b8a894' }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fontSize: 12, fill: '#b8a894' }} tickLine={false} axisLine={false} />
                            <Tooltip
                                contentStyle={{ borderRadius: '8px', backgroundColor: '#2c241c', border: '1px solid #3a2f24', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                labelStyle={{ fontWeight: 'bold', color: '#e2e8f0', marginBottom: '4px' }}
                                itemStyle={{ color: '#4f46e5', fontWeight: 'bold' }}
                            />
                            <Area type="monotone" dataKey="count" name="시설 수" stroke="#4f46e5" strokeWidth={3} fillOpacity={1} fill="url(#colorCount)" animationDuration={300} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* SPOT Explanation Guide */}
            <div className="mt-8 bg-hanok-panel p-6 rounded-2xl shadow-sm border border-hanok-line">
                <h3 className="text-lg font-bold text-hanok-ink mb-4 flex items-center gap-2">
                    <span className="bg-gold/15 text-gold p-1.5 rounded-lg"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></span>
                    SPOT (Smart Place Optimization for Tourism) 알고리즘 가이드
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm text-hanok-muted">
                    <div>
                        <p className="mb-4 leading-relaxed">
                            <strong className="text-hanok-ink">SPOT란?</strong><br/>
                            사용자가 서비스를 이용하기 위해 소비하는 <span className="font-semibold text-gold">대기 시간과 이동 시간의 기회비용을 가치(Value)로 환산</span>하여 최적의 스팟을 추천하는 NextSpot만의 핵심 알고리즘입니다. 점수(0~100점)가 높을수록 현재 상황에서 가장 합리적인 선택지임을 의미합니다.
                        </p>
                        <p className="leading-relaxed">
                            <strong className="text-hanok-ink">시뮬레이터 활용법:</strong><br/>
                            1,000개의 가상 스팟을 대상으로 가중치를 조절해보세요. 우측 히스토그램을 통해 점수 분포가 어떻게 변하는지 실시간으로 확인하며 알고리즘의 황금비를 튜닝할 수 있습니다.
                        </p>
                    </div>

                    <div className="space-y-3 bg-hanok p-4 rounded-xl border border-hanok-line">
                        <div className="flex gap-3">
                            <div className="w-2 h-2 rounded-full bg-gold mt-1.5 flex-shrink-0"></div>
                            <div>
                                <strong className="text-hanok-ink">선호도 일치 (Preference)</strong>
                                <p className="text-xs mt-0.5 text-hanok-muted">가중치를 높이면 거리가 멀더라도 사용자의 벡터(취향)에 완벽히 부합하는 핫플레이스를 우선 추천합니다.</p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <div className="w-2 h-2 rounded-full bg-red-500 mt-1.5 flex-shrink-0"></div>
                            <div>
                                <strong className="text-hanok-ink">시간비용 절감 (Time Cost)</strong>
                                <p className="text-xs mt-0.5 text-hanok-muted">가중치를 높이면 선호도가 낮더라도 대기줄이 없고 당장 도달 가능한 가장 가까운 스팟을 우선 추천합니다.</p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <div className="w-2 h-2 rounded-full bg-emerald-500 mt-1.5 flex-shrink-0"></div>
                            <div>
                                <strong className="text-hanok-ink">혼잡도 인센티브 (Congestion Incentive)</strong>
                                <p className="text-xs mt-0.5 text-hanok-muted">가중치를 높이면 한적한 틈새 스팟에 강력한 보너스 점수를 부여하여 골목·도심의 관광 수요를 적극적으로 분산시킵니다.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// 하위 동기화 컨트롤 컴포넌트 (텍스트 박스 + 슬라이더)
interface SyncControlProps {
    label: string;
    value: number;
    colorClass: string;
    accentClass: string;
    onChange: (val: string) => void;
}

function SyncControl({ label, value, colorClass, accentClass, onChange }: SyncControlProps) {
    // 로컬 텍스트 입력을 위한 상태 (키보드 타이핑 시 소수점 등 임시 상태 유지)
    const [inputValue, setInputValue] = useState(value.toString());

    // 외부(다른 슬라이더)에 의해 value가 변경되면 로컬 입력창도 동기화
    useEffect(() => {
        setInputValue(value.toString());
    }, [value]);

    const handleInputBlur = () => {
        // 포커스가 벗어날 때 빈 값이면 강제로 0 처리
        if (inputValue.trim() === '') onChange('0');
        else onChange(inputValue);
    };

    const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // 엔터키 누를 때 확정
        if (e.key === 'Enter') {
            e.currentTarget.blur();
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
                <label className="text-sm font-bold text-hanok-ink">{label}</label>
                <input
                    type="number"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onBlur={handleInputBlur}
                    onKeyDown={handleInputKeyDown}
                    className={`w-16 px-2 py-1 text-right text-sm font-bold border rounded focus:outline-none focus:ring-2 focus:ring-opacity-50 ${colorClass}`}
                />
            </div>
            <input
                type="range" min="0" max="100" step="0.1"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className={`w-full h-2 bg-hanok-line rounded-lg appearance-none cursor-pointer ${accentClass}`}
            />
        </div>
    );
}