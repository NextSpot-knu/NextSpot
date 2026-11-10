// 공유 버튼(웹 components/ShareButton.tsx) — 흰 알약 + Share2 15 + '공유'. 복사되면 2초 동안 비취 ✓, 실패하면 토스트 10초.
// 공유 흐름은 부르는 쪽 onShare 가 한다(lib/platform/share.ts shareLink 가 결과를 돌려준다). 이 버튼이 결과별 토스트를 띄우니
// 부르는 쪽은 자기 토스트·Alert 를 지운다(이중 알림 방지).
import { useEffect, useRef, useState } from 'react';
import { Check, Share2 } from 'lucide-react-native';

import { Icon } from '~/components/ui/Icon';
import { Pressable } from '~/components/ui/Pressable';
import { Text } from '~/components/ui/Text';
import { cn } from '~/components/ui/cn';
import { toast } from '~/components/ui/Toast';
import { useT } from '~/lib/i18n/I18nProvider';
import type { ShareOutcome } from '~/lib/platform/shareCore';

import { COPIED_CHECK_MS, SHARE_FAILED_TOAST_MS, reactionFor } from './shareButtonModel';

export type ShareButtonProps = {
  onShare: () => Promise<ShareOutcome>;
  /** 실패 토스트 아래에 보여 줄 주소(사용자가 직접 복사). */
  url?: string;
  /** 지도 위에 떠 있는 코스 모양 — 그림자 0 2 10 .15. */
  floating?: boolean;
  /** 예: 대안 카드는 'min-h-[44px]'. 기본은 보이는 높이 약 30 + hitSlop 으로 탭 영역 44. */
  className?: string;
};

export function ShareButton({ onShare, url, floating = false, className }: ShareButtonProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const press = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const reaction = reactionFor(await onShare());
      if (reaction.toast === 'copied') toast.success(t('common.linkCopied'));
      if (reaction.toast === 'failed') toast.error(t('common.shareFailed'), { description: url, duration: SHARE_FAILED_TOAST_MS });
      if (reaction.copied && alive.current) {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => alive.current && setCopied(false), COPIED_CHECK_MS);
      }
    } finally {
      busy.current = false;
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('common.share')}
      hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }}
      onPress={press}
      className={cn(
        'flex-row items-center gap-[6px] self-start rounded-full border border-line bg-white/80 px-[12px] py-[6px]',
        className,
      )}
      style={floating ? { boxShadow: '0px 2px 10px rgba(43, 35, 32, 0.15)' } : undefined}
    >
      <Icon icon={copied ? Check : Share2} size={15} color={copied ? 'jade' : 'muk-soft'} />
      <Text className="text-xs leading-[16px] text-muk-soft" weight="semibold">
        {t('common.share')}
      </Text>
    </Pressable>
  );
}
