'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  ReferenceArea, Label,
} from 'recharts';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Info } from 'lucide-react';
import {
  GAP_SHADING_NOTE, findGaps, formatGapLabel, isMissingValue, longestGap, summarizeSeries,
} from '@/lib/adminSeriesGaps';

// ── 로컬 타입 정의 ──────────────────────────────────────────────────────────
// 히트맵 셀 (value: null = 데이터 없음 센티넬 — 실측 0.00 과 구분)
interface HeatmapCell {
  facility: string;
  facilityType: string;
  hour: number;
  value: number | null;
}

// live 모드의 추이 행 — /admin/metrics/trend 를 대시보드가 옮겨 담은 모양.
// 값 null 은 **로그/추천이 없던 날**이고 실측 0.0 과 다르다(히트맵의 null 센티넬과 같은 규약).
interface LiveTrendRow {
  date: string;
  avgCongestion: number | null;
  acceptShare: number | null;
}

// recharts 는 stroke/fill 을 SVG 속성으로 내보내 var(--color-*) 를 해석하지 못한다.
// 그래서 globals.css @theme 의 한옥(관리자 웜다크) 토큰 값을 여기서 미러링한다 —
// 색의 단일 정의점은 여전히 globals.css 다.
// 대비는 이 카드의 실제 배경인 --color-hanok-panel(#241d17) 기준으로 쟀다(흰 종이가 아니다):
//   voidFill  #3a2f24 vs 패널 1.28:1 — 음영은 데이터보다 약해야 하므로 의도적으로 낮다
//   voidInk   #b8a894 vs 음영 5.63:1 (AA) — 음영 위 라벨 글자
const HANOK = {
  grid: '#3a2f24',     // --color-hanok-line
  axis: '#b8a894',     // --color-hanok-muted
  voidFill: '#3a2f24', // --color-hanok-line — 미관측 구간 음영
  voidInk: '#b8a894',  // --color-hanok-muted — 음영 라벨
} as const;

export function DashboardCharts({ distribution, mode = 'demo' }: { distribution: any[]; mode?: 'live' | 'demo' }) {
  // mode='demo': distribution = [ { date, beforeCongestion, afterCongestion, alternativeUsage } ] (합성 예시)
  // mode='live': distribution = [ { date, avgCongestion, acceptShare } ] (metrics/trend KST 일별 실측, 결측일 null)
  // recharts tooltip formatter to show percentage
  // (recharts Formatter 의 value 는 number|string|Array 유니언 — 반공변 파라미터라 unknown 이 안전하게 대입된다)
  const formatPercent = (value: unknown) => `${(Number(value) * 100).toFixed(1)}%`;

  // 데이터가 비면 recharts 는 축만 그리고 선이 없어 '빈 화면'처럼 보인다 → 빈 상태 가드로 안내 문구 표시.
  const hasData = Array.isArray(distribution) && distribution.length > 0;
  const live = mode === 'live';

  // ── 미관측 구간 판정 ──────────────────────────────────────────────────────
  // 판정은 lib/adminSeriesGaps.ts 한 곳에서만 한다 — 성과 리포트(app/admin/report/page.tsx)와
  // **같은 판정**을 써야 같은 metrics/trend 응답이 두 화면에서 다른 이야기를 하지 않는다.
  // 예전에 이 차트는 connectNulls 로 결측일을 직선으로 이어 붙였다. 관측이 없던 며칠이
  // '완만하게 이어진 추세' 로 보였고, 리포트는 같은 날을 '미관측' 으로 비워 두었다.
  const liveRows: LiveTrendRow[] = live && hasData ? (distribution as LiveTrendRow[]) : [];
  const congestionStats = summarizeSeries(liveRows, (row) => row.avgCongestion);
  const acceptStats = summarizeSeries(liveRows, (row) => row.acceptShare);
  // 음영은 **두 계열 모두** 없는 날만 덮는다 — 한쪽만 없는 날까지 덮으면 있는 관측을 없다고 말한다.
  const sharedGaps = findGaps(
    liveRows,
    (row) => isMissingValue(row.avgCongestion) && isMissingValue(row.acceptShare),
  );
  const labeledGap = longestGap(sharedGaps);
  const hasMissing = congestionStats.missingDays > 0 || acceptStats.missingDays > 0;

  return (
    <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm col-span-4 flex flex-col gap-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {/* ③ 분산 효과 — 폐루프의 마지막 단계(개입이 만든 장기 추이) */}
          <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-emerald-500/15 text-emerald-700 border-emerald-500/30">
            ③ 분산 효과
          </span>
          <h3 className="text-lg font-bold text-hanok-ink">최근 30일 관광 수요 분산 효과 분석</h3>
        </div>
        {/* 실측 집계인지 시나리오인지 라벨로 가른다 — 실측이면 집계 출처를, 시나리오면 목표 패턴임을 밝힌다. */}
        {live ? (
          <span
            title="혼잡 로그의 일평균 혼잡도와 추천 기록의 일별 수락률을 KST 일 단위로 집계한 실측 추이입니다. 수집 구간 외의 날은 선을 잇지 않고 음영으로 표시합니다."
            className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-emerald-500/10 text-emerald-700 border-emerald-500/25 cursor-help"
          >
            실측 집계(30일)
          </span>
        ) : (
          <span
            title="도입 전/후 혼잡도와 대안 장소 활용률의 목표 패턴을 30일 기준으로 제시합니다."
            className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-amber-500/10 text-amber-300 border-amber-500/25 cursor-help"
          >
            도입 효과 시나리오(30일)
          </span>
        )}
      </div>

      <div className="h-[300px] w-full">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={distribution} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={HANOK.grid} />

              {/* 미관측 구간 음영 — 선을 끊기만 하면 '그날은 0% 였다' 로 읽힌다.
                  자식 순서 = 그리는 순서(뒤가 위)라, 격자 뒤·추이선 앞에 둬야
                  음영이 격자를 덮으면서도 데이터 선을 가리지 않는다. */}
              {sharedGaps.map((gap) => (
                <ReferenceArea
                  key={`gap-${gap.from}`}
                  x1={gap.from}
                  x2={gap.to}
                  fill={HANOK.voidFill}
                  fillOpacity={1}
                  stroke={HANOK.voidFill}
                  ifOverflow="extendDomain"
                >
                  {/* 라벨은 가장 긴 구간 하나에만 — 짧은 구간까지 붙이면 글자가 겹쳐 아무것도 안 읽힌다. */}
                  {labeledGap && labeledGap.from === gap.from && (
                    <Label
                      value={formatGapLabel(gap)}
                      position="insideBottom"
                      offset={10}
                      fill={HANOK.voidInk}
                      fontSize={11}
                      fontWeight={600}
                    />
                  )}
                </ReferenceArea>
              ))}

              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: HANOK.axis, fontSize: 12}} />
              <YAxis axisLine={false} tickLine={false} tick={{fill: HANOK.axis, fontSize: 12}} domain={[0, 1]} tickFormatter={(val) => `${Math.round(val * 100)}%`} />
              <Tooltip formatter={formatPercent} contentStyle={{ borderRadius: '8px', backgroundColor: '#2c241c', border: '1px solid #3a2f24', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
              {live ? (
                <>
                  {/* 실측 계열 — 반사실('도입 전') 기준선은 실측 불가라 표시하지 않는다.
                      connectNulls={false}: 결측일을 직선으로 이으면 **없는 관측을 그린 것**이다.
                      성과 리포트와 같은 정책이며, 끊긴 이유는 위 음영과 아래 캡션이 말한다. */}
                  <Line name="일평균 혼잡도(실측)" type="monotone" dataKey="avgCongestion" stroke="#3b82f6" strokeWidth={3} dot={{r: 3}} activeDot={{r: 6}} connectNulls={false} />
                  <Line name="추천 수락률(실측)" type="monotone" dataKey="acceptShare" stroke="#10b981" strokeWidth={3} dot={{r: 3}} activeDot={{r: 6}} connectNulls={false} />
                </>
              ) : (
                <>
                  <Line name="원본 장소(도입 전)" type="monotone" dataKey="beforeCongestion" stroke="#b8a894" strokeDasharray="5 5" strokeWidth={2} dot={false} />
                  <Line name="원본 장소(도입 후)" type="monotone" dataKey="afterCongestion" stroke="#3b82f6" strokeWidth={3} dot={{r: 4}} activeDot={{r: 6}} />
                  <Line name="대안 장소 활용률" type="monotone" dataKey="alternativeUsage" stroke="#10b981" strokeWidth={3} dot={{r: 4}} activeDot={{r: 6}} />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-1 text-hanok-muted">
            <p className="text-sm font-semibold">분산 효과 추이를 집계하는 중입니다.</p>
            <p className="text-xs text-hanok-muted">30일 도입 전/후 추이가 집계되면 이 영역에 표시됩니다.</p>
          </div>
        )}
      </div>

      {/* 실측일 때만, 그리고 실제로 결측이 있을 때만 낸다 — 할 말이 없으면 하지 않는다.
          끊긴 선 옆에 이 한 줄이 없으면 관리자는 '그날은 0% 였다' 로 읽는다. */}
      {live && hasData && hasMissing && (
        <p className="flex gap-1.5 text-[11px] leading-relaxed text-hanok-muted">
          <Info size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            관측 — 혼잡도 {congestionStats.observed}일 · 수락률 {acceptStats.observed}일 / {congestionStats.total}일.
            {' '}{GAP_SHADING_NOTE}
          </span>
        </p>
      )}
    </div>
  );
}

// 히트맵이 비었을 때 화면이 말해야 하는 것 — lib/dashboardFallback.ts 의 CongestionEmptyNotice 미러
// (그 파일은 이 컴포넌트에 의존하지 않는 순수 모듈이라 타입을 여기서 다시 선언한다).
interface HeatmapEmptyNotice {
  headline: string;
  detail: string;
  /** 무엇을 하면 채워지는가. 조회 실패처럼 '적재' 가 답이 아닌 경우엔 null. */
  remedy: string | null;
}

// 추정 모드에서 히트맵이 받는 표식 — lib/adminEstimateView.ts 가 만든 문구를 그대로 받는다.
interface HeatmapEstimateMark {
  /** 배지 문구('추정'). */
  badge: string;
  /** 근거 한 줄('주차 실측(ITS 공영주차 4곳) + 관광공사 집중률 기반 추정 · 14:50 관측 · 반경 2km'). */
  basisLine: string;
}

const HEATMAP_CATEGORIES = [
  { id: 'restaurant', name: '음식점' },
  { id: 'cafe', name: '카페' },
  { id: 'attraction', name: '관광지' },
  { id: 'culture', name: '문화시설' },
];

// 히트맵 차트는 CSS Grid를 이용한 커스텀 구현 (Recharts에 기본 Heatmap이 없으므로 직관적이고 커스텀 쉬운 Grid 사용)
export function DashboardHeatmap({
  heatmapData,
  dateBadge = null,
  basisNote = null,
  emptyNotice = null,
  estimate = null,
  pendingFromHour = null,
}: {
  heatmapData: HeatmapCell[];
  /** '2026-08-21 (KST) 기준' — 오늘이 아닌 날로 폴백했을 때만 들어온다. 없으면 오늘 기준이다. */
  dateBadge?: string | null;
  /** 왜 오늘이 아닌지 한 줄. 배지만으로는 '왜' 를 말하지 못한다. */
  basisNote?: string | null;
  /** 그릴 셀이 하나도 없을 때 그 자리에 세울 사실(왜 비었는가 + 무엇을 하면 채워지는가). */
  emptyNotice?: HeatmapEmptyNotice | null;
  /** 이 격자가 **추정치**라면 그 표식. 없으면 실측(제보 기반)이다. */
  estimate?: HeatmapEstimateMark | null;
  /** 오늘을 그릴 때 '아직 오지 않은 시간' 이 시작되는 KST 시. 그 칸의 빈 값은 '데이터 없음' 이 아니다. */
  pendingFromHour?: number | null;
}) {
  // heatmapData: [ { facility: string, facilityType: string, hour: number, value: number } ]

  // 관리자가 탭을 직접 고르기 전에는 **행이 있는 첫 탭**을 연다. 예전에는 늘 '음식점' 으로
  // 열려서, 행이 관광지뿐인 날(추정 모드의 대표 장소가 전부 관광지다)엔 첫 화면이
  // '해당 카테고리의 장소 데이터가 없습니다' 였다 — 데이터가 있는데 없다고 말하는 화면이다.
  const [pickedCategory, setPickedCategory] = useState<string | null>(null);
  const firstWithData =
    HEATMAP_CATEGORIES.find((cat) => heatmapData.some((d) => d.facilityType === cat.id))?.id ?? 'restaurant';
  const selectedCategory = pickedCategory ?? firstWithData;
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const categories = HEATMAP_CATEGORIES;

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
    if (value == null) return 'bg-hanok-card'; // 데이터 없음(실측 0%와 구분)
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
    setPickedCategory(catId);
    setCurrentPage(1);
  };

  // 아직 오지 않은 시간 — 오늘 격자의 오른쪽 빈 칸은 '관측 없음' 이 아니라 '미래' 다.
  // 둘을 같은 회색으로 그리면 새벽에 연 화면이 '하루 종일 수집이 죽었다' 로 읽힌다.
  const isPending = (hour: number) => pendingFromHour !== null && hour >= pendingFromHour;

  return (
    // 추정 격자는 테두리를 점선(하늘색)으로 바꾼다 — 색 칸 자체는 실측과 같은 척도로 읽혀야 하므로
    // 칸 색은 건드리지 않고, 카드 전체의 테두리·배지·범례로 '실측이 아니다' 를 말한다.
    <div className={`bg-hanok-panel p-6 rounded-2xl shadow-sm col-span-4 flex flex-col justify-between overflow-x-auto min-h-[500px] ${
      estimate ? 'border-2 border-dashed border-sky-400/50' : 'border border-hanok-line'
    }`}>
      <div>
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* ① 실시간 관제 — 폐루프 첫 단계(현재 혼잡 모니터링) */}
              <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-gold/15 text-gold-deep border-gold/30">
                ① 실시간 관제
              </span>
              <h3 className="text-lg font-bold text-hanok-ink">장소별 시간대 혼잡 히트맵</h3>
              {/* 지표 출처를 제목 옆에 못 박는다 — 아래 '공영주차 실측(경주 ITS)' 카드와
                  같은 화면에 있어서, 라벨이 없으면 두 숫자가 한 지표처럼 읽힌다. */}
              {estimate ? (
                <span className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-black border border-dashed bg-sky-500/15 text-sky-700 border-sky-400/60">
                  시설 혼잡 · {estimate.badge} (주차 실측 + 관광 통계)
                </span>
              ) : (
                <span className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-hanok-card text-hanok-muted border-hanok-line">
                  시설 혼잡 · 제보 기반
                </span>
              )}
              {/* 기준일 배지 — 오늘이 아닌 날을 그리고 있다면 그 사실이 제목만큼 커야 한다. */}
              {dateBadge && (
                <span className="flex-shrink-0 px-2.5 py-1 rounded-md text-xs font-black border bg-amber-500/15 text-amber-300 border-amber-500/40">
                  {dateBadge}
                </span>
              )}
            </div>
            {basisNote && <p className="mt-2 text-xs text-amber-300/90 max-w-2xl">{basisNote}</p>}
            {estimate && <p className="mt-2 text-xs text-sky-700/90 max-w-2xl">{estimate.basisLine}</p>}
          </div>

          {/* Category Filters */}
          <div className="flex gap-2 flex-shrink-0">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => handleCategoryChange(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  selectedCategory === cat.id
                    ? 'bg-gold/10 border-gold/30 text-gold-deep font-bold'
                    : 'bg-hanok-card border-hanok-line text-hanok-muted hover:bg-hanok-line'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        {/* 셀이 하나도 없으면 격자를 그리는 대신 **왜 비었는지**를 그 자리에 세운다.
            빈 격자는 '전 시간대 여유' 로도, '고장' 으로도 읽힌다 — 어느 쪽도 사실이 아니다. */}
        {heatmapData.length === 0 && emptyNotice ? (
          <div className="min-h-[260px] flex flex-col items-center justify-center gap-2 rounded-xl border border-hanok-line bg-hanok-card/40 px-6 py-10 text-center">
            <p className="text-sm font-bold text-hanok-ink">{emptyNotice.headline}</p>
            <p className="max-w-2xl text-xs leading-relaxed text-hanok-muted">{emptyNotice.detail}</p>
            {emptyNotice.remedy && (
              <p className="max-w-2xl text-xs leading-relaxed text-hanok-muted border-t border-hanok-line pt-2 mt-1">
                {emptyNotice.remedy}
              </p>
            )}
          </div>
        ) : (
        <div className="min-w-[800px]">
          {/* X축 (시간) */}
          <div className="flex ml-36 mb-2">
            {hours.map(h => (
              <div key={h} className="flex-1 text-center text-xs text-hanok-muted font-medium">
                {h}시
              </div>
            ))}
          </div>
          
          {/* 시설별 로우 */}
          <div className="flex flex-col gap-2 min-h-[160px]">
            {paginatedFacilities.map(fac => (
              <div key={fac} className="flex items-center">
                <div className="w-36 text-sm font-semibold text-hanok-ink truncate pr-4 text-right">
                  {fac}
                </div>
                <div className="flex-1 flex gap-1">
                  {hours.map(h => {
                    const val = getHeatmapValue(fac, h);
                    const pending = val == null && isPending(h);
                    const label = estimate ? '추정 ' : '';
                    return (
                      <div
                        key={`${fac}-${h}`}
                        title={
                          pending
                            ? `${fac} ${h}시: 아직 오지 않은 시간`
                            : val == null
                              ? `${fac} ${h}시: 수집 중`
                              : `${fac} ${h}시: ${label}${(val * 100).toFixed(0)}%`
                        }
                        className={`flex-1 h-8 rounded-sm transition-colors hover:ring-2 hover:ring-gold cursor-pointer ${
                          pending ? 'border border-dashed border-hanok-line bg-transparent' : getHeatmapColor(val)
                        }`}
                      ></div>
                    );
                  })}
                </div>
              </div>
            ))}
            {paginatedFacilities.length === 0 && (
              <div className="h-32 flex items-center justify-center text-hanok-muted text-sm">
                이 카테고리는 다음 수집 주기에 표시됩니다.
              </div>
            )}
          </div>

          {/* 범례 */}
          <div className="flex justify-end items-center flex-wrap gap-4 mt-6 text-xs text-hanok-muted">
            {estimate && (
              <div className="flex items-center gap-1 font-semibold text-sky-700">
                <div className="w-4 h-4 rounded-sm border-2 border-dashed border-sky-400/60"></div>
                모든 칸이 {estimate.badge} 혼잡도입니다
              </div>
            )}
            {pendingFromHour !== null && (
              <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm border border-dashed border-hanok-line"></div>아직 오지 않은 시간</div>
            )}
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-hanok-card border border-hanok-line"></div>수집 중</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-emerald-100"></div>여유 (0~30%)</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-emerald-400"></div>보통 (30~60%)</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-amber-400"></div>혼잡 (60~80%)</div>
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-sm bg-rose-500"></div>매우 혼잡 (80%~)</div>
          </div>
        </div>
        )}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-hanok-line pt-4 mt-6">
          <div className="text-xs text-hanok-muted font-medium">
            총 {totalItems}개 중 {startIndex + 1}-{Math.min(startIndex + itemsPerPage, totalItems)}개 표시
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 10, 1))}
              disabled={currentPage === 1}
              title="10페이지 이전"
              className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              title="이전 페이지"
              className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs text-hanok-muted font-semibold px-2">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              title="다음 페이지"
              className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(prev => Math.min(prev + 10, totalPages))}
              disabled={currentPage === totalPages}
              title="10페이지 다음"
              className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
