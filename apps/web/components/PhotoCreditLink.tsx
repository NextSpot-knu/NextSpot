import type { PhotoCredit } from '@/lib/photoCredit';
import { useT } from '@/lib/i18n/I18nProvider';

// 사진 아래 출처. 판정(보이는 사진에 붙일 출처가 무엇인지)은 lib/photoCredit.ts creditForDisplayedPhoto 한 곳 —
// 이 컴포넌트는 그 결과를 그리기만 한다.
// - Wikimedia: '작가 · 라이선스' 가 원문(Commons 파일 페이지)으로 이어진다. 문구는 데이터라 i18n 키가 없다.
// - 경주시: '사진: 경주시' 한 줄(i18n common.cityPhotoCredit) — 사진 출처일 뿐, 운영 주체 표기가 아니다.
//   원문 주소가 있으면 경주시 관광 누리집으로 이어지고, 없으면 글자만.
//
// - 기본(한 줄): 긴 작가 이름은 말줄임되고 라이선스는 끝까지 남는다. 글자 줄은 14px 이지만 위아래 5px 씩
//   누르는 자리를 더해 24px 상자다(WCAG 2.5.8) — 호출부가 음수 여백으로 보이는 간격을 맞춘다.
// - stacked(두 줄): 좁은 카드(대기 보드 3열)용 — 작가 이름이 한 줄을 다 쓰고 라이선스는 다음 줄. 28px.
// 줄 높이가 고정이라 이름 길이로 카드 높이가 흔들리지 않는다(경주시 줄은 예외 — 잘리지 않고 접힌다).
// w-fit(+base 의 max-w-full): 누르는 자리는 보이는 글자 폭만큼 — 줄 오른쪽 빈자리를 누르거나 카드를 끌려다
// 새 창(Commons)이 열리지 않게. 블록 flex 라 인라인 줄 상자(글자 기준선) 때문에 높이가 늘지 않는다.
export function PhotoCreditLink({
  credit,
  stacked = false,
  className = '',
}: {
  credit: PhotoCredit;
  stacked?: boolean;
  className?: string;
}) {
  const t = useT();
  const text = 'min-w-0 max-w-full overflow-hidden text-[10px] leading-[14px] text-muk-soft';
  const base = `${text} underline underline-offset-2 hover:text-muk`;
  if (credit.kind === 'city') {
    // 이 줄이 경주시 사진의 유일한 출처라 말줄임하지 않는다 — 폭이 모자라면(320px 폰의 대기 보드 카드, 영어)
    // 낱말 단위로 다음 줄로 접힌다(대기 보드 출처 자리 min-h-9 pt-2 는 14px 두 줄을 담는다).
    // stacked(대기 보드): 옆 카드의 Wikimedia 출처(stacked)와 같은 위쪽 정렬 상자 — 두 출처 줄의 첫 줄 높이가 맞는다.
    // 기본: 한 줄이면 24px 상자(위아래 5px 누르는 자리), 접히면 그만큼 자란다.
    const label = t('common.cityPhotoCredit');
    const box = stacked ? 'flex min-h-6 w-fit flex-col' : 'flex min-h-6 w-fit items-center py-[5px]';
    const line = <span className="block min-w-0 whitespace-normal break-keep wrap-break-word">{label}</span>;
    return credit.sourceUrl ? (
      <a
        href={credit.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={label}
        className={`${box} ${base} ${className}`}
      >
        {line}
      </a>
    ) : (
      <p className={`${box} ${text} ${className}`}>{line}</p>
    );
  }
  const full = credit.license ? `${credit.label} · ${credit.license}` : credit.label;
  if (stacked) {
    return (
      <a
        href={credit.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={full}
        className={`flex min-h-6 w-fit flex-col ${base} ${className}`}
      >
        <span className="block min-w-0 truncate">{credit.label}</span>
        {credit.license && <span className="block min-w-0 truncate">{credit.license}</span>}
      </a>
    );
  }
  return (
    <a
      href={credit.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={full}
      className={`flex h-6 w-fit items-center py-[5px] ${base} ${className}`}
    >
      <span className="min-w-0 truncate">{credit.label}</span>
      {credit.license && <span className="shrink-0 whitespace-pre">{` · ${credit.license}`}</span>}
    </a>
  );
}
