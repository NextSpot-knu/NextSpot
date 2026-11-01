// 사진 출처 판정 — 웹 apps/web/lib/photoCredit.ts(기준 커밋 0d145a1)의 앱판.
// 바꾼 것: merchantPhotoUrl 이 process.env.NEXT_PUBLIC_SUPABASE_URL 대신 앱 env 를 읽는다(원본은 check:shared 에 걸린다).
// 판정(Wikimedia·경주시 출처가 있을 때만 후보, 보이는 사진에 출처 줄)은 그대로다. 사진 후보 커서(대기 보드용)는 옮기지 않았다.
import { env } from '~/lib/core/env';

export interface PhotoCredit {
  kind: 'wikimedia' | 'city';
  label: string;
  license: string;
  sourceUrl: string;
}

type Features = Record<string, unknown> | null | undefined;

function hostIs(url: unknown, domain: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
export const isWikimediaUrl = (url: unknown) => hostIs(url, 'wikimedia.org');
export const isCityPhotoUrl = (url: unknown) => hostIs(url, 'gyeongju.go.kr');

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
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
function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function wikimediaCredit(features: Features): PhotoCredit | null {
  const source = obj(features?.imageSource ?? features?.image_source);
  if (!source) return null;
  const sourceUrl = safeHttpUrl(source.sourceUrl ?? source.source_url);
  if (!sourceUrl) return null;
  return { kind: 'wikimedia', label: text(source.artist) || text(source.provider) || 'Wikimedia', license: text(source.license), sourceUrl };
}

function cityPhotoOf(features: Features): Record<string, unknown> | null {
  return obj(features?.cityPhoto ?? features?.city_photo);
}
function cityPhotoUrl(features: Features): string {
  return text(cityPhotoOf(features)?.url);
}
export function cityPhotoCredit(features: Features): PhotoCredit | null {
  const source = cityPhotoOf(features);
  if (!source || !cityPhotoUrl(features)) return null;
  return {
    kind: 'city',
    label: text(source.provider) || '경주시',
    license: text(source.license),
    sourceUrl: safeHttpUrl(source.sourceUrl ?? source.source_url),
  };
}
function isCreditedCityPhoto(url: string, features: Features): boolean {
  const cityUrl = cityPhotoUrl(features);
  return cityUrl !== '' && url.trim() === cityUrl;
}

export const MERCHANT_PHOTO_BUCKET = 'facility-photos';

/** 사장님이 올린 가게 사진의 공개 URL — features.merchant_photo.path. Supabase 설정이 없으면 null. */
export function merchantPhotoUrl(
  features: Features,
  supabaseUrl: string | null = env.supabaseConfigured ? env.supabaseUrl : null,
): string | null {
  const raw = obj(features?.merchantPhoto ?? features?.merchant_photo);
  const path = raw && typeof raw.path === 'string' ? raw.path.trim() : '';
  const base = (supabaseUrl ?? '').replace(/\/+$/, '');
  if (!path || !base) return null;
  return `${base}/storage/v1/object/public/${MERCHANT_PHOTO_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** 출처 없는 Wikimedia 사진, features.city_photo 와 짝이 아닌 경주시 사진은 후보에서 뺀다. */
export function creditedPhotoUrls(urls: readonly string[], features: Features): string[] {
  const wikimediaCredited = wikimediaCredit(features) !== null;
  return urls.filter((url) => {
    if (isWikimediaUrl(url)) return wikimediaCredited;
    if (isCityPhotoUrl(url)) return isCreditedCityPhoto(url, features);
    return true;
  });
}

export function creditForDisplayedPhoto(displayedUrl: string | null | undefined, features: Features): PhotoCredit | null {
  if (typeof displayedUrl !== 'string' || !displayedUrl.trim()) return null;
  if (isWikimediaUrl(displayedUrl)) return wikimediaCredit(features);
  return isCreditedCityPhoto(displayedUrl, features) ? cityPhotoCredit(features) : null;
}
