// 사진이 없는 가게의 업종 사진 — 음식점·카페 표지 자리에 업종(한식·고기·카페·빵집…)을 보여 주는 사진 한 장.
//
// 왜: 근처 음식점·카페의 대부분(카카오로 찾은 곳)은 우리가 쓸 수 있는 사진이 없다(2026-11-25 실측 1,748곳 중
// 1,690곳). PM 결정(2026-11-25): 가게 사진은 반드시 있어야 한다 — 실사진(사장님·TourAPI·경주시)이 없거나 다 깨지면
// 업종 사진을 표지로 깐다. 사진 파일은 apps/web/public/category/<key>.webp(960×540 WebP). 라이선스는 Unsplash
// License·Pexels License(상업 이용 가능, 출처 표기 의무 없음) — 원본은 파일 맨 아래 CATEGORY_PHOTO_SOURCES.
//
// 이 사진은 '실사진' 이 아니다 — 그래서 사진 후보(photoCredit.ts 의 photoCandidates·creditedPhotoUrls)에 넣지
// 않는다. 넣으면 대기 보드의 '같은 대기면 사진 있는 곳 먼저'(PM 2026-09-28)가 모든 가게를 사진 있음으로 보고,
// 저장 목록·출처 판정도 흐려진다. 그리기는 components/PlacePhotoFallback.tsx 의 cover(배경 그림 — <img> 아님).
//
// 업종은 features.cuisine_tags(카카오 분류의 아래 단계들, API 응답은 camel cuisineTags)로 고른다. 지도 응답은
// kakao_category_name 을 싣지 않으므로(routers/infrastructures.py) 그 키는 쓰지 않는다. 태그가 없으면 유형으로.
// 관광지·문화시설은 업종 사진이 없다(null) — 장소 표지가 그대로 남는다.

export const CATEGORY_PHOTO_KEYS = [
  'cafe',
  'cafe_theme',
  'tea',
  'bakery',
  'ricecake',
  'dessert',
  'korean_bbq',
  'korean',
  'seafood',
  'noodles',
  'soup',
  'tofu',
  'bunsik',
  'chicken',
  'chinese',
  'japanese',
  'western',
  'burger',
  'pub',
  'restaurant',
] as const;
export type CategoryPhotoKey = (typeof CATEGORY_PHOTO_KEYS)[number];

// 앞에서부터 처음 맞는 규칙이 이긴다 — 구체적인 업종을 넓은 업종(한식·카페)보다 앞에 둔다.
// 예: ['한식','육류,고기'] → 고기, ['술집','일본식주점'] → 술집, ['간식','제과,베이커리'] → 빵집.
const RULES: readonly (readonly [CategoryPhotoKey, readonly string[]])[] = [
  ['tea', ['전통찻집']],
  ['bakery', ['제과,베이커리', '베이커리', '도넛']],
  ['ricecake', ['떡,한과']],
  ['dessert', ['아이스크림', '빙수', '아이스크림판매']],
  ['cafe_theme', ['테마카페', '디저트카페', '키즈카페', '북카페', '애견카페']],
  ['cafe', ['커피전문점', '다방', '카페']],
  ['pub', ['술집', '호프,요리주점', '일본식주점', '실내포장마차', '오뎅바', '칵테일바', '와인바']],
  ['chicken', ['치킨', '닭강정']],
  ['korean_bbq', ['육류,고기', '갈비', '삼겹살', '곱창,막창', '오리', '족발,보쌈', '닭요리', '불고기,두루치기']],
  ['seafood', ['해물,생선', '회', '장어', '매운탕,해물탕', '게,대게', '조개', '아구', '복어']],
  ['noodles', ['국수', '칼국수', '냉면', '우동']],
  ['soup', ['국밥', '곰탕', '해장국', '감자탕', '찌개,전골', '순대', '설렁탕', '삼계탕']],
  ['tofu', ['두부전문점']],
  ['bunsik', ['분식', '떡볶이', '김밥']],
  ['chinese', ['중식', '중국요리', '양꼬치']],
  ['japanese', ['일식', '돈까스,우동', '초밥,롤', '일식집', '참치회']],
  ['burger', ['햄버거', '샌드위치', '패스트푸드', '토스트']],
  ['western', ['양식', '피자', '이탈리안', '스테이크,립', '패밀리레스토랑']],
  ['korean', ['한식', '한정식', '쌈밥', '도시락', '한식뷔페', '기사식당', '샤브샤브', '뷔페']],
];

/** features 의 업종 태그(camel cuisineTags · snake cuisine_tags). 문자열 배열이 아니면 빈 배열. */
export function cuisineTagsOf(features: Record<string, unknown> | null | undefined): string[] {
  const raw = features?.cuisineTags ?? features?.cuisine_tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean);
}

/** 이 가게의 업종 사진 키. 음식점·카페가 아니면 null. */
export function categoryPhotoKey(type: string | null | undefined, tags: readonly string[]): CategoryPhotoKey | null {
  if (type !== 'restaurant' && type !== 'cafe') return null;
  const tagSet = new Set(tags);
  for (const [key, names] of RULES) {
    if (names.some((name) => tagSet.has(name))) return key;
  }
  return type === 'cafe' ? 'cafe' : 'restaurant';
}

/** 업종 태그로 고른 업종 사진의 주소(정적 파일). 음식점·카페가 아니면 null. */
export function categoryPhotoUrlFromTags(type: string | null | undefined, tags: readonly string[]): string | null {
  const key = categoryPhotoKey(type, tags);
  return key ? `/category/${key}.webp` : null;
}

/** 업종 사진의 주소(정적 파일). 음식점·카페가 아니면 null. */
export function categoryPhotoUrl(
  type: string | null | undefined,
  features: Record<string, unknown> | null | undefined,
): string | null {
  return categoryPhotoUrlFromTags(type, cuisineTagsOf(features));
}

// 사진 원본(2026-11-25 수집). 바꿀 때는 같은 라이선스(Unsplash·Pexels)만 — 글자·상표·얼굴이 보이지 않는 사진.
// cafe        unsplash.com/photos/T3fFz5W0Foc (nameless 3791)       라테
// cafe_theme  unsplash.com/photos/SNy0Diwv0vI (Juzzepo)             카페 실내
// tea         pexels.com/photo/6545350 (Tima Miroshnichenko)        찻상
// bakery      unsplash.com/photos/qZ5lPCPvdXE (Mink Mingle)         빵·페이스트리
// ricecake    pexels.com/photo/10422389 (준섭 윤)                    한과·다식
// dessert     unsplash.com/photos/BZDvXJ9blUQ (Seungmin Yoon)       딸기 빙수
// korean_bbq  unsplash.com/photos/xk3er6C7oWM (Daniel)              숯불 고기·반찬
// korean      unsplash.com/photos/kCkv2HTm3Y8 (Cecelia Chang)       한상 차림
// seafood     unsplash.com/photos/5eFflPtVA8U (yeojin yun)          생선구이
// noodles     unsplash.com/photos/hk8XIspQq2Y (rawkkim)             물냉면
// soup        unsplash.com/photos/AODR1DIRjXg (Zion C)              국밥
// tofu        unsplash.com/photos/1_SenAyTAXg (rawkkim)             순두부찌개
// bunsik      unsplash.com/photos/n-E0XNnGc-Q (Markus Winkler)      라볶이
// chicken     unsplash.com/photos/CgXEzyC2fNA (Jim Sosengphet)      양념치킨
// chinese     pexels.com/photo/5339076 (Roman Odintsov)             짜장면
// japanese    unsplash.com/photos/fvGOeiYaza4 (Zhang Ziyu)          카츠
// western     unsplash.com/photos/HHhYcbwiXMc (Nerise Gokpinar)     파스타·피자
// burger      unsplash.com/photos/_qxbJUr9RqI (Ilya Mashkov)        버거
// pub         pexels.com/photo/19999942 (Spike Yuu)                 맥주·튀김 안주
// restaurant  pexels.com/photo/5083898 (Jep Gambardella)            식당 상차림
