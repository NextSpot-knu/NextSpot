# 검토 R1 — G1·G2

검토 방법:
- 쌍 사진을 직접 봤다. G1 15장, G2 25장, `_smoke/home`.
- 하네스로 2회 더 찍었다. HEAD export, `state:'saved'`, 새 게스트 0, 쓰기 0.
- 코드는 렌즈가 다른 검증 에이전트 2개가 줄 단위로 대조했다. 대상은 G1·G2 P0 전부와 P1 대부분이다.
- 결론을 바꾸는 주장은 내가 코드로 다시 확인했다. 해당 주장: ModalSheet 원인, 게이트가 `/intro?view=landing` 을 되돌림, `+html.tsx` 미사용, 사이드 사전 로드, Provider 순서, 웹 활성 탭 누름 무시, 로그인 광원 위치, `featureShortcuts` 의 `window` 사용.

## 1. 빠진 차이 (새 항목)

### G2-R01 공지 배너가 Expo 에서 검색창을 통째로 가린다
- 화면·상태: G2-NTC-01. 공지가 있고 아직 닫지 않은 상태.
- 스크린샷:
  - `shots/G2/notice-banner-top.pair.png`(G2 촬영)
  - `shots/R1/notice-vs-search.pair.png`(HEAD export 재촬영)
  - 측정 `shots/R1/_r1-checks.json`
- 웹(기준):
  - 배너는 `fixed top-[safe+0.5rem] z-[75]` 이다(`W:components/shell/PublicSettingsProvider.tsx:101-127`).
  - 2줄 공지에서 글 상자 y 19–52, 판 약 8–63.
  - 가리는 것은 상단 묶음뿐이다(언어 알약 y8 · 시계 y8 · 출처 y44).
  - 검색 입력은 y 69 에서 시작해 그대로 쓸 수 있다.
- Expo(현재):
  - `M:lib/core/publicSettings.tsx:127-169` NoticeBanner, `absolute top insets.top+8`.
  - 같은 공지에서 글 상자 y 19–53.
  - 검색 입력은 y 10–54 다(`M:features/home/HomeScreen.tsx:655-672`). 검색창 전체가 배너 밑에 깔려, 닫기 전에는 검색할 수 없다.
- 차이: 가리는 대상(상단 묶음 vs 검색창)과 기능(검색 불가).
- 중요도: P1
- 분류: 배치 · 동작
- 고칠 방법:
  1. G2-10(상단 묶음, 홈 머리 시작 `insets.top+68`)을 넣으면 배너가 웹처럼 상단 묶음만 덮는다. 따로 코드는 없고 G2-10 PR 에서 확인한다.
  2. G2-10 을 미루거나 빼기로 하면 다음과 같이 한다.
     - 배너가 떠 있는 동안 홈 머리 바깥 View(`HomeScreen.tsx:648-653`)의 `paddingTop` 을 `insets.top + 8 + 배너높이 + 8` 로 한다.
     - 배너 높이는 G2-33 의 새 `AppNoticeBanner` 에서 `onLayout` 으로 잰다.
     - 잰 값은 작은 컨텍스트(`useNoticeInset()`)로 홈에 넘긴다. 배너를 닫으면 0.
  3. 3줄 이상 긴 공지는 웹도 검색창과 겹친다. 그대로 둔다.
- 바꿀 Expo 파일: (1) 없음 / (2) `M:features/home/HomeScreen.tsx`, 새 `M:components/AppNoticeBanner.tsx`(G2-33)
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드도 같은 배치(absolute top + 상태 표시줄 inset)다.
- 확인 방법: `node scratch/parity/overlays/R1/r1-checks.mjs` 를 돌려 `_r1-checks.json` 에서 Expo 도 `notice.y + notice.h ≤ searchInput.y` 인지 본다(웹은 52 ≤ 69).
- 크기·의존: S · G2-10, G2-33
- 표시: —

### G2-R02 하단 탭 글자 아랫부분이 잘린다 — en 'My'→'Mv', ja·zh 대체 글꼴 글자
- 화면·상태: G2-NAV-01·02, 로케일 en·ja·zh
- 스크린샷:
  - `shots/G2/locale-ja-nav.pair.png`
  - `shots/R1/locale-zh-nav.pair.png`
  - `shots/R1/locale-en-nav.pair.png`
  - 측정 `shots/R1/_r1-locale-nav.json`
- 웹(기준): `W:components/shell/BottomNav.tsx:179-212`. 글자 11px/16.5, 대기 탭은 10px/15. 실측 글자 상자 높이 16.5px, 어느 로케일도 잘리지 않는다.
- Expo(현재):
  - `M:app/(tabs)/_layout.tsx:54-69` 이 탭 글자를 RN `Text` 로 그린다(`numberOfLines={1}`, fontSize 11, lineHeight 없음).
  - Expo web 실측 글자 상자 높이는 10px(11px Freesentation 의 'normal' 줄높이)이고, 한 줄 자르기(overflow hidden)가 걸린다.
  - 그래서 잘린다: en 'My' 의 y 꼬리, zh 활성 '首页', ja 'ホーム·今出発なら?·コース·マイ' 아래 절반.
  - Freesentation 에 없는 가나·한자는 더 큰 대체 글꼴로 그려진다. ko 는 한글이 10px 안에 들어가 드러나지 않을 뿐이다.
- 차이: 4개 중 3개 로케일에서 탭 이름이 읽기 어렵다.
- 중요도: P1
- 분류: 글꼴 · 크기·간격
- 고칠 방법:
  1. G2-G01 의 새 `TouristTabBar` 글자는 앱 `Text` 로 그린다.
     - 스타일 `style={{ fontSize: 11, lineHeight: 16.5 }}`.
     - 대기 탭은 `fontSize: 10, lineHeight: 15, letterSpacing: -0.25`.
     - `numberOfLines={1}` 과 `maxFontSizeMultiplier={1.2}`(`_layout.tsx:26`)는 유지한다.
  2. G2-G01 이 늦어지면 임시로 지금 `tabBarLabel` 의 RNText 스타일(`_layout.tsx:58-64`)에 `lineHeight: 16.5` 를 더한다. 다시 찍어도 잘리면 `tabBarStyle.height` 를 늘린다.
  3. ja·zh 글꼴은 G2-G04 와 함께 맞춘다.
  4. `numberOfLines` + arbitrary 크기 + 줄높이 없음 조합은 다른 화면에도 같은 잘림을 낼 수 있다. G2-G05(기본 줄높이)를 먼저 넣는 이유가 하나 더 생긴다.
- 바꿀 Expo 파일: `M:components/navigation/TouristTabBar.tsx`(G2-G01), 임시로는 `M:app/(tabs)/_layout.tsx`
- 문구(i18n): 재사용 `nav.*` / 새 키 없음
- 네이티브 주의: 안드로이드 TextView 는 글꼴 여백(includeFontPadding) 덕에 꼬리가 들어갈 가능성이 높다. 실기기에서 en·ja 를 확인한다.
- 확인 방법:
  - zh·en: `node scratch/parity/overlays/R1/r1-locale-nav.mjs`
  - ja: `work/G2/10-locale.mjs`
  - 측정 JSON 에서 Expo 탭 글자 `h ≥ 15` 인지, 쌍 사진에 잘림이 없는지 본다.
- 크기·의존: S · G2-G01, G2-G04, G2-G05
- 표시: 네이티브 확인 필요

### G2-R03 Expo web 글꼴에 대체 글꼴 목록이 없다 — TTF 로드 실패 시 명조(serif)
- 화면·상태: 모든 화면(Expo web 빌드)
- 스크린샷:
  - 없음. G1 이 EAS 429 순간에 serif 로 찍힌 2장(SET-06·GATE-01)을 다시 찍어 바꿨다(findings-G1 '촬영 주의').
  - 실측: `_r1-locale-nav.json` 의 Expo font-family 가 `Freesentation-5Medium` 하나뿐이다.
- 웹(기준): `W:app/globals.css:122` `--font-sans: 'Freesentation', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif`.
- Expo(현재): `M:components/ui/Text.tsx:71` 이 `fontFamily: fontFamilies[resolved]` 하나만 준다. 실패하면 브라우저 기본 serif 로 그린다. 네이티브는 글꼴이 앱에 묶여 있어 해당 없다.
- 차이: 글꼴이 늦거나 실패하면 웹은 고딕, Expo web 은 명조로 그린다.
- 중요도: P2
- 분류: 글꼴
- 고칠 방법:
  - `Text.tsx` 에서 `Platform.OS === 'web'` 일 때만 ``fontFamily: `${fontFamilies[resolved]}, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif` `` 를 준다.
  - ja·zh 목록(G2-G04)도 같은 자리에서 만든다.
  - RN `Text`/`TextInput` 을 직접 쓰는 곳(탭 막대, `HomeScreen.tsx:667`)은 G2-G04 의 `fontStyleFor` 헬퍼를 쓴다.
- 바꿀 Expo 파일: `M:components/ui/Text.tsx`(+G2-G04 헬퍼)
- 문구(i18n): 없음
- 네이티브 주의: 네이티브에 목록 문자열을 주면 안 된다. 웹 분기에서만 준다.
- 확인 방법: 하네스에서 `**/Freesentation*.ttf` 를 abort 한 뒤 home·login 쌍을 찍어 고딕인지 본다.
- 크기·의존: S · G2-G04 와 같은 PR
- 표시: —

## 2. 바로잡을 것 (기존 항목 정정)

### G1

- **G1-01(P0)**
  - 문제:
    1. 인용 `FirstRunGate.tsx:243-256` 은 없는 줄이다(파일 70줄). 실제 위치:
       - 게이트 이동 `M:features/onboarding/FirstRunGate.tsx:57-66`(replace :65)
       - 판정 훅 `:38-55`
       - 탭 쪽 `<Redirect>` `M:app/(tabs)/_layout.tsx:28-40`
    2. "모든 경로를 /intro 로"는 틀렸다. 소개·동의 단계일 때만 `/intro`, 설정 단계는 `/setup` 이다(`firstRunCore.ts:60-64`).
    3. A(b) 의 근거가 틀렸다.
       - 소개→로그인을 push 로 하면 스택이 [intro, login] 이 된다.
       - 로그인 성공 `router.replace`(`login.tsx:72`)는 맨 위만 바꾼다. 스택은 [intro, (tabs)] 가 되고, 탭 게이트가 /intro 를 또 얹는다. `intro.tsx:60-62` 주석이 막으려던 바로 그 상황이다.
       - 게스트는 `canGoBack()` 이 참이 되어 `:141-143` 의 back() 으로 소개에 돌아간다.
       - `toLogin` 이 먼저 `markIntroSeen()`(`intro.tsx:64`)을 부른다. 그래서 소개가 구독(`:38-41`)으로 동의 단계로 바뀌고, '뒤로 = 랜딩'이 되지 않는다.
    4. A(a) 의 루트 Pressable 은 RN 기본값 `accessible=true` 라 랜딩 전체가 버튼 하나로 읽힌다.
  - → A 를 이렇게 바꾼다.
    - (a) `Screen scroll` 의 자식(스크롤 내용 안)에 `Pressable noFeedback accessible={false} onPress={start}` 를 두고 랜딩을 그 안에 그린다. ScrollView 바깥은 감싸지 않는다.
    - (b) `toLogin` 에서 `markIntroSeen()` 을 빼고 `router.push('/login')` 만 한다. 로그인 화면은 이렇게 바꾼다.
      - 로그인 성공(`afterAuth`): `if (getFirstRunStep() === 'intro') markIntroSeen();` → `if (router.canDismiss()) router.dismissAll();` → `router.replace(dest)`. `dismissAll` 은 expo-router 57 에 있다.
      - 게스트(`continueAsGuest`): 맨 앞에 `if (getFirstRunStep() !== null) { markIntroSeen(); if (router.canDismiss()) router.dismissAll(); router.replace(nextFirstRunRoute()); return; }` 를 넣는다. `getFirstRunStep`·`markIntroSeen`·`nextFirstRunRoute` 는 모두 `~/features/onboarding/firstRun` 에 있다.
      - 안드로이드 뒤로(로그인 화면) = 소개 랜딩. 웹 브라우저 뒤로와 같다.
    - (c) (b) 가 부담이면 지금 replace 를 유지하고 '첫 실행 중 로그인에서 뒤로 = 앱 종료'를 차이로 기록한다. 결정 표시는 그대로 둔다.
    - 에뮬레이터에서 두 흐름을 확인한다: 소개→로그인→뒤로→소개 / 소개→로그인→게스트→동의→설정→홈→뒤로=종료.
- **G1-02(P0)**
  - 바탕 붙이는 법이 빠졌다. `Screen` 바깥 View 가 `bg-hanji` 를 칠한다(`Screen.tsx:43,55`). 그래서 뒤에 둔 배경은 안 보이고, 안에 넣으면 640 폭 제한을 받고 스크롤과 함께 움직인다. → 구조를 `<View className="flex-1 bg-hanji"><LandingBackdrop/><Screen scroll className="bg-transparent" …>` 로 바꾼다.
  - 토큰 값을 고친다. `landing-sunset-end` 는 `#f6dac8` 이다(tokens.test.ts 의 mix 반올림 기준). `#f6dac7` 이면 단언이 실패한다.
  - 배지 굵기: `EmojiLine` 의 weight 타입이 'medium'|'semibold' 뿐이다(`GuideSections.tsx:37`). 'bold' 를 받게 넓힌다. gap 은 공용 값을 바꾸지 말고 prop 으로 준다.
  - 바꿀 파일에 `M:features/onboarding/index.ts:13`(GuideHero export)를 더한다.
  - 능선: 경로마다 `fillOpacity` 0.08/0.08/0.13/0.13 도 옮긴다(`W:app/page.tsx:233-236`).
  - 광원: 300 원 안에서 0.15→0 으로 그리면 웹보다 훨씬 작다. → 3절 '광원 규칙'을 쓴다.
  - 로고 `expo-image` 는 기본이 `accessible=false` 다. `accessible accessibilityRole="header" accessibilityLabel="NextSpot"` 를 준다.
  - '바로 시작'에 `accessibilityRole="button"` 을 준다. 웹은 `min-h-[52px] px-10` 이고 세로 여백이 없다. G1-20 의 hero(py 14 + 17px/25.5)는 53.5 가 된다. → 3절 Button `size={52}` 를 쓴다.
- **G1-04(P1)**
  - 같은 이름 `M:features/mypage/components/LanguageSwitcher.tsx`(칩 줄, `app/mypage/settings.tsx:27,128`)가 이미 있다. → 3절 'LanguageSwitcher 하나'로 합친다.
  - `ModalSheet` 필수 prop `handleLabel`·`closeLabel`(`Sheet.tsx:285-297`)이 빠졌다.
  - 안내 모달(G1-08, RN `Modal`) 안에서 연 ModalSheet 는 루트 `BottomSheetModalProvider` 로 그려져 Modal 창 **뒤**에 깔린다. 안드로이드는 Modal 안 제스처에 `GestureHandlerRootView` 도 필요하다.
    - → GuideModal 내용 루트를 `<GestureHandlerRootView style={{flex:1}}><BottomSheetModalProvider>…` 로 감싼다.
    - Modal `onRequestClose` 에서 목록이 열려 있으면 목록부터 닫는다.
  - Expo web 에서는 G2-G07 수정이 먼저다.
- **G1-05(P1)**
  - FestivalChip 시트는 `location: Point` 와 `onFocus` 가 필수다(`ToolChips.tsx:157,170-174,257-259`). 랜딩은 동의 전이라 둘 다 없다.
  - → 추출한 `FestivalSheet` 에서 둘을 선택 prop 으로 바꾼다(웹 `FestivalBanner({onFocus?, location?})`, `canFocus` `W:components/main/FestivalBanner.tsx:155-160,314`). 없으면 거리와 '지도에서 보기'를 숨긴다.
  - 배너를 보일지는 `festivalTriggerVisible('banner', events)`(`@/lib/festivalBanner`)로 정한다.
  - `toHttpsImageUrl` 은 ToolChips 가 아니라 `M:lib/platform/images.ts` 에 있다.
- **G1-06(P1, 작음)**
  - 밑줄 색 지정이 안드로이드에서는 무시된다(`textDecorationColor` no-op). 1px View 로 그리거나 차이로 받아들인다(G1-18 과 같다).
  - 가로-세로 중첩에는 `nestedScrollEnabled` 가 필요 없다(있어도 무해).
- **G1-07(P1, 작음)**: 콘솔을 웹으로 열 때 `WebBrowser` 를 직접 부르지 말고 `openExternalUrl()`(`M:lib/platform/links.ts:26-35`)을 쓴다.
- **G1-08(P0)**
  - 머리의 안쪽 Text `ml-[8px]` 는 iOS·안드로이드에서 무시된다(겹친 Text 의 margin). → `flex-row gap-[8px]` 에 Text 둘을 둔다.
  - CTA '첫 실행이면 소개의 start()' 는 공급자에서 소개 화면의 함수에 닿을 수 없다. → `markIntroSeen()`(`firstRun.ts:58-61`) 후 모달을 닫는다. 그러면 소개가 구독으로 동의 단계로 바뀐다. 첫 실행이 아니면 `router.push('/setup')`.
  - 4번(닫기 모드 제거)은 G1-15 의 `view=landing` 분기 **뒤**에 둔다(3절 '서비스 소개 진입').
  - 안드로이드는 edge-to-edge 라 아래 inset 도 비운다. heroTitle 줄높이 1.08× 는 글자 위가 잘릴 수 있으니 실기기에서 확인한다.
  - 언어 시트가 모달 뒤로 깔리는 문제는 G1-04 대로 고친다.
- **G1-09(P1)**: `@/lib/featureShortcuts` 를 그대로 쓰면 `check:shared` 에 걸린다(`window`·`new CustomEvent`, `W:lib/featureShortcuts.ts:46-51`). → 경로·라벨 키 목록만 `M:features/onboarding/featureShortcuts.ts` 로 복사하고 `PORTING.md` 에 출처를 적는다.
- **G1-11(P1, 작음)**: `Icon` 에는 className·style 이 없다. `mt-[3px]` 는 `<View className="mt-[3px]">` 로 감싸서 준다.
- **G1-14(P0, 작음)**
  - C 를 고르면 `features/onboarding/firstRun.test.ts`(동의 단계 단언)도 고친다.
  - C 는 G2-32 ① 과 함께 고를 수 없다(3절 '위치 동의').
- **G1-15(P1, 큼)**
  - 문제:
    - 첫 실행(설정 단계)에서 `router.replace('/intro?view=landing')` 을 하면 곧바로 되돌려진다. `decideFirstRunRedirect('setup','/intro')` 가 `/setup` 을 돌려주고(`firstRunCore.ts:73-80`, `firstRun.test.ts:58`), 게이트가 replace 하며, 게이트는 쿼리를 보지 않는다.
    - 첫 실행 스택은 [setup] 하나라 안드로이드 뒤로 = 앱 종료다.
  - → 고칠 방법:
    1. `pt-[32px]` 와 '뒤로 버튼 늘 그리기'는 유지한다.
    2. 버튼: `canGoBack()` 이면 `back()`, 아니면 `router.replace('/intro?view=landing')`.
    3. 게이트 예외를 둔다.
       - `decideFirstRunRedirect(step, pathname, view?)` 에 `step === 'setup' && path === '/intro' && view === 'landing'` 이면 `null` 을 더한다.
       - `useFirstRunGate` 는 `useGlobalSearchParams()` 의 `view` 를 넘긴다.
       - `firstRun.test.ts` 에 케이스를 추가한다.
    4. `intro.tsx` 의 `params.view === 'landing'` 분기는 맨 앞(consentOnly·단계 분기보다 먼저)에 둔다. 랜딩 '바로 시작' → `router.replace(nextFirstRunRoute())`.
    5. 첫 실행 중이고 `!router.canGoBack()` 이면, 설정 화면의 `BackHandler` 가 2번과 같은 동작을 하고 true 를 돌려준다.
- **G1-17(P1)**
  - `pb-[108px]` 는 `paddingBottom: 108 + insets.bottom` 이어야 한다(설정 Screen 이 아래 inset 을 빼 둔다, `setup.tsx:68`).
  - 저장 중에도 그림자가 남아야 한다(웹). 지금 Button 은 비활성이면 그림자를 지운다(`Button.tsx:77`). → 3절 Button 의 `shadow` 명시값을 쓴다.
- **G1-20(P1, 큼)**
  - 문제:
    1. "늘 44"는 7행 중 2행에서 틀렸다. 랜딩 '바로 시작'(`intro.tsx:107`)과 설정 '시작하기'(`setup.tsx:197`)는 이미 `className="min-h-[52px]"` 로 52다(실측 350×52). −8 차이는 로그인·재설정 제출뿐이다.
    2. 화면별 처방 `className="min-h-[46px]"`·`"min-h-[48px] px-[24px]"` 는 Button 기본 `min-h-[44px] px-[16px]`(`Button.tsx:71`)와 같은 속성 클래스를 겹친다. 이 항목이 인용한 UI 규칙 4 위반이고, `style` 도 막혀 있다(`Button.tsx:15`).
    3. 콜백 처방 "size=lg 높이만 48"은 lg=52 와 모순이다.
    4. hero 는 53.5px 가 된다.
    5. 대비 "약 3.7:1"은 틀렸다. 흰 글자/#c19a3e 는 **2.64:1** 이다(`ErrorState.tsx:28` 주석도 틀림). 금 진 6.78, cta 양끝 5.05·5.86.
  - → 고칠 방법을 3절 'Button API 하나'로 바꾼다. G1 화면별 값은 그 안의 표에 있다.
- **G1-21(P1)**
  - 끝색 `auth-sunset-end` 는 `#f6dfcf` 다.
  - 광원 중심은 (50%, **33% + 140px**) 다. 웹 `top-1/3 left-1/2 -translate-x-1/2`(`W:app/login/page.tsx:197`)는 원의 위쪽 끝이 33% 이다.
  - 붙이는 법: 로그인 루트 KAV(`login.tsx:149`) 첫 자식으로 `AuthBackdrop` 을 absolute 로 두고, `Screen className="bg-transparent"` 로 한다.
  - 광원 크기는 3절 규칙을 따른다.
- **G1-23(P0, 작음)**
  - 구글 버튼은 3절 `size={46}` 을 쓴다.
  - 카카오를 켜면 `socialPolicy.test.ts:16,19,23` 도 바꿔야 하니 바꿀 파일에 더한다.
  - 카카오 Pressable 에 `accessibilityRole="button"` 과 `disabled={busy}` 를 준다(`login.tsx:248-255` 처럼).
- **G1-24(P1)**
  - `TextInput minHeight 24` 로 하면 누르는 자리가 24pt 로 줄어든다. RN View 는 웹 `<label>` 처럼 탭을 입력칸으로 넘기지 않는다.
  - → 컨테이너는 `min-h-[50px]` 로 하고 세로 패딩을 없앤다. `TextInput style={{ minHeight: 48, paddingVertical: 0 }}` 로 하면 테두리 1+1 을 더해 50이 된다.
- **G1-26(P1, 작음)**: 3절 `size={46}` 을 쓰고, AuthBackdrop 은 G1-21 과 같은 방법으로 붙인다(`forgot-password.tsx:49-50`).
- **G1-29(P2)**
  - 웹 `animate-fade-in` 은 fade-in-up 1s(투명도 + translateY 10→0, `W:app/globals.css:667-680`)이다. → `entering={FadeInUp.duration(1000).withInitialValues({ opacity: 0, transform: [{ translateY: 10 }] })}`.
  - 버튼은 3절 표를 쓴다.
- **G1-31(P0, 작음)**
  - goldTerracotta + 흰 글자는 금 쪽이 2.64:1 이다. 웹 `contrast.test.ts:49-65` 가 '옛 금→주칠(대비 미달)'로 금지한 조합이고, 404 는 검사 대상에서 빠져 남았다. → 결정을 추가한다: (A) 웹 그대로 / (B) 두 앱 모두 `cta`(웹 not-found 도 `cta-primary`). 권장은 B.
  - 마스코트: `contentFit="cover"` + `contentPosition={{ top: '22%', left: '50%' }}`.
  - `Gradient` 에 `style={StyleSheet.absoluteFill} pointerEvents="none"` 을 준다.
  - 알약 둘에 `accessibilityRole="button"`.
  - `leading-[64px]` 는 안드로이드에서 위가 잘릴 수 있다. 실기기에서 확인한다.
- **G1-34(P2)**
  - `aria-selected` 는 role=button 에 쓸 수 없다. 칩·토글에 붙이면 화면 읽기가 무시한다.
  - → 3절 '접근성 상태'로 고친다.
- 그대로 맞음: G1-03, G1-10, G1-12, G1-16, G1-22, G1-27, G1-28.

### G2

- **G2-G07(P0, 결론이 바뀜)**
  - 원인 추정(동적 크기 0)과 '네이티브는 동작한다'는 판단이 틀렸다. 코드로 확인한 원인:
    - `ModalSheet` 효과가 닫힌 채 처음 마운트될 때 `ref.current?.dismiss()` 를 부른다(`M:components/ui/Sheet.tsx:310-313`).
    - @gorhom/bottom-sheet 5.2.14 `handleDismiss` 는 INITIAL 상태면 `DISMISSING` 으로만 바꾸고 끝낸다(`node_modules/@gorhom/bottom-sheet/src/components/bottomSheetModal/BottomSheetModal.tsx:277-294`).
    - 그 뒤 `present()` 가 포털을 붙여도, `handlePortalRender` 가 DISMISSING 이면 그리지 않고 돌아간다(`:399-414`). 그래서 DOM 이 없고 오류도 없다(관찰과 같음).
    - 닫히면 다시 dismiss 되어 같은 상태가 반복된다.
    - JS 경로라 플랫폼과 무관하다. **안드로이드도 ModalSheet 7곳이 안 열릴 가능성이 높다**: 필터·편의, 날씨, 축제, 화장실, 지금 한산, 묶음 핀, 혼잡 제보. HANDOVER 11-09 는 추천 `Sheet` 만 확인했다.
    - HEAD export 에서도 재현했다(`shots/R1/_r1-checks.json`: 시트 제목 expo 0 / web 1).
  - 시트가 그려지기 시작하면 다음 문제가 드러난다.
    - `BottomSheetModalProvider`(`M:app/_layout.tsx:75`)가 I18nProvider·ProvidersWithLabels·ThemeProvider 보다 위에 있다.
    - 포털 내용은 PortalHost(Provider 자식 뒤)에 그려지므로 이 컨텍스트들 밖이다.
    - 시트 안에서 `useI18n()` 을 부르는 컴포넌트는 throw 한다(`M:lib/i18n/I18nProvider.tsx:76-78`). 지금 내용은 바깥에서 번역한 JSX 라 괜찮다.
  - → 고칠 방법(전부 바꿈):
    1. ModalSheet 를 이렇게 고친다.
       - `const presentedRef = useRef(false)` 를 둔다.
       - 효과는 `if (open) { presentedRef.current = true; ref.current?.present(); } else if (presentedRef.current) { ref.current?.dismiss(); }` 로 바꾼다.
       - `onDismiss={() => { presentedRef.current = false; onClose(); }}`.
    2. `_layout.tsx` 순서를 `GestureHandlerRootView > SafeAreaProvider > I18nProvider > ProvidersWithLabels > ThemeProvider > BottomSheetModalProvider > Stack·FirstRunGate·TrackedShellBridge` 로 바꾼다.
    3. 기존 1~2번(snapPoints·`ModalSheet.web.tsx`)과 G3-21 2번은 하지 않는다.
  - 바꿀 파일: `Sheet.tsx`, `app/_layout.tsx`.
  - 확인: 새 export 뒤 `r1-checks.mjs` 에서 시트 제목 expo 1, 그다음 `02-top`·`04b-panels`. 안드로이드 실기기에서 '필터·편의'·날씨·'혼잡 제보'를 연다.
  - 표시: 네이티브 확인 필요 · 크기 S
- **G2-G01(P0)**
  - 막대를 겹치는(absolute) 모델은 G3-01·G3-31·G5b-01 처방과 어긋나고 고칠 곳만 늘린다. 홈 시트 `bottomInset` 미전달(`HomeScreen.tsx:868-885`), 아래 스택 padding(`:791`), 카메라(`:253`), 마이 하위 7개, 대안 화면을 다 고쳐야 한다. → 3절 '탭 막대 모델'대로 **보통 흐름**으로 바꾸고, 2번의 'absolute·겹친다'와 각 화면 '101+insets 여백'·'지도를 끝까지'를 지운다. 바꿀 파일에서도 saved·waiting·course·mypage 를 뺀다.
  - 빠진 단계를 더한다.
    - 누를 때 `navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })` 를 보내고, 막히지 않았으면 `navigate`.
    - **활성 탭을 누르면 아무 일 없음**(햅틱도 없음). 웹 `W:components/shell/BottomNav.tsx:69` 와 같다.
    - `state.routes` 에 숨김 경로(`explore/recommend`)도 들어온다. 다섯 탭 이름만 그리고, 활성·알약 위치는 경로로 정한다.
    - 글자는 G2-R02 대로 그리고, 배율 상한 1.2 는 유지한다.
    - 막대에는 `Glass` 를 쓰지 않는다. G2-G03 의 글자색 바꾸기가 탭 글자를 #463b34 로 만든다.
    - `useBottomTabBarHeight` 는 지금 쓰는 곳이 없다. 높이 통보는 생략해도 된다.
    - `import { Tabs } from 'expo-router'` 는 v57 에서 deprecated 다(`expo-router/build/exports.d.ts:42`). `expo-router/js-tabs` 로 바꾼다.
  - 3번의 '그 전까지 /intro 닫기 모드' 는 지운다. G1-08 의 `openGuide()` 를 부른다.
  - 콘솔 링크는 `openExternalUrl()` 로 연다.
- **G2-G02(P0)**
  - 인용: 루트 항목은 `_layout.tsx:90`(explore/recommend)·`:92`(mypage)다. "91-92" 가 아니다.
  - 마이 쪽은 G5b-01 이 맡는다. `index` 머리 숨김과 `unstable_settings.initialRouteName:'index'` 가 G2-G02 에는 없는데, 다른 탭에서 하위로 push 하는 곳이 있다(`HomeScreen.tsx:853,881`, `saved.tsx:207`, `AiConsentNotice.tsx:14`).
  - 대안 화면을 Tabs 로 옮기면 생기는 일과 할 일:
    - 머리·뒤로가 사라진다(`headerShown:false` `_layout.tsx:48`, `RecommendScreen.tsx:116-131`).
    - 안드로이드 뒤로가 `firstRoute` 라 늘 홈으로 간다. → `<Tabs backBehavior="history">` 를 주고 머리는 G4a-15 로 대신한다.
  - 'popToTop' 은 지운다(웹은 활성 탭 누름을 무시).
  - 주석 `M:app/mypage/_layout.tsx:2-3`, `M:PORTING.md:39` 를 고친다.
- **G2-G03(P1)**
  - expo-blur 57 은 안드로이드에서 `blurTarget`(흐릴 내용을 감싼 `BlurTargetView` ref)이 필요하다. 없으면 흐림 없이 'none' 이 된다(`expo-blur/build/BlurView.types.d.ts:21-27`). 지도를 `BlurTargetView` 로 감싸야 하는데, 구글 지도(SurfaceView)는 이 흐림에 잡히지 않을 수 있다.
  - → 선택지 ① 은 실기기 시험 뒤에만 고른다. 안 되면 ③(70%).
  - `backdropFilter` 는 RN 타입에 없어 웹 분기에서 캐스트한다.
- **G2-G04(P1, 작음)**: navTheme 은 모듈 상수다(`_layout.tsx:43-59`). 로케일을 따르려면 컴포넌트 안(useMemo)으로 옮긴다.
- **G2-G05(P1)**
  - 글자 크기는 `StyleSheet.flatten(style).fontSize` 를 먼저 본다(`features/waiting/PlaceTile.tsx:49`).
  - NativeWind 가 `text-xs~2xl` 에 줄높이를 이미 준다. 그 클래스가 있으면 아무것도 더하지 않는다(style 이 className 을 덮는다). 기본값은 `text-[Npx]`·크기 없음일 때만 준다.
  - 웹 `leading-none`(G2-10 시계·출처)은 lineHeight = 글자 크기로 명시한다.
- **G2-G06(P1, 결론이 바뀜)**
  - `+html.tsx` 는 쓰이지 않는다. `app.json` `web.output: "single"`(:56)이라 Expo 기본 템플릿이 `<html lang="en">` 을 만든다(`M:lib/webSetup.web.ts:26` 메모). 바탕은 이미 한지(`M:lib/webFrameCore.ts:31`)라 3번도 필요 없다.
  - → `lib/webSetup.web.ts` 의 `<style>` 에 `html:lang(ko) body{word-break:keep-all;overflow-wrap:break-word} html:is(:lang(ja),:lang(zh)) body{line-break:strict}` 를 넣는다.
  - 시작할 때 `document.documentElement.lang = 저장 로케일 || 'ko'` 로 하고, `lib/i18n/I18nProvider.tsx` 에서 로케일이 바뀌면(웹만) 갱신한다.
  - G5a-13 도 이것으로 닫힌다.
- **G2-G09(P1)**
  - 빠진 호출 `HomeScreen.tsx:623` 을 더한다.
  - 알약은 `pointerEvents="none"`, 가운데 정렬, 낱말 단위 줄바꿈이다.
  - 자리: 홈 컨테이너 안이면 `bottom = 350 − 101 − insets.bottom` 이다(3절).
  - 파일은 G3-33 과 하나로 만든다(3절).
- **G2-06·G2-07(P1)**
  - Card 기본 `p-[16px]` 와 겹치지 않게 `padded={false}` + `className="px-[24px] py-[20px]"` 로 한다.
  - G2-06 버튼에 `mt-1` 을 더한다(`page.tsx:4613`).
  - 금 단색 대비는 2.6:1 이다(3절 결정).
- **G2-10(P0)**
  - 웹 왼쪽은 언어 알약 **아래** 출처 알약을 쌓는 열이다(`flex-col items-start gap-1 max-w-[220px]`, `page.tsx:3978-3994`). → 바깥 `row justify-between`, 왼쪽 열은 `gap 4 · maxWidth 220`.
  - 시계: `leading-none`·`mt-1`·KST 뒤 `mr-1`·`text-right`(`:3996-4007`). 출처 알약도 `leading-none` 이다.
  - Hermes `Intl` timeZone 은 홈이 이미 `@/lib/restDate` kstParts(`HomeScreen.tsx:17`)로 쓴다. 한 번만 확인한다.
  - 언어 알약은 3절 LanguageSwitcher 의 `glass` 변형이다.
- **G2-11(P0, 작음)**
  - 머리 좌우는 className `px-[12px]`(:650)와 style 패딩(:651)을 둘 다 바꾼다.
  - 마스코트 아바타는 `shadow-sm` + gold/35 테두리.
- **G2-13(P0)**
  - 축제·화장실 칩은 `useI18n()`(`ToolChips.tsx:158,302`)을 부른다. 시트 안으로 옮기면 G2-G07 의 Provider 이동 전에는 throw 한다. G2-G07 이 먼저다.
  - '위에 쌓기'에는 ModalSheet `stackBehavior` prop 이 필요하다(gorhom 기본 'switch').
  - 시트 안으로 옮기면 조회 시점이 바뀐다. 웹과 같은지 확인한다.
- **G2-14(P0)**
  - 문구 단계가 틀렸다. Expo 는 이미 사이드 사전을 읽는다(`M:lib/i18n/translate.ts:10-12,37-47`). `catalog.ts` 는 고칠 필요 없다.
  - 요청 자리도 틀렸다. `discovery_theme` 는 이미 `getRecommendations`(`M:lib/core/apiClient.ts:313-345`)가 받는다. `features/explore/logic.ts` 는 요청을 하지 않는다.
  - → 바꿀 파일에서 두 파일을 빼고, 새 `DiscoveryPanel.tsx` 에서 `getRecommendations({ …, discoveryTheme })` 를 부른다.
- **G2-16(P0)**
  - 팝오버를 첫 칩 줄 가로 ScrollView(`HomeScreen.tsx:700`) 안에 두면 안드로이드에서 잘리고, 부모 밖 터치가 막힌다.
  - → HomeScreen 루트로 올린다.
    - 자리는 칩의 `measureInWindow` 값으로 잡는다.
    - 바깥 닫기는 루트 전체 투명 Pressable(팝오버 바로 아래 층)로 한다.
    - z 순서는 뒤에 오는 여정 판(:836-866)·아래 스택·시트보다 위다.
- **G2-25(P0)**
  - Expo(현재) "`aria-selected`" 는 틀렸다. RNW 0.21.4 는 `accessibilityState` 를 DOM 으로 옮기지 않아, 홈 칩(:719,733,752)은 선택 상태를 아무 속성으로도 내지 않는다.
  - 4번은 3절 '접근성 상태' 로 대신한다(`aria-pressed` 는 웹 전용).
- **G2-26(P0, 작음)**
  - "고른 음식은 카드 조건 칩(G3)이 맡는다"는 틀렸다. 웹 조건 칩은 도보·실내·휠체어·유모차뿐이다(`page.tsx:3440-3452`).
  - 웹도 시트 밖에는 고른 음식을 보이지 않는다. 줄을 지우기만 하면 웹과 같고, G3 에 할 일은 없다.
- **G2-27(P0)**
  - 칸 색을 고친다. 꺼짐 = 흰 바탕 + 테두리 `rgba(62,124,106,0.3)`, 켜짐 = 테두리 jade `#3e7c6a` + 바탕 `rgba(62,124,106,0.15)`(`page.tsx:4581-4584`).
  - 공용 기본값을 바꾸지 말고 선택 prop 으로 한다(3절 ModalSheet). 패딩은 웹 `px-4 pt-3 pb-[20+safe]` 이다.
  - 축제·화장실은 G2-13 과 같은 선행 조건이 있다.
- **G2-30(P0, 작음)**
  - 웹 조건에는 `noOpenTodayOnly`·속성 핀 경우도 있다(`page.tsx:4702-4705`).
  - `chipCandidates`(`W:lib/travelContext.ts:151`)는 localStorage·`@/lib/visits` 에 의존한다. `check:shared` 를 확인하고, 안 되면 규칙만 옮긴다.
- **G2-31(P0, 작음)**: `pointForCoordinate` 는 react-native-maps 1.27.2 에 있고 안드로이드도 dp 를 돌려준다. `NextSpotMapHandle`(`types.ts:118`)에 더해 내부 `mapRef`(`NextSpotMap.tsx:110`)로 넘긴다.
- **G2-34(P0)**
  - `leading-28` 은 없는 클래스다. → `leading-[28px]`.
  - 공지는 `Card padded={false} elevation="none" className="px-[16px] py-[12px]"` 로 그린다(웹 그림자 없음, `PublicSettingsProvider.tsx:150-152`). 웹 `max-w-sm`·`space-y-3` 도 반영한다.
  - `renderMaintenance`·`renderNotice` 는 있다(`publicSettings.tsx:56-57`, `AppProviders.tsx:20-21,31-32`). 그런데 루트 `ProvidersWithLabels`(`_layout.tsx:117-130`)가 라벨만 넘긴다. → 거기서 넘긴다(G2-33 도 같은 자리).
- **G2-33(P1, 작음)**
  - 닫기는 `IconButton size="sm" box={22}` 로 한다(기본 상자 36).
  - 확성기 `mt-[2px]`, 판 `maxWidth 672` 가운데 정렬.
- **G2-17(P1, 작음)**
  - 바탕·막은 공용 상수다(`Sheet.tsx:116-122,351`). 인스턴스 prop 으로 바꾼다.
  - 안드로이드 흰 불투명 바탕은 의도된 것이다(`:117-118`).
- **G2-04(P1, 작음)**
  - `USER_DOT`(`pins.ts:44-47`)은 웹 판과 네이티브가 함께 쓴다.
  - 네이티브 마커는 600ms 뒤 `tracksViewChanges` 를 끈다(`NextSpotMap.tsx:76,275-284`). 그래서 맥박은 안 되고 정적 그라데이션만 된다.
  - `PORTING.md:10` 을 갱신한다.
- **G2-08(P1, 작음)**: 네이티브에서 알 수 있는 실패는 키 없음(`MAP_AVAILABLE`)뿐이다. 시간 초과 상수는 `kakaoWeb.ts:123`.
- 그대로 맞음(작은 메모만): G2-01, G2-03, G2-05, G2-09, G2-12, G2-15, G2-19, G2-20, G2-21, G2-22, G2-24, G2-28, G2-32.

## 3. 묶음 간 충돌·공용 컴포넌트

### `components/ui/Button.tsx`
- 관련 항목: G1-02·17·20·23·24·25·26·29 ↔ G4b-22 ↔ G5b-05·12·34. 금색 결정은 G2-06·G4a-28·G4b-10·21 도 걸린다.
- 충돌:
  - 같은 뜻에 다른 이름: `tone="gold"` ↔ `variant="gold"`, `shape="full"` ↔ `"pill"`.
  - 같은 이름에 다른 뜻: `size` 의 lg 가 52/16 ↔ py-12·rounded-xl. G5b-05 는 크기에 모서리까지 묶는다.
  - className 덮어쓰기가 규칙 4 를 어긴다.
- → 하나로 정한 방법: 다음 prop 만 더한다. 기본값은 지금 모양이라 다른 화면은 바뀌지 않는다. 높이·좌우 여백은 클래스가 아니라 `style` 로 넣는다.

  | prop | 값 | 기본 |
  |---|---|---|
  | `variant` | primary(cta) · gold(단색, 그림자 없음) · secondary · hanji(bg-hanji+line) · dangerSoft(terracotta/10 바탕·/30 테두리·terracotta 글자) · dangerOutline · ghost | primary |
  | `size` | 30 · 36 · 44 · 46 · 48 · 52 · 56 (= minHeight; paddingVertical 은 30 만 6, 나머지 8) | 44 |
  | `labelSize` | 12/16 · 13/19.5 · 14/18 · 15/22.5 · 16/24 · 17/25.5 (크기/줄높이) | 14/18 |
  | `labelWeight` | medium · semibold · bold | bold |
  | `paddingX` | 숫자 | 16(size 30 은 12) |
  | `shape` | lg(8) · xl(12) · 2xl(16) · full | 2xl |
  | `shadow` | auto(지금: primary·활성일 때 cta) · none · cta · ctaLg(0 8 20 .28) · ctaHero(0 8 24 .28). auto 가 아니면 비활성이어도 그린다 | auto |
  | `iconSize` | 숫자 | 14 |
  | `showSpinner` | boolean | true |
  | `disabledOpacity` | 숫자 | 0.5 |

  화면별 값:
  - G1
    - 랜딩: `size={52} labelSize={17} shape="full" paddingX={40} shadow="ctaHero"` + 오른쪽 `trailing` 에 ChevronRight 20 흰색.
    - 설정: `block size={52} labelSize={16} shadow="ctaLg" showSpinner={false} disabledOpacity={0.6}`.
    - 로그인 제출: `block size={52} labelSize={16} shape="xl" shadow="none" showSpinner={false}`.
    - 게스트·재설정 완료·구글: `block variant="secondary" size={46} shape="xl"`.
    - 재설정 링크: `block variant="gold" size={52} labelSize={16} shape="xl" showSpinner={false}`.
    - 콜백: `variant="gold" size={48} labelSize={16} shape="full" paddingX={24}`.
    - `intro.tsx:107`·`setup.tsx:197` 의 `className="min-h-[52px]"` 는 지운다.
  - G4b-22: `shape="full" labelSize={13} paddingX={20}`.
  - G5b
    - 모달 저장·완료: `variant="gold" size={48} labelSize={16} shape="xl"`(완료는 `paddingX={32}`).
    - 쿠폰: `variant="gold" size={30} labelSize={12} shape="lg"`.
    - 공유: `variant="gold" size={56} labelSize={16} labelWeight="semibold" iconSize={18}`.
    - 실험실: `variant="gold" size={36} shape="xl"`.
    - 문의 보내기: `variant="gold" size={56} labelSize={16} shape="xl" iconSize={20}`.
    - 프로필 수정: `variant="hanji" labelWeight="medium" shape="xl" paddingX={20}`.
    - 위험 버튼: `variant="dangerSoft"/"dangerOutline" labelWeight="semibold"`.

  진행 순서: 한 에이전트가 Button 만 먼저 바꾸고, 화면 PR 들은 쓰기만 한다.
- 금 단색 결정은 하나로 한다.
  - `variant="gold"` 는 토큰 하나(`button-gold`)만 읽는다.
  - 흰 글자/#c19a3e 는 2.6:1 이다.
  - 같은 결정 대상: G1-20·26·29, G2-06, G4a-28, G4b-10·21, G5b-05, G1-31(goldTerracotta).
  - 선택: (A) 웹 그대로 / (B) 두 앱 모두 #705819(6.8:1). B 면 토큰 값과 웹 `bg-gold` 버튼을 같은 PR 에서 바꾼다.

### 탭 막대 모델과 화면 아래 여백
- 관련 항목: G2-G01 ↔ G3-01·G3-31·G3-34②·G4a-01·G4b-26·G5a-03·G5b-01④·G2-01·G2-G09, G1 메모(토스트).
- 충돌: G2-G01 은 겹치는 막대인데, 나머지는 '화면이 막대 위에서 끝난다'를 전제한다(G3-01 `bottom:15` = 웹 116 − 101).
- → 하나로 정한 방법: **보통 흐름(겹치지 않음)**.
  - `TouristTabBar` 는 Tabs 기본 자리에 둔다. 높이 101 + insets.bottom, 바탕 `rgba(255,255,255,0.9)`(아래가 한지라 사실상 흰색), 흐림 없음.
  - 같은 파일에서 `TOURIST_NAV_HEIGHT = 101`, `TOURIST_NAV_GAP = 15` 를 export 한다.
  - 규칙:
    - 스크롤 아래 여백: 웹 `pb-[calc(var(--tourist-nav-clearance)+X)]` → `X + 15`. clearance 만 있으면 15(G5b-01 4번의 24 → 15).
    - 홈 아래 스택: `bottom: 15`.
    - 웹 'clearance+8' 자리: `15 + 8`.
    - 홈 알약 토스트: `bottom = 350 − 101 − insets.bottom`.
    - 카메라 띠 아래: 컨테이너 − 15 와 예측 띠·카드 위 중 높은 쪽 + 8.
    - sonner(`Toast.tsx:22`): 루트에서 `usePathname()` 으로 판단한다.
      - 탭 경로(/, /saved, /waiting, /course, /mypage, /mypage/*, /explore/*)는 `101 + 8 + insets.bottom`.
      - 탭 없는 화면(/login·/setup·/forgot-password·/intro·/auth/callback)은 `16 + insets.bottom`.
      - 단, G3-34 ② 에서 '웹 그대로(막대에 겹침)'를 고르면 모든 화면이 `16 + insets.bottom`.
  - 이렇게 정한 이유:
    - 다른 묶음 처방을 고칠 필요가 없다.
    - 안드로이드 구글 지도 로고가 막대 뒤로 숨지 않는다.
    - 남는 차이는 웹에서 막대 뒤에 숨는 카카오 로고·축척뿐이다.

### 라우트 이동
- 관련 항목: G2-G02 ↔ G5b-01·02 ↔ G4a-15.
- 충돌:
  - 마이 하위 이동을 두 묶음이 각각 지시한다.
  - '탭 다시 누르면 popToTop'(G2-G02), '하위에서 마이 누르면 /mypage'(G5b-01 5번)는 웹과 다르다. 웹은 활성 탭 누름을 무시한다(`BottomNav.tsx:69`).
  - G4a-15 1번(`_layout.tsx:90`)은 그 줄이 지워지면 할 일이 없어진다.
- → 하나로 정한 방법:
  - 마이 = G5b-01 1~4번(5번은 삭제).
  - 대안 화면 이동 + `<Tabs backBehavior="history">` = G2-G02. 하드웨어 뒤로가 '이전 탭'이 되어 G4a-15 4번 권장과 맞는다.
  - 대안 머리 = G4a-15 2~5번(`RecommendScreen.tsx:115-133` 블록 삭제 + 원형 '지도 보기').
  - 순서: G2-G02·G5b-01 다음에 G4a-15·G5b-02.

### 홈 알약 토스트 파일
- 관련 항목: G2-G09 ↔ G3-33. 같은 새 파일 `features/home/HomeToast.tsx` 를 둘 다 만든다.
- → 하나로 정한 방법:
  - 파일은 G3-33 이 만든다(호출 목록이 더 넓다).
  - G2-G09 는 HomeScreen 호출(:283·286·352·414·623·625)을 `useHomeToast()` 로 바꾸는 것만 한다.
  - ⓘ 끄기는 G3-34 1번 한 곳에서 한다.

### `components/ui/Sheet.tsx` ModalSheet
- 관련 항목: G2-G07 ↔ G3-21 ↔ G2-13·16·17·18·27 ↔ G1-04·05·08.
- 충돌:
  - 웹 판 처방이 둘(G2-G07 1~2, G3-21 2)인데, 둘 다 원인이 아니다.
  - G3-21 3번이 공용 모양을 바꾸면 6곳이 같이 바뀐다.
  - 웹 값이 시트마다 다르다: 막 muk 35% / 검정 30% / muk 40%+흐림, 폭 full/512/384, 패딩 16·12·20 / 20 / 24.
- → 하나로 정한 방법:
  - 원인 수정(G2-G07 정정)은 한 번만 한다.
  - 선택 prop 을 더한다. 기본값은 지금 그대로다.
    - `background?: 'default'|'hanji'`
    - `showHandle?`
    - `closeButton?`(머리 X)
    - `backdrop?: { color, opacity }`
    - `maxWidth?`
    - `contentPadding?: { x, top, bottom }`
    - `stackBehavior?`
  - 호출부가 웹 값을 넘긴다. G3-21 의 금 장식선은 내용 쪽에 둔다.
  - RN Modal 안에서는 내용에 `GestureHandlerRootView` + `BottomSheetModalProvider` 를 따로 둔다(G1-08).

### NextSpotMascot·로고 자산
- 관련 항목: G1-02·31 ↔ G2-05·07·11·30 ↔ G3-27, 로고는 G1-02·G4a-01·G5b-07.
- 충돌:
  - 컴포넌트 자리: `components/` ↔ `components/ui/`.
  - 그림 자리: `mascot-guide.webp` ↔ `mascot/` ↔ `assets/images/`.
- → 하나로 정한 방법:
  - 컴포넌트는 `M:components/NextSpotMascot.tsx`(웹과 같은 자리).
  - 그림은 `M:assets/images/mascot/nextspot-guide.webp`(512×512 원본, 웹 이름 그대로).
  - variant:
    - `full`: 4:5, 모서리 = 폭×0.28 숫자, `contentFit="cover"`, `contentPosition={{top:'42%',left:'50%'}}`.
    - `avatar`: 원형, 테두리 1 `rgba(193,154,62,0.35)`, 바탕 hanji, `contentPosition={{top:'22%',left:'50%'}}`, scale 1.48, `shadow-sm`.
  - 로고는 `M:assets/images/nextspot-logo.png`(505×109 원본 하나)만 둔다. @3x 원본이 없으니 G5b-07 의 @2x·@3x 는 만들지 않는다.

### LanguageSwitcher
- 관련 항목: G1-04 ↔ G2-10 ↔ G5b-07·32.
- 충돌:
  - 웹은 컴포넌트 하나(`W:components/LanguageSwitcher.tsx`)를 랜딩·로그인·안내 모달·홈(유리)·마이에서 같이 쓴다.
  - Expo 처방은 세 갈래이고, 읽기 이름도 세 갈래다(`app.intro.languageLabel`·`settings.langTitle` 은 "언어", G5b-07 새 키는 "언어 선택").
- → 하나로 정한 방법:
  - 컴포넌트는 `M:components/LanguageSwitcher.tsx`(네이티브: 알약 + 목록. G5b-32 의 `SelectField` 를 쓰기로 하면 그 위에) + `.web.tsx`(투명 `<select>` 겹치기)다. prop `glass?` 를 둔다.
  - 기존 마이 칩 `LanguageSwitcher` 와 소개 칩 줄은 지운다.
  - 읽기 이름은 새 키 하나로 한다. G5b-07 의 키를 `app.common.languageSelect` 로 이름만 바꾸고, 한 담당이 4로케일을 동시에 넣는다.
  - 안 쓰게 되는 `app.intro.languageLabel` 은 4 JSON 에서 같이 지운다.

### 광원
- 관련 항목: G1-02·21·31 ↔ G4a-14(`components/ui/Glow.tsx`) ↔ G5a-02(`BoardGlow`) ↔ G5b-20.
- 충돌: 같은 효과를 여러 벌 만들고, CSS blur 환산도 제각각이다.
- → 하나로 정한 방법:
  - 컴포넌트는 `components/ui/Glow.tsx` 하나(react-native-svg RadialGradient)다.
  - 환산 규칙(CSS `w×h` + `blur(σ)` → SVG):
    - 캔버스는 `(w+4σ)×(h+4σ)`, 중심은 CSS 원의 중심과 같다.
    - stop 0 = α×(1−e^(−r²/2σ²)).
    - stop r/(r+2σ) = 그 값의 절반.
    - stop 1 = 0.
    - 예: 300·σ100·15% → 캔버스 700, 중심 0.10.
  - LandingBackdrop·AuthBackdrop·404·저장/대안·대기·쿠폰이 이것을 쓴다.

### 원형 돌림표
- 관련 항목: G1-29 ↔ G2-05 ↔ G2-20.
- → 하나로 정한 방법: `components/ui/RingSpinner.tsx` 하나(size·borderWidth·trackColor·headColor, 1s linear, 동작 줄이기면 멈춤).

### 위치 동의
- 관련 항목: G1-14 ↔ G2-32 ↔ G2-04 ↔ G5b-33.
- 충돌: 권장끼리 함께 성립하지 않는다. G1-14 C 는 '홈 배너·내 위치 버튼에서 동의'인데, G2-32 ① 은 그 둘을 지운다. 둘을 함께 고르면 동의 입구가 설정 깊숙이만 남는다.
- → 하나로 정한 방법: 둘 중 하나를 고른다.
  - **(G1-14 A + G2-32 ①) 권장**: 첫 실행 동의 화면은 유지하고 모양만 맞춘다. 홈은 웹처럼 실패 알약으로 하고, 재진입은 설정에서 한다.
  - (C + ②): 첫 실행은 웹과 같게 하고, 홈에 Expo 전용 배너·버튼을 유지한다.
  - G2-04 ③ 은 어느 쪽과도 맞는다.

### 서비스 소개 진입
- 관련 항목: G1-08 ↔ G2-G01 3번 ↔ G1-15 ↔ G1-13.
- → 하나로 정한 방법:
  - G1-08 을 먼저 하거나 G2-G01 과 같은 PR 로 묶는다. 막대 안내 줄은 `openGuide()` 만 부른다.
  - `intro.tsx` 분기 순서: `view==='landing'` → `consentOnly` → intro/consent 단계 → step null 이면 `openGuide()` + `replace('/')`(또는 `/guide`).
  - GuideProvider 는 G2-G07 의 새 Provider 순서 안에 둔다.

### 축제 코드
- 관련 항목: G1-05 ↔ G2-13 ↔ G2-17·18. 셋 다 같은 `ToolChips.tsx:129-295` 를 고친다.
- → 하나로 정한 방법:
  - 순서: G1-05 추출(모양은 그대로, `location`·`onFocus` 선택 prop) → G2-13 → G2-17·18(추출된 `FestivalSheet.tsx`·`festival.ts` 에서). 모두 G2-G07 뒤.
  - G2-13 이 지우는 '한 줄형 칩'(`:177-190`)과 G1-05 의 랜딩 배너 카드는 다른 것이다.

### 접근성 상태(웹 빌드)
- 관련 항목: G1-34 ↔ G2-25 4번 ↔ G5b-06 ↔ G5a-25.
- → 하나로 정한 방법: `components/ui/Pressable.tsx` 한 곳에서 `accessibilityState` 를 펼친다.
  - selected: role=tab 이면 `aria-selected`, 그 밖은 웹에서만 `aria-pressed`(RN 타입에 없어 Platform 분기 + 캐스트).
  - checked → `aria-checked`, expanded → `aria-expanded`, busy → `aria-busy`.
  - 네이티브는 지금 그대로다.
  - 화면별 코드는 필요 없다. 예외는 Pressable 이 아닌 View(예: `waiting.tsx:51`)뿐이다.

### 전역 글자
- 관련 항목: G2-G03·04·05·06 ↔ G5a-13 ↔ G1 메모(Text 에 wordBreak) ↔ G4b-07·14·G5a-08·G4a-02.
- → 하나로 정한 방법: G2 한 담당이 이 순서로 한다.
  1. G2-G06: CSS 로 한다. Text 는 고치지 않으므로 G1 메모·G5a-13 의 Text 수정은 하지 않는다.
  2. G2-G05.
  3. G2-G04 + G2-R03.
  4. G2-G03.
  - G2-G05 뒤에 다른 묶음은 Expo 높이를 다시 재고 나서 작은 여백을 맞춘다.

### 여러 묶음이 같이 고치는 파일
- `lib/theme/tokens.ts`(+test): G1-02·20·21·23·G3-11·17·G4a-24·G5b-03 이 모두 여기에 더한다. 한 에이전트가 먼저 한 번에 넣는다.
- `app/_layout.tsx`: G2-G07·G1-08·G2-G02/G5b-01·G2-33/34·G2-G04·G4a-15 가 모두 고친다. 한 PR 로 묶거나 순서대로 한다.

### 홈 아래 스택
- 관련 항목: G3-01 ↔ G2-24·G2-30·G2-32·G2-12·G2-01.
- 충돌: G2-24 는 '시트 위끝 − 8', G2-01 은 `sheetCoverHeight` 를 기준으로 하는데, G3-01 은 시트를 웹의 카드 스택(`page.tsx:4693` `flex-col gap-2`)으로 바꾼다.
- → 하나로 정한 방법:
  - 스택은 G3-01 이 만든다.
  - 예측 띠·제안 카드·(①이 아니면) 배너·음성 알약은 그 스택의 자식으로 넣는다(gap 8).
  - G2-01 은 스택 위끝을 `onLayout` 으로 잰다.

### 함께 정할 결정
- 음성 비서: G2-11·G2-12·G3-04·G4a-17.
- 가정 시간: G2-24 '다른 시간' 미룸 ↔ G4b-08·G5a-05 `lib/core/assumedTime.ts` 이식. 이식하기로 하면 띠도 같은 모듈로 같은 차례에 한다.
- 콘솔 웹 열기: G1-07·G1-09·G2-G01①·G5b-08·11.
- 공모전 전용 요소: G1-22·G1-12 계획 절. 대회가 끝났으니 둘 다 '웹에서 빼기'로 맞추는 것이 일관된다.

### G1·G2 밖에서 눈에 띈 것(참고)
- `PlacePhotoFallback`: G3-08·G4b-12 는 `components/ui/`, G4a-19·G5a-15 는 `components/`.
- NowChip: G4b-06 은 새 `components/ui/`, G4a-03·G5a-04 는 기존 `features/waiting/`.
- LoadingReveal: G4b-20 은 `components/ui/`, G5a-09 는 `features/waiting/`.

## 4. 확인 결과 요약
- 확인한 P0 26건(G1 7 · G2 19) 중 정정 20건.
  - 결론·처방이 크게 바뀐 것: G2-G07, G2-G01, G2-G02, G2-14, G2-16, G1-01, G1-02.
  - 정정 없음: G1-03, G2-09·12·19·24·32.
- 확인한 P1 36건(G1 17 · G2 19) 중 정정 23건.
  - 큰 것: G1-15, G1-20, G2-G06, G2-G03.
  - 함께 본 P2 3건 중 2건 정정(G1-29·34).
- 새 항목 3건(P0 0 · P1 2 · P2 1): G2-R01, G2-R02, G2-R03.
- 인벤토리 상태 대응: G1 51 · G2 52 상태가 모두 쌍 사진·항목·'촬영 못 함/차이 없음' 기록 중 하나로 덮여 있다. 항목 없이 '차이 없음'을 따로 확인한 것: G2-TOP-14, G2-NTC-03, G1-LGN-09.
- 고친 수치:
  - 흰 글자/#c19a3e 대비 2.64:1(3.7 아님 — Expo `ErrorState.tsx:28` 주석도 틀림).
  - `landing-sunset-end` `#f6dac8`, `auth-sunset-end` `#f6dfcf`.
- 추가 촬영 경로(하네스 `openPair`, `state:'saved'`, 새 게스트 0, 쓰기 0 — public-settings 는 `mockGet`):
  - `scratch/parity/overlays/R1/r1-locale-nav.mjs` → `shots/R1/locale-zh-nav.pair.png`, `locale-en-nav.pair.png`, `_r1-locale-nav.json`
  - `scratch/parity/overlays/R1/r1-checks.mjs` → `shots/R1/notice-vs-search.pair.png`, `tools-sheet-head.pair.png`, `_r1-checks.json`(공지·검색 겹침, HEAD export 에서 ModalSheet 재현)
