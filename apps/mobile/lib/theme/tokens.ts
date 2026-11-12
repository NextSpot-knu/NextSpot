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
  /**
   * 금 단색 버튼 바탕(Button variant="gold" 가 이것 하나만 읽는다) — 흰 글자 대비 6.78:1.
   * 웹 bg-gold(#c19a3e)는 흰 글자 2.64:1 이라 D2(a)② 로 웹·앱 모두 금 진으로 바꾼다(docs/MOBILE_WEB_PARITY.md §3.2).
   */
  'button-gold': '#705819',

  // 바탕 그라데이션 끝색 — sunset-1 을 hanji 위에 섞은 값(tokens.test.ts 가 계산식으로 잠근다)
  /** 랜딩: color-mix(sunset-1 25%, hanji). */
  'landing-sunset-end': '#f6dac8',
  /** 로그인·가입: color-mix(sunset-1 20%, hanji). */
  'auth-sunset-end': '#f6dfcf',

  // 카카오 로그인 버튼(카카오 디자인 가이드 색)
  'kakao-yellow': '#fee500',
  'kakao-ink': '#191600',

  // 혼잡 혜택 띠(웹 globals.css .benefit-relaxed·.benefit-quiet) — 테두리 /35 · 바탕 /10 는 base, 글자는 ink
  'benefit-relaxed': '#10b981',
  'benefit-relaxed-ink': '#047857',
  'benefit-quiet': '#1d4ed8',
  'benefit-quiet-ink': '#1d4ed8',

  // 웹 Tailwind v4 기본 색(sRGB) — NativeWind(Tailwind 3.4) 의 같은 이름은 값이 달라서 *-web 으로 따로 둔다
  'emerald-500-web': '#00bc7d',
  'sky-500-web': '#00a6f4',
  'sky-700-web': '#0069a8',
  'sky-800-web': '#00598a',
  'sky-900-web': '#024a70',
  'indigo-500-web': '#615fff',
  'indigo-700-web': '#432dd7',
  'indigo-900-web': '#312c85',

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
  /** 흐림 없는 안드로이드 유리 바탕(D14 ③ — hanji 70%). 흐림이 되는 기기는 glass-bg. */
  'glass-bg-android': 'rgba(250, 245, 236, 0.7)',
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
  /** 랜딩 바탕 — 위에서 아래로 hanji → hanji-deep → 노을 끝. */
  landing: { colors: [colors.hanji, colors['hanji-deep'], colors['landing-sunset-end']], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } },
  /** 로그인·가입 바탕 — 위에서 아래로 hanji → hanji-deep → 노을 끝. */
  auth: { colors: [colors.hanji, colors['hanji-deep'], colors['auth-sunset-end']], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } },
  /** 1위 순위 배지 — 135deg cta-from → 금 진(흰 숫자 5.05:1 이상, D2. 웹 금 시작은 2.64:1). */
  goldRank: { colors: [colors['cta-from'], colors['gold-deep']], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
  /** 마이 임팩트 카드 — 90deg 금 15% → hanji → 옥 10%. */
  impactCard: { colors: ['rgba(193, 154, 62, 0.15)', colors.hanji, 'rgba(62, 124, 106, 0.10)'], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
  /** 마이 절약 띠 — 90deg 금 15% → hanji-deep 60% → 옥 10%. */
  savedBanner: { colors: ['rgba(193, 154, 62, 0.15)', 'rgba(241, 231, 211, 0.6)', 'rgba(62, 124, 106, 0.10)'], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
  /** 실험실 카드 — 90deg 옥 12% → hanji → 금 10%. */
  labCard: { colors: ['rgba(62, 124, 106, 0.12)', colors.hanji, 'rgba(193, 154, 62, 0.10)'], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
  /** 게스트 계정 카드(웹 merchant 카드와 같은 틀) — 90deg 금 15% → hanji → 주칠 10%. */
  merchantCard: { colors: ['rgba(193, 154, 62, 0.15)', colors.hanji, 'rgba(193, 85, 59, 0.10)'], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
} as const;

/** 그림자 — RN 0.76+ 의 boxShadow 문자열(새 아키텍처). 웹 클래스에서 그대로 옮겼다. */
export const shadows = {
  /** 카드·빈/오류 상태 — shadow-[0_2px_14px_rgba(43,35,32,0.06)] */
  card: '0px 2px 14px rgba(43, 35, 32, 0.06)',
  /** .toss-surface */
  surface: '0px 1px 2px rgba(43, 35, 32, 0.05), 0px 10px 30px rgba(43, 35, 32, 0.10)',
  /** 주 버튼 — shadow-[0_4px_14px_rgba(168,70,47,0.28)] */
  cta: '0px 4px 14px rgba(168, 70, 47, 0.28)',
  /** 큰 주 버튼(설정 시작하기 등) — shadow-[0_8px_20px_rgba(168,70,47,0.28)] */
  ctaLg: '0px 8px 20px rgba(168, 70, 47, 0.28)',
  /** 랜딩 바로 시작 — shadow-[0_8px_24px_rgba(168,70,47,0.28)] */
  ctaHero: '0px 8px 24px rgba(168, 70, 47, 0.28)',
  /** 금 테두리 요소의 옅은 빛 — 0 2 10 금 .16 */
  goldSoft: '0px 2px 10px rgba(193, 154, 62, 0.16)',
  /** 순위 배지 — shadow-[0_2px_8px_rgba(193,154,62,0.45)] */
  goldBadge: '0px 2px 8px rgba(193, 154, 62, 0.45)',
  /** 유리 판 */
  glass: '0px 6px 22px rgba(43, 35, 32, 0.16)',
  rail: '0px 6px 22px rgba(0, 0, 0, 0.28)',
  /** 웹 --glass-shadow 전체(globals.css .liquid-glass) — 위 1px 흰 빛선 · 아래 1px 옅은 빛선 · 바깥 그림자. */
  glassInset: 'inset 0px 1px 0px rgba(255, 255, 255, 0.95), inset 0px -1px 0px rgba(255, 255, 255, 0.35), 0px 6px 22px rgba(43, 35, 32, 0.16)',
  /** 웹 .rail-glass box-shadow 전체. */
  railInset: 'inset 0px 1px 0px rgba(255, 255, 255, 0.18), 0px 6px 22px rgba(0, 0, 0, 0.28)',
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

/**
 * 글꼴 목록(웹 globals.css) — 웹 빌드의 Freesentation 대체 목록(--font-sans 뒤쪽)과 ja·zh 시스템 글꼴(html:lang(ja|zh) 앞쪽).
 * components/ui/textStyle.ts fontStyleFor 가 쓴다.
 */
export const fontStacks = {
  webFallback: "'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif",
  ja: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", Meiryo, "Yu Gothic UI"',
  zh: '"PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI", "Microsoft YaHei"',
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

/**
 * 하단 탭 막대 높이(pt, 안전 영역 제외) — 웹 BottomNav 실측(안내 줄 32 + 탭 48 + 여백, 390px).
 * 화면은 이 값을 직접 쓰지 말고 components/navigation/navMetrics 의 NAV_GAP·useNavInsets() 를 쓴다.
 */
export const NAV_BAR_HEIGHT = 101;
/** 웹 --tourist-nav-clearance(모바일 폭) — 웹이 막대 밑 내용에 주는 아래 여백. tokens.test.ts 가 globals.css 와 대조한다. */
export const NAV_CLEARANCE = 116;

/** 탭 영역 최소(pt) — docs/DESIGN_PRINCIPLES.md 측정 기준. */
export const MIN_TAP = 44;

/** 펼친 폴더블·태블릿에서 내용 최대 폭(pt) — 가운데 정렬(계획 §9.1 화면별 점검표). */
export const CONTENT_MAX_WIDTH = 640;
