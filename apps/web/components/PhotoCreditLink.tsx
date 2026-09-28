import type { PhotoCredit } from '@/lib/photoCredit';

// 사진 아래 한 줄 출처 — '작가 · 라이선스' 가 원문(Wikimedia Commons 파일 페이지)으로 이어진다.
// 보이는 사진이 Wikimedia 일 때만 그린다(판정은 lib/photoCredit.ts creditForDisplayedPhoto).
// 긴 작가 이름은 한 줄 안에서 말줄임되고 라이선스는 끝까지 남는다 — 줄 높이가 고정이라 이름 길이로
// 카드 높이가 흔들리지 않는다. 문구는 데이터라 i18n 키가 없다.
export function PhotoCreditLink({ credit, className = '' }: { credit: PhotoCredit; className?: string }) {
  const full = credit.license ? `${credit.label} · ${credit.license}` : credit.label;
  return (
    <a
      href={credit.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={full}
      data-testid="photo-credit"
      className={`flex h-[14px] min-w-0 max-w-full items-center overflow-hidden text-[10px] leading-[14px] text-muk-soft underline underline-offset-2 hover:text-muk ${className}`}
    >
      <span className="min-w-0 truncate">{credit.label}</span>
      {credit.license && <span className="shrink-0 whitespace-pre">{` · ${credit.license}`}</span>}
    </a>
  );
}
