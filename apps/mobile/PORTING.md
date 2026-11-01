# 웹 → 앱 이식 원본 추적

앱이 웹 코드를 **다시 쓴** 파일의 원본을 적는다. 웹 원본이 기준 커밋 뒤에 바뀌면 앱도 반영할지 본다
(`git log <기준 커밋>.. -- <웹 원본>`). 그대로 import 하는 순수 모듈은 여기 적지 않는다 — `npm run check:shared` 가 지킨다.

| 앱 파일 | 웹 원본 | 기준 커밋 | 바꾼 것 |
|---|---|---|---|
| `lib/sessionStorage.ts` | (브라우저 `sessionStorage`) | — | 앱 실행 동안만 사는 메모리 대역 |
| `features/map/declutter.ts` | `apps/web/app/main/page.tsx` (`computeDisplayFacilities` 지도 쪽 절반) | `e07ea61` | 카카오 getBounds·getProjection·getLevel 대신 RN 영역(Region)+상자 크기로 계산, 카테고리·검색 필터와 묶음 핀 색칠은 화면에 남김 |
| `features/map/NextSpotMap.tsx` | `apps/web/app/main/page.tsx`(내 위치 점·축제 원·지도 이벤트), `apps/web/components/CourseMap.tsx`(번호 핀·점선·맞춤 패딩), `apps/web/app/explore/recommend/page.tsx`(MiniMap) | `e07ea61` | DOM 오버레이 → react-native-maps Marker/Circle/Polyline, 펄스 애니메이션은 정적 고리 |
| `lib/i18n/{I18nProvider.tsx,translate.ts,catalog.ts,initialLocale.ts,localeState.ts}` | `apps/web/lib/i18n/I18nProvider.tsx` | `e07ea61` | 조회 순서·치환 그대로, 첫 렌더부터 저장·기기 언어(expo-localization), en·ja·zh 는 처음 필요할 때 require, `<html lang>` 대신 localeState |
| `lib/platform/{kakaoLinks.ts,links.ts}` | `apps/web/lib/navigation.ts`, `components/RecommendationCard.tsx`(장소 링크) | `e07ea61` | https 주소 그대로, 앱이 있으면 `kakaomap://`, 없으면 시스템 브라우저 |
| `lib/platform/{shareCore.ts,share.ts,shareUrls.ts}` | `apps/web/components/ShareButton.tsx`, `app/course`·`app/explore/recommend` 공유 URL | `e07ea61` | RN Share → expo-clipboard 폴백, origin 은 운영 웹 주소 고정 |
| `lib/platform/haptics.ts` | `apps/web/lib/motion.ts`(haptic) | `e07ea61` | navigator.vibrate → expo-haptics |
| `lib/platform/{poller.ts,appState.ts}` | `apps/web/lib/visibilityPoller.ts`, `usePolling.ts` | `e07ea61` | 순수 부분 복사(웹 파일은 window·document 로 공유 불가), 화면 보임 → AppState |
| `lib/platform/{analyticsCore.ts,analytics.ts}` | `apps/web/lib/usageEvents.ts`, `analytics.ts`, `strollerSupport.ts`(세션 플래그) | `e07ea61` | 운영 호스트 판정 → `EXPO_PUBLIC_USAGE_EVENTS`, 전송 함수 주입, pagehide → AppState |
| `lib/platform/images.ts` | (서버 `apps/api/app/services/tourapi/transform.py` 의 https 승격) | — | 앱 전용 — iOS ATS·안드로이드 평문 차단 대비 |
| `lib/core/env.ts` | (웹 `NEXT_PUBLIC_*` 읽기) | `e07ea61` | `EXPO_PUBLIC_*` · 기본 API nextspot-t2ib · 사용 기록은 운영 빌드만 |
| `lib/core/events.ts` | `apps/web/lib/api-client.ts`·`recommendationOutcomes.ts` 의 window CustomEvent | `e07ea61` | 타입 있는 이벤트 버스 `appEvents` |
| `lib/core/{httpCore.ts,apiClient.ts}` | `apps/web/lib/api-client.ts` | `e07ea61` | AbortError 이름 검사 · `X-NextSpot-Client` · 지역 헤더·가정 시각·데모 프리페치 없음 |
| `lib/core/supabase.ts` | `apps/web/lib/supabase.ts` | `e07ea61` | expo-sqlite localStorage · detectSessionInUrl false · AppState 자동 갱신 |
| `lib/core/{anonymousSessionCore.ts,anonymousSession.ts,sessionHeal.ts,SessionBootstrap.tsx}` | `apps/web/lib/anonymousSession.ts`, `components/shell/SessionBootstrap.tsx` | `e07ea61` | Turnstile 제거 · visibilitychange → AppState |
| `lib/core/{guestMerge.ts,userData.ts,savedFacilities.ts,recommendationOutcomes.ts}` | `apps/web/lib/auth.ts`(capture/merge/discard), `userData.ts`, `savedFacilities.ts`, `recommendationOutcomes.ts` | `e07ea61` | 지역 캐시·헤더 제거(경주만) · 앱 Supabase 클라이언트 |
| `lib/core/{account.tsx,publicSettings.tsx,noticeDismissal.ts}` | `apps/web/lib/account.tsx`, `components/shell/PublicSettingsProvider.tsx`, `lib/noticeDismissal.ts` | `e07ea61` | 앱 클라이언트 · RN 자리 UI · 문구는 props |
| `lib/core/{strollerSupport.ts,travelContextTypes.ts}` | `apps/web/lib/strollerSupport.ts`, `travelContext.ts`, `voice/voiceCommands.ts`(타입) | `e07ea61` | 웹 `visits.ts` 의 `window.localStorage` 때문에 사슬이 공유 검사에 걸려 다시 씀 |
