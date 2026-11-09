// 전역 localStorage 깔기(네이티브) — expo-sqlite 의 동기 저장소를 globalThis.localStorage 로 둔다.
// 웹은 브라우저 localStorage 를 그대로 쓴다(storageInstall.web.ts). expo-sqlite 의 웹 모듈(wasm 워커)을 번들에 끌어오지 않게
// 플랫폼 파일로 나눈다 — 웹 개발 서버가 'Worker chunk not found' 로 번들을 못 만들었다.
import 'expo-sqlite/localStorage/install';
