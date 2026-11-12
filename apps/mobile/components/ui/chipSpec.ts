// Chip variant 표(순수) — docs/MOBILE_WEB_PARITY.md F5, review-R2.md. 선택 모양이 화면마다 달라 variant 가 웹 클래스 묶음을 통째로 갖는다.
import type { ColorToken } from '~/lib/theme/tokens';

export type ChipVariant = 'layer' | 'savedFilter' | 'courseType' | 'labReason';

export type ChipSpec = {
  minHeight: number;
  paddingX: number;
  paddingY: number;
  /** 글자·아이콘 간격. */
  gap: number;
  /** 위아래 탭 영역 넓힘 — 보이는 높이 + 2×이 값이 44 이상이 되게. */
  hitSlopY: number;
  labelClass: string;
  labelWeight: 'medium' | 'semibold' | 'bold';
  selectedClass: string;
  idleClass: string;
  selectedTextClass: string;
  idleTextClass: string;
  selectedIcon: ColorToken;
  idleIcon: ColorToken;
  disabledClass: string;
  /** 선택일 때 그림자(웹 shadow-[…]). */
  selectedShadow?: string;
};

export const CHIP_SPECS: Record<ChipVariant, ChipSpec> = {
  // 홈 레이어·필터 칩(웹 app/main/page.tsx layerChipClass) — 지금 모양 그대로.
  layer: {
    minHeight: 32,
    paddingX: 12,
    paddingY: 6,
    gap: 6,
    hitSlopY: 6,
    labelClass: 'text-[13px]',
    labelWeight: 'semibold',
    selectedClass: 'border-jade bg-jade-chip',
    idleClass: 'border-line bg-white',
    selectedTextClass: 'text-muk',
    idleTextClass: 'text-muk-soft',
    selectedIcon: 'jade',
    idleIcon: 'muk-soft',
    disabledClass: 'opacity-50',
  },
  // 저장 분류 칩(웹 app/saved/page.tsx:309-313) — min-h-11 px-3.5 text-[13px] medium, 금 선택 + muk.
  savedFilter: {
    minHeight: 44,
    paddingX: 14,
    paddingY: 0,
    gap: 6,
    hitSlopY: 0,
    labelClass: 'text-[13px] leading-[19.5px]',
    labelWeight: 'medium',
    selectedClass: 'border-gold bg-gold/15',
    idleClass: 'border-line bg-white',
    selectedTextClass: 'text-muk',
    idleTextClass: 'text-muk-soft',
    selectedIcon: 'gold-deep',
    idleIcon: 'muk-soft',
    disabledClass: 'opacity-50',
  },
  // 코스 종류 칩(웹 app/course/page.tsx:1266-1270) — min-h-11 px-4 13px bold, 금 선택 + gold-deep + 그림자, disabled 0.4.
  courseType: {
    minHeight: 44,
    paddingX: 16,
    paddingY: 0,
    gap: 6,
    hitSlopY: 0,
    labelClass: 'text-[13px] leading-[19.5px]',
    labelWeight: 'bold',
    selectedClass: 'border-gold bg-gold/15',
    idleClass: 'border-line bg-white',
    selectedTextClass: 'text-gold-deep',
    idleTextClass: 'text-muk-soft',
    selectedIcon: 'gold-deep',
    idleIcon: 'muk-soft',
    disabledClass: 'opacity-40',
    selectedShadow: '0px 2px 10px rgba(193, 154, 62, 0.18)',
  },
  // 실험실 이유 칩(웹 app/mypage/lab/page.tsx:331-345) — 높이 30, text-xs medium, 선택 바탕 button-gold + 흰 글자.
  labReason: {
    minHeight: 30,
    paddingX: 12,
    paddingY: 6,
    gap: 6,
    hitSlopY: 7,
    labelClass: 'text-xs',
    labelWeight: 'medium',
    selectedClass: 'border-gold bg-button-gold',
    idleClass: 'border-line bg-hanji',
    selectedTextClass: 'text-white',
    idleTextClass: 'text-muk',
    selectedIcon: 'white',
    idleIcon: 'muk',
    disabledClass: 'opacity-50',
  },
};

/** 읽기 화면 이름 — 개수가 있으면 "카페 1" 처럼 글자 뒤에 붙인다(저장 분류 칩). */
export function chipAccessibilityLabel(label: string, count: number | undefined, explicit: string | undefined): string {
  if (explicit) return explicit;
  return count === undefined ? label : `${label} ${count}`;
}
