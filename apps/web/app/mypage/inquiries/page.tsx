'use client';

// 내 문의 — 문의자가 자기 문의와 **관리자 답변**을 보는 화면.
//
// 왜 이 화면이 있어야 하는가: /admin/support 의 '답변 전송' 은 오랫동안 아무것도 보내지
// 않았다. 답변을 담을 컬럼도 없었고, 문의자에게 닿는 채널도 없었다. 메일·웹푸시 인프라가
// 이 저장소에 없으므로 전달 채널을 **앱 내 표시**로 정했다 — 즉 이 화면이 그 채널이다.
// 이 화면이 없으면 '답변했다' 는 여전히 관리자 쪽에서만 참인 말로 남는다.
//
// 데이터: GET /api/v1/inquiries/mine (본인 것만, service_role 로 user_id 필터).
// api-client 가 snake_case → camelCase 로 바꿔 주므로 여기서는 camelCase 로 읽는다.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { MYPAGE_BACK } from '@/lib/navigation';
import { ArrowLeft, MessageSquare, AlertCircle, Clock, CheckCircle2, Info } from 'lucide-react';
import { apiClient, isAuthError } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';
import { markInquiryRepliesSeen } from './seen';

interface InquiryItem {
  id: string;
  type: string | null;
  title: string | null;
  content: string | null;
  status: 'new' | 'in_progress' | 'resolved';
  createdAt: string | null;
  /** 관리자 답변 본문. null = 아직 답변 없음. */
  replyBody: string | null;
  repliedAt: string | null;
}

// 화면 상태. '로딩 / 실패 / 로그인 필요 / 정상' 을 서로 다른 값으로 둔다 —
// 이 저장소의 원칙대로 실패를 '문의 없음'(빈 목록)으로 뭉개지 않기 위해서다.
type LoadState = 'loading' | 'ok' | 'failed' | 'unauthenticated';

export default function MyInquiriesPage() {
  const router = useRouter();
  const t = useT();
  const [items, setItems] = useState<InquiryItem[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  // 서버가 답변 컬럼을 못 찾은 경우(마이그레이션 미적용). false 면 "아직 답변이 없어요" 가
  // **기다리면 온다는 거짓말**이 되므로 다른 문구를 쓴다 — 저장할 자리 자체가 없다.
  const [replySupported, setReplySupported] = useState(true);

  // 첫 실패는 익명 세션 부트스트랩(SessionBootstrap) 완료 전 레이스일 수 있어
  // 2.5초 유예 후 자동 1회만 재시도한다(mypage/impact·coupons 와 같은 패턴, 유한 재시도).
  const retriedRef = useRef(false);

  const load = useCallback(async () => {
    // 한 번의 시도. 결과만 돌려주고 화면 상태는 아래에서 한 곳에서 정한다
    // (재시도를 self-recursion 으로 쓰지 않는다 — 그래야 대기 중에도 스켈레톤이 유지되고,
    //  '실패로 확정' 이 정확히 한 지점에서만 일어난다).
    const attempt = async (): Promise<'ok' | 'auth' | 'error'> => {
      try {
        const data = await apiClient.get('/api/v1/inquiries/mine');
        const rows: InquiryItem[] = (data?.items || []).map((row: Record<string, unknown>) => ({
          id: String(row.id),
          type: (row.type as string) ?? null,
          title: (row.title as string) ?? null,
          content: (row.content as string) ?? null,
          status: ((row.status as InquiryItem['status']) || 'new'),
          createdAt: (row.createdAt as string) ?? null,
          // 공백뿐인 답변은 '답변 없음' 과 같이 다룬다 — 빈 답변 카드는 답한 것처럼 보인다.
          replyBody: typeof row.replyBody === 'string' && row.replyBody.trim() ? row.replyBody : null,
          repliedAt: (row.repliedAt as string) ?? null,
        }));
        setItems(rows);
        setReplySupported(data?.replySupported !== false);
        // 이 화면을 연 시점에 답변을 '봤다' 고 기록한다 — 마이페이지의 새 답변 배지가
        // 이 기록을 기준으로 사라진다(자세한 규약은 ./seen.ts).
        markInquiryRepliesSeen(rows.filter((row) => row.replyBody).map((row) => row.id));
        return 'ok';
      } catch (err) {
        // 401 은 서버 장애가 아니다. 재시도해도 성공할 수 없으므로 안내로 넘어간다.
        if (isAuthError(err)) return 'auth';
        console.warn('Failed to load my inquiries', err);
        return 'error';
      }
    };

    // 여기서 setState('loading') 을 하지 않는다 — 초기 상태가 이미 'loading' 이고,
    // 마운트 effect 안에서 동기적으로 setState 를 부르면 렌더가 한 번 더 돈다.
    // 재시도 버튼은 이벤트 핸들러에서 직접 'loading' 으로 돌려놓는다(아래 onClick).
    let outcome = await attempt();
    // 첫 실패는 익명 세션 부트스트랩 레이스일 수 있다 — 2.5초 유예 후 딱 한 번만 다시 시도한다.
    if (outcome === 'error' && !retriedRef.current) {
      retriedRef.current = true;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      outcome = await attempt();
    }
    setState(outcome === 'ok' ? 'ok' : outcome === 'auth' ? 'unauthenticated' : 'failed');
  }, []);

  useEffect(() => { void load(); }, [load]);

  const statusLabel = (status: InquiryItem['status']) => {
    if (status === 'resolved') return t('inquiries.statusResolved');
    if (status === 'in_progress') return t('inquiries.statusInProgress');
    return t('inquiries.statusNew');
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  return (
    <div className="relative w-full min-h-screen bg-hanji flex flex-col overflow-hidden">
      {/* 헤더 — 목적지를 못박는다(정적 export 에서 back() 은 죽는다. MYPAGE_BACK 주석 참조). */}
      <header className="flex items-center p-5 border-b border-line z-10 relative">
        <button
          onClick={() => router.push(MYPAGE_BACK)}
          className="text-muk-soft hover:text-muk transition-colors mr-4"
          aria-label={t('inquiries.title')}
        >
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">{t('inquiries.title')}</h1>
      </header>

      <main className="flex-1 flex flex-col relative z-10 p-6 overflow-y-auto">
        <div className="max-w-md mx-auto w-full flex flex-col gap-4">
          <p className="text-muk-soft text-sm">{t('inquiries.subtitle')}</p>

          {/* 답변 컬럼이 없는 DB — 답변이 '아직 안 온 것' 이 아니라 '올 자리가 없는 것' 이다. */}
          {state === 'ok' && !replySupported && (
            <p className="flex items-start gap-2 rounded-2xl border border-line bg-white px-4 py-3 text-xs text-muk-soft">
              <Info size={14} className="flex-shrink-0 mt-0.5" />
              <span>{t('inquiries.replyUnavailable')}</span>
            </p>
          )}

          {state === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 text-muk-soft">
              <div className="w-6 h-6 border-2 border-gold border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm">{t('inquiries.loading')}</p>
            </div>
          )}

          {/* 로그인 필요 — 실패가 아니다. '다시 시도' 를 권하지 않는다(눌러도 같은 결과). */}
          {state === 'unauthenticated' && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <MessageSquare size={40} className="text-muk-soft/50 mb-4" />
              <p className="text-muk-soft text-sm">{t('inquiries.loginRequired')}</p>
            </div>
          )}

          {/* 조회 실패를 '문의 없음' 으로 그리지 않는다 — 사용자가 보낸 문의가 사라진 줄 안다. */}
          {state === 'failed' && (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <AlertCircle size={40} className="text-terracotta/70 mb-4" />
              <p className="font-semibold text-muk">{t('inquiries.loadFailed')}</p>
              <p className="text-muk-soft text-sm mt-1">{t('inquiries.loadFailedHint')}</p>
              <button
                onClick={() => { retriedRef.current = false; setState('loading'); void load(); }}
                className="mt-5 px-6 py-2.5 bg-gold hover:bg-gold-deep text-white font-bold rounded-xl transition-colors"
              >
                {t('inquiries.retry')}
              </button>
            </div>
          )}

          {state === 'ok' && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <MessageSquare size={40} className="text-muk-soft/50 mb-4" />
              <p className="text-muk-soft text-sm">{t('inquiries.empty')}</p>
              {/* 세션 없이 보낸 문의는 계정에 묶이지 않아 여기 나오지 않는다(익명 문의 경로).
                  빈 목록을 보고 '문의가 사라졌다' 고 오해하지 않도록 이유를 말해 둔다. */}
              <p className="text-muk-soft/80 text-xs mt-2">{t('inquiries.anonymousHint')}</p>
              <button
                onClick={() => router.push('/mypage/support')}
                className="mt-5 px-6 py-2.5 bg-gold hover:bg-gold-deep text-white font-bold rounded-xl transition-colors"
              >
                {t('inquiries.emptyCta')}
              </button>
            </div>
          )}

          {state === 'ok' && items.map((item) => (
            <article key={item.id} className="bg-white border border-line rounded-2xl overflow-hidden shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="p-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="text-xs font-semibold text-muk-soft">{item.type}</span>
                  <span className={`flex items-center gap-1 text-xs font-bold ${item.status === 'resolved' ? 'text-jade' : 'text-muk-soft'}`}>
                    {item.status === 'resolved' ? <CheckCircle2 size={13} /> : <Clock size={13} />}
                    {statusLabel(item.status)}
                  </span>
                </div>
                <h2 className="font-bold text-muk mb-1 break-all">{item.title}</h2>
                <p className="text-xs text-muk-soft mb-3">{formatDate(item.createdAt)}</p>
                <p className="text-sm text-muk-soft leading-relaxed whitespace-pre-wrap break-all">{item.content}</p>
              </div>

              {/* 답변 영역. 답변이 있으면 본문과 시각을, 없으면 '아직 없음' 을 말한다.
                  replySupported=false 일 때는 위 배너가 이유를 따로 설명한다. */}
              <div className="border-t border-line bg-hanji px-5 py-4">
                {item.replyBody ? (
                  <>
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <span className="text-xs font-bold text-jade">{t('inquiries.replyTitle')}</span>
                      {item.repliedAt && (
                        <span className="text-xs text-muk-soft">
                          {t('inquiries.repliedAt', { date: formatDate(item.repliedAt) })}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muk leading-relaxed whitespace-pre-wrap break-all">{item.replyBody}</p>
                  </>
                ) : (
                  <p className="text-xs text-muk-soft">
                    {replySupported ? t('inquiries.awaitingReply') : t('inquiries.replyUnavailable')}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
