'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, Bell, BellOff, CheckCircle2, Clock, Info,
  MapPin, RefreshCw, SlidersHorizontal, TrendingUp, Users,
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { adminApi } from '@/lib/admin-api';

// 인파 밀집 안전 경보(B2G 관제) — GET /api/v1/admin/safety/status (apps/api/app/routers/safety.py) 미러.
//
// 정직성 원칙(반드시 유지):
//  - 이 화면은 실측 제보·혼잡 로그 기반의 '근사' 경보다. 문자/카톡 등 실 발송 연동은 2단계(추후) 작업이며
//    이 화면은 관제 열람 + 브라우저 알림 옵트인까지만 제공한다.
//  - '존'은 좌표를 소수점 셋째 자리(≈150m)로 반올림한 격자 근사다. 행정동·실제 골목 경계가 아니다.
//  - 임계값 슬라이더는 세션 로컬 상태로만 반영되며 즉시 조회 쿼리에 실린다. 백엔드 기본값 자체를
//    바꾸는 '저장'은 2단계 작업 — 이 화면에는 없다.

const REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_ALERT_PCT = 85; // 백엔드 기본 threshold(0.85)와 동일
const DEFAULT_WARN_PCT = 70;  // 백엔드 기본 warn(0.7)과 동일

interface SafetyFacilityItem {
  facilityId: string;
  facilityName: string;
  facilityType: string;
  congestion: number;
  nextHourCongestion: number | null;
  timestamp: string | null;
}

interface SafetyZone {
  zoneId: string;
  zoneLabel: string;
  topFacilityId: string | null;
  avgCongestion: number;
  maxCongestion: number;
  facilityCount: number;
  level: 'alert' | 'warn' | 'normal';
  nextHourCongestion: number | null;
}

interface SafetySummary {
  alertZones: number;
  warnZones: number;
  normalZones: number;
  alertFacilities: number;
  warnFacilities: number;
}

interface SafetyStatusResponse {
  generatedAt: string;
  sampleEmpty: boolean;
  thresholds: { alert: number; warn: number };
  meta: { zoneMethod: string };
  facilityAlerts: SafetyFacilityItem[];
  facilityWarnings: SafetyFacilityItem[];
  zones: SafetyZone[];
  summary: SafetySummary;
}

type NotifPermission = 'default' | 'granted' | 'denied' | 'unsupported';

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function fmtKstTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return '—';
  }
}

function notificationSupported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

function KpiCard({
  label, value, tone, icon,
}: {
  label: string;
  value: number;
  tone: 'red' | 'amber' | 'emerald';
  icon: React.ReactNode;
}) {
  const toneClass: Record<string, string> = {
    red: 'border-l-rose-500 text-rose-400',
    amber: 'border-l-amber-500 text-amber-300',
    emerald: 'border-l-emerald-500 text-emerald-300',
  };
  return (
    <div className={`flex-1 bg-hanok-panel p-5 rounded-2xl border border-hanok-line border-l-4 shadow-sm ${toneClass[tone]}`}>
      <div className="flex items-center gap-2 text-hanok-muted mb-2">
        {icon}
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <div className="text-3xl font-black tabular-nums">{value}</div>
    </div>
  );
}

function ZoneCard({ zone }: { zone: SafetyZone }) {
  const isAlert = zone.level === 'alert';
  return (
    <div
      className={`p-5 rounded-2xl border shadow-sm flex flex-col gap-3 ${
        isAlert
          ? 'bg-rose-500/10 border-rose-500/40'
          : 'bg-amber-500/10 border-amber-500/40'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <MapPin size={18} className={isAlert ? 'text-rose-400' : 'text-amber-300'} />
          <h3 className="font-bold text-hanok-ink truncate">{zone.zoneLabel}</h3>
        </div>
        <span
          className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${
            isAlert ? 'bg-rose-500 text-white' : 'bg-amber-500 text-white'
          }`}
        >
          {isAlert ? '경보' : '주의'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-hanok-muted text-xs mb-0.5">평균 혼잡</div>
          <div className="font-bold text-hanok-ink tabular-nums">{pct(zone.avgCongestion)}</div>
        </div>
        <div>
          <div className="text-hanok-muted text-xs mb-0.5">최대 혼잡</div>
          <div className={`font-bold tabular-nums ${isAlert ? 'text-rose-400' : 'text-amber-300'}`}>
            {pct(zone.maxCongestion)}
          </div>
        </div>
        <div>
          <div className="text-hanok-muted text-xs mb-0.5 flex items-center gap-1"><Users size={12} />시설 수</div>
          <div className="font-bold text-hanok-ink tabular-nums">{zone.facilityCount}개</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-hanok-muted border-t border-hanok-line/60 pt-2">
        <TrendingUp size={13} />
        다음 1시간 예측:{' '}
        <span className="font-semibold text-hanok-ink">
          {zone.nextHourCongestion !== null ? pct(zone.nextHourCongestion) : '예측 불가'}
        </span>
      </div>
    </div>
  );
}

export default function SafetyPage() {
  const [data, setData] = useState<SafetyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 임계값 슬라이더 — 세션 로컬 상태(%, 정수). 조회 시 0~1 소수로 변환해 쿼리에 싣는다.
  const [alertPct, setAlertPct] = useState(DEFAULT_ALERT_PCT);
  const [warnPct, setWarnPct] = useState(DEFAULT_WARN_PCT);
  const alertRef = useRef(alertPct);
  const warnRef = useRef(warnPct);
  useEffect(() => { alertRef.current = alertPct; }, [alertPct]);
  useEffect(() => { warnRef.current = warnPct; }, [warnPct]);

  // 브라우저 알림 옵트인 상태
  const [notifSupported, setNotifSupported] = useState(false);
  const [notifPermission, setNotifPermission] = useState<NotifPermission>('default');
  const [notifEnabled, setNotifEnabled] = useState(false);
  const notifEnabledRef = useRef(false);
  useEffect(() => { notifEnabledRef.current = notifEnabled; }, [notifEnabled]);
  const prevAlertCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (notificationSupported()) {
      setNotifSupported(true);
      setNotifPermission(Notification.permission as NotifPermission);
    }
  }, []);

  const fireAlertNotification = useCallback((increasedBy: number) => {
    if (!notificationSupported() || Notification.permission !== 'granted') return;
    try {
      new Notification('인파 밀집 경보 증가', {
        body: `경보 존이 ${increasedBy}건 늘었습니다. 관제 화면에서 확인하세요.`,
        tag: 'nextspot-safety-alert',
        icon: '/icon.svg',
      });
    } catch {
      /* 알림 생성 실패는 무시 — 데모 무중단 원칙 */
    }
  }, []);

  const fetchStatus = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const alertQ = (alertRef.current / 100).toFixed(2);
      const warnQ = (warnRef.current / 100).toFixed(2);
      const res: SafetyStatusResponse = await adminApi.get(
        `/api/v1/admin/safety/status?threshold=${alertQ}&warn=${warnQ}`,
      );
      setData(res);
      setError(null);

      if (notifEnabledRef.current && prevAlertCountRef.current !== null
        && res.summary.alertZones > prevAlertCountRef.current) {
        fireAlertNotification(res.summary.alertZones - prevAlertCountRef.current);
      }
      prevAlertCountRef.current = res.summary.alertZones;
    } catch (err: any) {
      // 백엔드 미기동/네트워크 실패 — 우아한 빈 상태로 폴백(무한 스켈레톤 금지).
      console.warn('안전 경보 조회 실패:', err);
      setError(err?.message || '백엔드에 연결할 수 없습니다.');
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [fireAlertNotification]);

  // 최초 로드 + 30초 자동 새로고침(cleanup 필수)
  useEffect(() => {
    fetchStatus();
    const id = setInterval(() => fetchStatus(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // 임계값 슬라이더 변경 → 디바운스 후 재조회(쿼리 파라미터로 전달)
  useEffect(() => {
    const t = setTimeout(() => { fetchStatus(true); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertPct, warnPct]);

  const requestNotifPermission = async () => {
    if (!notificationSupported()) return;
    if (notifEnabled) {
      setNotifEnabled(false);
      return;
    }
    let perm: NotifPermission = Notification.permission as NotifPermission;
    if (perm === 'default') {
      try {
        perm = (await Notification.requestPermission()) as NotifPermission;
      } catch {
        perm = Notification.permission as NotifPermission;
      }
    }
    setNotifPermission(perm);
    setNotifEnabled(perm === 'granted');
  };

  // 슬라이더 상호 제약: 주의 임계값은 항상 경보 임계값보다 낮게 유지(역전 방지, 백엔드도 방어적으로 스왑함)
  const handleAlertChange = (v: number) => {
    setAlertPct(v);
    if (warnPct >= v) setWarnPct(Math.max(0, v - 1));
  };
  const handleWarnChange = (v: number) => {
    setWarnPct(v);
    if (v >= alertPct) setAlertPct(Math.min(100, v + 1));
  };

  const zones = data?.zones ?? [];
  const alertZones = zones.filter((z) => z.level === 'alert');
  const warnZones = zones.filter((z) => z.level === 'warn');
  const cardZones = [...alertZones, ...warnZones];

  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <div>
            <h2 className="text-xl font-bold text-hanok-ink flex items-center gap-2">
              <AlertTriangle size={20} className="text-terracotta" />
              인파 밀집 안전 경보
            </h2>
            <p className="text-xs text-hanok-muted mt-0.5">골목(존) 단위 조기경보 — B2G 관제</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs text-hanok-muted">
              <Clock size={14} />
              마지막 갱신: {data ? fmtKstTime(data.generatedAt) : '—'}
            </div>
            {notifSupported && (
              <button
                onClick={requestNotifPermission}
                disabled={notifPermission === 'denied'}
                title={notifPermission === 'denied' ? '브라우저 알림 권한이 차단되어 있습니다.' : '경보 증가 시 브라우저 알림 받기'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  notifEnabled
                    ? 'bg-gold/15 border-gold text-gold'
                    : 'bg-hanok-card border-hanok-line text-hanok-muted hover:border-gold'
                }`}
              >
                {notifEnabled ? <Bell size={14} /> : <BellOff size={14} />}
                {notifEnabled ? '알림 켜짐' : '알림 받기'}
              </button>
            )}
            <button
              onClick={() => fetchStatus(false)}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-1.5 bg-hanok-card border border-hanok-line hover:bg-hanok-line text-hanok-ink text-xs font-semibold rounded-lg transition-colors disabled:opacity-60"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              새로고침
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-5xl mx-auto flex flex-col gap-6 pb-16">

            {/* 정직성 라벨 */}
            <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-hanok-card border border-hanok-line text-xs text-hanok-muted">
              <Info size={15} className="flex-shrink-0 mt-0.5 text-gold" />
              <span>
                실측 제보·혼잡 로그 기반의 근사 경보입니다 — 문자/카톡 발송 연동은 2단계(추후) 작업입니다.
                존 구분은 좌표 기반 150m 격자 근사(<span className="font-mono">{data?.meta.zoneMethod ?? 'grid150m'}</span>)이며,
                행정동·실제 골목 경계와 다를 수 있습니다.
              </span>
            </div>

            {/* KPI */}
            <div className="flex gap-4">
              <KpiCard label="경보" value={data?.summary.alertZones ?? 0} tone="red" icon={<AlertTriangle size={16} />} />
              <KpiCard label="주의" value={data?.summary.warnZones ?? 0} tone="amber" icon={<AlertTriangle size={16} />} />
              <KpiCard label="정상" value={data?.summary.normalZones ?? 0} tone="emerald" icon={<CheckCircle2 size={16} />} />
            </div>

            {/* 임계값 슬라이더 */}
            <section className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden">
              <div className="p-5 border-b border-hanok-line bg-hanok-card/30 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal size={18} className="text-hanok-muted" />
                  <h4 className="font-bold text-hanok-ink text-sm">임계값 조절</h4>
                </div>
                <span className="text-[11px] font-semibold px-2 py-1 bg-hanok-card border border-hanok-line rounded-md text-hanok-muted">
                  저장은 2단계 — 지금은 이 화면 조회에만 반영됩니다
                </span>
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-8">
                <div>
                  <div className="flex justify-between items-end mb-2">
                    <h5 className="font-bold text-hanok-ink text-sm">경보 임계값</h5>
                    <span className="text-xl font-black text-rose-400 tabular-nums">{alertPct}%</span>
                  </div>
                  <input
                    type="range"
                    min={warnPct + 1}
                    max={100}
                    value={alertPct}
                    onChange={(e) => handleAlertChange(Number(e.target.value))}
                    className="w-full h-2 bg-hanok-line rounded-lg appearance-none cursor-pointer accent-rose-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between items-end mb-2">
                    <h5 className="font-bold text-hanok-ink text-sm">주의 임계값</h5>
                    <span className="text-xl font-black text-amber-300 tabular-nums">{warnPct}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={alertPct - 1}
                    value={warnPct}
                    onChange={(e) => handleWarnChange(Number(e.target.value))}
                    className="w-full h-2 bg-hanok-line rounded-lg appearance-none cursor-pointer accent-amber-500"
                  />
                </div>
              </div>
            </section>

            {/* 경보/주의 존 카드 리스트 */}
            <section className="flex flex-col gap-3">
              <h4 className="font-bold text-hanok-ink text-sm flex items-center gap-2">
                <MapPin size={16} className="text-hanok-muted" />
                경보·주의 존
              </h4>

              {loading && !data ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[0, 1].map((i) => (
                    <div key={i} className="h-32 rounded-2xl bg-hanok-line/40 animate-pulse" />
                  ))}
                </div>
              ) : error && !data ? (
                <div className="p-6 text-center bg-hanok-panel rounded-2xl border border-hanok-line">
                  <AlertTriangle className="mx-auto mb-2 text-hanok-muted" size={28} />
                  <p className="text-sm font-semibold text-hanok-ink mb-1">백엔드에 연결할 수 없습니다.</p>
                  <p className="text-xs text-hanok-muted mb-3">
                    안전 경보 API(/api/v1/admin/safety/status)가 아직 배선되지 않았거나 서버가 꺼져 있을 수 있습니다.
                  </p>
                  <button
                    onClick={() => fetchStatus(false)}
                    className="px-4 py-1.5 bg-hanok-card border border-hanok-line hover:bg-hanok-line rounded-lg text-xs font-semibold text-hanok-ink transition-colors"
                  >
                    다시 시도
                  </button>
                </div>
              ) : data?.sampleEmpty ? (
                <div className="p-8 text-center bg-hanok-panel rounded-2xl border border-hanok-line">
                  <CheckCircle2 className="mx-auto mb-2 text-hanok-muted" size={28} />
                  <p className="text-sm font-semibold text-hanok-ink mb-1">오늘 실측 표본이 없습니다.</p>
                  <p className="text-xs text-hanok-muted mb-3">
                    혼잡 로그가 아직 적재되지 않았습니다 — 시뮬레이터로 데모용 혼잡 로그를 생성할 수 있습니다.
                  </p>
                  <Link
                    href="/admin/simulator"
                    className="inline-block px-4 py-1.5 bg-gold hover:bg-gold-deep text-white rounded-lg text-xs font-semibold transition-colors"
                  >
                    시뮬레이터로 이동
                  </Link>
                </div>
              ) : cardZones.length === 0 ? (
                <div className="p-8 text-center bg-hanok-panel rounded-2xl border border-hanok-line">
                  <CheckCircle2 className="mx-auto mb-2 text-emerald-400" size={28} />
                  <p className="text-sm font-semibold text-hanok-ink">현재 경보·주의 존이 없습니다. 전체 정상입니다.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {cardZones.map((zone) => (
                    <ZoneCard key={zone.zoneId} zone={zone} />
                  ))}
                </div>
              )}
            </section>

          </div>
        </div>
      </main>
    </div>
  );
}
