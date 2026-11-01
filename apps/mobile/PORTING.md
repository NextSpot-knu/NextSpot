# 웹 → 앱 이식 원본 추적

앱이 웹 코드를 **다시 쓴** 파일의 원본을 적는다. 웹 원본이 기준 커밋 뒤에 바뀌면 앱도 반영할지 본다
(`git log <기준 커밋>.. -- <웹 원본>`). 그대로 import 하는 순수 모듈은 여기 적지 않는다 — `npm run check:shared` 가 지킨다.

| 앱 파일 | 웹 원본 | 기준 커밋 | 바꾼 것 |
|---|---|---|---|
| `lib/sessionStorage.ts` | (브라우저 `sessionStorage`) | — | 앱 실행 동안만 사는 메모리 대역 |
| `features/map/declutter.ts` | `apps/web/app/main/page.tsx` (`computeDisplayFacilities` 지도 쪽 절반) | `e07ea61` | 카카오 getBounds·getProjection·getLevel 대신 RN 영역(Region)+상자 크기로 계산, 카테고리·검색 필터와 묶음 핀 색칠은 화면에 남김 |
| `features/map/NextSpotMap.tsx` | `apps/web/app/main/page.tsx`(내 위치 점·축제 원·지도 이벤트), `apps/web/components/CourseMap.tsx`(번호 핀·점선·맞춤 패딩), `apps/web/app/explore/recommend/page.tsx`(MiniMap) | `e07ea61` | DOM 오버레이 → react-native-maps Marker/Circle/Polyline, 펄스 애니메이션은 정적 고리 |
