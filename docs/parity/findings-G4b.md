# G4b 분산 코스 — 웹 `/course` ↔ Expo `/course`(탭) 화면 동등성 결과

- 작성: 2026-11-10, G4b 에이전트. 390×844 @2x, ko-KR, Asia/Seoul, 경주 GPS. 웹 `http://localhost:3000` · Expo web `https://nextspot.expo.app`.
- 기준: 웹(`apps/web`)이 정답. 저장소 파일은 하나도 고치지 않았다. 산출물은 `scratch/parity/` 아래만(스크린샷 `shots/G4b/`, 스크립트·측정 JSON `work/G4b/`, 오버레이 `overlays/G4b/`).
- 데이터: 코스 응답은 모두 고정 응답.
  - `overlays/G4b/plan1` = 공유 fixture(1곳 + `over_time_budget` 2자리, 1시간 예산 — 실제 상태)를 그대로 복사했다. `congestion_estimate.observed_at` 만 '지금-15분'으로 새로 썼다(60분이 넘으면 두 앱 모두 추정 칩을 숨기므로).
  - `plan3` = 녹화된 정류지 스키마에 다른 fixture 의 실제 시설 행을 채운 3곳 계획. 정류지는 천마총(대릉원)·향화정, 대안은 금관총·경주 첨성대·호랑이카츠·우직. 체류는 카페 40·관광지 45분(`courses.py:89`).
  - 그 밖에 빈·오류·401·지연·빠진 자리·고정 실패 변형.
  - 공유 모드의 Supabase `facilities` 읽기도 로컬 mock.
- 운영 호출: 렌더 POST 106건 전부 fixture, mock 19건, 쓰기 9건(`events/track`)은 모두 정책이 가짜 응답. 가입·실 POST·토큰 갱신 실패 0건(`logs/runs/G4b-*.policy.jsonl`).
- 다시 찍기: D:\NextSpot 에서 `node scratch/parity/work/G4b/build-overlays.mjs` 를 먼저 실행한 뒤 아래를 실행한다.
  - `cap-default.mjs [plan1|plan3]`
  - `cap-interact.mjs [rows|gantt|builder|pin]`
  - `cap-states.mjs [loading|err|auth|empty|partial|geo]`
  - `cap-shared.mjs [shared|sharedStates|share|nav]`
  - `cap-metrics.mjs`
  - `cap-extra.mjs [nomap|revisit]`
  - 측정값은 `work/G4b/*.json`.

## 요약

- 차이 29건 — **P0 6 · P1 15 · P2 8**.
  - 결정 필요 9건: 01·08·10·19·21·23·25·27·28.
  - 촬영 못 함 1건: 28.
  - 네이티브 확인 필요 5건: 01·05·12·20·24.
- 가장 중요한 5가지
  1. **G4b-01 지도·시트 구조**
     - 웹: 지도(38dvh = 320.7px)가 페이지와 함께 스크롤되고 끝까지 보인다. 카카오 지도가 시트 윗부분을 가리는 z-order 버그로 그랩바·둥근 모서리는 안 보인다.
     - Expo: 지도 287px 를 고정하고 그 위에 둥근 시트를 24px 겹친다. 보이는 지도는 263px, 카카오 로고는 가려지고, 목록만 532px 창에서 스크롤된다.
  2. **G4b-20 첫 로딩 화면**
     - 웹: 지도·버튼 없이 전면 스켈레톤 + 'NEXTSPOT' 내레이션(1.2초마다 3단계)·진행 바·블러 고스트.
     - Expo: 지도를 그대로 두고 제목 한 줄 + 회색 막대뿐.
  3. **G4b-02 '지도 보기' 뒤로 버튼 없음** — 웹 첫 화면 왼쪽 위 44px 원형 버튼이 Expo 에 없다.
  4. **G4b-08 가정 시간 선택 없음(결정 필요)**
     - 웹 헤더의 '🕒 가정 시간 지금(실시간) ▾' 컨트롤과 배지가 Expo 에 없다.
     - 빈 상태 문구 2개도 그 때문에 다른 키를 쓴다(G4b-23).
  5. **G4b-25 길안내 후 흐름(웹 버그)**
     - 웹: `window.open(…,'noopener')` 가 항상 null 을 돌려줘, 새 탭을 연 뒤 **현재 탭까지 카카오맵으로 이동**한다.
     - Expo: 코스 화면에 남고 토스트를 띄운다.
     - 웹 수정을 권장한다.

---

### G4b-01 지도·시트 구조 — 지도 높이, 시트 겹침, 스크롤 방식
- 화면·상태: 계획 표시(모든 상태 공통). plan1(실제 1곳)·plan3(3곳).
- 스크린샷: shots/G4b/plan1-01-top.pair.png, plan1-02-map.pair.png, m01-sheet-edge.pair.png, plan1-03-mid.pair.png, plan3-03-mid.pair.png
- 웹(기준):
  - 스크롤: 페이지 전체가 문서 스크롤이다. `apps/web/app/course/page.tsx:852` `<main class="min-h-screen … overflow-hidden">`, 지도 블록 `:863` `relative shrink-0` 이 내용과 함께 위로 사라진다.
  - 지도: `apps/web/components/CourseMap.tsx:238` `h-[38dvh]` → 320.7px.
  - 시트: `page.tsx:885` `relative -mt-6 flex-1 rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(43,35,32,0.12)]`.
    - 그랩바 `:886` `w-12 h-1.5 rounded-full bg-line mx-auto mt-3`.
    - 내용 `:888` `px-4 pt-4 space-y-5`.
  - **실제 렌더**: 카카오 지도 내부 층(z-index 0·1·2·40·60)이 z-index 없는 시트보다 위에 칠해진다.
    - 그래서 시트 윗부분 24px(둥근 모서리·그랩바)가 지도 밑에 숨는다. 그랩바 중심의 `elementFromPoint` 는 지도 `svg` 다(cap-metrics `grabHit`).
    - 결과적으로 지도 320.7px 가 카카오 축척·로고까지 끝까지 보인다. 직선 경계 10px 아래(y=330.7)에서 헤더 카드가 시작한다.
    - 카카오 지도가 없을 때(로딩·SDK 실패, x01)는 둥근 시트+그랩바가 보인다 = 의도된 디자인.
- Expo(현재):
  - 높이: `apps/mobile/app/(tabs)/course.tsx:93` `mapHeight = Math.max(220, Math.round(height * 0.34))` = 287px.
  - 구조: `:249-252` 지도를 고정하고, `View style={{flex:1, marginTop:-24}}` 안의 `ScrollView`(`:112-117`, `rounded-t-3xl bg-white`, padding 16)만 스크롤한다.
  - 겹침: 둥근 시트가 지도 아래 24px 를 덮어 보이는 지도는 263px 이고, 카카오 축척·로고가 시트 밑으로 가려진다. 그랩바는 없다.
  - 스크롤하면 지도는 위에 남고, 목록은 y 263~795(532px) 창 안에서만 움직인다(plan1-03-mid: 헤더가 지도 경계에서 잘려 지나감).
- 차이:
  1. 보이는 지도 320.7px vs 263px.
  2. 시트 윗모서리: 웹 직선 경계 / Expo 둥근 시트가 지도 위.
  3. 스크롤 모델: 웹은 지도가 함께 올라가 목록이 화면 전체를 쓴다 / Expo 는 지도 고정.
  4. 카카오 로고·축척 노출: 웹 보임 / Expo 가림.
- 중요도: P0
- 분류: 배치 · 동작
- 고칠 방법:
  1. `course.tsx` 폰 배치(`split === false`, `:248-253`)를 하나의 `ScrollView` 로 바꿔, 지도 묶음이 내용과 함께 스크롤되게 한다. 시트에는 그랩바(`page.tsx:886`)를 추가한다.
     ```tsx
     <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
       <View style={{ height: mapHeight, zIndex: 1 }}>
         {/* CourseMapView + 뒤로(G4b-02) + 공유(G4b-03) 절대 배치 */}
       </View>
       <View
         style={{ marginTop: -24, boxShadow: '0px -8px 30px rgba(43,35,32,0.12)' }}
         className="rounded-t-3xl bg-white"
       >
         <View className="mx-auto mt-[12px] h-[6px] w-[48px] rounded-full bg-line" />
         <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 20 }}>
           {/* 지금 ScrollView 안 내용 그대로 */}
         </View>
       </View>
     </ScrollView>
     ```
  2. `mapHeight = Math.round(height * 0.38)`(웹 38dvh, 844 → 321). 로딩·SDK 실패 높이는 G4b-20·G4b-05.
  3. 선택지(결정):
     - **A(권장) 웹 렌더 결과와 같게.** 위 코드처럼 지도 View `zIndex: 1` 로 시트 윗부분 24px 를 지도 밑에 둔다. 그랩바는 웹처럼 존재하되 가려진다. 지도 321px 와 로고가 끝까지 보여, 카카오(웹)·구글(네이티브) 지도 로고를 가리지 않는다.
     - **B 웹 의도대로 고침.** `page.tsx:885` 시트에 `z-10` 을 추가해 그랩바·둥근 모서리가 지도 위로 오게 하고, Expo 는 `zIndex` 없이 그랩바만 추가한다. 이때 두 앱 모두 지도 아래 24px(로고)가 가려지므로, 네이티브는 `mapPadding={{ bottom: 24 }}`, 웹은 로고 위치 조정이 따로 필요하다.
  4. 폭 600 이상 split 배치(`:243-247`)는 그대로 둔다.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/course.tsx`, `apps/mobile/features/course/components/CourseMapView.tsx`(높이 prop 그대로 사용)
- 문구(i18n): 없음
- 네이티브 주의:
  - react-native-maps 를 세로 ScrollView 안에 두면 지도 위 끌기는 지도 이동(웹 카카오 지도와 같은 동작)이고, 스크롤은 지도 밖에서 된다.
  - Android 에서 지도 제스처가 스크롤과 다투면 `nestedScrollEnabled`/`scrollEnabled` 조합을 확인한다.
  - Android 는 elevation 이 zIndex 보다 앞서므로, 시트에 elevation 이 생기면 겹침 순서를 다시 확인한다.
  - 구글 로고를 가리면 안 된다(약관).
- 확인 방법:
  - `cap-default.mjs plan1 plan3` → `plan1-01-top`·`plan1-03-mid`.
  - `cap-metrics.mjs` → `m01-sheet-edge`.
  - probe: Expo 지도 높이 321, 헤더 카드 top ≈ 331, 스크롤 시 지도가 위로 사라짐.
- 크기: M · 의존: G4b-02, G4b-03, G4b-05, G4b-20
- 표시: 결정 필요(웹 겹침 버그 처리 A/B), 네이티브 확인 필요

### G4b-02 '지도 보기' 뒤로 버튼 없음
- 화면·상태: 계획 표시·빈·오류·공유 모드(첫 로딩 제외 전부)
- 스크린샷: shots/G4b/plan1-01-top.pair.png, x01-map-unavailable.pair.png
- 웹(기준):
  - `page.tsx:865-871` `<Link href="/main" aria-label={t('course.backToMap')} className="toss-pressable absolute top-4 left-4 z-20 flex items-center justify-center w-11 h-11 rounded-full bg-white/90 backdrop-blur border border-line shadow-[0_2px_10px_rgba(43,35,32,0.15)] text-muk">`
  - 아이콘 `ArrowLeft size=18`.
  - 측정: 16,16, 44×44.
- Expo(현재): 없다. `course.tsx:95-110` 지도 위에는 공유 버튼만 있다. 탭 화면이라 뒤로가 없고, 지도로 가려면 하단 탭을 쓴다.
- 차이: 첫 화면 왼쪽 위 원형 뒤로 버튼 누락.
- 중요도: P0
- 분류: 누락
- 고칠 방법:
  1. `course.tsx` 지도 묶음 안(G4b-01 구조)에 아래 버튼을 추가한다. `goMap`(`:89` `router.navigate('/')`)을 재사용하고, `ArrowLeft` 는 `lucide-react-native` 에서 가져온다.
     ```tsx
     <Pressable
       accessibilityRole="link"
       accessibilityLabel={t('course.backToMap')}
       onPress={goMap}
       style={{
         position: 'absolute', top: 16, left: 16, width: 44, height: 44, borderRadius: 22,
         boxShadow: '0px 2px 10px rgba(43,35,32,0.15)',
       }}
       className="items-center justify-center border border-line bg-white/90"
     >
       <Icon icon={ArrowLeft} size={18} color="muk" />
     </Pressable>
     ```
  2. 첫 로딩 전면 스켈레톤(G4b-20)에서는 그리지 않는다(웹 `:857-859` 분기).
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/course.tsx`
- 문구(i18n): 재사용 `course.backToMap`("지도 보기") / 새 키 없음
- 네이티브 주의:
  - 탭 화면의 뒤로 버튼은 플랫폼 관례와 다르지만 웹과 같게 둔다.
  - `backdrop-blur` 는 RN 에서 생략한다(bg white/90).
- 확인 방법: `cap-default.mjs plan1` → `plan1-01-top`, probe `[aria-label="지도 보기"]` = (16,16,44×44).
- 크기: S · 의존: G4b-01
- 표시: —

### G4b-03 공유 버튼 — 모양과 보이는 조건
- 화면·상태: 계획 표시·오류·빈·공유 모드·공유 모드 로딩
- 스크린샷: shots/G4b/h20-share-button.pair.png, s10-error.pair.png, h10-shared-loading.pair.png, h21-share-click.pair.png
- 웹(기준):
  - 모양: `apps/web/components/ShareButton.tsx:66-76` `inline-flex items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 py-1.5 text-xs font-semibold text-muk-soft` + `page.tsx:878` `shadow-[0_2px_10px_rgba(43,35,32,0.15)]`.
  - 위치: `:873` top 16 · right 16.
  - 내용: 아이콘 `Share2 15` + 글자 '공유'(`common.share`), 65×30. 복사되면 2초 동안 `Check 15` jade(`:50-52,73`).
  - 보이는 조건 `pack.features.share`(경주는 항상):
    - 정류지가 없어도(오류·빈) 보이고, 그때는 지금 페이지 주소를 공유한다(`page.tsx:835` → `ShareButton.tsx:28`).
    - 첫 로딩 스켈레톤에는 없다.
  - 실패 토스트 10초(`ShareButton.tsx:63`).
- Expo(현재):
  - 모양: `course.tsx:98-108` `IconButton icon={Share2} box={44} className="border border-line bg-white/90"` — 44×44 원, 아이콘 20px muk, 글자 없음, 그림자 없음, top/right 12.
  - 보이는 조건:
    - `shareUrl` 이 null(정류지 0개)이면 그리지 않아 오류·빈 상태에 버튼이 없다(probe errShare 웹 1 / Expo 0).
    - 반대로 공유 모드 로딩 중에는 보인다(h10).
  - 복사 뒤 아이콘 변화 없음. 실패 토스트 `:86` 지속시간 기본(4초).
- 차이: 알약+글자 vs 원형 아이콘, 크기·위치·그림자, 표시 조건(오류·빈·로딩), 복사 표시, 실패 토스트 시간.
- 참고:
  - 링크 origin 이 웹은 지금 주소, Expo 는 운영 `https://nextspot-nu.vercel.app` 이다(의도 — inventory D26).
  - headless 에서는 웹이 클립보드 권한 거부로 '공유하지 못했어요'+주소 토스트, Expo web 은 expo-clipboard 성공 토스트를 띄웠다(h21). 실제 폰은 둘 다 공유 시트라 환경 차이로만 기록한다.
- 중요도: P1
- 분류: 아이콘·이미지 · 상태(로딩·빈·오류)
- 고칠 방법:
  1. `course.tsx:98-108` 을 알약으로 바꾼다. `copied` 상태는 `onShare` 결과가 `'copied'` 이면 true, 2초 뒤 false.
     ```tsx
     <Pressable
       accessibilityRole="button"
       accessibilityLabel={t('common.share')}
       onPress={onShare}
       hitSlop={{ top: 7, bottom: 7 }}
       style={{ position: 'absolute', top: 16, right: 16, boxShadow: '0px 2px 10px rgba(43,35,32,0.15)' }}
       className="flex-row items-center gap-[6px] rounded-full border border-line bg-white/80 px-[12px] py-[6px]"
     >
       <Icon icon={copied ? Check : Share2} size={15} color={copied ? 'jade' : 'muk-soft'} />
       <Text className="text-[12px] leading-[16px] text-muk-soft" weight="semibold">{t('common.share')}</Text>
     </Pressable>
     ```
  2. 표시: `firstLoad`(G4b-20)가 아니면 항상 그린다.
     - URL 은 정류지가 있으면 지금처럼, 없으면 `${WEB_ORIGIN}/course`(공유 모드는 `reshareCourseUrl`).
     - `lib/platform/shareUrls.ts` 에 `coursePageUrl()` 같은 폴백을 두거나, `course.tsx:73-79` 에서 `` ?? `${WEB_ORIGIN}/course` `` 로 처리한다.
  3. `:86` 실패 토스트에 `duration: 10000`.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/course.tsx`, (선택) `apps/mobile/lib/platform/shareUrls.ts`
- 문구(i18n): 재사용 `common.share`, `common.shareCourse`, `common.linkCopied`, `common.shareFailed` / 새 키 없음
- 네이티브 주의: Android `Share` 는 url 칸이 없어 문구 뒤에 링크를 붙인다(이미 `share.ts` 처리). hitSlop 으로 44pt 탭 영역을 유지한다.
- 확인 방법: `cap-shared.mjs share`(h20·h21), `cap-states.mjs err`(s10 에 '공유' 알약 존재), `cap-shared.mjs sharedStates`(h10 에 버튼 없음).
- 크기: S · 의존: G4b-01, G4b-20
- 표시: —

### G4b-04 지도 위 내 위치 점 크기
- 화면·상태: 모든 지도 상태(정류지 없을 때 가장 잘 보임)
- 스크린샷: shots/G4b/s10-error.pair.png, s50-location-fallback.pair.png, m02-user-dot.pair.png
- 웹(기준):
  - `CourseMap.tsx:110-116` div 14×14, `border: 3px solid #fff`, 바탕 `#2b2320`, `box-shadow: 0 0 0 4px rgba(43,35,32,0.15)`.
  - Tailwind preflight 의 `box-sizing: border-box` 가 적용된다(probe `boxSizing: border-box`). 그래서 검은 원 8px + 흰 테 3px(=14) + 번짐 4px(=22).
- Expo(현재):
  - `apps/mobile/features/map/pins.ts:46` `USER_DOT.plain = { core: 14, border: 3, outer: 22 }`.
  - `NextSpotMap.web.tsx:693-707` 에서 안쪽 20px(검은 14 + 흰 3) + 바깥 22px(번짐 1px). 네이티브 `NextSpotMap.tsx:405-411` 도 같은 값.
- 차이: 검은 원 지름 8 vs 14px — Expo 점이 크고 진하다.
- 중요도: P2
- 분류: 아이콘·이미지
- 고칠 방법:
  1. `pins.ts:46` → `plain: { core: 8, border: 3, outer: 22 }`(안쪽 8+3×2 = 14, 바깥 22 = 웹 14+4×2). `'plain'` 은 코스만 쓴다(`CourseMapView.tsx:77`) — 다른 화면 영향 없음.
  2. `pins.ts:43` 주석을 '코스: 검은 8 + 흰 테 3 + 번짐 4'로.
- 바꿀 Expo 파일: `apps/mobile/features/map/pins.ts`
- 문구(i18n): 없음
- 네이티브 주의: 네이티브 마커도 같은 상수라 함께 작아진다(웹과 같아짐).
- 확인 방법: `cap-states.mjs err` → s10 점 비교, `cap-metrics.mjs` → Expo `userDot` 14×14.
- 크기: S · 의존: G2(NextSpotMap 담당과 공유)
- 표시: —

### G4b-05 지도 SDK 실패 폴백
- 화면·상태: 카카오 SDK 를 못 받을 때(로컬에서 SDK 요청 abort 로 재현)
- 스크린샷: shots/G4b/x01-map-unavailable.pair.png
- 웹(기준):
  - `CourseMap.tsx:226-233`: 3초 뒤 `h-[22dvh]`(185.7px) `bg-gradient-to-b from-hanji-deep/70 via-hanji-deep/40 to-hanji`.
  - 그 위에 뒤로·공유 버튼, 아래 둥근 시트+그랩바가 보인다.
  - SDK 로드 중에는 `:238` `bg-hanji-deep animate-pulse`.
- Expo(현재): `features/map/NextSpotMap.web.tsx:540-547` `MAP_COLORS.unavailable`(#efe6d6, `pins.ts:40`) 단색, 높이 287 그대로. 첫 카드 y=301 vs 웹 212.7.
- 차이: 높이 185.7 vs 287, 그라데이션 vs 단색, (그랩바 — G4b-01).
- 중요도: P2
- 분류: 상태(로딩·빈·오류)
- 고칠 방법:
  1. `NextSpotMapProps` 에 `onUnavailable?: () => void` 를 추가한다.
     - web: `!MAP_AVAILABLE` 또는 `failed` 가 될 때 1회 호출(`NextSpotMap.web.tsx` 의 `failed` 상태).
     - native: `MAP_AVAILABLE === false` 일 때.
  2. `CourseMapView` 가 이를 상태로 받아, 지도 대신 `height = Math.round(windowHeight * 0.22)` 의 `Gradient colors={['rgba(241,231,211,0.7)','rgba(241,231,211,0.4)', colors.hanji]} start={{x:0.5,y:0}} end={{x:0.5,y:1}}` 를 그린다. 뒤로·공유는 그대로 위에 둔다.
  3. 로드 중 바탕은 `hanji-deep`(#f1e7d3) + 펄스(선택).
- 바꿀 Expo 파일: `apps/mobile/features/map/NextSpotMap.web.tsx`, `NextSpotMap.tsx`, `types.ts`, `apps/mobile/features/course/components/CourseMapView.tsx`, `app/(tabs)/course.tsx`
- 문구(i18n): 없음
- 네이티브 주의: react-native-maps 는 키·Play 서비스 문제를 콜백으로 잘 알리지 않는다 — `MAP_AVAILABLE` 기준만 확실하다.
- 확인 방법: `cap-extra.mjs nomap` → x01, `nomapGeo` 의 Expo 첫 카드 y ≈ 213.
- 크기: M · 의존: G4b-01, G2(NextSpotMap)
- 표시: 네이티브 확인 필요

### G4b-06 '현재 HH:MM 기준' 칩 — 시계 아이콘·살아 있는 점
- 화면·상태: 헤더 카드(계획·빈·오류·공유)
- 스크린샷: shots/G4b/plan3-10-header.pair.png
- 웹(기준): `apps/web/components/NowChip.tsx:28-41`
  - 칩: `inline-flex items-center gap-1 rounded-full bg-hanji-deep/70 border border-line px-2 py-0.5 text-[10px] font-medium text-muk-soft`.
  - 내용: `Clock 11` + 6px jade 점(`animate-ping` 2s 번짐, motion-reduce 숨김) + `common.nowTime`. 102.5×21.
- Expo(현재): `course.tsx:36-50` View `rounded-full border border-line bg-hanji-deep/70 px-[8px] py-[3px]` + Text 11px medium. 83.7×21, 아이콘·점 없음.
- 차이: 시계 아이콘·초록 점 누락, 글자 11 vs 10px.
- 중요도: P1
- 분류: 아이콘·이미지 · 글꼴
- 고칠 방법:
  1. 공용 `apps/mobile/components/ui/NowChip.tsx` 로 옮긴다. 웹 NowChip 은 대기·대안 화면도 쓰므로 G5a·G4a 와 공유한다. 핑은 같은 크기 원을 Reanimated 로 scale 1→2, opacity .6→0, 2s 반복(useReduceMotion 이면 생략).
     ```tsx
     <View className="flex-row items-center gap-[4px] self-start rounded-full border border-line bg-hanji-deep/70 px-[8px] py-[2px]">
       <Icon icon={Clock} size={11} color="muk-soft" />
       <View className="h-[6px] w-[6px]">
         {/* 핑 원 */}
         <View className="h-[6px] w-[6px] rounded-full bg-jade" />
       </View>
       <Text className="text-[10px] leading-[15px] text-muk-soft" weight="medium">
         {t('common.nowTime', { time })}
       </Text>
     </View>
     ```
  2. 30초 갱신은 그대로.
- 바꿀 Expo 파일: `apps/mobile/components/ui/NowChip.tsx`(새), `apps/mobile/components/ui/index.ts`, `apps/mobile/app/(tabs)/course.tsx`
- 문구(i18n): 재사용 `common.nowTime` / 새 키 없음
- 네이티브 주의: Reanimated 반복 애니메이션은 '동작 줄이기'(useReduceMotion)에서 멈춘다.
- 확인 방법: plan3-10-header 재촬영, 칩 102×21.
- 크기: S · 의존: G5a(공용 NowChip)
- 표시: —

### G4b-07 헤더 카드 — 간격·브랜드 칩·ETA 박스
- 화면·상태: 헤더 카드
- 스크린샷: shots/G4b/plan3-10-header.pair.png, plan1-10-header.pair.png
- 웹(기준):
  - 카드: `page.tsx:895` `rounded-2xl border border-line/70 bg-hanji-deep/45 p-4 space-y-3`.
  - 브랜드 칩: `:898` `px-2.5 py-1 text-[11px] font-bold`, 줄 높이 16.5 → 104.7×26.5.
  - 제목 묶음: `:906` `space-y-1.5`, h1 `:907` 22px black `leading-[1.15]`, 부제 `:910` 12px `leading-relaxed`(19.5).
  - 스탯 줄: `:929` `pt-0.5`(위 space-y-3 → 부제 아래 14px).
  - ETA: `:931-934` `inline-flex items-center gap-1.5 rounded-xl border border-gold/40 bg-gold/15 px-3 py-2 text-[13px] font-black` + `shadow-[0_2px_10px_rgba(193,154,62,0.16)]`. 🕒 은 따로 span → 163.4×37.5.
  - 빈·오류 제목: `:916` `text-lg leading-tight font-black`(18/22.5).
- Expo(현재):
  - 카드: `course.tsx:124-153` `gap-[10px] p-[16px]`.
  - 브랜드: `:126-130` Text 11px(줄 높이 normal) → 105×22.
  - headline 22/26, 부제 12/18.
  - ETA: `:139-143` `mt-[4px]` + Text "🕒 마지막 장소…" 13px black → 160.7×35, 그림자 없음(부제 아래 10px).
  - 빈 제목 18/24.
- 차이: 브랜드 칩 22 vs 26.5px, 간격 10 vs 12(·14), ETA 높이·그림자, 줄 높이.
- 중요도: P2
- 분류: 크기·간격 · 색·효과
- 고칠 방법:
  1. 카드 `gap-[12px]`.
  2. 브랜드 Text `leading-[16.5px]`.
  3. 제목 묶음 `gap-[6px]`(headline `leading-[25px]`, 부제 `leading-[19.5px]`).
  4. ETA 를 제목 묶음 밖 별도 행으로 옮긴다. 가정 시간 컨트롤도 이 행에 들어간다(G4b-08).
     ```tsx
     <View className="flex-row flex-wrap items-center gap-[8px] pt-[2px]">
       <View
         style={{ boxShadow: '0px 2px 10px rgba(193,154,62,0.16)' }}
         className="flex-row items-center gap-[6px] self-start rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]"
       >
         <Text>🕒</Text>
         <Text className="text-[13px] leading-[19.5px] text-gold-deep" weight="black">…</Text>
       </View>
     </View>
     ```
  5. 빈·오류 제목 `leading-[22.5px]`.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/course.tsx`
- 문구(i18n): 없음
- 네이티브 주의: Android Text 는 includeFontPadding 때문에 줄 높이를 명시해야 한다.
- 확인 방법: plan3-10-header 재촬영, probe `brandChip` 26.5, `etaBox` 163×37.5.
- 크기: S · 의존: G2(Text 기본 줄 높이 정책)
- 표시: —

### G4b-08 가정 시간 선택(웹 전용)
- 화면·상태: 헤더 카드(공유 모드 제외)
- 스크린샷: shots/G4b/plan3-10-header.pair.png, s10-error.pair.png
- 웹(기준): `page.tsx:936-957`
  - 컨트롤: `<label class="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-xs font-medium shadow-[0_2px_10px_rgba(43,35,32,0.06)]">` 안에 🕒 + '가정 시간'(`timeSim.label`, muk-soft) + `<select aria-label="가정 시간">`(굵게 muk).
  - 옵션: `timeSim.now` 지금(실시간) · `weekdayNoon` 평일 12:00 · `friEve` 금 18:00 · `satAfternoon` 토 14:00 · `sunMorning` 일 11:00.
  - 'now' 가 아니면 배지: `:953` `rounded-full bg-gold/15 border border-gold/40 px-2.5 py-1 text-[11px] font-bold text-gold-deep` `timeSim.badge`.
  - 고르면:
    - `nextspot_assumed_at` 저장.
    - 요청 body `assumed_at`(`page.tsx:516-517`, `lib/api-client.ts:648-720`).
    - 모든 'HH:MM 도착'과 간트 첫 눈금이 그 시각 기준(`:847-848`).
  - 빈 상태 문구 2개가 이 컨트롤을 가리킨다.
- Expo(현재): 없다. `features/course/useCoursePlan.ts:1-2` '가정 시각 프리셋 제외', PORTING.md:35. `baseMs={null}` 고정(`course.tsx:155,183`).
- 차이: 헤더의 컨트롤·배지 누락, 시간 기준 기능 없음, 관련 문구 키 차이(G4b-23).
- 중요도: P0
- 분류: 누락
- 고칠 방법(선택 A — 이식, 권장):
  1. 순수 모듈 `apps/mobile/lib/core/assumedTime.ts` 를 만든다.
     - 웹 `api-client.ts:648-720` 의 `ASSUMED_TIME_PRESETS`·`assumedAtIsoForPreset`·키 `nextspot_assumed_at` 를 옮긴다. 웹 파일은 window 를 써 `check:shared` 에 걸리므로 PORTING.md 에 원본·기준 커밋을 기록한다.
     - 저장은 localStorage(웹 빌드)/kv(네이티브), 화면 사이 동기화는 작은 구독 store.
  2. `features/course/components/TimeSimControl.tsx`:
     - 웹 label 모양의 Pressable: min-h 44, `rounded-xl border border-line bg-white px-[12px] gap-[6px]`, boxShadow `0px 2px 10px rgba(43,35,32,0.06)`. 내용은 🕒 + Text 12px muk-soft + 값 Text 12px bold muk + ChevronDown 12.
     - 누르면 `components/ui/Sheet.tsx` 에 5개 목록(선택 표시).
     - 'now' 가 아니면 배지(위 값).
  3. `useCoursePlan`:
     - body `assumedAt`(`features/course/api.ts`, `types.ts` `CoursePlanRequest`).
     - 캐시에 `preset` 저장·대조(`model.ts` `CourseCacheEntry`/`parseCache` — 웹 `page.tsx:431,583`).
     - 조용한 새로고침 판정에 preset 포함(웹 `:494-497`).
  4. `course.tsx`: `baseMs = preset === 'now' ? null : Date.parse(assumedAtIso)` 를 ETA(`:141`)·Stepper(`:155`)·Gantt(`:183`)·StopRows(`baseMs`)에 넘긴다.
  5. G4b-23 문구를 웹 키로 되돌린다.
  - 선택 B: 앱 범위 밖 유지(공모전 데모 기능 — 공모전 종료). 그러면 웹 빈 상태 문구에서도 '가정 시간' 언급을 빼는 것이 일관이다(웹 변경).
  - 선택 C: 웹에서도 제거.
- 바꿀 Expo 파일: `apps/mobile/lib/core/assumedTime.ts`(새), `apps/mobile/features/course/components/TimeSimControl.tsx`(새), `features/course/useCoursePlan.ts`, `features/course/api.ts`, `features/course/types.ts`, `features/course/model.ts`, `features/course/components/StopRows.tsx`, `CourseSections.tsx`, `app/(tabs)/course.tsx`, `apps/mobile/PORTING.md`
- 문구(i18n): 재사용 `timeSim.label`, `timeSim.now`, `timeSim.weekdayNoon`, `timeSim.friEve`, `timeSim.satAfternoon`, `timeSim.sunMorning`, `timeSim.badge` / 새 키 없음
- 네이티브 주의: 셀렉트가 없어 Sheet/ActionSheet 를 쓴다. Expo web 의 `Alert` 는 `window.confirm` 이라 쓰지 않는다.
- 확인 방법: 두 앱에서 '토 14:00' 을 고른 뒤 policy 로그 body 키에 `assumed_at` 이 있는지, 배지·도착 시각이 같은지 본다. plan3-10-header 재촬영.
- 크기: L · 의존: G5a(대기 화면 같은 컨트롤), G2(홈 예측 띠 프리셋 공유), G4b-23
- 표시: 결정 필요

### G4b-09 가로 스텝퍼 — 칸 배치·연결선·첫 원
- 화면·상태: 정류지 1·2·3곳
- 스크린샷: shots/G4b/plan3-11-stepper.pair.png, plan1-11-stepper.pair.png, s40-partial.pair.png
- 웹(기준):
  - 목록: `page.tsx:1103-1106` `ol` `flex items-start w-full rounded-2xl border border-line/60 bg-white px-2 py-3.5 shadow-[0_1px_2px_rgba(43,35,32,0.04)]`.
  - 칸: `li` `:1114-1116` 첫 칸 `flex-none`(1곳이면 `flex-1 justify-center`), 둘째부터 `flex-1`.
  - 연결선: `:1121` `h-[3px] rounded-full bg-gradient-to-r from-gold/20 via-gold/40 to-gold/20 flex-1 mt-[18px] mx-1`.
  - 내용: `:1125` `w-[5.5rem]`(88) `gap-1.5`.
  - 원: `:1127-1131` 40px. 첫 원 `bg-gradient-to-br from-gold to-gold-deep border-2 border-white shadow-[0_2px_10px_rgba(193,154,62,0.45)]`, 나머지 `bg-hanji-deep border-2 border-gold/25`.
  - 이름: `:1138` 12px `leading-tight` 2줄.
  - 알약: `:1147` `px-1.5 py-0.5 text-[10px] font-bold leading-none`(높이 14).
  - 결과: 3곳이면 첫 칸이 왼쪽에 붙고 약 31px 금빛 선이 사이를 채운다. 2곳이면 양 끝(s40).
- Expo(현재):
  - 칸: `features/course/components/CourseSections.tsx:27` 모두 `min-w-0 flex-1`(균등 분할).
  - 연결선: `:28` `mx-[2px] h-[3px] w-[10px] bg-gold/30` 고정.
  - 내용: `:29` `flex-1`.
  - 첫 원: `:33` `bg-gold` 단색·그림자 없음(흰 테두리가 흰 카드에서 안 보임).
  - 알약: `:44` `px-[6px] py-[3px]`(높이 17).
- 차이: 칸 배치(왼쪽 정렬+늘어나는 선 vs 균등 3등분+10px 선), 첫 원 그라데이션·그림자, 알약 높이 14 vs 17.
- 중요도: P1
- 분류: 배치 · 색·효과
- 고칠 방법:
  1. `CourseSections.tsx:24-52` 칸 클래스: `idx > 0 ? 'min-w-0 flex-1 flex-row items-start' : stops.length === 1 ? 'min-w-0 flex-1 flex-row items-start justify-center' : 'flex-row items-start'`.
  2. 연결선: `<Gradient colors={['rgba(193,154,62,0.2)','rgba(193,154,62,0.4)','rgba(193,154,62,0.2)']} start={{x:0,y:0.5}} end={{x:1,y:0.5}} style={{ flex: 1, height: 3, borderRadius: 9999, marginTop: 18, marginHorizontal: 4 }} />`.
  3. 내용 `w-[88px] items-center gap-[6px]`.
  4. 첫 원은 두 겹으로 만든다:
     - 바깥 View: 40×40, radius 20, boxShadow `0px 2px 10px rgba(193,154,62,0.45)`.
     - 안쪽 View: overflow hidden, 테두리 2 white.
     - 안에 `Gradient colors={[colors.gold, colors['gold-deep']]} start={{x:0,y:0}} end={{x:1,y:1}}` + 이모지 16px.
  5. 알약 `py-[2px]` + Text `leading-[10px]`. 카드 boxShadow `0px 1px 2px rgba(43,35,32,0.04)`.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/CourseSections.tsx`
- 문구(i18n): 없음
- 네이티브 주의: boxShadow 와 overflow hidden 을 한 View 에 두면 그림자가 잘릴 수 있어 두 겹으로 둔다.
- 확인 방법: `cap-default.mjs plan1 plan3`(stepper 줌), `cap-states.mjs partial`(2곳).
- 크기: M · 의존: —
- 표시: —

### G4b-10 '목록 | 시간표' 토글 — 색·높이
- 화면·상태: 정류지가 있을 때
- 스크린샷: shots/G4b/plan3-12-toggle.pair.png, i12-gantt-toggle.pair.png
- 웹(기준):
  - 컨테이너: `page.tsx:1291` `inline-flex items-center gap-1 p-1 rounded-full border border-line bg-white shadow-[0_1px_2px_rgba(43,35,32,0.04)]`, `role=tablist aria-label=course.title`.
  - 탭: `:1300` `min-h-9`(36) `px-4 text-xs font-bold`.
  - 켜짐: `:1301` `bg-gold text-white shadow-[0_2px_8px_rgba(193,154,62,0.3)]`. 50.3×36.
- Expo(현재): `CourseSections.tsx:68-83` 탭 `min-h-[44px] px-[18px]`, 켜짐 `bg-gold-deep`(#705819), 그림자 없음. 54.5×44.
- 차이: 켜진 탭 색(밝은 금 #c19a3e vs 진한 금갈색), 높이 36 vs 44, 그림자.
- 중요도: P1
- 분류: 색·효과 · 크기·간격
- 고칠 방법:
  1. `:78` → `min-h-[36px] px-[16px]`, 켜짐 `bg-gold` + `style={on ? { boxShadow: '0px 2px 8px rgba(193,154,62,0.3)' } : undefined}`. 탭에 `hitSlop={{ top: 4, bottom: 4 }}`(44pt 탭 영역).
  2. 컨테이너 `:68` boxShadow `0px 1px 2px rgba(43,35,32,0.04)`.
  - 결정: 흰 글자 on #c19a3e 대비는 2.6:1 로 WCAG AA 4.5:1 미달이다. Expo 가 gold-deep(6.8:1)을 쓴 이유다(`components/ui/ErrorState.tsx:28` 주석).
    - A: Expo 를 웹 금색으로(대비 미달 감수).
    - **B(권장)**: 웹 `page.tsx:1301` `bg-gold` → `bg-gold-deep`(+ G4b-21 웹 ErrorState). 두 앱이 같아지고 대비 기준도 충족한다. Expo 는 높이·그림자만 맞춘다.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/CourseSections.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 36pt 는 DESIGN_PRINCIPLES 44pt 미만 — hitSlop 이 필수다.
- 확인 방법: plan3-12-toggle·i12 재촬영, probe 탭 50×36·색.
- 크기: S · 의존: G4b-21(같은 결정)
- 표시: 결정 필요

### G4b-11 정류지 행 제목줄 — 종류 이모지 칸, '고정됨' 배지 위치
- 화면·상태: 정류지 행(고정 전·후)
- 스크린샷: shots/G4b/plan3-20-row1.pair.png, i30-pinned-row.pair.png, i31-unpin-all.pair.png
- 웹(기준): `page.tsx:1706-1719`
  - 제목: `<h3 class="min-w-0 flex items-start gap-1.5 text-[15px] font-bold text-muk leading-snug">`.
  - 종류 이모지: `:1707-1712` `mt-0.5 w-5 h-5 rounded-md bg-hanji-deep text-[11px]` 네모 칸(20×20).
  - 이름: `:1713` 2줄.
  - '📌 고정됨': `:1714-1718` **이름 바로 옆 같은 줄**, `mt-0.5 shrink-0 px-1.5 py-0.5 rounded-full bg-gold/15 border border-gold/30 text-[10px] font-bold text-gold-deep`.
- Expo(현재):
  - `features/course/components/StopRows.tsx:250-252` Text "☕ 이름" — 이모지가 15px 글자로 붙고 칸이 없다.
  - `:253-259` 고정됨 배지가 이름 아래 **별도 줄**(self-start).
  - 이름은 heading 이 아니다.
- 차이: 이모지 칸 누락, 배지 위치(같은 줄 vs 아래 줄 → 행 높이 +26px).
- 중요도: P1
- 분류: 배치 · 아이콘·이미지
- 고칠 방법:
  1. `StopRows.tsx:249-259` 를 아래처럼 바꾼다.
     ```tsx
     <View className="flex-row items-start gap-[6px]" accessibilityRole="header">
       <View
         className="mt-[2px] h-[20px] w-[20px] items-center justify-center rounded-md bg-hanji-deep"
         accessibilityElementsHidden
         importantForAccessibility="no-hide-descendants"
       >
         <Text className="text-[11px] leading-[14px]">{typeEmoji(stop.facility.type)}</Text>
       </View>
       <Text className="min-w-0 shrink text-[15px] leading-[21px]" weight="bold" numberOfLines={2}>
         {stop.facility.name}
       </Text>
       {pinned ? (
         <View className="mt-[2px] shrink-0 rounded-full border border-gold/30 bg-gold/15 px-[6px] py-[2px]">
           <Text className="text-[10px] text-gold-deep" weight="bold">📌 {t('course.pinnedBadge')}</Text>
         </View>
       ) : null}
     </View>
     ```
  2. 아래 칩 줄과의 간격은 웹 `mt-1.5`(6) — 지금 gap 6 을 유지한다.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/StopRows.tsx`
- 문구(i18n): 재사용 `course.pinnedBadge` / 새 키 없음
- 네이티브 주의: Android 에서 `shrink` Text 와 옆 배지가 줄바꿈될 때 2줄 제한을 확인한다.
- 확인 방법: `cap-interact.mjs pin` → i30, i31.
- 크기: S · 의존: G4b-29(heading)
- 표시: —

### G4b-12 사진 없는 정류지의 56px 표지
- 화면·상태: 사진 없는 정류지(설빙 황리단길점 — 카카오 발견 장소)
- 스크린샷: shots/G4b/plan3-20-row1.pair.png, plan1-20-row1.pair.png
- 웹(기준): `page.tsx:1764-1778` `h-14 w-14 rounded-xl border border-line` 상자에 `apps/web/components/PlacePhotoFallback.tsx:88-138`.
  - 문양: 장소 id 로 정한 경주 문양 SVG(기와·수막새·석탑·물결·문살, `:26-86`, 선 1.4 · opacity .5).
  - 색: `lib/placeVisual.ts` tone — slate #5b6878 · indigo #465a8c · stone #77736c, 바탕 `.place-tile`.
  - 가운데: 44px 원(`bg-hanji/90 ring-1 ring-current/40` + 그림자) 안 lucide 유형 그림 20px(`:16-22` Utensils/Coffee/Mountain/Landmark/MapPin, stroke 1.8).
- Expo(현재): `StopRows.tsx:294-309` `bg-tile-slate-bg`(#ded6c7) **고정** + 유형 이모지 22px. 문양·원·tone 선택 없음.
- 차이: 일러스트 표지 vs 이모지 블록, 장소별 색 없음.
- 중요도: P1
- 분류: 아이콘·이미지
- 고칠 방법:
  1. 공용 RN 컴포넌트 `apps/mobile/components/ui/PlacePhotoFallback.tsx`(react-native-svg)를 만든다.
     - 모양 결정: `placeVisual(id, type)`(`@/lib/placeVisual` — 순수, 이미 `features/waiting/PlaceTile.tsx:10` 이 import)로 motif·tone·glyph·phase.
     - 색: 바탕 `bg-tile-{tone}-bg`(`lib/theme/tokens.ts` `tile-*-bg`), 선 색 `colors['tile-'+tone]`.
     - 문양 path: 웹 `PlacePhotoFallback.tsx:26-86` 함수를 옮긴다. 권장은 웹에 순수 `lib/placeEmblem.ts` 로 떼어 두 앱이 import 하는 것 — 지금은 .tsx·lucide 의존이라 공유할 수 없다. 그리기: `<Svg viewBox="0 0 100 112" preserveAspectRatio="xMidYMid slice"><Path d={…} transform={`translate(${shift} 0)`} stroke={tone} strokeWidth={2.5} opacity={0.5} fill="none" /></Svg>`.
     - 가운데: 44px 원 `bg-hanji/90` + 1px 테(tone 40%) + boxShadow `0px 2px 10px rgba(43,35,32,0.12)` + `lucide-react-native` 아이콘 20, strokeWidth 1.8(색 tone).
  2. `StopRows.tsx:294-309` 를 `<View className="h-[56px] w-[56px] overflow-hidden rounded-xl border border-line"><PlacePhotoFallback visual={placeVisual(stop.facility.id, stop.facility.type)} style={StyleSheet.absoluteFill} />{photo}</View>` 로.
- 바꿀 Expo 파일: `apps/mobile/components/ui/PlacePhotoFallback.tsx`(새), `components/ui/index.ts`, `features/course/components/StopRows.tsx`
- 문구(i18n): 없음
- 네이티브 주의: react-native-svg 는 `vectorEffect="non-scaling-stroke"` 를 지원하지 않는다 → 56px 상자에서 화면 1.4px ≈ svg 2.5 단위로 환산한다.
- 확인 방법: plan3-20-row1 재촬영.
- 크기: M · 의존: G3(CardPhoto), G4a(PhotoCover), G5a(PlaceTile) — 같은 공용 표지로
- 표시: 네이티브 확인 필요

### G4b-13 펼침 쉐브론이 돌지 않음
- 화면·상태: 추천 이유·더보기·다른 곳 N·코스 직접 짜기 열고 닫기
- 스크린샷: shots/G4b/i01-row1-reason.pair.png, i03-row2-more.pair.png, i04-row2-alts.pair.png, i23-dimmed.pair.png
- 웹(기준): `ChevronDown` 에 열리면 `rotate-180`(transition).
  - 추천 이유 `page.tsx:1793`(13px, gold-deep).
  - 더보기 `:1804`(13px, muk-soft).
  - 다른 곳 `:1851`(12px).
  - 코스 직접 짜기 `:1031-1035`(14px, 글자색 muk).
- Expo(현재): `StopRows.tsx:324,337,394`, `course.tsx:216` — 회전 없음, 크기 xs(12), 코스 직접 짜기 쉐브론 색 muk-soft.
- 차이: 열림 표시(∧)가 Expo 에 없음, 크기·색 1~2px.
- 중요도: P2
- 분류: 동작 · 아이콘·이미지
- 고칠 방법:
  1. 각 `Icon` 을 `<View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>` 로 감싼다(원하면 Reanimated 200ms).
  2. 크기: 추천 이유·더보기 13, 다른 곳 12, 코스 직접 짜기 14·`color="muk"`.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/StopRows.tsx`, `apps/mobile/app/(tabs)/course.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: `cap-interact.mjs rows builder` → i01·i03·i04·i23.
- 크기: S · 의존: —
- 표시: —

### G4b-14 작은 글자 크기·줄 높이(웹 10·11·12px → Expo 11·12·13px)
- 화면·상태: 추천 이유·더보기·대안·빠진 자리·빈/로그인 카드·순서 피커·간트·공유 배너
- 스크린샷: shots/G4b/i01-row1-reason.pair.png, i02-row2-reason.pair.png, i03-row2-more.pair.png, i04-row2-alts.pair.png, plan1-30-dropped.pair.png, s21-auth-card.pair.png, s32-empty-none-card.pair.png, i21-builder-panel.pair.png, i11-gantt-card.pair.png
- 웹(기준) → Expo(현재) (측정값):

  | 요소 | 웹 `apps/web/app/course/page.tsx` | Expo |
  |---|---|---|
  | 추천 이유 문장 | `:1819` 12px / 19.5 | `StopRows.tsx:357` 13 / 19 |
  | 추정 근거 줄 | `:1822` 10px / 16.25 | `:359` 11 / 16 |
  | SPOT 알약 | `:1826` 11px semibold, 23.9px 높이 | `:363-367` 11, 19px |
  | 더보기 안 버튼(자동차·다른 곳·고정) | `:1838,1848,1859` 11px bold | `:379,391,405` 12 |
  | 대안 이름·정보·버튼·안내 | `:1882` 12 · `:1883` 10 · `:1901` 10 · `:1908` 10 | `:421` 13 · `:424` 11 · `:437` 11 · `:445` 11 |
  | 빠진 자리 제목·사유·힌트 | `:1576` 13/19.5 · `:1580` 11/17.9 · `:1586` 10/16.25 `text-muk-soft/80` | `:129` 13/normal · `:133` 12/18 · `:137` 11/16 muk-soft |
  | 빠진 자리 고정 해제 | `:1591` 11px | `:145` 12 |
  | 혜택 칩(도착·도보·혼잡·영업) | `:1723-1752` 12px, 줄 높이 18 → 26~28px | `StopRows.tsx:156-164` Pill 12px normal → 24~26px |
  | 빈 카드: 사유 제목·사유·힌트·본문 | `:1968` 11 semibold · `:1971` 12 · `:1976` 11 · `:1991` 12 | `CourseSections.tsx:226` 12 · `:230` 13 · `:234` 12 · `:244` 13 |
  | 로그인 카드 본문 | `:2006` 12 | `:263` 13 |
  | 순서 피커 안내·부제·초기화 | `:1187` 11 · `:1255` 11 semibold · `:1240` 11 | `OrderPicker.tsx:91` 12 · `:171` 12 · `:158` 12 |
  | 간트 안내·이름 | `:1337` 11 medium · `:1371` 11 bold | `CourseSections.tsx:105` 12 · `:137` 12 |

- 차이: 대부분 Expo 가 1px 크고 줄 높이가 다르다. 보이는 결과:
  - 로그인 카드 본문: 웹 1줄 → Expo 2줄('짜 드려|요.').
  - 빈 카드 본문: 1줄 → 2줄.
  - 추천 이유 문장 줄바꿈 위치가 다르다.
  - 칩 높이가 4px 낮다.
- 중요도: P1
- 분류: 크기·간격 · 글꼴
- 고칠 방법:
  1. 위 표의 Expo className 을 웹 값으로 바꾼다: `text-[N]px` + `leading-[웹 값]`. 웹 `leading-relaxed` = 1.625, 따로 주지 않은 곳은 상속 1.5.
  2. `Pill`(`StopRows.tsx:159`) Text 에 `leading-[18px]`, 빠진 자리 힌트는 `text-muk-soft/80`.
  3. 공유 배너는 G4b-24.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/StopRows.tsx`, `CourseSections.tsx`, `OrderPicker.tsx`
- 문구(i18n): 없음
- 네이티브 주의: Android includeFontPadding 으로 줄 높이가 웹보다 커질 수 있어 `leading-*` 를 명시한다. 큰 글자 배율(1.6)은 그대로 둔다.
- 확인 방법: `cap-interact.mjs rows gantt builder`, `cap-states.mjs auth empty` 재촬영 + `work/G4b/*.json` probe 값 비교.
- 크기: M · 의존: G2(Text 기본 줄 높이 1.5 를 전역으로 바꾸면 일부 자동 해결)
- 표시: —

### G4b-15 대안(다른 곳) 목록 행 구성
- 화면·상태: 더보기 → 다른 곳 N 펼침
- 스크린샷: shots/G4b/i04-row2-alts.pair.png
- 웹(기준):
  - 상자: `page.tsx:1874` `mt-2.5 rounded-2xl border border-line bg-hanji-deep/40 divide-y divide-line/70`.
  - 행: `:1879` `flex items-center gap-2 px-3 py-2.5`.
  - 왼쪽 이모지 칸: `:1880` `w-6 h-6 rounded-md bg-white text-xs`.
  - 이름: `:1882` truncate.
  - 버튼: `:1901` `min-h-10`(40) `px-3`.
  - 안내: `:1908` `px-3 py-2.5 bg-white/50`.
- Expo(현재): `StopRows.tsx:413-447` 이모지 칸 없이 "📸 이름" 한 줄(`:421-423`), 행 `py-[8px]`, 버튼 44px, 상자 `mt-[10px]`.
- 차이: 24px 이모지 칸 누락, 버튼 높이 40 vs 44, 행 여백.
- 중요도: P2
- 분류: 배치
- 고칠 방법:
  1. 행 앞에 `<View className="h-[24px] w-[24px] items-center justify-center rounded-md bg-white" accessibilityElementsHidden><Text className="text-[12px]">{typeEmoji(alt.facility.type)}</Text></View>` 를 두고, 이름에서 이모지를 뺀다.
  2. 행 `py-[10px]`.
  3. 버튼 `min-h-[40px]` + `hitSlop={{top:2,bottom:2}}`.
  4. 글자 크기는 G4b-14.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/StopRows.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: `cap-interact.mjs rows` → i04.
- 크기: S · 의존: G4b-14
- 표시: —

### G4b-16 그림자·그라데이션 효과 누락(일괄)
- 화면·상태: 화면 전반
- 스크린샷: shots/G4b/plan3-20-row1.pair.png, plan3-11-stepper.pair.png, plan3-10-header.pair.png, i11-gantt-card.pair.png, s30-empty-time-card.pair.png, i30-pinned-row.pair.png
- 웹(기준) → Expo 위치:
  - 번호 원 `page.tsx:1700` `shadow-[0_2px_8px_rgba(193,154,62,0.45)]` → `StopRows.tsx:239`
  - 길안내 `:1810` `shadow-[0_4px_14px_rgba(168,70,47,0.28)]` → `StopRows.tsx:339`(tokens `shadows.cta`)
  - 고정 해제(켜짐) `:1861` `0 2px 10px rgba(193,154,62,0.18)` → `StopRows.tsx:403`
  - 순서 칩 `:1222` `0 1px 4px rgba(193,154,62,0.18)` → `OrderPicker.tsx:63`
  - 간트 카드 `:1336`, 빈 `:1963`, 로그인 `:2003` `shadow-[0_2px_14px_rgba(43,35,32,0.06)]` → `CourseSections.tsx:104,217,256`(tokens `shadows.card`)
  - 정류지 세로선 `:1695` `bg-gradient-to-b from-gold/45 via-gold/25 to-gold/15` → `StopRows.tsx:42` 단색 gold 30%
  - 빠진 자리 선 `:1562` `from-gold/25 to-gold/10`(top 3rem, -bottom-2.5) → 단색 30% × opacity .5
  - ETA(G4b-07), 스텝퍼 첫 원(G4b-09), 토글(G4b-10), 선택 칩(G4b-18), 시트·뒤로·공유(G4b-01~03)는 따로 적었다.
- 차이: Expo 는 그림자·그라데이션 없이 평평하다. 번호 원·길안내 버튼의 금빛·주칠 번짐이 웹에서 눈에 띈다.
- 중요도: P2
- 분류: 색·효과
- 고칠 방법:
  1. 각 View 에 `style={{ boxShadow: '…' }}`. 카드는 `shadows.card`, 길안내는 `shadows.cta`, 나머지는 위 문자열.
  2. `Timeline`(`StopRows.tsx:29-47`)을 그라데이션으로 바꾼다.
     - 보통: `Gradient colors={['rgba(193,154,62,0.45)','rgba(193,154,62,0.25)','rgba(193,154,62,0.15)']} start={{x:0.5,y:0}} end={{x:0.5,y:1}}`, top 53.6(3.35rem), bottom -12.
     - `dashed`: `['rgba(193,154,62,0.25)','rgba(193,154,62,0.10)']`, top 48, bottom -10.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/StopRows.tsx`, `CourseSections.tsx`, `OrderPicker.tsx`
- 문구(i18n): 없음
- 네이티브 주의: RN `boxShadow` 는 새 아키텍처 전용이고, Android 9(API 28)+ 에서 바깥 그림자가 된다. 저사양에서 목록 스크롤 성능을 확인한다.
- 확인 방법: 위 스크린샷들 재촬영.
- 크기: S · 의존: —
- 표시: —

### G4b-17 시간표(간트) — 눈금 세로선·눈금 글자 정렬
- 화면·상태: '시간표' 탭
- 스크린샷: shots/G4b/i11-gantt-card.pair.png, i10-gantt-view.pair.png
- 웹(기준):
  - 카드: `page.tsx:1336` 그림자(G4b-16).
  - 눈금 글자: `:1342-1350` `text-[10px] text-muk-soft/80`. 가운데 눈금은 `-translate-x-1/2`(중앙 정렬), 마지막은 `-translate-x-full`.
  - 눈금 세로선: 각 트랙 `:1379` 안에 5개, `:1381-1383` `absolute top-0 bottom-0 w-px bg-line/60`.
  - 막대: `:1385-1386` `min-w-[2.5rem]`, 폭 `calc(w% - 2px)`.
- Expo(현재):
  - 트랙 `CourseSections.tsx:142` 에 세로선이 없다.
  - 눈금 `:113` `left: pct%`(왼쪽 정렬, 마지막만 `right:0`) → 가운데 눈금이 13px 오른쪽(probe 14:44 웹 x 101~127 / Expo 114~140).
  - 막대 `:145` `max(w,8)%`, minWidth 40.
- 차이: 트랙 안 시간 눈금선 누락, 눈금 글자 정렬, 글자 크기(G4b-14).
- 중요도: P1
- 분류: 누락 · 배치
- 고칠 방법:
  1. 트랙 View(`:142`) 안 맨 앞에 `ticks.map((tk,i) => <View key={i} pointerEvents="none" style={{ position:'absolute', top:0, bottom:0, width:1, left:`${tk.pct}%`, backgroundColor:'rgba(230,220,198,0.6)' }} />)` 를 넣는다.
  2. 눈금 줄(`:108-118`)은 `onLayout` 으로 폭 W 를 받아 각 Text 를 폭 40 상자로 둔다.
     - `left = i===0 ? 0 : i===4 ? W-40 : W*pct/100-20`
     - `textAlign` 은 왼쪽/가운데/오른쪽, 글자 `text-[10px] text-muk-soft/80`.
  3. 막대 폭을 px 로 `W*widthPct/100 - 2` 로 준다(minWidth 40 유지).
- 바꿀 Expo 파일: `apps/mobile/features/course/components/CourseSections.tsx`
- 문구(i18n): 없음
- 네이티브 주의: onLayout 첫 프레임에는 W=0 이다 — 0 이면 % 배치로 대체한다.
- 확인 방법: `cap-interact.mjs gantt` → i11, `ganttTicks` x 좌표가 웹과 같은지.
- 크기: M · 의존: G4b-14
- 표시: —

### G4b-18 순서 피커 — 선택된 종류 칩 색(금 vs 비취)·칩 글자 굵기
- 화면·상태: 코스 직접 짜기 → '어떤 곳을 넣을까요?' 칩 선택
- 스크린샷: shots/G4b/i22-filter-selected.pair.png, i21-builder-panel.pair.png
- 웹(기준):
  - `page.tsx:1266-1270` 켜짐 `bg-gold/15 border-gold text-gold-deep shadow-[0_2px_10px_rgba(193,154,62,0.18)]`, 꺼짐 `bg-white border-line text-muk-soft`.
  - 칩 글자 `text-[13px] font-bold`(담기 칩 `:1198` 도 bold, disabled `opacity-40`).
- Expo(현재): `OrderPicker.tsx:96-104,177-185` 공용 `Chip` 사용.
  - `components/ui/Chip.tsx:37` 켜짐 `border-jade bg-jade-chip`(#d8dfd5), 글자 muk.
  - `:45` semibold, disabled opacity-50.
- 차이: 선택색 금 vs 비취, 굵기 bold vs semibold, 그림자.
- 중요도: P1
- 분류: 색·효과 · 글꼴
- 고칠 방법:
  1. `Chip` 에 prop 두 개를 추가한다.
     - `tone?: 'jade' | 'gold'` — 기본 jade(홈 레이어 칩 유지).
     - `labelWeight?: FontWeightName`.
     - gold 켜짐은 `border-gold bg-gold/15` + 글자 `text-gold-deep` + boxShadow `0px 2px 10px rgba(193,154,62,0.18)`, gold 일 때 disabled `opacity-40`.
  2. `OrderPicker.tsx` 두 칩 줄에 `tone="gold" labelWeight="bold"`.
- 바꿀 Expo 파일: `apps/mobile/components/ui/Chip.tsx`, `apps/mobile/features/course/components/OrderPicker.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: `cap-interact.mjs builder` → i22, probe `cafeOn` bg/border.
- 크기: S · 의존: —
- 표시: —

### G4b-19 순서 피커 — Expo 전용 '앞으로/뒤로 옮기기' 줄
- 화면·상태: 순서 모드(칩을 1개 이상 담음)
- 스크린샷: shots/G4b/i25-sequence.pair.png, i26-sequence-after.pair.png
- 웹(기준): `page.tsx:1205-1245` 칩 한 줄(framer `Reorder`, 끌기) + '초기화' 뿐.
- Expo(현재): `OrderPicker.tsx:120-151` 칩 줄 아래 칸마다 "1. 📸 관광지" + ‹ › 44px 원 버튼 쌍(`app.course.moveEarlier/moveLater`). 패널이 약 100px 길어진다(inventory D21/E7 '의도').
- 차이: 웹에 없는 조작 줄이 보인다.
- 중요도: P0
- 분류: 추가
- 고칠 방법:
  - **A(권장) 웹과 같게** — `OrderPicker.tsx:120-151` 의 보이는 줄을 지운다.
    - 끌기 대안은 이미 칩의 `accessibilityActions`(`:53-62` decrement/increment/delete)로 스크린리더에 남는다.
    - 손 조작은 웹처럼 ✕ 로 빼고 다시 담아 순서를 바꿀 수 있다(끌기 없는 대안 존재).
  - B: 웹에도 같은 줄 추가(끌기 대안을 눈에 보이게 — 웹 변경).
  - C: 현행 유지(의도 차이로 문서화).
- 바꿀 Expo 파일: `apps/mobile/features/course/components/OrderPicker.tsx`
- 문구(i18n): A 면 `app.course.moveEarlier`/`moveLater` 는 accessibilityActions 에서만 계속 쓴다(키 유지) / 새 키 없음
- 네이티브 주의: DraggableFlatList 길게 누르기(180ms)는 그대로 둔다.
- 확인 방법: `cap-interact.mjs builder` → i25.
- 크기: S · 의존: —
- 표시: 결정 필요

### G4b-20 첫 로딩 화면(전면 스켈레톤 + 내레이션)
- 화면·상태: 첫 `courses/plan` 응답 전(overlay `slow`, 20초 지연), 공유 모드 첫 로딩(facilities 15초 지연)
- 스크린샷: shots/G4b/s01-loading-early.pair.png, s02-loading-3s.pair.png, s03-loading-card.pair.png, h10-shared-loading.pair.png
- 웹(기준): `page.tsx:857-859,1918-1934` — 화면 전체를 교체한다.
  - 지도 자리: `h-[38dvh] bg-hanji-deep animate-pulse`. 지도·뒤로·공유 없음.
  - 시트: 둥근 모서리+그랩바가 보인다. `space-y-6` 안에 `components/LoadingReveal.tsx` 를 그린다.
  - ① `NarrationHeader :88-128`:
    - 카드: `rounded-2xl border border-gold/25 bg-white/90 px-5 py-5 shadow-[0_8px_30px_rgba(43,35,32,0.08)]` + 오른쪽 위 흐린 금빛 원.
    - 48px 핀: 맥동 고리 `border-2 border-gold/45`(scale .9→2·opacity .6→0, 2.1s), 44px `bg-gold/10` 원 + MapPin 22 gold-deep stroke 2.3.
    - 글자: 'NextSpot' 11px bold uppercase tracking-wide gold-deep, 제목 14px bold(`loadingReveal.course.title`).
    - 내레이션: 12px muk-soft, 1.2초마다 step1→2→3 에서 멈춘다(0.4s 페이드).
    - 진행 바: h-1.5 `bg-line` + `bg-gold`, 28초 곡선(0→46→68→76→94%).
  - ② `CourseBodySkeleton :217-249`: 블러 고스트(글자 0) 3칸 스텝 + 전폭 구분선 행 3.
  - 공유 모드는 `loadingReveal.shared.*`.
- Expo(현재):
  - `course.tsx:92-120` 지도를 그대로 그린다(사용자 점, level 6). 공유 모드면 공유 버튼까지 보인다(h10).
  - 시트 안 `CourseSections.tsx:272-295` CourseSkeleton: 제목 16px bold + 막대 2 + 104px 블록 + 행 3.
  - 'NEXTSPOT'·핀·내레이션·진행 바·블러가 없다.
  - `:283` keys `[0,1,mode==='course'?2:1]` 는 공유 모드에서 key 가 중복된다.
  - Expo web 은 첫 프레임에 지도가 가운데 작은 타일로 잠깐 그려진다(s01, 웹 빌드 한정).
- 차이: 로딩 구성 전체가 다르다(지도 유무, 내레이션·진행 바, 스켈레톤 모양).
- 중요도: P0
- 분류: 상태(로딩·빈·오류)
- 고칠 방법:
  1. 공용 `apps/mobile/components/ui/LoadingReveal.tsx`(variant `'waiting' | 'course' | 'shared'` — 대기 G5a 와 공유)를 만든다.
     - NarrationHeader 는 위 값 그대로. 맥동 고리는 Reanimated `withRepeat(withTiming)`, 문장은 1.2초 단계 + `FadeIn` translateY 4.
     - 진행 바 width 는 구간 애니메이션: 0→46%(1.12s)→68%(1.4s)→76%(1.96s)→94%(23.5s), easing `Easing.bezier(.25,.6,.35,1)`. `useReduceMotion` 이면 94% 에서 정지.
     - CourseBodySkeleton 은 블러 대신 opacity .45 도형 + 천천히 숨쉬기. 전폭 행은 `-mx-[16px] border-t border-line`.
  2. `course.tsx`: `firstLoad` 이면 지도·버튼 없이 `<View style={{height: Math.round(height*0.38)}} className="bg-hanji-deep" />`(opacity 펄스) + 시트(그랩바 + `gap-[24px]` + `<LoadingReveal variant={isShare ? 'shared' : 'course'} />`)를 그린다.
  3. `CourseSkeleton` 을 삭제한다.
- 바꿀 Expo 파일: `apps/mobile/components/ui/LoadingReveal.tsx`(새), `components/ui/index.ts`, `app/(tabs)/course.tsx`, `features/course/components/CourseSections.tsx`
- 문구(i18n): 재사용 `loadingReveal.course.title/step1/step2/step3`, `loadingReveal.shared.title/step1/step2/step3` / 새 키 없음('NextSpot' 은 웹도 고정 글자)
- 네이티브 주의: CSS blur 대체 — Android BlurView 는 비용이 커서 opacity 도형을 권한다. 지도 첫 프레임 깜빡임은 네이티브에 없다.
- 확인 방법: `cap-states.mjs loading` → s01·s02, `cap-shared.mjs sharedStates` → h10.
- 크기: L · 의존: G5a(LoadingReveal 공용), G4b-01
- 표시: 네이티브 확인 필요

### G4b-21 오류 카드 '다시 시도' 버튼
- 화면·상태: `courses/plan` 500, 공유 facilities 500
- 스크린샷: shots/G4b/s11-error-card.pair.png, s10-error.pair.png, h11-shared-error.pair.png
- 웹(기준): `apps/web/components/ErrorState.tsx:15-23`
  - 카드: `p-8 space-y-3 border-terracotta/25 shadow-[0_2px_14px_rgba(43,35,32,0.06)]`.
  - 버튼: `px-4 py-2 rounded-full bg-gold text-white text-xs font-bold` — 글자만, 측정 71×32.
- Expo(현재): `apps/mobile/components/ui/ErrorState.tsx:37-66`
  - 카드: padding 32, 그림자 없음.
  - 버튼: `min-h-[44px] gap-[6px] rounded-full bg-gold-deep px-[18px]` + `RotateCw` 14 + 13px bold, 측정 98.5×44.
- 차이: 버튼 색(밝은 금 vs 진한 금갈색)·회전 아이콘·높이 32 vs 44·글자 12 vs 13, 카드 그림자.
- 중요도: P1
- 분류: 색·효과 · 아이콘·이미지
- 고칠 방법:
  - A: `ui/ErrorState.tsx:50-66` → `rounded-full bg-gold px-[16px] py-[8px]`, 아이콘 제거, Text `text-[12px] leading-[16px]` bold white, `hitSlop={{top:6,bottom:6}}`. Card 에 `boxShadow: shadows.card`.
  - **B(권장, G4b-10 과 같은 결정)**: 웹 `ErrorState.tsx:20` `bg-gold` → `bg-gold-deep`(대비 2.6:1 → 6.8:1). Expo 는 아이콘 제거·높이(py 8)·12px·그림자만 맞춘다.
  - 공용 컴포넌트라 대안 화면 등 모든 사용처가 함께 바뀐다.
- 바꿀 Expo 파일: `apps/mobile/components/ui/ErrorState.tsx`
- 문구(i18n): 재사용 `common.retry`, `course.fetchError`, `course.sharedError` / 새 키 없음
- 네이티브 주의: hitSlop 으로 44pt 를 유지한다.
- 확인 방법: `cap-states.mjs err` → s11, `cap-shared.mjs sharedStates` → h11.
- 크기: S · 의존: G4b-10, G4a(대안 화면 ErrorState)
- 표시: 결정 필요

### G4b-22 빈·로그인 안내 카드 — 주 버튼 모양·카드 여백
- 화면·상태: 빈 코스(여행 시간 초과), 401 로그인 안내
- 스크린샷: shots/G4b/s30-empty-time-card.pair.png, s21-auth-card.pair.png
- 웹(기준):
  - 넓히기 `page.tsx:1977-1988`·지도에서 추천받기 `:2007-2012`: `cta-primary` **알약** `rounded-full min-h-11 px-5 text-[13px] font-bold shadow-[0_4px_14px_rgba(168,70,47,0.28)]`(`globals.css:321-324` 그라데이션 #8a6a1c→#a8462f), 측정 121.9×44.
  - 카드: `p-8`(32) + shadow card. 빈 카드 `space-y-2`, 로그인 카드 `space-y-3`.
- Expo(현재):
  - `CourseSections.tsx:236-240,264` 공용 `Button`: `components/ui/Button.tsx:71` `rounded-2xl`(16px 둥근 사각) px 16, `:87` 14px.
  - 카드 `p-[28px]`, 그림자 없음, gap 8·10.
- 차이: 버튼 모서리(알약 vs 둥근 사각)·글자 13 vs 14·좌우 여백 20 vs 16, 카드 여백 32 vs 28·그림자.
- 중요도: P1
- 분류: 배치 · 크기·간격
- 고칠 방법:
  1. `Button` 에 prop 두 개를 추가한다.
     - `shape?: 'pill'` → `rounded-full`.
     - `size?: 'sm'` → Text `text-[13px] leading-[19.5px]`, `px-[20px]`.
  2. `CourseSections.tsx:236-240,264` 에 `shape="pill" size="sm"`.
  3. 카드 `p-[32px]` + `boxShadow: shadows.card`, 빈 카드 gap 8, 로그인 카드 gap 12.
- 바꿀 Expo 파일: `apps/mobile/components/ui/Button.tsx`, `apps/mobile/features/course/components/CourseSections.tsx`
- 문구(i18n): 재사용 `course.widenTime`, `course.widenTimeNoLimit`, `course.authCta`, `course.authTitle`, `course.authBody` / 새 키 없음
- 네이티브 주의: 없음
- 확인 방법: `cap-states.mjs empty auth` → s30·s21.
- 크기: S · 의존: G4b-14
- 표시: —

### G4b-23 빈 상태 문구 키가 다름
- 화면·상태: 빈 코스 — `late_night_unconfirmed` 사유, 사유 없음
- 스크린샷: shots/G4b/s31-empty-reasons-card.pair.png, s32-empty-none-card.pair.png, h12-shared-empty.pair.png
- 웹(기준):
  - `page.tsx:1530` `course.slotLateNight` "가정 시간을 낮 시간대로 바꾸면 식당·카페 선택지가 넓어져요."
  - `:1991` `course.emptyBody` "종류를 하나 더 고르거나 가정 시간을 바꾸면 바로 코스를 만들어 드려요."
- Expo(현재):
  - `features/course/model.ts:105` `app.course.slotLateNight` "늦은 시간이라 영업 확인이 어려워요. 낮 시간대에 다시 찾으면 식당·카페 선택지가 넓어져요."
  - `CourseSections.tsx:244` `app.course.emptyBody` "종류를 하나 더 고르거나 도보 시간·여행 시간을 넓히면 바로 코스를 만들어 드려요."
- 차이: 같은 상태에서 문장이 다르다. Expo 는 없는 '가정 시간' 언급을 뺐다.
- 중요도: P1
- 분류: 문구
- 고칠 방법:
  - G4b-08 A(이식)면 `model.ts:105` → `course.slotLateNight`, `CourseSections.tsx:244` → `course.emptyBody` 로 바꾸고, `app.course.slotLateNight`/`app.course.emptyBody` 를 4로케일 JSON 에서 지운다.
  - B(가정 시간 없음)면 Expo 문구가 맞으니, 웹 문구를 같은 뜻으로 바꾸는 것이 일관이다(웹 변경).
- 바꿀 Expo 파일: `apps/mobile/features/course/model.ts`, `apps/mobile/features/course/components/CourseSections.tsx`, (삭제 시) `apps/web/lib/i18n/messages/{ko,en,ja,zh}.json` 의 `app.course.*` 2키
- 문구(i18n): 재사용 `course.slotLateNight`, `course.emptyBody` / 삭제 후보 `app.course.slotLateNight`, `app.course.emptyBody`(4로케일 동시)
- 네이티브 주의: 없음
- 확인 방법: `cap-states.mjs empty` → `empty-reasons-text`, `empty-none-text` 가 웹과 같은지.
- 크기: S · 의존: G4b-08
- 표시: 결정 필요

### G4b-24 공유 모드 배너 — 글자 크기·줄바꿈·CTA 역할
- 화면·상태: 공유 링크(`?s=`)로 들어온 코스(30분 전 공유)
- 스크린샷: shots/G4b/h02-shared-banner.pair.png, h01-shared-top.pair.png
- 웹(기준):
  - 배너: `page.tsx:1081` `flex items-center justify-between gap-3 rounded-2xl border border-gold/30 bg-gold/10 px-3.5 py-3`.
  - 문장: `:1082` `text-[11px] font-semibold text-gold-deep leading-snug` — 한 줄.
  - CTA: `:1087-1092` `<Link href="/course">` `shrink-0 min-h-11 px-3.5 rounded-full bg-white border border-gold/35 text-[11px] font-bold text-gold-deep`.
- Expo(현재):
  - 문장: `CourseSections.tsx:180-183` 12px leading 17 → 2줄. '공유됨'이 음절 단위로 끊긴다('공유|됨').
  - CTA: `:184-193` 12px, `max-w-[48%]`, role=button.
- 차이: 줄 수(1 vs 2)·글자 크기·CTA 역할(링크 vs 버튼).
- 중요도: P1
- 분류: 크기·간격 · 접근성
- 고칠 방법: 문장 `text-[11px] leading-[15px]`, CTA Text 11px, `max-w-[48%]` 제거 + `shrink-0`, CTA `accessibilityRole="link"`.
- 바꿀 Expo 파일: `apps/mobile/features/course/components/CourseSections.tsx`
- 문구(i18n): 재사용 `course.sharedBanner`, `course.sharedAgo`, `course.sharedCta` / 새 키 없음
- 네이티브 주의: Android 는 Text 가 U+2060 으로 낱말 단위 줄바꿈을 한다 — '공유|됨' 음절 끊김은 Expo web 한정일 수 있다.
- 확인 방법: `cap-shared.mjs shared` → h02.
- 크기: S · 의존: G4b-14
- 표시: 네이티브 확인 필요

### G4b-25 길안내 누른 뒤 흐름 — 웹은 현재 탭까지 이동(버그)
- 화면·상태: 정류지 행 '길안내'(자동차도 같음)
- 스크린샷: shots/G4b/h30-directions-toast.pair.png
- 웹(기준): `page.tsx:1669-1688` → `apps/web/lib/navigation.ts:17-30` `const opened = window.open(url, '_blank', 'noopener,noreferrer'); if (!opened) window.location.href = url;`
  - `noopener` 를 주면 `window.open` 은 규격상 항상 null 이다. 그래서 새 탭을 연 뒤 **현재 탭도 카카오맵으로 이동**한다.
  - h30 웹 쪽 URL = `map.kakao.com/link/map/…`, 코스 화면·토스트가 사라졌다. 정책 로그에 카카오 링크 GET 2회.
  - `recordActiveTrip`·토스트는 이동 직전에 실행된다.
- Expo(현재): `StopRows.tsx:209-230` → `lib/platform/links.ts` `openWalkingDirections` → expo-web-browser 새 탭. 코스 화면에 남아 토스트 '카카오맵에서 도보를 선택해 주세요.'(`trip.selectWalking`)를 띄운다.
- 차이: 웹은 앱 화면을 떠나고 Expo 는 머문다.
- 중요도: P0
- 분류: 동작
- 고칠 방법(**권장: 웹 버그 수정, Expo 는 그대로**):
  1. `apps/web/lib/navigation.ts:21-23`(및 `openDrivingDirections :27-29`)을 아래처럼 바꾼다.
     ```ts
     const w = window.open(url, '_blank');
     if (w) {
       try { w.opener = null; } catch { /* ignore */ }
     } else {
       window.location.href = url;
     }
     ```
  2. Expo 를 웹처럼 현재 탭 이동시키는 것은 권하지 않는다.
- 바꿀 Expo 파일: 없음(웹 `apps/web/lib/navigation.ts`)
- 문구(i18n): 재사용 `trip.selectWalking`, `trip.driveBasisHint` / 새 키 없음
- 네이티브 주의: 네이티브는 카카오맵 앱/인앱 브라우저로 넘어가 화면을 떠나는 것이 정상이다.
- 확인 방법: `cap-shared.mjs nav` — 웹 `p.web.url()` 이 `/course` 그대로이고 토스트가 보이는지.
- 크기: S · 의존: G3(홈 '바로 갈래요' 등 같은 함수 사용처)
- 표시: 결정 필요

### G4b-26 토스트 모양·위치(재계획·위치·공유·길안내)
- 화면·상태: 재계획(핀·칩·순서), 위치 권한 없음, 공유, 길안내
- 스크린샷: shots/G4b/i24-replan-toast.pair.png, s50-location-fallback.pair.png, h21-share-click.pair.png, h30-directions-toast.pair.png
- 웹(기준): `apps/web/components/shell/ThemeToaster.tsx:16-29` sonner 전역.
  - 위치: 휴대폰 기본 아래 16px — 하단 탭 위를 덮는다.
  - 글꼴: sonner 기본 시스템 글꼴(Freesentation 아님, 자간 넓음).
  - 아이콘: richColors(info 검은 원 i · error 검은 !), `toast()`(재계획 `page.tsx:470`)는 아이콘 없음.
- Expo(현재): `apps/mobile/components/ui/Toast.tsx:22-48` sonner-native.
  - 위치: 탭 막대 위 64px.
  - 글꼴: Freesentation SemiBold 14px.
  - 아이콘: info 파란 원 i·success 초록 체크, 기본 `toast()` 에도 아이콘.
- 차이: 위치·글꼴·아이콘이 다르다. 문구·id(`course-replan`)는 같다. 코스 화면 고유 차이는 공유 실패 토스트 지속시간(G4b-03).
- 중요도: P1
- 분류: 색·효과 · 배치
- 고칠 방법:
  - 전역 Toaster 정렬은 G2 담당이다(웹 sonner 글꼴을 Freesentation 으로 할지, Expo 위치·아이콘을 웹에 맞출지).
  - 코스 화면 쪽은 G4b-03 의 `duration: 10000` 만.
- 바꿀 Expo 파일: (G2) `apps/mobile/components/ui/Toast.tsx` / 코스: `app/(tabs)/course.tsx:86`
- 문구(i18n): 재사용 `course.replanSame` 외 재계획 키, `map.locationFallback`, `common.linkCopied`, `common.shareFailed`, `trip.selectWalking` / 새 키 없음
- 네이티브 주의: 토스트 위치는 탭 막대 높이(iOS 49·Android 56) 기준이다.
- 확인 방법: `cap-interact.mjs builder`(i24), `cap-states.mjs geo`(s50).
- 크기: S(코스 부분) · 의존: G2
- 표시: —

### G4b-27 화면을 떠났다 돌아올 때 상태 유지(Expo) vs 초기화(웹)
- 화면·상태: 시간표 선택 + 코스 직접 짜기 열기 → 홈 탭 → 분산 코스 탭
- 스크린샷: shots/G4b/x02-revisit.pair.png
- 웹(기준): 하단 탭 이동이 라우트 이동이라 `/course` 가 새로 마운트된다.
  - 목록 보기·직접 짜기 닫힘·순서/종류/고정 비움·스크롤 맨 위(`page.tsx:269-292` 초기값).
  - 캐시 계획을 즉시 그리고 백그라운드로 재요청한다(`:415-449`, `:615-627`).
- Expo(현재): 탭 화면이 살아 있어 시간표·직접 짜기 열림·순서/고정·스크롤 위치가 그대로다(x02). 재요청은 `features/course/refreshPolicy.ts`(조건 변경 또는 10분) 때만.
- 차이: 돌아왔을 때 화면 상태가 다르다.
- 중요도: P1
- 분류: 동작
- 고칠 방법(웹과 같게):
  1. `course.tsx` 에 `useFocusEffect(useCallback(() => () => { setViewMode('cards'); setBuilderOpen(false); scrollRef.current?.scrollTo({ y: 0, animated: false }); plan.resetInputs(); }, []))`.
  2. `useCoursePlan` 에 `resetInputs()`(sequence·selectedTypes·pins 비움).
  3. 포커스마다 조용한 새로고침(웹 리마운트와 같게). `refreshPolicy` 의 10분 규칙을 없앨지는 서버 부하와 함께 결정한다.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/course.tsx`, `features/course/useCoursePlan.ts`, `features/course/refreshPolicy.ts`
- 문구(i18n): 없음
- 네이티브 주의: 앱 관례상 탭 상태 유지가 자연스러울 수 있다 — 결정 사항.
- 확인 방법: `cap-extra.mjs revisit` → Expo `ganttSelected` false·`builderOpen` 0.
- 크기: S · 의존: G4b-01(scrollRef)
- 표시: 결정 필요

### G4b-28 세션이 없을 때(익명 세션 미생성)
- 화면·상태: 저장된 Supabase 세션 없음
- 스크린샷: 없음(촬영 못 함 — `state: 'none'` 금지)
- 웹(기준): `page.tsx:323-351` 세션이 없으면 2.5초 기다린 뒤 데모 방문자 `MOCK_VISITOR_ID`(`:62`)로 요청한다. 세션이 승격되면 실제 id, 서버 401 이면 `AuthState`.
- Expo(현재): `features/course/api.ts:18-23` `currentUserId()` → `ensureAnonymousSession()` 실패 시 즉시 `AuthError` → `AuthState`(`CourseSections.tsx:253-267`). 로그인 이벤트에 자가 회복한다(`useCoursePlan.ts:215-224`).
- 차이: 웹은 2.5초 유예 + 데모 id 요청, Expo 는 즉시 안내.
- 중요도: P2
- 분류: 동작
- 고칠 방법:
  - 같게 하려면 `useCoursePlan` 에서 AuthError 가 세션 없음 때문이면 2.5초 기다렸다가 `needsAuth` 를 켠다(그 사이 SIGNED_IN 이면 그대로 진행).
  - 웹의 데모 방문자 요청은 운영에서 의미가 없어 웹 쪽 제거가 더 나을 수 있다(결정).
- 바꿀 Expo 파일: `apps/mobile/features/course/useCoursePlan.ts`
- 문구(i18n): 재사용 `course.authTitle`, `course.authBody`, `course.authCta` / 새 키 없음
- 네이티브 주의: 없음
- 확인 방법: 첫 실행 담당(G1)의 `state: 'first-run'`/새 설치 컨텍스트에서만 재현 가능.
- 크기: S · 의존: —
- 표시: 촬영 못 함, 결정 필요

### G4b-29 접근성 의미 구조
- 화면·상태: 화면 전반(스크린리더)
- 스크린샷: 없음(DOM·코드 비교, `work/G4b/default-plan1-plan3.json`)
- 웹(기준):
  - 정류지 이름 `<h3>`(`page.tsx:1706`), 순서 피커 제목 `<h2>`(`:1186,1254`).
  - 스텝퍼 `<ol aria-label="코스 순서 미리보기">`(`:1103-1106`), 탭리스트 `aria-label={t('course.title')}`(`:1291`).
  - 펼침 버튼 `aria-expanded`+`aria-controls`(`:1789,1800,1847,1025-1026`), 고정·종류 필터 `aria-pressed`(`:1858,1265`).
  - 공유 배너 CTA 링크(`:1087`), 지도는 라벨 없음(`CourseMap.tsx:239` `aria-hidden={!ready}`).
- Expo(현재):
  - 정류지 이름·피커 제목이 일반 Text 다(heading 아님, probe `rowName1` div).
  - 스텝퍼에 role 이 없고, **같은 라벨 '코스 순서 미리보기'가 지도 래퍼에도** 붙어 있다(`CourseMapView.tsx:71`, `course.tsx:97`) → 같은 이름이 2개.
  - tablist 라벨 없음(`CourseSections.tsx:68`), aria-controls 없음.
  - 고정·필터는 `selected`(aria-selected), 배너 CTA 는 role=button.
- 차이: 제목 단계·목록·컨트롤 관계·상태 속성.
- 중요도: P2
- 분류: 접근성
- 고칠 방법:
  1. `CourseMapView.tsx:71` 의 `accessible`/`accessibilityLabel` 을 지운다(웹처럼 장식). `course.tsx:97` 의 prop 도 정리한다.
  2. 스텝퍼 View `accessibilityRole="list"`.
  3. 정류지 이름 줄 `accessibilityRole="header"` + `aria-level={3}`, 피커 제목 `aria-level={2}`.
  4. ViewToggle 컨테이너 `accessibilityLabel={t('course.title')}`.
  5. 고정 버튼 `accessibilityState={{ checked: pinned }}`(aria-pressed 에 가장 가까움), 필터 Chip 도 checked.
  6. 배너 CTA `accessibilityRole="link"`(G4b-24).
- 바꿀 Expo 파일: `features/course/components/CourseMapView.tsx`, `CourseSections.tsx`, `StopRows.tsx`, `OrderPicker.tsx`, `app/(tabs)/course.tsx`, (선택) `components/ui/Chip.tsx`
- 문구(i18n): 재사용 `course.title`, `course.stepperAria` / 새 키 없음
- 네이티브 주의: `aria-level` 은 iOS/Android 에서 제목 단계로 읽히지 않을 수 있다(웹 빌드만 확실).
- 확인 방법: Playwright `getByRole('heading', { level: 3 })` 가 Expo 에서도 정류지 수만큼 잡히는지, `getByLabel('코스 순서 미리보기')` 가 1건인지.
- 크기: S · 의존: G4b-11, G4b-24
- 표시: —

---

## 촬영 못 한 상태(코드로 비교)

- **세션 없음(익명 세션 미생성)** — `state: 'none'` 금지라 G4b-28 에서 코드로 비교했다.
- **실제 공유 시트·클립보드 성공** — 헤드리스 Chromium 에는 `navigator.share` 가 없고 클립보드 권한도 거부된다. 그래서 웹은 실패 토스트, Expo web 은 expo-clipboard 성공으로 갈렸다. 폰 동작은 코드 기준(G4b-03).
- **대안 '여기로 바꾸기'·핀으로 바뀐 계획** — fixture 가 요청과 무관하게 같은 계획을 돌려줘, 교체 결과는 '같은 계획 + replanSame 토스트'로만 확인했다. 판정은 두 앱 공용 `@/lib/coursePlanDiff` 다. replanChanged/Reordered/Removed/Swapped 문구는 촬영하지 못했다.
- **40자 이상 긴 이름** — 오버레이를 실제 시설 행으로만 만들어 긴 이름이 없다.
  - 코드상 웹은 `line-clamp-2 break-words`(`page.tsx:1138,1713`)·간트 `truncate`(`:1371`), Expo 는 `numberOfLines` 2/1.
  - 줄 수는 같고 줄바꿈 단위만 다르다(G2 keep-all).
- **구 API 폴백(404 → `/courses/recommend`)** — 공유 fixture `courses-recommend` 를 녹화하지 않았다. 두 앱이 같은 로직이다(`page.tsx:548-554` ↔ `features/course/api.ts:44-55`).
- **서비스 지역 밖 위치** — 촬영하지 않았다. 두 앱 모두 조용히 중심으로 바꾼다(`page.tsx:359-362` ↔ `useCourseLocation.ts:22-24`).
- **안드로이드 네이티브 화면 전부** — Expo web 만 비교했다.

## 열린 질문

1. 웹 지도가 시트 윗부분(그랩바·둥근 모서리)을 가리는 것이 의도인가?
   - 맞출 기준을 '렌더 결과'(A)로 할지 '의도'(B)로 할지 정해야 한다(G4b-01).
   - B 면 지도 로고 가림 대책이 필요하다.
2. 웹 토글·다시 시도 버튼(흰 글자 on 금 #c19a3e, 2.6:1)을 웹에서 gold-deep 으로 고칠지(G4b-10·21).
3. 가정 시간 프리셋을 앱에 넣을지 — 대기(G5a)·홈 예측 띠(G2)와 한 번에 결정해야 한다(G4b-08·23).
4. Expo 전용 앞/뒤 옮기기 줄을 지울지(G4b-19), 탭 재진입 시 상태를 초기화할지(G4b-27).
5. 카카오·구글 지도 로고를 시트가 가리는 지금 Expo 배치가 약관상 괜찮은지(G4b-01).
6. Expo web 첫 프레임의 작은 지도 깜빡임(s01)이 NextSpotMap.web 초기 크기 계산 문제인지. 네이티브에는 없을 것으로 보인다.

## 다른 묶음으로 넘길 것

- **G2**
  - Text 기본 줄 높이: 웹 상속 1.5 vs RN normal 이라 칩·라벨이 4px 낮다(G4b-07·14 의 뿌리).
  - Expo web 한국어 줄바꿈: keep-all 이 없어 음절 단위로 끊긴다('공유|됨', '드려|요.').
  - 전역 토스트: 웹 sonner 시스템 글꼴·아래 16px·아이콘 규칙 vs sonner-native(G4b-26).
  - 하단 탭: 웹 약 105px 유리 막대 + 안내·콘솔 줄 vs Expo 약 49px 한지 막대. 코스 화면 아래쪽 모양이 다르다.
  - NextSpotMap 공용 변경 2건: 코스용 사용자 점 크기(`pins.ts` USER_DOT.plain, G4b-04), 지도 실패 콜백(G4b-05).
- **G3**
  - 웹 `lib/navigation.ts` noopener 버그(현재 탭 이동)가 홈 길안내에도 있는지(G4b-25).
- **G3·G4a·G5a**
  - 사진 없는 장소 표지(PlacePhotoFallback)를 공용 RN 컴포넌트로(G4b-12).
- **G4a**
  - 공용 ErrorState 버튼(대안 화면 포함)(G4b-21).
- **G5a**
  - LoadingReveal(waiting)·NowChip·가정 시간 컨트롤 공용화(G4b-06·08·20).
