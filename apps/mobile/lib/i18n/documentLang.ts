// 웹 빌드의 <html lang> — 웹 apps/web/lib/i18n/I18nProvider.tsx:70,84 와 같은 일(G2-G06).
// lang 이 맞아야 lib/webSetup.web.ts 의 html:lang(ko) keep-all · ja·zh 금칙 CSS 가 걸리고 화면 읽기가 그 언어로 읽는다.
// 네이티브에는 document 가 없어 아무것도 하지 않는다.
import type { Locale } from '@/lib/i18n/config';

type DocLike = { documentElement?: { lang: string } | null };

export function applyDocumentLang(
  locale: Locale,
  doc: DocLike | undefined = (globalThis as { document?: DocLike }).document,
): void {
  if (doc?.documentElement && doc.documentElement.lang !== locale) doc.documentElement.lang = locale;
}
