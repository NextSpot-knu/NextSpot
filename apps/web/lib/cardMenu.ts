// 추천 카드 맨 앞에 보일 '무엇을 파는 곳인가' 한 줄 — 음식점·카페만.
//
// 1) 실제 메뉴가 있으면 그것(kind 'menu' — 화면은 '대표 메뉴' 라고 부른다): TourAPI 대표·취급 메뉴(first_menu ·
//    treat_menu)와 경주시 맛집 데이터의 메뉴(menu). 운영 데이터에서 음식점 1,121곳 중 약 70곳뿐이다(10-10 확인).
// 2) 없으면 카카오 장소 분류(kind 'cuisine' — '대표 메뉴' 라고 부르지 않는다): ['한식','육류,고기','갈비'] →
//    '한식 · 갈비'. 맨 위 분류와 가장 자세한 분류만 쓰고, 상호(체인 이름)인 분류는 뺀다('컴포즈커피 황리단길점' 의
//    '컴포즈커피'). 음식점 1,109곳 · 카페 296곳에 있다.
// apiClient 를 거친 시설은 features 키가 camelCase, Supabase 직접 읽기 폴백은 snake_case — 둘 다 읽는다.

export interface CardMenu {
  kind: 'menu' | 'cuisine';
  items: string[];
}

type Features = Record<string, unknown> | null | undefined;

const MENU_SPLIT = /[,/\n·]+/;
// 숫자 사이 쉼표(가격 '15,000원')는 나누지 않는다 — 잠시 다른 글자로 바꿔 두었다가 되돌린다(정규식 lookbehind 는 구형
// iOS Safari 에서 번들 전체를 깨뜨리므로 쓰지 않는다).
const DIGIT_COMMA = /(\d),(?=\d)/g;
const DIGIT_COMMA_MARK = '\u0000';
// 원문에 '메뉴 없음' 대신 들어 있는 자리표시 값 — 음식 이름처럼 카드 앞에 내지 않는다.
const PLACEHOLDER = new Set(['없음', '해당없음', '정보없음', '미정', '기타', '-', '--', '.', '0', 'x', 'X']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

/** 실제 메뉴 이름들 — 중복 없이 앞에서부터. '스시, 나가사키짬뽕 등 일식' 의 '등 …' 꼬리는 뗀다. */
export function menuItems(features: Features, limit = 5): string[] {
  const f = features ?? {};
  const raw = [
    f.firstMenu ?? f.first_menu,
    f.treatMenu ?? f.treat_menu,
    f.menu,
  ].map(text).filter((value): value is string => value !== null);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const source of raw) {
    for (const piece of source.replace(DIGIT_COMMA, `$1${DIGIT_COMMA_MARK}`).split(MENU_SPLIT)) {
      const item = piece.split(DIGIT_COMMA_MARK).join(',').replace(/\s+등(\s.*)?$/, '').trim();
      if (!item || PLACEHOLDER.has(compact(item)) || seen.has(compact(item))) continue;
      seen.add(compact(item));
      items.push(item);
    }
  }
  return items.slice(0, limit);
}

/** 카카오 분류에서 맨 위 + 가장 자세한 것(상호 조각 제외). '육류,고기' 처럼 한 단계 안의 쉼표는 '·' 로. */
export function cuisineItems(features: Features, name: string): string[] {
  const f = features ?? {};
  const raw = f.cuisineTags ?? f.cuisine_tags;
  const tags = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
    .map(text)
    .filter((value): value is string => value !== null)
    .map((tag) => tag.trim());
  const placeName = compact(name);
  const kept = tags.filter((tag) => tag.length <= 12 && !(placeName && placeName.includes(compact(tag))));
  if (kept.length === 0) return [];
  const pretty = (tag: string) => tag.split(',').map((part) => part.trim()).filter(Boolean).join('·');
  const first = pretty(kept[0]);
  const last = pretty(kept[kept.length - 1]);
  return first === last ? [first] : [first, last];
}

export function cardMenu(type: string | null | undefined, name: string, features: Features, limit = 3): CardMenu | null {
  if (type !== 'restaurant' && type !== 'cafe') return null;
  const menu = menuItems(features, limit);
  if (menu.length > 0) return { kind: 'menu', items: menu };
  const cuisine = cuisineItems(features, name);
  return cuisine.length > 0 ? { kind: 'cuisine', items: cuisine } : null;
}
