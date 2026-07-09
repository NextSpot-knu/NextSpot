// NextSpot 다국어(i18n) 사전 — 정적 export 앱이라 서버 로케일 라우팅 대신 클라이언트 사전을 쓴다.
// 소스 언어는 ko. en/ja/zh 는 스타터(핵심 공통 문자열)만 채워져 있고, 미번역 키는 lib/i18n/I18nProvider.ts
// 의 t() 가 ko 로 폴백한다. 전 페이지 문자열을 t() 로 감싸는 전면 패스에서 네임스페이스를 확장한다.

export type Locale = 'ko' | 'en' | 'ja' | 'zh';
export const DEFAULT_LOCALE: Locale = 'ko';

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
];

export type Messages = { [k: string]: string | Messages };

// 소스(ko) — 실제 UI 문자열의 단일 정의점. 전면 패스에서 네임스페이스를 확장한다.
const ko: Messages = {
  common: {
    appName: 'NextSpot',
    retry: '다시 시도',
    close: '닫기',
    save: '저장',
    loading: '불러오는 중...',
    empty: '표시할 내용이 없어요',
    error: '문제가 발생했어요',
  },
  nav: { home: '홈', saved: '저장', mypage: '마이' },
  landing: { tagline: '기다림 없는 스마트한 경주 여행', tapToStart: '탭하여 시작' },
  setup: {
    step1: '어떤 장소에\n가장 관심이 있으세요?',
    step2: '어떤 음식을\n좋아하세요?',
    step3: '주로 언제\n여행을 즐기세요?',
    next: '다음',
    start: '시작하기',
  },
  saved: {
    title: '저장한 장소',
    emptyTitle: '아직 저장한 장소가 없어요',
    emptyBody: '경주 황리단길에서 마음에 든 장소를 저장하면 여기에 모여요.',
    browseMap: '지도 둘러보기',
    clearAll: '전체 초기화',
  },
  map: { heatmap: '히트맵', now: '지금', forecast: 'AI 예측', barrierFree: '배리어프리' },
};

// en — 스타터 번역(핵심 공통). 미번역 키는 ko 로 폴백.
const en: Messages = {
  common: {
    appName: 'NextSpot',
    retry: 'Retry',
    close: 'Close',
    save: 'Save',
    loading: 'Loading...',
    empty: 'Nothing to show',
    error: 'Something went wrong',
  },
  nav: { home: 'Home', saved: 'Saved', mypage: 'My' },
  landing: { tagline: 'Smart Gyeongju travel, without the wait', tapToStart: 'Tap to start' },
  setup: {
    step1: 'Which places\ninterest you most?',
    step2: 'What food\ndo you like?',
    step3: 'When do you\nusually travel?',
    next: 'Next',
    start: 'Get started',
  },
  saved: {
    title: 'Saved places',
    emptyTitle: 'No saved places yet',
    emptyBody: 'Save places you like around Hwangnidan-gil and they will appear here.',
    browseMap: 'Browse the map',
    clearAll: 'Clear all',
  },
  map: { heatmap: 'Heatmap', now: 'Now', forecast: 'AI forecast', barrierFree: 'Barrier-free' },
};

// ja — 스타터 번역(핵심 공통). 미번역 키는 ko 로 폴백.
const ja: Messages = {
  common: {
    appName: 'NextSpot',
    retry: '再試行',
    close: '閉じる',
    save: '保存',
    loading: '読み込み中...',
    empty: '表示する内容がありません',
    error: '問題が発生しました',
  },
  nav: { home: 'ホーム', saved: '保存', mypage: 'マイ' },
  landing: { tagline: '待たないスマートな慶州旅行', tapToStart: 'タップして開始' },
  setup: {
    step1: 'どんな場所に\n一番興味がありますか？',
    step2: 'どんな料理が\nお好きですか？',
    step3: 'いつ旅行を\n楽しみますか？',
    next: '次へ',
    start: 'はじめる',
  },
  saved: {
    title: '保存した場所',
    emptyTitle: 'まだ保存した場所がありません',
    emptyBody: '慶州・皇理団ギルで気に入った場所を保存するとここに集まります。',
    browseMap: '地図を見る',
    clearAll: 'すべて削除',
  },
  map: { heatmap: 'ヒートマップ', now: '現在', forecast: 'AI予測', barrierFree: 'バリアフリー' },
};

// zh — 스타터 번역(핵심 공통). 미번역 키는 ko 로 폴백.
const zh: Messages = {
  common: {
    appName: 'NextSpot',
    retry: '重试',
    close: '关闭',
    save: '保存',
    loading: '加载中...',
    empty: '暂无内容',
    error: '出现了问题',
  },
  nav: { home: '首页', saved: '收藏', mypage: '我的' },
  landing: { tagline: '无需等待的智慧庆州之旅', tapToStart: '点击开始' },
  setup: {
    step1: '你最感兴趣的\n是哪类地方？',
    step2: '你喜欢\n什么美食？',
    step3: '你通常\n什么时候出游？',
    next: '下一步',
    start: '开始',
  },
  saved: {
    title: '收藏的地点',
    emptyTitle: '还没有收藏的地点',
    emptyBody: '在庆州皇理团街收藏喜欢的地点，就会出现在这里。',
    browseMap: '浏览地图',
    clearAll: '全部清除',
  },
  map: { heatmap: '热力图', now: '现在', forecast: 'AI预测', barrierFree: '无障碍' },
};

export const dictionaries: Record<Locale, Messages> = { ko, en, ja, zh };
