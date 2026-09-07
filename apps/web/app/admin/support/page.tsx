'use client';

import { useState, useEffect } from 'react';
import {
  Search, Bell, MessageSquare, CheckCircle, FileText, AlertCircle, Send, Loader2
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { adminApi } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import { countLabel, emptyOrFailedText, type LoadStatus } from '@/lib/adminLoadState';

interface Ticket {
  id: string;
  user: string;
  /** 문의자 uid. null = 세션 없이 접수된 익명 문의 → 앱 안에서 답변을 볼 사람이 없다(아래 배너). */
  userId: string | null;
  type: string;
  title: string;
  content: string;
  status: 'new' | 'in_progress' | 'resolved';
  time: string;
  /** 저장된 답변 본문. null = 아직 답하지 않음. */
  replyBody: string | null;
  repliedAt: string | null;
}

/** GET /api/v1/admin/inquiries 응답 행 — inquiries 테이블 원형(snake_case, admin-api 는 케이스 변환 없음).
 *  status 는 DB CHECK(new/in_progress/resolved)와 동일 집합.
 *  reply_body/replied_at 은 20260907091000 마이그레이션이 추가한 컬럼이라, 적용 전 DB 에서는
 *  아예 키가 없다(백엔드는 select('*') 이므로 오류가 아니라 '없음' 으로 온다). */
interface InquiryRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  type: string | null;
  title: string | null;
  content: string | null;
  status: Ticket['status'] | null;
  created_at: string;
  reply_body?: string | null;
  replied_at?: string | null;
}

/** PATCH /api/v1/admin/inquiries/{id} 응답 — 갱신된 행 + 서버가 실제로 한 일.
 *  reply_saved 가 이 화면의 존재 이유다: 답변이 저장됐는지를 **서버가 말해 준다.**
 *  예전에는 화면이 스스로 '전송됨' 이라고 판단했고, 그 판단은 언제나 틀렸다. */
interface InquiryPatchResponse {
  reply_saved?: boolean;
  reply_unavailable_reason?: string | null;
  reply_body?: string | null;
  replied_at?: string | null;
}

function formatRelativeTime(dateString: string) {
  try {
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return '방금 전';
    if (diffMins < 60) return `${diffMins}분 전`;
    if (diffHours < 24) return `${diffHours}시간 전`;
    
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (yesterday.toDateString() === date.toDateString()) return '어제';

    return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  } catch {
    return '최근';
  }
}

/** 답변 시각 표기 — 상대시간(목록)과 달리 '언제 답했는지' 는 정확한 시각이 근거가 된다. */
function formatDateTime(dateString: string) {
  try {
    return new Date(dateString).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '시각 불명';
  }
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [replyText, setReplyText] = useState('');
  // 전송 중 이중 클릭 차단 — 같은 티켓에 답변이 두 번 저장되면 뒤엣것이 앞엣것을 덮는다.
  const [isSending, setIsSending] = useState(false);
  // 조회 실패를 '문의 없음' 과 같은 값(빈 목록)으로 표현하지 않는다. 예전에는 목록 조회가
  // 실패해도 'Total: 0 · New: 0' 이 떠서, 대기 중인 문의가 쌓여 있는데 관리자가 없다고 믿었다.
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch inquiries from Supabase
  useEffect(() => {
    async function fetchTickets() {
      try {
        // 문의는 PII(user_name/content) — RLS 강화로 anon 열람이 막혀 관리자 API 경유로만 읽는다(WS-A-6).
        const data: InquiryRow[] = await adminApi.get('/api/v1/admin/inquiries');

        const mappedTickets: Ticket[] = (data || []).map((item: InquiryRow) => ({
          id: item.id,
          user: item.user_name || '익명 사용자',
          userId: item.user_id ?? null,
          type: item.type || '기타 문의',
          title: item.title || '제목 없음',
          content: item.content || '내용 없음',
          status: item.status || 'new',
          time: formatRelativeTime(item.created_at),
          // 빈 문자열은 '답변 없음' 과 같이 취급한다 — 빈 답변 카드를 그리면 답한 것처럼 보인다.
          replyBody: item.reply_body?.trim() ? item.reply_body : null,
          repliedAt: item.replied_at ?? null,
        }));
        setTickets(mappedTickets);
        setSelectedTicket(mappedTickets[0] ?? null);
        setLoadStatus('ok');
      } catch (err) {
        // 백엔드 실패/타임아웃. 목록을 비우되 상태는 'failed' 로 남긴다 —
        // 화면이 건수를 0 으로 말하지 않고 '조회 실패' 라고 말해야 한다.
        console.warn('문의 실데이터 로드 실패:', err);
        setTickets([]);
        setSelectedTicket(null);
        setLoadStatus('failed');
        setLoadError(errorMessage(err) || '알 수 없는 오류');
      }
    }

    fetchTickets();
  }, []);

  // 답변 저장 + 처리 완료.
  //
  // 이 화면은 오랫동안 답변을 **보내지 않았다.** inquiries 에 답변을 담을 칼럼이 없었고
  // (20260531220000 이후 추가된 적이 없었다), 백엔드 PATCH 도 status 만 받았다. 관리자는
  // 답을 썼다고 믿고 창을 닫고, 티켓은 resolved 로 잠기고, 문의자는 아무것도 받지 못했다.
  //
  // 지금은 실제로 저장한다(마이그레이션 20260907091000). 전달 채널은 **앱 내 표시**다 —
  // 메일·웹푸시 인프라가 이 저장소에 없어서, 문의자는 /mypage/inquiries 에서 답변을 본다.
  //
  // 성공/실패 문구는 **서버 응답(reply_saved)에서 가져온다.** 화면이 스스로 '전송됨' 이라고
  // 판단하지 않는 것이 이 수정의 핵심이다 — 그 판단이 틀렸던 게 원래 결함이었다.
  const handleReply = async () => {
    if (!selectedTicket || isSending) return;
    const body = replyText.trim();

    setIsSending(true);
    try {
      // 관리자 API 경유(0행 갱신은 백엔드가 404 로 반환 — 무음 실패가 성공으로 표시되지 않는다).
      // reply_body 는 쓴 글이 있을 때만 보낸다 — 빈 답변을 저장해 '답변함' 으로 만들지 않는다.
      const res: InquiryPatchResponse = await adminApi.patch(
        `/api/v1/admin/inquiries/${selectedTicket.id}`,
        body ? { status: 'resolved', reply_body: body } : { status: 'resolved' }
      );
      const replySaved = res?.reply_saved === true;

      // 실제 갱신 성공 시에만 로컬 상태를 옮긴다. 답변 본문/시각도 **서버가 돌려준 값**을
      // 쓴다(우리가 보낸 값이 아니라) — 저장되지 않았으면 화면에도 남지 않아야 한다.
      const patched: Ticket = {
        ...selectedTicket,
        status: 'resolved',
        replyBody: replySaved ? (res.reply_body ?? body) : selectedTicket.replyBody,
        repliedAt: replySaved ? (res.replied_at ?? new Date().toISOString()) : selectedTicket.repliedAt,
      };
      setTickets(tickets.map(t => (t.id === patched.id ? patched : t)));
      setSelectedTicket(patched);
      if (replySaved) setReplyText('');

      if (body && replySaved) {
        alert(
          selectedTicket.userId
            ? '답변을 저장했습니다. 문의자는 마이페이지 > 내 문의에서 확인할 수 있습니다.'
            : '답변을 저장했습니다. 다만 이 문의는 세션 없이 접수돼(user_id 없음) 문의자가 앱에서 볼 수 없습니다 — 별도로 연락해 주세요.'
        );
      } else if (body && res?.reply_unavailable_reason === 'schema_missing') {
        // 마이그레이션 미적용 DB. 상태는 바뀌었지만 답변은 저장되지 않았다 — 그 사실을 그대로 말한다.
        alert('상태만 처리 완료로 바꿨습니다. 답변 저장에 필요한 DB 컬럼이 아직 없어(마이그레이션 미적용) 쓴 내용은 저장되지 않았습니다.');
      } else if (body) {
        alert('상태만 처리 완료로 바꿨습니다. 답변 본문은 저장되지 않았습니다.');
      } else {
        alert('답변 없이 처리 완료로 표시했습니다.');
      }
    } catch (err) {
      console.warn('Failed to save reply:', err);
      alert(`처리에 실패했습니다: ${errorMessage(err) || '다시 시도해 주세요.'}`);
    } finally {
      setIsSending(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'new': return <span className="px-2 py-1 bg-red-500/15 text-red-300 text-xs font-bold rounded-md">NEW</span>;
      case 'in_progress': return <span className="px-2 py-1 bg-amber-500/15 text-amber-300 text-xs font-bold rounded-md">IN PROGRESS</span>;
      case 'resolved': return <span className="px-2 py-1 bg-emerald-500/15 text-emerald-300 text-xs font-bold rounded-md">RESOLVED</span>;
      default: return <span className="px-2 py-1 bg-hanok-card text-hanok-ink text-xs font-bold rounded-md">NEW</span>;
    }
  };

  const filteredTickets = tickets.filter(t => 
    t.user.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.type.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-hanok-ink">문의 관리 (Help & Support)</h2>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-hanok-muted" size={18} />
              <input
                type="text"
                placeholder="Search tickets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-2 bg-hanok-card text-hanok-ink placeholder-hanok-muted rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold w-64"
              />
            </div>
            <button className="relative text-hanok-muted hover:text-hanok-ink">
              <Bell size={24} />
            </button>
          </div>
        </header>

        {/* Inbox Layout */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Ticket List (Inbox) */}
          <div className="w-1/3 bg-hanok-panel border-r border-hanok-line flex flex-col h-full">
            {/* 건수는 조회에 성공했을 때만 숫자다. 실패하면 숫자 대신 '조회 실패' 를 낸다 —
                실패한 0 은 '0건' 이라는 사실이 아니라 '몇 건인지 모른다' 이기 때문이다. */}
            <div className="p-4 border-b border-hanok-line flex gap-4">
              <div className="flex items-center gap-2 text-hanok-muted font-semibold text-sm">
                <FileText size={16} /> Total: {countLabel(loadStatus, filteredTickets.length)}
              </div>
              <div className={`flex items-center gap-2 font-semibold text-sm ${loadStatus === 'failed' ? 'text-hanok-muted' : 'text-red-400'}`}>
                <MessageSquare size={16} /> New: {countLabel(loadStatus, filteredTickets.filter(t => t.status === 'new').length)}
              </div>
            </div>
            {loadStatus === 'failed' && (
              <div className="mx-4 mt-4 flex items-start gap-2 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">
                <AlertCircle size={16} className="text-rose-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs">
                  <p className="font-bold text-rose-300">문의 목록을 불러오지 못했습니다</p>
                  <p className="text-hanok-muted mt-1">
                    대기 중인 문의가 있는지 <span className="font-semibold text-hanok-ink">알 수 없는 상태</span>입니다. 새로고침해 주세요.
                  </p>
                  <p className="text-hanok-muted mt-1">사유: {loadError}</p>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              {loadStatus === 'loading' ? (
                <div className="flex items-center justify-center p-8">
                  <div className="w-6 h-6 border-2 border-gold border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : filteredTickets.length === 0 ? (
                <div className="text-center p-8 text-hanok-muted text-sm">
                  {emptyOrFailedText(loadStatus, searchQuery ? '검색된 문의가 없습니다.' : '접수된 문의가 없습니다.')}
                </div>
              ) : (
                filteredTickets.map(ticket => (
                  <div
                    key={ticket.id}
                    onClick={() => setSelectedTicket(ticket)}
                    className={`p-4 border-b border-hanok-line cursor-pointer transition-colors ${
                      selectedTicket?.id === ticket.id
                        ? 'bg-gold/10 border-l-4 border-l-gold'
                        : 'hover:bg-hanok-card border-l-4 border-l-transparent'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm font-semibold text-hanok-ink">{ticket.user}</span>
                      <span className="text-xs text-hanok-muted">{ticket.time}</span>
                    </div>
                    <h4 className="font-bold text-hanok-ink text-sm mb-2 truncate">{ticket.title}</h4>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-hanok-muted">{ticket.type}</span>
                      {getStatusBadge(ticket.status)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Ticket Detail & Reply */}
          <div className="flex-1 bg-hanok flex flex-col overflow-hidden">
            {selectedTicket ? (
              <div className="flex flex-col h-full max-w-4xl mx-auto w-full p-8">

                {/* Detail Header */}
                <div className="bg-hanok-panel p-6 rounded-t-2xl border border-hanok-line shadow-sm mb-4">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        {getStatusBadge(selectedTicket.status)}
                        <span className="text-xs font-semibold px-2 py-0.5 bg-hanok-card text-hanok-muted rounded">
                          {selectedTicket.type}
                        </span>
                        <span className="text-[10px] text-hanok-muted">Ticket ID: {selectedTicket.id}</span>
                      </div>
                      <h2 className="text-2xl font-bold text-hanok-ink">{selectedTicket.title}</h2>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-hanok-ink">{selectedTicket.user}</div>
                      <div className="text-sm text-hanok-muted">{selectedTicket.time}</div>
                    </div>
                  </div>
                  <div className="p-4 bg-hanok rounded-xl text-hanok-ink leading-relaxed break-all whitespace-pre-wrap">
                    {selectedTicket.content}
                  </div>
                </div>

                {/* Reply Section */}
                <div className="bg-hanok-panel p-6 rounded-b-2xl border border-hanok-line shadow-sm flex-1 flex flex-col">
                  <h3 className="font-bold text-hanok-ink mb-4">답변</h3>

                  {/* 이미 답한 티켓은 저장된 답변과 그 시각을 보여준다. '답했다' 를 화면이
                      기억해야 같은 문의에 두 번 답하거나, 답한 걸 잊고 다시 묻지 않는다. */}
                  {selectedTicket.replyBody && (
                    <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                          <CheckCircle size={14} /> 답변 완료
                        </span>
                        <span className="text-xs text-hanok-muted">
                          {selectedTicket.repliedAt ? formatDateTime(selectedTicket.repliedAt) : '시각 기록 없음'}
                        </span>
                      </div>
                      <p className="text-sm text-hanok-ink leading-relaxed whitespace-pre-wrap break-all">
                        {selectedTicket.replyBody}
                      </p>
                    </div>
                  )}

                  {selectedTicket.status === 'resolved' && !selectedTicket.replyBody ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-hanok-muted bg-hanok rounded-xl border border-dashed border-hanok-line p-6 text-center">
                      <CheckCircle size={48} className="text-emerald-400 mb-4" />
                      <p className="font-medium">답변 없이 처리 완료된 문의입니다.</p>
                      {/* 이 구분이 중요하다 — '처리 완료' 는 '답했다' 가 아니다. */}
                      <p className="text-xs mt-1">저장된 답변 본문이 없습니다. 필요하면 아래에 답변을 남길 수 있습니다.</p>
                    </div>
                  ) : null}

                  {selectedTicket.status !== 'resolved' || !selectedTicket.replyBody ? (
                    <div className="flex-1 flex flex-col">
                      {/* 세션 없이 접수된 문의는 답변을 볼 주인이 없다. RLS 정책
                          select_own_or_admin_inquiries 는 user_id = auth.uid() 로 행을 고르는데,
                          NULL 은 어떤 uid 와도 같아지지 않는다(20260904091000 이 신원 위조를 막느라
                          익명 문의를 그렇게 열어 뒀다). 저장은 되지만 앱 안에서는 아무도 못 읽는다 —
                          답변을 쓰기 **전에** 알려야 하는 사실이다. */}
                      {!selectedTicket.userId && (
                        <p className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                          <span>
                            <strong className="font-bold">이 문의는 앱에서 답변을 볼 수 없습니다.</strong>{' '}
                            세션 없이 접수돼 문의자 계정이 연결돼 있지 않습니다(익명 문의). 답변은 저장되지만
                            문의자에게 보이지 않으니, 본문에 적힌 연락처로 직접 연락해 주세요.
                          </span>
                        </p>
                      )}
                      <textarea
                        className="flex-1 w-full bg-hanok border border-hanok-line text-hanok-ink rounded-xl p-4 resize-none focus:outline-none focus:ring-2 focus:ring-gold mb-4"
                        placeholder={selectedTicket.replyBody ? '답변을 새로 쓰면 기존 답변을 덮어씁니다' : '문의자에게 보낼 답변을 작성하세요'}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                      ></textarea>
                      <div className="flex justify-between items-center gap-4">
                        <div className="text-sm text-hanok-muted">
                          {replyText.trim()
                            ? <>답변을 저장하고 상태를 <span className="font-bold text-emerald-400">RESOLVED</span>로 바꿉니다. 문의자는 <span className="font-semibold text-hanok-ink">마이페이지 &gt; 내 문의</span>에서 봅니다.</>
                            : <>답변 없이 상태만 <span className="font-bold text-emerald-400">RESOLVED</span>로 바꿉니다.</>}
                        </div>
                        {/* `disabled={!replyText.trim()}` 를 걸지 않는다 — 답변 없이 닫아야 하는
                            문의(스팸·중복)가 실제로 있고, 그때 억지로 글을 쓰게 만들 이유가 없다. */}
                        <button
                          onClick={handleReply}
                          disabled={isSending}
                          className="flex items-center gap-2 px-6 py-2.5 bg-gold hover:bg-gold-deep disabled:bg-gold-deep disabled:cursor-not-allowed text-white font-bold rounded-xl transition-colors shadow-sm flex-shrink-0"
                        >
                          {isSending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                          {isSending ? '저장 중…' : replyText.trim() ? '답변 저장 후 완료' : '처리 완료로 표시'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-hanok-muted">
                {/* 조회 실패 때 '선택하세요' 라고 하면 목록이 비어 있는 게 정상인 줄 안다. */}
                {loadStatus === 'failed' ? (
                  <>
                    <AlertCircle size={48} className="mb-4 text-rose-400/70" />
                    <p className="font-semibold text-rose-300">문의 목록을 불러오지 못했습니다</p>
                    <p className="text-sm mt-1">문의가 없는 것이 아니라 조회에 실패한 상태입니다.</p>
                  </>
                ) : (
                  <>
                    <MessageSquare size={48} className="mb-4 opacity-50" />
                    <p>좌측 목록에서 문의를 선택하여 확인하세요.</p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
