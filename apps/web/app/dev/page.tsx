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
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { useAccount, canEnterDevConsole, type AccountRole } from '@/lib/account';

type Tab = 'users' | 'requests' | 'audit';

interface DevUser {
  id: string;
  nickname: string | null;
  role: AccountRole;
  createdAt?: string;
}

interface VerificationRow {
  id: string;
  userId: string;
  storeName: string;
  facilityId: string | null;
  contact: string | null;
  status: string;
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

const ROLES: AccountRole[] = ['tourist', 'merchant', 'admin', 'developer'];

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
        <header className="mb-6">
          <h1 className="font-serif text-2xl font-bold tracking-tight">개발자 콘솔</h1>
          <p className="mt-1 text-sm text-muk-soft">
            역할 임명·가게 소유권·사업자 인증 심사. 모든 변경은 감사 로그에 남습니다.
          </p>
        </header>

        <nav className="mb-5 flex gap-2">
          {(
            [
              ['users', '사용자·권한', UserCog],
              ['requests', '인증 심사', ClipboardCheck],
              ['audit', '감사 로그', ScrollText],
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
      </div>
    </main>
  );
}

// =========================================================================
// 사용자 검색 · 역할 임명 · 소유권 부여
// =========================================================================
function UsersPanel({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<DevUser[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (term: string) => {
    setBusy(true);
    try {
      const res = await apiClient.get('/api/v1/dev/users', { params: { q: term } });
      setRows(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      toast.error(errorMessage(err) || '사용자 조회에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  const changeRole = async (user: DevUser, role: AccountRole) => {
    try {
      await apiClient.patch(`/api/v1/dev/users/${user.id}/role`, { role });
      toast.success(`${user.nickname || user.id.slice(0, 8)} → ${role}`);
      await load(q);
      onChanged();
    } catch (err) {
      // 마지막 developer 강등은 서버가 409 로 막는다(아무도 권한을 못 주는 잠김 방지).
      toast.error(errorMessage(err) || '역할 변경에 실패했어요.');
    }
  };

  return (
    <section className="rounded-3xl border border-line bg-white p-5">
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muk-soft" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load(q)}
            placeholder="닉네임 부분일치 또는 uid 정확일치"
            className="w-full rounded-xl border border-line bg-hanji py-2.5 pl-9 pr-3 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
          />
        </div>
        <button
          type="button"
          onClick={() => void load(q)}
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
              <p className="truncate text-sm font-semibold">{u.nickname || '(닉네임 없음)'}</p>
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
            <OwnerGrant userId={u.id} onGranted={onChanged} />
          </div>
        ))}
        {!busy && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muk-soft">결과가 없어요.</p>
        )}
      </div>
    </section>
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
          {rows.map((r) => (
            <div key={r.id} className="rounded-xl border border-line px-3.5 py-3">
              <p className="text-sm font-semibold">{r.storeName}</p>
              <p className="mt-0.5 text-[11px] text-muk-soft">연락처 {r.contact || '—'}</p>
              <p className="font-mono text-[11px] text-muk-soft">
                user {r.userId} · facility {r.facilityId || '(미연결)'}
              </p>
              {!r.facilityId && (
                <p className="mt-1 text-[11px] text-terracotta">
                  가게(POI)가 연결되지 않아 승인할 수 없어요. 먼저 시설을 매핑하세요.
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={!r.facilityId}
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
          ))}
        </div>
      )}
    </section>
  );
}

// =========================================================================
// 감사 로그 (읽기 전용 — 삭제 기능은 만들지 않는다)
// =========================================================================
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
