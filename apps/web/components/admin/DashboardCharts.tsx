'use client';

import { useState } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from 'recharts';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

export function DashboardCharts({ distribution }: { distribution: any[] }) {
  // distribution = [ { date: string, beforeCongestion: number, afterCongestion: number, alternativeUsage: number } ]
  // recharts tooltip formatter to show percentage
  const formatPercent = (value: any) => `${(Number(value) * 100).toFixed(1)}%`;

  // 데이터가 비면 recharts 는 축만 그리고 선이 없어 '빈 화면'처럼 보인다 → 빈 상태 가드로 안내 문구 표시.
  const hasData = Array.isArray(distribution) && distribution.length > 0;

  return (
    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm col-span-4 flex flex-col gap-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {/* ③ 분산 효과 — 폐루프의 마지막 단계(개입이 만든 장기 추이) */}
          <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
            ③ 분산 효과
          </span>
          <h3 className="text-lg font-bold text-slate-100">최근 30일 관광 수요 분산 효과 분석</h3>
        </div>
        {/* 실측 오인 방지(정직성 원칙) — 도입 전/후 추이는 합성한 데모용 예시임을 명시한다. */}
        <span
          title="실측 집계가 아닌 데모용 예시 추이입니다. 도입 전/후 혼잡도와 대안 장소 활용률의 기대 패턴을 보여줍니다."
          className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-amber-500/10 text-amber-300 border-amber-500/25 cursor-help"
        >
          예시 추이(데모)
        </span>
      </div>

      <div className="h-[300px] w-full">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={distribution} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} />
              <YAxis axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} domain={[0, 1]} tickFormatter={(val) => `${Math.round(val * 100)}%`} />
              <Tooltip formatter={formatPercent} contentStyle={{ borderRadius: '8px', backgroundColor: '#0f172a', border: '1px solid #1e293b', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
              <Line name="원본 장소(도입 전)" type="monotone" dataKey="beforeCongestion" stroke="#94a3b8" strokeDasharray="5 5" strokeWidth={2} dot={false} />
              <Line name="원본 장소(도입 후)" type="monotone" dataKey="afterCongestion" stroke="#3b82f6" strokeWidth={3} dot={{r: 4}} activeDot={{r: 6}} />
              <Line name="대안 장소 활용률" type="monotone" dataKey="alternativeUsage" stroke="#10b981" strokeWidth={3} dot={{r: 4}} activeDot={{r: 6}} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-1 text-slate-500">
            <p className="text-sm font-semibold">표시할 분산 효과 추이가 없습니다.</p>
            <p className="text-xs text-slate-600">30일 도입 전/후 A/B 추이가 집계되면 이 영역에 표시됩니다.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// 히트맵 차트는 CSS Grid를 이용한 커스텀 구현 (Recharts에 기본 Heatmap이 없으므로 직관적이고 커스텀 쉬운 Grid 사용)
export function DashboardHeatmap({ heatmapData }: { heatmapData: any[] }) {
  // heatmapData: [ { facility: string, facilityType: string, hour: number, value: number } ]
  
  const [selectedCategory, setSelectedCategory] = useState('restaurant');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const categories = [
    { id: 'restaurant', name: '음식점' },
    { id: 'cafe', name: '카페' },
    { id: 'attraction', name: '관광지' },
    { id: 'culture', name: '문화시설' },
  ];

  // Selected category data
  const filteredData = heatmapData.filter(d => d.facilityType === selectedCategory);
  
  // Unique facilities in selected category
  const filteredFacilities = Array.from(new Set(filteredData.map(d => d.facility)));
  
  // Pagination
  const totalItems = filteredFacilities.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedFacilities = filteredFacilities.slice(startIndex, startIndex + itemsPerPage);

  // 0시 ~ 23시 순서대로 표시
  const hours = Array.from({length: 24}, (_, i) => i);
  
  const getHeatmapColor = (value: number | null) => {
    if (value == null) return 'bg-slate-800'; // 데이터 없음(실측 0%와 구분)
    if (value < 0.3) return 'bg-emerald-100';  // 0(여유)도 여기로 — 더 이상 '데이터 없음'과 섞이지 않음
    if (value < 0.6) return 'bg-emerald-400';
    if (value < 0.8) return 'bg-amber-400';
    return 'bg-rose-500';
  };

  const getHeatmapValue = (facility: string, hour: number): number | null => {
    const item = heatmapData.find(d => d.facility === facility && d.hour === hour);
    // 셀이 없거나(미존재) 데이터 없음 센티넬(null)이면 null. 실측 0.00 은 0 그대로 반환된다.
    return item ? item.value : null;
  };

  const handleCategoryChange = (catId: string) => {
    setSelectedCategory(catId);
    setCurrentPage(1);
  };

  return (
    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm col-span-4 flex flex-col justify-between overflow-x-auto min-h-[500px]">
      <div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-2">
            {/* ① 실시간 관제 — 폐루프 첫 단계(현재 혼잡 모니터링) */}
            <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-blue-500/15 text-blue-300 border-blue-500/30">
              ① 실시간 관제
            </span>
            <h3 className="text-lg font-bold text-slate-100">장소별 시간대 혼잡 히트맵</h3>
          </div>

          {/* Category Filters */}
          <div className="flex gap-2">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => handleCategoryChange(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  selectedCategory === cat.id
                    ? 'bg-blue-500/10 border-blue-500/30 text-blue-300 font-bold'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-[800px]">
          {/* X축 (시간) */}
          <div className="flex ml-36 mb-2">
            {hours.map(h => (
              <div key={h} className="flex-1 text-center text-xs text-slate-400 font-medium">
                {h}시
              </div>
            ))}
          </div>
          
          {/* 시설별 로우 */}
          <div className="flex flex-col gap-2 min-h-[160px]">
            {paginatedFacilities.map(fac => (
              <div key={fac} className="flex items-center">
                <div className="w-36 text-sm font-semibold text-slate-200 truncate pr-4 text-right">
                  {fac}
                </div>
                <div className="flex-1 flex gap-1">
                  {hours.map(h => {
                    const val = getHeatmapValue(fac, h);
                    return (
                      <div
                        key={`${fac}-${h}`}
                        title={val == null ? `${fac} ${h}시: 데이터 없음` : `${fac} ${h}시: ${(val * 100).toFixed(0)}%`}
                        className={`flex-1 h-8 rounded-sm transition-colors hover:ring-2 hover:ring-blue-500 cursor-pointer ${getHeatmapColor(val)}`}
                      ></div>
                    );
                  })}
                </div>
              </div>
            ))}
            {paginatedFacilities.length === 0 && (
              <div className="h-32 flex items-center justify-center text-slate-500 text-sm">
                해당 카테고리의 장소 데이터가 없습니다.
              </div>
            )}
          </div>

          {/* 범례 */}
          <div className="flex justify-end items-center gap-4 mt-6 text-xs text-slate-400">
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-slate-800 border border-slate-700"></div>데이터 없음</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-emerald-100"></div>여유 (0~30%)</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-emerald-400"></div>보통 (30~60%)</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-amber-400"></div>혼잡 (60~80%)</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-rose-500"></div>매우 혼잡 (80%~)</div>
          </div>
        </div>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-800 pt-4 mt-6">
          <div className="text-xs text-slate-400 font-medium">
            총 {totalItems}개 중 {startIndex + 1}-{Math.min(startIndex + itemsPerPage, totalItems)}개 표시
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 10, 1))}
              disabled={currentPage === 1}
              title="10페이지 이전"
              className="p-1 rounded border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              title="이전 페이지"
              className="p-1 rounded border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs text-slate-300 font-semibold px-2">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              title="다음 페이지"
              className="p-1 rounded border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(prev => Math.min(prev + 10, totalPages))}
              disabled={currentPage === totalPages}
              title="10페이지 다음"
              className="p-1 rounded border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
