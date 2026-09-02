'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MYPAGE_BACK } from '@/lib/navigation';
import { ArrowLeft, Send, CheckCircle } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n/I18nProvider';

export default function UserSupportForm() {
  const router = useRouter();
  const t = useT();
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
      toast.error(t('support.submitFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative w-full min-h-screen bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center p-5 border-b border-line z-10 relative">
        <button
          // 목적지를 못박는다 — 딥링크·새로고침이면 back() 은 죽는다(MYPAGE_BACK 주석).
          onClick={() => router.push(MYPAGE_BACK)}
          className="text-muk-soft hover:text-muk transition-colors mr-4"
        >
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">{t('support.title')}</h1>
      </header>

      {/* Content */}
      <main className="flex-1 flex flex-col relative z-10 p-6 overflow-y-auto">
        {isSubmitted ? (
          <div className="flex-1 flex flex-col items-center justify-center animate-fade-in text-center">
            <div className="w-20 h-20 bg-jade/15 rounded-full flex items-center justify-center mb-6">
              <CheckCircle size={40} className="text-jade" />
            </div>
            <h2 className="text-2xl font-bold font-serif text-muk mb-2">{t('support.doneTitle')}</h2>
            <p className="text-muk-soft mb-8 max-w-[80%]">
              {t('support.doneDesc')}
            </p>
            <button
              onClick={() => router.push('/mypage')}
              className="px-8 py-3 bg-gold hover:bg-gold-deep text-white font-bold rounded-xl transition-colors"
            >
              {t('support.backToMypage')}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5 animate-fade-in max-w-md mx-auto w-full">
            <p className="text-muk-soft text-sm mb-2">
              {t('support.intro')}
            </p>

            <div className="flex flex-col gap-2">
              {/* value 는 그대로 DB(inquiries.type)에 저장돼 관리자 화면의 분류 기준이 된다 —
                  **번역하면 안 된다.** 사용자에게 보이는 라벨만 로케일을 따른다. */}
              <label htmlFor="support-type" className="text-sm font-semibold text-muk-soft">{t('support.typeLabel')}</label>
              <select
                id="support-type"
                className="bg-white border border-line text-muk rounded-xl p-4 outline-none focus:border-gold appearance-none"
                value={formData.type}
                onChange={e => setFormData({ ...formData, type: e.target.value })}
              >
                <option value="앱 버그" className="bg-white text-muk">{t('support.typeBug')}</option>
                <option value="인프라 불만" className="bg-white text-muk">{t('support.typeInfra')}</option>
                <option value="데이터 수정" className="bg-white text-muk">{t('support.typeData')}</option>
                <option value="기타 문의" className="bg-white text-muk">{t('support.typeEtc')}</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="support-title" className="text-sm font-semibold text-muk-soft">{t('support.titleLabel')}</label>
              <input
                id="support-title"
                type="text"
                placeholder={t('support.titlePlaceholder')}
                className="bg-white border border-line text-muk placeholder:text-muk-soft/70 rounded-xl p-4 outline-none focus:border-gold"
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
                required
              />
            </div>

            <div className="flex flex-col gap-2 flex-1">
              <label htmlFor="support-content" className="text-sm font-semibold text-muk-soft">{t('support.contentLabel')}</label>
              <textarea
                id="support-content"
                placeholder={t('support.contentPlaceholder')}
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
              {isSubmitting ? t('support.submitting') : t('support.submit')}
            </button>
          </form>
        )}
      </main>

    </div>
  );
}
