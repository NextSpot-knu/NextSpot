import { expect, type Page } from '@playwright/test';

// 휴대폰(<768px) /main 추천 카드는 짧은 미리보기(이름 · 도보 N분 · 혼잡 배지 · 도보 길안내)로 열린다.
// 비교 헤더·사진·출처·상세처럼 전체 카드에만 있는 것을 보려면 먼저 펼친다 — 손잡이 버튼의 접근 이름은
// card.peek.expand, 상세 토글은 card.detailsExpand 다(라벨은 바꾸지 않는다).
// 미리보기가 없으면 실패한다: 390px e2e 에서 미리보기가 사라진 것 자체가 회귀다.

const PEEK_EXPAND = { ko: '추천 자세히 보기', en: 'See the full recommendation' } as const;
const DETAILS_EXPAND = { ko: '상세 정보 펼치기', en: 'Show details' } as const;
export type RecCardLocale = keyof typeof PEEK_EXPAND;

/** 미리보기 → 전체 카드. */
export async function expandPeek(page: Page, locale: RecCardLocale = 'ko'): Promise<void> {
  await page.getByRole('button', { name: PEEK_EXPAND[locale] }).click();
  await expect(page.getByTestId('rec-card-peek')).toBeHidden();
}

/** 미리보기를 펼친 뒤 '상세 정보 펼치기'까지 — 사진·출처·영업시간이 있는 상세 패널을 연다. */
export async function openCardDetails(page: Page, locale: RecCardLocale = 'ko'): Promise<void> {
  await expandPeek(page, locale);
  await page.getByRole('button', { name: DETAILS_EXPAND[locale] }).click();
}
