// 사진 출처 — 출처가 필요한 사진은 출처 없이 보이지 않는다(PM 규칙 2026-09-28 · 2026-09-29).
//
// 1) Wikimedia(CC BY/BY-SA): 적재 배치(apps/api/scripts/ingest_tourapi.py)는 TourAPI 사진이 전혀 없는 관광지에만
//    Wikimedia 사진 1장을 gallery_images 에 넣고, 출처(작가·라이선스·원문 링크)를 features.image_source 에 둔다.
// 2) 경주시(메뉴별음식점 API 사진): 적재 배치(apps/api/scripts/ingest_gyeongju_restaurants.py)는 사진이 하나도 없는
//    음식점에만 경주시 사진 1장을 gallery_images 에 넣고, 출처를 features.city_photo = {url, provider, source_url,
//    license, ...} 에 둔다(걷어 내면 null). 출처 줄은 '사진: 경주시' 하나 — 사진 출처일 뿐 운영 주체 표기가 아니다.
//    image_source 는 Wikimedia 전용이라 둘은 섞이지 않는다.
//
// 카드는 [대표 사진, ...갤러리] 를 차례로 시도하므로 대표 사진이 깨지면 갤러리 사진이 뜰 수 있다 — 출처는 늘
// '지금 보이는 사진' 을 따라간다. 출처 데이터가 없는 Wikimedia 사진, 출처와 짝이 아닌 경주시 사진은 후보에서
// 뺀다(출처 없이 띄우지 않는다).
//
// features 는 두 모양으로 온다: API 응답(keysToCamel → imageSource.sourceUrl · cityPhoto.url)과 Supabase 직접 읽기
// (원본 snake_case → image_source.source_url · city_photo.url). 둘 다 읽는다.

export interface PhotoCredit {
  /** 'wikimedia' = '작가 · 라이선스' 줄(글자는 데이터). 'city' = '사진: 경주시' 줄(글자는 i18n common.cityPhotoCredit). */
  kind: 'wikimedia' | 'city';
  label: string;
  license: string;
  /** 출처 줄이 이어지는 원문(http/https). 경주시 출처는 비어 있을 수 있다 — 그때는 링크 없이 글자만. */
  sourceUrl: string;
}

function hostIs(url: unknown, domain: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export function isWikimediaUrl(url: unknown): boolean {
  return hostIs(url, 'wikimedia.org');
}

/** 경주시 누리집(gyeongju.go.kr)에 올라 있는 사진 — 적재 배치는 이 호스트의 사진만 경주시 사진으로 넣는다. */
export function isCityPhotoUrl(url: unknown): boolean {
  return hostIs(url, 'gyeongju.go.kr');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 링크로 걸어도 되는 원문 주소 — http(s) 만. javascript:·data: 같은 주소는 출처 링크가 될 수 없다. */
function safeHttpUrl(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/** features 의 출처 원본(camel imageSource 또는 snake image_source). 객체가 아니면 null. */
export function imageSourceOf(
  features: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const raw = features?.imageSource ?? features?.image_source;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** features 에 저장된 Wikimedia 출처. 원문 링크(http/https)가 없으면 출처로 쓸 수 없어 null. */
export function wikimediaCredit(features: Record<string, unknown> | null | undefined): PhotoCredit | null {
  const source = imageSourceOf(features);
  if (!source) return null;
  const sourceUrl = safeHttpUrl(source.sourceUrl ?? source.source_url);
  if (!sourceUrl) return null;
  return {
    kind: 'wikimedia',
    label: text(source.artist) || text(source.provider) || 'Wikimedia',
    license: text(source.license),
    sourceUrl,
  };
}

/** features 의 경주시 사진 출처 원본(camel cityPhoto 또는 snake city_photo). 객체가 아니면 null(걷어 낸 출처 포함). */
export function cityPhotoOf(
  features: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const raw = features?.cityPhoto ?? features?.city_photo;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** 경주시 출처가 짝지은 사진 URL(앞뒤 공백 제거). 출처가 없거나 url 이 비었으면 ''. */
function cityPhotoUrl(features: Record<string, unknown> | null | undefined): string {
  return text(cityPhotoOf(features)?.url);
}

/** features 에 저장된 경주시 사진 출처. 짝이 되는 사진 url 이 없으면 출처로 쓸 수 없어 null. */
export function cityPhotoCredit(features: Record<string, unknown> | null | undefined): PhotoCredit | null {
  const source = cityPhotoOf(features);
  if (!source || !cityPhotoUrl(features)) return null;
  return {
    kind: 'city',
    label: text(source.provider) || '경주시',
    license: text(source.license),
    sourceUrl: safeHttpUrl(source.sourceUrl ?? source.source_url),
  };
}

/** 이 사진이 features.city_photo 가 가리키는 바로 그 사진인가 — 출처와 사진은 URL 로 짝을 짓는다. */
function isCreditedCityPhoto(url: string, features: Record<string, unknown> | null | undefined): boolean {
  const cityUrl = cityPhotoUrl(features);
  return cityUrl !== '' && url.trim() === cityUrl;
}

/**
 * 한 장소의 사진 후보 — 대표 사진(firstimage)부터 갤러리(detailImage2) 순. 빈 값·문자열 아닌 값은 빼고,
 * 같은 URL 은 한 번만(처음 자리). URL 문자열 자체는 고치지 않는다(출처 판정·커서 키가 URL 그대로 쓴다).
 */
export function photoCandidates(
  imageUrl: unknown,
  galleryImages: unknown,
): string[] {
  const gallery: unknown[] = Array.isArray(galleryImages) ? galleryImages : [];
  return Array.from(
    new Set(
      [imageUrl, ...gallery].filter(
        (url): url is string => typeof url === 'string' && url.trim().length > 0,
      ),
    ),
  );
}

/**
 * 카드가 시도할 사진 후보 — 출처가 없는 Wikimedia 사진, 그리고 features.city_photo 와 짝이 아닌 경주시 사진은 뺀다.
 * 순서·중복 제거는 입력 그대로 따른다.
 */
export function creditedPhotoUrls(
  urls: readonly string[],
  features: Record<string, unknown> | null | undefined,
): string[] {
  const wikimediaCredited = wikimediaCredit(features) !== null;
  return urls.filter((url) => {
    if (isWikimediaUrl(url)) return wikimediaCredited;
    if (isCityPhotoUrl(url)) return isCreditedCityPhoto(url, features);
    return true;
  });
}

/**
 * 지금 보이는 사진에 붙일 출처 — Wikimedia 사진이면 그 출처, features.city_photo.url 과 같은 사진이면 경주시 출처.
 * TourAPI 사진 아래에는 붙이지 않는다.
 */
export function creditForDisplayedPhoto(
  displayedUrl: string | null | undefined,
  features: Record<string, unknown> | null | undefined,
): PhotoCredit | null {
  if (typeof displayedUrl !== 'string' || !displayedUrl.trim()) return null;
  if (isWikimediaUrl(displayedUrl)) return wikimediaCredit(features);
  return isCreditedCityPhoto(displayedUrl, features) ? cityPhotoCredit(features) : null;
}

/** 후보 중 하나라도 뜨면 출처 줄이 붙는가 — 출처 줄 자리를 미리 잡아 둘지 정할 때 쓴다. */
export function mayShowPhotoCredit(
  urls: readonly string[],
  features: Record<string, unknown> | null | undefined,
): boolean {
  return urls.some((url) => creditForDisplayedPhoto(url, features) !== null);
}

/** 출처 판정에 쓰는 features 조각 — 목록 행에 features 전체를 싣지 않고 두 출처 원본만 들고 다닌다. */
export function photoCreditFeatures(
  features: Record<string, unknown> | null | undefined,
): { imageSource: Record<string, unknown> | null; cityPhoto: Record<string, unknown> | null } {
  return { imageSource: imageSourceOf(features), cityPhoto: cityPhotoOf(features) };
}

// --- 사진 후보 커서(대기 보드) -------------------------------------------------------------
// 출처는 '지금 보이는 사진' 과 같은 렌더에서 같은 값으로 정해져야 한다. 자식이 effect 로 띄운 사진을
// 알려 주면 한 커밋 늦어, 목록이 바뀐 직후 TourAPI 사진 아래에 이전 Wikimedia 출처가 한 프레임 남는다.
// 그래서 몇 번째 후보가 깨졌는지를 부모가 들고, 보이는 사진 URL 을 렌더 중에 바로 계산한다.

/** 어느 후보 목록에서 몇 번째 사진을 띄우는지. 목록이 바뀌면(listKey 가 다르면) 첫 후보부터 다시. */
export interface PhotoCursor {
  listKey: string;
  index: number;
}

export function photoListKey(urls: readonly string[]): string {
  return urls.join('|');
}

function cursorIndex(urls: readonly string[], cursor: PhotoCursor | undefined): number {
  return cursor && cursor.listKey === photoListKey(urls) ? cursor.index : 0;
}

/** 지금 띄울 사진 — 후보를 다 써 버렸으면 null(유형 아이콘 자리표시). */
export function displayedPhotoUrl(urls: readonly string[], cursor: PhotoCursor | undefined): string | null {
  return urls[cursorIndex(urls, cursor)] ?? null;
}

/**
 * failedUrl 이 지금 띄운 사진일 때만 다음 후보로 넘긴다 — 이미 지나간 사진의 늦은 onError 는 무시한다.
 * 바뀔 게 없으면 받은 cursor 를 그대로 돌려준다(상태 갱신 생략용).
 */
export function advancePhotoCursor(
  urls: readonly string[],
  cursor: PhotoCursor | undefined,
  failedUrl: string,
): PhotoCursor | undefined {
  const index = cursorIndex(urls, cursor);
  if (urls[index] !== failedUrl) return cursor;
  return { listKey: photoListKey(urls), index: index + 1 };
}
