# apps/mobile — NextSpot 모바일 앱 (Expo React Native)

관광객용 iOS·Android 앱. 계획·범위·결정은 [`docs/MOBILE_APP_PLAN.md`](../../docs/MOBILE_APP_PLAN.md), 이어받기 순서는
`AGENTS.md`(루트) → `docs/HANDOVER.md` → 계획 문서. 사장님·관제·개발자 화면은 웹에 남는다.

- **구조:** Expo SDK 57 · Expo Router(`app/` 의 파일 하나가 화면, `_layout.tsx` 가 네비게이터) · NativeWind 4(Tailwind v3 설정).
  화면이 아닌 코드는 `app/` 밖(`components/`·`features/`·`lib/`)에 둔다. 앱 자기 코드 별칭은 `~/…`.
- **루트 npm 작업공간 밖의 독립 패키지다.** 의존성은 이 폴더에서 `npx expo install <패키지>`(SDK 에 맞는 버전을 고른다 —
  `npm install` 로 RN 라이브러리를 넣지 않는다). lock 은 `apps/mobile/package-lock.json`.
- **웹 코드 재사용:** `@/lib/…` 로 `apps/web/lib` 의 **의존 폐포까지 순수한** 모듈만 import 한다. `npm run check:shared` 가 사슬 전체에서
  `window.`·`document.`·`navigator.`·`CustomEvent`·`DOMException`·외부 패키지(shared-types 제외)·`.tsx` 를 막는다.
  걸리면 그 모듈을 import 하지 말고 `lib/` 에 앱용으로 다시 쓰고, 원본 경로·기준 커밋을 [`PORTING.md`](./PORTING.md) 에 적는다.
- **WebView 금지.** `react-native-webview` 를 설치·import 하지 않는다(App Store 4.2). 외부 페이지는 `expo-web-browser` 로 연다.
- **문구:** 웹 `apps/web/lib/i18n/messages/*.json` 을 그대로 쓴다. 앱 전용 키는 같은 JSON 의 `app.*` 에, 4로케일 동시에.
  병렬 에이전트에 문구를 나눠 맡기지 않는다 — 새 키는 요청 목록에 적고 통합 때 한 번에 쓴다.
- **네이티브 폴더(`android/`·`ios/`)는 만들어지는 것이다(CNG).** 손으로 고치지 않고 `app.json`·설정 플러그인으로 바꾼다. 둘 다 커밋하지 않는다.
- **비밀값:** `EXPO_PUBLIC_*` 는 번들에 그대로 들어간다 — 공개 값(API 주소·Supabase 주소·anon 키)만. 서명 키·.p8·서비스 계정 JSON 은 저장소 밖.
- **검증(CI `mobile` 잡과 같다):** `npm run typecheck` · `npm run check:shared` · `npx expo-doctor` · `npm run export:android`.
- **실행:** 에뮬레이터 `nextspot_phone`·`nextspot_fold`(Android SDK 는 `%LOCALAPPDATA%\Android\Sdk`, `ANDROID_HOME`).
  개발 빌드 `npx expo run:android` → 이후엔 `npx expo start` 로 JS 만 다시 싣는다.
- **Expo 는 SDK 마다 API 가 바뀐다 — 기억으로 쓰지 말 것.** `package.json` 의 `expo` 메이저 버전에 맞는 문서
  `https://docs.expo.dev/versions/v<major>.0.0/` 와 `https://docs.expo.dev/llms.txt` 를 먼저 확인한다.
