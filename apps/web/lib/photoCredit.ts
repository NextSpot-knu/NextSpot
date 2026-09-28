// Wikimedia 사진 출처 — CC BY/BY-SA 사진은 출처 없이 보이지 않는다(PM 규칙 2026-09-28).
//
// 적재 배치(apps/api/scripts/ingest_tourapi.py)는 TourAPI 사진이 전혀 없는 관광지에만 Wikimedia 사진 1장을
// gallery_images 에 넣고, 출처(작가·라이선스·원문 링크)를 features.image_source 에 둔다. 카드는
// [대표 사진, ...갤러리] 를 차례로 시도하므로 대표 사진이 깨지면 Wikimedia 사진이 뜰 수 있다 — 그때 이 출처를
// 사진 아래에 붙인다. 출처 데이터가 없는 Wikimedia 사진은 후보에서 뺀다(출처 없이 띄우지 않는다).
//
// features 는 두 모양으로 온다: API 응답(keysToCamel → imageSource.sourceUrl)과 Supabase 직접 읽기
// (원본 snake_case → image_source.source_url). 둘 다 읽는다.

export interface PhotoCredit {
  label: string;
  license: string;
  sourceUrl: string;
}

export function isWikimediaUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === 'wikimedia.org' || host.endsWith('.wikimedia.org');
  } catch {
    return false;
  }
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
    label: text(source.artist) || text(source.provider) || 'Wikimedia',
    license: text(source.license),
    sourceUrl,
  };
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

/** 카드가 시도할 사진 후보 — 출처가 없는 Wikimedia 사진은 뺀다. 순서·중복 제거는 입력 그대로 따른다. */
export function creditedPhotoUrls(
  urls: readonly string[],
  features: Record<string, unknown> | null | undefined,
): string[] {
  const credited = wikimediaCredit(features) !== null;
  return urls.filter((url) => credited || !isWikimediaUrl(url));
}

/** 지금 보이는 사진에 붙일 출처 — Wikimedia 사진일 때만. TourAPI 사진 아래에는 붙이지 않는다. */
export function creditForDisplayedPhoto(
  displayedUrl: string | null | undefined,
  features: Record<string, unknown> | null | undefined,
): PhotoCredit | null {
  return isWikimediaUrl(displayedUrl) ? wikimediaCredit(features) : null;
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
