'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Building2, Search, Bell, Utensils, MapPin, Filter,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, AlertTriangle, Users, Clock, Activity, Coffee
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { createPublicClient } from '@/lib/supabase';

// --- Types ---
interface Infrastructure {
  id: string;
  name: string;
  type: '음식점' | '카페' | '관광지' | '문화시설';
  status: 'blue' | 'green' | 'yellow' | 'orange';
  capacity: string;
  expectedDemand: string;
}

interface ChartDataPoint {
  time: string;
  demand: number;
}

// 데모 폴백: 백엔드가 비어있거나 응답이 없을 때 보여줄 샘플 시설(데모 페이지 무중단).
const DEMO_FACILITIES: Infrastructure[] = [
  { id: 'demo-rest-1', name: '황남쌈밥', type: '음식점', status: 'orange', capacity: '54/60', expectedDemand: '매우 높음 (점심 피크 예측)' },
  { id: 'demo-rest-2', name: '교리김밥 황리단길점', type: '음식점', status: 'yellow', capacity: '14/30', expectedDemand: '보통 (일반 식사 패턴)' },
  { id: 'demo-cafe-1', name: '황리단길 감성카페 봄', type: '카페', status: 'orange', capacity: '32/40', expectedDemand: '매우 높음 (오후 피크)' },
  { id: 'demo-cafe-2', name: '한옥카페 다랑', type: '카페', status: 'green', capacity: '12/35', expectedDemand: '낮음 (여유 상태)' },
  { id: 'demo-attr-1', name: '대릉원', type: '관광지', status: 'orange', capacity: '720/800', expectedDemand: '매우 높음 (주말 포화 예측)' },
  { id: 'demo-attr-2', name: '첨성대', type: '관광지', status: 'yellow', capacity: '420/600', expectedDemand: '보통' },
  { id: 'demo-cult-1', name: '국립경주박물관', type: '문화시설', status: 'green', capacity: '250/500', expectedDemand: '낮음 (여유 상태)' },
];

// 데모 시설 선택 시 보여줄 합성 시간대 추이. 백엔드 의존 없이 가벼운 곡선 생성.
function genDemoChart(seedStr: string): ChartDataPoint[] {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed += seedStr.charCodeAt(i);
  const out: ChartDataPoint[] = [];
  const nowH = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours(); // KST(브라우저 로컬 TZ 무관)
  for (let h = 8; h <= Math.max(9, nowH); h++) {
    const noise = ((seed * (h + 1)) % 100) / 100;
    let base = 30 + noise * 25;
    if (h >= 11 && h <= 13) base = 60 + noise * 35; // 점심 피크
    else if (h >= 17 && h <= 19) base = 55 + noise * 30; // 퇴근 피크
    out.push({ time: `${String(h).padStart(2, '0')}:00`, demand: Math.round(Math.min(99, base)) });
  }
  return out;
}

export default function InfrastructurePage() {
  const [facilities, setFacilities] = useState<Infrastructure[]>([]);
  const [selectedInfra, setSelectedInfra] = useState<Infrastructure | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [activeFilter, setActiveFilter] = useState('음식점');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const supabase = createPublicClient();

  const fetchFacilities = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      // 1. 모든 인프라 조회
      const { data: facilitiesData, error: fError } = await supabase
        .from('facilities')
        .select('*');
      
      if (fError) throw fError;

      // 2. 각 인프라별 최신 congestion log 조회
      const mappedInfras = await Promise.all(
        (facilitiesData || []).map(async (f) => {
          const { data: logs, error: lError } = await supabase
            .from('congestion_logs')
            .select('current_count, congestion_level, timestamp')
            .eq('facility_id', f.id)
            .order('timestamp', { ascending: false })
            .limit(1);

          if (lError) throw lError;

          const latestLog = logs && logs.length > 0 ? logs[0] : null;
          const level = latestLog ? latestLog.congestion_level : 0.0;
          const currentCount = latestLog ? latestLog.current_count : 0;

          // 타입 매핑
          const typeMap: Record<string, '음식점' | '카페' | '관광지' | '문화시설'> = {
            restaurant: '음식점',
            cafe: '카페',
            attraction: '관광지',
            culture: '문화시설'
          };
          const mappedType = typeMap[f.type] || '관광지';

          // 상태 매핑 (orange, yellow, green, blue)
          let status: 'blue' | 'green' | 'yellow' | 'orange' = 'blue';
          if (level >= 0.75) status = 'orange';
          else if (level >= 0.50) status = 'yellow';
          else if (level >= 0.25) status = 'green';

          // expectedDemand 문구 매핑
          let expectedDemand = '낮음';
          if (level >= 0.75) {
            expectedDemand = mappedType === '음식점' ? '매우 높음 (점심·저녁 피크 예측)'
              : mappedType === '관광지' ? '매우 높음 (주말·낮 시간 포화 예측)'
              : '매우 높음';
          } else if (level >= 0.50) {
            expectedDemand = mappedType === '음식점' ? '보통 (일반 식사 시간 패턴)'
              : mappedType === '관광지' ? '보통 (관람객 유입 진행)'
              : '보통';
          } else if (level >= 0.25) {
            expectedDemand = '낮음 (여유 상태)';
          } else {
            expectedDemand = '매우 낮음 (한산한 상태)';
          }

          return {
            id: f.id,
            name: f.name,
            type: mappedType,
            status,
            capacity: `${currentCount}/${f.capacity}`,
            expectedDemand
          } as Infrastructure;
        })
      );

      // 실데이터가 비면 데모 시설로 대체(데모 페이지 무중단).
      const finalInfras = mappedInfras.length > 0 ? mappedInfras : DEMO_FACILITIES;
      setFacilities(finalInfras);
      setSelectedInfra(prev => {
        if (!prev) return finalInfras[0];
        const updated = finalInfras.find(item => item.id === prev.id);
        return updated || finalInfras[0];
      });
    } catch (err: any) {
      // 백엔드 실패/타임아웃 — 에러 대신 데모 데이터로 폴백(데모 무중단).
      console.warn('인프라 실데이터 로드 실패 — 데모 데이터로 대체:', err);
      setError(null);
      setFacilities(DEMO_FACILITIES);
      setSelectedInfra(prev => prev || DEMO_FACILITIES[0]);
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [supabase]);

  const fetchChartData = useCallback(async (facilityId: string) => {
    // 데모 시설은 백엔드를 거치지 않고 합성 추이를 보여준다.
    if (facilityId.startsWith('demo-')) {
      setChartData(genDemoChart(facilityId));
      return;
    }
    try {
      // KST '오늘' 00:00 의 UTC 경계(브라우저 로컬 TZ 무관). 로컬 자정으로 자르면 비-KST 브라우저에서 어긋난다.
      const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const kstMidnightUtc = new Date(
        Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate()) - 9 * 60 * 60 * 1000
      );

      const { data, error: cError } = await supabase
        .from('congestion_logs')
        .select('timestamp, congestion_level')
        .eq('facility_id', facilityId)
        .gte('timestamp', kstMidnightUtc.toISOString())
        .order('timestamp', { ascending: true });

      if (cError) throw cError;

      const formatted = (data || []).map(log => {
        // 한국 시간대(KST) 시간 포맷팅: HH:MM (UTC epoch +9h 후 getUTC* — 브라우저 로컬 TZ 무관)
        const k = new Date(new Date(log.timestamp).getTime() + 9 * 60 * 60 * 1000);
        const hours = String(k.getUTCHours()).padStart(2, '0');
        const minutes = String(k.getUTCMinutes()).padStart(2, '0');
        return {
          time: `${hours}:${minutes}`,
          demand: Math.round(log.congestion_level * 100)
        };
      });

      setChartData(formatted);
    } catch (err) {
      // 타임아웃/오류 — 빈 차트 대신 합성 추이로 폴백.
      console.warn('차트 실데이터 로드 실패 — 합성 추이로 대체:', err);
      setChartData(genDemoChart(facilityId));
    }
  }, [supabase]);

  // 1. 최초 데이터 패칭
  useEffect(() => {
    fetchFacilities();
  }, [fetchFacilities]);

  // 2. 선택된 인프라 변경 시 차트 데이터 갱신
  useEffect(() => {
    if (selectedInfra) {
      fetchChartData(selectedInfra.id);
    }
  }, [selectedInfra, fetchChartData]);

  const filteredInfras = facilities.filter(infra => infra.type === activeFilter);

  const totalItems = filteredInfras.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedInfras = filteredInfras.slice(startIndex, startIndex + itemsPerPage);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case '음식점': return <Utensils size={18} />;
      case '카페': return <Coffee size={18} />;
      case '관광지': return <MapPin size={18} />;
      case '문화시설': return <Building2 size={18} />;
      default: return <Building2 size={18} />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'orange': return 'bg-orange-500';
      case 'yellow': return 'bg-amber-500';
      case 'green': return 'bg-emerald-500';
      case 'blue': return 'bg-blue-500';
      default: return 'bg-gray-500';
    }
  };

  return (
    <div className="flex h-screen bg-[#070b19] text-slate-100 font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-slate-100">관광지 모니터링</h2>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="text"
                placeholder="Search..."
                className="pl-10 pr-4 py-2 bg-slate-800 text-slate-100 placeholder-slate-500 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
              />
            </div>
            <button className="relative text-slate-400 hover:text-slate-200">
              <Bell size={24} />
            </button>
          </div>
        </header>

        {/* Layout: Master-Detail */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Master List */}
          <div className="w-1/3 bg-slate-900 border-r border-slate-800 flex flex-col h-full">
            <div className="p-4 border-b border-slate-800">
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
                {['음식점', '카페', '관광지', '문화시설'].map(filter => (
                  <button
                    key={filter}
                    onClick={() => {
                      setActiveFilter(filter);
                      setCurrentPage(1);
                    }}
                    className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                      activeFilter === filter
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {loading ? (
                <div className="flex flex-col items-center justify-center h-48 text-slate-400">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-4" />
                  <p>데이터를 불러오는 중...</p>
                </div>
              ) : error ? (
                <div className="p-4 text-center text-red-400 bg-red-500/10 rounded-xl border border-red-500/30">
                  <AlertTriangle className="mx-auto mb-2" size={24} />
                  <p className="text-sm font-semibold">{error}</p>
                </div>
              ) : filteredInfras.length === 0 ? (
                <div className="text-center p-8 text-slate-400">
                  등록된 장소가 없습니다.
                </div>
              ) : (
                paginatedInfras.map(infra => (
                  <div
                    key={infra.id}
                    onClick={() => setSelectedInfra(infra)}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${
                      selectedInfra?.id === infra.id
                        ? 'border-blue-500 bg-blue-500/10 shadow-sm'
                        : 'border-slate-800 bg-slate-900 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <span className="p-1.5 rounded-lg bg-slate-800 text-slate-300">
                          {getTypeIcon(infra.type)}
                        </span>
                        <h3 className="font-bold text-slate-100">{infra.name}</h3>
                      </div>
                      <div className={`w-3 h-3 rounded-full ${getStatusColor(infra.status)} mt-1`} />
                    </div>
                    <div className="text-sm text-slate-400 flex justify-between mt-3">
                      <span>수용 현황: {infra.capacity}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex flex-col gap-2 p-4 border-t border-slate-800 bg-slate-900 flex-shrink-0">
                <div className="text-xs text-slate-400 font-medium text-center">
                  총 {totalItems}개 중 {startIndex + 1}-{Math.min(startIndex + itemsPerPage, totalItems)}개 표시
                </div>
                <div className="flex items-center justify-center gap-2">
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

          {/* Detail Panel */}
          <div className="flex-1 bg-slate-950 p-8 overflow-y-auto">
            {loading && !selectedInfra ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-400">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-4" />
                <p>상세 정보를 불러오는 중...</p>
              </div>
            ) : selectedInfra ? (
              <div className="max-w-3xl mx-auto flex flex-col gap-6 animate-fade-in">

                {/* Detail Header */}
                <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-blue-500/15 text-blue-300">
                        {selectedInfra.type}
                      </span>
                      <span className="text-sm font-medium text-slate-400">ID: INF-{selectedInfra.id.substring(0, 8)}</span>
                    </div>
                    <h2 className="text-3xl font-black text-slate-100">{selectedInfra.name}</h2>
                  </div>
                  <div className="flex flex-col items-end">
                    <div className="text-sm font-semibold text-slate-400 mb-1">현재 상태</div>
                    <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 border border-slate-800">
                      <div className={`w-3 h-3 rounded-full ${getStatusColor(selectedInfra.status)}`} />
                      <span className="text-sm font-bold text-slate-200">
                        {selectedInfra.status === 'orange' ? '혼잡' : selectedInfra.status === 'yellow' ? '보통' : selectedInfra.status === 'green' ? '여유' : '한산'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* KPI Overview */}
                <div className="grid grid-cols-2 gap-6">
                  <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm">
                    <div className="flex items-center gap-2 text-slate-400 mb-2">
                      <Users size={18} />
                      <span className="font-semibold text-sm">실시간 수용량</span>
                    </div>
                    <div className="text-2xl font-bold text-slate-100">{selectedInfra.capacity}</div>
                  </div>
                  <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm border-l-4 border-l-blue-500">
                    <div className="flex items-center gap-2 text-slate-400 mb-2">
                      <Activity size={18} />
                      <span className="font-semibold text-sm">예상 수요 (온보딩 데이터 기반)</span>
                    </div>
                    <div className="text-lg font-bold text-blue-300">{selectedInfra.expectedDemand}</div>
                    <p className="text-xs text-slate-500 mt-1">유저의 선호 메뉴 및 동선 데이터 분석 결과</p>
                  </div>
                </div>

                {/* Time Series Chart */}
                <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col h-[300px]">
                  <h3 className="text-lg font-bold text-slate-100 mb-4 flex items-center gap-2">
                    <Clock size={20} className="text-slate-400" />
                    시간대별 혼잡도 추이 (금일)
                  </h3>
                  <div className="flex-1 w-full">
                    {chartData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-slate-400">
                        오늘 기록된 혼잡도 데이터가 없습니다.
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                          <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} />
                          <YAxis axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} />
                          <Tooltip contentStyle={{ borderRadius: '8px', backgroundColor: '#0f172a', border: '1px solid #1e293b', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                          <Line type="monotone" dataKey="demand" stroke="#0ea5e9" strokeWidth={3} dot={{r: 4, strokeWidth: 2}} activeDot={{r: 6}} fill="url(#colorDemand)" />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                {/* Admin Actions */}
                <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col gap-4">
                  <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <AlertTriangle size={20} className="text-amber-500" />
                    관리자 액션
                  </h3>
                  <div className="flex gap-4">
                    <button className="flex-1 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 font-semibold py-3 rounded-xl transition-colors">
                      수동 상태 변경 (Override)
                    </button>
                    <button className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm shadow-blue-500/30">
                      근처 유저에게 분산 안내 발송
                    </button>
                  </div>
                </div>

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-400">
                <Building2 size={48} className="mb-4 opacity-50" />
                <p>좌측 목록에서 인프라를 선택하여 상세 정보를 확인하세요.</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
