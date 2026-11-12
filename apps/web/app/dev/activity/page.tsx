'use client';

// 이용 기록(행동 로그) — 개발자 전용.
//
// 공모전 심사위원이 서비스를 실제로 써 봤는지(심사 계정 openapi@naver.com=사장님 · openapi@gmail.com=관제)를
// 기기·세션 단위로 확인하고 CSV 로 남기는 화면이다. 브라우저가 public.action_logs 에 쌓은 행을
// Supabase RPC 두 개(action_log_devices · action_log_rows)로 읽는다.
//
// 권한: 프런트 관문은 /dev 와 같은 canEnterDevConsole(UX 용)이고, 실제 차단은 DB 함수가 한다 —
// users.role='developer' 가 아니면 42501. 심사 계정은 admin 이라 여기를 볼 수 없어야 한다(그래서 admin 도 막힌다).
//
// 화면 문구는 /dev 처럼 한국어만 쓴다(개발자 콘솔은 i18n 대상이 아니다).
// 규칙(KST 표기·내용 요약·CSV 열·심사 계정 판정·키셋)은 lib/actionLogViewer.ts 에 있고 테스트로 잠겨 있다.

import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Download,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import { useAccount, canEnterDevConsole } from '@/lib/account';
import {
  ACTION_LOG_EVENTS,
  CSV_BOM,
  DEVICE_CSV_COLUMNS,
  DEVICE_LIST_MAX,
  JUDGE_CONSOLE_LABELS,
  KST_DAY_MAX,
  KST_DAY_MIN,
  RANGE_PRESETS,
  ROW_CSV_COLUMNS,
  accountLabel,
  actionLogErrorText,
  buildCsv,
  clockDiffSeconds,
  collectKeyset,
  csvFileName,
  csvHeader,
  csvRows,
  deviceHasJudge,
  deviceRequestLimit,
  eventLabel,
  formatClockDiff,
  formatDuration,
  formatKst,
  groupBySession,
  heartbeatSeconds,
  ipChainText,
  isKstDay,
  isRetryableActionLogError,
  judgeConsoleForEmail,
  judgeUsage,
  kstDay,
  latestLastAt,
  normalizeDevices,
  normalizeRange,
  normalizeRows,
  parseTimestamp,
  pathLabel,
  presetRange,
  rangeDayCount,
  rangeToIso,
  referrerLabel,
  rowAccountLabel,
  shortId,
  shortUserAgent,
  snapshotUpperBound,
  summarizeProps,
  toActionLogError,
  trimDeviceList,
  type ActionLogDevice,
  type ActionLogError,
  type ActionLogRow,
  type KstDayRange,
  type RangePreset,
  type SessionGroup,
} from '@/lib/actionLogViewer';

/** 기기 목록 한도. 처음엔 300, 잘렸으면 상한(1000)까지 늘릴 수 있다. */
const DEVICE_LIMIT_DEFAULT = 300;
/** 타임라인 한 쪽 · 한 번에 자동으로 모으는 양. 넘으면 '더 불러오기'. */
const TIMELINE_PAGE = 2000;
const TIMELINE_BATCH = 6000;
/**
 * CSV 내보내기 첫 쪽 크기(RPC 상한 5000)와 안전 상한. 서버가 더 짧게 주면 collectKeyset 이 그 크기를 배운다.
 * 상한·오류로 다 못 받은 파일은 이름 끝에 _partial 이 붙는다.
 */
const EXPORT_PAGE = 5000;
const EXPORT_ROW_CAP = 300_000;

interface IsoRange {
  from: string;
  to: string;
}

const fmt = (n: number) => n.toLocaleString('ko-KR');

// =========================================================================
// RPC — supabase-js 는 대개 던지지 않고 error 를 돌려준다. 둘 다 ActionLogError 로 모은다.
// =========================================================================

async function fetchDevices(range: IsoRange, accountsOnly: boolean, limit: number): Promise<ActionLogDevice[]> {
  let response;
  try {
    response = await createPublicClient().rpc('action_log_devices', {
      p_from: range.from,
      p_to: range.to,
      p_accounts_only: accountsOnly,
      p_limit: limit,
    });
  } catch (err) {
    throw toActionLogError(err);
  }
  if (response.error) throw toActionLogError(response.error, response.status);
  return normalizeDevices(response.data);
}

async function fetchRows(
  range: IsoRange,
  deviceId: string | null,
  afterId: number,
  limit: number,
): Promise<ActionLogRow[]> {
  let response;
  try {
    response = await createPublicClient().rpc('action_log_rows', {
      p_from: range.from,
      p_to: range.to,
      p_device_id: deviceId,
      p_after_id: afterId,
      p_limit: limit,
    });
  } catch (err) {
    throw toActionLogError(err);
  }
  if (response.error) throw toActionLogError(response.error, response.status);
  return normalizeRows(response.data);
}

// 지금 시각은 렌더 밖(초기값·클릭·내려받기 시작)에서만 읽는다.

/** 빠른 기간을 지금 시각 기준으로. */
function presetRangeNow(key: RangePreset): KstDayRange {
  return presetRange(key, Date.now());
}

/** 내려받기의 끝 시각 — 시작한 순간에 고정하되, 서버가 알려 준 마지막 시각 앞으로는 자르지 않는다(snapshotUpperBound 주석). */
function exportSnapshotTo(toIso: string, floorIso: string | null): string {
  return snapshotUpperBound(toIso, Date.now(), { floorIso });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 바로 회수하면 일부 브라우저가 내려받기를 시작하기 전에 URL 이 사라진다.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// =========================================================================
// 관문 — /dev 와 같은 방식(개발자가 아니면 /main 으로).
// =========================================================================

export default function DevActivityPage() {
  const router = useRouter();
  const { account, status } = useAccount();

  useEffect(() => {
    if (status === 'loading') return;
    if (!canEnterDevConsole(account)) router.replace('/main');
  }, [status, account, router]);

  if (status === 'loading' || !canEnterDevConsole(account)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-hanji text-muk-soft">
        {status === 'loading' ? (
          <Loader2 className="animate-spin" size={20} />
        ) : (
          <div className="flex items-center gap-2">
            <ShieldAlert size={18} />
            <span className="text-sm">개발자 전용 화면입니다.</span>
          </div>
        )}
      </div>
    );
  }

  return <ActivityConsole />;
}

// =========================================================================
// 본문
// =========================================================================

/**
 * 행 CSV 내보내기 한 건. 쪽마다 Blob 조각으로 쌓아(300k 행도 문자열 하나로 들지 않게) 실패하면 마지막 id 에서
 * 이어 받거나 받은 데까지 저장할 수 있게 들고 있는다.
 */
interface ExportJob {
  deviceId: string | null;
  label: string;
  /** 파일 이름에 쓸 KST 날짜(시작할 때의 기간). */
  range: KstDayRange;
  /** RPC 인자 — 끝은 시작한 순간으로 고정했다. */
  iso: IsoRange;
  expected: number | null;
  parts: BlobPart[];
  loaded: number;
  lastId: number;
}

type ExportState =
  | { phase: 'idle' }
  | { phase: 'running'; deviceId: string | null; label: string; loaded: number; expected: number | null }
  | {
      phase: 'done';
      deviceId: string | null;
      label: string;
      loaded: number;
      /** 다 못 받은 이유 — cap=안전 상한, error=오류 뒤 받은 데까지 저장. */
      partial: 'cap' | 'error' | null;
      fileName: string;
    }
  | { phase: 'error'; deviceId: string | null; label: string; loaded: number; title: string; detail: string | null }
  /** 중지했지만 받은 행이 있다 — 이어 받거나 받은 데까지 저장할 수 있다. */
  | { phase: 'stopped'; deviceId: string | null; label: string; loaded: number };

interface DevicesState {
  key: string;
  devices: ActionLogDevice[];
  truncated: boolean;
  error: ActionLogError | null;
}

const PILL =
  'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40';
const PILL_IDLE = 'border-line bg-white text-muk-soft hover:bg-hanji hover:text-muk';
const PILL_ACTIVE = 'border-gold bg-gold/15 text-muk';
const DATE_INPUT =
  'min-h-11 rounded-xl border border-line bg-hanji px-3 text-sm text-muk focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40';

function ActivityConsole() {
  // 기본 기간은 최근 7일(오늘 포함, KST 달력). 이 컴포넌트는 관문을 통과한 브라우저에서만 그려지므로
  // 지금 시각을 여기서 읽어도 프리렌더 HTML 과 어긋나지 않는다.
  const [range, setRange] = useState<KstDayRange>(() => presetRangeNow('7d'));
  const [preset, setPreset] = useState<RangePreset | null>('7d');
  const [accountsOnly, setAccountsOnly] = useState(false);
  const [deviceLimit, setDeviceLimit] = useState(DEVICE_LIMIT_DEFAULT);
  const [nonce, setNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [devicesState, setDevicesState] = useState<DevicesState | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const exportJobRef = useRef<ExportJob | null>(null);
  const exportBusyRef = useRef(false);
  const exportCancelRef = useRef(false);
  // 이 화면이 살아 있는 동안의 표식 — 나가면 진행 중인 내려받기를 멈춘다(다른 화면에서 파일이 떨어지지 않게).
  const lifeRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const timelineRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const life = { cancelled: false };
    lifeRef.current = life;
    return () => {
      life.cancelled = true;
    };
  }, []);

  const iso = useMemo(() => rangeToIso(range), [range]);
  const devicesKey = `${iso.from}|${iso.to}|${accountsOnly}|${deviceLimit}|${nonce}`;

  // 조건이 바뀌면 다시 읽는다. '읽는 중' 은 상태로 두지 않고 key 비교로 얻는다(이펙트 안 동기 setState 없음).
  // 한 대 더 물어(deviceRequestLimit) 목록이 정말 잘렸는지 안다.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await fetchDevices(iso, accountsOnly, deviceRequestLimit(deviceLimit));
        if (alive) setDevicesState({ key: devicesKey, ...trimDeviceList(list, deviceLimit), error: null });
      } catch (err) {
        if (alive) setDevicesState({ key: devicesKey, devices: [], truncated: false, error: toActionLogError(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [devicesKey, iso, accountsOnly, deviceLimit]);

  const devicesLoading = devicesState?.key !== devicesKey;
  const devices = useMemo(() => devicesState?.devices ?? [], [devicesState]);
  const devicesError = devicesLoading ? null : (devicesState?.error ?? null);
  const truncated = !devicesLoading && !devicesError && (devicesState?.truncated ?? false);
  const selectedDevice = useMemo(
    () => devices.find((d) => d.device_id === selectedId) ?? null,
    [devices, selectedId],
  );

  const applyPreset = (key: RangePreset) => {
    setRange(presetRangeNow(key));
    setPreset(key);
  };

  const changeDay = (edge: 'fromDay' | 'toDay', value: string) => {
    // 날짜 칸을 지우면 '' 가 온다 — 마지막 유효값을 지킨다.
    if (!isKstDay(value)) return;
    setRange((prev) => normalizeRange({ ...prev, [edge]: value }));
    setPreset(null);
  };

  const refresh = () => {
    // 빠른 기간은 '오늘' 기준이라, 자정을 넘겨 새로 고치면 날짜도 다시 잡아야 오늘 기록이 빠지지 않는다.
    if (preset) setRange(presetRangeNow(preset));
    setNonce((n) => n + 1);
  };

  // 표(memo)에 넘기는 콜백이라 고정한다 — 내려받기 진행률이 바뀔 때마다 기기 수백 줄을 다시 그리지 않게.
  const selectDevice = useCallback((deviceId: string) => {
    setSelectedId(deviceId);
    window.requestAnimationFrame(() => {
      timelineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const exportDevices = () => {
    if (devicesLoading || devices.length === 0) return;
    const fileName = csvFileName(range, { kind: 'devices', accountsOnly, partial: truncated });
    downloadBlob(new Blob([buildCsv(DEVICE_CSV_COLUMNS, devices)], { type: 'text/csv;charset=utf-8' }), fileName);
    toast.success(`기기 ${fmt(devices.length)}대를 내려받았어요.`);
  };

  const saveExport = (job: ExportJob, partial: 'cap' | 'error' | null) => {
    const fileName = csvFileName(job.range, { deviceId: job.deviceId, partial: partial !== null });
    downloadBlob(new Blob(job.parts, { type: 'text/csv;charset=utf-8' }), fileName);
    exportJobRef.current = null;
    setExportState({ phase: 'done', deviceId: job.deviceId, label: job.label, loaded: job.loaded, partial, fileName });
    if (partial) toast.warning(`${job.label} ${fmt(job.loaded)}건만 담았어요(파일 이름 끝 _partial).`);
    else toast.success(`${job.label} ${fmt(job.loaded)}건을 내려받았어요.`);
  };

  /** 처음부터든 이어서든 job 을 끝까지(또는 상한까지) 받는다. */
  const runExport = async (job: ExportJob) => {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    exportCancelRef.current = false;
    exportJobRef.current = job;
    const life = lifeRef.current;
    const progress = (): ExportState => ({
      phase: 'running',
      deviceId: job.deviceId,
      label: job.label,
      loaded: job.loaded,
      expected: job.expected,
    });
    setExportState(progress());
    try {
      const result = await collectKeyset<ActionLogRow>({
        fetchPage: (afterId, limit) => fetchRows(job.iso, job.deviceId, afterId, limit),
        afterId: job.lastId,
        pageSize: EXPORT_PAGE,
        maxRows: EXPORT_ROW_CAP - job.loaded,
        isCancelled: () => exportCancelRef.current || life.cancelled,
        isRetryable: isRetryableActionLogError,
        onPage: (rows) => {
          job.parts.push(new Blob([csvRows(ROW_CSV_COLUMNS, rows)]));
          job.loaded += rows.length;
          for (const row of rows) if (row.id > job.lastId) job.lastId = row.id;
          setExportState(progress());
        },
      });
      if (life.cancelled) return;
      if (result.reason === 'cancelled') {
        // 받은 행이 있으면(앞서 실패했다 이어 받던 것 포함) 버리지 않는다 — 이어 받기·받은 데까지 저장을 남긴다.
        if (job.loaded > 0) {
          setExportState({ phase: 'stopped', deviceId: job.deviceId, label: job.label, loaded: job.loaded });
        } else {
          exportJobRef.current = null;
          setExportState({ phase: 'idle' });
        }
        toast('내려받기를 멈췄어요.');
        return;
      }
      saveExport(job, result.reason === 'cap' ? 'cap' : null);
    } catch (err) {
      if (life.cancelled) return;
      // job 은 그대로 둔다 — '이어서 받기' 가 마지막 id 에서, '받은 데까지 저장' 이 지금까지의 조각으로 이어 간다.
      const { title, detail } = actionLogErrorText(toActionLogError(err));
      setExportState({ phase: 'error', deviceId: job.deviceId, label: job.label, loaded: job.loaded, title, detail });
      toast.error(`${job.label}을 받지 못했어요.`);
    } finally {
      exportBusyRef.current = false;
    }
  };

  /** deviceId 가 null 이면 기간 전체(모든 기기). */
  const startExport = (deviceId: string | null) => {
    if (exportBusyRef.current) return;
    // 실패·중지로 남은 작업(이어 받거나 저장할 수 있는 행)을 말없이 덮어쓰지 않는다.
    const pending = exportJobRef.current;
    if (
      pending &&
      pending.loaded > 0 &&
      !window.confirm(`받다 만 ${pending.label} ${fmt(pending.loaded)}건이 있어요. 버리고 새로 받을까요?`)
    ) {
      return;
    }
    const listComplete = !devicesLoading && !devicesError && !accountsOnly && !truncated;
    const expected = deviceId
      ? (devices.find((d) => d.device_id === deviceId)?.events ?? null)
      : listComplete
        ? devices.reduce((sum, d) => sum + d.events, 0)
        : null;
    // 서버가 알려 준 마지막 시각 — 이 브라우저 시계가 늦어도 그보다 앞에서 자르지 않는다.
    const listFresh = !devicesLoading && !devicesError;
    const floorIso = listFresh
      ? latestLastAt(deviceId ? devices.filter((d) => d.device_id === deviceId) : devices)
      : null;
    void runExport({
      deviceId,
      label: deviceId ? `기기 ${shortId(deviceId)} 기록` : '기간 전체 기록',
      range,
      iso: { from: iso.from, to: exportSnapshotTo(iso.to, floorIso) },
      expected,
      parts: [CSV_BOM + csvHeader(ROW_CSV_COLUMNS)],
      loaded: 0,
      lastId: 0,
    });
  };

  const resumeExport = () => {
    const job = exportJobRef.current;
    if (job) void runExport(job);
  };

  const savePartialExport = () => {
    const job = exportJobRef.current;
    if (job && job.loaded > 0 && !exportBusyRef.current) saveExport(job, 'error');
  };

  const dismissExport = () => {
    if (exportBusyRef.current) return;
    exportJobRef.current = null;
    setExportState({ phase: 'idle' });
  };

  const exporting = exportState.phase === 'running';
  const exportStatus = (
    <ExportStatus
      state={exportState}
      onCancel={() => {
        exportCancelRef.current = true;
      }}
      onDismiss={dismissExport}
      onResume={resumeExport}
      onSavePartial={savePartialExport}
    />
  );

  return (
    <main className="min-h-screen min-w-0 bg-hanji px-4 py-7 font-sans text-muk sm:px-5">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-serif text-2xl font-bold tracking-tight">이용 기록(행동 로그)</h1>
            <p className="mt-1 text-sm text-muk-soft">
              기기·세션별로 언제 무엇을 했는지 봅니다. 심사 계정이 서비스를 실제로 썼는지 확인하는 용도예요.
            </p>
          </div>
          <Link
            href="/dev"
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-white px-3.5 text-sm font-medium text-muk-soft transition-colors hover:text-muk"
          >
            <ArrowLeft size={15} /> 개발자 콘솔
          </Link>
        </header>

        <p className="mb-5 flex items-start gap-2 rounded-2xl border border-line bg-white px-3.5 py-3 text-[12px] leading-relaxed text-muk-soft">
          <Info size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            기록은 쌓이기만 하고 고치거나 지울 수 없으며, 1년 동안 보관돼요. 이 화면은 연 것만 남고, 여기서 누르거나
            내려받은 것은 기록되지 않아요. 시각은 모두 한국 시간(KST)이고 서버가 받은 시각 기준이에요.
            <span className="mt-1 block">
              증빙은 <b className="font-semibold text-jade">서버가 찍은 값</b>(받은 시각 received_at · 계정 · IP ·
              브라우저 UA)으로 읽으세요. 브라우저 시각(occurred_at) · 화면 · 내용 · seq 는{' '}
              <b className="font-semibold text-muk">브라우저가 보낸 값</b>이라 기기 시계가 틀리면 같이 틀려요. 못 보낸
              기록은 다음 방문 때 다시 보내므로 서버에 늦게 들어올 수 있어, 세션 안은 seq(브라우저 순번) 순으로 보여요.
              CSV 열 이름도 server_ · browser_ 로 나뉘어요.
            </span>
          </span>
        </p>

        {/* 기간 · 필터 · 내보내기 */}
        <section aria-label="기간과 내려받기" className="mb-5 rounded-3xl border border-line bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="빠른 기간" className="flex gap-1.5">
              {RANGE_PRESETS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={preset === item.key}
                  onClick={() => applyPreset(item.key)}
                  className={`${PILL} ${preset === item.key ? PILL_ACTIVE : PILL_IDLE}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <label className="sr-only" htmlFor="activity-from">
                시작일
              </label>
              <input
                id="activity-from"
                type="date"
                value={range.fromDay}
                min={KST_DAY_MIN}
                max={range.toDay}
                onChange={(e) => changeDay('fromDay', e.target.value)}
                className={DATE_INPUT}
              />
              <span className="text-muk-soft" aria-hidden>
                ~
              </span>
              <label className="sr-only" htmlFor="activity-to">
                종료일
              </label>
              <input
                id="activity-to"
                type="date"
                value={range.toDay}
                min={range.fromDay}
                max={KST_DAY_MAX}
                onChange={(e) => changeDay('toDay', e.target.value)}
                className={DATE_INPUT}
              />
              <span className="text-[12px] text-muk-soft">KST · {rangeDayCount(range)}일</span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-white px-4 text-sm font-semibold text-muk">
              <input
                type="checkbox"
                checked={accountsOnly}
                onChange={(e) => setAccountsOnly(e.target.checked)}
                className="h-4 w-4 accent-gold"
              />
              계정으로 로그인한 기기만
            </label>
            <button type="button" onClick={refresh} className={`${PILL} ${PILL_IDLE}`}>
              <RefreshCw size={15} className={devicesLoading ? 'animate-spin' : ''} aria-hidden /> 새로고침
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <span className="text-[12px] font-semibold text-muk-soft">CSV 내려받기</span>
            <button
              type="button"
              onClick={exportDevices}
              disabled={devicesLoading || devices.length === 0}
              className={`${PILL} ${PILL_IDLE}`}
            >
              <Download size={15} aria-hidden /> 기기 목록
            </button>
            <button
              type="button"
              onClick={() => startExport(null)}
              disabled={exporting}
              className={`${PILL} ${PILL_IDLE}`}
            >
              <Download size={15} aria-hidden /> 기간 전체 기록
            </button>
          </div>
          {exportStatus}
        </section>

        {/* 기기 목록 */}
        <section aria-label="기기 목록" className="mb-5 rounded-3xl border border-line bg-white p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-bold">
              기기 <span className="font-mono">{devicesState ? fmt(devices.length) : '–'}</span>대
              {devicesLoading && devicesState && (
                <Loader2 size={14} className="ml-2 inline animate-spin text-muk-soft" aria-label="불러오는 중" />
              )}
            </h2>
            <p className="text-[12px] text-muk-soft">
              {range.fromDay} ~ {range.toDay} · 마지막 활동이 최근인 순
              {accountsOnly ? ' · 로그인한 기기만' : ''}
            </p>
          </div>

          {devicesError ? (
            <ErrorNotice error={devicesError} onRetry={refresh} />
          ) : !devicesState ? (
            <Loader2 size={18} className="mx-auto my-8 animate-spin text-muk-soft" aria-label="불러오는 중" />
          ) : (
            <>
              <JudgeSummary devices={devices} truncated={truncated} accountsOnly={accountsOnly} />
              {devices.length === 0 ? (
                <p className="py-8 text-center text-sm text-muk-soft">
                  {devicesLoading ? '불러오는 중이에요…' : '이 기간에 기록된 기기가 없어요.'}
                </p>
              ) : (
                <DeviceTable
                  devices={devices}
                  selectedId={selectedId}
                  stale={devicesLoading}
                  onSelect={selectDevice}
                />
              )}
              {truncated && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muk-soft">
                  <span>최근에 활동한 {fmt(deviceLimit)}대까지만 보여요.</span>
                  {deviceLimit < DEVICE_LIST_MAX && (
                    <button
                      type="button"
                      onClick={() => setDeviceLimit(DEVICE_LIST_MAX)}
                      className={`${PILL} ${PILL_IDLE}`}
                    >
                      {fmt(DEVICE_LIST_MAX)}대까지 보기
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* 고른 기기의 타임라인 */}
        <section
          ref={timelineRef}
          aria-label="기기 기록"
          className="scroll-mt-4 rounded-3xl border border-line bg-white p-4 sm:p-5"
        >
          {selectedId ? (
            <Timeline
              key={`${selectedId}|${iso.from}|${iso.to}|${nonce}`}
              deviceId={selectedId}
              from={iso.from}
              to={iso.to}
              device={selectedDevice}
              exportBusy={exporting}
              onExport={() => startExport(selectedId)}
              onClose={() => setSelectedId(null)}
              // '이 기기 CSV' 는 화면 아래쪽에 있다 — 진행·결과를 누른 자리에서도 보이게 한 번 더 그린다.
              statusSlot={exportState.phase !== 'idle' && exportState.deviceId === selectedId ? exportStatus : null}
            />
          ) : (
            <p className="py-6 text-center text-sm text-muk-soft">
              위 표에서 기기를 고르면 그 기기의 기록이 세션별로(세션 안은 브라우저 순번 seq 순) 보여요.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

// =========================================================================
// 내려받기 진행 · 결과
// =========================================================================

function ExportStatus({
  state,
  onCancel,
  onDismiss,
  onResume,
  onSavePartial,
}: {
  state: ExportState;
  onCancel: () => void;
  onDismiss: () => void;
  onResume: () => void;
  onSavePartial: () => void;
}) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    const pct =
      state.expected && state.expected > 0 ? Math.min(100, Math.round((state.loaded / state.expected) * 100)) : null;
    return (
      <div className="mt-3 rounded-2xl border border-line bg-hanji px-3.5 py-2.5 text-[12px]" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-muk">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {state.label} 받는 중 · {fmt(state.loaded)}건
            {state.expected ? ` / 약 ${fmt(state.expected)}건` : ''}
          </span>
          <button type="button" onClick={onCancel} className={`${PILL} ${PILL_IDLE}`}>
            중지
          </button>
        </div>
        {pct !== null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
            <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-muk-soft">
          {fmt(EXPORT_ROW_CAP)}건이 넘으면 거기서 멈추고 그때까지 받은 것만 저장해요. 받기 시작하기 약 10초 전까지 서버에
          들어온 기록만 담아요(그 뒤 기록은 다시 받으면 들어가요).
        </p>
      </div>
    );
  }

  const warn = state.phase === 'error' || (state.phase === 'done' && state.partial !== null);
  // 실패·중지 뒤에 남은 행 — 이어 받거나(마지막 id 다음부터) 받은 데까지 저장한다.
  const leftover =
    state.phase === 'error' || state.phase === 'stopped' ? (
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onResume} className={`${PILL} ${PILL_IDLE}`}>
          <RefreshCw size={14} aria-hidden />{' '}
          {state.loaded > 0 ? `이어서 받기(${fmt(state.loaded)}건 다음부터)` : '다시 시도'}
        </button>
        {state.loaded > 0 && (
          <button type="button" onClick={onSavePartial} className={`${PILL} ${PILL_IDLE}`}>
            <Download size={14} aria-hidden /> 받은 {fmt(state.loaded)}건만 저장
          </button>
        )}
      </div>
    ) : null;
  return (
    <div
      className={`mt-3 flex items-start justify-between gap-2 rounded-2xl border px-3.5 py-2.5 text-[12px] ${
        warn
          ? 'border-terracotta/40 bg-terracotta/5'
          : state.phase === 'stopped'
            ? 'border-line bg-hanji'
            : 'border-jade/40 bg-jade/10'
      }`}
      aria-live="polite"
    >
      <div className="min-w-0 leading-relaxed">
        {state.phase === 'done' ? (
          <>
            <p className="font-semibold text-muk">
              {state.label} {fmt(state.loaded)}건을 내려받았어요.
            </p>
            <p className="break-all font-mono text-[11px] text-muk-soft">{state.fileName}</p>
            {state.partial === 'cap' && (
              <p className="mt-1 font-semibold text-terracotta">
                {fmt(EXPORT_ROW_CAP)}건 상한에서 멈춰 뒷부분이 빠졌을 수 있어요(파일 이름 끝 _partial). 기간을 나눠
                다시 받으세요.
              </p>
            )}
            {state.partial === 'error' && (
              <p className="mt-1 font-semibold text-terracotta">
                오류로 멈춘 데까지만 담았어요(파일 이름 끝 _partial).
              </p>
            )}
          </>
        ) : state.phase === 'stopped' ? (
          <>
            <p className="font-semibold text-muk">
              {state.label} 받기를 멈췄어요 — 지금까지 {fmt(state.loaded)}건.
            </p>
            {leftover}
          </>
        ) : (
          <>
            <p className="font-semibold text-terracotta">
              {state.label}을 받지 못했어요 — {state.title}
            </p>
            {state.detail && <p className="break-words text-muk-soft">{state.detail}</p>}
            {leftover}
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="알림 닫기"
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muk-soft hover:text-muk"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function ErrorNotice({ error, onRetry }: { error: ActionLogError; onRetry: () => void }) {
  const { title, detail } = actionLogErrorText(error);
  return (
    <div role="alert" className="rounded-2xl border border-terracotta/40 bg-terracotta/5 px-3.5 py-3">
      <p className="flex items-start gap-1.5 text-sm font-semibold text-terracotta">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
        {title}
      </p>
      {detail && <p className="mt-1 break-words text-[12px] leading-relaxed text-muk-soft">{detail}</p>}
      <button type="button" onClick={onRetry} className={`mt-2 ${PILL} ${PILL_IDLE}`}>
        <RefreshCw size={14} aria-hidden /> 다시 시도
      </button>
    </div>
  );
}

// =========================================================================
// 심사 계정 요약 · 기기 표
// =========================================================================

function JudgeBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-gold/60 bg-gold/20 px-2 py-0.5 text-[11px] font-bold text-gold-deep">
      심사 계정
    </span>
  );
}

/** 심사 계정 두 개가 이 목록에서 쓰였는가 — 이 화면을 여는 가장 흔한 이유라 표 위에 바로 답한다. */
function JudgeSummary({
  devices,
  truncated,
  accountsOnly,
}: {
  devices: ActionLogDevice[];
  truncated: boolean;
  accountsOnly: boolean;
}) {
  const usage = useMemo(() => judgeUsage(devices), [devices]);
  return (
    <div className="mb-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {usage.map((item) => (
          <div
            key={item.console}
            className={`rounded-2xl border px-3.5 py-3 ${item.devices > 0 ? 'border-gold/50 bg-gold/10' : 'border-line bg-hanji'}`}
          >
            <p className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-muk">
              <JudgeBadge />
              {JUDGE_CONSOLE_LABELS[item.console]}
              <span className="break-all font-mono font-normal text-muk-soft">{item.email}</span>
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-muk-soft">
              {item.devices > 0 ? (
                <>
                  이 계정으로 로그인한 기기 <span className="font-semibold text-muk">{fmt(item.devices)}</span>대 · 그
                  기기들의 기록 {formatKst(item.firstAt, 'minute') || '—'} ~ {formatKst(item.lastAt, 'minute') || '—'} ·
                  이벤트 {fmt(item.events)}건
                  {/* 기기 단위 값이라 같은 기기의 로그인 전·다른 계정 행동이 섞인다 — 계정 시각으로 읽히지 않게 적는다. */}
                  <span className="block text-[11px]">로그인 전·다른 계정 행동도 섞인 기기 단위 값이에요.</span>
                </>
              ) : (
                '이 목록에는 이 계정으로 로그인한 기기가 없어요.'
              )}
            </p>
          </div>
        ))}
      </div>
      {truncated && !accountsOnly && (
        <p className="mt-2 text-[11px] leading-relaxed text-muk-soft">
          목록이 한도에 닿아 오래된 기기가 빠졌어요. ‘계정으로 로그인한 기기만’을 켜면 심사 계정 기기를 더 빠짐없이 셀
          수 있어요.
        </p>
      )}
    </div>
  );
}

const TH = 'sticky top-0 z-10 whitespace-nowrap bg-hanji px-2.5 py-2.5 font-semibold';
const TD = 'px-2.5 py-2';
const NUM = `${TD} text-right font-mono tabular-nums`;

/** memo — 내려받기 진행률처럼 표와 상관없는 상태가 바뀔 때 수백 줄을 다시 그리지 않는다. */
const DeviceTable = memo(function DeviceTable({
  devices,
  selectedId,
  stale,
  onSelect,
}: {
  devices: ActionLogDevice[];
  selectedId: string | null;
  stale: boolean;
  onSelect: (deviceId: string) => void;
}) {
  return (
    // 세로·가로 모두 이 상자 안에서 스크롤한다 — 페이지가 옆으로 밀리지 않고, 기기가 수백 대여도
    // 아래 타임라인이 멀어지지 않는다. 머리줄은 sticky 라 스크롤해도 보인다.
    <div className={`max-h-[70vh] overflow-auto rounded-2xl border border-line ${stale ? 'opacity-60' : ''}`}>
      <table className="w-full min-w-[1180px] border-collapse text-left text-[12px]">
        <caption className="sr-only">기기별 이용 요약</caption>
        <thead className="text-[11px] text-muk-soft">
          <tr>
            <th scope="col" className={TH}>기기</th>
            <th scope="col" className={TH}>처음 → 마지막 (KST)</th>
            <th scope="col" className={`${TH} text-right`}>세션</th>
            <th scope="col" className={`${TH} text-right`}>이벤트</th>
            <th scope="col" className={`${TH} text-right`}>화면</th>
            <th scope="col" className={`${TH} text-right`}>클릭</th>
            <th
              scope="col"
              className={`${TH} text-right`}
              title="하트비트 수 × 30초(대략). 하트비트는 탭이 보이는 동안 30초마다(입력이 10분 넘게 없으면 5분마다) 오므로 조작한 시간이 아니라 화면을 열어 둔 시간에 가깝다. 조작 시간은 기기 기록의 세션 요약에 있다."
            >
              열어 둔 시간
            </th>
            <th scope="col" className={TH}>계정</th>
            <th scope="col" className={TH}>IP</th>
            <th scope="col" className={TH}>브라우저</th>
            <th scope="col" className={TH}>첫 화면 · 유입</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <DeviceRow
              key={device.device_id}
              device={device}
              selected={device.device_id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});

function DeviceRow({
  device,
  selected,
  onSelect,
}: {
  device: ActionLogDevice;
  selected: boolean;
  onSelect: (deviceId: string) => void;
}) {
  const judge = deviceHasJudge(device);
  const shownIps = device.ips.slice(0, 2);
  return (
    <tr className={`border-t border-line align-top ${selected ? 'bg-jade/10' : judge ? 'bg-gold/10' : ''}`}>
      <td className="px-2 py-1.5">
        <button
          type="button"
          onClick={() => onSelect(device.device_id)}
          aria-pressed={selected}
          title={device.device_id}
          className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-2.5 font-mono text-[12px] font-semibold transition-colors ${
            selected ? 'border-jade/50 bg-jade/15 text-jade' : 'border-line bg-white text-muk hover:bg-hanji'
          }`}
        >
          {shortId(device.device_id)}
          <ChevronRight size={14} aria-hidden />
        </button>
      </td>
      <td className={`${TD} whitespace-nowrap font-mono tabular-nums`}>
        <span className="block">{formatKst(device.first_at, 'minute') || '—'}</span>
        <span className="block text-muk-soft">→ {formatKst(device.last_at, 'minute') || '—'}</span>
      </td>
      <td className={NUM}>{fmt(device.sessions)}</td>
      <td className={NUM}>{fmt(device.events)}</td>
      <td className={NUM}>{fmt(device.page_views)}</td>
      <td className={NUM}>{fmt(device.clicks)}</td>
      <td className={`${NUM} whitespace-nowrap`}>{formatDuration(heartbeatSeconds(device.heartbeats))}</td>
      <td className={`${TD} min-w-[220px]`}>
        {device.accounts.length === 0 ? (
          <span className="text-muk-soft">로그인 안 함</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {device.accounts.map((account, i) => (
              <li key={`${account.user_id ?? account.email ?? ''}-${i}`} className="flex flex-wrap items-center gap-1.5">
                {judgeConsoleForEmail(account.email) && <JudgeBadge />}
                <span className="break-all">{accountLabel(account)}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={`${TD} whitespace-nowrap font-mono`} title={device.ips.join(', ')}>
        {shownIps.length === 0
          ? '—'
          : shownIps.map((ip) => (
              <span key={ip} className="block">
                {ip}
              </span>
            ))}
        {device.ips.length > shownIps.length && (
          <span className="block text-muk-soft">+{device.ips.length - shownIps.length}</span>
        )}
      </td>
      <td className={`${TD} whitespace-nowrap`} title={device.user_agent ?? ''}>
        {shortUserAgent(device.user_agent) || '—'}
      </td>
      <td className={`${TD} max-w-[220px]`}>
        <span className="block truncate font-mono" title={device.landing ?? ''}>
          {pathLabel(device.landing) || '—'}
        </span>
        <span className="block truncate text-muk-soft" title={device.referrer ?? ''}>
          {referrerLabel(device.referrer)}
        </span>
      </td>
    </tr>
  );
}

// =========================================================================
// 타임라인 — 기기 하나의 행을 키셋으로 끝까지(한 번에 6000건씩) 읽어 세션별로 보여 준다.
// 부모가 기기·기간·새로고침마다 key 를 바꿔 새로 마운트하므로 상태 초기화를 따로 하지 않는다.
// =========================================================================

interface TimelineState {
  rows: ActionLogRow[];
  lastId: number;
  phase: 'loading' | 'ready' | 'error';
  /** 한 번에 모으는 양에서 멈췄고 뒤에 더 있다. */
  more: boolean;
  error: ActionLogError | null;
}

/** 이벤트 거르기: 하트비트는 30초마다 와서 기본으로 뺀다(세션 요약의 시간 계산에는 그대로 센다). */
const FILTER_NO_HEARTBEAT = '__no_heartbeat';
const FILTER_ALL = '__all';

function matchesFilter(event: string, filter: string): boolean {
  if (filter === FILTER_ALL) return true;
  if (filter === FILTER_NO_HEARTBEAT) return event !== 'heartbeat';
  return event === filter;
}

/**
 * 기기 하나의 행을 afterId 다음부터 한 번에 TIMELINE_BATCH 건까지 읽어 onUpdate 로 넘긴다.
 * 쪽마다 넘겨서 수천 건이어도 첫 쪽부터 보인다. 실패하면 받은 데까지는 남긴다 — '다시 시도' 가 거기서 이어 간다.
 */
async function loadTimelineRows({
  deviceId,
  from,
  to,
  life,
  afterId,
  base,
  onUpdate,
}: {
  deviceId: string;
  from: string;
  to: string;
  life: { cancelled: boolean };
  afterId: number;
  base: ActionLogRow[];
  onUpdate: (next: TimelineState) => void;
}): Promise<void> {
  let rows = base;
  let lastId = afterId;
  try {
    const result = await collectKeyset<ActionLogRow>({
      fetchPage: (after, limit) => fetchRows({ from, to }, deviceId, after, limit),
      afterId,
      pageSize: TIMELINE_PAGE,
      maxRows: TIMELINE_BATCH,
      isCancelled: () => life.cancelled,
      isRetryable: isRetryableActionLogError,
      onPage: (page) => {
        rows = rows.concat(page);
        for (const row of page) if (row.id > lastId) lastId = row.id;
        onUpdate({ rows, lastId, phase: 'loading', more: false, error: null });
      },
    });
    if (life.cancelled) return;
    onUpdate({ rows, lastId: result.lastId, phase: 'ready', more: result.reason === 'cap', error: null });
  } catch (err) {
    if (life.cancelled) return;
    onUpdate({ rows, lastId, phase: 'error', more: false, error: toActionLogError(err) });
  }
}

function Timeline({
  deviceId,
  from,
  to,
  device,
  exportBusy,
  onExport,
  onClose,
  statusSlot,
}: {
  deviceId: string;
  from: string;
  to: string;
  device: ActionLogDevice | null;
  exportBusy: boolean;
  onExport: () => void;
  onClose: () => void;
  statusSlot: ReactNode;
}) {
  const [state, setState] = useState<TimelineState>({
    rows: [],
    lastId: 0,
    phase: 'loading',
    more: false,
    error: null,
  });
  const [filter, setFilter] = useState(FILTER_NO_HEARTBEAT);
  // 이 타임라인이 살아 있는 동안의 표식. 언마운트되면 진행 중인 키셋 읽기가 멈춘다.
  const lifeRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  useEffect(() => {
    const life = { cancelled: false };
    lifeRef.current = life;
    void loadTimelineRows({ deviceId, from, to, life, afterId: 0, base: [], onUpdate: setState });
    return () => {
      life.cancelled = true;
    };
  }, [deviceId, from, to]);

  /** 더 불러오기 · 실패 뒤 다시 시도 — 마지막으로 받은 id 다음부터 이어 간다. */
  const resume = () => {
    if (state.phase === 'loading') return;
    setState((prev) => ({ ...prev, phase: 'loading', error: null }));
    void loadTimelineRows({
      deviceId,
      from,
      to,
      life: lifeRef.current,
      afterId: state.lastId,
      base: state.rows,
      onUpdate: setState,
    });
  };

  const sessions = useMemo(() => groupBySession(state.rows), [state.rows]);
  const eventCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of state.rows) counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
    return counts;
  }, [state.rows]);
  const eventOptions = useMemo(() => {
    const known = (ACTION_LOG_EVENTS as readonly string[]).filter((e) => eventCounts.has(e));
    const unknown = [...eventCounts.keys()].filter((e) => !(ACTION_LOG_EVENTS as readonly string[]).includes(e)).sort();
    return [...known, ...unknown];
  }, [eventCounts]);
  const visibleCount = useMemo(
    () => state.rows.reduce((n, row) => (matchesFilter(row.event, filter) ? n + 1 : n), 0),
    [state.rows, filter],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold">
            기기 <span className="font-mono">{shortId(deviceId)}</span> 기록
          </h2>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muk-soft">{deviceId}</p>
          {device && (
            <p className="mt-1 text-[12px] text-muk-soft">
              {[
                shortUserAgent(device.user_agent),
                `세션 ${fmt(device.sessions)}`,
                `이벤트 ${fmt(device.events)}`,
                device.accounts.length > 0 ? device.accounts.map(accountLabel).join(', ') : '로그인 안 함',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" onClick={onExport} disabled={exportBusy} className={`${PILL} ${PILL_IDLE}`}>
            <Download size={15} aria-hidden /> 이 기기 CSV
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="기기 기록 닫기"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-line bg-white text-muk-soft transition-colors hover:text-muk"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      {statusSlot && <div className="-mt-1 mb-3">{statusSlot}</div>}

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="inline-flex items-center gap-2 text-[12px] font-semibold text-muk-soft">
          이벤트
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="min-h-11 rounded-xl border border-line bg-hanji px-3 text-sm font-normal text-muk focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
          >
            <option value={FILTER_NO_HEARTBEAT}>하트비트 빼고 전부</option>
            <option value={FILTER_ALL}>전부</option>
            {eventOptions.map((event) => (
              <option key={event} value={event}>
                {eventLabel(event)} ({fmt(eventCounts.get(event) ?? 0)})
              </option>
            ))}
          </select>
        </label>
        <p className="text-[12px] text-muk-soft" aria-live="polite">
          불러온 기록 {fmt(state.rows.length)}건
          {device ? ` / 이 기간 ${fmt(device.events)}건` : ''} · 세션 {fmt(sessions.length)}개
          {visibleCount !== state.rows.length ? ` · 표에 ${fmt(visibleCount)}건` : ''}
          {state.phase === 'loading' && (
            <Loader2 size={13} className="ml-1.5 inline animate-spin" aria-label="불러오는 중" />
          )}
        </p>
      </div>

      {state.error && <ErrorNotice error={state.error} onRetry={resume} />}

      {state.phase === 'ready' && state.rows.length === 0 && (
        <p className="py-6 text-center text-sm text-muk-soft">이 기간에 이 기기의 기록이 없어요.</p>
      )}
      {state.phase === 'loading' && state.rows.length === 0 && (
        <Loader2 size={18} className="mx-auto my-8 animate-spin text-muk-soft" aria-label="불러오는 중" />
      )}

      <div className="flex flex-col gap-3">
        {sessions.map((group) => (
          <SessionBlock key={group.sessionId ?? '__none'} group={group} filter={filter} />
        ))}
      </div>

      {state.more && state.phase !== 'loading' && (
        <div className="mt-4 flex flex-col items-center gap-1.5">
          <button type="button" onClick={resume} className={`${PILL} ${PILL_IDLE}`}>
            더 불러오기 (다음 {fmt(TIMELINE_BATCH)}건)
          </button>
          <p className="text-[11px] text-muk-soft">
            CSV 는 더 불러오지 않아도 이 기기의 기간 전체를 담아요.
          </p>
        </div>
      )}
    </div>
  );
}

/** memo — 세션 묶음은 행이 바뀔 때만 다시 그린다(수천 줄짜리 표가 여럿일 수 있다). */
const SessionBlock = memo(function SessionBlock({ group, filter }: { group: SessionGroup; filter: string }) {
  const rows = group.rows.filter((row) => matchesFilter(row.event, filter));
  const startMs = parseTimestamp(group.startAt);
  const endMs = parseTimestamp(group.endAt);
  const sameDay = startMs !== null && endMs !== null && kstDay(startMs) === kstDay(endMs);
  const clientStartMs = parseTimestamp(group.clientStartAt);
  const clientEndMs = parseTimestamp(group.clientEndAt);
  const clientSameDay =
    clientStartMs !== null && clientEndMs !== null && kstDay(clientStartMs) === kstDay(clientEndMs);
  const accounts = group.accounts.filter((a) => a.email || !a.anonymous);
  const guests = group.accounts.length - accounts.length;

  return (
    <div className="overflow-hidden rounded-2xl border border-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-hanji px-3.5 py-2.5 text-[12px] text-muk-soft">
        <span className="font-mono font-semibold text-muk" title={group.sessionId ?? ''}>
          세션 {group.sessionId ? shortId(group.sessionId) : '(없음)'}
        </span>
        <span
          className="inline-flex flex-wrap items-center gap-x-1.5 text-muk"
          title="서버가 받은 시각(received_at) 기준 — 증빙은 이 값으로 읽는다. 늦게 다시 보낸 기록이 있으면 끝이 그만큼 늘어난다."
        >
          <SourceTag source="server" />
          <span className="font-mono tabular-nums">
            {formatKst(group.startAt, 'second') || '—'} → {formatKst(group.endAt, sameDay ? 'time' : 'second') || '—'}
          </span>
          {group.durationS !== null && <span>{formatDuration(group.durationS)}</span>}
        </span>
        {group.clientStartAt && (
          <span
            className="inline-flex flex-wrap items-center gap-x-1.5"
            title="브라우저 시계(occurred_at) 기준 — 참고값. 기기 시계가 틀리면 같이 틀리지만, 늦게 도착한 기록에 길이가 늘어나지 않는다."
          >
            <SourceTag source="browser" />
            <span className="font-mono tabular-nums">
              {formatKst(group.clientStartAt, 'second') || '—'} →{' '}
              {formatKst(group.clientEndAt, clientSameDay ? 'time' : 'second') || '—'}
            </span>
            {group.clientDurationS !== null && <span>{formatDuration(group.clientDurationS)}</span>}
          </span>
        )}
        {group.lateRows > 0 && (
          <span
            className="font-semibold text-terracotta"
            title="seq 로는 앞인데 뒤 순번보다 서버에 늦게 들어온 기록(보내지 못해 다음 방문 때 다시 보낸 것). 표는 seq 순이라 서버 시각이 거꾸로 가는 줄이 있다."
          >
            늦게 도착 {fmt(group.lateRows)}건
          </span>
        )}
        <span>
          이벤트 {fmt(group.events)} · 화면 이동 {fmt(group.pageViews)} · 클릭 {fmt(group.clicks)}
        </span>
        {group.visibleS > 0 && (
          <span title="하트비트 기준 대략값 — 열어 둔 시간은 하트비트 전부, 조작은 직전 30초 안에 입력이 있던 하트비트만 센다.">
            열어 둔 시간 약 {formatDuration(group.visibleS)}(조작 약 {formatDuration(group.activeS)})
          </span>
        )}
        {accounts.map((a, i) => (
          <span key={`${a.user_id ?? a.email ?? ''}-${i}`} className="inline-flex flex-wrap items-center gap-1.5 text-muk">
            {judgeConsoleForEmail(a.email) && <JudgeBadge />}
            <span className="break-all">{accountLabel(a)}</span>
          </span>
        ))}
        {guests > 0 && <span>게스트 세션 {guests}</span>}
        {group.ips.length > 0 && <span className="font-mono">{group.ips.join(', ')}</span>}
      </div>

      {rows.length === 0 ? (
        <p className="px-3.5 py-3 text-[12px] text-muk-soft">고른 이벤트가 이 세션에는 없어요.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] table-fixed border-collapse text-left text-[12px]">
            <caption className="sr-only">세션 {shortId(group.sessionId)} 기록</caption>
            <colgroup>
              <col className="w-[118px]" />
              <col className="w-[76px]" />
              <col className="w-[72px]" />
              <col className="w-[56px]" />
              <col className="w-[92px]" />
              <col className="w-[150px]" />
              <col />
              <col className="w-[190px]" />
              <col className="w-[118px]" />
            </colgroup>
            <thead className="bg-white text-[11px] text-muk-soft">
              {/* 출처 묶음 — 서버가 찍은 칸(초록 바탕)과 브라우저가 보낸 칸을 가른다. 증빙은 서버 칸으로 읽는다. */}
              <tr className="text-[10px]">
                <th scope="colgroup" className={`${SERVER_CELL} px-2.5 pt-1.5 font-semibold text-jade`}>
                  서버가 찍음
                </th>
                <th scope="colgroup" colSpan={6} className="border-x border-line px-2.5 pt-1.5 font-semibold">
                  브라우저가 보냄 (참고값 · 기기 시계)
                </th>
                <th scope="colgroup" colSpan={2} className={`${SERVER_CELL} px-2.5 pt-1.5 font-semibold text-jade`}>
                  서버가 찍음
                </th>
              </tr>
              <tr>
                <th scope="col" className={`${TD} ${SERVER_CELL} font-semibold`}>서버 시각</th>
                <th
                  scope="col"
                  className={`${TD} font-semibold`}
                  title="브라우저가 적은 시각 − 서버가 받은 시각. 보통 몇 초 음수(모았다가 보낸다). 크게 어긋나면 기기 시계가 틀렸거나 오프라인 뒤에 몰아 보낸 것."
                >
                  시각 차이
                </th>
                <th scope="col" className={`${TD} font-semibold`}>세션</th>
                <th scope="col" className={`${TD} font-semibold`} title="세션 안 브라우저 순번 — 표는 이 순서(오름차순)다.">
                  #seq ↑
                </th>
                <th scope="col" className={`${TD} font-semibold`}>이벤트</th>
                <th scope="col" className={`${TD} font-semibold`}>화면</th>
                <th scope="col" className={`${TD} font-semibold`}>내용</th>
                <th scope="col" className={`${TD} ${SERVER_CELL} font-semibold`}>계정</th>
                <th scope="col" className={`${TD} ${SERVER_CELL} font-semibold`}>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TimelineRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});

/** 서버가 찍은 값(받은 시각 · 계정 · IP)의 칸 바탕 — 브라우저가 보낸 칸과 한눈에 갈리게. */
const SERVER_CELL = 'bg-jade/5';

/** 시각 앞의 출처 꼬리표 — 세션 머리의 두 시각(서버 · 브라우저 시계)을 가른다. */
function SourceTag({ source }: { source: 'server' | 'browser' }) {
  return source === 'server' ? (
    <span className="rounded border border-jade/40 bg-jade/10 px-1.5 text-[10px] font-semibold text-jade">서버</span>
  ) : (
    <span className="rounded border border-line bg-white px-1.5 text-[10px] font-semibold text-muk-soft">
      브라우저 시계
    </span>
  );
}

function eventTone(event: string): string {
  if (event === 'error') return 'font-semibold text-terracotta';
  if (event === 'auth') return 'font-semibold text-jade';
  if (['click', 'input', 'submit', 'search', 'voice', 'page_view'].includes(event)) return 'font-semibold text-muk';
  return 'text-muk-soft';
}

function TimelineRow({ row }: { row: ActionLogRow }) {
  const account = rowAccountLabel(row);
  const judge = judgeConsoleForEmail(row.email) !== null;
  const summary = summarizeProps(row.event, row.props);
  return (
    <tr className="border-t border-line align-top">
      <td
        className={`${TD} ${SERVER_CELL} whitespace-nowrap font-mono tabular-nums`}
        title={`서버가 받은 시각 ${formatKst(row.received_at, 'full')}`}
      >
        {formatKst(row.received_at, 'second') || '—'}
      </td>
      <td
        className={`${TD} whitespace-nowrap font-mono tabular-nums text-muk-soft`}
        title={row.occurred_at ? `브라우저 시각 ${formatKst(row.occurred_at, 'full')}` : ''}
      >
        {formatClockDiff(clockDiffSeconds(row.occurred_at, row.received_at)) || '—'}
      </td>
      <td className={`${TD} truncate font-mono text-muk-soft`} title={row.session_id ?? ''}>
        {shortId(row.session_id, 6) || '—'}
      </td>
      <td className={`${TD} font-mono tabular-nums text-muk-soft`}>{row.seq !== null ? `#${row.seq}` : '—'}</td>
      <td className={TD}>
        <span className={`block ${eventTone(row.event)}`}>{eventLabel(row.event)}</span>
        <span className="block truncate font-mono text-[11px] text-muk-soft">{row.event}</span>
      </td>
      <td className={`${TD} truncate font-mono`} title={[row.host, row.page].filter(Boolean).join('')}>
        {row.page || '—'}
      </td>
      <td className={`${TD} break-words`}>{summary || <span className="text-muk-soft">—</span>}</td>
      <td className={`${TD} ${SERVER_CELL}`}>
        {account ? (
          <span className="flex flex-wrap items-center gap-1">
            {judge && <JudgeBadge />}
            <span className="break-all">{account}</span>
          </span>
        ) : (
          <span className="text-muk-soft">—</span>
        )}
      </td>
      <td className={`${TD} ${SERVER_CELL} truncate font-mono`} title={ipChainText(row.ip_chain) || (row.ip ?? '')}>
        {row.ip || '—'}
      </td>
    </tr>
  );
}
