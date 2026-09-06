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
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;

    // 1) 네이티브 공유 시트. **취소만 조용히 넘긴다.**
    if (nav?.share) {
      try {
        await nav.share({ title, text: message, url: shareUrl });
        return;
      } catch (err) {
        // 사용자가 스스로 닫은 것은 실패가 아니다.
        if ((err as { name?: string })?.name === 'AbortError') return;
        // 그 밖의 실패(인앱 웹뷰의 NotAllowedError, 제스처 만료 등)는 여기서 끝내지 않는다 —
        // 예전에는 곧장 catch 로 빠져 클립보드 폴백을 **아예 시도하지 않았고**, 사용자는
        // 아무것도 얻지 못한 채 아무 말도 듣지 못했다.
        console.warn('native share failed, falling back to clipboard', err);
      }
    }

    // 2) 클립보드 폴백.
    if (nav?.clipboard) {
      try {
        await nav.clipboard.writeText(`${message} ${shareUrl}`.trim());
        setCopied(true);
        toast.success(t('common.linkCopied'));
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch (err) {
        console.warn('clipboard copy failed', err);
      }
    }

    // 3) 둘 다 안 되면 **말한다.** 이 앱의 성장 경로가 카카오톡 인앱 브라우저 공유인데,
    //    거기서 조용히 실패하면 사용자는 실패한 줄도 모르고 링크를 얻을 방법도 없다.
    //    (권한 정책으로 clipboard 가 막힌 인앱 브라우저에서는 버튼이 말 그대로 아무 일도
    //     안 했다 — 이 저장소의 '무음 폴백 금지' 를 이 버튼만 어기고 있었다.)
    toast.error(t('common.shareFailed'), { description: shareUrl, duration: 10000 });
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
