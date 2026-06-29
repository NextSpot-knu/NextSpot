'use client';

import { useState, useEffect } from 'react';
import {
  Search, Bell, Settings as SettingsIcon, Sliders, Save, Database,
  RefreshCw, Building2, Activity, Clock, Loader2, CheckCircle2, AlertCircle
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { createPublicClient } from '@/lib/supabase';

const supabase = createPublicClient();

const DEFAULT_NOTICE = '현재 구내식당 메뉴 개편으로 인해 관련 데이터가 부정확할 수 있습니다.';

export default function SettingsPage() {
  // 즉시 렌더용 기본값 → 마운트 후 system_settings 실값으로 교체(스피너 없음).
  const [isMaintenance, setIsMaintenance] = useState(false);
  const [notice, setNotice] = useState(DEFAULT_NOTICE);
  const [threshold, setThreshold] = useState(80);
  const [weight, setWeight] = useState(50);

  const [stats, setStats] = useState<{ facilities: number | null; logs: number | null; lastLog: string | null }>({
    facilities: null, logs: null, lastLog: null,
  });
  const [statsLoading, setStatsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadStats = async () => {
    setStatsLoading(true);
    try {
      // count(head:true)는 행을 받지 않아 매우 빠름. 3개 병렬.
      const [fac, log, last] = await Promise.all([
        supabase.from('facilities').select('*', { count: 'exact', head: true }),
        supabase.from('congestion_logs').select('*', { count: 'exact', head: true }),
        supabase.from('congestion_logs').select('timestamp').order('timestamp', { ascending: false }).limit(1),
      ]);
      setStats({
        facilities: fac.count ?? null,
        logs: log.count ?? null,
        lastLog: last.data && last.data[0] ? last.data[0].timestamp : null,
      });
    } catch (e) {
      console.warn('DB 통계 로드 실패:', e);
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await supabase.from('system_settings').select('*').eq('id', 1).maybeSingle();
        if (active && data) {
          setIsMaintenance(!!data.maintenance_mode);
          if (typeof data.notice_text === 'string') setNotice(data.notice_text);
          if (typeof data.congestion_threshold === 'number') setThreshold(data.congestion_threshold);
          if (typeof data.coldstart_weight === 'number') setWeight(data.coldstart_weight);
        }
      } catch (e) {
        console.warn('설정 로드 실패(기본값 사용):', e);
      }
      if (active) loadStats();
    })();
    return () => { active = false; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const { data, error } = await supabase
        .from('system_settings')
        .update({
          maintenance_mode: isMaintenance,
          notice_text: notice,
          congestion_threshold: threshold,
          coldstart_weight: weight,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) {
        setSaveMsg({ type: 'err', text: '저장 대상이 없습니다. system_settings 마이그레이션 적용이 필요합니다.' });
      } else {
        setSaveMsg({ type: 'ok', text: '시스템 설정이 저장되었습니다.' });
      }
    } catch (e: any) {
      setSaveMsg({ type: 'err', text: `저장 실패: ${e?.message || '권한 또는 연결 오류'}` });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  };

  const fmtTime = (ts: string | null) => {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '—';
    }
  };

  return (
    <div className="flex h-screen bg-[#070b19] text-slate-100 font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-slate-100">시스템 설정</h2>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
              <input
                type="text"
                placeholder="Search settings..."
                className="pl-10 pr-4 py-2 bg-slate-800 text-slate-100 placeholder-slate-500 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
              />
            </div>
            <button className="relative text-slate-400 hover:text-slate-200">
              <Bell size={24} />
            </button>
          </div>
        </header>

        {/* Settings Content */}
        <div className="flex-1 p-8 overflow-y-auto">
          <div className="max-w-4xl mx-auto flex flex-col gap-8 pb-20">

            {/* Header Area */}
            <div className="flex justify-between items-end">
              <div>
                <h3 className="text-2xl font-bold text-slate-100 mb-2">환경 설정</h3>
                <p className="text-slate-400">앱 서비스의 상태 및 AI 추천 알고리즘의 세부 파라미터를 조정합니다.</p>
              </div>
              <div className="flex items-center gap-3">
                {saveMsg && (
                  <span className={`flex items-center gap-1.5 text-sm font-semibold ${saveMsg.type === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {saveMsg.type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                    {saveMsg.text}
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-900 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl font-bold shadow-sm shadow-blue-500/20 transition-colors"
                >
                  {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                  {saving ? '저장 중…' : '변경사항 저장'}
                </button>
              </div>
            </div>

            {/* Section A: 일반 설정 */}
            <section className="bg-slate-900 rounded-2xl border border-slate-800 shadow-sm overflow-hidden">
              <div className="p-5 border-b border-slate-800 bg-slate-800/30 flex items-center gap-2">
                <SettingsIcon size={20} className="text-slate-400" />
                <h4 className="font-bold text-slate-100">일반 설정 (General)</h4>
              </div>
              <div className="p-6 flex flex-col gap-6">

                {/* Maintenance Toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <h5 className="font-bold text-slate-100 mb-1">서비스 점검 모드</h5>
                    <p className="text-sm text-slate-400">점검 모드를 활성화하면 사용자들의 앱 접속이 제한되고 공지사항이 표시됩니다.</p>
                  </div>
                  <button
                    onClick={() => setIsMaintenance(!isMaintenance)}
                    className={`w-14 h-7 rounded-full p-1 transition-colors flex-shrink-0 ${isMaintenance ? 'bg-rose-500' : 'bg-slate-600'}`}
                  >
                    <div className={`w-5 h-5 bg-white rounded-full shadow-sm transform transition-transform ${isMaintenance ? 'translate-x-7' : 'translate-x-0'}`} />
                  </button>
                </div>

                {/* Notice Input */}
                <div>
                  <h5 className="font-bold text-slate-100 mb-2">앱 상단 고정 공지사항</h5>
                  <input
                    type="text"
                    value={notice}
                    onChange={(e) => setNotice(e.target.value)}
                    placeholder="사용자 앱 상단에 표시할 공지 문구"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </section>

            {/* Section B: AI 추천 엔진 설정 */}
            <section className="bg-slate-900 rounded-2xl border border-slate-800 shadow-sm overflow-hidden border-l-4 border-l-purple-500">
              <div className="p-5 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sliders size={20} className="text-purple-400" />
                  <h4 className="font-bold text-slate-100">AI 추천 알고리즘 설정</h4>
                </div>
                <span className="text-xs font-bold px-2 py-1 bg-purple-500/15 text-purple-300 rounded-md">
                  CORE CONFIG
                </span>
              </div>
              <div className="p-6 flex flex-col gap-8">

                {/* Threshold Slider */}
                <div>
                  <div className="flex justify-between items-end mb-2">
                    <div>
                      <h5 className="font-bold text-slate-100 mb-1">혼잡도 임계값 (Congestion Threshold)</h5>
                      <p className="text-sm text-slate-400">인프라 수용량 대비 몇 %일 때 &apos;혼잡(Red)&apos; 상태로 판단할지 설정합니다.</p>
                    </div>
                    <span className="text-2xl font-black text-rose-400">{threshold}%</span>
                  </div>
                  <input
                    type="range"
                    min="50" max="100"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-rose-500"
                  />
                  <div className="flex justify-between text-xs text-slate-500 mt-2 font-medium">
                    <span>50% (매우 민감)</span>
                    <span>100% (둔감)</span>
                  </div>
                </div>

                {/* Weight Slider */}
                <div>
                  <div className="flex justify-between items-end mb-2">
                    <div>
                      <h5 className="font-bold text-slate-100 mb-1">콜드 스타트 방지 데이터 가중치</h5>
                      <p className="text-sm text-slate-400">추천 시 &apos;실시간 빈자리&apos;와 &apos;유저 온보딩 선호도&apos; 중 어느 쪽에 가중치를 둘지 설정합니다.</p>
                    </div>
                  </div>
                  <div className="relative pt-4">
                    <input
                      type="range"
                      min="0" max="100"
                      value={weight}
                      onChange={(e) => setWeight(Number(e.target.value))}
                      className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-600"
                    />
                    <div className="flex justify-between text-xs font-bold mt-3">
                      <span className={weight < 50 ? 'text-purple-400' : 'text-slate-500'}>실시간 빈자리 우선</span>
                      <span className={weight === 50 ? 'text-purple-400' : 'text-slate-500'}>균형 50:50</span>
                      <span className={weight > 50 ? 'text-purple-400' : 'text-slate-500'}>개인 선호도 우선</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Section C: 데이터베이스 현황 (실DB) */}
            <section className="bg-slate-900 rounded-2xl border border-slate-800 shadow-sm overflow-hidden">
              <div className="p-5 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database size={20} className="text-slate-400" />
                  <h4 className="font-bold text-slate-100">데이터베이스 현황</h4>
                </div>
                <button
                  onClick={loadStats}
                  disabled={statsLoading}
                  className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg transition-colors disabled:opacity-60"
                >
                  <RefreshCw size={14} className={statsLoading ? 'animate-spin' : ''} /> 새로고침
                </button>
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* 시설 수 */}
                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-slate-400">
                    <Building2 size={16} className="text-blue-400" />
                    <span className="text-xs font-semibold">등록 시설</span>
                  </div>
                  <div className="text-2xl font-black text-slate-100">
                    {statsLoading && stats.facilities === null ? '…' : `${(stats.facilities ?? 0).toLocaleString()}개`}
                  </div>
                </div>
                {/* 누적 로그 */}
                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-slate-400">
                    <Activity size={16} className="text-emerald-400" />
                    <span className="text-xs font-semibold">누적 혼잡 로그</span>
                  </div>
                  <div className="text-2xl font-black text-slate-100">
                    {statsLoading && stats.logs === null ? '…' : `${(stats.logs ?? 0).toLocaleString()}건`}
                  </div>
                </div>
                {/* 최근 로그 시각 */}
                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-slate-400">
                    <Clock size={16} className="text-amber-400" />
                    <span className="text-xs font-semibold">최근 데이터 수집</span>
                  </div>
                  <div className="text-lg font-bold text-slate-100">
                    {statsLoading && stats.lastLog === null ? '…' : fmtTime(stats.lastLog)}
                  </div>
                </div>
              </div>
            </section>

          </div>
        </div>
      </main>
    </div>
  );
}
