export interface SearchablePlace {
  name?: unknown;
  address?: unknown;
  features?: Record<string, unknown> | null;
}

const PLACE_SEARCH_ALIASES: Record<string, string[]> = {
  '아메리카노': ['커피', '에스프레소'],
  '라떼': ['카페라떼'],
  '돼지고기': ['삼겹살', '목살', '돼지갈비', '고깃집', '육류'],
  '돼지 고기': ['삼겹살', '목살', '돼지갈비', '고깃집', '육류'],
  '구이': ['고깃집', '숯불', '갈비', '삼겹살', '목살'],
  '고기': ['고깃집', '육류', '삼겹살', '목살', '갈비'],
};

const EXACT_TOKEN_ALIASES = new Set(['고기', '구이']);

function facilitySearchText(place: SearchablePlace): string {
  const features = place.features ?? {};
  const facts = [
    place.name,
    place.address,
    features.category,
    features.category_name,
    features.cuisine_tags,
    features.cuisine,
    features.first_menu,
    features.firstMenu,
    features.treat_menu,
    features.treatMenu,
    features.overview,
    features.description,
  ];
  return facts
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 상호·주소와 저장된 실제 메뉴/업종/소개만 검색한다. 동의어는 매칭용이며 메뉴로 저장하지 않는다. */
export function facilityMatchesSearch(place: SearchablePlace, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  const compactQuery = query.replace(/\s+/g, '');
  const tokens = new Set(query.match(/[0-9a-z가-힣]+/g) ?? []);
  const aliases = Object.entries(PLACE_SEARCH_ALIASES)
    .find(([key]) => EXACT_TOKEN_ALIASES.has(key) ? tokens.has(key) : query.includes(key))?.[1] ?? [];
  const terms = [compactQuery, ...aliases.map((term) => term.replace(/\s+/g, ''))];
  const haystack = facilitySearchText(place);
  return terms.some((term) => term && haystack.includes(term));
}
