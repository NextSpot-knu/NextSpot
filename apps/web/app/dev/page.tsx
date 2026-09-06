'use client';

// 개발자 콘솔 — 역할 임명 · 가게 소유권 · 사업자 인증 심사 · 감사 로그.
//
// /admin(정부기관 관제)과 경로부터 분리했다. 거기에 '이 계정을 사장님으로 임명' 같은 운영
// 도구가 섞이면 화면이 산만해지고 사고 위험도 커진다 — 권한 운영은 팀 전용이다.
//
// 이 화면의 모든 쓰기는 서버에서 role_audit_log 에 남는다(삭제 API 는 없다). 프런트 가드는
// UX 이고, 실제 차단은 백엔드가 매 요청 수행한다(require_role("developer")).

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  FileText,
  Link2,
  Plus,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { searchFacilities, type FacilityHit } from '@/lib/facilitySearch';
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
  /** facilities 임베드에서 평탄화한 이름. 관리자 신청이거나 미연결이면 null. */
  facilityName: string | null;
  /** 사업자등록증 경로. 심사가 끝나면 서버가 지우므로 null 이 된다. */
  documentPath?: string | null;
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

// 사용자 행에서 바로 누를 수 있는 역할. **developer 가 없는 것은 의도다.**
// 이 버튼들은 목록의 모든 행에 붙어 있어 오클릭 한 번이 곧 개발자 계정 증가였다.
// 승격은 '인증 심사 > 개발자' 에서 대상을 검색해 지목하고 확인창을 거치는 경로 하나뿐이다.
// 강등은 여기서 그대로 된다(개발자 행에서 tourist/merchant/admin 을 누르면 된다) —
// 권한을 거두는 쪽은 막을 이유가 없고, 마지막 개발자만 서버가 409 로 지킨다.
const ASSIGNABLE_ROLES: AccountRole[] = ['tourist', 'merchant', 'admin'];

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
              역할 임명·가게 소유권·인증 심사. 모든 변경은 감사 로그에 남습니다.
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
  const [hiddenGuests, setHiddenGuests] = useState(0);
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
      setHiddenGuests(Number(res?.hiddenGuests) || 0);

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

      {/* 목록이 줄어든 이유를 화면에 적는다 — 조용히 걸러 낸 목록을 '전부'로 읽으면
          "가입자가 이것뿐인가?" 하고 엉뚱한 데를 의심하게 된다. */}
      {hiddenGuests > 0 && (
        <p className="-mt-2 mb-3 text-[11px] text-muk-soft">
          익명 게스트 세션 {hiddenGuests.toLocaleString()}개는 숨겼어요. uid 를 그대로 넣으면
          게스트도 조회됩니다.
        </p>
      )}

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
              {ASSIGNABLE_ROLES.map((r) => (
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
// 인증 심사 — 사업자 / 관리자 / 개발자
// =========================================================================

/** 심사 하위 메뉴. 사용자·권한 탭과 같은 모양으로 가른다(같은 종류의 일이라 같은 손놀림이어야 한다). */
const REQUEST_TABS = [
  { key: 'merchant', label: '사업자' },
  { key: 'admin', label: '관리자' },
  { key: 'developer', label: '개발자' },
] as const;

type RequestTab = (typeof REQUEST_TABS)[number]['key'];

/**
 * 개발자만 다른 화면인 이유.
 *
 * 사업자·관리자는 본인이 신청하고 심사자가 승인/반려한다 — 큐가 있다.
 * 개발자는 신청 경로가 아예 없다(앱 어디에도 없고, API 는 422, DB CHECK 도 merchant/admin 만
 * 허용한다). 그래서 여기에 큐를 두면 영원히 비어 있고, 빈 큐는 '아직 신청이 안 왔다'로 읽혀
 * 없는 동선을 있는 것처럼 보이게 한다. 대신 대상을 직접 찾아 지목하는 화면을 둔다.
 */
function RequestsPanel({ onChanged }: { onChanged: () => void }) {
  const [sub, setSub] = useState<RequestTab>('merchant');

  return (
    <section className="rounded-3xl border border-line bg-white p-5">
      <nav className="mb-4 flex flex-wrap gap-1.5">
        {REQUEST_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSub(item.key)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
              sub === item.key
                ? 'border-gold bg-gold/15 text-gold-deep'
                : 'border-line text-muk-soft hover:bg-hanji hover:text-muk'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {sub === 'developer' ? (
        <DeveloperPromotion onChanged={onChanged} />
      ) : (
        <ReviewQueue requestedRole={sub} onChanged={onChanged} />
      )}
    </section>
  );
}

/** 사업자·관리자 심사 큐 — 신청을 받아 승인/반려한다. */
function ReviewQueue({
  requestedRole,
  onChanged,
}: {
  requestedRole: 'merchant' | 'admin';
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<VerificationRow[]>([]);
  const [busy, setBusy] = useState(true);
  // 미연결 신청마다 심사자가 고른 가게. 값이 하나뿐인 판별 유니언이라 '기존 연결'과
  // '신규 등록'이 동시에 담길 수 없다(FacilitySelection 주석 참고).
  const [selections, setSelections] = useState<Record<string, FacilitySelection | null>>({});
  // 신규 등록 승인 직전의 인라인 확인. window.confirm 을 쓰지 않는 화면이라 카드 안에서 묻는다.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // 처리 중인 신청. 승인이 새 POI 를 만들 수 있게 되면서 이중 클릭이 곧 가게 2개다 — 막는다.
  const [decidingId, setDecidingId] = useState<string | null>(null);

  // 자식이 useEffect 로 값을 올리므로 이 콜백은 렌더마다 새로 만들면 안 된다(올림 → 리렌더 →
  // 새 콜백 → 다시 올림 의 루프가 된다). useCallback 으로 고정한다.
  const selectFacility = useCallback((requestId: string, selection: FacilitySelection | null) => {
    setSelections((prev) => (prev[requestId] === selection ? prev : { ...prev, [requestId]: selection }));
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiClient.get('/api/v1/dev/verification-requests', {
        params: { status_filter: 'pending', requested_role: requestedRole },
      });
      setRows(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      toast.error(errorMessage(err) || '심사 큐 조회에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }, [requestedRole]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (row: VerificationRow, approve: boolean) => {
    if (decidingId) return;
    // 승인은 역할 승격 + 소유권 부여 + 증빙 삭제를 서버가 한 번에 처리한다.
    // 거절은 사유가 필수다(신청자에게 그대로 보인다).
    const reason = approve ? undefined : window.prompt('반려 사유를 입력하세요');
    if (!approve && !reason) return;

    // 가게 매핑은 **미연결 사업자 신청을 승인할 때만** 싣는다. 관리자 신청에 facility_id 나
    // new_facility 가 딸려 가면 서버가 422 로 되돌린다(관리자는 다루는 가게가 없다).
    const body: Record<string, unknown> = { reason };
    if (approve && row.requestedRole !== 'admin' && !row.facilityId) {
      const selection = selections[row.id] ?? null;
      if (!selection) return; // 버튼이 이미 잠겨 있지만, 값이 없으면 서버 422 를 부를 이유가 없다.
      // 갈래마다 필드가 하나씩만 나온다 — 두 필드를 동시에 실을 방법이 아예 없다.
      if (selection.mode === 'link') body.facilityId = selection.facilityId;
      else body.newFacility = selection.newFacility;
    }

    setDecidingId(row.id);
    try {
      const res = await apiClient.post(
        `/api/v1/dev/verification-requests/${row.id}/${approve ? 'approve' : 'reject'}`,
        body,
      );
      // 새 POI 를 만든 승인은 되돌리기 어려운 쓰기다 — '승인했어요'로 뭉뚱그리면 심사자가
      // 방금 가게가 하나 생겼다는 걸 모른 채 넘어간다.
      toast.success(
        approve
          ? res?.createdFacility
            ? '새 가게를 등록하고 승인했어요.'
            : '승인했어요.'
          : '반려했어요.',
      );
      setConfirmingId(null);
      // 처리된 신청의 선택값만 버린다. 전체를 비우면 화면에 남아 있는 다른 카드의 칩과
      // 승인 버튼 상태가 어긋난다(패널은 자기 상태를 그대로 들고 있다).
      setSelections((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      await load();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err) || '심사 처리에 실패했어요.');
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <>
      {busy ? (
        <Loader2 size={16} className="mx-auto my-6 animate-spin text-muk-soft" />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muk-soft">대기 중인 신청이 없어요.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => {
            // 관리자 신청은 다루는 가게가 없다 — 가게 매핑을 요구하면 영원히 승인할 수 없다.
            const isAdminRequest = r.requestedRole === 'admin';
            const needsLink = !isAdminRequest && !r.facilityId;
            const selection = selections[r.id] ?? null;
            const blocked = needsLink && !selection;
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
              {/* 가게는 **이름**으로 보여준다. facility_id 는 신청자가 본문에 적어 보낸 값이라
                  uuid 만 보고 승인하면 남의 가게 소유권을 줄 수 있다. 이름이 신청서의
                  가게 이름과 다르면 그 자리에서 눈에 띈다. */}
              {!isAdminRequest && (
                <p className="text-[11px] text-muk-soft">
                  연결된 가게 <span className="font-semibold text-muk">{r.facilityName || '(미연결)'}</span>
                  {r.facilityName && r.facilityName !== r.storeName && (
                    <span className="ml-1 text-terracotta">· 신청서와 이름이 다릅니다</span>
                  )}
                </p>
              )}
              <p className="font-mono text-[11px] text-muk-soft">
                user {r.userId}
                {!isAdminRequest && ` · facility ${r.facilityId || '(미연결)'}`}
              </p>
              {blocked && (
                <p className="mt-1 text-[11px] text-terracotta">
                  가게(POI)가 연결되지 않았어요. 아래에서 기존 가게를 연결하거나 새로 등록하면
                  승인할 수 있어요.
                </p>
              )}
              {needsLink && (
                <FacilityLinkPanel
                  requestId={r.id}
                  storeName={r.storeName}
                  onSelect={selectFacility}
                />
              )}

              {/* 신규 등록은 지도에 없던 POI 를 만드는 쓰기다. 좌표 한 자리를 잘못 쳐도 서버는
                  받아 주므로, 보내기 직전에 무엇이 생기는지 한 번 더 보여 준다.
                  기존 가게 연결·반려는 예전 그대로 곧장 처리한다(확인을 늘리면 심사가 느려진다). */}
              {confirmingId === r.id && selection?.mode === 'create' ? (
                <div className="mt-2 rounded-xl border border-gold/50 bg-gold/10 px-3 py-2.5">
                  <p className="text-[11px] leading-relaxed text-muk">
                    새 가게 <span className="font-semibold">{selection.newFacility.name}</span> 을(를)
                    좌표 {selection.newFacility.latitude}, {selection.newFacility.longitude} 에
                    등록하고 이 신청을 승인합니다.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={decidingId === r.id}
                      onClick={() => void decide(r, true)}
                      className="flex items-center gap-1 rounded-lg border border-jade/40 bg-jade/10 px-3 py-1.5 text-[11px] font-semibold text-jade disabled:opacity-40"
                    >
                      <Check size={13} /> 등록하고 승인
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="rounded-lg border border-line bg-white px-3 py-1.5 text-[11px] font-semibold text-muk-soft hover:text-muk"
                    >
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.documentPath && <EvidenceLink requestId={r.id} />}
                  <button
                    type="button"
                    disabled={blocked || decidingId === r.id}
                    onClick={() =>
                      selection?.mode === 'create' ? setConfirmingId(r.id) : void decide(r, true)
                    }
                    className="flex items-center gap-1 rounded-lg border border-jade/40 bg-jade/10 px-3 py-1.5 text-[11px] font-semibold text-jade disabled:opacity-40"
                  >
                    <Check size={13} />
                    {selection?.mode === 'link'
                      ? '연결하고 승인'
                      : selection?.mode === 'create'
                        ? '새 가게로 승인'
                        : '승인'}
                  </button>
                  <button
                    type="button"
                    disabled={decidingId === r.id}
                    onClick={() => void decide(r, false)}
                    className="flex items-center gap-1 rounded-lg border border-terracotta/40 bg-terracotta/10 px-3 py-1.5 text-[11px] font-semibold text-terracotta disabled:opacity-40"
                  >
                    <X size={13} /> 반려
                  </button>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// =========================================================================
// 미연결 신청에 가게(POI) 붙이기
// =========================================================================
// 심사 큐는 facility_id 가 없는 사업자 신청을 승인 불가로 막아 왔는데, 정작 매핑할 화면이
// 어디에도 없어서 사업자 승인이 한 건도 되지 않았다. 그 화면을 심사 카드 안에 둔다 —
// 심사자가 증빙을 보고 있는 자리에서 바로 가게를 고르는 게 맥락이 끊기지 않는다.

const FACILITY_TYPES = [
  { value: 'restaurant', label: '음식점' },
  { value: 'cafe', label: '카페' },
  { value: 'attraction', label: '관광지' },
  { value: 'culture', label: '문화시설' },
] as const;

type FacilityType = (typeof FACILITY_TYPES)[number]['value'];

function typeLabel(type: string): string {
  return FACILITY_TYPES.find((item) => item.value === type)?.label ?? type;
}

/** 신규 POI 등록 본문. 서버 계약과 같은 이름을 camelCase 로 쓴다(apiClient 가 snake 로 바꿔 보낸다). */
interface NewFacilityInput {
  name: string;
  type: FacilityType;
  latitude: number;
  longitude: number;
  address?: string;
  phone?: string;
  capacity?: number;
}

/**
 * 심사자가 고른 가게. **둘 중 하나만** 존재할 수 있는 판별 유니언이다.
 *
 * 서버는 facility_id 와 new_facility 를 함께 받으면 422 를 낸다. 갈래마다 상태를 따로 두면
 * "검색으로 하나 고른 뒤 마음을 바꿔 신규 폼도 채운" 화면이 두 값을 동시에 들고 있게 되고,
 * 그때 422 를 막는 일은 전송 직전 if 문의 몫이 된다. 값 하나로 들면 그 상태를 애초에 만들 수
 * 없다 — 검증으로 막는 대신 자료구조로 불가능하게 하는 쪽을 골랐다.
 */
type FacilitySelection =
  | { mode: 'link'; facilityId: string; facilityName: string }
  | { mode: 'create'; newFacility: NewFacilityInput };

/** 어느 갈래를 펼쳤는가. null 은 아직 아무 갈래도 열지 않은 상태다. */
type LinkBranch = 'link' | 'create' | null;

/**
 * 신규 등록 폼의 입력값은 **문자열로** 들고 있는다.
 *
 * 숫자 상태로 들면 '-' 나 '129.' 같은 입력 중간 단계를 표현할 수 없어 타이핑이 튄다.
 * 게다가 빈 칸을 Number('') 로 읽으면 0 이라, 위도를 비워 둔 신청이 조용히 적도에 등록된다.
 * 숫자로 바꾸는 건 선택값을 만들 때 한 번뿐이고, 그때 실패하면 값이 없는 것으로 둔다.
 */
interface NewFacilityDraft {
  name: string;
  type: FacilityType;
  latitude: string;
  longitude: string;
  address: string;
  phone: string;
  capacity: string;
}

/** 카카오 장소 검색 1건 — GET /api/v1/search/places 응답(keysToCamel 통과 후). */
interface PlaceHit {
  placeId: string;
  name: string;
  /** 카카오 카테고리에서 유추한 종류. cafe|restaurant 만 오고, 아예 없을 수도 있다. */
  type?: 'cafe' | 'restaurant' | null;
  latitude: number;
  longitude: number;
  address: string;
  phone?: string | null;
  categoryName?: string | null;
}

/**
 * 장소 검색의 결과 상태.
 *
 * '빈 목록' 하나로 뭉치지 않는다. 0건은 "카카오에도 그런 장소가 없다"이고, unavailable/failed 는
 * "물어보지 못했다"다. 심사자에게 이 둘은 완전히 다른 뜻이다 — 후자를 0건으로 보여 주면
 * 좌표를 직접 넣어 등록하면 될 일을 "등록할 수 없는 가게"로 읽고 신청을 덮어 둔다.
 */
type PlaceLookup =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'ok'; items: PlaceHit[] }
  /** 서버가 source:'unavailable' 로 알려 준 경우 — 카카오 키가 없거나 카카오가 죽었다. */
  | { kind: 'unavailable' }
  /** 호출 자체가 실패(네트워크·타임아웃). */
  | { kind: 'failed' };

/** 빈 칸은 '입력 안 함'(null)이지 0 이 아니다. Number('') 가 0 이라 그냥 넘기면 위도 0 이 된다. */
function parseNumeric(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

const inLatRange = (v: number) => v >= -90 && v <= 90;
const inLngRange = (v: number) => v >= -180 && v <= 180;

/** 정원 칸이 채워졌는데 양의 정수가 아니면 true. 빈 칸은 문제가 아니다(서버 기본값이 있다). */
function hasBadCapacity(raw: string): boolean {
  if (!raw.trim()) return false;
  const parsed = parseNumeric(raw);
  return parsed === null || !Number.isInteger(parsed) || parsed <= 0;
}

// 경주 대략 범위. **막지 않고 경고만** 한다 — 경주 밖 가게가 있을 수 있는 반면,
// 자릿수 하나 틀린 좌표(129.21 → 12.921)는 조용히 엉뚱한 곳에 가게를 만든다.
const GYEONGJU_LAT: readonly [number, number] = [35.6, 36.0];
const GYEONGJU_LNG: readonly [number, number] = [129.0, 129.5];

function isOutsideGyeongju(lat: number, lng: number): boolean {
  return (
    lat < GYEONGJU_LAT[0] || lat > GYEONGJU_LAT[1] || lng < GYEONGJU_LNG[0] || lng > GYEONGJU_LNG[1]
  );
}

/**
 * 펼쳐 둔 갈래에서 **보낼 수 있는 값 하나**를 만든다. 못 만들면 null 이고, null 이면 승인 버튼이 잠긴다.
 *
 * 닫힌 갈래의 입력값은 여기서 아예 읽히지 않는다. 그래서 검색으로 가게를 골라 둔 채 신규 폼을
 * 채워도 전송되는 건 열려 있는 쪽 하나뿐이다.
 */
function toSelection(
  branch: LinkBranch,
  picked: FacilityHit | null,
  draft: NewFacilityDraft,
): FacilitySelection | null {
  if (branch === 'link') {
    return picked ? { mode: 'link', facilityId: picked.id, facilityName: picked.name } : null;
  }
  if (branch === 'create') {
    const name = draft.name.trim();
    const latitude = parseNumeric(draft.latitude);
    const longitude = parseNumeric(draft.longitude);
    if (!name || latitude === null || longitude === null) return null;
    // 서버도 422 로 막지만 왕복을 기다릴 이유가 없다 — 어차피 고쳐야 하는 값이다.
    if (!inLatRange(latitude) || !inLngRange(longitude)) return null;
    if (hasBadCapacity(draft.capacity)) return null;

    const newFacility: NewFacilityInput = { name, type: draft.type, latitude, longitude };
    const address = draft.address.trim();
    if (address) newFacility.address = address;
    const phone = draft.phone.trim();
    if (phone) newFacility.phone = phone;
    // 정원은 비우면 보내지 않는다(서버 기본값). 적었는데 숫자가 아니면 위에서 이미 null 이다 —
    // 조용히 버리고 승인하면 심사자는 자기가 넣은 정원이 반영된 줄 안다.
    const capacity = parseNumeric(draft.capacity);
    if (capacity !== null) newFacility.capacity = capacity;
    return { mode: 'create', newFacility };
  }
  return null;
}

const FIELD_CLASS =
  'rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12px] font-normal text-muk focus:outline-none focus:ring-2 focus:ring-gold/40';

function branchChipClass(active: boolean): string {
  return `flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
    active
      ? 'border-gold bg-gold/15 text-gold-deep'
      : 'border-line bg-white text-muk-soft hover:bg-hanji hover:text-muk'
  }`;
}

/**
 * 미연결 사업자 신청에 가게를 붙이는 패널 — (A) 등록된 가게 연결, (B) 새 가게 등록.
 *
 * 두 갈래는 탭이라 한 번에 하나만 열린다. 고른 결과는 FacilitySelection 한 개로 카드에 올린다
 * (승인 버튼이 카드에 있어서다). 폼의 중간 입력값은 여기 남고 위로 올라가지 않는다.
 */
function FacilityLinkPanel({
  requestId,
  storeName,
  onSelect,
}: {
  requestId: string;
  storeName: string;
  onSelect: (requestId: string, selection: FacilitySelection | null) => void;
}) {
  const [branch, setBranch] = useState<LinkBranch>(null);
  // 검색어·이름의 기본값은 신청서의 가게 이름이다. 심사자가 한 글자도 치기 전에 후보가 뜨고,
  // 신청서와 다른 이름이면 그 자리에서 눈에 띈다.
  const [linkTerm, setLinkTerm] = useState(storeName);
  const [linkHits, setLinkHits] = useState<FacilityHit[]>([]);
  const [linkFailed, setLinkFailed] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [picked, setPicked] = useState<FacilityHit | null>(null);
  const [placeTerm, setPlaceTerm] = useState(storeName);
  const [places, setPlaces] = useState<PlaceLookup>({ kind: 'idle' });
  const [draft, setDraft] = useState<NewFacilityDraft>(() => ({
    name: storeName,
    type: 'restaurant',
    latitude: '',
    longitude: '',
    address: '',
    phone: '',
    capacity: '',
  }));

  const selection = useMemo(() => toSelection(branch, picked, draft), [branch, picked, draft]);

  // 승인 버튼은 카드가 그리므로 고른 값을 위로 올린다. onSelect 는 부모가 useCallback 으로
  // 고정했고 selection 은 useMemo 라, 값이 실제로 달라질 때만 한 번 올라간다(렌더 루프 방지).
  useEffect(() => {
    onSelect(requestId, selection);
  }, [onSelect, requestId, selection]);

  // (A) 등록된 가게 검색 — 300ms 디바운스. searchFacilities 는 던지지 않지만 실패 여부는 알려 준다.
  // 여기서 실패를 '결과 없음' 으로 그리면 안 된다: 아래 안내가 '새 가게로 등록' 을 권하는데,
  // Supabase 가 잠깐 흔들린 것뿐이면 이미 있는 가게에 **중복 유령 POI** 가 만들어지고
  // 되돌릴 자동 수단이 없다(features.origin='merchant_request' 로 지도에 그대로 남는다).
  //
  // 스피너 켜기와 목록 비우기까지 전부 타이머 안에서 한다. 이펙트 본문에서 곧장 setState 하면
  // 글자 하나마다 렌더가 한 번 더 돈다(react-hooks/set-state-in-effect) — 어차피 300ms 뒤의 일이다.
  useEffect(() => {
    if (branch !== 'link') return;
    const term = linkTerm.trim();
    let alive = true;
    const timer = setTimeout(async () => {
      if (!term) {
        setLinkHits([]);
        setLinkFailed(false);
        setLinkBusy(false);
        return;
      }
      setLinkBusy(true);
      const res = await searchFacilities({ term, limit: 8 });
      // 늦게 도착한 이전 검색이 최신 결과를 덮지 않게 한다(타이핑 중에는 요청이 겹친다).
      if (!alive) return;
      setLinkHits(res.items);
      setLinkFailed(res.failed);
      setLinkBusy(false);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [branch, linkTerm]);

  // (B) 카카오 장소 검색 — 자동 채움용. 한 글자로는 결과가 소음이라 두 글자부터 묻는다.
  useEffect(() => {
    if (branch !== 'create') return;
    const term = placeTerm.trim();
    let alive = true;
    const timer = setTimeout(async () => {
      if (term.length < 2) {
        setPlaces({ kind: 'idle' });
        return;
      }
      setPlaces({ kind: 'searching' });
      try {
        const res = await apiClient.get('/api/v1/search/places', {
          params: { q: term },
          timeoutMs: 4500,
        });
        if (!alive) return;
        setPlaces(
          res?.source === 'unavailable'
            ? { kind: 'unavailable' }
            : { kind: 'ok', items: Array.isArray(res?.items) ? res.items : [] },
        );
      } catch {
        // 여기서 빈 목록으로 눙치면 '카카오에 없는 가게'와 구분되지 않는다.
        if (alive) setPlaces({ kind: 'failed' });
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [branch, placeTerm]);

  /** 카카오 결과로 폼을 채운다. 채운 뒤에도 모든 칸은 그대로 고칠 수 있다 —
   *  카카오에 없는 가게가 이 경로의 존재 이유라 자동 채움은 어디까지나 초안이다. */
  const fillFromPlace = (place: PlaceHit) => {
    setDraft((prev) => ({
      ...prev,
      name: place.name || prev.name,
      // 카카오는 cafe|restaurant 만 주고 그마저 없을 수 있다. 모를 때 restaurant 로 덮으면
      // 심사자가 골라 둔 관광지·문화시설이 조용히 뒤집힌다 — 모르면 건드리지 않는다.
      type: place.type === 'cafe' || place.type === 'restaurant' ? place.type : prev.type,
      latitude: Number.isFinite(place.latitude) ? String(place.latitude) : prev.latitude,
      longitude: Number.isFinite(place.longitude) ? String(place.longitude) : prev.longitude,
      address: place.address || prev.address,
      phone: place.phone || prev.phone,
      // 정원은 카카오가 주지 않는다. 심사자가 적어 둔 값을 자동 채움이 지우지 않게 그대로 둔다.
    }));
  };

  const lat = parseNumeric(draft.latitude);
  const lng = parseNumeric(draft.longitude);
  const latBad = draft.latitude.trim() !== '' && (lat === null || !inLatRange(lat));
  const lngBad = draft.longitude.trim() !== '' && (lng === null || !inLngRange(lng));
  const farFromGyeongju = !latBad && !lngBad && lat !== null && lng !== null && isOutsideGyeongju(lat, lng);

  return (
    <div className="mt-2 rounded-xl border border-line bg-hanji px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setBranch((prev) => (prev === 'link' ? null : 'link'))}
          className={branchChipClass(branch === 'link')}
        >
          <Link2 size={12} /> 기존 가게 연결
        </button>
        <button
          type="button"
          onClick={() => setBranch((prev) => (prev === 'create' ? null : 'create'))}
          className={branchChipClass(branch === 'create')}
        >
          <Plus size={12} /> 새 가게로 등록
        </button>
        {selection?.mode === 'link' && (
          <span className="flex items-center gap-1 rounded-full border border-jade/40 bg-jade/10 px-2.5 py-1 text-[11px] font-semibold text-jade">
            연결 예정: {selection.facilityName}
            <button
              type="button"
              onClick={() => setPicked(null)}
              title="연결 해제"
              className="text-jade/70 transition-colors hover:text-terracotta"
            >
              <X size={12} />
            </button>
          </span>
        )}
      </div>

      {branch === 'link' && (
        <div className="mt-2.5">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muk-soft" />
            <input
              value={linkTerm}
              onChange={(e) => setLinkTerm(e.target.value)}
              placeholder="등록된 가게 이름으로 검색"
              className="w-full rounded-lg border border-line bg-white py-2 pl-8 pr-3 text-[12px] focus:outline-none focus:ring-2 focus:ring-gold/40"
            />
          </div>
          {picked && picked.name !== storeName && (
            <p className="mt-1.5 text-[11px] text-terracotta">
              고른 가게 이름이 신청서(<span className="font-semibold">{storeName}</span>)와 달라요.
              증빙을 한 번 더 확인하세요.
            </p>
          )}
          {linkBusy && <Loader2 size={14} className="mx-auto my-2 animate-spin text-muk-soft" />}
          <div className="mt-1.5 flex flex-col gap-1">
            {linkHits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => setPicked(hit)}
                className={`rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                  picked?.id === hit.id
                    ? 'border-jade/50 bg-jade/10'
                    : 'border-line bg-white hover:bg-hanji'
                }`}
              >
                <span className="font-semibold text-muk">{hit.name}</span>
                <span className="ml-1 text-muk-soft">· {typeLabel(hit.type)}</span>
                <span className="block truncate text-muk-soft">{hit.address || '주소 없음'}</span>
              </button>
            ))}
          </div>
          {!linkBusy && linkTerm.trim() !== '' && linkHits.length === 0 && (
            linkFailed ? (
              // 못 물어본 것이지 없는 것이 아니다 — 여기서 '새 가게로 등록' 을 권하면 중복 POI 가 생긴다.
              <p className="py-2 text-center text-[11px] text-terracotta">
                가게 검색을 지금 할 수 없어요. 잠시 후 다시 시도해 주세요 — 새로 등록하기 전에 꼭 다시 확인하세요.
              </p>
            ) : (
              <p className="py-2 text-center text-[11px] text-muk-soft">
                검색 결과가 없어요. 아직 등록되지 않은 가게라면 ‘새 가게로 등록’ 을 쓰세요.
              </p>
            )
          )}
        </div>
      )}

      {branch === 'create' && (
        <div className="mt-2.5 flex flex-col gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muk-soft" />
            <input
              value={placeTerm}
              onChange={(e) => setPlaceTerm(e.target.value)}
              placeholder="카카오에서 장소 찾아 자동 채우기(선택)"
              className="w-full rounded-lg border border-line bg-white py-2 pl-8 pr-3 text-[12px] focus:outline-none focus:ring-2 focus:ring-gold/40"
            />
          </div>

          {places.kind === 'searching' && (
            <Loader2 size={14} className="mx-auto animate-spin text-muk-soft" />
          )}
          {places.kind === 'ok' && places.items.length > 0 && (
            <div className="flex flex-col gap-1">
              {places.items.slice(0, 6).map((place) => (
                <button
                  key={place.placeId}
                  type="button"
                  onClick={() => fillFromPlace(place)}
                  className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-hanji"
                >
                  <span className="font-semibold text-muk">{place.name}</span>
                  {place.categoryName && (
                    <span className="ml-1 text-muk-soft">· {place.categoryName}</span>
                  )}
                  <span className="block truncate text-muk-soft">{place.address}</span>
                </button>
              ))}
            </div>
          )}
          {places.kind === 'ok' && places.items.length === 0 && (
            <p className="text-[11px] text-muk-soft">
              카카오에도 이 이름의 장소가 없어요. 아래 칸을 직접 채우면 그대로 등록됩니다.
            </p>
          )}
          {(places.kind === 'unavailable' || places.kind === 'failed') && (
            <p className="rounded-lg border border-terracotta/30 bg-terracotta/5 px-2.5 py-2 text-[11px] leading-relaxed text-terracotta">
              {places.kind === 'unavailable'
                ? '카카오 장소 검색을 지금 쓸 수 없어요(키 미설정 또는 카카오 장애).'
                : '장소 검색 요청이 실패했어요.'}{' '}
              아래 칸에 이름과 좌표를 직접 입력하면 등록할 수 있어요.
            </p>
          )}

          <label className="flex flex-col gap-1 text-[11px] font-semibold text-muk-soft">
            가게 이름
            <input
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="신청서의 가게 이름"
              className={FIELD_CLASS}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muk-soft">
              종류
              <select
                value={draft.type}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, type: e.target.value as FacilityType }))
                }
                className={FIELD_CLASS}
              >
                {FACILITY_TYPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muk-soft">
              정원(선택)
              <input
                value={draft.capacity}
                onChange={(e) => setDraft((prev) => ({ ...prev, capacity: e.target.value }))}
                inputMode="numeric"
                placeholder="비우면 기본값"
                className={FIELD_CLASS}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muk-soft">
              위도
              <input
                value={draft.latitude}
                onChange={(e) => setDraft((prev) => ({ ...prev, latitude: e.target.value }))}
                inputMode="decimal"
                placeholder="35.8342"
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muk-soft">
              경도
              <input
                value={draft.longitude}
                onChange={(e) => setDraft((prev) => ({ ...prev, longitude: e.target.value }))}
                inputMode="decimal"
                placeholder="129.2094"
                className={FIELD_CLASS}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-[11px] font-semibold text-muk-soft">
            주소(선택)
            <input
              value={draft.address}
              onChange={(e) => setDraft((prev) => ({ ...prev, address: e.target.value }))}
              className={FIELD_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-muk-soft">
            전화(선택)
            <input
              value={draft.phone}
              onChange={(e) => setDraft((prev) => ({ ...prev, phone: e.target.value }))}
              className={FIELD_CLASS}
            />
          </label>

          {(latBad || lngBad) && (
            <p className="text-[11px] font-semibold text-terracotta">
              위도는 -90~90, 경도는 -180~180 사이의 숫자여야 해요.
            </p>
          )}
          {hasBadCapacity(draft.capacity) && (
            <p className="text-[11px] font-semibold text-terracotta">
              정원은 1 이상의 정수로 적어 주세요. 모르면 비워 두면 됩니다.
            </p>
          )}
          {farFromGyeongju && (
            <p className="flex items-start gap-1.5 rounded-lg border border-terracotta/50 bg-terracotta/10 px-2.5 py-2 text-[11px] font-semibold leading-relaxed text-terracotta">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                경주 밖 좌표예요(경주는 대략 위도 35.6~36.0, 경도 129.0~129.5). 자릿수를 잘못 친 게
                아닌지 확인하세요. 실제로 경주 밖 가게라면 그대로 등록해도 됩니다.
              </span>
            </p>
          )}
          {!selection && (
            <p className="text-[11px] text-muk-soft">
              가게 이름과 좌표를 올바르게 채우면 승인 버튼이 켜져요.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 사업자등록증 열기 — 서버가 만든 **5분짜리 서명 URL** 로만 연다.
 *
 * 버킷은 비공개이고 신청자 본인만 자기 폴더를 읽을 수 있다. 심사자는 그 정책으로는 못 보므로
 * 백엔드가 service_role 로 서명해 준다. URL 을 상태에 담아 두지 않고 받는 즉시 새 탭으로
 * 넘기는 이유도 같다 — 화면에 오래 남을수록 링크가 새어 나갈 표면이 넓어진다. */
function EvidenceLink({ requestId }: { requestId: string }) {
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiClient.get(`/api/v1/dev/verification-requests/${requestId}/document`);
      const url = typeof res?.url === 'string' ? res.url : null;
      if (!url) throw new Error('no url');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(errorMessage(err) || '증빙을 열지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={busy}
      className="flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-[11px] font-semibold text-muk-soft hover:bg-hanji hover:text-muk disabled:opacity-40"
    >
      <FileText size={13} /> {busy ? '여는 중…' : '증빙 보기'}
    </button>
  );
}

/**
 * 개발자 승격 — 신청이 아니라 지목이다.
 *
 * 개발자는 모든 사용자의 역할을 바꾸고 가게 소유권을 줄 수 있다. 그래서 '신청을 받는' 구조를
 * 두지 않는다: 신청 큐가 있으면 누구나 문을 두드릴 수 있고, 심사자가 목록을 훑다 잘못 누르는
 * 순간이 생긴다. 대신 이미 개발자인 사람이 대상을 검색해 지목하고, 확인창을 한 번 더 거친다.
 *
 * 강등은 여기 없다 — '사용자·권한' 탭의 역할 버튼으로 한다. 권한을 거두는 쪽은 어렵게 만들
 * 이유가 없고, 마지막 개발자만 서버가 409 로 지킨다(잠김 방지).
 */
function DeveloperPromotion({ onChanged }: { onChanged: () => void }) {
  const [devs, setDevs] = useState<DevUser[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<DevUser[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const loadDevs = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiClient.get('/api/v1/dev/users', { params: { role: 'developer' } });
      setDevs(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      toast.error(errorMessage(err) || '개발자 목록 조회에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadDevs();
  }, [loadDevs]);

  const search = async () => {
    const term = q.trim();
    if (!term) {
      setFound(null);
      return;
    }
    try {
      const res = await apiClient.get('/api/v1/dev/users', { params: { q: term } });
      setFound(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      toast.error(errorMessage(err) || '사용자 조회에 실패했어요.');
    }
  };

  const nameOf = (u: DevUser) => u.nickname || u.email || u.id.slice(0, 8);

  const promote = async (u: DevUser) => {
    // 되돌릴 수는 있지만(강등) 그 사이에 무엇이든 할 수 있는 권한이라 한 번 더 묻는다.
    const ok = window.confirm(
      `${nameOf(u)} 님을 개발자로 승격합니다.\n\n` +
        '개발자는 모든 사용자의 역할을 바꾸고 가게 소유권을 부여할 수 있어요. 계속할까요?',
    );
    if (!ok) return;

    setPendingId(u.id);
    try {
      await apiClient.patch(`/api/v1/dev/users/${u.id}/role`, {
        role: 'developer',
        reason: '개발자 콘솔에서 직접 승격',
      });
      toast.success(`${nameOf(u)} → developer`);
      setFound(null);
      setQ('');
      await loadDevs();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err) || '승격에 실패했어요.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <>
      <p className="mb-4 rounded-xl border border-line bg-hanji px-3.5 py-3 text-[11px] leading-relaxed text-muk-soft">
        개발자 권한은 신청을 받지 않아요. 앱 어디에도 신청 경로가 없고, 아래에서 대상을 직접
        찾아 승격하는 길 하나뿐입니다.
      </p>

      <p className="mb-2 text-xs font-semibold text-muk-soft">
        현재 개발자
        {devs.length > 0 && <span className="ml-1 font-mono opacity-70">{devs.length}</span>}
      </p>
      {busy ? (
        <Loader2 size={16} className="mx-auto my-4 animate-spin text-muk-soft" />
      ) : (
        <div className="mb-5 flex flex-col gap-2">
          {devs.map((u) => (
            <div key={u.id} className="rounded-xl border border-line px-3.5 py-3">
              <p className="truncate text-sm font-semibold">{nameOf(u)}</p>
              <p className="font-mono text-[11px] text-muk-soft">{u.id}</p>
            </div>
          ))}
          {devs.length === 0 && (
            <p className="py-2 text-center text-sm text-muk-soft">개발자가 없어요.</p>
          )}
        </div>
      )}

      <p className="mb-2 text-xs font-semibold text-muk-soft">승격할 사용자 찾기</p>
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muk-soft" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            placeholder="이메일·닉네임 부분일치 또는 uid 정확일치"
            className="w-full rounded-xl border border-line bg-hanji py-2.5 pl-9 pr-3 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
          />
        </div>
        <button
          type="button"
          onClick={() => void search()}
          className="rounded-xl border border-line px-4 text-sm font-semibold hover:bg-hanji"
        >
          검색
        </button>
      </div>

      {found !== null && (
        <div className="flex flex-col gap-2">
          {found.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3.5 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{nameOf(u)}</p>
                <p className="font-mono text-[11px] text-muk-soft">
                  {u.id} · {u.role}
                </p>
              </div>
              <button
                type="button"
                disabled={u.role === 'developer' || pendingId === u.id}
                onClick={() => void promote(u)}
                className="flex items-center gap-1 rounded-lg border border-gold/40 bg-gold/10 px-3 py-1.5 text-[11px] font-semibold text-gold-deep disabled:opacity-40"
              >
                <Check size={13} />
                {u.role === 'developer' ? '이미 개발자' : '개발자로 승격'}
              </button>
            </div>
          ))}
          {found.length === 0 && (
            <p className="py-4 text-center text-sm text-muk-soft">결과가 없어요.</p>
          )}
        </div>
      )}
    </>
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
