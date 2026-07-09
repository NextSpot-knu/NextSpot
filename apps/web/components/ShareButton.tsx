'use client';

// 공유 버튼 — 모바일 네이티브 공유 시트(Web Share API)를 우선 사용하고,
// 미지원(데스크톱 등) 시 클립보드 복사로 폴백한다. 관광객이 한산한 코스/장소를
// 퍼뜨려 자연 유입을 만드는 성장 기능. 정적 export/SSR 안전(런타임 가드).
import { useCallback, useState } from 'react';
import { Share2, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n/I18nProvider';

interface ShareButtonProps {
  title: string;
  text: string;
  className?: string;
}

export function ShareButton({ title, text, className = '' }: ShareButtonProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const onShare = useCallback(async () => {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav?.share) {
        await nav.share({ title, text, url });
        return;
      }
      if (nav?.clipboard) {
        await nav.clipboard.writeText(`${text} ${url}`.trim());
        setCopied(true);
        toast.success(t('common.linkCopied'));
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      // 사용자가 공유를 취소(AbortError)한 경우는 조용히 무시한다.
      if ((err as { name?: string })?.name !== 'AbortError') {
        console.warn('share failed', err);
      }
    }
  }, [title, text, t]);

  return (
    <button
      type="button"
      onClick={onShare}
      aria-label={t('common.share')}
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 py-1.5 text-xs font-semibold text-muk-soft transition-colors hover:text-muk hover:bg-white ${className}`}
    >
      {copied ? <Check size={15} className="text-jade" /> : <Share2 size={15} />}
      <span>{t('common.share')}</span>
    </button>
  );
}
