'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Send, CheckCircle } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';

export default function UserSupportForm() {
  const router = useRouter();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({ type: '앱 버그', title: '', content: '' });
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('사용자');

  useEffect(() => {
    async function loadUser() {
      try {
        const supabase = createPublicClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          setUserId(session.user.id);
          const name = session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || '사용자';
          setUserName(name);
        } else {
          setUserId("a2222222-2222-2222-2222-222222222222");
          setUserName("임시 사용자");
        }
      } catch (err) {
        console.warn('Failed to load user session:', err);
      }
    }
    loadUser();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title || !formData.content) return;

    setIsSubmitting(true);
    try {
      const supabase = createPublicClient();
      const { error } = await supabase.from('inquiries').insert([
        {
          user_id: userId,
          user_name: userName,
          type: formData.type,
          title: formData.title,
          content: formData.content,
          status: 'new'
        }
      ]);

      if (error) {
        throw error;
      }

      setIsSubmitted(true);
    } catch (err) {
      console.warn('Failed to submit inquiry:', err);
      alert('문의 제출에 실패했습니다. 다시 시도해주세요.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative w-full min-h-screen bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center p-5 border-b border-line z-10 relative">
        <button
          onClick={() => router.back()}
          className="text-muk-soft hover:text-muk transition-colors mr-4"
        >
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">고객지원</h1>
      </header>

      {/* Content */}
      <main className="flex-1 flex flex-col relative z-10 p-6 overflow-y-auto">
        {isSubmitted ? (
          <div className="flex-1 flex flex-col items-center justify-center animate-fade-in text-center">
            <div className="w-20 h-20 bg-jade/15 rounded-full flex items-center justify-center mb-6">
              <CheckCircle size={40} className="text-jade" />
            </div>
            <h2 className="text-2xl font-bold font-serif text-muk mb-2">문의가 접수되었습니다.</h2>
            <p className="text-muk-soft mb-8 max-w-[80%]">
              관리자가 내용을 확인한 후 신속하게 처리할 예정입니다.
            </p>
            <button
              onClick={() => router.push('/mypage')}
              className="px-8 py-3 bg-gold hover:bg-gold-deep text-white font-bold rounded-xl transition-colors"
            >
              마이페이지로 돌아가기
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5 animate-fade-in max-w-md mx-auto w-full">
            <p className="text-muk-soft text-sm mb-2">
              서비스 이용 중 불편한 점이나 건의사항을 남겨주시면 관리자 대시보드로 실시간 전달됩니다.
            </p>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-muk-soft">문의 유형</label>
              <select
                className="bg-white border border-line text-muk rounded-xl p-4 outline-none focus:border-gold appearance-none"
                value={formData.type}
                onChange={e => setFormData({ ...formData, type: e.target.value })}
              >
                <option value="앱 버그" className="bg-white text-muk">앱 버그 및 오류</option>
                <option value="인프라 불만" className="bg-white text-muk">시설/인프라 불만</option>
                <option value="데이터 수정" className="bg-white text-muk">내 정보/데이터 수정</option>
                <option value="기타 문의" className="bg-white text-muk">기타 문의</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-muk-soft">제목</label>
              <input
                type="text"
                placeholder="어떤 문제가 발생했나요?"
                className="bg-white border border-line text-muk placeholder:text-muk-soft/70 rounded-xl p-4 outline-none focus:border-gold"
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
                required
              />
            </div>

            <div className="flex flex-col gap-2 flex-1">
              <label className="text-sm font-semibold text-muk-soft">상세 내용</label>
              <textarea
                placeholder="관리자가 상황을 이해할 수 있도록 자세히 적어주세요."
                className="bg-white border border-line text-muk placeholder:text-muk-soft/70 rounded-xl p-4 outline-none focus:border-gold min-h-[200px] resize-none"
                value={formData.content}
                onChange={e => setFormData({ ...formData, content: e.target.value })}
                required
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-4 flex items-center justify-center gap-2 bg-gold hover:bg-gold-deep disabled:bg-muk-soft/40 text-white font-bold py-4 rounded-xl transition-colors shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
            >
              <Send size={20} />
              {isSubmitting ? '제출 중...' : '문의 보내기'}
            </button>
          </form>
        )}
      </main>

    </div>
  );
}
