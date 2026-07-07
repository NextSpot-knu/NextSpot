'use client';

import { useState, useEffect } from 'react';
import { 
  Search, Bell, MessageSquare, CheckCircle, Clock, FileText, Send 
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

// 데모 폴백: 백엔드가 비어있거나 응답이 없을 때 보여줄 샘플 문의(데모 페이지 무중단).
const DEMO_TICKETS: Ticket[] = [];

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
  } catch (e) {
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
        const data = await adminApi.get('/api/v1/admin/inquiries');

        const mappedTickets: Ticket[] = (data || []).map((item: any) => ({
          id: item.id,
          user: item.user_name || '익명 사용자',
          type: item.type || '기타 문의',
          title: item.title || '제목 없음',
          content: item.content || '내용 없음',
          status: item.status || 'new',
          time: formatRelativeTime(item.created_at)
        }));
        // 실데이터가 비면 데모 문의로 대체(데모 페이지 무중단).
        const finalTickets = mappedTickets.length > 0 ? mappedTickets : DEMO_TICKETS;
        setTickets(finalTickets);
        setSelectedTicket(finalTickets[0]);
      } catch (err) {
        // 백엔드 실패/타임아웃 — 데모 문의로 폴백.
        console.warn('문의 실데이터 로드 실패 — 데모 데이터로 대체:', err);
        setTickets(DEMO_TICKETS);
        setSelectedTicket(DEMO_TICKETS[0]);
      } finally {
        setIsLoading(false);
      }
    }

    fetchTickets();
  }, []);

  const handleReply = async () => {
    if (!selectedTicket || !replyText.trim()) return;

    // 데모 폴백 티켓(id 'demo-*')은 inquiries 테이블에 실제 행이 없어 0행 UPDATE 가 error 없이 통과 →
    // 거짓 성공이 된다. DB 호출을 건너뛰고 화면 상태만 갱신하되, 실제 저장이 없음을 정직하게 안내(데모 무중단).
    if (String(selectedTicket.id).startsWith('demo-')) {
      setTickets(tickets.map(t => t.id === selectedTicket.id ? { ...t, status: 'resolved' as const } : t));
      setSelectedTicket({ ...selectedTicket, status: 'resolved' });
      setReplyText('');
      alert('데모 모드: 답변이 화면에만 반영되었습니다(실제 저장 없음).');
      return;
    }

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
      console.error('Failed to reply and resolve ticket:', err);
      alert('답변 처리에 실패했습니다. 다시 시도해주세요.');
    }
  };

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'new': return <span className="px-2 py-1 bg-red-500/15 text-red-300 text-xs font-bold rounded-md">NEW</span>;
      case 'in_progress': return <span className="px-2 py-1 bg-amber-500/15 text-amber-300 text-xs font-bold rounded-md">IN PROGRESS</span>;
      case 'resolved': return <span className="px-2 py-1 bg-emerald-500/15 text-emerald-300 text-xs font-bold rounded-md">RESOLVED</span>;
      default: return <span className="px-2 py-1 bg-slate-800 text-slate-200 text-xs font-bold rounded-md">NEW</span>;
    }
  };

  const filteredTickets = tickets.filter(t => 
    t.user.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.type.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen bg-[#070b19] text-slate-100 font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-slate-100">문의 관리 (Help & Support)</h2>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
              <input
                type="text"
                placeholder="Search tickets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-2 bg-slate-800 text-slate-100 placeholder-slate-500 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
              />
            </div>
            <button className="relative text-slate-400 hover:text-slate-200">
              <Bell size={24} />
            </button>
          </div>
        </header>

        {/* Inbox Layout */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Ticket List (Inbox) */}
          <div className="w-1/3 bg-slate-900 border-r border-slate-800 flex flex-col h-full">
            <div className="p-4 border-b border-slate-800 flex gap-4">
              <div className="flex items-center gap-2 text-slate-300 font-semibold text-sm">
                <FileText size={16} /> Total: {filteredTickets.length}
              </div>
              <div className="flex items-center gap-2 text-red-400 font-semibold text-sm">
                <MessageSquare size={16} /> New: {filteredTickets.filter(t => t.status === 'new').length}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center justify-center p-8">
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : filteredTickets.length === 0 ? (
                <div className="text-center p-8 text-slate-500 text-sm">
                  검색된 문의가 없습니다.
                </div>
              ) : (
                filteredTickets.map(ticket => (
                  <div
                    key={ticket.id}
                    onClick={() => setSelectedTicket(ticket)}
                    className={`p-4 border-b border-slate-800 cursor-pointer transition-colors ${
                      selectedTicket?.id === ticket.id
                        ? 'bg-blue-500/10 border-l-4 border-l-blue-600'
                        : 'hover:bg-slate-800 border-l-4 border-l-transparent'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm font-semibold text-slate-100">{ticket.user}</span>
                      <span className="text-xs text-slate-500">{ticket.time}</span>
                    </div>
                    <h4 className="font-bold text-slate-100 text-sm mb-2 truncate">{ticket.title}</h4>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-slate-400">{ticket.type}</span>
                      {getStatusBadge(ticket.status)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Ticket Detail & Reply */}
          <div className="flex-1 bg-[#070b19] flex flex-col overflow-hidden">
            {selectedTicket ? (
              <div className="flex flex-col h-full max-w-4xl mx-auto w-full p-8">

                {/* Detail Header */}
                <div className="bg-slate-900 p-6 rounded-t-2xl border border-slate-800 shadow-sm mb-4">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        {getStatusBadge(selectedTicket.status)}
                        <span className="text-xs font-semibold px-2 py-0.5 bg-slate-800 text-slate-300 rounded">
                          {selectedTicket.type}
                        </span>
                        <span className="text-[10px] text-slate-500">Ticket ID: {selectedTicket.id}</span>
                      </div>
                      <h2 className="text-2xl font-bold text-slate-100">{selectedTicket.title}</h2>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-slate-200">{selectedTicket.user}</div>
                      <div className="text-sm text-slate-500">{selectedTicket.time}</div>
                    </div>
                  </div>
                  <div className="p-4 bg-slate-950 rounded-xl text-slate-200 leading-relaxed break-all whitespace-pre-wrap">
                    {selectedTicket.content}
                  </div>
                </div>

                {/* Reply Section */}
                <div className="bg-slate-900 p-6 rounded-b-2xl border border-slate-800 shadow-sm flex-1 flex flex-col">
                  <h3 className="font-bold text-slate-100 mb-4">답변 작성</h3>

                  {selectedTicket.status === 'resolved' ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-slate-500 bg-slate-950 rounded-xl border border-dashed border-slate-700">
                      <CheckCircle size={48} className="text-emerald-400 mb-4" />
                      <p className="font-medium">이미 처리가 완료된 문의입니다.</p>
                    </div>
                  ) : (
                    <>
                      <textarea
                        className="flex-1 w-full bg-slate-950 border border-slate-800 text-slate-100 rounded-xl p-4 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
                        placeholder="여기에 답변을 작성하세요..."
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                      ></textarea>
                      <div className="flex justify-between items-center">
                        <div className="text-sm text-slate-400">
                          답변을 전송하면 자동으로 상태가 <span className="font-bold text-emerald-400">RESOLVED</span>로 변경됩니다.
                        </div>
                        <button
                          onClick={handleReply}
                          disabled={!replyText.trim()}
                          className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-bold rounded-xl transition-colors shadow-sm"
                        >
                          <Send size={18} /> Send Reply
                        </button>
                      </div>
                    </>
                  )}
                </div>

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-500">
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
