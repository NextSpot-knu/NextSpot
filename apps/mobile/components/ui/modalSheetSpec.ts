// ModalSheet 선택 prop 의 값 계산 — react-native 를 import 하지 않는 순수 모듈(modalSheetSpec.test.ts 가 잠근다).
// docs/MOBILE_WEB_PARITY.md §4.2 F8: 기본값은 지금 모양 그대로, 호출부가 웹 값을 넘긴다.
//
// 웹 바닥 시트는 두 갈래다(R1 3절 'ModalSheet').
//  - 대화 시트(혼잡 제보 CongestionReportButton · 지금 한산 TodayCalmSpots · 설치 안내 InstallPrompt):
//    bg-hanji border-line rounded-t-3xl, 그림자 0 -8px 40px rgba(43,35,32,.2), 막 bg-muk/40 + 흐림, max-w-sm(384), p-6,
//    머리 X = p-1.5 muk-soft.
//  - 판 시트(필터·편의 app/main/page.tsx · 축제 FestivalBanner · 화장실 RestroomChip):
//    bg-hanji rounded-t-3xl shadow-2xl(테두리 없음), 막 bg-muk/35(필터) · bg-black/30(축제·화장실), 폭 full · max-w-lg(512),
//    여백 px-4 pt-3 pb-[20+safe](필터) · p-5(축제·화장실), 머리 X = p-2 muk(축제·화장실) · 흰 원 테두리 p-2(필터).
import { colors } from '../../lib/theme/tokens';

/** 판 바탕 — default: 지금 모양(흰 95%, 안드로이드는 불투명 흰), hanji: 웹 bg-hanji. */
export type ModalSheetBackground = 'default' | 'hanji';

/**
 * 머리 X 모양(웹 값) — 아이콘은 모두 X 18.
 *  - muted: p-1.5 · muk-soft · 바탕 없음(혼잡 제보 · 지금 한산 · 설치 안내)
 *  - plain: p-2 · muk · 바탕 없음(축제 · 화장실)
 *  - bordered: p-2 · muk · 흰 원 + border-line(필터·편의)
 */
export type ModalSheetCloseVariant = 'muted' | 'plain' | 'bordered';

/** X 아이콘 크기(웹 lucide X size={18}). */
export const MODAL_SHEET_CLOSE_ICON = 18;

/** 머리 X 의 보이는 상자 한 변(pt) — 18 + 위아래 여백(+ 테두리 2). 머리 줄은 이만큼 + 간격을 오른쪽에 비워 둔다. */
export const MODAL_SHEET_CLOSE_BOX: Record<ModalSheetCloseVariant, number> = {
  muted: MODAL_SHEET_CLOSE_ICON + 6 * 2,
  plain: MODAL_SHEET_CLOSE_ICON + 8 * 2,
  bordered: MODAL_SHEET_CLOSE_ICON + 8 * 2 + 2,
};

/**
 * 머리 X 의 hitSlop — 탭 영역을 44pt 까지 넓히되 부모(내용 판) 밖으로는 넘기지 않는다. 안드로이드는 부모 밖의 hitSlop 을
 * 받지 않아, 위 여백이 0(기본)일 때 위로 넘긴 영역은 눌리지 않고 TalkBack 의 탭 영역 판정만 어긋난다.
 * top·right = X 가 놓인 자리(내용 여백)만큼까지.
 */
export function closeHitSlop(variant: ModalSheetCloseVariant, top: number, right: number, minTap = 44) {
  const slop = Math.max(0, Math.ceil((minTap - MODAL_SHEET_CLOSE_BOX[variant]) / 2));
  return { top: Math.min(slop, Math.max(0, top)), right: Math.min(slop, Math.max(0, right)), bottom: slop, left: slop };
}

export type ModalSheetPadding ={ x?: number; top?: number; bottom?: number };
export type ModalSheetBackdrop = { color?: string; opacity?: number };

/** 지금 모양(B3 전과 같다) — 선택 prop 을 주지 않으면 이 값. */
export const MODAL_SHEET_DEFAULT_PADDING = { x: 16, top: 0, bottom: 16 } as const;
export const MODAL_SHEET_DEFAULT_BACKDROP = { color: '#000000', opacity: 0.35 } as const;

/** 내용 여백 — 아래는 늘 아래 안전 영역을 더한다(제스처 막대 위에서 끝나게). */
export function resolveContentPadding(padding: ModalSheetPadding | undefined, bottomInset: number) {
  const x = padding?.x ?? MODAL_SHEET_DEFAULT_PADDING.x;
  const top = padding?.top ?? MODAL_SHEET_DEFAULT_PADDING.top;
  const bottom = padding?.bottom ?? MODAL_SHEET_DEFAULT_PADDING.bottom;
  return { paddingHorizontal: x, paddingTop: top, paddingBottom: bottom + bottomInset };
}

export function resolveBackdrop(backdrop: ModalSheetBackdrop | undefined) {
  return {
    color: backdrop?.color ?? MODAL_SHEET_DEFAULT_BACKDROP.color,
    opacity: backdrop?.opacity ?? MODAL_SHEET_DEFAULT_BACKDROP.opacity,
  };
}

/** 폭 상한이 화면보다 좁으면 좌우를 같은 만큼 띄워 가운데에 둔다(웹 max-w-* + justify-center). */
export function sheetSideMargin(windowWidth: number, maxWidth: number | undefined): number {
  if (maxWidth === undefined || !(windowWidth > maxWidth)) return 0;
  return Math.round((windowWidth - maxWidth) / 2);
}

/**
 * 판 모양(gorhom backgroundStyle). default 는 지금 값 그대로 — 웹 bg-white/95, 안드로이드는 흐림이 없어 반투명이면
 * 뒤 지도·목록이 비쳐 글자가 겹친다(규칙 7) — 불투명. bordered 는 1px border-line(대화 시트), false 면 테두리 없음(판 시트).
 */
export function sheetSurface(background: ModalSheetBackground, bordered: boolean, platform: string) {
  const backgroundColor =
    background === 'hanji' ? colors.hanji : platform === 'android' ? colors.white : 'rgba(255, 255, 255, 0.95)';
  return {
    backgroundColor,
    borderColor: colors.line,
    borderWidth: bordered ? 1 : 0,
    borderRadius: 24, // 웹 rounded-3xl(아래 모서리는 화면 밖)
  };
}
