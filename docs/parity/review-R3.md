# 검토 R3 — G5a·G5b

(먼저 확인한 것: `findings-G5b.md` 는 복구본 38건·76,516바이트로, 처음 읽은 판과 같습니다. digest 235행도 확인했습니다. 저장소 파일은 하나도 고치지 않았습니다. 촬영은 `work/R3/` 스크립트 1개로 1쌍을 찍었습니다(GET mock 만 썼고 쓰기는 0건).)

## 1. 빠진 차이 (새 항목)

**완전성 점검 결과**
- **G5a**: 인벤토리 WAI-01~22 상태는 모두 쌍 사진·항목·'차이 없음' 메모 중 하나로 덮여 있습니다.
  - 찍지 않은 것: WAI-04 3/3, WAI-14 오늘 휴무, WAI-20 시간 의존 문구, WAI-22 오프라인. 모두 공용 계산이거나 같은 코드 경로라 위험이 낮습니다.
  - 직접 본 쌍: 01·03·06·11·30·31·38·41·52.
  - 새로 빠진 차이는 찾지 못했습니다.
- **G5b**: MY·CPN·IMP·INQ·LAB·PRV·SETG·SUP 상태가 모두 덮여 있습니다.
  - 직접 본 쌍: my-01-top/tall, my-04 2장, my-08-learned, my-10-failed, cpn-05, setg-01-tall, prv-01-top, lab-05.
  - 새 차이 2건을 찾았습니다(아래 R01·R02).

### G5b-R01 설정 화면에 노을 광원이 없다
- 화면·상태: G5-SETG-01·02(설정 모든 상태)
- 스크린샷: shots/G5b/setg-01-guest-tall.pair.png — 웹 오른쪽 위에 복숭아빛 번짐이 있다.
- 웹(기준): `apps/web/app/mypage/settings/page.tsx:252` `absolute top-1/4 right-1/4 w-[300px] h-[300px] bg-sunset-1/10 rounded-full blur-[100px] pointer-events-none z-0`. 페이지 틀이 `h-[100dvh] overflow-hidden`(:89)이라 광원은 스크롤과 무관하게 고정된다.
- Expo(현재): `apps/mobile/app/mypage/settings.tsx:126` `Screen` 의 `bg-hanji` 단색이다. G5b-20(쿠폰)·G5b-31(개인정보)은 광원을 적었는데 설정만 빠졌다.
- 차이: 웹에만 화면 위쪽 1/4 지점 오른쪽에 sunset 10% 흐린 원이 있다.
- 중요도: P2 · 분류: 색·효과
- 고칠 방법:
  1) 화면을 `<View className="flex-1 bg-hanji">` 로 감싼다.
  2) 첫 자식으로 공용 광원(3절 13번 `components/ui/Glow.tsx`)을 `absolute` · `pointerEvents="none"` 로 둔다. 원 300 = 오른쪽 25%·위 25%, `react-native-svg` RadialGradient 로 sunset-1 10% → 0.
  3) `Screen` 에는 `className="bg-transparent"` 를 준다(기본 `bg-hanji` 가 광원을 덮지 않게).
- 바꿀 Expo 파일: `app/mypage/settings.tsx` (+ 공용 `components/ui/Glow.tsx`)
- 문구(i18n): 없음
- 네이티브 주의: blur 대신 그라데이션 가장자리로 흉내 낸다. 세 플랫폼에서 같다.
- 확인 방법: `06-privacy-settings.mjs` 를 다시 돌린다. setg-01 오른쪽 위 픽셀 톤이 웹과 같은지 PIL 로 비교한다.
- 크기: S · 의존: 3절 13번(광원 공용)
- 표시: —

### G5b-R02 내 문의·고객지원 — 웹은 머리가 스크롤과 함께 사라지고, Expo 는 고정된다
- 화면·상태: G5-INQ-05(목록이 길 때), G5-SUP-01·03(폼을 아래로 넘길 때)
- 스크린샷: **shots/R3/inq-scrolled-420.pair.png** — 둘 다 420px 스크롤.
  - 측정: 웹 `<header>` y=−420(사라짐) · `window.scrollY=420`, Expo 머리 y=22 고정.
  - 스크립트: `work/R3/01-inquiries-scroll.mjs`
- 웹(기준): 두 화면만 바깥 틀이 `min-h-screen` 이라(`inquiries/page.tsx:109`, `support/page.tsx:78`) 문서 전체가 스크롤되고 머리도 함께 올라간다. 나머지 다섯 하위 화면(coupons:97 · impact:100 · lab:206 · privacy:28 · settings:89)은 `h-[100dvh] overflow-hidden` + `main overflow-y-auto` 라 머리가 고정이다.
- Expo(현재): 7개 모두 스택 헤더(`app/mypage/_layout.tsx:13-21`)라 고정이다. G5b-02 의 사용자 머리(`screenOptions.header`)로 고쳐도 고정으로 남는다.
- 차이: 두 화면에서 스크롤할 때 머리가 남는지 여부
- 중요도: P2 · 분류: 동작·배치
- 고칠 방법:
  1) inquiries·support 두 화면만 스택 머리를 끈다(`<Stack.Screen name="inquiries" options={{ headerShown:false }}/>`, support 도 같게).
  2) 각 화면 `Screen scroll` 내용의 맨 앞에 G5b-02 의 `SubPageHeader`(bordered 변형: ArrowLeft, `gap-[16px] border-b border-line p-[20px]`)를 그린다. `Screen edges` 에 'top' 을 더한다 — Screen 은 위 안전 영역을 스크롤 밖에 둔다(Screen.tsx:52-55).
  3) support 완료 화면(`done`, 비스크롤)에도 같은 머리를 맨 위에 둔다.
  4) 나머지 다섯 화면은 G5b-02 대로 고정 머리로 둔다.
- 바꿀 Expo 파일: `app/mypage/_layout.tsx`(G5b-01 뒤에는 `app/(tabs)/mypage/_layout.tsx`), `app/mypage/inquiries.tsx`, `app/mypage/support.tsx`, `features/mypage/components/SubPageHeader.tsx`(G5b-02 새 파일)
- 문구(i18n): 재사용 `inquiries.title` `support.title` · 뒤로 라벨은 아래 G5b-02 정정안(`settings.backAria`) / 새 키 없음
- 네이티브 주의: 하드웨어 뒤로는 그대로 스택 pop 이다. 머리 제목은 `accessibilityRole="header"` 를 유지한다.
- 확인 방법: R3 스크립트를 다시 돌려 `headerTop.expo.y` 가 웹처럼 음수인지 본다.
- 크기: S · 의존: G5b-01, G5b-02
- 표시: —

## 2. 바로잡을 것 (기존 항목 정정)

### G5a

- **G5a-05 (P0)**
  - 문제:
    - ① 3)의 "Sheet 나 `@expo/ui` Picker" — `@expo/ui` 는 `apps/mobile/package.json` 에 없다. 새 네이티브 의존성과 dev build 재빌드가 필요한데 적혀 있지 않다.
    - ② `ModalSheet`(Sheet.tsx:305)는 Expo 웹 빌드에서 열리지 않는다(G2-G07·G3-21). 그래서 확인 방법(41번 촬영)이 웹 빌드에서는 실패한다.
    - ③ 같은 닫힌 셀렉트 모양을 G4b-08(`TimeSimControl`)·G5b-32(`SelectField`)가 따로 만든다.
  - → 3)을 다음으로 바꾼다.
    - 공용 `components/ui/SelectField.tsx` 에 `variant="control"` 을 둔다(3절 7번).
    - 바깥 `Pressable`: `min-h-[44px] flex-row items-center gap-[6px] rounded-xl border border-line bg-white px-[12px]`, `style={{boxShadow:'0px 2px 10px rgba(43, 35, 32, 0.06)'}}`.
    - 내용: 🕒(13px, 접근성 숨김) · `timeSim.label`(text-xs medium muk-soft) · 현재 라벨(text-xs bold muk) · `ChevronDown` 12.
    - 접근성: `accessibilityRole="button"`, `accessibilityLabel={t('timeSim.label')}`, `accessibilityValue={{text: 현재 라벨}}`.
    - 누르면: 네이티브는 `ModalSheet` 라디오 5행(각 44pt). 웹 빌드는 G2-G07 의 `ModalSheet.web.tsx` 가 들어올 때까지 `SelectField.web.tsx` 에서 투명 `<select>` 를 상자 위에 겹친다.
    - `@expo/ui` 는 쓰지 않는다.
  - 1)·2)·4)는 맞다. 웹 `page.tsx:670-680, 826, 847`, Expo `useWaitingBoard.ts:127,149`, `boardCache.ts:21`, `api.ts:30` 을 확인했다.

- **G5a-09 (P0)**
  - 문제:
    - ① 핀 링 키프레임은 0→70% 에서 끝나고 70~100% 는 멈춘다(`LoadingReveal.tsx:36-41`). "2100ms 반복"만 적으면 쉬지 않는 링이 된다.
    - ② 머리 장식 원은 `blur-2xl`(:103)인데, 고칠 방법의 흐림 없는 128px 원은 딱딱한 원판이 된다.
    - ③ 고스트는 `filter: blur(8px)` + 숨쉬기(9↔6px, 2.6s), 판은 `ns-skel` 시머다(:25-70). 고스트 목록에서 `h-3.5 w-3/4 bg-muk/30` 줄(:160)이 빠졌다.
    - ④ `Skeleton` 은 색을 못 바꾼다(Skeleton.tsx — 한지 진 고정). 그래서 머리 칩 `bg-gold/20` 을 그릴 수 없다.
    - ⑤ 새 파일 경로가 G4b-20 과 갈린다.
  - → 바로잡음:
    1. 링: 진행값 `p = withRepeat(withSequence(withTiming(0,{duration:0}), withTiming(1,{duration:1470, easing:Easing.bezier(0.2,0,0,1)}), withTiming(1,{duration:630})), -1)`. 그 위에 `scale=0.9+1.1p`, `opacity=0.6(1−p)`. 감속 모드면 숨긴다.
    2. 장식 원: react-native-svg `RadialGradient`(gold 15%→0) 원, `right:-40, top:-48`, `pointerEvents="none"`.
    3. 고스트: `opacity:0.75` 를 기본으로 둔다. 선택으로 `filter:'blur(8px)'`(RN 0.76+ 문자열 문법. 안드로이드 12+ 에서만 적용, iOS 무시, 웹 빌드는 CSS). 저장소 규칙 7(안드로이드 흐림 없음, `components/ui/index.ts`)을 따르면 opacity 만 쓴다. 시머는 `Skeleton` 숨쉬기로 대신한다고 명시한다. 대기 상자 위에 `h-[14px] w-3/4 rounded bg-muk/30` 줄을 더한다.
    4. `Skeleton` 에 `color` prop 을 더한다. G4a-27 과 같은 이름 하나로 한다.
    5. 파일은 `components/ui/LoadingReveal.tsx` 하나(3절 4번)로 한다.
  - 나머지(진행 바 1120/1400/1960/23520ms, 80%/30% 넘침 — 31번 쌍에서 둘째 판이 섹터 밖으로 나간 것을 확인) 는 맞다.

- **G5a-11 (P1)**
  - 문제: 같은 Text 에서 "최대 2줄로 그려 onLayout 으로 세고 numberOfLines 로 자르는" 방식이면 이런 일이 생긴다.
    - 자른 뒤 다시 오는 onLayout 이 원래 줄 수를 '잘린 줄 수'로 덮어쓴다.
    - 0 이 된 문단은 언마운트되어 다시 잴 수 없다.
    - 폭이나 글꼴이 바뀌면 복구되지 않는다. 웹은 매번 clamp 를 풀고 다시 잰다(`page.tsx:261-281`).
  - → 2)를 바꾼다.
    - 소개 블록 안에 보이지 않는 측정용 사본을 둔다: `position:'absolute', left:0, right:0, opacity:0`, `pointerEvents="none"`, 접근성 숨김.
    - 사본의 세 문단은 늘 `numberOfLines={2}` 로 그리고, 높이 ÷ 줄 높이(16.5·13.75)를 `Math.round` 해 `lines` 로 쓴다.
    - 보이는 쪽은 `fitWholeLines(블록 높이, [{lineHeight,lines,gapBefore}])` 결과로 numberOfLines 를 정한다.
  - 코드상 근거: NativeWind 가 `flex-1` 을 `flexBasis:'0%'` 로 낸다(`react-native-css-interop/dist/css-to-rn/parseDeclaration.js:637-640`). 부모 높이가 정해지지 않았으니 몸통은 내용 크기로 풀리고, `flexBasis:0`(숫자)인 소개 블록만 카드 높이에서 빠진다. 그래서 네이티브에서도 웹처럼 동작한다.

- **G5a-19 (P1)**
  - 추가할 것:
    1. 버튼이 21px 이므로 `hitSlop={{top:12,bottom:12,left:4,right:4}}` 를 준다(저장소 규칙 11).
    2. 로컬 예약만 쓰고 `getExpoPushTokenAsync` 는 부르지 않는다. `docs/MOBILE_PRIVACY_DRAFT.md` §1 '푸시 없음'이 계속 참이 되게.
    3. `app.json` plugins 에 `expo-notifications` 를 넣는다. 안드로이드 13 POST_NOTIFICATIONS 는 플러그인이 넣는다. 날짜 트리거라 정확한 알람 권한은 필요 없다.
    4. 시작 시각이 지났으면 웹처럼 즉시 알린다(`GoldenHourBadge.tsx:92-94` delay 0). 네이티브는 `trigger:null` 로 한다.
    5. 저장 화면과 같은 컴포넌트다(3절 8번).

- **G5a-22 (P1)**
  - `M:components/ui/ErrorState.tsx:82-111` 는 없는 줄이다(파일이 69줄). 실제는 `:30-68`(Card 37-67, 버튼 50-66)이다. 내용 서술은 맞다.
  - 화면 전용 `BoardError` 로 할지 공용 변형으로 할지는 3절 9번.

- **G5a-25 (P2)**
  - `aria-level` 은 RN 타입에 없다(`ViewAccessibility.d.ts` 에는 aria-busy·aria-expanded 만). 그대로 쓰면 `tsc` 가 깨진다.
  - → `{...(Platform.OS==='web' ? ({'aria-level':2} as object) : null)}` 처럼 쓴다.
  - `aria-busy` 는 그대로 된다. RN-web 0.21.4 `createDOMProps` 는 `aria-busy/level/pressed` 를 DOM 에 내지만 `accessibilityState` 객체는 무시한다.

### G5b

- **G5b-01 (P0)**
  - ① 5)의 "웹은 /mypage 이동(BottomNav.tsx:68-77)" 은 틀렸다.
    - `handleTabClick` 첫 줄이 `if (tab.id === activeTab) return;`(:69)이고, `/mypage/*` 에서 활성 탭은 '마이'(:55)다. 그래서 하위 화면에서 '마이'를 눌러도 웹은 아무 일도 하지 않는다.
    - Expo 중첩 Stack 은 기본으로 맨 위로 돌아간다(popToTop).
    - → 결정 필요: (a) 플랫폼 관례 유지(권장, PORTING 에 차이로 기록) / (b) 웹과 같게 `<Tabs.Screen name="mypage" listeners={({navigation})=>({tabPress:(e)=>{ if(navigation.isFocused()) e.preventDefault(); }})}/>`.
  - ② "80px(globals.css:74)" 는 데스크톱 값이다. 폰 폭은 `:237` 의 **116px** 다(G5a-03 이 맞다).
  - ③ G2-G02 와 같은 이동이다 — 3절 2번.

- **G5b-02 (P1)**
  - 문제: 뒤로 라벨 기준이 섞였다. inquiries 는 웹의 잘못된 라벨('내 문의', :115)을 그대로 옮기고, support 만 새로 준다.
  - → 두 화면 모두 `settings.backAria` 로 한다. 웹 두 결함(inquiries:115, support:83-88 라벨 없음)은 HANDOVER 웹 항목에 적는다.
  - 두 화면의 머리는 스크롤형으로 한다 → G5b-R02.

- **G5b-03 (P1)** — 원인은 맞지만 네이티브 설명과 수정 코드를 고친다.
  - ① "안드로이드 NativeWind 도 승자가 정해져 있지 않다" → **정해져 있고, 웹 빌드와 같다.**
    - Tailwind 3.4.19 는 후보 클래스를 알파벳순으로 정렬해 CSS 를 만든다(`tailwindcss/lib/lib/expandTailwindAtRules.js:183-189`).
    - css-interop 은 네이티브에서도 그 CSS 순서로 고른다(`runtime/native/native-interop.js:236-242, 569-596`, `specificityCompare` 의 Order).
    - 결과: 같은 속성이면 이름이 알파벳 뒤인 클래스가 이긴다.
      - `bg-white` 는 `bg-white/NN` 말고 모든 `bg-*` 를 이긴다.
      - `border-line` 은 gold·jade·dan-red·hanji 계열을 이기고, muk·sky·terracotta·transparent·white 계열에는 진다.
      - `rounded-2xl` 은 `rounded-3xl·xl·lg·full` 에 진다(덮어쓰기가 원래 된다).
    - 그러므로 **안드로이드에서도 같은 흰 카드가 나온다.**
  - ② 영향 범위: `<Card` 전수 조사 결과, 현재 영향은 G5b 파일뿐이다.
    - mypage.tsx:155 · :184 · :271
    - coupons.tsx:113(흐린 카드 bg, 사용 가능 카드 border)
    - impact.tsx:56 · :71
    - AccountSection.tsx:60
    - ImpactSummaryCard.tsx:26
    - 다른 묶음의 현재 Card 는 괜찮다: HomeOverlays.tsx:66 `bg-white/95` 은 이기고, parts.tsx:46 terracotta 와 VisitCheckCard `rounded-3xl` 도 이긴다.
  - ③ 제안 정규식은 `border-dashed`·`border-solid`·`border-[1.5px]` 를 색으로 잘못 본다. 그러면 기본 border-line 이 빠지고 RN 기본 검정 테두리가 된다.
    - → `/^border-(?!(?:[trblxyse]{1}(?:$|-)|\d|\[\d|(?:solid|dashed|dotted|double|hidden|none)$))/` 로 바꾼다.
  - ④ 여백도 같은 규칙으로 정해진다(`p-[12px]`·`p-5` 는 `p-[16px]` 에 진다). → 다른 여백은 `padded={false}` 와 함께 준다고 명시한다.

- **G5b-04 (P1)**: `p-[20px]` 등은 `padded={false}` 와 함께 준다(위 ④). `rounded-3xl` 은 G5b-03 전에도 이기지만, 그 뒤에 적용하는 순서는 유지한다.

- **G5b-05 (P1)** — 대비 수치를 정정한다.
  - 흰 글자 / #c19a3e = **2.64:1** 이다. 큰 글자 기준 3:1 에도 못 미친다.
    - 금 진 #705819 = 6.78:1, cta 양끝 5.05 / 5.86:1.
    - Expo `ErrorState.tsx:28` 주석의 3.7:1 도 틀린 수치다.
  - 저장소 규칙: `docs/DESIGN_PRINCIPLES.md:107` '주 버튼 ≥4.5:1'. 웹 `lib/contrast.test.ts:17-18` 은 이 색을 '기준 미달 예전 버튼'으로 못박아 두었다.
  - → 권장을 (A)에서 다음으로 바꾼다: 모양(높이 30/50/56, rounded-lg/xl/2xl, 12/14/16px, 아이콘·그림자 없음)은 웹대로 하고, 바탕은 `bg-gold-deep` 단색으로 한다.
  - 웹의 bg-gold 흰 글자 버튼(마이 모달 저장·쿠폰 사용·공유·실험실/문의 보내기·완료, 공용 `components/ErrorState.tsx:20`)은 웹 결함으로 기록한다.
  - (A)를 고르면 규칙 위반을 앱으로 옮긴다는 점을 결정 문구에 쓴다. G1-20 과 한 결정이다.

- **G5b-07 (P0)**
  - ① @2x·@3x 는 필요 없다. 원본 505×109(약 3.9배) 한 장을 `width:130, height:28` 로 쓴다. G4a-01 이 같은 파일을 만드니 한 번만 넣는다.
  - ② 언어 알약은 SelectField → ModalSheet 라서 Expo 웹 빌드에서는 G2-G07 전까지 열리지 않는다.
  - ③ 새 키 `app.mypage.languageSelect` 는 G1-04·G2-10 과 하나로 한다(3절 7번). 기존 `settings.langTitle` 을 접근성 이름으로 쓰면 새 키가 필요 없다.

- **G5b-09 (P0)**
  - 소셜 노출 규칙 함수가 둘이다.
    - `accountCore.ts:12-14 visibleProviders`: 안드로이드 ['google'] 하드코딩
    - `socialPolicy.ts:17-24 socialProvidersFor`: `KAKAO_LOGIN_ENABLED` 스위치
  - 지금은 카카오를 켜도 마이 카드에는 나오지 않는다.
  - → (A)/(B) 어느 쪽이든 `visibleProviders` 가 `socialProvidersFor` 를 부르게 해서 G1-23 과 스위치 하나로 만든다.
  - (B)는 안드로이드 버튼이 하나뿐이라 눈에 보이는 변화가 높이 48→44 와 바탕(G5b-03)뿐이다.

- **G5b-14 (P1)** — 눈금·고리가 틀렸다.
  - 웹 recharts 3.9.2 의 암묵 반지름 축은 눈금 5개·정수로 [0,max] 를 둥글린다(`node_modules/recharts/lib/util/scale/getNiceTickValues.js:51-64,159-209`).
    - 균등 35 → [0,9,18,27,36] — 97%, 거의 꽉 참
    - 학습 최댓값 90 → [0,25,50,75,100] — 90%. learned 쌍 크롭에서 꼭짓점이 바깥 고리 안쪽에 있는 것을 확인했다.
  - `v/max` 는 학습 상태에서 꼭짓점을 바깥 고리에 붙인다(웹과 다름).
  - 보이는 고리는 **4겹(0.25 간격)** 이다. 0 눈금 고리는 점이다. 지금 `RINGS=[0.25,0.5,0.75,1]` 을 유지하고, "5겹(0.2~1.0)" 은 버린다.
  - → `tasteCore.ts` 에 아래 함수를 두고 `ratio = v / radarNiceMax(Math.max(...values))` 로 한다. 1~100 전 구간에서 recharts 와 0건 불일치를 대조했다.
    ```ts
    export function radarNiceMax(max:number):number{ if(!(max>0)) return 1; const r6=(n:number)=>Math.round(n*1e6)/1e6;
      for(let c=0;c<20;c++){ const rough=max/4, d=Math.floor(Math.log10(rough))+1, unit=10**d, s=d!==1?0.05:0.1;
        const step=Math.ceil(r6((Math.ceil(r6(rough/unit/s))+c)*s*unit)); if(Math.ceil(r6(max/step))<=4) return step*4; } return max; }
    ```
  - 바퀴살 8·점 삭제·크기·배지·로딩은 원안대로 한다.

- **G5b-17 (P1)**
  - ⑥ 토스트: sonner-native 0.27.0 은 이름 붙은 Toaster 를 지원한다(`<Toaster id>` + `toast(…,{toasterId})`, `lib/typescript/src/types.d.ts:47-49,88-93`).
    - → RN Modal 안에 `<AppToaster id="profileEdit"/>` 를 두고(`AppToaster` 에 `id` 를 넘길 수 있게 한다) 실패 토스트에 `toasterId` 를 준다.
    - RN Modal 은 유지한다. 웹 오버레이는 `absolute inset-0 z-50`(page.tsx:782)으로 하단 탭(`z-40`, BottomNav:156)까지 덮는다. 절대 배치 오버레이로 바꾸면 탭 막대를 덮지 못한다.
  - ① 흐림: expo-blur 57 안드로이드는 `blurMethod` + `BlurTargetView` 가 있어야 흐리고(기본 none), RN Modal 은 별도 창이라 뒤 화면을 흐릴 수 없다.
    - → 안드로이드는 `bg-muk/40` 만 쓴다. iOS·웹만 `BlurView`(intensity 약 20, light)를 쓴다.

- **G5b-18 (P1)**
  - `router.replace('/')` → `router.navigate('/')` 로 한다(탭 전환. 다른 Expo 코드와 같다, waiting.tsx:46).
  - G1 이 랜딩에 해당하는 화면을 만들면(G1-01/02 결정) 그쪽으로 보낸다.

- **G5b-23 (P1)**
  - `48%`/`48.5%` + gap 은 반올림 때문에 넘친다. 타일 줄 안쪽 폭 278(342−64)에서 0.48·278·2+12 = 278.9 > 278 이라 둘째 칸이 내려가 1열이 된다. px16 그대로여도 294.2 > 294 로 같다.
  - → 두 개씩 `flex-row gap-[12px]` 줄로 묶고, 칸은 `flex-1` 로 한다. 홀수 마지막 줄에는 빈 `<View className="flex-1"/>` 를 둔다. 지표 격자도 같은 방식으로 gap 8.

- **G5b-24 (P1)**: 웹 시작 카드 `border-gold/30`(impact:135)을 Card 로 그리면 G5b-03 전에는 진다. 의존에 G5b-03 을 더한다. 버튼 색은 G5b-05 결정을 따른다.

- **G5b-30 (P0)** — 이기는 쪽을 바로잡는다.
  - 정본은 Expo 13절 화면이 아니라 법무 검토를 거친 `docs/MOBILE_PRIVACY_DRAFT.md` 다. 문서 머리가 "검토 뒤 웹 /mypage/privacy 와 앱 화면 문구를 이 문서에 맞춘다"고 정해 두었다.
  - 웹 페이지는 스토어 개인정보 처리방침 URL 이다(같은 문서 체크리스트 '웹 문안 맞추기'). 웹이 앱보다 짧은 지금이 공백이다.
  - Expo '웹에서 전체 안내 보기'(privacy.tsx:73-80)는 더 짧은 웹을 '전체'라고 가리켜 거꾸로다. 웹을 갱신하기 전까지 버튼 노출이나 문구를 정해야 한다(결정 필요).
  - 날짜는 둘 다 시행일이 아니다. 10-31 은 웹 부정 이용 방지 절을 넣은 날, 11-02 는 초안을 쓴 날이다. 검토 뒤 하나의 시행일로 맞춘다.
  - Expo 는 문안 변경 금지를 유지한다.

- **G5b-32 (P1)**: G2-G07 의존을 명시한다. G5a-05·G4b-08(control)과 G1-04·G2-10(pill)을 `SelectField` 하나로 묶는다(3절 7번).

- 나머지 확인 결과 인용과 사실이 맞았다: G5a-01·04·06·12·15·16, G5b-08·10·11·12·15·16·20·21·25·27·28·33·34·35·37.

## 3. 묶음 간 충돌·공용 컴포넌트
(근거: 다른 묶음의 지시는 digest 한 줄 + 코드로 확인했다. G1~G4b findings 본문의 변형·prop 이름까지 대조하지는 못했다 — 구현 전에 각 묶음 본문과 한 번 더 맞출 것.)

1. **`components/ui/Card.tsx` 기본 클래스**(G5b-03 ↔ 모든 묶음)
   - 이 수정을 가장 먼저 한다. 다른 묶음의 새 화면이 Card 에 `bg-*`·`border-gold/jade/…` 를 주는 순간 같은 버그가 난다.
   - 그때까지 다른 묶음은 Card 대신 style 로 색을 준다(ErrorState.tsx:41 방식).

2. **하위 화면 하단 탭·스택**(G5b-01 ↔ G2-G02 ↔ G4a-15, + G5b-02)
   - G2-G02 가 `app/mypage/*`·`(tabs)/mypage.tsx`·`explore/recommend.tsx` 이동을, G5b-01 이 같은 mypage 이동을 따로 적었다.
   - → 한 PR, 한 담당으로 한다.
     - mypage: G5b-01 안(`(tabs)/mypage/_layout.tsx` + `unstable_settings.initialRouteName='index'`).
     - explore/recommend: 웹 활성 탭이 '홈'(BottomNav:56)이므로 `(tabs)/index` 쪽 스택으로 옮긴다.
   - 머리: G5b-02 `SubPageHeader` 와 G4a-15 '지도 보기' 머리를 같은 공용 머리 컴포넌트 변형으로 한다.

3. **탭 화면의 뒤로 버튼**(G5a-01 ↔ G4b-02 ↔ G4a-15)
   - 같은 질문(탭 화면에 웹의 뒤로 원을 둘지)이다. 결정은 하나로 한다.
   - 모양은 웹 44px 원 `bg-white/90 border-line` + 그림자 `0 2px 10px rgba(43,35,32,0.1)` 로 같다. 목적지는 모두 `router.navigate('/')`. 공용 `components/ui/BackCircleButton.tsx` 하나.

4. **LoadingReveal**(G5a-09 `features/waiting/LoadingReveal.tsx` ↔ G4b-20 `components/ui/LoadingReveal.tsx`)
   - → `components/ui/LoadingReveal.tsx` 하나로 한다. 웹도 한 컴포넌트에 waiting·course·shared 변형이 있다.
   - 화면별 스켈레톤은 children 으로 넘긴다.

5. **NowChip·GoldenHourLabel**
   - NowChip(G5a-04 `features/waiting/NowChip.tsx` · G4a-03 같은 파일 · G4b-06 새 `components/ui/NowChip.tsx`)
     - 지금 waiting·saved 가 import 하고, course 는 따로 그린다(course.tsx:46).
     - → `components/ui/NowChip.tsx` 로 옮겨 세 화면이 쓰고, `features/waiting/NowChip.tsx` 는 지운다.
   - GoldenHourLabel(G5a-12·19 ↔ G4a-09): 저장 화면 SavedCard.tsx:8 도 쓰는 공용이다. 한 담당이 고친다.

6. **사진 없는 표지·출처**
   - 경로가 갈린다: G5a-15·G4a-19 `components/PlacePhotoFallback.tsx` ↔ G4b-12·G3-08 `components/ui/PlacePhotoFallback.tsx`.
     - → `components/ui/PlacePhotoFallback.tsx` + `components/ui/index.ts` export 로 한다.
   - 출처 판정 모듈도 둘이다(`features/explore/port/photoCredit.ts`, `features/recommendation-card/photoCredit.ts`).
     - → port 판(커서 함수 포함)으로 합친다.
   - 출처 줄은 G5a-16 의 `components/ui/CreditLine.tsx` 하나로 PhotoCover·CardPhoto·대기 카드가 함께 쓴다.

7. **선택 상자 묶음**
   - 관련: 가정 시간(G5a-05 ↔ G4b-08 `TimeSimControl` ↔ G4b-23 ↔ G2-24), 언어 알약(G5b-07·32 ↔ G1-04 새 `components/LanguageSwitcher.tsx` ↔ G2-10 `LanguagePill(.web).tsx`), 문의 유형(G5b-32).
   - → `lib/core/assumedTime.ts` 는 G5a-05·G4b-08 경로가 같으니 그대로 하나로 한다.
   - UI 는 `components/ui/SelectField.tsx` 하나로, variant 셋을 둔다.
     - `control`: 가정 시간
     - `pill`: 언어, 웹 LanguageSwitcher.tsx:13 모양
     - `field`: 문의 유형
   - 열림은 `ModalSheet`. **G2-G07/G3-21 의 `ModalSheet.web.tsx` 를 먼저 하거나, 그 전까지 `SelectField.web.tsx` 에서 `<select>` 를 쓴다.**
   - 언어 접근성 이름 키는 하나(새 키를 만든다면 4로케일을 한 사람이)로 하거나 `settings.langTitle` 을 재사용한다.

8. **알림**(G5a-19 골든 '알림 받기' ↔ G4a-06(저장 토글 + 골든) ↔ G5b-10(마이·설정 토글) ↔ G3-18)
   - → 결정을 둘로 나눈다.
     - (가) 골든 '알림 받기' = 로컬 예약이라 서버가 필요 없다. 공용 `lib/platform/notify.ts`(네이티브 expo-notifications · 웹 Notification) + `GoldenHourLabel` 하나로 대기·저장·카드에 동시에 반영한다.
     - (나) 혼잡 알림 토글 = 백그라운드 조회나 서버 푸시가 필요하니 v1.1 로 한다.
   - expo-notifications 추가·재빌드는 (가)에 한 번만 한다.

9. **ErrorState·EmptyState**
   - 관련: G5a-21/22 화면 전용 새 파일 ↔ G4a-28·G4b-21 공용 ErrorState 변경 ↔ G2-06/07 ↔ G4a-10/29 ↔ G4b-22 ↔ G5b-21/24/25 ↔ G1-32.
   - 웹 자체가 두 모양이다.
     - 공용 `components/ErrorState.tsx`: ⚠️ text-3xl, text-sm semibold, `bg-gold text-xs` 버튼 — course·explore
     - 대기 전용: 36px, 15px bold, cta 알약
   - → 공용 `ErrorState` 에 `variant: 'compact'|'board'` 를 둔다. `role="alert"`·알림 낭독은 유지한다. 대기는 `variant="board"` 로 쓰고 새 `BoardError.tsx` 는 만들지 않는다.
   - Empty 도 같은 원칙으로 한다. 공용 `EmptyState` 에 `variant` 와 `action.kind='ctaPill'` 을 두고, 대기·저장·대안 빈 상태(cta 알약 CTA)가 함께 쓴다.
   - 마이 하위 화면 전용(StateCard·InlineState)은 마이 안에서만 쓴다.
   - 버튼 색은 10번 결정을 따른다.

10. **Button 변형 + 금 대비**(G1-20 ↔ G5b-05 `gold`+size xs~xl ↔ G5b-12 `hanji` ↔ G5b-34 `dangerSoft/dangerOutline` ↔ G4b-22 ↔ G4a-21)
    - → `Button` 에 `variant`(primary=cta · solid · secondary · hanji · dangerSoft · dangerOutline · ghost)와 `size`(xs·sm·md·lg·xl) 표를 G1-20 담당이 한 번에 만들고, 나머지는 그 이름을 쓴다.
    - 금 단색 흰 글자는 2.64:1 이다. 2절 G5b-05 의 권장(solid = gold-deep)을 G1-20·공용 ErrorState 버튼에도 같은 결정으로 적용한다.

11. **Chip 선택색·접근성**(G5b-27 `variant="lab"` ↔ G4a-05 ↔ G4b-18(금 선택) ↔ G5b-06 ↔ G1-34 `Pressable` 일괄)
    - → `Chip` 기본(비취, 홈 칩)은 유지하고, `selectedTone="gold"` prop 하나를 저장·코스·실험실이 함께 쓴다.
    - 높이·크기는 `size`.
    - aria 는 G1-34 안대로 `components/ui/Pressable.tsx` 한 곳에서 웹 빌드만 `accessibilityState` 를 바꾼다.
      - role=button 의 `selected` → `aria-pressed`
      - expanded/busy/checked → `aria-*`
    - 그러면 G5b-06 의 Chip·TasteRadar 개별 수정은 없앤다.

12. **Text 줄 높이·줄바꿈**(G2-G05·G06 ↔ G5a-08·13 ↔ G4b-14)
    - G2-G05 기본 1.5배는 `className` 에 `leading-` 가 없을 때만 넣어야 한다(`withDefault`). style 로 넣으면 NativeWind 클래스(`leading-[…]`)를 덮어 G5a-08 의 명시값이 모두 무시된다.
    - 한국어 keep-all 은 G2-G06(`+html.tsx`·`I18nProvider.tsx`)과 G5a-13(`Text.tsx` 웹 분기) 중 **한 곳만** 고친다. 전역 CSS 로 하면 G5a-13 은 지운다.

13. **광원**(G4a-14 새 `components/ui/Glow.tsx` ↔ G5a-02 `BoardGlow` ↔ G5b-20 · G5b-31 · G5b-R01 ↔ G1-21)
    - → `Glow({ color, opacity, size, position, scroll })` 하나(react-native-svg RadialGradient)로 한다.
    - 대기는 스크롤 안, 쿠폰·개인정보·설정은 스크롤 밖에 고정한다(웹 `h-[100dvh]` 틀).

14. **확인창·토스트**(G5b-35 `confirmDestructive` ↔ G4a-12 '전체 초기화' ↔ G3-34·G2-G09 Toast 전역 ↔ G5b-17)
    - → `features/mypage/confirm.ts` 를 `components/ui/confirmToast.ts` 로 옮겨 저장 화면과 함께 쓴다. sonner-native `action/cancel/onDismiss/onAutoClose` 를 지원한다.
    - 모양은 G3-34 의 Toast 결정을 먼저 정한 뒤에 맞춘다.

15. **Icon `fill`**(G5b-12 ↔ G4a-02): `components/ui/Icon.tsx` 에 `fill?: ColorToken|string` prop 하나를 둔다. color 와 같은 토큰 해석을 쓴다.

16. **로고 자산**(G5b-07 ↔ G4a-01): `assets/images/nextspot-logo.png` 한 장(원본 그대로)을 한 PR 에서 넣는다.

17. **`lib/theme/tokens.ts`+`tokens.test.ts`**(G5b-03 gradients 4종 ↔ G1-21 ↔ G3-11 ↔ G4a-24): 같은 파일·테스트를 고친다. 순서대로 한 담당이 넣는다(병렬 수정 금지).

18. **소셜 노출 규칙**(G5b-09 ↔ G1-23): 2절 G5b-09 대로 `socialProvidersFor` 하나로 한다.

## 4. 확인 결과 요약
- 확인한 P0 12건(G5a 4 · G5b 8) 중 정정 6건: G5a-05, G5a-09, G5b-01, G5b-07, G5b-09, G5b-30
- 확인한 P1 29건(G5a 8 · G5b 21, 전체 30건 중) 중 정정 13건: G5a-11, G5a-19, G5a-22, G5b-02, G5b-03, G5b-04, G5b-05, G5b-14, G5b-17, G5b-18, G5b-23, G5b-24, G5b-32
- P2 정정 1건(G5a-25)
- 새 항목 2건(P0 0 · P1 0 · P2 2): G5b-R01 설정 광원, G5b-R02 문의·고객지원 머리 스크롤
- 추가 촬영:
  - `scratch/parity/shots/R3/inq-scrolled-420.{web,expo,pair}.png`
  - 스크립트 `scratch/parity/work/R3/01-inquiries-scroll.mjs`(GET mock 만, 쓰기 0, 새 게스트 0)
  - 보조 검산 `C:\Users\OWNER7\AppData\Local\Temp\claude\0fa2f3b7e932577a\1ac09600-324c-458f-a226-e2c4dc6c9bcf\scratchpad\nicemax.mjs`(레이더 눈금, recharts 와 대조)
- 결론을 바꾸는 주장의 근거 파일:
  - Tailwind 정렬: `tailwindcss/lib/lib/expandTailwindAtRules.js:183`
  - css-interop: `native-interop.js:569`
  - RN-web aria: `createDOMProps/index.js:164,243,279`
  - recharts: `getNiceTickValues.js`
  - sonner-native: `types.d.ts:47-93`
  - expo-blur 57: `BlurView.types.d.ts:22-60`
  - 대비 계산: 흰/#c19a3e 2.64, 흰/#705819 6.78
