// 디자인 토큰 — 웹 apps/web/app/globals.css 의 `:root`(라이트) 와 `@theme inline` 을 앱으로 옮긴 단일 정의점.
//
// 왜 값을 다시 적는가: React Native 에는 CSS 변수·color-mix 가 없다. 그래서 웹 변수 값을 hex 로 적고,
// 웹이 color-mix 로 섞는 색은 미리 계산해 둔다. 웹 값이 바뀌면 tokens.test.ts 가 globals.css 를 읽어 어긋남을 잡는다.
// tailwind.config.js 가 이 파일을 읽어 웹과 같은 클래스 이름(bg-hanji · text-muk · text-gold …)을 만든다.
// 라이트 테마만 옮긴다(앱은 어두운 테마를 쓰지 않는다 — app.json userInterfaceStyle).
//
// 이 파일은 tailwind.config.js 가 Node(jiti)로도 읽는다 — React Native import 를 넣지 않는다.

/** 웹 `:root` 의 --nextspot-* (라이트) 와 `@theme inline` 의 --color-* 를 같은 이름으로. */
export const colors = {
  background: '#faf5ec',
  foreground: '#2b2320',

  // 한지(관광객 라이트)
  hanji: '#faf5ec',
  'hanji-deep': '#f1e7d3',
  muk: '#2b2320',
  'muk-soft': '#6b5d4f',
  line: '#e6dcc6',

  // 단청 오방색 강조
  gold: '#c19a3e',
  /** 작은 글자용 금 — 흰·한지·한지 진 바탕에서 4.5:1 이상(웹 lib/contrast.test.ts). */
  'gold-deep': '#705819',
  jade: '#3e7c6a',
  terracotta: '#c1553b',
  'dan-red': '#b5322e',
  'sunset-1': '#e8895a',
  'sunset-2': '#c15b7a',

  // 사진 없는 장소의 표지 색(웹 components/PlacePhotoFallback.tsx)
  'tile-slate': '#5b6878',
  'tile-indigo': '#465a8c',
  'tile-stone': '#77736c',

  // 주요 버튼 그라데이션(흰 글자 전 구간 4.5:1 이상)
  'cta-from': '#8a6a1c',
  'cta-to': '#a8462f',

  // 유리 위 보조 글자 — 유리 안에서만 쓴다
  'glass-muk-soft': '#463b34',
  'glass-gold-deep': '#4b3b1d',

  // 한옥(관리자 콘솔) — 앱에는 콘솔이 없지만 이름을 맞춰 둔다
  hanok: '#efe7d8',
  'hanok-panel': '#f8f3e9',
  'hanok-card': '#fffdf7',
  'hanok-line': '#d8cab2',
  'hanok-ink': '#251d15',
  'hanok-muted': '#63533f',

  // ── 웹이 color-mix·rgb() 로 만드는 색을 미리 계산한 것(앱 전용 이름) ──
  /** 선택된 칩 바탕: color-mix(jade 18%, hanji) — 웹 app/main/page.tsx layerChipClass. */
  'jade-chip': '#d8dfd5',
  /** 장소 표지 바탕: color-mix(tile 13%, hanji-deep) — 웹 .place-tile. */
  'tile-slate-bg': '#ded6c7',
  'tile-indigo-bg': '#dbd5ca',
  'tile-stone-bg': '#e1d8c6',
  /** 유리(regular) 바탕: hanji 35% — 흐림 위에서만(iOS). */
  'glass-bg': 'rgba(250, 245, 236, 0.35)',
  /** 흐림이 없을 때(안드로이드)의 유리 바탕 — 흐린 지도가 없으니 글자 대비를 위해 거의 불투명하게. */
  'glass-bg-solid': 'rgba(250, 245, 236, 0.92)',
  /** 유리 가장자리 빛. */
  'glass-edge': 'rgba(255, 255, 255, 0.85)',
  /** 왼쪽 내비 캡슐(.rail-glass) — 매우 어두운 갈색 반투명. 흐림 위 72%, 흐림 없으면 95%. */
  'rail-bg': 'rgba(30, 21, 16, 0.72)',
  'rail-bg-solid': 'rgba(30, 21, 16, 0.95)',
  'rail-edge': 'rgba(255, 255, 255, 0.16)',
  /** rail 안에서 뒤집힌 글자 색(.rail-glass 의 --nextspot-* 재정의). */
  'rail-muk': '#f3eadb',
  'rail-muk-soft': '#d9cbb6',
  'rail-gold': '#d8b45b',
  'rail-gold-deep': '#efcd78',
  'rail-line': 'rgba(255, 255, 255, 0.22)',
  white: '#ffffff',
} as const;

export type ColorToken = keyof typeof colors;

/** 웹의 퍼센트 토큰(0~1). */
export const ratios = {
  /** --nextspot-glass-tint: 35% */
  glassTint: 0.35,
  /** --nextspot-tile-mix: 13% */
  tileMix: 0.13,
} as const;

/** 그라데이션 — expo-linear-gradient 의 colors·start·end 로 바로 넘긴다. */
export const gradients = {
  /** .cta-primary — 90deg 금 진 → 주칠(흰 글자). */
  cta: { colors: [colors['cta-from'], colors['cta-to']], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
  /** .gradient-text·.sunset 계열 — 90deg 금 → 주칠. */
  goldTerracotta: { colors: [colors.gold, colors.terracotta], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
  /** 노을 — sunset-1 → sunset-2. */
  sunset: { colors: [colors['sunset-1'], colors['sunset-2']], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
} as const;

/** 그림자 — RN 0.76+ 의 boxShadow 문자열(새 아키텍처). 웹 클래스에서 그대로 옮겼다. */
export const shadows = {
  /** 카드·빈/오류 상태 — shadow-[0_2px_14px_rgba(43,35,32,0.06)] */
  card: '0px 2px 14px rgba(43, 35, 32, 0.06)',
  /** .toss-surface */
  surface: '0px 1px 2px rgba(43, 35, 32, 0.05), 0px 10px 30px rgba(43, 35, 32, 0.10)',
  /** 주 버튼 — shadow-[0_4px_14px_rgba(168,70,47,0.28)] */
  cta: '0px 4px 14px rgba(168, 70, 47, 0.28)',
  /** 유리 판 */
  glass: '0px 6px 22px rgba(43, 35, 32, 0.16)',
  rail: '0px 6px 22px rgba(0, 0, 0, 0.28)',
} as const;

/**
 * 글꼴 — Freesentation(OFL). 안드로이드는 굵기마다 family 이름이 하나여야 해서 파일 하나 = 이름 하나다.
 * 웹이 실제로 쓰는 굵기만 넣었다(font-normal·medium·semibold·bold·extrabold·black · CSS 650/750 은 브라우저가 700/800 을 고른다).
 */
export const fontFamilies = {
  regular: 'Freesentation-4Regular',
  medium: 'Freesentation-5Medium',
  semibold: 'Freesentation-6SemiBold',
  bold: 'Freesentation-7Bold',
  extrabold: 'Freesentation-8ExtraBold',
  black: 'Freesentation-9Black',
} as const;

export type FontWeightName = keyof typeof fontFamilies;

/**
 * Tailwind font-normal… 이름 → 굵기 이름. Text 가 className 에서 읽는다.
 * 앱에 없는 굵기는 가까운 글꼴로: 웹 font-[650]·[750] 은 브라우저가 700·800 을 고르므로 bold·extrabold,
 * font-thin·extralight·light 는 글꼴 파일이 없어 regular(웹 사용처는 장식 숫자뿐 — 얇게 보일 필요 없음).
 */
export const weightClassToName: Record<string, FontWeightName> = {
  'font-thin': 'regular',
  'font-extralight': 'regular',
  'font-light': 'regular',
  'font-[650]': 'bold',
  'font-[750]': 'extrabold',
  'font-normal': 'regular',
  'font-medium': 'medium',
  'font-semibold': 'semibold',
  'font-bold': 'bold',
  'font-extrabold': 'extrabold',
  'font-black': 'black',
};

/** 아이콘 크기(px) — 웹 lucide 사용처의 12·14·16·20·24 를 이름으로. */
export const iconSizes = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;
export type IconSize = keyof typeof iconSizes;

/**
 * 스프링 — 웹 lib/motion.ts 의 두 가지(framer 타입을 끌고 와서 import 하지 않고 값만 옮긴다 · tokens.test.ts 가 대조).
 * Reanimated withSpring 설정으로 바로 쓴다.
 */
export const springs = {
  /** 작은 요소, 거의 튀지 않음. */
  interaction: { stiffness: 460, damping: 34, mass: 0.72 },
  /** 시트. */
  sheet: { stiffness: 380, damping: 32, mass: 0.82 },
} as const;

/** 탭 영역 최소(pt) — docs/DESIGN_PRINCIPLES.md 측정 기준. */
export const MIN_TAP = 44;

/** 펼친 폴더블·태블릿에서 내용 최대 폭(pt) — 가운데 정렬(계획 §9.1 화면별 점검표). */
export const CONTENT_MAX_WIDTH = 640;
