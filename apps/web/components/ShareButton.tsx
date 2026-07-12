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
  text?: string;
  // 선택적 오버라이드 — 미지정 시 현행 동작(text 그대로, 현재 페이지 URL) 유지(하위호환).
  // url: 공유 대상 URL을 현재 페이지가 아닌 다른 경로(예: ref=share 계측 파라미터 포함)로 지정.
  // shareText: text 대신 사용할 공유 문구(더 구체적인 카드별 문구가 필요한 호출부용).
  url?: string;
  shareText?: string;
  className?: string;
}

export function ShareButton({ title, text = '', url, shareText, className = '' }: ShareButtonProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const message = shareText ?? text;

  const onShare = useCallback(async () => {
    const shareUrl = url ?? (typeof window !== 'undefined' ? window.location.href : '');
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav?.share) {
        await nav.share({ title, text: message, url: shareUrl });
        return;
      }
      if (nav?.clipboard) {
        await nav.clipboard.writeText(`${message} ${shareUrl}`.trim());
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
  }, [title, message, url, t]);

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
