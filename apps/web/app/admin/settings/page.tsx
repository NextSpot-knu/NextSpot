'use client';

import { useState, useEffect } from 'react';
import {
  Search, Bell, Settings as SettingsIcon, Sliders, Save, Database,
  RefreshCw, Building2, Activity, Clock, Loader2, CheckCircle2, AlertCircle
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { createPublicClient } from '@/lib/supabase';
import { adminApi } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import { countLabel, settingsSaveGuard, type LoadStatus, type SettingsLoad } from '@/lib/adminLoadState';

// DB 통계(count)는 anon 읽기(facilities/congestion_logs 공개 유지), system_settings 읽기/쓰기는
// 관리자 API(FastAPI service_role) 경유 — anon 은 RLS 로 거부된다(WS-A-6).
const supabase = createPublicClient();

const DEFAULT_NOTICE = '현재 일부 식당·카페 정보 갱신 중으로 관련 데이터가 일시적으로 부정확할 수 있습니다.';

/** GET /api/v1/admin/settings 응답 — system_settings 단일 행(snake_case, admin-api 는 케이스 변환 없음).
 *  행이 없으면 백엔드가 null 을 반환한다(마이그레이션 미적용 환경 = 'missing').
 *  필드별 typeof 가드가 있으므로 넓게 잡는다. */
interface SystemSettingsRow {
  maintenance_mode?: boolean | null;
  notice_text?: string | null;
  congestion_threshold?: number | null;
  coldstart_weight?: number | null;
}

export default function SettingsPage() {
  // 화면에 보이는 초기값은 어디까지나 **프런트 기본값**이다. 조회가 성공해야 서버 값으로 바뀐다.
  // 이 구분을 settingsLoad 가 들고 있다 — 이게 없으면 조회 실패가 '기본값' 으로 위장돼,
  // 관리자가 저장을 누르는 순간 읽지도 못한 실제 설정이 기본값으로 덮인다.
  const [isMaintenance, setIsMaintenance] = useState(false);
  const [notice, setNotice] = useState(DEFAULT_NOTICE);
  const [threshold, setThreshold] = useState(80);
  // coldstart_weight — **화면에 컨트롤이 없다**(아래 Section B 의 제거 사유 주석 참조).
  // 그래도 상태로 들고 있는 이유: 서버 모델(SettingsUpdate)이 이 필드를 필수로 받으므로
  // PUT 에서 뺄 수 없고, 읽어 온 값을 그대로 되돌려 보내야 저장할 때마다 기본값(50)으로
  // 덮이지 않는다. 즉 이 값은 지금 '읽어서 그대로 돌려주는' 통과 값이다.
  const [weight, setWeight] = useState(50);
  const [settingsLoad, setSettingsLoad] = useState<SettingsLoad>({ status: 'loading' });

  const [stats, setStats] = useState<{ facilities: number | null; logs: number | null; lastLog: string | null }>({
    facilities: null, logs: null, lastLog: null,
  });
  // DB 통계도 실패를 0 으로 그리지 않는다 — '등록 시설 0개' 는 관리자에게 재난이지 '문제 없음' 이 아니다.
  const [statsStatus, setStatsStatus] = useState<LoadStatus>('loading');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadStats = async () => {
    setStatsStatus('loading');
    try {
      // count(head:true)는 행을 받지 않아 매우 빠름. 3개 병렬.
      //
      // congestion_logs 는 `select('*')` 를 쓸 수 없다. 신원 컬럼(reporter_user_id,
      // origin_outcome_id)을 브라우저 역할에서 가리려고 테이블 SELECT 를 걷고 공개 컬럼만
      // 부여했는데(20260905090000), PostgreSQL 의 `*` 는 **모든 컬럼 권한을 요구**하므로
      // 그대로 두면 이 줄만 권한 오류로 죽는다. 어차피 head:true 라 행을 받지 않으니
      // 컬럼 하나면 충분하다.
      const [fac, log, last] = await Promise.all([
        supabase.from('facilities').select('*', { count: 'exact', head: true }),
        supabase.from('congestion_logs').select('id', { count: 'exact', head: true }),
        supabase.from('congestion_logs').select('timestamp').order('timestamp', { ascending: false }).limit(1),
      ]);
      // supabase-js 는 쿼리 오류를 throw 하지 않고 error 로 돌려준다 — 구조분해하지 않으면
      // try/catch 가 있어도 실패가 조용히 'count=null → 0개' 로 흘러간다.
      const failure = fac.error || log.error || last.error;
      if (failure) throw failure;
      setStats({
        facilities: fac.count ?? null,
        logs: log.count ?? null,
        lastLog: last.data && last.data[0] ? last.data[0].timestamp : null,
      });
      setStatsStatus('ok');
    } catch (e) {
      console.warn('DB 통계 로드 실패:', e);
      setStatsStatus('failed');
    }
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data: SystemSettingsRow | null = await adminApi.get('/api/v1/admin/settings');
        if (!active) return;
        if (data) {
          setIsMaintenance(!!data.maintenance_mode);
          if (typeof data.notice_text === 'string') setNotice(data.notice_text);
          if (typeof data.congestion_threshold === 'number') setThreshold(data.congestion_threshold);
          if (typeof data.coldstart_weight === 'number') setWeight(data.coldstart_weight);
          setSettingsLoad({ status: 'ok' });
        } else {
          // 백엔드가 null = system_settings 행 자체가 없다. 덮어쓸 실제 설정이 없으므로
          // 저장은 막지 않는다(PUT 은 404 로 사실을 말해 준다).
          setSettingsLoad({ status: 'missing' });
        }
      } catch (e) {
        console.warn('설정 로드 실패:', e);
        if (active) {
          setSettingsLoad({ status: 'failed', message: errorMessage(e) || '알 수 없는 오류' });
        }
      }
      if (active) loadStats();
    })();
    return () => { active = false; };
  }, []);

  const saveGuard = settingsSaveGuard(settingsLoad, saving);

  const handleSave = async () => {
    // 조회 실패 상태의 저장은 눌러도 아무 일이 없어야 한다. 버튼 disabled 만 믿지 않는 이유는
    // 이 핸들러가 유일한 쓰기 경로이고, 여기서 막아야 어떤 경로로 호출돼도 안전하기 때문이다.
    if (!saveGuard.allowed) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await adminApi.put('/api/v1/admin/settings', {
        maintenance_mode: isMaintenance,
        notice_text: notice,
        congestion_threshold: threshold,
        // 화면에 컨트롤이 없는 통과 값 — 읽어 온 값을 그대로 되돌려 보낸다(위 상태 선언 주석).
        coldstart_weight: weight,
      });
      setSaveMsg({ type: 'ok', text: '시스템 설정이 저장되었습니다.' });
      // 저장에 성공했다면 서버에 우리가 보낸 값이 실제로 들어 있다 — 이제 화면 값은 서버 값이다.
      setSettingsLoad({ status: 'ok' });
    } catch (e) {
      setSaveMsg({ type: 'err', text: `저장 실패: ${errorMessage(e) || '권한 또는 연결 오류'}` });
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
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-hanok-ink">시스템 설정</h2>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-hanok-muted" size={18} />
              <input
                type="text"
                placeholder="Search settings..."
                className="pl-10 pr-4 py-2 bg-hanok-card text-hanok-ink placeholder-hanok-muted rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold w-64"
              />
            </div>
            <button className="relative text-hanok-muted hover:text-hanok-ink">
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
                <h3 className="text-2xl font-bold text-hanok-ink mb-2">환경 설정</h3>
                <p className="text-hanok-muted">앱 서비스의 상태 및 AI 추천 알고리즘의 세부 파라미터를 조정합니다.</p>
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
                  disabled={!saveGuard.allowed}
                  title={saveGuard.reason ?? undefined}
                  className="flex items-center gap-2 bg-gold hover:bg-gold-deep disabled:bg-gold-deep disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl font-bold shadow-sm shadow-gold/20 transition-colors"
                >
                  {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                  {saving ? '저장 중…' : '변경사항 저장'}
                </button>
              </div>
            </div>

            {/* 조회 실패 배너 — 화면의 값이 서버 값이 아님을 명시한다.
                이 안내가 없으면 기본값이 '현재 설정' 으로 읽히고, 저장 버튼이 막힌 이유도 알 수 없다. */}
            {settingsLoad.status === 'failed' && (
              <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4">
                <AlertCircle size={20} className="text-rose-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-rose-300">현재 설정을 불러오지 못했습니다</p>
                  <p className="text-sm text-hanok-muted mt-1">
                    아래 값은 서버에 저장된 설정이 아니라 <span className="font-semibold text-hanok-ink">화면 기본값</span>입니다.
                    이 상태에서 저장하면 실제 설정이 기본값으로 덮이므로 저장을 막아 두었습니다 — 새로고침해 다시 시도해 주세요.
                  </p>
                  <p className="text-xs text-hanok-muted mt-1">사유: {settingsLoad.message}</p>
                </div>
              </div>
            )}

            {/* 'missing' 은 실패가 아니다 — 저장할 행 자체가 없는 상태(마이그레이션 미적용). */}
            {settingsLoad.status === 'missing' && (
              <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
                <AlertCircle size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-amber-300">저장된 시스템 설정이 아직 없습니다</p>
                  <p className="text-sm text-hanok-muted mt-1">
                    system_settings 행이 없어 화면 기본값을 보여 주고 있습니다(마이그레이션 미적용).
                    덮어쓸 기존 설정은 없지만, 저장은 행이 생성된 뒤에만 성공합니다.
                  </p>
                </div>
              </div>
            )}

            {/* Section A: 일반 설정 */}
            <section className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden">
              <div className="p-5 border-b border-hanok-line bg-hanok-card/30 flex items-center gap-2">
                <SettingsIcon size={20} className="text-hanok-muted" />
                <h4 className="font-bold text-hanok-ink">일반 설정 (General)</h4>
              </div>
              <div className="p-6 flex flex-col gap-6">

                {/* Maintenance Toggle
                    문구를 사실에 맞췄다. 예전에는 '앱 접속이 제한되고' 라고 단언했는데
                    **이 앱은 접속을 막을 수 없다** — 정적 export(Vercel 정적 호스팅)라
                    요청을 가로챌 서버 미들웨어가 없고, 번들은 이미 브라우저에 내려가 있다.
                    실제로 할 수 있는 일은 '점검 안내를 전면에 띄우는 것' 뿐이다.
                    장애 때 관리자가 이 스위치를 켜고 접속이 차단됐다고 믿는 것이,
                    스위치가 아무 데도 연결돼 있지 않던 것만큼이나 위험했다. */}
                <div className="flex items-center justify-between">
                  <div>
                    <h5 className="font-bold text-hanok-ink mb-1">서비스 점검 안내</h5>
                    <p className="text-sm text-hanok-muted">
                      켜면 관광객 앱에 <span className="font-semibold text-hanok-ink">점검 안내가 전면에 표시</span>됩니다.
                      접속을 차단하지는 않습니다 — 정적 앱이라 서버가 요청을 막을 수 없고, 사용자는 계속 앱을 쓸 수 있습니다.
                    </p>
                  </div>
                  <button
                    onClick={() => setIsMaintenance(!isMaintenance)}
                    className={`w-14 h-7 rounded-full p-1 transition-colors flex-shrink-0 ${isMaintenance ? 'bg-rose-500' : 'bg-hanok-line'}`}
                  >
                    <div className={`w-5 h-5 bg-white rounded-full shadow-sm transform transition-transform ${isMaintenance ? 'translate-x-7' : 'translate-x-0'}`} />
                  </button>
                </div>

                {/* Notice Input */}
                <div>
                  <h5 className="font-bold text-hanok-ink mb-2">앱 상단 고정 공지사항</h5>
                  <input
                    type="text"
                    value={notice}
                    onChange={(e) => setNotice(e.target.value)}
                    placeholder="사용자 앱 상단에 표시할 공지 문구"
                    className="w-full bg-hanok border border-hanok-line rounded-lg px-4 py-3 text-hanok-ink placeholder-hanok-muted focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
              </div>
            </section>

            {/* Section B: 혼잡도 표시 기준
                예전 제목은 'AI 추천 알고리즘 설정' + 'CORE CONFIG' 배지였다. 그 안에 있던
                컨트롤 둘 중 하나(콜드 스타트 가중치)를 아래 이유로 걷어냈고, 남은 하나는
                추천 알고리즘이 아니라 **표시 등급 경계**라 제목을 사실에 맞췄다. */}
            <section className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden">
              <div className="p-5 border-b border-hanok-line bg-hanok-card/30 flex items-center gap-2">
                <Sliders size={20} className="text-jade" />
                <h4 className="font-bold text-hanok-ink">혼잡도 표시 기준</h4>
              </div>
              <div className="p-6 flex flex-col gap-8">

                {/* Threshold Slider
                    이 값의 뜻: 혼잡도(0~1)를 등급으로 나눌 때의 **'혼잡(Red)' 경계**다.
                    threshold=75 면 0.75 이상이 '혼잡'. 프런트 분류 함수는 지금
                    0.25/0.5/0.75 로 하드코딩돼 있고, 이 설정이 정하는 것은 그중
                    **마지막 경계 하나뿐**이다(여유/보통 경계는 이 설정과 무관하다).
                    값은 GET /api/v1/system/public-settings 가 congestionThreshold 로 내보낸다. */}
                <div>
                  <div className="flex justify-between items-end mb-2">
                    <div>
                      <h5 className="font-bold text-hanok-ink mb-1">혼잡 등급 경계 (Congestion Threshold)</h5>
                      <p className="text-sm text-hanok-muted">
                        인프라 수용량 대비 몇 %부터 &apos;혼잡(Red)&apos;으로 표시할지 정합니다.
                        아래 등급(여유·보통)의 경계는 이 설정이 바꾸지 않습니다.
                      </p>
                    </div>
                    <span className="text-2xl font-black text-rose-400">{threshold}%</span>
                  </div>
                  <input
                    type="range"
                    min="50" max="100"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="w-full h-2 bg-hanok-line rounded-lg appearance-none cursor-pointer accent-rose-500"
                  />
                  <div className="flex justify-between text-xs text-hanok-muted mt-2 font-medium">
                    <span>50% (매우 민감)</span>
                    <span>100% (둔감)</span>
                  </div>
                </div>

                {/* ⚠️ '콜드 스타트 방지 데이터 가중치'(coldstart_weight) 컨트롤을 제거했다.
                    이유는 배선이 없어서가 아니라, **배선하면 안 되는 값**이기 때문이다:
                    SPOT 추천 가중치는 packages/shared-types 를 통해 프런트 미러와 백엔드가
                    같은 값을 쓴다는 전제로 묶여 있고, 그 일치를 패리티 테스트가 지킨다.
                    런타임에 슬라이더로 바꾸면 서버 랭킹만 움직이고 프런트 미러는 그대로라
                    두 랭킹이 **조용히 갈라진다**(테스트는 여전히 초록이다 — 상수끼리는
                    일치하니까). 가중치를 바꾸려면 상수와 패리티 테스트를 함께 고쳐 배포하는
                    쪽이 맞다.

                    서버 모델(SettingsUpdate)과 DB 컬럼은 **일부러 건드리지 않았다.** 옛 관리자
                    번들이 coldstart_weight 를 담아 PUT 해도 422 가 나면 안 된다(Vercel·Render
                    배포 시점이 다르고 스테이징이 없다). 그래서 화면에서만 뺐고, 아래 handleSave
                    는 서버에서 읽어 온 값을 그대로 되돌려 보낸다 — 컨트롤이 사라졌다고 저장할
                    때마다 값이 기본값(50)으로 덮이면 그게 더 나쁜 종류의 조용한 변경이다. */}
              </div>
            </section>

            {/* Section C: 데이터베이스 현황 (실DB) */}
            <section className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden">
              <div className="p-5 border-b border-hanok-line bg-hanok-card/30 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database size={20} className="text-hanok-muted" />
                  <h4 className="font-bold text-hanok-ink">데이터베이스 현황</h4>
                </div>
                <button
                  onClick={loadStats}
                  disabled={statsStatus === 'loading'}
                  className="flex items-center gap-2 px-3 py-1.5 bg-hanok-card border border-hanok-line hover:bg-hanok-line text-hanok-ink text-xs font-semibold rounded-lg transition-colors disabled:opacity-60"
                >
                  <RefreshCw size={14} className={statsStatus === 'loading' ? 'animate-spin' : ''} /> 새로고침
                </button>
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* 시설 수 — 조회 실패를 '0개' 로 그리지 않는다(0개는 재난, 실패는 모름). */}
                <div className="p-4 bg-hanok border border-hanok-line rounded-xl flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-hanok-muted">
                    <Building2 size={16} className="text-gold" />
                    <span className="text-xs font-semibold">등록 시설</span>
                  </div>
                  <div className={`text-2xl font-black ${statsStatus === 'failed' ? 'text-rose-400 text-base' : 'text-hanok-ink'}`}>
                    {statsStatus === 'ok' ? `${(stats.facilities ?? 0).toLocaleString()}개` : countLabel(statsStatus, 0)}
                  </div>
                </div>
                {/* 누적 로그 */}
                <div className="p-4 bg-hanok border border-hanok-line rounded-xl flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-hanok-muted">
                    <Activity size={16} className="text-emerald-400" />
                    <span className="text-xs font-semibold">누적 혼잡 로그</span>
                  </div>
                  <div className={`text-2xl font-black ${statsStatus === 'failed' ? 'text-rose-400 text-base' : 'text-hanok-ink'}`}>
                    {statsStatus === 'ok' ? `${(stats.logs ?? 0).toLocaleString()}건` : countLabel(statsStatus, 0)}
                  </div>
                </div>
                {/* 최근 로그 시각 — 실패했을 때의 '—' 는 '수집된 적 없음' 으로 읽히므로 구분한다. */}
                <div className="p-4 bg-hanok border border-hanok-line rounded-xl flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-hanok-muted">
                    <Clock size={16} className="text-amber-400" />
                    <span className="text-xs font-semibold">최근 데이터 수집</span>
                  </div>
                  <div className={`text-lg font-bold ${statsStatus === 'failed' ? 'text-rose-400' : 'text-hanok-ink'}`}>
                    {statsStatus === 'loading' ? '…' : statsStatus === 'failed' ? '조회 실패' : fmtTime(stats.lastLog)}
                  </div>
                </div>
              </div>
              {statsStatus === 'failed' && (
                <p className="px-6 pb-5 -mt-2 text-xs text-rose-300">
                  DB 통계를 불러오지 못했습니다. 위 값은 0 이 아니라 <span className="font-semibold">모르는 상태</span>입니다 — 새로고침을 눌러 다시 시도하세요.
                </p>
              )}
            </section>

          </div>
        </div>
      </main>
    </div>
  );
}
