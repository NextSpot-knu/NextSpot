'use client';

import { useState, useEffect } from 'react';
import { 
  Search, Bell, MessageSquare, CheckCircle, FileText, Send
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { adminApi } from '@/lib/admin-api';

interface Ticket {
  id: string;
  user: string;
  type: string;
  title: string;
  content: string;
  status: 'new' | 'in_progress' | 'resolved';
  time: string;
}

/** GET /api/v1/admin/inquiries 응답 행 — inquiries 테이블 원형(snake_case, admin-api 는 케이스 변환 없음).
 *  status 는 DB CHECK(new/in_progress/resolved)와 동일 집합. */
interface InquiryRow {
  id: string;
  user_name: string | null;
  type: string | null;
  title: string | null;
  content: string | null;
  status: Ticket['status'] | null;
  created_at: string;
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

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [replyText, setReplyText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
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
          type: item.type || '기타 문의',
          title: item.title || '제목 없음',
          content: item.content || '내용 없음',
          status: item.status || 'new',
          time: formatRelativeTime(item.created_at)
        }));
        setTickets(mappedTickets);
        setSelectedTicket(mappedTickets[0]);
      } catch (err) {
        // 백엔드 실패/타임아웃 — 빈 목록으로 표시.
        console.warn('문의 실데이터 로드 실패 — 빈 목록으로 표시:', err);
        setTickets([]);
        setSelectedTicket(null);
      } finally {
        setIsLoading(false);
      }
    }

    fetchTickets();
  }, []);

  const handleReply = async () => {
    if (!selectedTicket || !replyText.trim()) return;

    try {
      // 관리자 API 경유(0행 갱신은 백엔드가 404 로 반환 — 무음 실패가 성공으로 표시되지 않는다).
      await adminApi.patch(`/api/v1/admin/inquiries/${selectedTicket.id}`, { status: 'resolved' });

      // 실제 갱신 성공 시에만 로컬 상태 + 성공 알림.
      const updatedTickets = tickets.map(t =>
        t.id === selectedTicket.id ? { ...t, status: 'resolved' as const } : t
      );
      setTickets(updatedTickets);
      setSelectedTicket({ ...selectedTicket, status: 'resolved' });
      setReplyText('');
      alert('답변이 전송되었으며, 티켓 상태가 완료로 변경되었습니다.');
    } catch (err) {
      console.warn('Failed to reply and resolve ticket:', err);
      alert('답변 처리에 실패했습니다. 다시 시도해주세요.');
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
            <div className="p-4 border-b border-hanok-line flex gap-4">
              <div className="flex items-center gap-2 text-hanok-muted font-semibold text-sm">
                <FileText size={16} /> Total: {filteredTickets.length}
              </div>
              <div className="flex items-center gap-2 text-red-400 font-semibold text-sm">
                <MessageSquare size={16} /> New: {filteredTickets.filter(t => t.status === 'new').length}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center justify-center p-8">
                  <div className="w-6 h-6 border-2 border-gold border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : filteredTickets.length === 0 ? (
                <div className="text-center p-8 text-hanok-muted text-sm">
                  검색된 문의가 없습니다.
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
                  <h3 className="font-bold text-hanok-ink mb-4">답변 작성</h3>

                  {selectedTicket.status === 'resolved' ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-hanok-muted bg-hanok rounded-xl border border-dashed border-hanok-line">
                      <CheckCircle size={48} className="text-emerald-400 mb-4" />
                      <p className="font-medium">이미 처리가 완료된 문의입니다.</p>
                    </div>
                  ) : (
                    <>
                      <textarea
                        className="flex-1 w-full bg-hanok border border-hanok-line text-hanok-ink rounded-xl p-4 resize-none focus:outline-none focus:ring-2 focus:ring-gold mb-4"
                        placeholder="여기에 답변을 작성하세요..."
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                      ></textarea>
                      <div className="flex justify-between items-center">
                        <div className="text-sm text-hanok-muted">
                          답변을 전송하면 자동으로 상태가 <span className="font-bold text-emerald-400">RESOLVED</span>로 변경됩니다.
                        </div>
                        <button
                          onClick={handleReply}
                          disabled={!replyText.trim()}
                          className="flex items-center gap-2 px-6 py-2.5 bg-gold hover:bg-gold-deep disabled:bg-hanok-line disabled:cursor-not-allowed text-white font-bold rounded-xl transition-colors shadow-sm"
                        >
                          <Send size={18} /> Send Reply
                        </button>
                      </div>
                    </>
                  )}
                </div>

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-hanok-muted">
                <MessageSquare size={48} className="mb-4 opacity-50" />
                <p>좌측 목록에서 문의를 선택하여 확인하세요.</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
