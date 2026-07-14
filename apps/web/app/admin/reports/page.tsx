'use client';

import { useState, useEffect } from 'react';
import {
  Search, Bell, Download, FileText, Calendar as CalendarIcon,
  TrendingUp, BarChart2, PieChart as PieChartIcon, Database
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { createPublicClient } from '@/lib/supabase';
import { adminApi } from '@/lib/admin-api';

const supabase = createPublicClient();

// --- Types ---
type CategoryKo = '음식점' | '카페' | '관광지' | '문화시설';

/** 막대 차트 1행: 요일 + 카테고리별 누적 방문량 */
type WeeklyRow = { day: string } & Record<CategoryKo, number>;

/** AI 수락 트렌드 1행(주차 버킷) */
interface AiTrendRow {
  date: string;
  수락: number;
  거절: number;
}

/** 카테고리 요약 표 1행 */
interface CategoryTableRow {
  id: number;
  category: string;
  totalUsers: string;
  growth: string;
  status: string;
}

/** congestion_logs select('current_count, timestamp, facility:facilities(type)') 행(snake_case).
 *  조인 결과는 Supabase 관계 카디널리티 추정에 따라 객체 또는 배열로 올 수 있다. */
interface CongestionLogRow {
  current_count: number | null;
  timestamp: string;
  facility: { type: string | null } | { type: string | null }[] | null;
}

/** /api/v1/admin/metrics 의 recommendations 행(snake_case, admin-api 는 케이스 변환 없음) */
interface RecommendationRow {
  accepted: boolean | null;
  created_at: string;
}

// --- 빈 초기 상태: 실데이터 로드 전 초기값(목업 아님 — 항상 빈 배열) ---
const EMPTY_WEEKLY: WeeklyRow[] = [];

const EMPTY_AI: AiTrendRow[] = [];

const EMPTY_TABLE: CategoryTableRow[] = [];

const TYPE_KO: Record<string, CategoryKo> = {
  restaurant: '음식점', cafe: '카페', attraction: '관광지', culture: '문화시설',
};
const TYPE_UNIT: Record<string, string> = { 음식점: '명', 카페: '명', 관광지: '명', 문화시설: '명' };
const WEEK_ORDER = ['월', '화', '수', '목', '금', '토', '일'];
const WD_KO = ['일', '월', '화', '수', '목', '금', '토']; // getUTCDay() 인덱스

function kstWeekdayKo(ts: string) {
  const d = new Date(new Date(ts).getTime() + 9 * 60 * 60 * 1000);
  return WD_KO[d.getUTCDay()];
}
function joinedType(log: CongestionLogRow): string | null {
  const f = log?.facility;
  const o = Array.isArray(f) ? f[0] : f;
  return o?.type ?? null;
}
function statusFromGrowth(g: number) {
  if (g >= 20) return '급증';
  if (g >= 5) return '활발';
  if (g >= -5) return '보통';
  return '둔화';
}
function fmtMD(d: Date) {
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`;
}

// 최근 14일 혼잡 로그(시설 유형 조인). 최소 컬럼 + 페이지 캡으로 로딩 비용 최소화.
async function fetchLogs14d(): Promise<CongestionLogRow[]> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  let out: CongestionLogRow[] = [];
  let from = 0;
  const limit = 1000;
  const maxPages = 8;
  for (let p = 0; p < maxPages; p++) {
    const { data, error } = await supabase
      .from('congestion_logs')
      .select('current_count, timestamp, facility:facilities(type)')
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .range(from, from + limit - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out = out.concat(data);
    if (data.length < limit) break;
    from += limit;
  }
  return out;
}
async function fetchRecs28d(): Promise<RecommendationRow[]> {
  // 추천 이력은 RLS 강화(20260707 security_hardening)로 anon 열람 불가 →
  // 관리자 API(/admin/metrics, service_role) 경유(WS-A-6).
  // 실패해도 로그 기반(막대/표) 실데이터는 살리도록 여기서 격리(빈 배열 반환).
  try {
    const metrics = await adminApi.get('/api/v1/admin/metrics?days=28');
    return metrics?.recommendations || [];
  } catch {
    return [];
  }
}

export default function ReportsPage() {
  const [weekly, setWeekly] = useState(EMPTY_WEEKLY);
  const [aiTrend, setAiTrend] = useState(EMPTY_AI);
  const [table, setTable] = useState<CategoryTableRow[]>(EMPTY_TABLE);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true); // 최초 로드 중 여부(빈 상태 안내를 '불러오는 중' vs '데이터 없음'으로 구분)
  const [rangeLabel, setRangeLabel] = useState('최근 7일');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [logs, recs] = await Promise.all([fetchLogs14d(), fetchRecs28d()]);
        if (!active) return;

        const now = Date.now();
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const twoWeekAgo = now - 14 * 24 * 60 * 60 * 1000;
        setRangeLabel(`${fmtMD(new Date(weekAgo))} ~ ${fmtMD(new Date(now))} · 최근 7일`);

        let gotReal = false;

        // (1) 주간 사용량 + (2) 카테고리 요약 (current_count 합 = 누적 footfall)
        if (logs.length > 0) {
          const wk: Record<string, WeeklyRow> = {};
          for (const d of WEEK_ORDER) wk[d] = { day: d, 음식점: 0, 카페: 0, 관광지: 0, 문화시설: 0 };
          const thisWeek: Record<string, number> = { 음식점: 0, 카페: 0, 관광지: 0, 문화시설: 0 };
          const lastWeek: Record<string, number> = { 음식점: 0, 카페: 0, 관광지: 0, 문화시설: 0 };

          for (const l of logs) {
            const t = joinedType(l);
            if (!t) continue;
            const ko = TYPE_KO[t];
            if (!ko || !(ko in thisWeek)) continue;
            const tsMs = new Date(l.timestamp).getTime();
            const cnt = l.current_count || 0;
            if (tsMs >= weekAgo) {
              const wd = kstWeekdayKo(l.timestamp);
              if (wk[wd]) wk[wd][ko] += cnt;
              thisWeek[ko] += cnt;
            } else if (tsMs >= twoWeekAgo) {
              lastWeek[ko] += cnt;
            }
          }

          if (Object.values(thisWeek).some((v) => v > 0)) {
            setWeekly(WEEK_ORDER.map((d) => wk[d]));
            const types = ['음식점', '카페', '관광지', '문화시설'];
            setTable(
              types.map((ko, i) => {
                const cur = thisWeek[ko];
                const prev = lastWeek[ko];
                const g = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0;
                return {
                  id: i + 1,
                  category: ko,
                  totalUsers: `${cur.toLocaleString()}${TYPE_UNIT[ko]}`,
                  growth: `${g >= 0 ? '+' : ''}${g}%`,
                  status: statusFromGrowth(g),
                };
              })
            );
            gotReal = true;
          }
        }

        // (3) AI 수락 트렌드 (4주 버킷) — 추천 데이터가 충분할 때만 실측 반영
        if (recs.length >= 8) {
          const buckets = [0, 1, 2, 3].map(() => ({ acc: 0, tot: 0 }));
          for (const r of recs) {
            const age = now - new Date(r.created_at).getTime();
            const wIdx = 3 - Math.min(3, Math.floor(age / (7 * 24 * 60 * 60 * 1000)));
            if (wIdx < 0) continue;
            buckets[wIdx].tot += 1;
            if (r.accepted) buckets[wIdx].acc += 1;
          }
          if (buckets.every((b) => b.tot > 0)) {
            setAiTrend(
              buckets.map((b, i) => {
                const acc = Math.round((b.acc / b.tot) * 100);
                return { date: `${i + 1}주차`, 수락: acc, 거절: 100 - acc };
              })
            );
            gotReal = true;
          }
        }

        if (gotReal) setIsLive(true);
      } catch (e) {
        console.warn('리포트 실데이터 로드 실패, 목업 유지:', e);
      } finally {
        // 로딩 종료 표시: 이후 빈 상태는 '데이터 없음'으로 안내
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Excel(=CSV) 내보내기: 현재 표시 중인 데이터로 클라이언트에서 생성(엑셀 한글 BOM).
  const handleExcel = () => {
    try {
      const lines: string[] = [];
      lines.push('카테고리,총 이용량,전주 대비,상태');
      for (const r of table) {
        lines.push(`${r.category},${String(r.totalUsers).replace(/,/g, '')},${r.growth},${r.status}`);
      }
      lines.push('');
      lines.push('요일,음식점,카페,관광지,문화시설');
      for (const w of weekly) {
        lines.push(`${w.day},${w.음식점},${w.카페},${w.관광지},${w.문화시설}`);
      }
      const csv = '﻿' + lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nextspot-report-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('CSV 내보내기 실패:', e);
      alert('내보내기에 실패했습니다.');
    }
  };

  // 브라우저 인쇄 → '대상: PDF로 저장' 으로 PDF 추출(별도 서버 불필요).
  const handlePdf = () => {
    if (typeof window !== 'undefined') window.print();
  };

  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full min-h-0 overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-hanok-ink">통계 리포트</h2>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-hanok-muted" size={18} />
              <input
                type="text"
                placeholder="Search..."
                className="pl-10 pr-4 py-2 bg-hanok-card text-hanok-ink placeholder-hanok-muted rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold w-64"
              />
            </div>
            <button className="relative text-hanok-muted hover:text-hanok-ink">
              <Bell size={24} />
            </button>
          </div>
        </header>

        {/* Dashboard Content */}
        <div className="flex-1 min-h-0 p-8 overflow-y-auto pb-20 space-y-8">

          {/* Controllers & Actions */}
          <div className="flex justify-between items-center bg-hanok-panel p-4 rounded-2xl border border-hanok-line shadow-sm flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-4 py-2 bg-hanok-card rounded-lg border border-hanok-line">
                <CalendarIcon size={18} className="text-hanok-muted" />
                <span className="text-sm font-semibold text-hanok-ink">{rangeLabel}</span>
              </div>
              {/* 데이터 출처 배지: 실DB 반영 여부 표시 */}
              <span
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border ${
                  isLive
                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    : 'bg-hanok-card text-hanok-muted border-hanok-line'
                }`}
              >
                <Database size={13} />
                {isLive ? 'DB 실시간 반영' : loading ? '불러오는 중' : '데이터 없음'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleExcel}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold rounded-lg transition-colors text-sm"
              >
                <FileText size={16} /> Excel 내보내기
              </button>
              <button
                onClick={handlePdf}
                className="flex items-center gap-2 px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 font-semibold rounded-lg transition-colors text-sm"
              >
                <Download size={16} /> PDF 다운로드
              </button>
            </div>
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-2 gap-6 min-h-[350px] flex-shrink-0">
            {/* Bar Chart */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-6">
                <BarChart2 className="text-gold" size={20} />
                <h3 className="text-lg font-bold text-hanok-ink">요일별 관광 장소 누적 방문량</h3>
              </div>
              <div className="flex-1 w-full h-[250px]">
                {weekly.length === 0 ? (
                  // 빈 상태 안내: 실측 방문량 데이터 없음
                  <div className="flex items-center justify-center h-full text-hanok-muted text-sm">
                    {loading ? '데이터를 불러오는 중...' : '표시할 방문량 데이터가 아직 없습니다.'}
                  </div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weekly} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3a2f24" />
                    <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{fill: '#b8a894', fontSize: 12}} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#b8a894', fontSize: 12}} />
                    <Tooltip cursor={{fill: '#3a2f24'}} contentStyle={{ borderRadius: '8px', backgroundColor: '#2c241c', border: '1px solid #3a2f24', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                    <Bar dataKey="음식점" stackId="a" fill="#3b82f6" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="카페" stackId="a" fill="#10b981" />
                    <Bar dataKey="관광지" stackId="a" fill="#8b5cf6" />
                    <Bar dataKey="문화시설" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Area Chart */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-6">
                <TrendingUp className="text-jade" size={20} />
                <h3 className="text-lg font-bold text-hanok-ink">AI 추천 알고리즘 수락 트렌드</h3>
              </div>
              <div className="flex-1 w-full h-[250px]">
                {aiTrend.length === 0 ? (
                  // 빈 상태 안내: AI 추천 수락 트렌드 데이터 없음(추천 이력 부족 또는 관리자 API 미응답)
                  <div className="flex items-center justify-center h-full text-hanok-muted text-sm">
                    {loading ? '데이터를 불러오는 중...' : 'AI 추천 수락 데이터가 아직 없습니다.'}
                  </div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={aiTrend} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}>
                    <defs>
                      <linearGradient id="colorAccept" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8}/>
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorReject" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#cbd5e1" stopOpacity={0.8}/>
                        <stop offset="95%" stopColor="#cbd5e1" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3a2f24" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: '#b8a894', fontSize: 12}} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#b8a894', fontSize: 12}} />
                    <Tooltip contentStyle={{ borderRadius: '8px', backgroundColor: '#2c241c', border: '1px solid #3a2f24', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                    <Area type="monotone" dataKey="수락" stroke="#8b5cf6" fillOpacity={1} fill="url(#colorAccept)" />
                    <Area type="monotone" dataKey="거절" stroke="#b8a894" fillOpacity={1} fill="url(#colorReject)" />
                  </AreaChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* Data Table */}
          <div className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden flex-shrink-0">
            <div className="p-6 border-b border-hanok-line flex items-center gap-2">
              <PieChartIcon className="text-hanok-muted" size={20} />
              <h3 className="text-lg font-bold text-hanok-ink">카테고리별 누적 요약 데이터</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-hanok text-hanok-muted text-sm border-b border-hanok-line">
                    <th className="p-4 font-semibold">카테고리</th>
                    <th className="p-4 font-semibold">총 이용량 (최근 7일)</th>
                    <th className="p-4 font-semibold">전주 대비 증감률</th>
                    <th className="p-4 font-semibold">상태</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {table.length === 0 ? (
                    // 빈 상태 행: 요약 데이터 없음
                    <tr>
                      <td colSpan={4} className="p-8 text-center text-hanok-muted">
                        {loading ? '데이터를 불러오는 중...' : '표시할 요약 데이터가 아직 없습니다.'}
                      </td>
                    </tr>
                  ) : (
                    table.map((row) => (
                    <tr key={row.id} className="border-b border-hanok-line hover:bg-hanok-card transition-colors">
                      <td className="p-4 font-bold text-hanok-ink">{row.category}</td>
                      <td className="p-4 text-hanok-muted">{row.totalUsers}</td>
                      <td className="p-4">
                        <span className={`font-bold ${row.growth.startsWith('-') ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {row.growth}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded-md text-xs font-bold ${
                          row.status === '급증' ? 'bg-rose-500/15 text-rose-300' :
                          row.status === '활발' ? 'bg-gold/15 text-gold' :
                          row.status === '보통' ? 'bg-amber-500/15 text-amber-300' :
                          'bg-hanok-card text-hanok-ink'
                        }`}>
                          {row.status}
                        </span>
                      </td>
                    </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
