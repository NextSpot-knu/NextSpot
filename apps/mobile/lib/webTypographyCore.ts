// 웹 빌드 글자 CSS — 순수 문자열(테스트: webTypographyCore.test.ts). lib/webSetup.web.ts 가 <head> 에 싣는다.
// 네이티브는 쓰지 않는다(안드로이드 한국어 줄바꿈은 Text 의 U+2060, iOS 는 hangul-word).
//
// 웹 기준 apps/web/app/globals.css:
//   :167-170 html:lang(ko) body { word-break: keep-all; overflow-wrap: break-word }   (G2-G06 · G5a-13 이 이것으로 닫힌다)
//   :193-195 html:is(:lang(ja), :lang(zh)) body { line-break: strict }
// react-native-web Text 는 word-break 를 정하지 않아 body 값을 물려받는다(한 줄 자르기는 wordWrap 만 normal 로 바꾼다).
// lang 은 lib/i18n/documentLang.ts 가 바꾼다.

/** 웹 빌드 글자 CSS. */
export function webTypographyCss(): string {
  return `
html:lang(ko) body { word-break: keep-all; overflow-wrap: break-word; }
html:is(:lang(ja), :lang(zh)) body { line-break: strict; }
/* 검색 등 입력칸의 Chromium 기본 포커스 외곽선 — 웹 입력칸은 outline-none 이다(G2-G08, apps/web/app/main/page.tsx:4055). */
input:focus, textarea:focus { outline: none; }
/* Freesentation 굵기별 글꼴은 한 face(400)로 등록된다 — 숫자 굵기(Text 의 fontStyleFor)를 주면 브라우저가 이미 굵은 글꼴을
   가짜로 한 번 더 굵힌다. 가짜 굵게만 끄고, 대체 글꼴(맑은 고딕·시스템 CJK)은 제 굵은 face 로 그린다. */
* { font-synthesis-weight: none !important; }`;
}
