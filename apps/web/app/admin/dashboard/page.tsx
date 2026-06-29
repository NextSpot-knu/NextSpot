'use client';

import { useState, useEffect } from 'react';
import { 
  Users, Activity, TrendingUp, AlertTriangle, Search, Bell, Download
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { DashboardCharts, DashboardHeatmap } from '@/components/admin/DashboardCharts';
import { FacilityTable } from '@/components/admin/FacilityTable';
import { SimulatePeakButton } from '@/components/admin/SimulatePeakButton';

import { createPublicClient } from '@/lib/supabase';

const supabase = createPublicClient();

// KST 시간대 보정 헬퍼. Date.now()는 이미 UTC epoch 이므로 +9h 후 getUTCHours()만 하면 KST 벽시계 시(時)다.
// (기존엔 getTimezoneOffset 까지 더해 KST 브라우저에서 KST 가 아닌 UTC 시를 반환하는 이중보정 버그가 있었음.
//  같은 파일 line 263 히트맵 집계가 쓰는 검증된 idiom 과 일치시킴.)
function getKstHours() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}

// 클라이언트 단의 실시간 Fallback 데이터 생성기
function generateClientFallbackData(realFacilities?: any[]) {
  const kstHour = getKstHours();
  const seed = new Date().getDate() * 100 + kstHour;
  
  const pseudoRand = (offset: number) => {
    const x = Math.sin(seed + offset) * 10000;
    return x - Math.floor(x);
  };

  // 시간대별 혼잡도 패턴 (출퇴근·점심 피크 반영)
  let baseCongestion = 0.3;
  if (kstHour >= 8 && kstHour <= 10) baseCongestion = 0.55 + pseudoRand(1) * 0.15; // 출근 피크
  else if (kstHour >= 11 && kstHour <= 13) baseCongestion = 0.65 + pseudoRand(2) * 0.2; // 점심 피크
  else if (kstHour >= 17 && kstHour <= 19) baseCongestion = 0.58 + pseudoRand(3) * 0.18; // 퇴근 피크
  else if (kstHour >= 22 || kstHour < 7) baseCongestion = 0.08 + pseudoRand(4) * 0.08; // 야간
  else baseCongestion = 0.35 + pseudoRand(5) * 0.15;

  const changePercent = Math.round((-8 + pseudoRand(6) * 20) * 10) / 10;
  const acceptRateVal = 0.62 + pseudoRand(7) * 0.23;
  const total = 80 + Math.floor(pseudoRand(8) * 60);
  const accepted = Math.round(total * acceptRateVal);
  const activeUsers = 180 + Math.floor(pseudoRand(9) * 240);
  const isPeak = (kstHour >= 11 && kstHour <= 13) || (kstHour >= 17 && kstHour <= 19);
  const anomalyCount = isPeak ? 2 + Math.floor(pseudoRand(10) * 4) : Math.floor(pseudoRand(10) * 3);

  // 히트맵용 가상 데이터 생성 (실제 DB 시설 엔티티 연동 우선)
  const dummyHeatmap: any[] = [];
  
  if (realFacilities && realFacilities.length > 0) {
    // 1. DB에서 로드된 실제 시설을 기반으로 혼잡도 수치만 Fallback 채우기
    realFacilities.forEach((fac) => {
      const name = fac.name;
      const type = fac.type;
      
      let facSeed = 0;
      for (let i = 0; i < name.length; i++) facSeed += name.charCodeAt(i);
      
      for (let hour = 0; hour < 24; hour++) {
        const noise = ((facSeed * (hour + 1)) % 100) / 100;
        let mockVal = 0.1;
        if (type === 'restaurant') {
          if (hour >= 11 && hour <= 13) mockVal = 0.65 + noise * 0.25;
          else if (hour >= 17 && hour <= 19) mockVal = 0.5 + noise * 0.25;
          else mockVal = 0.1 + noise * 0.15;
        } else if (type === 'cafe') {
          if (hour >= 13 && hour <= 18) mockVal = 0.55 + noise * 0.3;
          else mockVal = 0.1 + noise * 0.2;
        } else if (type === 'attraction') {
          if (hour >= 10 && hour <= 17) mockVal = 0.5 + noise * 0.4;
          else mockVal = 0.05 + noise * 0.1;
        } else { // culture 등
          if (hour >= 10 && hour <= 17) mockVal = 0.35 + noise * 0.4;
          else mockVal = 0.03 + noise * 0.1;
        }
        
        dummyHeatmap.push({
          facility: name,
          facilityType: type,
          hour,
          value: Math.max(0, Math.min(1, Math.round(mockVal * 100) / 100))
        });
      }
    });
  } else {
    // 2. DB 연결 실패 시 최후의 폴백 (하드코딩 더미 장소)
    const facilityTypes = ['restaurant', 'cafe', 'attraction', 'culture'];
    const baseNames: Record<string, string[]> = {
      restaurant: ['황남쌈밥', '교리김밥', '한우국밥', '경주 한정식'],
      cafe: ['감성카페 봄', '한옥카페 다랑', '루프탑카페', '십원빵'],
      attraction: ['대릉원', '첨성대', '동궁과 월지', '월정교'],
      culture: ['국립경주박물관', '교촌마을', '최부자댁']
    };

    facilityTypes.forEach((type) => {
      const names = baseNames[type] || [];
      names.forEach((name) => {
        let facSeed = 0;
        for (let i = 0; i < name.length; i++) facSeed += name.charCodeAt(i);

        for (let hour = 0; hour < 24; hour++) {
          const noise = ((facSeed * (hour + 1)) % 100) / 100;
          let mockVal = 0.1;
          if (type === 'restaurant') {
            if (hour >= 11 && hour <= 13) mockVal = 0.65 + noise * 0.25;
            else if (hour >= 17 && hour <= 19) mockVal = 0.5 + noise * 0.25;
            else mockVal = 0.1 + noise * 0.15;
          } else if (type === 'cafe') {
            if (hour >= 13 && hour <= 18) mockVal = 0.55 + noise * 0.3;
            else mockVal = 0.1 + noise * 0.2;
          } else if (type === 'attraction') {
            if (hour >= 10 && hour <= 17) mockVal = 0.5 + noise * 0.4;
            else mockVal = 0.05 + noise * 0.1;
          } else {
            if (hour >= 10 && hour <= 17) mockVal = 0.35 + noise * 0.4;
            else mockVal = 0.03 + noise * 0.1;
          }
          
          dummyHeatmap.push({
            facility: name,
            facilityType: type,
            hour,
            value: Math.max(0, Math.min(1, Math.round(mockVal * 100) / 100))
          });
        }
      });
    });
  }

  // 최근 30일 추이 가상 데이터 생성
  const dummyDistribution: any[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    
    const beforeCong = isWeekend 
      ? 0.08 + Math.sin(i * 0.5) * 0.02 + pseudoRand(i) * 0.03
      : 0.45 + Math.sin(i * 0.5) * 0.1 + pseudoRand(i) * 0.08;
    const afterCong = beforeCong * (1 - (0.65 + pseudoRand(i) * 0.15) * 0.48);
    const altUsage = isWeekend
      ? 0.03 + pseudoRand(i) * 0.03
      : 0.2 + Math.cos(i * 0.5) * 0.06 + pseudoRand(i) * 0.06;

    dummyDistribution.push({
      date: dateStr,
      beforeCongestion: Math.round(beforeCong * 100) / 100,
      afterCongestion: Math.round(afterCong * 100) / 100,
      alternativeUsage: Math.round(altUsage * 100) / 100
    });
  }

  // 이상 알림 내역
  const dummyAnomalies = [
    { id: "a1", facilityName: "대릉원", timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(), congestionLevel: 0.92, durationMinutes: 45 },
    { id: "a2", facilityName: "황남쌈밥", timestamp: new Date(Date.now() - 120 * 60 * 1000).toISOString(), congestionLevel: 0.95, durationMinutes: 60 }
  ];

  return {
    kpi: {
      avgCongestion: { value: Math.round(baseCongestion * 100) / 100, changePercent },
      acceptRate: { value: Math.round(acceptRateVal * 1000) / 1000, total, accepted },
      activeUsers,
      anomalyCount
    },
    heatmap: dummyHeatmap,
    distribution: dummyDistribution,
    anomalies: dummyAnomalies
  };
}

// KST '오늘' 00:00~23:59:59 구간을 UTC ISO 문자열로 반환.
// congestion_logs.timestamp 는 UTC 로 적재되므로, 브라우저 로컬 TZ 와 무관하게 KST(UTC+9) 고정 환산한다.
function getKstTodayRangeUtc() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000); // KST 벽시계
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0) - 9 * 60 * 60 * 1000;
  const endUtcMs = Date.UTC(y, m, d, 23, 59, 59, 999) - 9 * 60 * 60 * 1000;
  return { start: new Date(startUtcMs).toISOString(), end: new Date(endUtcMs).toISOString() };
}

// 조인된 facility 가 배열/객체 어느 형태로 와도 안전하게 name/type 추출
function joinedFacility(log: any): { name: string | null; type: string | null } {
  const f = log?.facility;
  if (!f) return { name: null, type: null };
  const o = Array.isArray(f) ? f[0] : f;
  return { name: o?.name ?? null, type: o?.type ?? null };
}

// 정적 export 환경에서는 서버 라우트가 없으므로, 관리자 대시보드의 실데이터는
// 로그인된 admin 세션을 실은 publicClient 로 브라우저에서 직접 조회한다.
//  - congestion_logs/facilities: RLS 가 authenticated 에 USING(true) → 실데이터.
//  - recommendations/user_feedback: 같은 회사 admin 에게만 열려 있어, 데모 계정 권한 밖이면 빈 배열 → null 반환.
// 반환값의 null 지표는 호출부에서 합성 폴백으로 채운다(프로토타입 데모 무중단).
async function fetchRealDashboard(supabaseClient: any) {
  const { start, end } = getKstTodayRangeUtc();

  // 1) 오늘자 혼잡 로그 (페이지네이션, 시설명/유형 조인). maxPages 로 과다 조회 방지.
  let logs: any[] = [];
  const limit = 1000;
  const maxPages = 12;
  let from = 0;
  for (let p = 0; p < maxPages; p++) {
    const { data, error } = await supabaseClient
      .from('congestion_logs')
      .select('congestion_level, current_count, timestamp, facility:facilities(name, type)')
      .gte('timestamp', start)
      .lte('timestamp', end)
      .order('timestamp', { ascending: true })
      .range(from, from + limit - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    logs = logs.concat(data);
    if (data.length < limit) break;
    from += limit;
  }

  const hasLogs = logs.length >= 5;

  // 2) KPI: 평균 혼잡도 + 이상(>=0.9) 건수
  let avgCongestion: { value: number; changePercent: number } | null = null;
  let anomalyCount: number | null = null;
  if (hasLogs) {
    const avg = logs.reduce((a, l) => a + (l.congestion_level || 0), 0) / logs.length;
    avgCongestion = { value: Math.round(avg * 100) / 100, changePercent: 0 };
    anomalyCount = logs.filter((l) => (l.congestion_level || 0) >= 0.9).length;

    // 전일 평균으로 변화율 보정 (있을 때만)
    try {
      const yStart = new Date(new Date(start).getTime() - 24 * 60 * 60 * 1000).toISOString();
      const yEnd = new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString();
      const { data: yLogs } = await supabaseClient
        .from('congestion_logs')
        .select('congestion_level')
        .gte('timestamp', yStart)
        .lte('timestamp', yEnd)
        .limit(5000);
      if (yLogs && yLogs.length > 0) {
        const yAvg = yLogs.reduce((a: number, l: any) => a + (l.congestion_level || 0), 0) / yLogs.length;
        if (yAvg > 0) {
          avgCongestion.changePercent = Math.round(((avgCongestion.value - yAvg) / yAvg) * 1000) / 10;
        }
      }
    } catch { /* 변화율은 보조 지표 — 실패 시 0 유지 */ }
  }

  // 3) 히트맵: 시설명 × KST시간 평균 (로그가 있는 시설만)
  let heatmap: any[] | null = null;
  if (hasLogs) {
    const cell: Record<string, { sum: number; n: number }> = {};
    const typeOf: Record<string, string> = {};
    const names: string[] = [];
    for (const l of logs) {
      const { name, type } = joinedFacility(l);
      if (!name) continue;
      if (!(name in typeOf)) { typeOf[name] = type || 'unknown'; names.push(name); }
      const hour = new Date(new Date(l.timestamp).getTime() + 9 * 60 * 60 * 1000).getUTCHours();
      const key = `${name}__${hour}`;
      if (!cell[key]) cell[key] = { sum: 0, n: 0 };
      cell[key].sum += l.congestion_level || 0;
      cell[key].n += 1;
    }
    const cells: any[] = [];
    for (const name of names) {
      for (let h = 0; h < 24; h++) {
        const c = cell[`${name}__${h}`];
        cells.push({
          facility: name,
          facilityType: typeOf[name],
          hour: h,
          // 로그 없는 시간대는 null(데이터 없음 센티넬). 실측 0.00 과 구분돼 '여유 0%'가 회색으로 묻히지 않는다.
          value: c && c.n ? Math.round((c.sum / c.n) * 100) / 100 : null,
        });
      }
    }
    heatmap = cells;
  }

  // 4) 이상 알림: 오늘 >=0.9 피크 (시설별 최고 1건, 상위 6)
  let anomalies: any[] | null = null;
  if (hasLogs) {
    const peak: Record<string, any> = {};
    for (const l of logs) {
      if ((l.congestion_level || 0) < 0.9) continue;
      const { name } = joinedFacility(l);
      if (!name) continue;
      if (!peak[name] || l.congestion_level > peak[name].congestionLevel) {
        peak[name] = {
          id: `${name}-${l.timestamp}`,
          facilityName: name,
          timestamp: l.timestamp,
          congestionLevel: l.congestion_level,
          durationMinutes: 30,
        };
      }
    }
    anomalies = Object.values(peak)
      .sort((a: any, b: any) => b.congestionLevel - a.congestionLevel)
      .slice(0, 6);
  }

  // 5) 추천 수락률(최근 7일) / DAU(오늘 피드백) — RLS 권한 밖이면 빈 배열 → null
  let acceptRate: { value: number; total: number; accepted: number } | null = null;
  let activeUsers: number | null = null;
  try {
    const weekAgo = new Date(new Date(start).getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recs } = await supabaseClient
      .from('recommendations')
      .select('accepted')
      .gte('created_at', weekAgo)
      .lte('created_at', end)
      .limit(5000);
    if (recs && recs.length > 0) {
      const total = recs.length;
      const accepted = recs.filter((r: any) => r.accepted).length;
      acceptRate = { value: Math.round((accepted / total) * 1000) / 1000, total, accepted };
    }
  } catch { /* 권한/스키마 차이 시 폴백 */ }
  try {
    const { data: fb } = await supabaseClient
      .from('user_feedback')
      .select('user_id')
      .gte('timestamp', start)
      .lte('timestamp', end)
      .limit(5000);
    if (fb && fb.length > 0) activeUsers = new Set(fb.map((f: any) => f.user_id)).size;
  } catch { /* 권한/스키마 차이 시 폴백 */ }

  return { hasLogs, avgCongestion, anomalyCount, heatmap, anomalies, acceptRate, activeUsers };
}

export default function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadData() {
      // 1) 실시간 시설 목록 로드 (publicClient + 로그인된 admin 세션 → RLS 통과).
      let databaseFacilities: any[] = [];
      try {
        let from = 0;
        const limit = 1000;
        while (true) {
          const { data, error } = await supabase
            .from('facilities')
            .select('id, name, type, capacity')
            .order('name', { ascending: true })
            .range(from, from + limit - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          databaseFacilities = [...databaseFacilities, ...data];
          if (data.length < limit) break;
          from += limit;
        }
      } catch (dbErr) {
        console.warn("시설 목록 로드 실패, 합성 폴백 사용:", dbErr);
      }

      // 2) 실시설 기반 합성 폴백 준비 (실데이터가 비는 지표를 채울 안전망).
      const fallback = generateClientFallbackData(databaseFacilities);

      // 3) 실데이터를 직접 조회한 뒤, 지표별로 실데이터 우선·폴백 보완으로 병합.
      try {
        const real = await fetchRealDashboard(supabase);
        const merged = {
          kpi: {
            avgCongestion: real.avgCongestion ?? fallback.kpi.avgCongestion,
            acceptRate: real.acceptRate ?? fallback.kpi.acceptRate,
            activeUsers: real.activeUsers ?? fallback.kpi.activeUsers,
            anomalyCount:
              real.hasLogs && real.anomalyCount != null ? real.anomalyCount : fallback.kpi.anomalyCount,
          },
          // 오늘자 로그가 있으면 실측 히트맵을 사용하되, 실측 데이터가 없는 시간대(예: 14시 이후 미래 시간대)는 fallback 생성기의 가상 데이터로 채웁니다.
          heatmap: (() => {
            if (!real.heatmap || !real.heatmap.length) return fallback.heatmap;
            return real.heatmap.map((rCell: any) => {
              if (rCell.value !== null) return rCell;
              const fCell = fallback.heatmap.find(
                (f: any) => f.facility === rCell.facility && f.hour === rCell.hour
              );
              return {
                ...rCell,
                value: fCell ? fCell.value : null
              };
            });
          })(),
          // 30일 수요 분산 효과는 장기 A/B 추이라 일관된 합성 추이를 유지(데모 가독성).
          distribution: fallback.distribution,
          // 실측 이상 알림이 있으면 그것을, 없으면 합성 알림으로 패널이 비지 않게.
          anomalies: real.anomalies && real.anomalies.length ? real.anomalies : fallback.anomalies,
        };
        if (active) setData(merged);
      } catch (err) {
        console.warn("실데이터 조회 실패, 합성 폴백으로 대체:", err);
        if (active) setData(fallback);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadData();
    return () => {
      active = false;
    };
  }, []);

  if (loading || !data) {
    return (
      <div className="flex h-screen w-screen bg-[#070b19] items-center justify-center font-sans text-slate-400">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="font-semibold text-sm">대시보드 데이터를 조회 중입니다...</p>
        </div>
      </div>
    );
  }

  const { kpi, heatmap, distribution, anomalies } = data;

  // 정적 export 에는 서버 라우트(/api/admin/export)가 없으므로, 현재 로드된 데이터로
  // 클라이언트에서 CSV 를 생성해 다운로드한다(엑셀 한글 깨짐 방지를 위해 BOM 부착).
  const handleExportCsv = () => {
    try {
      const lines: string[] = [];
      lines.push('구분,항목,값');
      lines.push(`KPI,오늘 평균 혼잡도(%),${(kpi.avgCongestion.value * 100).toFixed(1)}`);
      lines.push(`KPI,AI 추천 수락률(%),${(kpi.acceptRate.value * 100).toFixed(1)}`);
      lines.push(`KPI,활성 사용자(DAU),${kpi.activeUsers}`);
      lines.push(`KPI,이상 혼잡 발생(건),${kpi.anomalyCount}`);
      lines.push('');
      lines.push('시설명,유형,시간(시),혼잡도(%)');
      for (const c of heatmap as any[]) {
        const name = String(c.facility).replace(/[",\n]/g, ' ');
        lines.push(`${name},${c.facilityType},${c.hour},${Math.round((c.value ?? 0) * 100)}`);
      }
      const csv = '﻿' + lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().split('T')[0];
      a.href = url;
      a.download = `nextspot-dashboard-${today}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('CSV 내보내기 실패:', e);
      alert('CSV 내보내기에 실패했습니다.');
    }
  };

  return (
    <div className="flex h-screen bg-[#070b19] text-slate-100 font-sans overflow-hidden">

      {/* Sidebar */}
      <AdminSidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-slate-100">경주 관광 혼잡 종합 대시보드</h2>
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
              {kpi.anomalyCount > 0 && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-rose-500 rounded-full border-2 border-slate-900"></span>
              )}
            </button>
            <div className="w-10 h-10 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center font-bold text-blue-300">
              AD
            </div>
          </div>
        </header>

        {/* Dashboard Content (Scrollable) */}
        <div className="flex-1 p-8 overflow-y-auto flex flex-col gap-8">
          
          {/* Action Bar (Export & Simulation) */}
          <div className="flex justify-end items-center gap-4">
            <SimulatePeakButton />
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-lg shadow-sm transition-colors text-sm cursor-pointer"
            >
              <Download size={16} /> 데이터 내보내기 (CSV)
            </button>
          </div>

          {/* KPI Cards (Server Rendered) */}
          <div className="grid grid-cols-4 gap-6">
            {/* 오늘 평균 혼잡도 */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-blue-500/10 rounded-xl text-blue-400">
                  <Activity size={24} />
                </div>
                <span className={`px-2 py-1 text-xs font-bold rounded-full ${kpi.avgCongestion.changePercent < 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                  {kpi.avgCongestion.changePercent > 0 ? '+' : ''}{kpi.avgCongestion.changePercent}%
                </span>
              </div>
              <div>
                <h3 className="text-slate-400 text-sm font-semibold mb-1">오늘 평균 혼잡도</h3>
                <div className="text-3xl font-black text-slate-100">
                  {(kpi.avgCongestion.value * 100).toFixed(1)}%
                </div>
              </div>
            </div>

            {/* 추천 수락률 */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-purple-500/10 rounded-xl text-purple-400">
                  <TrendingUp size={24} />
                </div>
                <span className="text-xs font-bold text-slate-500">지난 7일</span>
              </div>
              <div>
                <h3 className="text-slate-400 text-sm font-semibold mb-1">AI 추천 수락률</h3>
                <div className="text-3xl font-black text-slate-100">
                  {(kpi.acceptRate.value * 100).toFixed(1)}%
                </div>
                <div className="text-xs text-slate-500 mt-1">총 {kpi.acceptRate.total}건 중 {kpi.acceptRate.accepted}건 수락</div>
              </div>
            </div>

            {/* DAU */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-400">
                  <Users size={24} />
                </div>
              </div>
              <div>
                <h3 className="text-slate-400 text-sm font-semibold mb-1">활성 사용자 수 (DAU)</h3>
                <div className="text-3xl font-black text-slate-100">
                  {kpi.activeUsers.toLocaleString()}명
                </div>
              </div>
            </div>

            {/* 이상 혼잡 알림 건수 */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-rose-500/10 rounded-xl text-rose-400">
                  <AlertTriangle size={24} />
                </div>
              </div>
              <div>
                <h3 className="text-slate-400 text-sm font-semibold mb-1">이상 혼잡 발생 (오늘)</h3>
                <div className="text-3xl font-black text-rose-600">
                  {kpi.anomalyCount}건
                </div>
              </div>
            </div>
          </div>

          {/* Charts Row (Client Components) */}
          <div className="grid grid-cols-4 gap-6">
            <DashboardHeatmap heatmapData={heatmap} />
            <DashboardCharts distribution={distribution} />
          </div>

          {/* Bottom Section */}
          <div className="grid grid-cols-3 gap-6 pb-10">
            {/* Facility Table (Client Component) */}
            <FacilityTable />

            {/* Anomaly Alerts List (Server Rendered) */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-sm overflow-hidden flex flex-col">
              <div className="p-6 border-b border-slate-800 flex items-center gap-2 bg-slate-800/30">
                <AlertTriangle className="text-rose-400" size={20} />
                <h3 className="text-lg font-bold text-slate-100">이상 혼잡 알림 내역</h3>
              </div>
              <div className="flex-1 p-4 overflow-y-auto">
                <div className="flex flex-col gap-3">
                  {anomalies.map((alert: any) => (
                    <div key={alert.id} className="p-4 rounded-xl border border-rose-500/15 bg-rose-500/10 flex flex-col gap-2 relative overflow-hidden">
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-rose-500"></div>
                      <div className="flex justify-between items-start">
                        <span className="font-bold text-rose-300">{alert.facilityName}</span>
                        <span className="text-xs font-semibold text-rose-400">
                          {new Date(alert.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </span>
                      </div>
                      <div className="text-sm text-rose-400 flex justify-between">
                        <span>임계치 초과: {(alert.congestionLevel * 100).toFixed(0)}%</span>
                        <span className="font-bold">지속: {alert.durationMinutes}분</span>
                      </div>
                    </div>
                  ))}
                  {anomalies.length === 0 && (
                    <div className="text-center text-slate-500 py-10 text-sm">
                      현재 발생한 이상 알림이 없습니다.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
