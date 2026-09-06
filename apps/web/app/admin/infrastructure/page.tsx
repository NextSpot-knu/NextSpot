'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Building2, Search, Bell, Utensils, MapPin,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronDown, ChevronUp,
  AlertTriangle, Users, Clock, Activity, Coffee,
  SlidersHorizontal, X, Inbox
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { createPublicClient } from '@/lib/supabase';
import { adminApi } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import {
  chunk,
  facilityStatusKey,
  facilityStatusLabel,
  observedLevel,
  type FacilityCongestion,
} from '@/lib/adminMetricState';
import { toast } from 'sonner';

// --- Types ---
interface Infrastructure {
  id: string;
  name: string;
  type: '음식점' | '카페' | '관광지' | '문화시설';
  // 최신 혼잡 상태. '관측 없음'(none)과 '조회 실패'(unavailable)를 level=0 으로 뭉개지 않는다 —
  // 예전 코드는 둘 다 0.0 으로 만들어 '한산' 으로 그렸고, 그건 없는 사실을 만들어내는 것이었다.
  congestion: FacilityCongestion;
  capacity: string;
}

// facilities 에서 화면이 실제로 쓰는 컬럼만 고른다. select('*') 는 features(파이프라인 출처 기록)까지
// 1,600행 분량으로 끌고 와 브라우저·Supabase 양쪽에 불필요한 부하를 준다.
const FACILITY_COLUMNS = 'id, name, type, capacity';
// PostgREST 는 단일 응답 행수를 기본 1000 으로 캡한다. 실측 시설 수가 1,664 라
// select 한 번으로는 664곳이 **조용히** 누락된다(2026-09-06 프로덕션 확인).
const FACILITY_PAGE_SIZE = 1000;
// 무한 루프 방지 상한(= 20,000곳). 도달하면 페이지네이션이 잘못된 것이므로 멈춘다.
const MAX_FACILITY_PAGES = 20;
// latest_congestion_for_facilities 는 시설당 최대 1행을 돌려주므로 500개씩 끊으면 캡에 걸리지 않는다.
const CONGESTION_CHUNK_SIZE = 500;

// latest_congestion_for_facilities RPC 반환 행(snake_case 그대로).
interface LatestCongestionRow {
  facility_id: string;
  congestion_level: number | null;
  current_count: number | null;
  timestamp: string;
  source: string | null;
  evidence_tier: string | null;
}

// 이상(anomaly) 알림 임계치 — 최신 혼잡도가 이 값 이상이면 관리자 알림 대상(포화 위험).
const ANOMALY_THRESHOLD = 0.9;

interface ChartDataPoint {
  time: string;
  demand: number;
}

// 실시간 키워드 게이트웨이(2위 기획) 승인 큐 — GET /api/v1/search/ingest-requests(status=pending) 행.
// snake_case 그대로 사용(adminApi 는 admin-api.ts 도크대로 camelCase 변환을 하지 않는다).
interface IngestRequest {
  id: string;
  contentid: string;
  name: string | null;
  content_type_id: number | null;
  status: string;
  created_at: string;
}

export default function InfrastructurePage() {
  const [facilities, setFacilities] = useState<Infrastructure[]>([]);
  const [selectedInfra, setSelectedInfra] = useState<Infrastructure | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [chartError, setChartError] = useState<string | null>(null); // 추이 조회 실패 ≠ 오늘 기록 없음
  const [activeFilter, setActiveFilter] = useState('음식점');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [loading, setLoading] = useState(true);
  // 시설 목록 조회 실패와 최신 혼잡도 조회 실패는 서로 다른 사실이라 따로 보관한다.
  // (목록은 왔는데 혼잡만 못 가져온 경우, 목록은 그대로 쓰고 혼잡 칸만 '조회 실패' 로 그린다.)
  const [error, setError] = useState<string | null>(null);
  const [congestionError, setCongestionError] = useState<string | null>(null);
  // 검색(클라이언트 필터)·알림 드롭다운·Override 모달 UI 상태
  const [searchQuery, setSearchQuery] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideLevel, setOverrideLevel] = useState(50); // 0~100(%) 슬라이더 값
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);

  // 적재 요청 대기(실시간 키워드 게이트웨이 승인 큐) — 접이식 섹션 상태.
  const [ingestRequests, setIngestRequests] = useState<IngestRequest[]>([]);
  const [ingestRequestsOpen, setIngestRequestsOpen] = useState(true);
  const [ingestRequestsLoading, setIngestRequestsLoading] = useState(true);
  const [approvingIngestId, setApprovingIngestId] = useState<string | null>(null);

  const supabase = createPublicClient();

  const fetchIngestRequests = useCallback(async () => {
    setIngestRequestsLoading(true);
    try {
      const data = await adminApi.get('/api/v1/search/ingest-requests?status=pending');
      setIngestRequests(Array.isArray(data) ? data : []);
    } catch (err) {
      // 라우터 미배선/마이그레이션 미적용 환경 — 대기 0건과 동일하게 조용히 숨김(데모 무중단).
      console.warn('적재 요청 목록 로드 실패:', err);
      setIngestRequests([]);
    } finally {
      setIngestRequestsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIngestRequests();
  }, [fetchIngestRequests]);

  const approveIngestRequest = async (req: IngestRequest) => {
    setApprovingIngestId(req.id);
    try {
      await adminApi.post('/api/v1/search/ingest-requests/approve', { id: req.id });
      toast.success('적재 요청 승인 완료', {
        description: `'${req.name || req.contentid}'을(를) 적재했습니다.`,
      });
      setIngestRequests(prev => prev.filter(r => r.id !== req.id));
    } catch (err) {
      toast.error('승인 실패', { description: errorMessage(err) || '잠시 후 다시 시도해 주세요.' });
    } finally {
      setApprovingIngestId(null);
    }
  };

  // 시설 목록 전체를 페이지네이션으로 받는다(PostgREST 1000행 캡 회피).
  // order('id') 없이 range 를 쓰면 페이지 경계에서 행이 중복/누락될 수 있으므로 정렬을 고정한다.
  const fetchAllFacilities = useCallback(async () => {
    const rows: { id: string; name: string; type: string; capacity: number }[] = [];
    for (let page = 0; page < MAX_FACILITY_PAGES; page++) {
      const from = page * FACILITY_PAGE_SIZE;
      const { data, error: fError } = await supabase
        .from('facilities')
        .select(FACILITY_COLUMNS)
        .order('id', { ascending: true })
        .range(from, from + FACILITY_PAGE_SIZE - 1);
      if (fError) throw fError;
      const batch = data || [];
      rows.push(...batch);
      if (batch.length < FACILITY_PAGE_SIZE) return rows;
    }
    // 상한까지 채웠다면 목록이 잘린 것이다. 잘린 목록을 정상인 척 반환하지 않는다.
    throw new Error(`시설 목록이 상한(${MAX_FACILITY_PAGES * FACILITY_PAGE_SIZE}곳)을 넘었습니다. 페이지네이션을 확인하세요.`);
  }, [supabase]);

  // 시설 1,600여 곳의 최신 혼잡을 **묶어서** 조회한다.
  //
  // 예전에는 시설마다 congestion_logs 를 limit(1) 로 병렬 조회했다 — 화면 한 번 여는 데
  // 1,664 요청이 브라우저와 Supabase 양쪽을 때렸다. DB 에는 이미 같은 일을 한 번에 하는
  // latest_congestion_for_facilities(DISTINCT ON) RPC 가 있다(20260820123000 마이그레이션).
  //
  // 필터가 같은지 확인하고 바꿨다: RPC 는 evidence_tier IN (single_report, corroborated,
  // verified) 로 예전 쿼리와 동일하게 거르고, 여기에 source NOT IN ('seed','simulated') 가
  // 더 붙는다. 프로덕션의 seed 행은 전부 evidence_tier='synthetic' 이라(2026-09-06 확인:
  // seed 1,352행 전부 synthetic) 예전 쿼리에서도 이미 제외되던 행들이다 — 표시 결과는 같다.
  const fetchLatestCongestion = useCallback(async (ids: string[]) => {
    const byFacility = new Map<string, LatestCongestionRow>();
    // RPC 도 PostgREST 응답 캡(1000행)을 받는다. 시설당 1행이므로 500개씩이면 안전하다.
    const responses = await Promise.all(
      chunk(ids, CONGESTION_CHUNK_SIZE).map(async (part) => {
        const { data, error: rpcError } = await supabase
          .rpc('latest_congestion_for_facilities', { facility_ids: part });
        if (rpcError) throw rpcError;
        return (data || []) as LatestCongestionRow[];
      })
    );
    for (const rows of responses) {
      for (const row of rows) byFacility.set(String(row.facility_id), row);
    }
    return byFacility;
  }, [supabase]);

  const fetchFacilities = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const facilityRows = await fetchAllFacilities();
      const ids = facilityRows.map((f) => String(f.id));

      // 혼잡 조회는 시설 목록과 **별개 실패 경로**다. 여기서 실패해도 시설 목록 자체는
      // 살아 있으므로 목록을 지우지 않고, 혼잡 칸만 '조회 실패' 로 표시한다.
      let latest: Map<string, LatestCongestionRow> | null = null;
      try {
        latest = await fetchLatestCongestion(ids);
        setCongestionError(null);
      } catch (err) {
        console.warn('최신 혼잡도 일괄 조회 실패:', err);
        setCongestionError(errorMessage(err) || '최신 혼잡도를 불러오지 못했습니다.');
      }

      const typeMap: Record<string, '음식점' | '카페' | '관광지' | '문화시설'> = {
        restaurant: '음식점',
        cafe: '카페',
        attraction: '관광지',
        culture: '문화시설',
      };

      const mappedInfras: Infrastructure[] = facilityRows.map((f) => {
        const latestLog = latest ? latest.get(String(f.id)) ?? null : null;
        const congestion: FacilityCongestion =
          latest === null
            ? { kind: 'unavailable' }      // 혼잡 조회 자체가 실패 — '한산' 이 아니다
            : latestLog && latestLog.congestion_level != null
              ? { kind: 'observed', level: latestLog.congestion_level }
              : { kind: 'none' };          // 조회는 됐고, 이 시설엔 아직 관측이 없다
        // 인원 수는 CCTV 계수일 때만 실측이다(제보/관리자 개입은 정원×비율 추정값).
        const currentCount = latestLog?.source === 'traffic_cctv' ? latestLog.current_count : null;
        return {
          id: String(f.id),
          name: f.name,
          type: typeMap[f.type] || '관광지',
          congestion,
          capacity: currentCount == null ? `${f.capacity} 정원 · 인원 미계수` : `${currentCount}/${f.capacity}`,
        };
      });

      setError(null);
      setFacilities(mappedInfras);
      setSelectedInfra(prev => {
        if (!prev) return mappedInfras[0] ?? null;
        const updated = mappedInfras.find(item => item.id === prev.id);
        return updated || mappedInfras[0] || null;
      });
    } catch (err) {
      // 시설 목록 조회 실패 — 빈 목록으로 두면 '등록된 장소가 없습니다' 로 읽힌다.
      // 마지막으로 받아둔 목록은 지우지 않고(알림 배지가 0건으로 거짓말하지 않도록) 오류를 표시한다.
      console.warn('시설 목록 로드 실패:', err);
      setError(errorMessage(err) || '시설 목록을 불러오지 못했습니다.');
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [fetchAllFacilities, fetchLatestCongestion]);

  const fetchChartData = useCallback(async (facilityId: string) => {
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
        .in('evidence_tier', ['single_report', 'corroborated', 'verified'])
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
      setChartError(null);
    } catch (err) {
      // 빈 배열로 두면 '오늘 기록이 없다' 로 읽힌다 — 실패는 실패라고 적는다.
      console.warn('차트 실데이터 로드 실패:', err);
      setChartData([]);
      setChartError(errorMessage(err) || '혼잡도 추이를 불러오지 못했습니다.');
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

  // 활성 유형 탭 + 검색어(이름/유형, 대소문자 무시) 클라이언트 필터.
  const searchLower = searchQuery.trim().toLowerCase();
  const filteredInfras = facilities.filter(infra => {
    if (infra.type !== activeFilter) return false;
    if (!searchLower) return true;
    return infra.name.toLowerCase().includes(searchLower) || infra.type.toLowerCase().includes(searchLower);
  });

  // 이상 알림: 이미 로드된 시설 데이터에서 임계치 이상 시설만(혼잡도 내림차순). 추가 백엔드 호출 없음.
  // 관측이 없거나 조회에 실패한 시설은 판정 대상이 아니다(0 으로 간주해 '정상' 처리하지 않는다 —
  // 판정 불가라는 사실은 아래 드롭다운의 경고 문구가 따로 알린다).
  const anomalies = facilities
    .map(infra => ({ infra, level: observedLevel(infra.congestion) }))
    .filter((row): row is { infra: Infrastructure; level: number } => row.level !== null && row.level >= ANOMALY_THRESHOLD)
    .sort((a, b) => b.level - a.level);
  // 혼잡도를 못 가져왔으면 '이상 0건' 은 판정 결과가 아니라 판정 불가다.
  const anomalyJudgementBlocked = congestionError !== null || error !== null;

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

  // 상태 점 색. unknown(관측 없음/조회 실패)은 혼잡 등급 색을 쓰지 않고 회색 테두리만 둔다 —
  // 색이 같으면 '측정된 한산' 과 구분이 안 된다.
  const getStatusColor = (c: FacilityCongestion) => {
    switch (facilityStatusKey(c)) {
      case 'orange': return 'bg-orange-500';
      case 'yellow': return 'bg-amber-500';
      case 'green': return 'bg-emerald-500';
      case 'blue': return 'bg-gold';
      default: return 'bg-transparent border border-dashed border-hanok-muted';
    }
  };

  // 관리자 액션: 수동 혼잡도 설정(Override) — 모달을 열어 레벨 선택. 현재 혼잡도를 슬라이더 초기값으로.
  const handleOverride = () => {
    if (!selectedInfra) return;
    // 관측이 없거나 조회에 실패했으면 초기값을 지어내지 않고 슬라이더 중앙(50%)에서 시작한다.
    const level = observedLevel(selectedInfra.congestion);
    setOverrideLevel(level === null ? 50 : Math.round(Math.min(1, Math.max(0, level)) * 100));
    setOverrideOpen(true);
  };

  // Override 확정 — FastAPI(service_role)로 congestion_logs 에 수동 혼잡도 1행 기록 후 목록 무음 갱신.
  const submitOverride = async () => {
    if (!selectedInfra) return;
    const level = Math.min(1, Math.max(0, overrideLevel / 100));
    setOverrideSubmitting(true);
    try {
      await adminApi.post(`/api/v1/admin/facilities/${selectedInfra.id}/congestion`, { level });
      toast.success('혼잡 상태 변경 완료', {
        description: `'${selectedInfra.name}'의 혼잡도를 ${overrideLevel}%로 설정했습니다.`,
      });
      setOverrideOpen(false);
      await fetchFacilities(true); // 최신 혼잡도 반영(무음 갱신 — 목록/차트 재조회)
    } catch (err) {
      toast.error('혼잡 상태 변경 실패', {
        description: errorMessage(err) || '잠시 후 다시 시도해 주세요.',
      });
    } finally {
      setOverrideSubmitting(false);
    }
  };

  // 알림에서 이상 시설 선택 — 해당 유형 탭으로 전환하고 상세를 연다(검색어/페이지 초기화).
  const openAnomaly = (infra: Infrastructure) => {
    setActiveFilter(infra.type);
    setSearchQuery('');
    setCurrentPage(1);
    setSelectedInfra(infra);
    setNotifOpen(false);
  };

  // 관리자 액션: 근처 유저에게 분산 안내 발송 — 개입 스토리 데모 확인 토스트(실발송 연동 전, 데모 시뮬레이션).
  const handleDispatch = () => {
    if (!selectedInfra) return;
    toast.success('분산 안내 발송 완료', {
      description: `'${selectedInfra.name}' 인근 유저에게 대안 장소 안내를 전송했습니다. (데모)`,
    });
  };

  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-hanok-ink">관광지 모니터링</h2>
          <div className="flex items-center gap-6">
            {/* 검색: 로드된 시설을 이름/유형으로 클라이언트 필터 */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-hanok-muted" size={18} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                placeholder="장소 검색 (이름·유형)"
                title="이름 또는 유형으로 검색"
                className="pl-10 pr-8 py-2 bg-hanok-card text-hanok-ink placeholder-hanok-muted rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold w-64"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); setCurrentPage(1); }}
                  title="검색어 지우기"
                  aria-label="검색어 지우기"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-hanok-muted hover:text-hanok-ink"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            {/* 알림: 이상(포화 위험) 시설 수 배지 + 드롭다운(로드된 데이터 기반, 추가 조회 없음) */}
            <div className="relative">
              <button
                onClick={() => setNotifOpen(o => !o)}
                title="혼잡 이상 알림"
                aria-label="혼잡 이상 알림"
                className="relative text-hanok-muted hover:text-hanok-ink transition-colors"
              >
                <Bell size={24} />
                {anomalies.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-terracotta text-white text-[11px] font-bold flex items-center justify-center">
                    {anomalies.length}
                  </span>
                )}
                {/* 배지가 아예 없으면 '이상 없음' 으로 읽힌다 — 판정 불가는 다른 표시가 필요하다. */}
                {anomalies.length === 0 && anomalyJudgementBlocked && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[11px] font-bold flex items-center justify-center">
                    !
                  </span>
                )}
              </button>
              {notifOpen && (
                <>
                  {/* 바깥 클릭 시 닫기 */}
                  <button
                    className="fixed inset-0 z-30 cursor-default"
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={() => setNotifOpen(false)}
                  />
                  <div className="absolute right-0 mt-3 w-80 max-h-96 overflow-y-auto z-40 bg-hanok-panel border border-hanok-line rounded-xl shadow-xl">
                    <div className="px-4 py-3 border-b border-hanok-line flex items-center justify-between sticky top-0 bg-hanok-panel">
                      <span className="font-bold text-hanok-ink text-sm flex items-center gap-2">
                        <AlertTriangle size={16} className="text-terracotta" />
                        혼잡 이상 알림
                      </span>
                      <span className="text-xs text-hanok-muted">{anomalies.length}건</span>
                    </div>
                    {anomalyJudgementBlocked && (
                      <div className="px-4 py-3 border-b border-hanok-line bg-amber-500/10 text-xs text-amber-300">
                        {error
                          ? '시설 목록을 불러오지 못해 이상 여부를 판정할 수 없습니다.'
                          : '최신 혼잡도를 불러오지 못해 이상 여부를 판정할 수 없습니다.'}
                        {' '}아래 목록은 판정 가능한 시설만 보여줍니다.
                      </div>
                    )}
                    {anomalies.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-hanok-muted">
                        {anomalyJudgementBlocked ? '판정할 수 있는 시설이 없습니다.' : '현재 이상 혼잡 시설이 없습니다.'}
                      </div>
                    ) : (
                      <ul className="py-1">
                        {anomalies.map(({ infra, level }) => (
                          <li key={infra.id}>
                            <button
                              onClick={() => openAnomaly(infra)}
                              className="w-full text-left px-4 py-3 hover:bg-hanok-card transition-colors flex items-center justify-between gap-3"
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <span className="p-1.5 rounded-lg bg-hanok-card text-hanok-muted flex-shrink-0">
                                  {getTypeIcon(infra.type)}
                                </span>
                                <span className="min-w-0">
                                  <span className="block font-semibold text-hanok-ink text-sm truncate">{infra.name}</span>
                                  <span className="block text-xs text-hanok-muted">{infra.type} · 수용 {infra.capacity}</span>
                                </span>
                              </span>
                              <span className="text-sm font-bold text-terracotta flex-shrink-0">
                                {Math.round(level * 100)}%
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* 적재 요청 대기(실시간 키워드 게이트웨이 승인 큐) — 접이식 섹션 */}
        <div className="flex-shrink-0 border-b border-hanok-line bg-hanok-panel">
          <button
            onClick={() => setIngestRequestsOpen(o => !o)}
            className="w-full px-8 py-3 flex items-center justify-between text-left hover:bg-hanok-card transition-colors"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-hanok-ink">
              <Inbox size={16} className="text-gold" />
              적재 요청 대기 {ingestRequests.length}
            </span>
            {ingestRequestsOpen ? (
              <ChevronUp size={16} className="text-hanok-muted" />
            ) : (
              <ChevronDown size={16} className="text-hanok-muted" />
            )}
          </button>
          {ingestRequestsOpen && (
            <div className="px-8 pb-4">
              {ingestRequestsLoading ? (
                <p className="text-xs text-hanok-muted py-2">불러오는 중...</p>
              ) : ingestRequests.length === 0 ? (
                <p className="text-xs text-hanok-muted py-2">대기 중인 적재 요청이 없습니다.</p>
              ) : (
                <ul className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                  {ingestRequests.map(req => (
                    <li
                      key={req.id}
                      className="flex items-center justify-between gap-3 bg-hanok-card border border-hanok-line rounded-xl px-4 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-hanok-ink truncate">{req.name || '(이름 없음)'}</p>
                        <p className="text-xs text-hanok-muted">
                          contentid {req.contentid} · {new Date(req.created_at).toLocaleString('ko-KR')}
                        </p>
                      </div>
                      <button
                        onClick={() => approveIngestRequest(req)}
                        disabled={approvingIngestId === req.id}
                        className="shrink-0 text-xs font-semibold bg-gold hover:bg-gold-deep text-white rounded-full px-3 py-1.5 transition-colors disabled:opacity-50"
                      >
                        {approvingIngestId === req.id ? '승인 중...' : '승인'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Layout: Master-Detail */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Master List */}
          <div className="w-1/3 bg-hanok-panel border-r border-hanok-line flex flex-col h-full">
            <div className="p-4 border-b border-hanok-line">
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
                        ? 'bg-gold text-white'
                        : 'bg-hanok-card text-hanok-muted hover:bg-hanok-line'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>
            {/* 목록은 왔지만 혼잡도만 못 가져온 경우 — 모든 시설이 '관측 대기' 로 보이는 이유를 밝힌다. */}
            {!loading && !error && congestionError && (
              <div className="mx-4 mt-4 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
                최신 혼잡도를 불러오지 못했습니다 — 아래 혼잡 상태는 &lsquo;없음&rsquo;이 아니라 &lsquo;모름&rsquo;입니다. ({congestionError})
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {loading ? (
                <div className="flex flex-col items-center justify-center h-48 text-hanok-muted">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold mb-4" />
                  <p>데이터를 불러오는 중...</p>
                </div>
              ) : error ? (
                <div className="p-4 text-center text-red-400 bg-red-500/10 rounded-xl border border-red-500/30">
                  <AlertTriangle className="mx-auto mb-2" size={24} />
                  <p className="text-sm font-semibold">{error}</p>
                  <p className="text-xs text-hanok-muted mt-2">목록이 비어 있는 것은 등록된 장소가 없다는 뜻이 아닙니다.</p>
                </div>
              ) : filteredInfras.length === 0 ? (
                <div className="text-center p-8 text-hanok-muted">
                  {searchQuery.trim()
                    ? `'${searchQuery.trim()}' 검색 결과가 없습니다.`
                    : `등록된 ${activeFilter}이(가) 없습니다.`}
                </div>
              ) : (
                paginatedInfras.map(infra => (
                  <div
                    key={infra.id}
                    onClick={() => setSelectedInfra(infra)}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${
                      selectedInfra?.id === infra.id
                        ? 'border-gold bg-gold/10 shadow-sm'
                        : 'border-hanok-line bg-hanok-panel hover:border-hanok-line'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <span className="p-1.5 rounded-lg bg-hanok-card text-hanok-muted">
                          {getTypeIcon(infra.type)}
                        </span>
                        <h3 className="font-bold text-hanok-ink">{infra.name}</h3>
                      </div>
                      <div
                        title={facilityStatusLabel(infra.congestion)}
                        className={`w-3 h-3 rounded-full ${getStatusColor(infra.congestion)} mt-1`}
                      />
                    </div>
                    <div className="text-sm text-hanok-muted flex justify-between mt-3">
                      <span>수용 현황: {infra.capacity}</span>
                      {/* 혼잡 등급이 없는 시설은 '한산' 이 아니라 그 사실을 글자로 적는다. */}
                      {infra.congestion.kind !== 'observed' && (
                        <span className={infra.congestion.kind === 'unavailable' ? 'text-amber-400' : ''}>
                          {facilityStatusLabel(infra.congestion)}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex flex-col gap-2 p-4 border-t border-hanok-line bg-hanok-panel flex-shrink-0">
                <div className="text-xs text-hanok-muted font-medium text-center">
                  총 {totalItems}개 중 {startIndex + 1}-{Math.min(startIndex + itemsPerPage, totalItems)}개 표시
                </div>
                <div className="flex items-center justify-center gap-2">
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

          {/* Detail Panel */}
          <div className="flex-1 bg-hanok p-8 overflow-y-auto">
            {loading && !selectedInfra ? (
              <div className="flex flex-col items-center justify-center h-full text-hanok-muted">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold mb-4" />
                <p>상세 정보를 불러오는 중...</p>
              </div>
            ) : selectedInfra ? (
              <div className="max-w-3xl mx-auto flex flex-col gap-6 animate-fade-in">

                {/* Detail Header */}
                <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-gold/15 text-gold">
                        {selectedInfra.type}
                      </span>
                      <span className="text-sm font-medium text-hanok-muted">ID: INF-{selectedInfra.id.substring(0, 8)}</span>
                    </div>
                    <h2 className="text-3xl font-black text-hanok-ink">{selectedInfra.name}</h2>
                  </div>
                  <div className="flex flex-col items-end">
                    <div className="text-sm font-semibold text-hanok-muted mb-1">현재 상태</div>
                    <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-hanok-card border border-hanok-line">
                      <div className={`w-3 h-3 rounded-full ${getStatusColor(selectedInfra.congestion)}`} />
                      {/* 관측이 없거나 조회에 실패했을 때 '한산' 으로 단정하던 자리 — 사실대로 적는다. */}
                      <span className={`text-sm font-bold ${selectedInfra.congestion.kind === 'observed' ? 'text-hanok-ink' : 'text-hanok-muted'}`}>
                        {facilityStatusLabel(selectedInfra.congestion)}
                      </span>
                    </div>
                    {selectedInfra.congestion.kind === 'observed' && (
                      <div className="text-xs text-hanok-muted mt-1 tabular-nums">
                        최신 혼잡도 {Math.round(selectedInfra.congestion.level * 100)}%
                      </div>
                    )}
                  </div>
                </div>

                {/* KPI Overview */}
                <div className="grid grid-cols-2 gap-6">
                  <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm">
                    <div className="flex items-center gap-2 text-hanok-muted mb-2">
                      <Users size={18} />
                      <span className="font-semibold text-sm">실시간 수용량</span>
                    </div>
                    <div className="text-2xl font-bold text-hanok-ink">{selectedInfra.capacity}</div>
                  </div>
                  <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm border-l-4 border-l-gold">
                    <div className="flex items-center gap-2 text-hanok-muted mb-2">
                      <Activity size={18} />
                      <span className="font-semibold text-sm">수요 수준 (최신 관측 기준)</span>
                    </div>
                    {/* 이 값은 최신 congestion_logs 한 건을 등급으로 환산한 것이다.
                        예전 라벨('온보딩 데이터 기반' / '선호 메뉴·동선 분석 결과')은 코드가 하는 일과
                        달랐다 — 온보딩 선호 데이터는 이 계산에 한 줄도 들어가지 않는다. */}
                    <div className={`text-lg font-bold ${selectedInfra.congestion.kind === 'observed' ? 'text-gold' : 'text-hanok-muted'}`}>
                      {facilityStatusLabel(selectedInfra.congestion)}
                    </div>
                    <p className="text-xs text-hanok-muted mt-1">최신 혼잡 관측 1건을 등급으로 환산한 값입니다.</p>
                  </div>
                </div>

                {/* Time Series Chart */}
                <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col h-[300px]">
                  <h3 className="text-lg font-bold text-hanok-ink mb-4 flex items-center gap-2">
                    <Clock size={20} className="text-hanok-muted" />
                    시간대별 혼잡도 추이 (금일)
                  </h3>
                  <div className="flex-1 w-full">
                    {chartError ? (
                      <div className="flex flex-col items-center justify-center h-full gap-1 text-center px-4">
                        <AlertTriangle className="text-amber-400" size={20} />
                        <p className="text-sm font-semibold text-amber-300">추이를 불러오지 못했습니다</p>
                        <p className="text-xs text-hanok-muted">{chartError}</p>
                      </div>
                    ) : chartData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-hanok-muted">
                        오늘 기록된 혼잡도 데이터가 없습니다.
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3a2f24" />
                          <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{fill: '#b8a894', fontSize: 12}} />
                          <YAxis axisLine={false} tickLine={false} tick={{fill: '#b8a894', fontSize: 12}} />
                          <Tooltip contentStyle={{ borderRadius: '8px', backgroundColor: '#2c241c', border: '1px solid #3a2f24', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                          <Line type="monotone" dataKey="demand" stroke="#0ea5e9" strokeWidth={3} dot={{r: 4, strokeWidth: 2}} activeDot={{r: 6}} fill="url(#colorDemand)" />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                {/* Admin Actions */}
                <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col gap-4">
                  <h3 className="text-lg font-bold text-hanok-ink flex items-center gap-2">
                    <AlertTriangle size={20} className="text-amber-500" />
                    관리자 액션
                  </h3>
                  <div className="flex gap-4">
                    <button
                      onClick={handleOverride}
                      className="flex-1 bg-hanok-card border border-hanok-line hover:bg-hanok-line text-hanok-ink font-semibold py-3 rounded-xl transition-colors"
                    >
                      수동 상태 변경 (Override)
                    </button>
                    <button
                      onClick={handleDispatch}
                      className="flex-1 bg-gold hover:bg-gold-deep text-white font-semibold py-3 rounded-xl transition-colors shadow-sm shadow-gold/30"
                    >
                      근처 유저에게 분산 안내 발송
                    </button>
                  </div>
                </div>

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-hanok-muted">
                <Building2 size={48} className="mb-4 opacity-50" />
                <p>좌측 목록에서 인프라를 선택하여 상세 정보를 확인하세요.</p>
              </div>
            )}
          </div>
        </div>

        {/* 수동 혼잡도 설정(Override) 모달 */}
        {overrideOpen && selectedInfra && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <button
              className="absolute inset-0 bg-black/60"
              aria-label="닫기"
              onClick={() => { if (!overrideSubmitting) setOverrideOpen(false); }}
            />
            <div className="relative z-10 w-full max-w-md bg-hanok-panel border border-hanok-line rounded-2xl shadow-2xl p-6 flex flex-col gap-5 animate-fade-in">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-hanok-ink flex items-center gap-2">
                    <SlidersHorizontal size={18} className="text-gold" />
                    수동 혼잡 상태 변경
                  </h3>
                  <p className="text-sm text-hanok-muted mt-1">
                    &lsquo;{selectedInfra.name}&rsquo;의 현재 혼잡도를 직접 설정합니다.
                  </p>
                </div>
                <button
                  onClick={() => { if (!overrideSubmitting) setOverrideOpen(false); }}
                  className="text-hanok-muted hover:text-hanok-ink"
                  aria-label="닫기"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-end justify-between">
                  <span className="text-sm font-semibold text-hanok-muted">설정 혼잡도</span>
                  <span className="text-3xl font-black text-gold tabular-nums">{overrideLevel}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={overrideLevel}
                  onChange={(e) => setOverrideLevel(Number(e.target.value))}
                  className="w-full accent-gold"
                />
                <div className="flex gap-2">
                  {[
                    { label: '한산', v: 20 },
                    { label: '보통', v: 55 },
                    { label: '혼잡', v: 80 },
                    { label: '포화', v: 95 },
                  ].map(preset => (
                    <button
                      key={preset.label}
                      onClick={() => setOverrideLevel(preset.v)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        overrideLevel === preset.v
                          ? 'bg-gold text-white border-gold'
                          : 'bg-hanok-card text-hanok-muted border-hanok-line hover:border-gold'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => setOverrideOpen(false)}
                  disabled={overrideSubmitting}
                  className="flex-1 bg-hanok-card border border-hanok-line hover:bg-hanok-line text-hanok-ink font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  onClick={submitOverride}
                  disabled={overrideSubmitting}
                  className="flex-1 bg-gold hover:bg-gold-deep text-white font-semibold py-2.5 rounded-xl transition-colors shadow-sm shadow-gold/30 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {overrideSubmitting ? (
                    <>
                      <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      적용 중...
                    </>
                  ) : '적용'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
