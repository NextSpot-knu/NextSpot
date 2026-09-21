'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Bell, Download, FileText, Calendar as CalendarIcon,
  TrendingUp, BarChart2, PieChart as PieChartIcon, Database, AlertCircle, RefreshCw, LogIn
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { createPublicClient } from '@/lib/supabase';
import { adminApi, adminApiKind, adminApiStatus } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import { foldObservations, describeGrowth } from '@/lib/adminUsageIndex';
import { emptyOrFailedText, reportSourceLabel, reportSourceState, type LoadStatus } from '@/lib/adminLoadState';
import {
  describeAdminFailure, kindFromMessage, type AdminFailureNotice,
} from '@/lib/adminApiFailure';
import { describeObservationGap, type LastObservation } from '@/lib/adminObservationGap';
import {
  ESTIMATE_BADGE, ESTIMATE_NO_HEADCOUNT_NOTE, categoryEstimateRows, estimatedSeriesBasisLine,
  estimatedSeriesMethodNote, estimatedSeriesUnavailableNote, readEstimatedSeries,
  weekdayEstimateRows, type CategoryEstimateRow, type WeekdayEstimateRow,
} from '@/lib/adminEstimatedSeries';

const supabase = createPublicClient();

// --- Types ---
type CategoryKo = '음식점' | '카페' | '관광지' | '문화시설';

/** 막대 차트 1행: 요일 + 카테고리별 관측 혼잡 지수(= (시설,30분)당 중앙값의 합) */
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
  facility_id: string | null;
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
const WEEK_ORDER = ['월', '화', '수', '목', '금', '토', '일'];
/** 막대·표에서 카테고리를 그리는 순서. TYPE_KO 의 값과 같은 집합이어야 한다. */
const CATEGORY_ORDER: CategoryKo[] = ['음식점', '카페', '관광지', '문화시설'];
/** 추정 막대 4색. 실측 막대와 같은 계열을 쓰되(같은 업종=같은 색), 파선 테두리로 갈라 본다. */
const CATEGORY_COLOR: Record<CategoryKo, string> = {
  음식점: '#3b82f6', 카페: '#10b981', 관광지: '#8b5cf6', 문화시설: '#f59e0b',
};
/** 혼잡 로그 조회 창. '데이터 없음' 문구가 이 숫자를 밝혀야 관리자가 범위를 안다. */
const LOG_WINDOW_DAYS = 14;
/** 추정 추이 조회 창. 화면은 최근 7일을 보여 주고, 앞 7일은 '전주 대비' 비교에만 쓴다. */
const ESTIMATE_WINDOW_DAYS = 14;
/** 요약표·막대 차트가 보여 주는 최근 창(일). 실측 쪽 '최근 7일' 과 같은 길이다. */
const ESTIMATE_SUMMARY_DAYS = 7;
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
function fmtMD(d: Date) {
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`;
}

// 최근 14일 혼잡 로그(시설 유형 조인). 최소 컬럼 + 페이지 캡으로 로딩 비용 최소화.
async function fetchLogs14d(): Promise<CongestionLogRow[]> {
  const since = new Date(Date.now() - LOG_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let out: CongestionLogRow[] = [];
  let from = 0;
  const limit = 1000;
  const maxPages = 8;
  for (let p = 0; p < maxPages; p++) {
    const { data, error } = await supabase
      .from('congestion_logs')
      .select('facility_id, current_count, timestamp, facility:facilities(type)')
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
/**
 * 혼잡 로그 표의 **마지막 관측 시각**(창 무관, 1행).
 *
 * 14일 창이 0행일 때 '데이터가 아직 없습니다' 로만 말하면, 수집이 19일째 멈춘 상황이
 * '원래 없는 데이터' 로 읽힌다. 그 둘은 관리자에게 정반대의 할 일이다 — 그래서 사실을
 * 조회해서 붙인다(지어내지 않는다).
 */
async function fetchLastObservation(): Promise<LastObservation> {
  const { data, error } = await supabase
    .from('congestion_logs')
    .select('timestamp')
    .order('timestamp', { ascending: false })
    .limit(1);
  if (error) throw error;
  const iso = data?.[0]?.timestamp;
  return typeof iso === 'string' && iso ? { status: 'at', iso } : { status: 'none' };
}

/** 추천 이력 조회 결과. 실패를 빈 배열로 뭉개지 않으려고 실패 사유를 함께 돌려준다. */
interface RecsResult {
  rows: RecommendationRow[];
  /** 실패했다면 '관리자가 무엇을 하면 되는지' 까지 담은 안내(성공이면 null). */
  failure: AdminFailureNotice | null;
}

async function fetchRecs28d(): Promise<RecsResult> {
  // 추천 이력은 RLS 강화(20260707 security_hardening)로 anon 열람 불가 →
  // 관리자 API(/admin/metrics, service_role) 경유(WS-A-6).
  //
  // 여기서 예외를 격리하는 이유는 로그 기반(막대/표) 실데이터를 살리기 위해서다. 다만
  // 예전처럼 빈 배열만 돌려주면 호출부가 '추천 이력이 아직 없다' 와 구분할 수 없어,
  // 관리자 API 가 죽어도 화면은 'AI 추천 수락 데이터가 아직 없습니다' 라고 말했다.
  //
  // 사유를 **문자열 한 줄**로 뭉개던 것도 여기서 끝낸다. 이 엔드포인트는 require_role(admin)
  // 가드라 401(세션 만료)·403(권한 없음)·타임아웃·5xx 가 전부 다른 조치를 요구하는데,
  // errorMessage() 한 줄로는 관리자가 그중 무엇인지 알 수 없었다.
  try {
    const metrics = await adminApi.get('/api/v1/admin/metrics?days=28');
    return { rows: metrics?.recommendations || [], failure: null };
  } catch (e) {
    console.warn('추천 이력(/admin/metrics) 로드 실패:', e);
    return {
      rows: [],
      failure: describeAdminFailure({
        kind: adminApiKind(e),
        status: adminApiStatus(e),
        message: errorMessage(e),
      }),
    };
  }
}

export default function ReportsPage() {
  const [weekly, setWeekly] = useState(EMPTY_WEEKLY);
  const [aiTrend, setAiTrend] = useState(EMPTY_AI);
  const [table, setTable] = useState<CategoryTableRow[]>(EMPTY_TABLE);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true); // 최초 로드 중 여부
  // 두 출처는 따로 실패할 수 있다. 한 덩어리로 묶으면 한쪽 실패가 다른 쪽의 '데이터 없음'
  // 으로 번지거나, 반대로 한쪽 성공이 다른 쪽 실패를 가린다.
  const [logsStatus, setLogsStatus] = useState<LoadStatus>('loading');   // 혼잡 로그 → 막대차트·요약표
  const [recsStatus, setRecsStatus] = useState<LoadStatus>('loading');   // 추천 이력 → AI 수락 트렌드
  // 실패 사유는 문자열이 아니라 '무엇을 하면 되는지' 까지 담은 안내로 들고 있는다.
  const [logsFailure, setLogsFailure] = useState<AdminFailureNotice | null>(null);
  const [recsFailure, setRecsFailure] = useState<AdminFailureNotice | null>(null);
  // 14일 창이 0행일 때 빈 자리에 넣을 사실 문장(실패가 아닐 때만 채운다).
  // 렌더가 아니라 **조회 시점에** 만든다 — 'N일 전' 의 기준 시각이 리렌더마다 흔들리면 안 된다.
  const [observationGap, setObservationGap] = useState<string | null>(null);
  const [rangeLabel, setRangeLabel] = useState('최근 7일');
  // 재시도 트리거. 타임아웃(콜드 스타트)·5xx 는 다시 누르면 풀릴 수 있는 실패라 버튼을 준다.
  const [reloadKey, setReloadKey] = useState(0);
  // 일별 **추정** 집계 응답 원문. 형을 믿지 않으므로 readEstimatedSeries 로만 읽는다
  // (옛 서버에는 이 엔드포인트가 없다 — 그때는 undefined 로 남고 화면은 아무 말도 하지 않는다).
  const [estimateRaw, setEstimateRaw] = useState<unknown>(undefined);

  useEffect(() => {
    let active = true;
    (async () => {
      // 재조회 시작 — 이전 실패 안내를 남겨 두면 성공한 화면에 옛 경고가 붙는다.
      setLoading(true);
      setLogsStatus('loading');
      setRecsStatus('loading');
      setLogsFailure(null);
      setRecsFailure(null);
      setObservationGap(null);
      setEstimateRaw(undefined);

      // 추정 추이는 **별도 요청**이다. 실측 두 출처와 서로를 막지 않는다 — 추정이 몇 초 걸리거나
      // 죽어도 실측 집계는 이미 자기 요청으로 끝나 있다.
      adminApi.get(`/api/v1/admin/reports/estimated?days=${ESTIMATE_WINDOW_DAYS}`).then(
        (value) => { if (active) setEstimateRaw(value); },
        (e) => { console.warn('추정 추이(/admin/reports/estimated) 로드 실패:', e); },
      );

      // 혼잡 로그 조회는 실패해도 추천 이력 쪽을 막지 않는다(allSettled).
      const [logsSettled, recs] = await Promise.all([
        fetchLogs14d().then(
          (rows) => ({ rows, failure: null as AdminFailureNotice | null }),
          (e) => {
            console.warn('혼잡 로그 로드 실패:', e);
            // Supabase(PostgREST) 오류에는 HTTP 상태가 없다. 최소한 6초 타임아웃만은
            // 갈라내 '다시 시도' 를 붙인다(lib/supabase.ts timeoutFetch).
            const message = errorMessage(e) ?? null;
            return {
              rows: [] as CongestionLogRow[],
              failure: describeAdminFailure({ kind: kindFromMessage(message), message }),
            };
          },
        ),
        fetchRecs28d(),
      ]);
      if (!active) return;

      const logs = logsSettled.rows;
      setLogsStatus(logsSettled.failure ? 'failed' : 'ok');
      setRecsStatus(recs.failure ? 'failed' : 'ok');
      setLogsFailure(logsSettled.failure);
      setRecsFailure(recs.failure);

      // 조회는 성공했는데 창이 비었다 = 실패가 아니라 '수집이 멈췄을 수 있다' 는 사실.
      // 언제가 마지막이었는지는 조회해서 말한다(창 밖이라 위 질의로는 알 수 없다).
      if (!logsSettled.failure && logs.length === 0) {
        let last: LastObservation = { status: 'unknown' };
        try {
          last = await fetchLastObservation();
        } catch (e) {
          // 마지막 관측 조회 실패 — '기록 없음' 으로 단정하지 않고 unknown 을 유지한다.
          console.warn('마지막 관측 시각 조회 실패:', e);
        }
        if (active) setObservationGap(describeObservationGap(last, LOG_WINDOW_DAYS, Date.now()));
      }

      try {

        const now = Date.now();
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const twoWeekAgo = now - 14 * 24 * 60 * 60 * 1000;
        setRangeLabel(`${fmtMD(new Date(weekAgo))} ~ ${fmtMD(new Date(now))} · 최근 7일`);

        let gotReal = false;

        // (1) 주간 관측 혼잡 지수 + (2) 카테고리 요약
        //
        // 예전에는 `current_count` 를 **그냥 다 더했다.** 그 값은 한 로그 행의 순간 재실 인원
        // 추정치라, 같은 시설의 로그가 많을수록 커진다 — 사람 수가 아니라 '누가 얼마나 자주
        // 제보했는가' 를 재고 있었다. 그래서 합을 내기 전에 **(시설, 30분 버킷)당 하나**로
        // 접는다(중앙값). 판정은 lib/adminUsageIndex.ts 에 있고 테스트가 잠근다.
        if (logs.length > 0) {
          const folded = foldObservations(
            logs.map((l) => ({
              facilityId: l.facility_id,
              timestamp: l.timestamp,
              currentCount: l.current_count,
            }))
          );
          // 접힌 조각에 업종을 다시 붙인다 — fold 는 시설 단위라 업종을 모른다.
          const typeByFacility = new Map<string, string>();
          for (const l of logs) {
            if (!l.facility_id) continue;
            const jt = joinedType(l);
            if (jt) typeByFacility.set(l.facility_id, jt);
          }

          const wk: Record<string, WeeklyRow> = {};
          for (const d of WEEK_ORDER) wk[d] = { day: d, 음식점: 0, 카페: 0, 관광지: 0, 문화시설: 0 };
          const thisWeek: Record<string, number> = { 음식점: 0, 카페: 0, 관광지: 0, 문화시설: 0 };
          const lastWeek: Record<string, number> = { 음식점: 0, 카페: 0, 관광지: 0, 문화시설: 0 };
          // 전주에 **관측 조각이 몇 개나 있었는지**. 0 이면 비교 자체가 불가능하다 —
          // 예전에는 그 자리에서 '+100% 급증' 을 지어냈다.
          const lastWeekBuckets: Record<string, number> = { 음식점: 0, 카페: 0, 관광지: 0, 문화시설: 0 };

          for (const f of folded) {
            const jt = typeByFacility.get(f.facilityId);
            if (!jt) continue;
            const ko = TYPE_KO[jt];
            if (!ko || !(ko in thisWeek)) continue;
            if (f.bucketMs >= weekAgo) {
              const wd = kstWeekdayKo(new Date(f.bucketMs).toISOString());
              if (wk[wd]) wk[wd][ko] += f.level;
              thisWeek[ko] += f.level;
            } else if (f.bucketMs >= twoWeekAgo) {
              lastWeek[ko] += f.level;
              lastWeekBuckets[ko] += 1;
            }
          }

          if (Object.values(thisWeek).some((v) => v > 0)) {
            setWeekly(WEEK_ORDER.map((d) => wk[d]));
            const types = ['음식점', '카페', '관광지', '문화시설'];
            setTable(
              types.map((ko, i) => {
                const verdict = describeGrowth(thisWeek[ko], lastWeek[ko], lastWeekBuckets[ko]);
                return {
                  id: i + 1,
                  category: ko,
                  // 단위를 뗀다. 접어도 여전히 재실 인원 **추정치**의 합이라 '명' 이 아니다.
                  totalUsers: Math.round(thisWeek[ko]).toLocaleString(),
                  growth:
                    verdict.percent === null
                      ? '—'
                      : `${verdict.percent >= 0 ? '+' : ''}${verdict.percent}%`,
                  status: verdict.status ?? '기준 준비 중',
                };
              })
            );
            gotReal = true;
          }
        }

        // (3) AI 수락 트렌드 (4주 버킷) — 추천 데이터가 충분할 때만 실측 반영
        if (recs.rows.length >= 8) {
          const buckets = [0, 1, 2, 3].map(() => ({ acc: 0, tot: 0 }));
          for (const r of recs.rows) {
            // age 를 0 아래로 두면 인덱스가 **위로** 튄다: 미래 시각이면 Math.min(3, -1) = -1 →
            // wIdx = 4 → buckets[4] 가 undefined 라 그 자리에서 TypeError 가 나고, 바깥
            // catch 가 이 계산을 통째로 날린다(차트는 빈 채로 남는다).
            // 기존 `if (wIdx < 0)` 가드는 죽은 코드였다 — Math.min(3, x) ≤ 3 이라 wIdx 는
            // 절대 음수가 되지 않는다. 막아야 했던 쪽은 반대편이었다.
            const age = now - new Date(r.created_at).getTime();
            if (!Number.isFinite(age)) continue; // created_at 파싱 실패 → NaN 인덱스
            const wIdx = 3 - Math.min(3, Math.floor(Math.max(0, age) / (7 * 24 * 60 * 60 * 1000)));
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
        // 집계 도중의 예외. 이 화면에 목업 데이터는 존재하지 않는다(EMPTY_* 는 전부 빈 배열)
        // — 예전 주석은 여기서 목업으로 폴백한다고 말했지만 실제로는 빈 화면이 남았고,
        // 그게 '데이터 없음' 으로 읽혔다.
        // 조회는 성공했는데 집계에서 죽은 것도 실패이므로 두 상태 모두 failed 로 올린다.
        console.warn('리포트 집계 실패:', e);
        if (active) {
          // 집계에서 죽은 것은 서버 탓이 아니라 우리 코드 탓이다 — 재시도로 풀릴 가능성은
          // 낮지만 상태 코드가 없는 실패이므로 일반 안내로 떨어진다(사유는 detail 에 남는다).
          const aggregateFailure = describeAdminFailure({ message: errorMessage(e) });
          setLogsStatus('failed');
          setRecsStatus('failed');
          setLogsFailure((prev) => prev ?? aggregateFailure);
          setRecsFailure((prev) => prev ?? aggregateFailure);
          setObservationGap(null);
        }
      } finally {
        // 로딩 종료. 이후 빈 자리는 조회 상태에 따라 '데이터 없음' 또는 '조회 실패' 로 안내한다.
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const anyFailed = logsStatus === 'failed' || recsStatus === 'failed';
  const sourceState = reportSourceState({ loading, failed: anyFailed, live: isLive });

  // ── 추정 모드 ──────────────────────────────────────────────────────────────
  // **실측이 이긴다.** 실측 집계가 한 줄이라도 나오면(weekly/table 이 비지 않으면) 추정은
  // 아예 만들지 않는다. 한 화면에 두 출처를 섞어 그리면 어느 막대가 무엇인지 말할 수 없다.
  // 조회 실패(logsStatus==='failed')일 때도 추정을 그리지 않는다 — 그때 화면이 말해야 하는
  // 사실은 '추정치' 가 아니라 '실측을 못 읽었다' 이고, 그 둘은 관리자의 할 일이 다르다.
  const estimatedSeries = useMemo(() => readEstimatedSeries(estimateRaw), [estimateRaw]);
  const measuredEmpty = !loading && logsStatus === 'ok' && weekly.length === 0 && table.length === 0;
  const estimateInUse = measuredEmpty && estimatedSeries && estimatedSeries.observedDays > 0
    ? estimatedSeries
    : null;
  const estimateWeekly: WeekdayEstimateRow[] = useMemo(
    () => (estimateInUse ? weekdayEstimateRows(estimateInUse.daily.slice(-ESTIMATE_SUMMARY_DAYS), TYPE_KO) : []),
    [estimateInUse],
  );
  const estimateTable: CategoryEstimateRow[] = useMemo(
    () => (estimateInUse ? categoryEstimateRows(estimateInUse.daily, TYPE_KO, { windowDays: ESTIMATE_SUMMARY_DAYS }) : []),
    [estimateInUse],
  );
  const estimateBasis = estimateInUse ? estimatedSeriesBasisLine(estimateInUse) : null;
  const estimateMethod = estimateInUse ? estimatedSeriesMethodNote(estimateInUse) : null;
  // 추정을 못 그린 이유. 실측이 있거나 조회 실패 중이거나 옛 서버면 아무 말도 하지 않는다.
  const estimateNote = !measuredEmpty || estimateInUse
    ? null
    : estimatedSeries
      ? '공영주차 실측(경주 ITS)을 10분 주기로 수집하는 중입니다 — 수집이 누적되면 추정 지표가 표시됩니다.'
      : estimatedSeriesUnavailableNote(estimateRaw);
  // 화면 위쪽 배너에 묶어 보여줄 갱신 대기 목록(출처 이름 + 안내).
  const failures: { source: string; notice: AdminFailureNotice }[] = [
    logsFailure ? { source: '혼잡 로그', notice: logsFailure } : null,
    recsFailure ? { source: '추천 이력', notice: recsFailure } : null,
  ].filter((f): f is { source: string; notice: AdminFailureNotice } => f !== null);
  const reload = () => setReloadKey((k) => k + 1);

  // Excel(=CSV) 내보내기: 현재 표시 중인 데이터로 클라이언트에서 생성(엑셀 한글 BOM).
  const handleExcel = () => {
    try {
      const lines: string[] = [];
      if (estimateInUse) {
        // 파일로 나간 숫자는 화면 맥락을 잃는다 — 추정이라는 사실과 근거를 **파일 안에** 박는다.
        lines.push('# 공영주차 실측 + 관광 통계 기반 추정 혼잡도(0~100%)');
        lines.push(`# 근거: ${(estimateBasis ?? '').replace(/,/g, ' ')}`);
        lines.push(`# 산식: ${(estimateMethod ?? '').replace(/,/g, ' ')}`);
        lines.push(`# ${ESTIMATE_NO_HEADCOUNT_NOTE.replace(/,/g, ' ')}`);
        lines.push('');
        lines.push('카테고리,추정 평균 혼잡도(%),전주 대비(%p),상태,산출일수');
        for (const r of estimateTable) {
          lines.push([
            r.label,
            r.avgCongestion === null ? '' : (r.avgCongestion * 100).toFixed(1),
            r.changePoints === null ? '' : r.changePoints.toFixed(1),
            r.status ?? '',
            r.dayCount,
          ].join(','));
        }
        lines.push('');
        lines.push('요일,음식점,카페,관광지,문화시설  (추정 평균 혼잡도 %)');
        for (const w of estimateWeekly) {
          lines.push([w.day, ...CATEGORY_ORDER.map((ko) => {
            const value = w[ko];
            return typeof value === 'number' ? (value * 100).toFixed(1) : '';
          })].join(','));
        }
      } else {
        lines.push('카테고리,관측 혼잡 지수,전주 대비,상태');
        for (const r of table) {
          lines.push(`${r.category},${String(r.totalUsers).replace(/,/g, '')},${r.growth},${r.status}`);
        }
        lines.push('');
        lines.push('요일,음식점,카페,관광지,문화시설');
        for (const w of weekly) {
          lines.push(`${w.day},${w.음식점},${w.카페},${w.관광지},${w.문화시설}`);
        }
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
      toast.error('내보내기를 다시 시도해 주세요.');
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
              {/* 데이터 출처 배지. 갱신 대기 상태를 '수집 중' 으로 뭉개면 관리자는 '이번 주엔
                  아무 일도 없었구나' 로 읽는다 — 상태를 따로 적고 색도 따로 쓴다. */}
              <span
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border ${
                  sourceState === 'live'
                    ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
                    : sourceState === 'failed' || sourceState === 'partial'
                      ? 'bg-rose-500/10 text-rose-700 border-rose-500/30'
                      : 'bg-hanok-card text-hanok-muted border-hanok-line'
                }`}
              >
                {sourceState === 'failed' || sourceState === 'partial' ? <AlertCircle size={13} /> : <Database size={13} />}
                {reportSourceLabel(sourceState)}
              </span>
              {/* 화면 전체가 추정으로 그려지고 있다는 사실을 맨 위에서도 한 번 말한다
                  (차트·표 옆 배지와 중복이지만, 어느 쪽을 먼저 보든 놓치지 않게). */}
              {estimateInUse && <EstimateBadge label="추정 지표로 표시 중" />}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleExcel}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 border border-emerald-500/30 font-semibold rounded-lg transition-colors text-sm"
              >
                <FileText size={16} /> Excel 내보내기
              </button>
              <button
                onClick={handlePdf}
                className="flex items-center gap-2 px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-700 border border-rose-500/30 font-semibold rounded-lg transition-colors text-sm"
              >
                <Download size={16} /> PDF 다운로드
              </button>
            </div>
          </div>

          {/* 갱신 대기 배너 — 어느 출처가 갱신 중인지, 그리고 **관리자가 무엇을 하면 되는지**
              말한다. 서버 원문은 화면에 적지 않는다(운영 단서는 console.warn 에 남는다).
              판정은 lib/adminApiFailure.ts 의 순수 함수에 있고 테스트가 잠근다. */}
          {anyFailed && (
            <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex-shrink-0">
              <AlertCircle size={20} className="text-rose-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold text-rose-700">일부 지표를 갱신하는 중입니다</p>
                <p className="text-sm text-hanok-muted mt-1">
                  비어 있는 차트·표는 갱신이 끝나는 대로 자동으로 표시됩니다.
                  내보내기(Excel/PDF)도 갱신 후 다시 받아 주세요.
                </p>
                <ul className="mt-3 space-y-3">
                  {failures.map(({ source, notice }) => (
                    <li key={source} className="text-sm">
                      <p className="font-semibold text-hanok-ink">
                        {source} — {notice.title}
                      </p>
                      <p className="text-hanok-muted mt-0.5">{notice.action}</p>
                      <div className="flex items-center gap-3 mt-1.5">
                        {notice.href && (
                          <Link
                            href={notice.href}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep"
                          >
                            <LogIn size={13} /> 관리자 로그인으로 이동
                          </Link>
                        )}
                        {notice.retryable && (
                          <button
                            onClick={reload}
                            disabled={loading}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep disabled:opacity-50 disabled:no-underline"
                          >
                            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 다시 시도
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Charts Row */}
          <div className="grid grid-cols-2 gap-6 min-h-[350px] flex-shrink-0">
            {/* Bar Chart */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-6">
                <BarChart2 className="text-gold-deep" size={20} />
                <h3 className="text-lg font-bold text-hanok-ink">
                  {/* 제목까지 바꾼다 — 단위가 다르기 때문이다. 실측은 (시설,30분)당 재실 추정의
                      **합**(지수)이고, 추정은 0~100% 의 **평균 혼잡도**다. 같은 제목 아래 두면
                      두 막대가 같은 양을 재는 것처럼 읽힌다. */}
                  {estimateInUse ? '요일별 추정 혼잡도 (업종 평균)' : '요일별 관측 혼잡 지수'}
                </h3>
                {estimateInUse && <EstimateBadge />}
              </div>
              <div className="flex-1 w-full h-[250px]">
                {estimateInUse ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={estimateWeekly} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3a2f24" />
                      <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#b8a894', fontSize: 12 }} />
                      {/* 0~100% 고정 축. 실측 지수 차트와 달리 값이 비율이라 축이 데이터에 따라
                          늘었다 줄었다 하면 요일 간 차이가 실제보다 커 보인다. */}
                      <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#b8a894', fontSize: 12 }}
                        domain={[0, 1]}
                        ticks={[0, 0.25, 0.5, 0.75, 1]}
                        tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
                      />
                      <Tooltip
                        cursor={{ fill: '#3a2f24' }}
                        formatter={(value: unknown) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}% (추정)` : '—')}
                        contentStyle={{ borderRadius: '8px', backgroundColor: '#2c241c', border: '1px solid #3a2f24', color: '#e2e8f0' }}
                      />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                      {/* 누적이 아니라 **나란히** 둔다 — 비율은 더할 수 있는 양이 아니다.
                          (쌓으면 400% 짜리 막대가 나오고, 그건 아무 뜻도 없는 숫자다.) */}
                      {CATEGORY_ORDER.map((ko) => (
                        <Bar key={ko} dataKey={ko} fill={CATEGORY_COLOR[ko]} radius={[3, 3, 0, 0]} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                ) : weekly.length === 0 ? (
                  // 빈 자리 안내. 세 가지가 서로 다른 사실이다:
                  //  · 조회 실패 → 무엇을 하면 되는지(재로그인/재시도)까지 말한다.
                  //  · 조회 성공인데 14일 창이 0행 → 실패가 아니다. 마지막 관측이 언제였는지 말한다.
                  //  · 로그는 있는데 집계에 쓸 게 없음 → 기존 '아직 없습니다'.
                  <div className={`flex items-center justify-center h-full text-sm text-center px-4 ${logsStatus === 'failed' ? 'text-rose-700' : 'text-hanok-muted'}`}>
                    {logsStatus === 'failed' && logsFailure ? (
                      <span>
                        <span className="font-semibold">{logsFailure.title}</span>
                        <br />
                        {logsFailure.action}
                      </span>
                    ) : !loading && observationGap ? (
                      <span>
                        {observationGap}
                        {estimateNote && <><br />{estimateNote}</>}
                      </span>
                    ) : (
                      <span>
                        {emptyOrFailedText(
                          loading ? 'loading' : logsStatus,
                          '방문량 지표를 집계하는 중입니다.',
                          '데이터를 불러오는 중...',
                        )}
                        {estimateNote && <><br />{estimateNote}</>}
                      </span>
                    )}
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
              {/* 근거는 차트 **바로 아래**에 둔다 — 화면 위 배너에만 적으면 스크린샷 한 장에서
                  떨어져 나가고, 그 순간 이 막대는 실측처럼 보인다. */}
              {estimateInUse && estimateBasis && (
                <p className="mt-3 text-xs text-hanok-muted leading-relaxed border-t border-dashed border-hanok-line pt-2">
                  {estimateBasis}
                  <br />
                  {estimateMethod}
                </p>
              )}
            </div>

            {/* Area Chart */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-6">
                <TrendingUp className="text-jade" size={20} />
                <h3 className="text-lg font-bold text-hanok-ink">AI 추천 알고리즘 수락 트렌드</h3>
              </div>
              <div className="flex-1 w-full h-[250px]">
                {aiTrend.length === 0 ? (
                  // 관리자 API 미응답('조회 실패')과 추천 이력 부족('아직 없음')을 갈라 말한다.
                  // 실패일 때는 사유가 아니라 **할 일**을 앞세운다(원문 근거는 위 배너에 있다).
                  <div className={`flex flex-col items-center justify-center h-full text-sm text-center px-4 gap-2 ${recsStatus === 'failed' ? 'text-rose-700' : 'text-hanok-muted'}`}>
                    {recsStatus === 'failed' && recsFailure ? (
                      <>
                        <span>
                          <span className="font-semibold">{recsFailure.title}</span>
                          <br />
                          {recsFailure.action}
                        </span>
                        {recsFailure.href && (
                          <Link
                            href={recsFailure.href}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep"
                          >
                            <LogIn size={13} /> 관리자 로그인으로 이동
                          </Link>
                        )}
                        {recsFailure.retryable && (
                          <button
                            onClick={reload}
                            disabled={loading}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep disabled:opacity-50 disabled:no-underline"
                          >
                            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 다시 시도
                          </button>
                        )}
                      </>
                    ) : (
                      emptyOrFailedText(
                        loading ? 'loading' : recsStatus,
                        'AI 추천 수락 지표를 집계하는 중입니다.',
                        '데이터를 불러오는 중...',
                      )
                    )}
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
              <h3 className="text-lg font-bold text-hanok-ink">
                {estimateInUse ? '카테고리별 추정 혼잡도 요약' : '카테고리별 누적 요약 데이터'}
              </h3>
              {estimateInUse && <EstimateBadge />}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-hanok text-hanok-muted text-sm border-b border-hanok-line">
                    <th className="p-4 font-semibold">카테고리</th>
                    {/* 열 이름을 바꾸는 것이 핵심이다 — 값의 단위가 '지수(합)' 에서 '평균 혼잡도(%)'
                        로 바뀌었는데 머리글이 그대로면 그 표는 거짓말이 된다. */}
                    <th className="p-4 font-semibold">
                      {estimateInUse
                        ? `추정 평균 혼잡도 (최근 ${ESTIMATE_SUMMARY_DAYS}일)`
                        : '관측 혼잡 지수 (최근 7일)'}
                    </th>
                    <th className="p-4 font-semibold">
                      {/* 비율의 변화는 '증감률' 이 아니라 **%포인트**다. 50%→60% 를 '+20%' 로 적으면
                          읽는 사람이 혼잡도가 20% 올랐다고 읽는다. */}
                      {estimateInUse ? '전주 대비 (%p)' : '전주 대비 증감률'}
                    </th>
                    <th className="p-4 font-semibold">상태</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {estimateInUse ? (
                    estimateTable.map((row) => (
                      <tr key={row.type} className="border-b border-hanok-line hover:bg-hanok-card transition-colors">
                        <td className="p-4 font-bold text-hanok-ink">{row.label}</td>
                        <td className="p-4 text-hanok-muted">
                          {row.avgCongestion === null
                            ? '—'
                            : `${(row.avgCongestion * 100).toFixed(1)}% (추정)`}
                          {row.dayCount > 0 && (
                            <span className="ml-2 text-xs text-hanok-muted/70">산출 {row.dayCount}일</span>
                          )}
                        </td>
                        <td className="p-4">
                          {/* 직전 주에 추정 표본이 없으면 비교를 **만들지 않는다**(실측 쪽
                              describeGrowth 와 같은 규칙 — 없는 비교는 '—' 다). */}
                          {row.changePoints === null ? (
                            <span className="text-hanok-muted">—</span>
                          ) : (
                            <span className={`font-bold ${row.changePoints < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                              {row.changePoints >= 0 ? '+' : ''}{row.changePoints.toFixed(1)}%p
                            </span>
                          )}
                        </td>
                        <td className="p-4">
                          <span className={`px-2 py-1 rounded-md text-xs font-bold ${
                            row.status === '혼잡' ? 'bg-rose-500/15 text-rose-700' :
                            row.status === '보통' ? 'bg-amber-500/15 text-amber-300' :
                            row.status === '여유' ? 'bg-emerald-500/15 text-emerald-700' :
                            'bg-hanok-card text-hanok-ink'
                          }`}>
                            {row.status ?? '—'}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : table.length === 0 ? (
                    // 빈 상태 행: 요약 데이터 없음 / 조회 실패(같은 혼잡 로그 출처)
                    <tr>
                      <td colSpan={4} className={`p-8 text-center ${logsStatus === 'failed' ? 'text-rose-700' : 'text-hanok-muted'}`}>
                        {logsStatus === 'failed' && logsFailure ? (
                          <span>
                            <span className="font-semibold">{logsFailure.title}</span> — {logsFailure.action}
                          </span>
                        ) : !loading && observationGap ? (
                          <span>
                            {observationGap}
                            {estimateNote && <><br />{estimateNote}</>}
                          </span>
                        ) : (
                          <span>
                            {emptyOrFailedText(
                              loading ? 'loading' : logsStatus,
                              '요약 지표를 집계하는 중입니다.',
                              '데이터를 불러오는 중...',
                            )}
                            {estimateNote && <><br />{estimateNote}</>}
                          </span>
                        )}
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
                          row.status === '급증' ? 'bg-rose-500/15 text-rose-700' :
                          row.status === '활발' ? 'bg-gold/15 text-gold-deep' :
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
            {/* '총 이용량(명)' 칸이 왜 없는지. 추정치에는 인원 수가 없고, 0 으로 채우면
                없는 관측을 만들어 내는 것이다 — 이 화면이 예전에 하던 바로 그 실수다. */}
            {estimateInUse && (
              <div className="px-6 py-4 border-t border-hanok-line text-xs text-hanok-muted leading-relaxed">
                <p>{ESTIMATE_NO_HEADCOUNT_NOTE}</p>
                {estimateBasis && <p className="mt-1">{estimateBasis}</p>}
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  );
}

/** '추정' 배지 — 이 화면 안에서 한 번만 정의하고 차트·표가 같은 모양을 쓴다.
 *  파선 테두리는 실측 배지(실선)와 눈으로 갈라 보라는 신호다. */
function EstimateBadge({ label }: { label?: string }) {
  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-dashed border-indigo-400/60 bg-indigo-500/10 text-indigo-700 text-xs font-bold"
      title="공영주차 실측(경주 ITS)과 관광공사 집중률로 산출한 추정 지표입니다."
    >
      {label ?? ESTIMATE_BADGE}
    </span>
  );
}
