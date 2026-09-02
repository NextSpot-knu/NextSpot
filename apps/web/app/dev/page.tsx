'use client';

// 개발자 콘솔 — 역할 임명 · 가게 소유권 · 사업자 인증 심사 · 감사 로그.
//
// /admin(정부기관 관제)과 경로부터 분리했다. 거기에 '이 계정을 사장님으로 임명' 같은 운영
// 도구가 섞이면 화면이 산만해지고 사고 위험도 커진다 — 권한 운영은 팀 전용이다.
//
// 이 화면의 모든 쓰기는 서버에서 role_audit_log 에 남는다(삭제 API 는 없다). 프런트 가드는
// UX 이고, 실제 차단은 백엔드가 매 요청 수행한다(require_role("developer")).

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldAlert,
  Loader2,
  Search,
  UserCog,
  Store,
  ClipboardCheck,
  ScrollText,
  Check,
  X,
  LogOut,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { useAccount, canEnterDevConsole, type AccountRole } from '@/lib/account';

type Tab = 'users' | 'requests' | 'audit' | 'failures';

interface DevUser {
  id: string;
  nickname: string | null;
  role: AccountRole;
  /** 마스킹된 이메일(op***@naver.com). 익명 세션·이메일 없는 소셜 계정은 null. */
  email: string | null;
  createdAt?: string;
}

interface OwnerRow {
  id: string;
  userId: string;
  facilityId: string;
  facilityName: string | null;
  facilityType: string | null;
}

interface VerificationRow {
  id: string;
  userId: string;
  storeName: string;
  facilityId: string | null;
  contact: string | null;
  status: string;
  /** 신청한 역할. 컬럼이 없는 DB(마이그레이션 미적용)에서는 undefined → merchant 로 읽는다. */
  requestedRole?: 'merchant' | 'admin';
  createdAt?: string;
}

interface AuditRow {
  id: number;
  actorId: string | null;
  targetId: string;
  action: string;
  fromValue: string | null;
  toValue: string | null;
  reason: string | null;
  createdAt?: string;
}

interface FailureRow {
  at: string;
  kind: string;
  errorType: string;
  error: string;
  context?: Record<string, string>;
}

const ROLES: AccountRole[] = ['tourist', 'merchant', 'admin', 'developer'];

// 사용자·권한 탭의 하위 메뉴. 관광객은 600명이 넘어 목록으로서 의미가 없고(검색으로 찾는다),
// 운영이 필요한 건 상위 3역할이다 — '전체'에서는 최근 가입순으로 섞여 보인다.
const ROLE_TABS: { key: AccountRole | null; label: string }[] = [
  { key: null, label: '전체' },
  { key: 'merchant', label: '사업자' },
  { key: 'admin', label: '관리자' },
  { key: 'developer', label: '개발자' },
];

export default function DevConsolePage() {
  const router = useRouter();
  const { account, status, refresh } = useAccount();
  const [tab, setTab] = useState<Tab>('users');

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

  return (
    <main className="min-h-screen bg-hanji px-5 py-7 font-sans text-muk">
      <div className="mx-auto max-w-3xl">
        {/* 나가기 — 이 화면은 BottomNav 대상 경로가 아니라(chrome 없는 페이지) 나갈 길이
            주소창밖에 없었다. 관광객 앱으로 돌아가는 버튼을 머리말에 둔다. */}
        <header className="mb-6 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-serif text-2xl font-bold tracking-tight">개발자 콘솔</h1>
            <p className="mt-1 text-sm text-muk-soft">
              역할 임명·가게 소유권·사업자 인증 심사. 모든 변경은 감사 로그에 남습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push('/main')}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-white px-3.5 py-2 text-sm font-medium text-muk-soft transition-colors hover:text-muk"
          >
            <LogOut size={15} /> 나가기
          </button>
        </header>

        <nav className="mb-5 flex gap-2">
          {(
            [
              ['users', '사용자·권한', UserCog],
              ['requests', '인증 심사', ClipboardCheck],
              ['audit', '감사 로그', ScrollText],
              ['failures', '최근 실패', ShieldAlert],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors ${
                tab === id
                  ? 'border-gold bg-gold/15 text-muk'
                  : 'border-line bg-white text-muk-soft hover:text-muk'
              }`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>

        {tab === 'users' && <UsersPanel onChanged={refresh} />}
        {tab === 'requests' && <RequestsPanel onChanged={refresh} />}
        {tab === 'audit' && <AuditPanel />}
        {tab === 'failures' && <FailuresPanel />}
      </div>
    </main>
  );
}

// =========================================================================
// 사용자 검색 · 역할 임명 · 소유권 부여
// =========================================================================
function UsersPanel({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState<AccountRole | null>(null);
  const [rows, setRows] = useState<DevUser[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [owners, setOwners] = useState<OwnerRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (term: string, role: AccountRole | null) => {
    setBusy(true);
    try {
      const params: Record<string, string> = { q: term };
      if (role) params.role = role;
      const res = await apiClient.get('/api/v1/dev/users', { params });
      const items: DevUser[] = Array.isArray(res?.items) ? res.items : [];
      setRows(items);
      setCounts((res?.counts as Record<string, number>) ?? {});

      // 소유 가게는 별도 호출로 한 화면분을 한 번에 받는다. 실패해도 목록은 살려 둔다 —
      // 역할 임명이 주 기능이고 소유권 표시는 부가 정보다.
      if (items.length === 0) {
        setOwners([]);
      } else {
        try {
          const own = await apiClient.get('/api/v1/dev/facility-owners', {
            params: { user_ids: items.map((u) => u.id).join(',') },
          });
          setOwners(Array.isArray(own?.items) ? own.items : []);
        } catch {
          setOwners([]);
        }
      }
    } catch (err) {
      toast.error(errorMessage(err) || '사용자 조회에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // 하위 메뉴를 바꾸면 검색어는 유지한 채 다시 조회한다(역할 안에서 이어 찾는 동선).
    void load(q, roleFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, roleFilter]);

  const changeRole = async (user: DevUser, role: AccountRole) => {
    try {
      await apiClient.patch(`/api/v1/dev/users/${user.id}/role`, { role });
      toast.success(`${user.nickname || user.email || user.id.slice(0, 8)} → ${role}`);
      await load(q, roleFilter);
      onChanged();
    } catch (err) {
      // 마지막 developer 강등은 서버가 409 로 막는다(아무도 권한을 못 주는 잠김 방지).
      toast.error(errorMessage(err) || '역할 변경에 실패했어요.');
    }
  };

  return (
    <section className="rounded-3xl border border-line bg-white p-5">
      {/* 역할별 하위 메뉴 — 사업자·관리자·개발자는 몇 명뿐이라 검색 없이 바로 보이는 게 맞다.
          닉네임이 NULL 인 이메일 계정은 '전체' 최근순 20건에 묻혀 사실상 찾을 수 없었다. */}
      <nav className="mb-4 flex flex-wrap gap-1.5">
        {ROLE_TABS.map((item) => {
          const active = roleFilter === item.key;
          const count = item.key ? counts[item.key] : undefined;
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => setRoleFilter(item.key)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? 'border-gold bg-gold/15 text-gold-deep'
                  : 'border-line text-muk-soft hover:bg-hanji hover:text-muk'
              }`}
            >
              {item.label}
              {typeof count === 'number' && (
                <span className="ml-1 font-mono text-[10px] opacity-70">{count}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muk-soft" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load(q, roleFilter)}
            placeholder="이메일·닉네임 부분일치 또는 uid 정확일치"
            className="w-full rounded-xl border border-line bg-hanji py-2.5 pl-9 pr-3 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
          />
        </div>
        <button
          type="button"
          onClick={() => void load(q, roleFilter)}
          className="rounded-xl border border-line px-4 text-sm font-semibold hover:bg-hanji"
        >
          검색
        </button>
      </div>

      {busy && <Loader2 size={16} className="mx-auto my-4 animate-spin text-muk-soft" />}

      <div className="flex flex-col gap-2">
        {rows.map((u) => (
          <div
            key={u.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3.5 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {u.nickname || u.email || '(이름·이메일 없음)'}
              </p>
              {u.nickname && u.email && (
                <p className="truncate text-[11px] text-muk-soft">{u.email}</p>
              )}
              <p className="font-mono text-[11px] text-muk-soft">{u.id}</p>
            </div>
            <div className="flex items-center gap-1.5">
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={u.role === r}
                  onClick={() => void changeRole(u, r)}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    u.role === r
                      ? 'cursor-default border-gold bg-gold/15 text-gold-deep'
                      : 'border-line text-muk-soft hover:bg-hanji hover:text-muk'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <OwnedFacilities
              rows={owners.filter((o) => o.userId === u.id)}
              onRevoked={() => void load(q, roleFilter)}
            />
            <OwnerGrant userId={u.id} onGranted={() => void load(q, roleFilter)} />
          </div>
        ))}
        {!busy && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muk-soft">결과가 없어요.</p>
        )}
      </div>
    </section>
  );
}

/** 이 사용자가 가진 활성 소유권 + 회수.
 *
 * 부여 UI 만 있고 회수 UI 가 없어, 잘못 준 소유권은 SQL 로만 되돌릴 수 있었다
 * (DELETE API 는 처음부터 있었는데 화면이 부르지 않았다). 회수는 행 삭제가 아니라
 * revoked_at 갱신이다 — 누가 언제 이 가게를 관리했는지는 감사 대상이라 남긴다. */
function OwnedFacilities({ rows, onRevoked }: { rows: OwnerRow[]; onRevoked: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const revoke = async (row: OwnerRow) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      await apiClient.delete(`/api/v1/dev/facility-owners/${row.id}`);
      toast.success('소유권을 회수했어요.');
      onRevoked();
    } catch (err) {
      toast.error(errorMessage(err) || '소유권 회수에 실패했어요.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 border-t border-line pt-2">
      <Store size={14} className="shrink-0 text-muk-soft" />
      {rows.map((row) => (
        <span
          key={row.id}
          className="flex items-center gap-1 rounded-lg border border-line bg-hanji px-2 py-1 text-[11px]"
        >
          {row.facilityName || row.facilityId.slice(0, 8)}
          <button
            type="button"
            onClick={() => void revoke(row)}
            disabled={busyId === row.id}
            title="소유권 회수"
            className="text-muk-soft transition-colors hover:text-terracotta disabled:opacity-40"
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** 가게 소유권 부여 — facility_id 를 직접 넣는다(가게 검색은 사장님 콘솔의 개발자 피커에 있다). */
function OwnerGrant({ userId, onGranted }: { userId: string; onGranted: () => void }) {
  const [facilityId, setFacilityId] = useState('');
  const [busy, setBusy] = useState(false);

  const grant = async () => {
    if (!facilityId.trim() || busy) return;
    setBusy(true);
    try {
      await apiClient.post('/api/v1/dev/facility-owners', {
        userId,
        facilityId: facilityId.trim(),
      });
      toast.success('소유권을 부여했어요.');
      setFacilityId('');
      onGranted();
    } catch (err) {
      toast.error(errorMessage(err) || '소유권 부여에 실패했어요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full items-center gap-1.5 border-t border-line pt-2">
      <Store size={14} className="shrink-0 text-muk-soft" />
      <input
        value={facilityId}
        onChange={(e) => setFacilityId(e.target.value)}
        placeholder="facility_id (UUID) 붙여넣기"
        className="min-w-0 flex-1 rounded-lg border border-line bg-hanji px-2.5 py-1.5 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-gold/40"
      />
      <button
        type="button"
        onClick={() => void grant()}
        disabled={busy || !facilityId.trim()}
        className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-40 hover:bg-hanji"
      >
        소유 부여
      </button>
    </div>
  );
}

// =========================================================================
// 사업자 인증 심사
// =========================================================================
function RequestsPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<VerificationRow[]>([]);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiClient.get('/api/v1/dev/verification-requests', {
        params: { status_filter: 'pending' },
      });
      setRows(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      toast.error(errorMessage(err) || '심사 큐 조회에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (row: VerificationRow, approve: boolean) => {
    // 승인은 역할 승격 + 소유권 부여 + 증빙 삭제를 서버가 한 번에 처리한다.
    // 거절은 사유가 필수다(신청자에게 그대로 보인다).
    const reason = approve ? undefined : window.prompt('반려 사유를 입력하세요');
    if (!approve && !reason) return;
    try {
      await apiClient.post(
        `/api/v1/dev/verification-requests/${row.id}/${approve ? 'approve' : 'reject'}`,
        { reason },
      );
      toast.success(approve ? '승인했어요.' : '반려했어요.');
      await load();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err) || '심사 처리에 실패했어요.');
    }
  };

  return (
    <section className="rounded-3xl border border-line bg-white p-5">
      {busy ? (
        <Loader2 size={16} className="mx-auto my-6 animate-spin text-muk-soft" />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muk-soft">대기 중인 신청이 없어요.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => {
            // 관리자 신청은 다루는 가게가 없다 — 가게 매핑을 요구하면 영원히 승인할 수 없다.
            const isAdminRequest = r.requestedRole === 'admin';
            const blocked = !isAdminRequest && !r.facilityId;
            return (
            <div key={r.id} className="rounded-xl border border-line px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                    isAdminRequest
                      ? 'border-jade/40 bg-jade/10 text-jade'
                      : 'border-gold/40 bg-gold/10 text-gold-deep'
                  }`}
                >
                  {isAdminRequest ? '관리자' : '사업자'}
                </span>
                <p className="text-sm font-semibold">{r.storeName}</p>
              </div>
              <p className="mt-0.5 text-[11px] text-muk-soft">연락처 {r.contact || '—'}</p>
              <p className="font-mono text-[11px] text-muk-soft">
                user {r.userId}
                {!isAdminRequest && ` · facility ${r.facilityId || '(미연결)'}`}
              </p>
              {blocked && (
                <p className="mt-1 text-[11px] text-terracotta">
                  가게(POI)가 연결되지 않아 승인할 수 없어요. 먼저 시설을 매핑하세요.
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => void decide(r, true)}
                  className="flex items-center gap-1 rounded-lg border border-jade/40 bg-jade/10 px-3 py-1.5 text-[11px] font-semibold text-jade disabled:opacity-40"
                >
                  <Check size={13} /> 승인
                </button>
                <button
                  type="button"
                  onClick={() => void decide(r, false)}
                  className="flex items-center gap-1 rounded-lg border border-terracotta/40 bg-terracotta/10 px-3 py-1.5 text-[11px] font-semibold text-terracotta"
                >
                  <X size={13} /> 반려
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// =========================================================================
// 감사 로그 (읽기 전용 — 삭제 기능은 만들지 않는다)
// =========================================================================
// =========================================================================
// 최근 실패 (진단)
// =========================================================================
// Render 로그를 열지 않고도 프로덕션 예외의 정체를 볼 수 있게 하는 화면.
// 백엔드의 인메모리 링버퍼를 읽으므로 재시작하면 비고, 워커가 여럿이면 이 워커 것만 보인다.
// 분산코스 간헐 실패(2026-08-28)를 좁히려고 붙였다 — 원인을 잡고 나면 지워도 된다.
function FailuresPanel() {
  const [rows, setRows] = useState<FailureRow[]>([]);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiClient.get('/api/v1/dev/failures', { params: { limit: '50' } });
      setRows(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      toast.error(errorMessage(err) || '실패 기록 조회에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-3xl border border-line bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muk-soft">
          이 서버 프로세스에서 최근에 난 예외입니다. 재시작하면 비워집니다.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muk-soft hover:bg-hanji disabled:opacity-50"
        >
          새로고침
        </button>
      </div>

      {busy ? (
        <Loader2 size={16} className="mx-auto my-6 animate-spin text-muk-soft" />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muk-soft">기록된 실패가 없어요.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r, i) => (
            <div key={`${r.at}-${i}`} className="rounded-lg border border-line px-3 py-2 text-[11px]">
              <div>
                <span className="font-semibold text-terracotta">{r.errorType}</span>{' '}
                <span className="text-muk-soft">{r.kind}</span>
              </div>
              <div className="mt-0.5 break-all font-mono text-muk-soft">{r.error}</div>
              <div className="mt-0.5 font-mono text-[10px] text-muk-soft">
                {r.at}
                {r.context && Object.keys(r.context).length > 0
                  ? ' · ' + Object.entries(r.context).map(([k, v]) => `${k}=${v}`).join(' ')
                  : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AuditPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get('/api/v1/dev/audit-log', { params: { limit: '100' } });
        setRows(Array.isArray(res?.items) ? res.items : []);
      } catch (err) {
        toast.error(errorMessage(err) || '감사 로그 조회에 실패했어요.');
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  return (
    <section className="rounded-3xl border border-line bg-white p-5">
      {busy ? (
        <Loader2 size={16} className="mx-auto my-6 animate-spin text-muk-soft" />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muk-soft">기록이 없어요.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-line px-3 py-2 text-[11px]">
              <span className="font-semibold">{r.action}</span>{' '}
              <span className="text-muk-soft">
                {r.fromValue ? `${r.fromValue} → ` : ''}
                {r.toValue || ''}
              </span>
              <div className="font-mono text-muk-soft">
                actor {r.actorId ? r.actorId.slice(0, 8) : '시스템'} · target{' '}
                {r.targetId.slice(0, 8)} · {(r.createdAt || '').slice(0, 19).replace('T', ' ')}
              </div>
              {r.reason && <div className="mt-0.5 text-muk-soft">{r.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
