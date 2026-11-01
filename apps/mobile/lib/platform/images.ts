// 이미지 주소를 https 로 — iOS ATS 와 안드로이드(targetSdk 28+ 기본 cleartext 차단)가 http 이미지를 막는다.
// TourAPI 는 firstimage 를 'http://tong.visitkorea.or.kr/…' 로 줄 때가 있다. 서버 적재도 같은 승격을 하지만
// (apps/api/app/services/tourapi/transform.py — tong.visitkorea.or.kr CDN 은 https 를 지원한다), 옛 행·다른 출처
// (카카오·위키미디어·사장님 업로드)가 섞여 앱에서 한 번 더 맞춘다. 순수 함수(테스트: images.test.ts).

/**
 * - 'http://…' → 'https://…', '//host/…'(스킴 생략) → 'https://host/…'
 * - 'https://…' 와 'data:image/…' 는 그대로
 * - 빈 값·공백·그 밖의 스킴(file:, javascript:, 상대 경로)은 null — 화면은 자리표시를 그린다
 */
export function toHttpsImageUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!s) return null;
  if (/^https:\/\//i.test(s)) return s;
  if (/^http:\/\//i.test(s)) return `https://${s.slice('http://'.length)}`;
  if (s.startsWith('//')) return `https:${s}`;
  if (/^data:image\//i.test(s)) return s;
  return null;
}

/** 여러 후보(대표·추가 사진)를 https 로 맞추고 빈 것·중복을 뺀다. 순서는 지킨다. */
export function toHttpsImageUrls(urls: readonly (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls ?? []) {
    const n = toHttpsImageUrl(u);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
