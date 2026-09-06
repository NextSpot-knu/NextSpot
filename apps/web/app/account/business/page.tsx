'use client';

// 계정 역할 변경 신청 — 오프라인 확인(담당자가 실물 증거·소속 확인)의 '기록' 부분.
//
// 원래 사업자 인증 전용 화면이었다. 신청할 수 있는 역할이 둘(사업자·관리자)로 늘면서
// 화면을 하나로 합쳤다 — 큐도, 심사 화면도, 감사 로그도 이미 공용이라 화면만 나누면
// 사용자가 어느 문으로 들어가야 하는지 매번 골라야 한다.
//
// 실제 확인은 사람이 하되, 누가 무엇을 요청했는지는 시스템이 큐로 받는다. 승인 한 번으로
// 역할 임명(+사업자면 가게 소유권 부여)이 처리되고 감사 이력이 붙는다(백엔드 /api/v1/dev).
//
// developer 는 신청 대상이 아니다 — 팀 내부 권한이라 /dev 콘솔에서 직접 임명한다.
//
// 신청자가 자기 신청을 볼 수 있어야 한다. 예전에는 심사중이면 "확인을 기다리고 있어요" 두 줄이
// 전부였다 — 무엇으로 신청했는지, 언제 냈는지, 잘못 적은 것을 고칠 수 있는지 앱 안에 답이
// 없었고, 유일한 탈출구가 담당자에게 전화하는 것이었다. 그래서 진행 상태 카드(신청 내용 +
// 3단계 표시) · 신청 내역 · 취소 · 수정을 이 화면에 둔다. 수정은 PATCH(보낸 필드만 갱신),
// 취소는 withdraw 다. **역할만은 수정할 수 없다** — 역할이 바뀌면 심사 근거(증빙의 종류)도
// 달라지므로 취소 후 새로 신청하는 것이 맞고, 서버도 422 로 막는다.
//
// 가게 검색: 사업자 신청은 이름을 치면 등록된 POI 를 찾아 facility_id 를 붙인다. 이 값이 없으면
// 심사자가 승인할 때 소유권을 붙일 대상이 없어 큐에 쌓이기만 한다. 다만 **'목록에 없어요 ·
// 직접 입력' 경로를 항상 열어 둔다** — 카카오맵/TourAPI 에 없는 가게가 우리 앱을 못 쓰게 되면
// 안 되기 때문이다. 그때 facility_id 는 null 이고, 담당자가 확인 후 새 가게로 등록한다.
// 관리자 신청에는 검색이 없다(소속 기관은 POI 가 아니다).
//
// 증빙 정책: **확인이 끝나면 보관하지 않는다.** 승인·거절 어느 쪽이든 결정과 같은 호출에서
// 서류 경로와 사업자번호 뒤 4자리를 지운다. **신청자가 직접 취소(withdraw)해도 같이 지운다** —
// 심사가 끝나지 않았을 뿐 보관할 이유가 사라진 것은 같기 때문이다. 그래서 취소 버튼은 지워진다는
// 사실을 누르기 **전에** 알려야 한다(재신청하려면 서류를 다시 올려야 한다). 전체 번호는 어느
// 시점에도 저장하지 않으므로 이 화면에서도 받지 않는다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MYPAGE_BACK } from '@/lib/navigation';
import {
  ArrowLeft,
  Store,
  Clock,
  Check,
  X,
  ShieldCheck,
  Search,
  Link2,
  Edit2,
  Trash2,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient, httpStatus } from '@/lib/api-client';
import { createPublicClient } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAccount, canEnterMerchantConsole, canEnterAdminConsole } from '@/lib/account';
import { isRoleRequestPending } from '@/lib/accountRoles';
import { searchFacilities, type FacilityHit } from '@/lib/facilitySearch';

/** 신청 가능한 역할. 백엔드 REQUESTABLE_ROLES 와 같은 집합이어야 한다. */
type RequestableRole = 'merchant' | 'admin';

interface RequestRow {
  id: string;
  storeName: string;
  facilityId: string | null;
  /**
   * 연결된 가게 이름. **null 의 뜻이 하나가 아니다** — 연결이 없어도 null 이고, 연결은
   * 있는데 서버가 그 행을 못 읽어도 null 이다. 둘을 facilityId 로 갈라서 표시한다
   * (없는 것과 모르는 것을 같은 문장으로 말하지 않는다).
   */
  facilityName?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reviewNote: string | null;
  createdAt?: string | null;
  reviewedAt?: string | null;
  contact?: string | null;
  /** 증빙 첨부 여부만 온다 — 경로는 내려오지 않는다(심사자 외에는 볼 이유가 없다). */
  hasDocument?: boolean;
  /** 컬럼이 없는 DB(마이그레이션 미적용)에서는 undefined → merchant 로 읽는다. */
  requestedRole?: RequestableRole;
}

/** PATCH 본문. 보낸 필드만 갱신되고 명시적 null 은 지운다 — 그래서 값 타입에 null 이 있다. */
type RequestPatch = Record<string, string | null>;

/** 4개 로케일 → Intl BCP47 태그. 신청 일시는 사용자가 고른 언어로 읽혀야 한다(mypage/lab 과 동일). */
const INTL_LOCALE: Record<string, string> = {
  ko: 'ko-KR',
  en: 'en-US',
  ja: 'ja-JP',
  zh: 'zh-CN',
};

/** category.* 사전에 있는 시설 종류. 없는 값은 번역하지 않고 원문을 그대로 보여준다. */
const KNOWN_FACILITY_TYPES = new Set(['restaurant', 'cafe', 'attraction', 'culture', 'parking']);

export default function RoleChangeRequestPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const { account, status: accountStatus, refresh } = useAccount();

  const [requestedRole, setRequestedRole] = useState<RequestableRole>('merchant');
  const [storeName, setStoreName] = useState('');
  const [contact, setContact] = useState('');
  const [last4, setLast4] = useState('');
  // 사업자등록증 이미지. 심사자가 신청서의 가게 이름·facility_id 를 대조할 유일한 근거다 —
  // facility_id 는 신청 본문에 신청자가 적어 보내는 값이라 그 자체로는 아무것도 증명하지 않는다.
  const [docFile, setDocFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  // 목록 전체를 담는다. latest 는 파생값이다 — 예전에는 최신 1건만 담아서 "내가 예전에 낸
  // 신청이 어떻게 됐는지" 를 이 화면이 아예 모르고 있었다.
  const [items, setItems] = useState<RequestRow[]>([]);
  // 조회 실패를 빈 배열로 적지 않는다. 빈 배열은 '신청한 적 없음' 이라는 **다른 사실**이고,
  // 그걸로 뭉뚱그리면 화면이 "신청 내역이 없어요" 라고 거짓말한다. 실패는 실패라고 말한다.
  const [listError, setListError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 수정 중인 신청(없으면 새 신청 폼). 폼 하나를 두 용도로 쓰되 제출 동사만 갈린다(POST/PATCH).
  const [editing, setEditing] = useState<RequestRow | null>(null);
  // 취소 확인은 인페이지로 받는다 — 브라우저 confirm() 은 이 앱의 관례가 아니고(saved·settings 참고),
  // 무엇보다 "증빙이 함께 지워진다" 는 경고를 확인창 안에 함께 보여줘야 한다.
  const [withdrawArmed, setWithdrawArmed] = useState(false);

  // 가게 연결(사업자 신청 전용).
  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [linkedName, setLinkedName] = useState<string | null>(null);
  // '목록에 없어요 · 직접 입력' 경로. 이걸 켜면 검색을 멈추고 자유 입력으로 받는다.
  const [manualEntry, setManualEntry] = useState(false);
  // 결과에 **어떤 검색어의 결과인지** 를 함께 담는다. 그래야 타이핑 도중 이전 검색어의 결과가
  // 잠깐 남아 "왜 이 가게가 나왔지" 가 생기는 것을 렌더 단계에서 걸러 낼 수 있다.
  const [searchResult, setSearchResult] = useState<{ term: string; items: FacilityHit[]; failed: boolean } | null>(null);

  // 언마운트 후 setState 를 막는 가드. 조회는 마운트 effect 와 재시도 버튼 두 곳에서 부르므로
  // effect 지역 변수 대신 ref 로 둔다(같은 함수를 두 벌 쓰지 않기 위해서다).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/v1/account/verification-requests/mine');
      if (!aliveRef.current) return;
      const rows: RequestRow[] = Array.isArray(res?.items) ? res.items : [];
      setItems(rows);
      setListError(false);
    } catch {
      if (!aliveRef.current) return;
      // 알던 목록은 지우지 않는다 — 재시도가 실패했다고 이미 보여준 내역을 없앨 이유는 없다.
      setListError(true);
    } finally {
      if (aliveRef.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // 비동기 콜백 안에서 부른다 — 이펙트 본문에서 바로 부르면 setState 가 동기 호출로 읽혀
    // react-hooks/set-state-in-effect 가 걸린다(실제로는 첫 await 뒤에야 상태를 만진다).
    void (async () => {
      await loadRequests();
    })();
  }, [loadRequests]);

  const isMerchantRequest = requestedRole === 'merchant';
  // **선택한 역할의** 최신 신청. 그냥 items[0] 이면 역할을 가리지 않은 '가장 최근 건' 이라,
  // 사업자 신청이 대기 중일 때 관리자 신청을 하나 더 내면 items[0] 이 그쪽으로 바뀌고
  // **먼저 낸 사업자 신청은 어느 탭에서도 취소·수정 버튼이 없는 상태**가 됐다(내역 목록에는
  // 버튼이 없다). 관리자 건을 철회해도 created_at 순서는 그대로라 영영 손댈 수 없었다 —
  // 남는 탈출구가 담당자에게 전화하는 것뿐인데, 그게 이 화면이 없애려던 상태다.
  // (pending 이 둘 생기는 것은 막지 않는 설계다: 사장님이 관리자 권한을 신청할 수 있어야 한다.)
  // items 는 created_at desc 라 find 가 곧 '그 역할의 최신 건' 이다.
  const latest = items.find((r) => (r.requestedRole ?? 'merchant') === requestedRole) ?? null;
  const trimmedTerm = storeName.trim();
  // 검색 UI 를 띄우는 조건. 관리자 신청에는 붙일 POI 가 없고, 이미 고른 뒤나 직접 입력을
  // 택한 뒤에 목록이 계속 열려 있으면 방금 한 선택을 다시 묻는 꼴이다.
  const showSearch = isMerchantRequest && !manualEntry && !facilityId;
  const hitsForTerm = searchResult && searchResult.term === trimmedTerm ? searchResult.items : null;
  const searching = showSearch && trimmedTerm.length > 0 && hitsForTerm === null;

  useEffect(() => {
    if (!showSearch) return;
    const term = storeName.trim();
    if (!term) return;
    let alive = true;
    // 300ms 디바운스 — 글자마다 Supabase 를 때리면 결과가 뒤늦게 뒤섞여 도착한다.
    const timer = setTimeout(() => {
      void (async () => {
        // searchFacilities 는 throw 하지 않는다. 다만 '못 찾았다' 와 '못 물어봤다' 는 다르다 —
        // 후자를 '검색 결과가 없어요' 로 그리면, 자기 가게가 DB 에 있는데도 자유 입력으로 밀려난다.
        const res = await searchFacilities({ term, limit: 8 });
        if (alive) setSearchResult({ term, items: res.items, failed: res.failed });
      })();
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [showSearch, storeName]);

  const resetForm = useCallback(() => {
    setStoreName('');
    setContact('');
    setLast4('');
    setDocFile(null);
    setFacilityId(null);
    setLinkedName(null);
    setManualEntry(false);
    setSearchResult(null);
  }, []);

  const formatDateTime = useCallback(
    (iso: string | null | undefined): string | null => {
      if (!iso) return null;
      const ms = new Date(iso).getTime();
      // 못 읽는 값은 null 로 돌려 호출부가 줄 자체를 그리지 않게 한다 — 'Invalid Date' 를
      // 화면에 내보내느니 아무 말도 하지 않는 편이 낫다.
      if (Number.isNaN(ms)) return null;
      try {
        return new Date(ms).toLocaleString(INTL_LOCALE[locale] ?? 'ko-KR', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return null;
      }
    },
    [locale],
  );

  const roleLabel = useCallback(
    (role: RequestableRole | undefined) =>
      role === 'admin' ? t('account.roleAdmin') : t('account.roleMerchant'),
    [t],
  );

  const statusLabel = useCallback(
    (status: string) => {
      if (status === 'pending') return t('account.statusPending');
      if (status === 'approved') return t('account.statusApproved');
      if (status === 'rejected') return t('account.statusRejected');
      if (status === 'withdrawn') return t('account.statusWithdrawn');
      return status; // 모르는 상태를 아는 척하지 않는다
    },
    [t],
  );

  const statusBadgeClass = (status: string) => {
    if (status === 'approved') return 'bg-jade/15 text-jade';
    if (status === 'rejected') return 'bg-terracotta/15 text-terracotta';
    if (status === 'withdrawn') return 'bg-muk/10 text-muk-soft';
    return 'bg-gold/15 text-gold-deep';
  };

  const typeLabel = (type: string) =>
    KNOWN_FACILITY_TYPES.has(type) ? t(`category.${type}`) : type;

  const MAX_DOC_BYTES = 5 * 1024 * 1024; // 버킷 제한과 같은 값(20260904200000)
  const pickDocument = (file: File | null) => {
    if (file && file.size > MAX_DOC_BYTES) {
      toast.error(t('account.docTooLarge'));
      return;
    }
    setDocFile(file);
  };

  const uploadDocument = async (file: File): Promise<string> => {
    setUploading(true);
    try {
      const supabase = createPublicClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('no session');
      // 경로 규약은 '<uid>/<파일명>' 이다 — 스토리지 정책이 첫 세그먼트를 auth.uid() 와
      // 대조해 남의 폴더에 올리는 것을 막는다(20260904200000).
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 8);
      const path = `${user.id}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from('business-documents')
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (error) throw error;
      return path;
    } finally {
      setUploading(false);
    }
  };

  const chooseRole = (role: RequestableRole) => {
    setRequestedRole(role);
    // 역할을 바꾸면 가게 연결은 의미를 잃는다(관리자 신청의 '소속 기관'은 POI 가 아니다).
    // 남겨 두면 사업자 → 관리자 → 사업자로 오갔을 때 엉뚱한 가게가 조용히 붙어 나간다.
    setFacilityId(null);
    setLinkedName(null);
    setManualEntry(false);
  };

  const changeStoreName = (value: string) => {
    setStoreName(value);
    // 이름을 고쳐 쓰는 것은 '다른 가게를 찾는 중' 이라는 뜻이다. 연결을 그대로 두면 화면에 보이는
    // 이름과 실제로 붙는 facility_id 가 어긋난 채 제출된다.
    if (facilityId) {
      setFacilityId(null);
      setLinkedName(null);
    }
  };

  const pickFacility = (hit: FacilityHit) => {
    setFacilityId(hit.id);
    setLinkedName(hit.name);
    setStoreName(hit.name);
    setManualEntry(false);
  };

  const unlinkFacility = () => {
    setFacilityId(null);
    setLinkedName(null);
  };

  const startEdit = (row: RequestRow) => {
    setEditing(row);
    setWithdrawArmed(false);
    setRequestedRole(row.requestedRole ?? 'merchant');
    setStoreName(row.storeName);
    setContact(row.contact ?? '');
    // 뒤 4자리는 목록에 내려오지 않는다(심사 전에도 최소 노출) — 원래 값을 모르므로 빈 칸으로 연다.
    setLast4('');
    setDocFile(null);
    setFacilityId(row.facilityId);
    setLinkedName(row.facilityName ?? null);
    // 연결 없이 낸 신청은 직접 입력 경로로 연다. 검색 목록이 곧바로 펼쳐지면 이미 적어 둔 이름을
    // 다시 고르라고 재촉하는 꼴인데, 애초에 목록에 없어서 그렇게 낸 사람이 대부분이다.
    setManualEntry(!row.facilityId);
    setSearchResult(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    resetForm();
  };

  /**
   * 바뀐 필드만 골라 PATCH 본문을 만든다.
   *
   * 서버는 **보내지 않은 필드는 그대로 두고 명시적 null 은 지운다.** 그래서 안 바꾼 값을 같이
   * 실어 보내면(무해해 보여도) '지움' 과 '그대로 둠' 의 경계가 화면 쪽 실수 하나로 무너진다.
   */
  const buildPatch = (row: RequestRow, uploadedPath: string | null): RequestPatch => {
    const patch: RequestPatch = {};
    const nextStore = storeName.trim();
    if (nextStore !== row.storeName) patch.storeName = nextStore;
    const nextContact = contact.trim();
    if (nextContact !== (row.contact ?? '')) patch.contact = nextContact;
    // 뒤 4자리는 원래 값을 모른다(위 startEdit 주석). 빈 칸을 '지워 달라'로 읽으면 손대지 않은
    // 사람의 번호가 사라지므로, 새로 입력했을 때만 보낸다.
    const nextLast4 = last4.trim();
    if (isMerchantRequest && nextLast4) patch.businessNumberLast4 = nextLast4;
    const nextFacilityId = isMerchantRequest ? facilityId : null;
    if (nextFacilityId !== (row.facilityId ?? null)) patch.facilityId = nextFacilityId;
    if (uploadedPath) patch.documentPath = uploadedPath;
    return patch;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!storeName.trim() || !contact.trim()) return;
    // 증빙은 **새 신청에만** 강제한다. 수정에서는 이미 올린 서류가 그대로 남아 있어서, 파일을
    // 다시 고르라고 요구하면 이름 한 글자를 고치려던 사람에게 재업로드를 시키는 셈이다.
    if (!editing && isMerchantRequest && !docFile) return;
    // 서버는 뒤 4자리에 정확히 4자리 패턴을 건다(선택 입력이지만 '두 자리'는 없다). 여기서
    // 안 막으면 Pydantic 의 영문 패턴 메시지가 사용자에게 그대로 뜬다.
    if (isMerchantRequest && last4.trim() && last4.trim().length !== 4) {
      toast.error(t('account.bizLast4Invalid'));
      return;
    }
    setBusy(true);
    try {
      // 증빙을 **먼저** 올린다. 업로드가 실패했는데 신청만 접수되면 심사자는 근거 없는
      // 신청을 받고, 신청자는 낸 줄 안다. 실패하면 여기서 멈추고 신청서를 만들지 않는다.
      let documentPath: string | null = null;
      if (isMerchantRequest && docFile) {
        documentPath = await uploadDocument(docFile);
      }

      if (editing) {
        const patch = buildPatch(editing, documentPath);
        if (Object.keys(patch).length === 0) {
          toast(t('account.editNoChanges'));
          return;
        }
        const updated: RequestRow = await apiClient.patch(
          `/api/v1/account/verification-requests/${editing.id}`,
          patch,
        );
        // 보낸 값을 화면에도 반영한다. 서버가 200 을 준 이상 그대로 적용된 것이고, 응답이 일부
        // 필드를 빼고 오더라도 옛 값이 남아 "고쳤는데 그대로네" 가 되면 안 된다. 응답에 있는
        // 필드는 응답을 최종 권위로 삼는다(facilityName 이 null 이면 서버가 못 읽은 것이다).
        const echo: Partial<RequestRow> = {};
        if ('storeName' in patch) echo.storeName = patch.storeName ?? editing.storeName;
        if ('contact' in patch) echo.contact = patch.contact;
        if ('facilityId' in patch) {
          echo.facilityId = patch.facilityId;
          echo.facilityName = patch.facilityId ? linkedName : null;
        }
        if (patch.documentPath) echo.hasDocument = true;
        setItems((prev) =>
          prev.map((row) => (row.id === editing.id ? { ...row, ...echo, ...updated } : row)),
        );
        setEditing(null);
        resetForm();
        toast.success(t('account.editSuccess'));
        void refresh(); // pendingVerification 반영
      } else {
        const created: RequestRow = await apiClient.post('/api/v1/account/verification-requests', {
          storeName: storeName.trim(),
          contact: contact.trim(),
          // 사업자번호는 사업자 신청에만 의미가 있다 — 관리자 신청에서는 보내지 않는다.
          businessNumberLast4: isMerchantRequest ? last4.trim() || null : null,
          // 검색에서 고른 가게. '목록에 없어요' 경로면 null 이고, 담당자가 확인 후 새로 등록한다.
          facilityId: isMerchantRequest ? facilityId : null,
          documentPath,
          requestedRole,
        });
        // listError 는 여기서 끄지 않는다. 새 신청 한 건을 받았다고 해서 **못 읽은 과거 내역**이
        // 읽힌 것은 아니다 — 끄면 아래 내역 섹션이 지금 보이는 목록을 전부인 양 말하게 된다.
        setItems((prev) => [
          // facilityName 은 조인 결과라 생성 응답에 없을 수 있다 — 그때는 방금 고른 이름을 쓴다.
          { ...created, facilityName: created.facilityName ?? linkedName },
          ...prev,
        ]);
        resetForm();
        void refresh(); // pendingVerification 반영
      }
    } catch (err) {
      const fallback = editing ? t('account.editFailed') : t('account.submitFailed');
      toast.error(errorMessage(err) || fallback);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (row: RequestRow) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiClient.post(`/api/v1/account/verification-requests/${row.id}/withdraw`);
      // 서버가 철회와 **같은 호출에서** 증빙을 지운다. 그래서 hasDocument 도 함께 내려야
      // 내역이 "첨부됨" 이라고 남아 있지 않다(있지도 않은 파일을 있다고 말하지 않는다).
      setItems((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, status: 'withdrawn', hasDocument: false } : r)),
      );
      setWithdrawArmed(false);
      setEditing(null);
      resetForm();
      toast.success(t('account.withdrawSuccess'));
      // 목록을 고친 **뒤에** 계정을 새로 고친다. pendingVerification 이 남아 있으면 목록 조회가
      // 실패한 다음 방문에서 이 화면이 다시 '심사중' 으로 잠긴다(isRoleRequestPending 의 폴백).
      void refresh();
    } catch (err) {
      const status = httpStatus(err);
      if (status === 409) {
        // 이미 심사가 끝난 건이다 — 화면이 낡았다는 뜻이므로 목록을 다시 읽는다.
        toast.error(t('account.withdrawGone'));
        void loadRequests();
      } else if (status === 404) {
        toast.error(t('account.withdrawNotFound'));
        void loadRequests();
      } else {
        toast.error(errorMessage(err) || t('account.withdrawFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  // 게스트는 신청할 수 없다 — 승인 대상을 특정할 수 없고, 단말을 지우면 권한이 사라진다.
  const isGuest = !account || account.isAnonymous;

  // 심사중 판정에 근거가 둘이다. 목록 조회(latest)가 자세하지만 실패할 수 있고, 그때
  // `loaded` 는 true 인데 `latest` 가 null 이라 **심사중인 사람에게 빈 신청 폼이 다시 열린다.**
  // 마이페이지 카드는 account.pendingVerification 으로 "심사중" 이라 말하는데 눌러 들어오면
  // 폼이 나오는 어긋남이 정확히 이 경로에서 생긴다. 그래서 목록이 비면 계정 컨텍스트를 믿는다
  // — 서버가 같은 사실을 두 경로로 말하고 있고, 둘 중 살아 있는 쪽을 쓰는 것이 맞다.
  //
  // 판정은 **선택한 역할 기준**이다(바로 아래 alreadyHasRole 과 같은 기준). 이유는
  // lib/accountRoles.ts 의 isRoleRequestPending 주석 참조.
  const isPending = isRoleRequestPending(requestedRole, latest, !!account?.pendingVerification);
  // 이미 그 권한이 있으면 폼 대신 콘솔로 안내한다. **선택한 역할 기준**으로 판정한다 —
  // 사장님이 관리자 권한을 신청하는 경우가 있어, 역할과 무관하게 막으면 길이 없다.
  const alreadyHasRole = isMerchantRequest
    ? canEnterMerchantConsole(account)
    : canEnterAdminConsole(account);

  // 수정 중에는 진행 상태 카드 대신 폼을 연다(카드 자리에서 폼으로 바뀌므로 화면이 튀지 않는다).
  const mainBranch: 'console' | 'guest' | 'progress' | 'form' = alreadyHasRole
    ? 'console'
    : isGuest && accountStatus !== 'loading'
      ? 'guest'
      : loaded && isPending && !editing
        ? 'progress'
        : 'form';

  // 진행 중인 한 건이 내역의 전부라면, 아래 목록은 위 카드와 같은 내용을 두 번 말하는 꼴이다.
  // (진행 카드가 안 보이는 분기 — 예: 사업자 신청이 심사중인데 관리자 탭을 연 경우 — 에서는
  //  그 한 건이 화면 어디에도 없게 되므로 목록을 그린다.)
  const historyRedundant = mainBranch === 'progress' && items.length === 1;
  const showHistory =
    loaded &&
    (mainBranch === 'progress' || mainBranch === 'form') &&
    // 조회가 실패했으면 중복을 감수하고서라도 섹션을 그린다 — 못 읽었다는 사실을 말할 자리가
    // 여기밖에 없고, 침묵은 '내역이 이게 전부' 라는 잘못된 인상을 준다.
    (listError || (items.length > 0 && !historyRedundant));

  const progressSteps = [
    t('account.stepReceived'),
    t('account.stepReviewing'),
    t('account.stepResult'),
  ];

  const roleOptions: { key: RequestableRole; label: string; desc: string; Icon: typeof Store }[] = [
    {
      key: 'merchant',
      label: t('account.roleMerchant'),
      desc: t('account.roleMerchantDesc'),
      Icon: Store,
    },
    {
      key: 'admin',
      label: t('account.roleAdmin'),
      desc: t('account.roleAdminDesc'),
      Icon: ShieldCheck,
    },
  ];

  const renderDetail = (label: string, value: string) => (
    <div key={label} className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[11px] font-semibold text-muk-soft">{label}</dt>
      <dd className="text-right text-xs leading-relaxed">{value}</dd>
    </div>
  );

  return (
    <main className="min-h-screen bg-hanji text-muk px-5 py-7 font-sans">
      <div className="mx-auto max-w-md">
        <header className="mb-6 flex items-center gap-2">
          <button
            type="button"
            // 목적지를 못박는다 — 딥링크·새로고침이면 back() 은 죽는다(MYPAGE_BACK 주석).
            onClick={() => router.push(MYPAGE_BACK)}
            aria-label={t('common.back')}
            className="rounded-xl border border-line bg-white p-2.5"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="font-serif text-xl font-bold tracking-tight">
            {t('account.roleRequestTitle')}
          </h1>
        </header>

        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-gold/30 bg-gold/10 p-4">
          {isMerchantRequest ? (
            <Store size={20} className="mt-0.5 shrink-0 text-gold-deep" />
          ) : (
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-gold-deep" />
          )}
          <p className="text-xs leading-relaxed text-muk-soft">
            {isMerchantRequest ? t('account.businessDesc') : t('account.adminDesc')}
          </p>
        </div>

        {/* 역할 선택은 어느 분기에서도 보인다 — '이미 사장님'이어도 관리자 권한은 신청할 수 있다.
            단 수정 중에는 잠근다: 서버가 requested_role 변경을 422 로 막는다(취소 후 재신청). */}
        <fieldset className="mb-5" disabled={!!editing}>
          <legend className="mb-2 text-xs font-semibold text-muk-soft">
            {t('account.roleLabel')}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {roleOptions.map(({ key, label, desc, Icon }) => {
              const selected = requestedRole === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => chooseRole(key)}
                  className={`rounded-2xl border p-3.5 text-left transition-colors disabled:opacity-60 ${
                    selected
                      ? 'border-gold bg-gold/10'
                      : 'border-line bg-white hover:border-gold/40'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-bold">
                    <Icon size={16} className={selected ? 'text-gold-deep' : 'text-muk-soft'} />
                    {label}
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug text-muk-soft">{desc}</span>
                </button>
              );
            })}
          </div>
          {editing && (
            <p className="mt-2 text-[11px] leading-relaxed text-muk-soft">
              {t('account.editRoleLocked')}
            </p>
          )}
        </fieldset>

        {mainBranch === 'console' ? (
          <div className="rounded-3xl border border-line bg-white p-6 text-center">
            <Check size={22} className="mx-auto mb-2 text-jade" />
            <p className="font-bold">
              {isMerchantRequest ? t('account.approvedTitle') : t('account.adminApprovedTitle')}
            </p>
            <p className="mt-1 text-xs text-muk-soft">
              {isMerchantRequest ? t('account.approvedDesc') : t('account.adminApprovedDesc')}
            </p>
            <button
              type="button"
              onClick={() => router.push(isMerchantRequest ? '/merchant' : '/admin/dashboard')}
              className="mt-4 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white"
            >
              {isMerchantRequest ? t('account.goConsole') : t('account.goAdminConsole')}
            </button>
          </div>
        ) : mainBranch === 'guest' ? (
          <div className="rounded-3xl border border-line bg-white p-6 text-center">
            <p className="text-sm font-semibold">{t('account.needAccount')}</p>
            <button
              type="button"
              onClick={() => router.push('/login?next=/account/business')}
              className="mt-4 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white"
            >
              {t('landing.ctaLogin')}
            </button>
          </div>
        ) : mainBranch === 'progress' ? (
          <section className="rounded-3xl border border-line bg-white p-6">
            <div className="text-center">
              <Clock size={22} className="mx-auto mb-2 text-gold-deep" />
              <p className="font-bold">{t('account.pendingTitle')}</p>
              <p className="mt-1 text-xs text-muk-soft">{t('account.pendingDesc')}</p>
            </div>

            {/* 3단계 진행 — 이 카드는 pending 에서만 그리므로 현재 위치는 항상 '확인 중'이다. */}
            <ol className="mt-5 flex items-start" aria-label={t('account.requestStatusTitle')}>
              {progressSteps.map((label, index) => {
                const done = index === 0;
                const current = index === 1;
                return (
                  <li
                    key={label}
                    className="flex flex-1 flex-col items-center gap-1"
                    aria-current={current ? 'step' : undefined}
                  >
                    <div className="flex w-full items-center">
                      <span
                        className={`h-0.5 flex-1 ${index === 0 ? 'bg-transparent' : 'bg-gold'}`}
                      />
                      <span
                        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[10px] font-bold ${
                          done
                            ? 'border-gold bg-gold text-white'
                            : current
                              ? 'border-gold bg-gold/15 text-gold-deep'
                              : 'border-line bg-white text-muk-soft'
                        }`}
                      >
                        {done ? <Check size={12} /> : index + 1}
                      </span>
                      <span
                        className={`h-0.5 flex-1 ${
                          index === progressSteps.length - 1 ? 'bg-transparent' : 'bg-line'
                        }`}
                      />
                    </div>
                    <span
                      className={`text-[10px] ${current ? 'font-bold text-gold-deep' : 'text-muk-soft'}`}
                    >
                      {label}
                    </span>
                  </li>
                );
              })}
            </ol>

            {latest ? (
              <>
                <div className="mt-5 rounded-2xl border border-line bg-hanji p-4">
                  <span
                    className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-bold ${statusBadgeClass('pending')}`}
                  >
                    {roleLabel(latest.requestedRole)}
                  </span>
                  <dl className="mt-2 divide-y divide-line/60">
                    {renderDetail(
                      (latest.requestedRole ?? 'merchant') === 'admin'
                        ? t('account.orgName')
                        : t('account.storeName'),
                      latest.storeName,
                    )}
                    {/* 서버가 아직 안 내려주는 필드는 '없음'으로 단정하지 않고 줄을 생략한다. */}
                    {latest.contact ? renderDetail(t('account.contact'), latest.contact) : null}
                    {formatDateTime(latest.createdAt)
                      ? renderDetail(
                          t('account.requestedAtLabel'),
                          formatDateTime(latest.createdAt) as string,
                        )
                      : null}
                    {(latest.requestedRole ?? 'merchant') === 'merchant'
                      ? renderDetail(
                          t('account.linkedStoreLabel'),
                          latest.facilityId
                            ? (latest.facilityName ?? t('account.linkedNameUnknown'))
                            : t('account.linkedNone'),
                        )
                      : null}
                    {(latest.requestedRole ?? 'merchant') === 'merchant' &&
                    typeof latest.hasDocument === 'boolean'
                      ? renderDetail(
                          t('account.documentFieldLabel'),
                          latest.hasDocument
                            ? t('account.documentAttached')
                            : t('account.documentMissing'),
                        )
                      : null}
                  </dl>
                </div>

                {withdrawArmed ? (
                  <div className="mt-4 rounded-2xl border border-terracotta/40 bg-terracotta/10 p-4">
                    <p className="flex items-center gap-1.5 text-xs font-bold text-terracotta">
                      <AlertTriangle size={14} />
                      {t('account.withdrawConfirmTitle')}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muk-soft">
                      {t('account.withdrawConfirmDesc')}
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void withdraw(latest)}
                        className="rounded-xl bg-terracotta py-2.5 text-xs font-bold text-white disabled:opacity-50"
                      >
                        {busy ? t('account.withdrawing') : t('account.withdrawConfirmAction')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setWithdrawArmed(false)}
                        className="rounded-xl border border-line bg-white py-2.5 text-xs font-bold disabled:opacity-50"
                      >
                        {t('account.withdrawKeep')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(latest)}
                        className="flex items-center justify-center gap-1.5 rounded-xl border border-line bg-white py-2.5 text-xs font-bold"
                      >
                        <Edit2 size={14} />
                        {t('account.editRequest')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setWithdrawArmed(true)}
                        className="flex items-center justify-center gap-1.5 rounded-xl border border-terracotta/40 bg-white py-2.5 text-xs font-bold text-terracotta"
                      >
                        <Trash2 size={14} />
                        {t('account.withdrawRequest')}
                      </button>
                    </div>
                    {/* 누르기 **전에** 알린다 — 증빙은 취소와 같은 호출에서 서버가 지운다. */}
                    <p className="mt-2 text-[11px] leading-relaxed text-muk-soft">
                      {t('account.withdrawNotice')}
                    </p>
                  </>
                )}
              </>
            ) : (
              // 계정 컨텍스트만으로 '심사중' 을 아는 경로다(목록 조회 실패). 상세를 지어내지 않고,
              // 무엇을 못 하고 있는지 말한 뒤 다시 시도할 길을 준다 — 취소·수정은 신청 id 가
              // 있어야 하므로 여기서는 낼 수 없다.
              <div className="mt-5 rounded-2xl border border-line bg-hanji p-4 text-center">
                <p className="text-xs font-semibold">{t('account.historyUnavailable')}</p>
                <p className="mt-1 text-[11px] text-muk-soft">
                  {t('account.historyUnavailableDesc')}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void loadRequests()}
                  className="mt-3 rounded-xl border border-line bg-white px-4 py-2 text-xs font-bold disabled:opacity-50"
                >
                  {t('common.retry')}
                </button>
              </div>
            )}
          </section>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-3xl border border-line bg-white p-6">
            {editing && (
              <div className="flex items-start gap-2 rounded-xl border border-gold/30 bg-gold/10 p-3">
                <Edit2 size={16} className="mt-0.5 shrink-0 text-gold-deep" />
                <p className="text-xs font-bold text-gold-deep">{t('account.editTitle')}</p>
              </div>
            )}

            {!editing && loaded && latest?.status === 'rejected' && (
              <div className="flex items-start gap-2 rounded-xl border border-terracotta/30 bg-terracotta/10 p-3">
                <X size={16} className="mt-0.5 shrink-0 text-terracotta" />
                <div>
                  <p className="text-xs font-bold text-terracotta">{t('account.rejectedTitle')}</p>
                  {latest.reviewNote && (
                    <p className="mt-0.5 text-xs text-muk-soft">{latest.reviewNote}</p>
                  )}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="store-name" className="mb-1.5 block text-xs font-semibold text-muk-soft">
                {isMerchantRequest ? t('account.storeName') : t('account.orgName')}
              </label>
              <div className="relative">
                <input
                  id="store-name"
                  value={storeName}
                  onChange={(e) => changeStoreName(e.target.value)}
                  required
                  maxLength={200}
                  autoComplete="off"
                  className={`w-full rounded-xl border border-line bg-hanji py-3 pl-3.5 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40 ${
                    isMerchantRequest ? 'pr-10' : 'pr-3.5'
                  }`}
                />
                {isMerchantRequest && (
                  <Search
                    size={16}
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-muk-soft"
                  />
                )}
              </div>

              {/* 연결됨 칩 — 무엇에 붙는지 이름으로 확인시키고, 언제든 뗄 수 있게 둔다. */}
              {isMerchantRequest && facilityId && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-jade/40 bg-jade/10 px-3 py-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-jade">
                    <Link2 size={13} className="shrink-0" />
                    <span className="truncate">
                      {t('account.linkedChip', {
                        name: linkedName ?? t('account.linkedNameUnknown'),
                      })}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={unlinkFacility}
                    className="shrink-0 text-[11px] font-bold text-muk-soft underline"
                  >
                    {t('account.unlinkFacility')}
                  </button>
                </div>
              )}

              {/* '목록에 없어요' 경로 — 이 기능의 핵심이다. 카카오맵/TourAPI 에 없는 가게도
                  신청할 수 있어야 하고, 그때 facility_id 는 null 인 채로 접수된다. */}
              {isMerchantRequest && manualEntry && !facilityId && (
                <div className="mt-2 flex items-start justify-between gap-2 rounded-xl border border-line bg-hanji px-3 py-2">
                  <span className="text-[11px] leading-relaxed text-muk-soft">
                    {t('account.manualNotice')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setManualEntry(false)}
                    className="shrink-0 text-[11px] font-bold text-gold-deep underline"
                  >
                    {t('account.searchAgain')}
                  </button>
                </div>
              )}

              {showSearch && trimmedTerm.length > 0 && (
                <div className="mt-2 overflow-hidden rounded-xl border border-line">
                  {searching ? (
                    <p className="px-3 py-2.5 text-[11px] text-muk-soft">
                      {t('account.searchSearching')}
                    </p>
                  ) : hitsForTerm && hitsForTerm.length > 0 ? (
                    <ul className="max-h-64 overflow-y-auto">
                      {hitsForTerm.map((hit) => (
                        <li key={hit.id} className="border-b border-line/60 last:border-b-0">
                          <button
                            type="button"
                            onClick={() => pickFacility(hit)}
                            className="w-full px-3 py-2.5 text-left hover:bg-gold/10"
                          >
                            <span className="block truncate text-xs font-semibold">{hit.name}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-muk-soft">
                              {hit.address ? `${typeLabel(hit.type)} · ${hit.address}` : typeLabel(hit.type)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 py-2.5 text-[11px] text-muk-soft">
                      {searchResult?.failed ? t('account.searchFailed') : t('account.searchNoResults')}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setManualEntry(true)}
                    className="w-full border-t border-line bg-hanji px-3 py-2.5 text-left text-[11px] font-bold text-gold-deep"
                  >
                    {t('account.searchManual')}
                  </button>
                </div>
              )}

              <p className="mt-1 text-[11px] text-muk-soft">
                {isMerchantRequest ? t('account.storeNameHint') : t('account.orgNameHint')}
              </p>
            </div>

            <div>
              <label htmlFor="contact" className="mb-1.5 block text-xs font-semibold text-muk-soft">
                {t('account.contact')}
              </label>
              <input
                id="contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                required
                maxLength={200}
                className="w-full rounded-xl border border-line bg-hanji px-3.5 py-3 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
              />
              <p className="mt-1 text-[11px] text-muk-soft">{t('account.contactHint')}</p>
            </div>

            {/* 사업자등록번호는 사업자 신청에만 묻는다 — 관리자 신청에는 해당 사항이 없다. */}
            {isMerchantRequest && (
              <>
                <div>
                  <label htmlFor="biz-last4" className="mb-1.5 block text-xs font-semibold text-muk-soft">
                    {t('account.bizLast4')}
                  </label>
                  <input
                    id="biz-last4"
                    value={last4}
                    onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    inputMode="numeric"
                    maxLength={4}
                    className="w-32 rounded-xl border border-line bg-hanji px-3.5 py-3 text-sm tracking-widest focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
                  />
                  {editing && (
                    <p className="mt-1 text-[11px] text-muk-soft">{t('account.editLast4Hint')}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="biz-doc" className="mb-1.5 block text-xs font-semibold text-muk-soft">
                    {t('account.docLabel')}
                  </label>
                  <input
                    id="biz-doc"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    required={!editing}
                    onChange={(e) => pickDocument(e.target.files?.[0] ?? null)}
                    className="w-full rounded-xl border border-line bg-hanji px-3.5 py-3 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-gold/15 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-gold-deep focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
                  />
                  <p className="mt-1 text-[11px] text-muk-soft">
                    {editing ? t('account.editDocHint') : t('account.docHint')}
                  </p>
                  {docFile && (
                    <p className="mt-1 truncate text-[11px] font-semibold text-jade">{docFile.name}</p>
                  )}
                </div>

                <p className="text-[11px] leading-relaxed text-muk-soft">{t('account.docNotice')}</p>
              </>
            )}

            <button
              type="submit"
              disabled={busy || (!editing && isMerchantRequest && !docFile)}
              className="w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {uploading
                ? t('account.docUploading')
                : busy
                  ? editing
                    ? t('account.saving')
                    : t('account.submitting')
                  : editing
                    ? t('account.editSave')
                    : t('account.roleSubmit')}
            </button>

            {editing && (
              <button
                type="button"
                disabled={busy}
                onClick={cancelEdit}
                className="w-full rounded-xl border border-line bg-white py-3 text-xs font-bold disabled:opacity-50"
              >
                {t('account.editCancelAction')}
              </button>
            )}
          </form>
        )}

        {showHistory && (
          <section className="mt-6">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muk-soft">
              <FileText size={14} />
              {t('account.historyTitle')}
            </h2>

            {/* 조회 실패는 '이력 없음'과 다른 사실이다 — 목록이 비어 보이는 이유를 말해 준다. */}
            {listError && (
              <div className="mb-2 rounded-2xl border border-terracotta/30 bg-terracotta/10 p-3.5">
                <p className="text-xs font-bold text-terracotta">
                  {t('account.historyUnavailable')}
                </p>
                <p className="mt-0.5 text-[11px] text-muk-soft">
                  {t('account.historyUnavailableDesc')}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void loadRequests()}
                  className="mt-2 rounded-lg border border-line bg-white px-3 py-1.5 text-[11px] font-bold disabled:opacity-50"
                >
                  {t('common.retry')}
                </button>
              </div>
            )}

            <ul className="space-y-2">
              {items.map((row) => {
                const createdAt = formatDateTime(row.createdAt);
                const reviewedAt = formatDateTime(row.reviewedAt);
                return (
                  <li key={row.id} className="rounded-2xl border border-line bg-white p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusBadgeClass(row.status)}`}
                      >
                        {statusLabel(row.status)}
                      </span>
                      {createdAt && <span className="text-[10px] text-muk-soft">{createdAt}</span>}
                    </div>
                    <p className="mt-1.5 truncate text-sm font-semibold">{row.storeName}</p>
                    <p className="text-[11px] text-muk-soft">{roleLabel(row.requestedRole)}</p>
                    {reviewedAt && (row.status === 'approved' || row.status === 'rejected') && (
                      <p className="mt-0.5 text-[10px] text-muk-soft">
                        {t('account.reviewedAtLabel')} · {reviewedAt}
                      </p>
                    )}
                    {row.status === 'rejected' && row.reviewNote && (
                      <p className="mt-1.5 rounded-lg bg-terracotta/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-terracotta">
                        <span className="font-bold">{t('account.rejectReasonLabel')}</span> ·{' '}
                        {row.reviewNote}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
