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

const supabase = createPublicClient();

// --- Fallback(목업): 실데이터 로드 전 즉시 렌더 + 데이터 없을 때 대체 ---
const MOCK_WEEKLY: any[] = [];

const MOCK_AI: any[] = [];

const MOCK_TABLE: any[] = [];

const TYPE_KO: Record<string, string> = {
  restaurant: '음식점', cafe: '카페', attraction: '관광지', culture: '문화시설',
};
const TYPE_UNIT: Record<string, string> = { 음식점: '명', 카페: '명', 관광지: '명', 문화시설: '명' };
const WEEK_ORDER = ['월', '화', '수', '목', '금', '토', '일'];
const WD_KO = ['일', '월', '화', '수', '목', '금', '토']; // getUTCDay() 인덱스

function kstWeekdayKo(ts: string) {
  const d = new Date(new Date(ts).getTime() + 9 * 60 * 60 * 1000);
  return WD_KO[d.getUTCDay()];
}
function joinedType(log: any): string | null {
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
async function fetchLogs14d() {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  let out: any[] = [];
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
async function fetchRecs28d() {
  // 추천 이력은 RLS 로 같은 회사 admin 에게만 열려 있어 비거나 막힐 수 있다 →
  // 실패해도 로그 기반(막대/표) 실데이터는 살리도록 여기서 격리(빈 배열 반환).
  try {
    const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('recommendations')
      .select('accepted, created_at')
      .gte('created_at', since)
      .limit(5000);
    return data || [];
  } catch {
    return [];
  }
}

export default function ReportsPage() {
  const [weekly, setWeekly] = useState(MOCK_WEEKLY);
  const [aiTrend, setAiTrend] = useState(MOCK_AI);
  const [table, setTable] = useState<any[]>(MOCK_TABLE);
  const [isLive, setIsLive] = useState(false);
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
          const wk: Record<string, any> = {};
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
      console.error('CSV 내보내기 실패:', e);
      alert('내보내기에 실패했습니다.');
    }
  };

  // 브라우저 인쇄 → '대상: PDF로 저장' 으로 PDF 추출(별도 서버 불필요).
  const handlePdf = () => {
    if (typeof window !== 'undefined') window.print();
  };

  return (
    <div className="flex h-screen bg-[#070b19] text-slate-100 font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full min-h-0 overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-slate-100">통계 리포트</h2>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
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

        {/* Dashboard Content */}
        <div className="flex-1 min-h-0 p-8 overflow-y-auto pb-20 space-y-8">

          {/* Controllers & Actions */}
          <div className="flex justify-between items-center bg-slate-900 p-4 rounded-2xl border border-slate-800 shadow-sm flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 rounded-lg border border-slate-700">
                <CalendarIcon size={18} className="text-slate-400" />
                <span className="text-sm font-semibold text-slate-200">{rangeLabel}</span>
              </div>
              {/* 데이터 출처 배지: 실DB 반영 여부 표시 */}
              <span
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border ${
                  isLive
                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}
              >
                <Database size={13} />
                {isLive ? 'DB 실시간 반영' : '데모 데이터'}
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
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-6">
                <BarChart2 className="text-blue-400" size={20} />
                <h3 className="text-lg font-bold text-slate-100">요일별 관광 장소 누적 방문량</h3>
              </div>
              <div className="flex-1 w-full h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weekly} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                    <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} />
                    <Tooltip cursor={{fill: '#1e293b'}} contentStyle={{ borderRadius: '8px', backgroundColor: '#0f172a', border: '1px solid #1e293b', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                    <Bar dataKey="음식점" stackId="a" fill="#3b82f6" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="카페" stackId="a" fill="#10b981" />
                    <Bar dataKey="관광지" stackId="a" fill="#8b5cf6" />
                    <Bar dataKey="문화시설" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Area Chart */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-6">
                <TrendingUp className="text-purple-400" size={20} />
                <h3 className="text-lg font-bold text-slate-100">AI 추천 알고리즘 수락 트렌드</h3>
              </div>
              <div className="flex-1 w-full h-[250px]">
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
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} />
                    <Tooltip contentStyle={{ borderRadius: '8px', backgroundColor: '#0f172a', border: '1px solid #1e293b', color: '#e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                    <Area type="monotone" dataKey="수락" stroke="#8b5cf6" fillOpacity={1} fill="url(#colorAccept)" />
                    <Area type="monotone" dataKey="거절" stroke="#94a3b8" fillOpacity={1} fill="url(#colorReject)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-sm overflow-hidden flex-shrink-0">
            <div className="p-6 border-b border-slate-800 flex items-center gap-2">
              <PieChartIcon className="text-slate-400" size={20} />
              <h3 className="text-lg font-bold text-slate-100">카테고리별 누적 요약 데이터</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-950 text-slate-400 text-sm border-b border-slate-800">
                    <th className="p-4 font-semibold">카테고리</th>
                    <th className="p-4 font-semibold">총 이용량 (최근 7일)</th>
                    <th className="p-4 font-semibold">전주 대비 증감률</th>
                    <th className="p-4 font-semibold">상태</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {table.map((row) => (
                    <tr key={row.id} className="border-b border-slate-800 hover:bg-slate-800 transition-colors">
                      <td className="p-4 font-bold text-slate-200">{row.category}</td>
                      <td className="p-4 text-slate-300">{row.totalUsers}</td>
                      <td className="p-4">
                        <span className={`font-bold ${row.growth.startsWith('-') ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {row.growth}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded-md text-xs font-bold ${
                          row.status === '급증' ? 'bg-rose-500/15 text-rose-300' :
                          row.status === '활발' ? 'bg-blue-500/15 text-blue-300' :
                          row.status === '보통' ? 'bg-amber-500/15 text-amber-300' :
                          'bg-slate-800 text-slate-200'
                        }`}>
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
