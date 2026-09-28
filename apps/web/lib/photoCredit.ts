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

/** features 에 저장된 Wikimedia 출처. 원문 링크가 없으면 출처로 쓸 수 없어 null. */
export function wikimediaCredit(features: Record<string, unknown> | null | undefined): PhotoCredit | null {
  const raw = features?.imageSource ?? features?.image_source;
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const sourceUrl = text(source.sourceUrl ?? source.source_url);
  if (!sourceUrl) return null;
  return {
    label: text(source.artist) || text(source.provider) || 'Wikimedia',
    license: text(source.license),
    sourceUrl,
  };
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
