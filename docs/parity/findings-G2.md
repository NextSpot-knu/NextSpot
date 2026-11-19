# G2 홈 지도·상단·도구 + 전역 모양 — 웹(기준) ↔ Expo 차이

- 작성: 2026-11-10 G2 에이전트.
- 비교 대상: 기준은 `apps/web`(localhost:3000 정적 빌드), 비교는 Expo 웹 빌드(`https://nextspot.expo.app`). 두 앱 모두 390×844 @2x, ko-KR, Asia/Seoul, 경주 GPS(35.838, 129.21)로 열었다.
- 촬영: `scratch/parity/work/G2/*.mjs` 로 찍었다(하네스 `openPair` 만 사용, 쓰기 0 — 정책 로그 `logs/runs/G2-*`). 결과는 `shots/G2/*.pair.png` 58쌍이다.
- 수치: `work/G2/metrics/*.json`(DOM 계측: 상자·글꼴·색·테두리·그림자).
- 표기: `W:` = `apps/web/`, `M:` = `apps/mobile/`. 줄 번호는 `yunseong` `c6374ab` 작업 트리 기준이다.
- 촬영 요령(다른 묶음에도 유용): **웹 카카오 마커는 마우스 클릭에 반응하지 않는다**(기기 설정이 `hasTouch`). `page.touchscreen.tap(x,y)` 로 눌러야 카드가 바뀐다. Expo 오버레이 마커는 둘 다 받는다.

## 요약

| 중요도 | 개수 | 항목 |
|---|---|---|
| P0 | 19 | G2-G01, G2-G02, G2-G07, G2-09, G2-10, G2-11, G2-12, G2-13, G2-14, G2-16, G2-19, G2-24, G2-25, G2-26, G2-27, G2-30, G2-31, G2-32, G2-34 |
| P1 | 19 | G2-G03, G2-G04, G2-G05, G2-G06, G2-G09, G2-01, G2-03, G2-04, G2-05, G2-06, G2-07, G2-08, G2-15, G2-17, G2-20, G2-21, G2-22, G2-28, G2-33 |
| P2 | 5 | G2-G08, G2-02, G2-18, G2-23, G2-29 |
| 합계 | 43 | `결정 필요` 11건(G2-G01 콘솔 링크, G2-G03 안드로이드 흐림, G2-01, G2-04, G2-09, G2-12, G2-14, G2-21 적재 요청, G2-24, G2-25 주차장 탭, G2-32), `네이티브 확인 필요` 6건(G2-G03, G2-G05, G2-G06, G2-G07, G2-G08, G2-10) |

일치하는 것(차이 아님):
- 색 토큰 값: `M:lib/theme/tokens.ts:11-77` 와 `W:app/globals.css:77-106` 이 같다. 실측 gold-deep `rgb(112,88,25)`, muk-soft `rgb(107,93,79)`, 바탕 `rgb(250,245,236)` 모두 양쪽 같다.
- 한국어 글꼴: 둘 다 Freesentation, 굵기 400~800 매핑도 같다.
- 핀 SVG·크기: 26×33, 순위 34×43, 선택 42×53. 공용 `@/lib/map/markerSvg` 를 쓴다.
- 지도 타일 채도 필터: `saturate(55%) brightness(103%)`.
- 축제 영역 원의 색·반경.
- 화면 위 여백: 둘 다 위 8px.

가장 중요한 5가지:
1. **하단 탭 막대(G2-G01·G02):** 웹은 101px 유리 막대에 안내 줄과 활성 알약이 있고 하위 화면에도 나온다. Expo 는 49px 한지 막대이고 하위 화면에는 막대가 없다.
2. **홈 상단 머리(G2-10·11·13·14):** 언어·출처·시계 묶음, 유리 검색창과 마스코트, ✨ 칩이 없고, 둘째 줄 구성이 다르다.
3. **칩 줄·음식 줄·필터 시트(G2-25·26·27):** 아이콘·주차장 탭이 없고, 음식 칩 줄이 홈에 따로 있으며, 시트 구성이 다르다.
4. **Expo 웹 빌드에서 `ModalSheet` 가 열리지 않는다(G2-G07):** 홈 도구 6종이 모두 그렇다.
5. **예측 띠·음성 비서가 없다(G2-24·12, 결정 필요).** 이 밖에 검색 동작(G2-19)과 제안 카드 버그(G2-30)도 크다.

---

## 전역 모양 (G2-Gxx) — 다른 묶음이 먼저 볼 것

### G2-G01 하단 탭 막대 — 높이·재질·안내 줄·활성 알약·아이콘/글자 크기

- **화면·상태:** 모든 탭 화면(G2-NAV-01·02·04). `/main`·`/saved`·`/waiting`·`/course`·`/mypage`
- **스크린샷:** `shots/G2/nav-home-clip.pair.png`, `nav-saved`·`nav-waiting`·`nav-course`·`nav-mypage.pair.png`, `home-default.pair.png`
- **웹(기준):** `W:components/shell/BottomNav.tsx:154-214`
  - 막대: `md:hidden fixed bottom-0 left-0 w-full z-40 bg-white/90 backdrop-blur-xl border-t border-line shadow-[0_-2px_14px_rgba(43,35,32,0.06)] px-6 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]`. 실측 `0,743,390×101`, 바탕은 흰 90% + 흐림 24px.
    - 지도 위에 **겹쳐** 떠 있다. 그래서 `/main` 지도가 막대 뒤까지 이어지고, 카카오 축척·로고는 막대 뒤에 가려진다.
  - 안내 줄(`:159-178`): `mb-1 flex h-8 items-center justify-between gap-1 border-b border-line pb-1`.
    - 왼쪽은 `GuideButton compact`(`W:components/guide/GuideProvider.tsx:13-24`): `CircleHelp` 20px + `서비스 소개` 12px medium muk-soft. `aria-label`=`guide.title` "NextSpot 알아보기"이고, 누르면 소개 `<dialog>` 가 열린다.
    - 오른쪽은 콘솔 링크 둘: `Store`/`Landmark` 14px + `nav.merchantShort` "사장님 콘솔" · `nav.adminShort` "관제 대시보드". 모양은 `inline-flex min-h-8 gap-1 rounded-lg px-1.5 text-xs font-medium text-muk-soft`.
    - 링크 목적지는 `W:lib/consoleLinks.ts:23-28` 이 정한다. 기본은 `/merchant?demo=1`·`/admin/dashboard?demo=1` 이고, 역할이 있으면 실제 콘솔이다.
  - 탭 줄(`:179-212`):
    - 칸: 5칸 `flex-1 h-12`(실측 68×48), 아이콘 22px.
    - 글자: `text-[11px] font-medium whitespace-nowrap`(줄높이 16.5px). `지금 출발하면?` 만 `text-[10px] tracking-tight`(`:45`, 실측 10px · 자간 −0.25px).
    - 색: 활성 `text-gold-deep`, 비활성 `text-muk-soft`.
    - 활성 표시: 칸 가운데 `h-12 w-14 rounded-2xl bg-gold/15` 알약(56×48)이 framer `interactionSpring` 으로 옆으로 미끄러진다(`:182-191`).
    - 누르면 `haptic('selection')` 이 나고, 누른 탭이 바로 활성으로 바뀐다(낙관적 활성).
  - 페이지 여백: 폰은 `--tourist-nav-clearance: 116px`(`W:app/globals.css:235-238`).
- **Expo(현재):** `M:app/(tabs)/_layout.tsx:42-79` — React Navigation 기본 탭 막대다.
  - 실측 `0,795,390×49`. 바탕은 `hanji` 불투명, 위 1px `line`. 그림자·흐림·안내 줄·활성 알약이 없다.
  - 탭 칸 78×48(좌우 여백 0), 아이콘 25px.
  - 글자는 11px Freesentation-5Medium, 줄높이 normal. `지금 출발하면?` 도 11px.
  - 지도가 막대 위에서 끝나서 카카오 `100m kakao` 가 막대 바로 위에 보인다.
- **차이:**
  - 높이 101 vs 49. 화면 아래가 52px 다르니 시트·카드·목록 끝 위치가 전부 달라진다.
  - 재질: 흰 유리 vs 한지 불투명.
  - 웹에만 있는 것: 안내 줄, 활성 알약, 좌우 24px 여백. 웹 막대는 지도 위에 겹치고 Expo 막대는 겹치지 않는다.
  - 크기: 아이콘 22 vs 25, 대기 탭 글자 10px+자간 vs 11px.
- **중요도:** P0
- **분류:** 배치 · 누락 · 크기·간격 · 색·효과
- **고칠 방법:**
  1. 기본 탭 막대를 웹 구조의 막대로 바꾼다.
     - 새 파일 `M:components/navigation/TouristTabBar.tsx` 를 만든다.
     - `<Tabs tabBar={(props) => <TouristTabBar {...props} />}>` 로 연결하고, 기존 `tabBarStyle`·`tabBarLabel`·`tabBarIcon` 은 지운다.
  2. 바깥 판:
     - 자리: `position:absolute, left:0, right:0, bottom:0`. 웹처럼 화면 위에 겹친다.
     - 모양: `backgroundColor 'rgba(255,255,255,0.9)'`, 위 테두리 1px `colors.line`, `boxShadow '0px -2px 14px rgba(43,35,32,0.06)'`, `paddingHorizontal 24`, `paddingTop 8`, `paddingBottom 8+insets.bottom`.
     - 흐림은 G2-G03 의 `Glass` 방식을 따른다: 웹 빌드는 `backdropFilter 'blur(24px)'`, iOS 는 `BlurView`, 안드로이드는 G2-G03 결정에 따른다.
     - 막대가 겹치므로 탭 화면은 아래 여백(101 + insets.bottom, 화면별로 웹 값과 맞춤)을 직접 둔다. 홈은 지도를 끝까지 깔고, 카메라 띠 계산에 막대 높이를 넣는다(G2-01).
  3. 안내 줄:
     - 줄: 높이 32 + 아래 간격 4 + 아래 테두리 1px line + `pb-1`.
     - 왼쪽: `Pressable` 에 `CircleHelp` 20 muk-soft + `t('guide.label')` 12px medium muk-soft, gap 8, `accessibilityLabel=t('guide.title')`. 누르면 G1 이 포팅할 소개 화면을 연다. 그 전까지는 `/intro`(첫 실행 뒤 '닫기' 모드)로 보낸다.
     - 오른쪽 콘솔 링크 둘: `Store`/`Landmark` 14 + 12px medium muk-soft, `min-h 32, px 6, gap 4, radius 8`.
     - 링크를 누르면 `openExternalUrl(WEB_ORIGIN + 경로)` 로 연다. `WEB_ORIGIN` 은 `M:lib/platform/shareUrls.ts:10` 에 있다. 경로는 `@/lib/consoleLinks` 를 쓰고, check:shared 에 걸리면 경로 상수만 복사한다.
  4. 탭 줄:
     - 칸: `flex:1, height:48`, 가운데 정렬. 아이콘 `Icon size={22}`, 아이콘과 글자 사이 2px.
     - 글자: `fontFamilies.medium` 11px, `lineHeight 16.5`. 대기 탭만 10px + `letterSpacing −0.25`.
     - 색: 활성 `gold-deep`, 비활성 `muk-soft`.
  5. 활성 알약:
     - 칸 폭(100/5%) 틀 가운데에 `56×48, radius 16, rgba(193,154,62,0.15)` 를 둔다.
     - Reanimated `withSpring(index×칸폭, springs.interaction)` 으로 옮긴다(`M:lib/theme/tokens.ts:154-159`).
     - 동작 줄이기 설정이면 애니메이션 없이 바로 옮긴다.
  6. 활성 판정은 웹 `getActiveTab`(`BottomNav.tsx:50-57`)처럼 경로 포함 검사 + 낙관적 활성으로 한다. `haptic('selection')` 은 유지한다.
- **바꿀 Expo 파일:**
  - `M:app/(tabs)/_layout.tsx`
  - 새 `M:components/navigation/TouristTabBar.tsx`
  - `M:features/home/HomeScreen.tsx`
  - `M:app/(tabs)/saved.tsx`·`waiting.tsx`·`course.tsx`·`mypage.tsx`(아래 여백)
  - `M:components/ui/Toast.tsx:22`(`TAB_BAR_TOAST_OFFSET`)
- **문구(i18n):** 재사용 `nav.home`·`nav.saved`·`nav.waiting`·`nav.course`·`nav.mypage`·`guide.label`·`guide.title`·`nav.merchantShort`·`nav.adminShort`. 새 키는 없다.
- **네이티브 주의:**
  - 제스처 내비게이션 막대가 있는 기기는 `insets.bottom` 이 0이 아니다. 이 값은 `paddingBottom` 에만 더한다.
  - 막대가 내용 위에 겹치므로 `ScrollView` 의 아래 여백을 화면마다 맞춰야 한다.
  - 키보드가 떠도 막대를 숨기지 않는다(웹과 같게).
- **확인 방법:**
  - `work/G2/09-nav.mjs`·`01-default.mjs` 를 다시 돌린다. 계측에서 막대 `0,743,390×101`, 칸 68×48, 아이콘 22, 알약 56×48 을 확인한다.
  - 에뮬레이터에서 알약 이동과 햅틱을 확인한다.
- **크기·의존:** L · G2-G03, G2-G02, G1(소개 화면)
- **표시:** 결정 필요 — 콘솔 링크를 앱에 둘지
  - 선택지 ① 안내 줄 전체(콘솔 링크는 외부 브라우저로 연다)
  - 선택지 ② `서비스 소개` 만 둔다(계획 §3.3 '앱에 콘솔 없음' 유지)
  - 선택지 ③ 안내 줄 없이 65px
  - **추천 ①:** 화면 높이·모양이 웹과 같아지고, 링크가 웹 데모를 여는 것뿐이라 앱 범위가 넓어지지 않는다. 앱 심사에서 '사업자 링크'가 문제 되면 ② 로 바꾼다.

### G2-G02 하위 화면(`/mypage/*`, `/explore/recommend`)에 하단 탭이 없다

- **화면·상태:** G2-NAV-03. `/mypage/settings` 등 7개, `/explore/recommend`
- **스크린샷:** `nav-mypage-settings-full.pair.png`, `nav-recommend-full.pair.png`, `nav-mypage-settings.pair.png`
- **웹(기준):** `W:components/shell/BottomNav.tsx:38-39` 의 `NAV_ROUTES` 가 하위 경로에도 막대를 그린다.
  - `/mypage/settings` 에서는 `마이` 가 활성이다.
  - `/explore/recommend` 에서는 `홈` 이 활성이다(기본값, `:56`).
  - 실측 두 화면 모두 막대가 `0,743,390×101`.
- **Expo(현재):** `M:app/_layout.tsx:80-92` 에서 `mypage`(자기 Stack)와 `explore/recommend` 가 루트 Stack 화면이라 탭 막대가 없다. 대신 Stack 머리가 있다.
- **차이:** 하위 화면에서 탭 막대가 통째로 빠진다. 다른 영역으로 바로 갈 수 없고, 아래 101px 이 웹보다 더 보인다.
- **중요도:** P0
- **분류:** 누락 · 동작
- **고칠 방법:**
  1. `M:app/mypage/*` 를 `M:app/(tabs)/mypage/` 로 옮긴다.
     - Stack 은 `M:app/(tabs)/mypage/_layout.tsx` 가 맡는다(기존 `M:app/mypage/_layout.tsx` 헤더 설정을 그대로 옮긴다).
     - 기존 `M:app/(tabs)/mypage.tsx` 는 `M:app/(tabs)/mypage/index.tsx` 가 된다.
     - URL 은 그대로다. 그룹 폴더 이름은 URL 에 들어가지 않는다.
  2. `/explore/recommend` 는 `M:app/(tabs)/explore/recommend.tsx` 로 옮긴다.
     - `<Tabs.Screen name="explore/recommend" options={{ href: null }} />` 로 탭 버튼은 숨긴다.
     - 활성 탭은 경로로 판정해 `홈` 이 된다.
  3. 루트 `M:app/_layout.tsx:91-92` 의 두 Stack.Screen 항목을 지운다.
  4. 대안(비추천): 두 Stack 화면에 탭 막대를 직접 붙이는 래퍼. 탭 상태 연동이 어긋나기 쉽다.
- **바꿀 Expo 파일:** `M:app/mypage/*`, `M:app/(tabs)/mypage.tsx`, `M:app/explore/recommend.tsx`(모두 이동), `M:app/(tabs)/_layout.tsx`, `M:app/_layout.tsx`
- **문구:** 없음
- **네이티브 주의:**
  - 안드로이드 뒤로 가기는 탭 안 Stack 을 먼저 닫는다(기대한 동작).
  - 탭을 다시 누르면 그 탭 Stack 의 첫 화면으로 돌아가게(`popToTop`) 한다.
- **확인 방법:** `09-nav.mjs` 를 다시 돌린다. 두 full 그림에 막대가 있고 각각 `마이`·`홈` 이 활성인지 본다.
- **크기·의존:** M · G2-G01

### G2-G03 지도 위 탐색 층의 유리(Liquid Glass) 재질이 Expo 에 없다

- **화면·상태:** 홈 기본(G2-MAP-01, TOP-01, CHIP-01)
- **스크린샷:** `home-top-clip.pair.png`, `chips-row-mocked-top.pair.png`
- **웹(기준):** `W:app/globals.css:408-466` `.liquid-glass`·`.liquid-glass-phone`
  - 바탕: `rgba(250,245,236,0.35)`.
  - 위쪽 광택: `linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0) 45%)`.
  - 흐림: `backdrop-filter: blur(8px) saturate(180%)`.
  - 테두리: `rgba(255,255,255,0.85)`.
  - 그림자: `inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(255,255,255,0.35), 0 6px 22px rgba(43,35,32,0.16)`.
  - 유리 안 보조 글자는 진하게 바꾼다: muk-soft → `#463b34`, gold-deep → `#4b3b1d`(`:82-83, 423-424`).
  - 쓰는 곳: 언어·출처·시계(`W:app/main/page.tsx:3987-3998`), 검색창(`:4043`), 날씨·✨ 칩, 필터·편의(`:4446`), 비활성 분류 칩(`:4462`).
- **Expo(현재):**
  - `M:components/ui/Glass.tsx:42-79` 가 있지만 **홈에서 쓰지 않는다**.
  - 검색창·칩은 `bg-white` 불투명 + `border-line` 이고 그림자가 없다(`HomeScreen.tsx:655, 722, 736`, `ToolChips.tsx:24`).
  - `Glass` 자체도 웹 빌드·안드로이드에서는 흐림 없는 92% 판이다. 광택과 안쪽 빛선도 없다.
- **차이:**
  - 웹은 지도가 비치는 반투명 유리, Expo 는 흰 불투명 알약이다.
  - 유리 안 보조 글자 색: 웹 실측 `rgb(70,59,52)`·`rgb(75,59,29)`, Expo `rgb(107,93,79)`.
- **중요도:** P1
- **분류:** 색·효과
- **고칠 방법:**
  1. `Glass` 를 웹과 같은 판으로 만든다.
     - 바탕 `glass-bg`(0.35) + 위쪽 광택(`Gradient` 로 위 45%만) + 테두리 `glass-edge`.
     - `boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.95), inset 0px -1px 0px rgba(255,255,255,0.35), 0px 6px 22px rgba(43,35,32,0.16)'`.
  2. 흐림:
     - 웹 빌드: `style={{ backdropFilter: 'blur(8px) saturate(180%)' }}`. react-native-web 0.21 이 지원한다(`prefixStyles/static.js`).
     - iOS: `BlurView`.
     - 안드로이드: 아래 결정에 따른다.
  3. 유리 안 글자색: `Glass` 가 컨텍스트를 내리고, `Text`·`Icon` 이 그 안에서 `muk-soft`→`glass-muk-soft`, `gold-deep`→`glass-gold-deep` 로 바꾼다.
  4. 홈에 적용한다: 검색창(G2-11), 날씨·✨(G2-15·14), 필터·편의·비활성 칩(G2-25), 언어·출처·시계(G2-10, 시계는 `panel` 모양).
- **바꿀 Expo 파일:** `Glass.tsx`, `Text.tsx`, `Icon.tsx`, `HomeScreen.tsx`, `ToolChips.tsx`
- **문구:** 없음
- **네이티브 주의:**
  - 안드로이드는 `expo-blur` 의 `blurMethod="dimezisBlurViewSdk31Plus"` 로 흐림을 걸 수 있다. 다만 지도 위 칩 8~10개에 걸면 프레임이 떨어질 수 있다.
  - 흐림 없이 35%로 두면 대비 기준(`W:lib/contrast.test.ts` 7번)을 넘지 못한다.
- **확인 방법:**
  - 웹 빌드: `01-default.mjs` 계측에서 검색창 bg 가 0.35, `backdrop-filter` 가 `blur(8px) saturate(1.8)` 인지 본다.
  - 안드로이드: 에뮬레이터에서 글자 대비와 FPS 를 본다.
- **크기·의존:** M · 없음
- **표시:** 결정 필요(안드로이드), 네이티브 확인 필요
  - 선택지 ① SDK 31 이상은 흐림 + 35%
  - 선택지 ② 92% 불투명(지금)
  - 선택지 ③ 70% 절충
  - **추천 ①:** 31 미만은 ② 로 자동 폴백한다.

### G2-G04 일본어·중국어 글꼴 — 웹은 언어별 시스템 글꼴, Expo 는 한국어 글꼴 그대로

- **화면·상태:** 로케일 ja/zh 의 모든 화면
- **스크린샷:** `locale-ja-top.pair.png`, `locale-ja-nav.pair.png`, `locale-ja-home.pair.png`
- **웹(기준):** `W:app/globals.css:176-196`
  - ja: `"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP",Meiryo,"Yu Gothic UI",'Freesentation',system-ui`
  - zh: `"PingFang SC","Noto Sans SC",…`
  - 금칙: `line-break: strict`
  - 실측 ja 탭 글자: `Hiragino Sans` 계열
- **Expo(현재):** `M:components/ui/Text.tsx:47-77` 은 로케일과 상관없이 Freesentation family 를 쓴다.
  - 실측: `現在の慶州 16℃` 가 `Freesentation-7Bold` 로 잡힌다.
  - 이 글꼴에 없는 가나·한자는 브라우저가 글자마다 다른 글꼴로 바꿔 그린다. 그래서 `フィルター・便利機能` 처럼 글자 사이가 벌어진다.
- **차이:** ja·zh 에서 글꼴·자간·줄바꿈이 다르다.
- **중요도:** P1
- **분류:** 글꼴
- **고칠 방법:**
  1. `Text.tsx` 에서 로케일이 ja/zh 일 때:
     - 웹 빌드: `fontFamily` 를 웹과 같은 목록 문자열로 준다.
     - 네이티브: `fontFamily` 를 비우고(시스템 Noto CJK) 굵기 이름을 숫자 `fontWeight` 로 바꾼다(regular 400 … black 900).
  2. `TextInput`(`HomeScreen.tsx:667`), navTheme(`M:app/_layout.tsx:43-58`), 새 탭 막대도 같은 헬퍼 `fontStyleFor(weight, locale)` 를 쓴다.
  3. 웹 빌드는 `lang` 과 금칙을 G2-G06 처럼 맞춘다.
- **바꿀 Expo 파일:** `Text.tsx`, `tokens.ts`(글꼴 목록), `HomeScreen.tsx`, `app/_layout.tsx`
- **문구:** 없음
- **네이티브 주의:** 안드로이드 시스템 CJK 글꼴은 400/700 위주라 600·800 이 가까운 굵기로 그려진다.
- **확인 방법:** `10-locale.mjs` 를 다시 돌린다. 계측의 ja 글꼴 목록과 자간을 웹과 비교한다.
- **크기·의존:** S · G2-G06

### G2-G05 기본 줄 높이 — 웹 글자는 1.5배를 물려받고 Expo 는 `normal`

- **화면·상태:** 모든 화면
- **스크린샷:** `home-top-clip.pair.png`(칩 글자 상자 20 vs 15px), `map-error.pair.png`, `maintenance.pair.png`
- **웹(기준):** Tailwind preflight `line-height:1.5` 를 물려받는다.
  - 실측: 칩 13px → 19.5px, 날씨 12px → 18px.
  - `text-xs` 는 16px 줄높이를 같이 준다.
- **Expo(현재):** `M:components/ui/Text.tsx:53-54` 에 줄높이 기본값이 없다. react-native-web 은 `normal`(≈1.2배)로 그린다.
  - 실측: 13px → 15px, 12px → 14px.
- **차이:** 여러 줄 글과 카드·문단이 Expo 에서 체계적으로 낮고 촘촘하다.
- **중요도:** P1
- **분류:** 글꼴 · 크기·간격
- **고칠 방법:**
  1. `className` 에 `leading-` 도 없고 `style.lineHeight` 도 없으면 `lineHeight = 크기×1.5` 를 기본으로 준다.
     - 크기는 `text-[Npx]` 에서 읽고, 없으면 16 으로 본다.
     - Tailwind 기본 크기 클래스는 그 줄높이를 쓴다: xs 16 · sm 20 · base 24 · lg 28 · xl 28 · 2xl 32.
  2. 이미 명시한 `leading-[Npx]` 는 그대로 둔다.
  3. 겹친 Text 는 지금처럼 부모 값을 물려받는다.
- **바꿀 Expo 파일:** `Text.tsx`, `cn.ts`
- **문구:** 없음
- **네이티브 주의:**
  - 안드로이드는 `lineHeight` 를 주면 남는 공간이 글자 위로 쏠린다. 한 줄 칩은 `includeFontPadding:false` + 세로 가운데를 확인한다.
  - 모든 화면이 바뀌므로 다른 묶음 촬영을 다시 해야 한다.
- **확인 방법:** `lib.mjs dumpRegion` 으로 같은 글자의 `lh` 가 양쪽 같은지 본다.
- **크기·의존:** L(파급이 넓다) · 없음. 다른 묶음 비교 전에 먼저 넣는 편이 낫다.
- **표시:** 네이티브 확인 필요

### G2-G06 Expo 웹 빌드: 한국어가 음절 단위로 끊기고 `<html lang="en">`

- **화면·상태:** 모든 화면(웹 빌드). 예: 오류 카드 `다시 시도해 주 / 세요.`, 점검 본문 `이 / 용할 수 있어요.`
- **스크린샷:** `map-error.pair.png`, `maintenance.pair.png`, `loc-outside.pair.png`
- **웹(기준):**
  - `W:app/globals.css:167-170` `html:lang(ko) body{word-break:keep-all;overflow-wrap:break-word}`
  - `lang` 은 `W:lib/i18n/I18nProvider.tsx:70,84` 가 바꾼다. 실측 `lang="ko"`.
- **Expo(현재):**
  - `M:app/+html.tsx:10` 이 `<html lang="en">` 으로 고정이다(실측 `lang="en"`).
  - `keep-all` 규칙이 없다.
  - 네이티브는 `Text.tsx:56` 이 안드로이드 ko 에서 U+2060 을 넣고, iOS 는 `hangul-word` 를 쓴다. 웹 빌드는 둘 다 없다.
- **차이:** 웹 빌드에서 낱말 중간에서 줄이 바뀌고, 화면 읽기와 `:lang` 규칙이 영어로 동작한다.
- **중요도:** P1
- **분류:** 글꼴 · 접근성
- **고칠 방법:**
  1. `+html.tsx` `<style>` 에 웹과 같은 규칙을 넣는다: `html:lang(ko) body{word-break:keep-all;overflow-wrap:break-word}`, `html:is(:lang(ja),:lang(zh)) body{line-break:strict}`.
  2. `M:lib/i18n/I18nProvider.tsx` 에서 웹 빌드일 때 로케일이 바뀌면 `document.documentElement.lang=locale`. 정적 출력의 기본값은 `ko` 로 한다.
  3. 같은 파일의 `body{background:#fff}` 와 다크 `#000`(`:31-39`)을 `#faf5ec` 하나로 바꾼다.
- **바꿀 Expo 파일:** `+html.tsx`, `I18nProvider.tsx`
- **문구:** 없음
- **네이티브 주의:** 웹 빌드 전용 변경이다. 안드로이드 U+2060 결과가 웹과 같은지는 실기기에서 확인한다.
- **확인 방법:** `06-mapstates.mjs`·`08-notices.mjs` 를 다시 돌린다.
- **크기·의존:** S · 없음
- **표시:** 네이티브 확인 필요

### G2-G07 Expo 웹 빌드에서 `ModalSheet` 가 열리지 않는다

- **화면·상태:** 필터·편의(CHIP-04), 날씨(TOP-07), 축제(TOP-08), 화장실(TOP-10), 지금 한산(TOP-11), 묶음 핀(POP-01)
- **스크린샷:** `tools-sheet-open.pair.png`, `weather-open.pair.png`, `weather-indoor-open.pair.png`, `work/G2/diag-sheet*.png`
- **웹(기준):** 같은 자리의 판들이 모두 열린다(`page.tsx:4571-4595`, `WeatherChip.tsx:84-101`, `FestivalBanner.tsx:280-451`, `RestroomChip.tsx:45-64`, 묶음 `page.tsx:3139-3176`).
- **Expo(현재):** `M:components/ui/Sheet.tsx:305-392` — gorhom `BottomSheetModal`, `enableDynamicSizing={!snapPoints}`.
  - 진단 스크립트 `work/G2/diag-sheet.mjs`, `diag-sheet2.mjs`, `diag-sheet3.mjs` 를 돌렸다.
  - 클릭·터치·Enter 는 `onPress` 까지 닿는다(같은 줄 분류 칩은 동작한다).
  - 그래도 5초 뒤까지 시트 글(`필터와 여행 편의`·`인근 공중화장실`)이 DOM 에 생기지 않는다.
  - 콘솔 오류는 없다.
  - snapPoints 가 있는 추천 카드 `BottomSheet` 는 웹에서 뜬다.
- **차이:** Expo 웹 판에서 홈 도구 6종이 눌러도 반응이 없다.
- **중요도:** P0(웹 빌드)
- **분류:** 동작
- **고칠 방법:**
  1. 웹에서 동적 크기가 0으로 재져서 인덱스가 -1 에 머문다고 추정한다. 먼저 웹일 때 `snapPoints={['60%']}`·`enableDynamicSizing={false}` 로 확인한다.
  2. 그래도 안 되면 `M:components/ui/ModalSheet.web.tsx` 를 따로 둔다. RN `Modal`(react-native-web 에서는 포털) + 아래에서 올라오는 `rounded-t-3xl` 판 + `bg-muk/35` 막으로 대신한다.
  3. G2-16·31 이 고쳐지면 날씨·묶음 핀은 팝오버로 바뀌어 이 문제와 상관없어진다.
- **바꿀 Expo 파일:** `Sheet.tsx`(또는 `ModalSheet.web.tsx`)
- **문구:** 없음
- **네이티브 주의:** HANDOVER 11-09 기록상 네이티브 시트는 동작한다. 웹 빌드 한정 문제로 보인다.
- **확인 방법:** `diag-sheet3.mjs` 의 세 값이 `true` 인지 본다. 그다음 `02-top.mjs`·`04b-panels.mjs` 를 다시 돌린다.
- **크기·의존:** S~M · 없음
- **표시:** 네이티브 확인 필요

### G2-G08 Expo 웹 빌드: 검색 입력칸에 브라우저 기본 포커스 테두리

- **화면·상태:** G2-TOP-01 포커스
- **스크린샷:** `top-search-focused.pair.png`, `search-kakao-results.pair.png`
- **웹(기준):** 입력칸이 `outline-none` 이다(`W:app/main/page.tsx:4055`).
- **Expo(현재):** `HomeScreen.tsx:657-668` `TextInput` 에 Chromium 기본 외곽선이 그려진다. 알약 안에 사각 테두리가 생긴다.
- **중요도:** P2
- **분류:** 색·효과
- **고칠 방법:** 둘 중 하나.
  - `Platform.OS==='web' && { outlineStyle:'none' }` 를 입력칸에 준다.
  - 또는 `+html.tsx` 에 `input:focus,textarea:focus{outline:none}` 를 넣는다.
- **바꿀 Expo 파일:** `HomeScreen.tsx` 또는 `+html.tsx`
- **문구:** 없음
- **네이티브 주의:** 네이티브에는 이 테두리가 없다.
- **확인 방법:** `02-top.mjs` 를 다시 돌린다.
- **크기·의존:** S
- **표시:** 네이티브 확인 필요(해당 없음 확인만)

### G2-G09 홈 알림(토스트) — 웹은 카드 위 먹색 알약, Expo 는 탭 막대 위 한지 카드

- **화면·상태:** G2-TOP-15, LOC-02·05, 홈 알림 전부
- **스크린샷:** `loc-outside.pair.png`, `loc-prompt.pair.png`
- **웹(기준):** `/main` 전용 알약 `W:app/main/page.tsx:5150-5156`
  - 자리: `fixed bottom-[350px] left-1/2 z-50 max-w-sm px-4`.
  - 모양: `bg-muk/90 backdrop-blur-md text-hanji text-xs px-5 py-3 rounded-full shadow-[0_2px_14px_rgba(43,35,32,0.14)] font-medium`. 아이콘은 없다.
  - 3000ms 동안 뜬다(`:663-670`). 나타날 때 `animate-toast` 로 아래 20px 에서 올라온다.
  - 다른 화면은 전역 sonner 를 쓴다.
- **Expo(현재):** `M:components/ui/Toast.tsx:22-48` sonner-native.
  - 자리: 탭 막대 위 64px.
  - 모양: 한지 바탕 + line 테두리 + surface 그림자, 14px SemiBold, 파란 ⓘ 아이콘.
  - 지속: 약 4초.
  - 실측: 경주 밖 알림이 `69,723,288×40` 두 줄로 카드를 덮는다.
- **차이:** 색, 모양, 위치(350px vs 막대 위), 글자 12 vs 14, 지속 3 vs 4초.
- **중요도:** P1
- **분류:** 색·효과 · 배치 · 글꼴
- **고칠 방법:**
  1. 새 `M:features/home/HomeToast.tsx` 를 만든다.
     - 자리: `absolute, bottom 350`, 가운데, `maxWidth 384`, `px 16`.
     - 모양: `rgba(43,35,32,0.9)` 바탕, 둥근 알약, `px 20 py 12`, hanji 12px medium, `boxShadow 0px 2px 14px rgba(43,35,32,0.14)`.
     - 3000ms 뒤 사라진다. 나타날 때 20px 위로 + 투명→불투명, 250ms.
  2. `HomeScreen` 의 `toast(...)` 를 이 알약으로 바꾼다: `:283`(경주 밖), `:286`·`:625`(위치 실패), `:352`(곧 닫음 대체), `:414`(음식 0곳).
  3. 전역 sonner 는 ⓘ 아이콘을 끈다. 위치는 G3·G4·G5 가 웹 sonner 와 맞춘다.
- **바꿀 Expo 파일:** 새 `HomeToast.tsx`, `HomeScreen.tsx`, `Toast.tsx`
- **문구:** 재사용 `map.outOfRegionStart`·`map.locationFallback`·`map.closingSoonRedirect`·`map.closingSoonNoAlternative`·`cuisine.noMatch`
- **네이티브 주의:** `accessibilityLiveRegion="polite"` 를 권장한다.
- **확인 방법:** `07-location.mjs` 를 다시 돌린다.
- **크기·의존:** S · G3(카드 알림)

---

## [MAP] 지도

### G2-01 지도 카메라 — 고른 핀이 놓이는 세로 위치(첫 화면·핀 탭)

- **화면·상태:** G2-MAP-01·08, POP-03
- **스크린샷:** `home-default.pair.png`, `pin-tap-single.pair.png`(같은 `우직` 터치), `pins-around-user.pair.png`
- **웹(기준):** 첫 진입은 `centerOnFreeArea`(`W:app/main/page.tsx:3012, 1593-1608`). 1위 추천과 핀 탭은 `panToVisible`(`:2296-2299, 3178-3181, 1611-1626`).
  - 핀은 `mapInsets()`(`:1555-1590`)가 만든 띠의 가운데로 간다. 띠 계산은 `W:lib/map/visibleBand.ts:51-62`.
    - 띠 위: 머리 아래 + 8.
    - 띠 아래: 예측 띠 위 · 카드 위 · 화면 아래−116 중 가장 높은 곳 + 8.
  - 실측: 첫 화면 1위 `향화정` 핀 끝은 y≈229(칩 줄 바로 아래). `우직` 을 누른 뒤에는 y≈329(띠 218~441 의 가운데).
- **Expo(현재):**
  - 첫 위치: `HomeScreen.tsx:259-271` 이 레벨 4, 인셋 위 `headerH+8` · 아래 16 으로 옮긴다.
  - 1위 추천·핀 탭: `focusOn`(`:254-257`, 아래는 시트 덮개+16, `sheetModel.ts:86-97`).
  - 실측: 둘 다 핀 끝 y≈405(띠 196~656 의 가운데). 첫 화면 가로도 웹보다 20px 왼쪽이다.
- **차이:**
  - 같은 데이터에서 핀·지도가 세로로 어긋난다(첫 화면 176px, 탭 76px).
  - 원인 1: 띠의 위·아래가 다르다(머리·예측 띠·시트 높이).
  - 원인 2: 웹 첫 화면은 카드가 펼친 높이일 때 띠를 재는 것으로 보인다.
- **중요도:** P1
- **분류:** 배치 · 동작
- **고칠 방법:**
  1. `focusOn` 인셋을 웹 규칙으로 맞춘다.
     - 위 = 머리 아래끝 + 8.
     - 아래 = 컨테이너 − min(예측 띠 위(G2-24), 시트 위, 컨테이너 − 탭 막대 덮개(G2-G01)) + 8.
     - 예측 띠와 시트 높이는 `onLayout` 으로 잰다. 지금 `HomeScreen.tsx:253` 은 시트만 본다.
  2. 첫 진입(`:259-265`)도 아래를 16 이 아니라 같은 띠로 준다.
  3. 첫 추천 핀 위치를 웹과 같게 하려면 `[recs]` 효과(`:369-378`)에서만 아래를 `sheetCoverHeight('normal')` 로 준다. 결정 필요.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, `sheetModel.ts`
- **문구:** 없음
- **네이티브 주의:** `NextSpotMap.tsx` 의 `animateTo` 인셋 결과가 웹 판과 같은지 에뮬레이터로 확인한다. 지도 공급자 줌 차이는 허용이고, 핀의 화면 위치만 맞춘다.
- **확인 방법:** `03-map`/`11-taps` 를 다시 돌린다. 같은 핀의 `cy` 차이가 ±8px 이내인지 본다.
- **크기·의존:** M · G2-10·11·13·24·G01
- **표시:** 결정 필요 — 첫 추천 핀 위치
  - 선택지 ① 웹 그대로(칩 바로 아래)
  - 선택지 ② 웹을 고쳐 미리보기 높이로 띠를 재고 띠 가운데에 둔다
  - **추천 ②:** 웹 `panToVisible` 주석의 의도('보이는 띠의 가운데')와 맞다.

### G2-02 지도 위치·분류 칩을 세션에 기억하지 않는다

- **화면·상태:** G2-MAP-01 새로고침·재진입
- **스크린샷:** 없음(코드 비교)
- **웹(기준):**
  - 지도 `idle` 마다 `sessionStorage` `nextspot_map_center_lat/lng`·`nextspot_map_level` 을 쓴다(`page.tsx:3016-3030`).
  - 다음 진입에서 복원하고 띠 보정은 생략한다(`:2968-2993, 3009-3012`).
  - 분류 칩은 `nextspot_active_filter` 에 기억한다(`:1444, 3329`).
- **Expo(현재):** 키를 읽지도 쓰지도 않는다. 새로고침·앱 재시작 때 레벨 4·사용자 위치·첫 설정 칩으로 돌아간다(`HomeScreen.tsx:138, 259-265`).
- **중요도:** P2
- **분류:** 동작
- **고칠 방법:**
  1. `M:lib/sessionStorage.ts` 로 같은 키를 쓴다. `onRegionChangeComplete`(`:643`)에서 저장하고, 첫 `mapReady` 에서 복원한다. 저장 위치가 중심 ±0.0005° 안이면 띠 보정을 한다.
  2. `selectCategory`(`:380-389`)에서 웹 값(`음식점|카페|관광지|문화시설`)으로 저장하고 첫 렌더에서 읽는다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, `homeContext.ts`
- **문구:** 없음
- **확인 방법:** 웹 빌드에서 지도를 옮기고 새로고침한 뒤 같은 자리인지 본다.
- **크기·의존:** S · G2-01

### G2-03 핀 고르는 순서 — 웹 SPOT 점수 순, Expo 거리 순 → 보이는 핀이 다르다

- **화면·상태:** G2-MAP-01·06
- **스크린샷:** `home-default.pair.png`, `group-pin-open.pair.png`(웹에는 `이 건물의 장소 2곳` 이 있고, Expo 같은 화면에는 없다)
- **웹(기준):** `computeDisplayFacilities`(`page.tsx:1709-1806`)
  - 순서: 순위 핀 먼저, 그다음 `compareSpot(calculateSPOT)`(`:1471-1488`, `W:lib/recommender.ts:436-500`).
  - 점수에 들어가는 것: 혼잡·거리·선호 분류(`users.preferred_categories` `:1165-1172`)·음식 취향.
  - 52px 간격, 최대 7개.
- **Expo(현재):** `orderForPins`(`M:features/home/homeModel.ts:261-268`)는 순위 다음 **거리 순**이다. 간격·상한은 같다.
- **차이:** 실측 7핀 중 웹은 `이 건물의 장소 2곳`(사시스세소·황오명과), Expo 는 `정밤` 이 들어간다.
- **중요도:** P1
- **분류:** 동작 · 아이콘·이미지
- **고칠 방법:**
  1. `scoreFacility`·`compareSpot` 을 `M:features/home/pinOrder.ts` 로 복사한다. recommender 는 api-client 타입 사슬 때문에 check:shared 에 걸린다. `PORTING.md` 에 원본을 기록한다.
  2. `orderForPins` 를 `rank || compareSpot` 으로 바꾼다.
  3. 선호 분류는 세션이 있으면 Supabase `users.preferred_categories` 에서 읽는다. 음식 취향은 `cuisineIntentOf`.
  4. 웹 결과와 대조하는 테스트를 넣는다.
- **바꿀 Expo 파일:** `homeModel.ts`, 새 `pinOrder.ts`(+test), `PORTING.md`
- **문구:** 없음
- **확인 방법:** `03-map` 을 다시 돌려 핀 제목 목록이 같은지 본다.
- **크기·의존:** M

### G2-04 내 위치 점 — 웹 100px 금빛 번짐(맥박), Expo 44px 정적 고리 / 거부·경주 밖 표시

- **화면·상태:** G2-MAP-01, LOC-01·02·05
- **스크린샷:** `pins-around-user.pair.png`, `loc-prompt.pair.png`(거부: 웹은 중심에 점, Expo 는 없음), `loc-outside.pair.png`
- **웹(기준):** `page.tsx:1373-1407` CustomOverlay 100×100
  - 번짐: `radial-gradient(circle, rgba(193,154,62,0.6) 0%, rgba(193,154,62,0.2) 50%, rgba(193,154,62,0) 80%)`.
  - 맥박: `pulse-user-marker 1.2s infinite cubic-bezier(0.2,0,0.2,1)`(scale 0.3→1.6, 투명도 1→0).
  - 흰 원 28 + 그림자 `0 0 10px rgba(43,35,32,0.25)`, 금 점 14 `#c19a3e`, zIndex 10.
  - 늘 그린다. 거부·경주 밖이면 지역 중심에 그린다.
- **Expo(현재):**
  - 웹 빌드: `NextSpotMap.web.tsx:689-725` — 44px 정적 원 `rgba(193,154,62,0.28)` + 흰 28 + 금 14.
  - 네이티브: `NextSpotMap.tsx` 도 같은 정적 고리.
  - 허용 + 경주 안일 때만 그린다(`locationPolicy.showsUserDot`).
- **차이:** 번짐 크기·모양·움직임, 그리고 거부·밖 상태에서 점이 있느냐 없느냐.
- **중요도:** P1
- **분류:** 아이콘·이미지 · 동작
- **고칠 방법:**
  1. 웹 빌드: `buildUserDot('halo')` 를 웹 DOM 그대로 만든다. 100 상자 + 번짐 div + `@keyframes` 를 `ensureMapStyle`(`:145-153`)에 넣는다. 동작 줄이기면 애니메이션을 끈다.
  2. 네이티브: `USER_DOT.halo.outer` 를 100 으로 하고, react-native-svg `RadialGradient`(같은 정지점)를 쓴다.
     - 맥박은 Reanimated 로 넣을 수 있지만, 구글 마커는 `tracksViewChanges` 비용이 크다. 정적 그라데이션도 선택지다.
  3. 거부·밖 표시는 아래 결정에 따른다.
- **바꿀 Expo 파일:** `NextSpotMap.web.tsx`, `NextSpotMap.tsx`, `pins.ts`, (결정에 따라) `locationPolicy.ts`
- **문구:** 없음
- **확인 방법:** `03-map` 을 다시 돌린다. 애니메이션을 끄고 같은 프레임으로 비교한다.
- **크기·의존:** S~M · 없음
- **표시:** 결정 필요 — 거부·밖에서 가짜 위치에 '내 위치' 점을 그릴지
  - 선택지 ① 웹처럼 그린다
  - 선택지 ② 그리지 않는다(지금 Expo)
  - 선택지 ③ 웹도 그리지 않게 고친다
  - **추천 ③:** 웹이 사실과 다른 위치를 보여 준다. 맥박은 웹 빌드는 그대로, 네이티브는 정적 그라데이션.

### G2-05 장소 불러오는 중 — 웹 마스코트 + 원형 스피너, Expo 기본 스피너만

- **화면·상태:** G2-MAP-02
- **스크린샷:** `map-loading.pair.png`
- **웹(기준):** `page.tsx:4598-4604`
  - 마스코트: `NextSpotMascot variant="full" className="w-20 shadow-[0_8px_24px_rgba(43,35,32,0.10)]"`. 80px, 4:5, 둥글기 28%, 그림 `/mascot/nextspot-guide.webp`.
  - 스피너: `w-10 h-10 rounded-full border-2 border-line border-t-gold animate-spin`.
  - 글: `map.loadingRec` 14px medium. 간격 12.
- **Expo(현재):** `HomeScreen.tsx:770-775` — `ActivityIndicator large gold` + 같은 글.
- **차이:** 마스코트가 없고 스피너 모양이 다르다.
- **중요도:** P1
- **분류:** 아이콘·이미지 · 상태
- **고칠 방법:**
  1. `W:public/mascot/nextspot-guide.webp` 를 `M:assets/images/mascot/` 로 복사한다.
  2. `M:components/ui/NextSpotMascot.tsx` 를 만든다.
     - avatar: 원형, 테두리 gold 35%, 바탕 hanji, 그림 위치 50% 22%, 확대 1.48.
     - full: 4:5, 둥글기 28%, 그림 위치 50% 42%.
     - expo-image 의 `contentPosition` + transform 으로 구현한다.
  3. 스피너는 40px 원(`border 2 line`, 위쪽 gold)을 Reanimated 로 1s linear 회전한다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, 새 `NextSpotMascot.tsx`, assets
- **문구:** 재사용 `map.loadingRec`
- **네이티브 주의:** expo-image 는 webp 를 지원한다.
- **확인 방법:** `06-mapstates` 를 다시 돌린다.
- **크기·의존:** S · 마스코트는 G2-07·11·30 이 같이 쓴다

### G2-06 장소 불러오기 실패 카드

- **화면·상태:** G2-MAP-03
- **스크린샷:** `map-error.pair.png`
- **웹(기준):** `page.tsx:4606-4621`
  - 카드: `bg-white border-line rounded-2xl px-6 py-5 shadow-[0_2px_14px_…0.06] max-w-xs gap-3`.
  - ⚠️ 24px / 제목 14 semibold muk / 본문 12 muk-soft leading-relaxed.
  - 버튼: `px-4 py-2 rounded-full bg-gold text-white text-sm font-bold`, 아이콘 없음.
- **Expo(현재):** `HomeScreen.tsx:776-780` → `ErrorState.tsx:30-69`
  - 카드 padding 32, 테두리 terracotta 25%, ⚠️ 30.
  - 제목과 본문을 `\n` 으로 붙인 한 글자로 쓴다(14 semibold muk).
  - 버튼은 `bg-gold-deep min-h 44` + `RotateCw` 아이콘 + 13 bold.
- **차이:** 본문 크기·색, 버튼 색·아이콘·크기, 테두리, 여백.
- **중요도:** P1
- **분류:** 상태 · 색·효과 · 글꼴
- **고칠 방법:** 홈 전용 블록으로 바꾼다. 공용 `ErrorState` 를 고치면 다른 화면도 바뀌니 각 화면 웹 오류 카드와 비교한 뒤 공용화를 정한다.
  - 카드: `Card px 24 py 20 border-line shadow card maxWidth 320 gap 12`.
  - ⚠️ 24 / 제목 14 semibold / 본문 12 muk-soft `leading-[19.5px]`.
  - 버튼: `bg-gold rounded-full px 16 py 8`, 14 bold white, 아이콘 없음, `hitSlop` 으로 44.
- **바꿀 Expo 파일:** `HomeScreen.tsx`
- **문구:** 재사용 `map.loadErrorTitle`·`map.loadErrorBody`·`common.retry`
- **확인 방법:** `06-mapstates` 를 다시 돌린다.
- **크기·의존:** S

### G2-07 표시할 장소 없음 카드

- **화면·상태:** G2-MAP-04
- **스크린샷:** `map-empty.pair.png`
- **웹(기준):** `page.tsx:4623-4631` — 같은 카드(gap-2) + 마스코트 full 64px + 제목 14 semibold + 본문 12 muk-soft.
- **Expo(현재):** `HomeScreen.tsx:781-785` → `EmptyState.tsx:26-45` — 🗺️ 30 + 제목 15 bold + 본문 13, padding 28.
- **차이:** 마스코트 vs 이모지, 제목 15 bold vs 14 semibold, 본문 13 vs 12.
- **중요도:** P1
- **분류:** 아이콘·이미지 · 글꼴
- **고칠 방법:** 홈 전용 블록을 만든다. 마스코트 64 + 14 semibold + 12 muk-soft `leading-[19.5px]`, 카드 `px 24 py 20 gap 8 max 320`.
- **바꿀 Expo 파일:** `HomeScreen.tsx`
- **문구:** 재사용 `map.emptyTitle`·`map.emptyBody`
- **확인 방법:** `06-mapstates` 를 다시 돌린다.
- **크기·의존:** S · G2-05

### G2-08 지도 SDK 실패 — 웹 안내 칩 + 한지 그라데이션, Expo 평평한 상자·안내 없음

- **화면·상태:** G2-MAP-07(카카오 SDK 차단)
- **스크린샷:** `map-sdk-failed.pair.png`
- **웹(기준):**
  - 8초 동안 SDK 가 없으면 `mapUnavailable` 이 된다(`page.tsx:2911-2927`).
  - 지도 자리 바탕: `bg-gradient-to-b from-hanji-deep/70 via-hanji-deep/40 to-hanji`(`:3970`).
  - 머리 맨 위에 칩 `map.loadFailed`(`:4017-4023`: `text-xs bg-white border-line rounded-full px-3 py-1 shadow`, 가운데). 검색 줄이 28px 아래로 밀린다.
  - 5초 간격으로 최대 3회 복구를 시도한다.
- **Expo(현재):**
  - `NextSpotMap.web.tsx:540-547` 은 `#efe6d6` 평평한 상자만 그리고 안내가 없다.
  - 시간 초과는 15초.
  - 네이티브 `NextSpotMap.tsx:192-194` 도 같은 상자다.
- **차이:** 안내 칩이 없고, 바탕이 다르며, 기다리는 시간이 8 vs 15초다.
- **중요도:** P1
- **분류:** 상태 · 누락
- **고칠 방법:**
  1. `NextSpotMap`(웹·네이티브)에 `onUnavailable` 을 추가한다.
  2. 홈 머리 맨 위에 칩을 그린다: 12px muk, `bg-white border-line rounded-full px 12 py 4`, 그림자.
  3. 지도 자리 바탕을 `Gradient` 세 정지점(hanji-deep 0.7 → 0.4 → hanji)으로 바꾼다.
  4. 시간 초과를 8000ms 로 줄인다(`kakaoWeb.ts`).
- **바꿀 Expo 파일:** `NextSpotMap.web.tsx`, `NextSpotMap.tsx`, `kakaoWeb.ts`, `pins.ts`, `HomeScreen.tsx`
- **문구:** 재사용 `map.loadFailed`
- **네이티브 주의:** 구글 키가 없거나 네트워크가 실패할 때도 같은 칩을 보인다.
- **확인 방법:** `06-mapstates` 를 다시 돌린다.
- **크기·의존:** S

### G2-09 히트맵(🔥) 없음 — 결정 필요

- **화면·상태:** G2-MAP-11
- **스크린샷:** `heatmap-on-web.pair.png`
- **웹(기준):**
  - 필터·편의 시트 첫 칸 `🔥 히트맵`(`page.tsx:4581`). 누르면 시트가 닫힌다.
  - 실측 지점에 혼잡색 원 블롭을 그린다(`:3218-3297`, `mix-blend-mode:screen`).
  - 처음 켤 때 `GET /api/v1/area-demand/parking-lots` 를 부른다.
- **Expo(현재):** 없다(`HomeScreen.tsx:3`, 계획 v1.1).
- **중요도:** P0
- **분류:** 누락
- **고칠 방법(포팅할 경우):**
  1. 시트 첫 칸에 `ToggleTile` 히트맵을 둔다.
  2. `NextSpotMap` 에 `blobs` 를 추가한다.
     - 웹 빌드: Kakao CustomOverlay div(radial-gradient, screen 블렌드).
     - 네이티브: react-native-maps `Circle`(반투명 채움, 블렌드 불가).
  3. 지점 모으기는 웹 규칙 `:3234-3265` + `W:lib/map/heatmap.ts` `getHeatRadius` 를 따른다.
  4. 주차 실측 GET 을 붙인다.
- **바꿀 Expo 파일:** `HomeOverlays.tsx`, `HomeScreen.tsx`, `NextSpotMap.web.tsx`·`NextSpotMap.tsx`·`types.ts`, 새 heatmap 모듈
- **문구:** 재사용 `map.heatmap`
- **네이티브 주의:** 블렌드가 없어 색이 더 진해 보일 수 있다.
- **크기·의존:** L · G2-27
- **표시:** 결정 필요
  - 선택지 ① 지금 포팅
  - 선택지 ② v1.1
  - **추천 ②:** 단, 시트 2열 배치는 웹과 같게(G2-27).

---

## [TOP] 상단 — 검색·날씨·축제·화장실·예측 띠·음성

### G2-10 상단 묶음 없음 — 언어 알약 · 출처 알약 · KST 시계

- **화면·상태:** 홈 기본
- **스크린샷:** `home-top-clip.pair.png`, `notice-banner-top.pair.png`
- **웹(기준):** `page.tsx:3975-4009` — `absolute inset-x-3 top-[safe+0.5rem] z-30 flex justify-between gap-2`
  - 언어 알약(`W:components/LanguageSwitcher.tsx:9-30`, 실측 12,8,117×32):
    - `rounded-full border px-3 text-sm`, 폰은 유리.
    - `Globe` 16 + `<select>` 14px medium(한국어/English/日本語/中文 + ▾).
  - 출처 알약(`SourceCredit compact`, `W:components/SourceCredit.tsx:30-37`, 실측 12,44,135×18):
    - `rounded-full border px-2.5 py-[3px] text-[10px] leading-none font-semibold`, 유리.
    - 글은 `credit.tourapi`.
  - 시계(실측 257,8,121×45):
    - `liquid-glass-phone rounded-2xl border px-3 py-2 shadow-[0_3px_16px_rgba(43,35,32,0.12)]`.
    - `Clock3` 16 gold + 날짜 10px semibold + `KST`(10px bold tracking-wider gold-deep) 시각 13px extrabold tracking-tight.
    - 30초마다 갱신(`:749-776`). `Intl` 은 timeZone `Asia/Seoul`, 로케일은 ko-KR/en-US/ja-JP/zh-CN.
  - 이 묶음 때문에 검색 줄이 위 68px 에서 시작한다(`:4013`).
- **Expo(현재):** 셋 다 없다. 검색이 y=8 에서 시작한다(`HomeScreen.tsx:651`). 언어는 마이>설정 칩에만 있다.
- **차이:** 첫 화면 위 60px 의 구성(언어 바꾸기·데이터 출처·현지 시각)이 통째로 없다.
- **중요도:** P0
- **분류:** 누락 · 배치
- **고칠 방법:**
  1. 새 `M:features/home/HomeTopCluster.tsx` 를 만든다. 자리는 `absolute top insets.top+8, left/right 12`, `row space-between gap 8`.
  2. 언어 알약: `Glass` 높이 32, px 12, gap 6. `Globe` 16 + 현재 로케일 라벨 14 medium + `ChevronDown` 14.
     - 웹 빌드: `LanguagePill.web.tsx` 에서 투명 `<select>` 를 겹친다.
     - 네이티브: 4개 목록에서 `useLocale()` 로 고른다.
     - 라벨은 `@/lib/i18n/config` `LOCALES` 를 쓴다.
  3. 출처 알약: `Glass` 18 높이, px 10, 10px semibold `glass-muk-soft`, `t('credit.tourapi')`.
  4. 시계: `Glass panel`(16), px 12 py 8 gap 8, `Clock3` 16 gold.
     - 날짜 10 semibold.
     - `KST` 10 bold `glass-gold-deep` 자간 0.5 + 시각 13 extrabold 자간 −0.325.
     - 30초 간격 + 앱 복귀 때 갱신. 그림자 `0px 3px 16px rgba(43,35,32,0.12)`.
  5. 홈 머리 시작을 `insets.top+68` 로 옮긴다.
- **바꿀 Expo 파일:** 새 `HomeTopCluster.tsx`·`LanguagePill(.web).tsx`, `HomeScreen.tsx`
- **문구:** 재사용 `credit.tourapi`. 언어 알약 접근 이름은 `settings.langTitle`(웹은 '언어 선택'을 하드코딩 — 웹 i18n 누락). 새 키는 없다.
- **네이티브 주의:** Hermes `Intl` 의 `timeZone:'Asia/Seoul'` 을 기기에서 확인한다. 안 되면 UTC+9 를 직접 계산한다.
- **확인 방법:** `01-default` 를 다시 돌려 상자 3개를 확인한다.
- **크기·의존:** M · G2-G03, G2-G07
- **표시:** 네이티브 확인 필요(Hermes `Intl`)

### G2-11 검색창 — 유리·높이 58·좌우 16·마스코트 없음

- **화면·상태:** G2-TOP-01
- **스크린샷:** `home-top-clip.pair.png`, `top-search-focused.pair.png`
- **웹(기준):** `page.tsx:4043-4089` — `liquid-glass rounded-full px-4 border`, 실측 16,68,358×58
  - 입력: `py-[18px] text-sm`, 자리 표시 글은 유리 muk-soft(#463b34).
  - `Search` 20 + `mr-3`.
  - 오른쪽: 마이크(G2-12) 또는 X, 그 오른쪽 `NextSpotMascot ml-3 w-9`(36px 원형 아바타).
  - 키 낮은 폰(<720)에서는 높이를 줄이고 마스코트를 숨긴다.
- **Expo(현재):** `HomeScreen.tsx:655-672`
  - `min-h-[48px] rounded-full border-line bg-white px-[14px]`, 실측 12,8,366×48.
  - 입력 `px-[10px]`, 자리 표시 글 #6b5d4f.
  - 마스코트·마이크 없음.
- **차이:** 마스코트 없음, 높이 48 vs 58, 좌우 12 vs 16, 유리 vs 흰, 간격 10 vs 12, 자리 표시 글색.
- **중요도:** P0
- **분류:** 누락 · 크기·간격 · 색·효과
- **고칠 방법:**
  1. 머리 좌우를 16 으로(`:650-651`).
  2. 알약을 `Glass`, `min-h 58`, px 16 으로. `Search` 20 `glass-muk-soft` + `marginRight 12`. 입력 px 0, 14px, 자리 표시 글 `glass-muk-soft`, 줄높이 20.
  3. 맨 오른쪽에 마스코트 avatar 36, `marginLeft 12`.
  4. 화면 높이 <720 규칙도 웹처럼 넣는다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`
- **문구:** 재사용 `map.searchPlaceholder`
- **확인 방법:** 계측 검색 상자가 `16,68,358×58` 인지 본다.
- **크기·의존:** S · G2-G03, G2-05, G2-10

### G2-12 음성 비서 — 검색 마이크 · `AI 음성 비서` 알약 없음(결정 필요)

- **화면·상태:** G2-TOP-13
- **스크린샷:** `home-default.pair.png`, `search-kakao-results.pair.png`
- **웹(기준):**
  - 마이크 `page.tsx:4067-4086`: `Mic` 18(`map.voiceSearchStart`). 듣는 중에는 금색 맥박 + `map.voiceSearchListening` 10px. 한 발화를 검색어로 넣는다.
  - 알약 `VoicePill`(`W:components/VoiceSlot.tsx:23-57`):
    - `h-9 rounded-full bg-muk px-3.5 text-[13px] font-extrabold text-hanji shadow-[0_4px_14px_rgba(43,35,32,0.22)]` "🎙 AI 음성 비서"(`voice.pill`, 접근 이름 `recommend.listenCta`).
    - 폰에서는 카드 오른쪽 위(실측 257,516,104×36). 카드가 없어도 남는다(`:4706-4708`).
  - 자막 막대 `VoiceCaptionBar`. 서버는 `POST /api/v1/voice/turn`(LLM).
- **Expo(현재):** 없다(계획 v1.1).
- **중요도:** P0
- **분류:** 누락 · 동작
- **포팅에 드는 것:**
  1. STT: `expo-speech-recognition`(설정 플러그인·`RECORD_AUDIO`·Play 데이터 안전), 웹 빌드는 Web Speech.
  2. TTS: `expo-speech`.
  3. 상태 기계: `W:lib/voice/useVoiceAssistant.ts` 를 앱용으로 다시 쓴다(window 의존이라 공유 불가). `voice/turn` 은 외부 AI 라 Expo AI 동의 대상에 넣는다.
  4. UI: 검색 알약의 마이크, 카드 머리의 알약(G3), 자막 막대.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, `RecommendationSheet.tsx`(G3), 새 `features/voice/*`
- **문구:** 재사용 `map.voiceSearchStart`·`voiceSearchListening`·`voiceSearchLabel`·`sttMicDenied`·`sttFailed`·`voice.pill`·`voice.state*`·`recommend.listenCta`·`recommend.stopAria`·`recommend.voiceHint`
- **네이티브 주의:** 권한, 오디오 포커스.
- **크기·의존:** L · G3, G2-11
- **표시:** 결정 필요
  - 선택지 ① 지금 포팅
  - 선택지 ② v1.1 유지
  - 선택지 ③ 자리만 비활성(비추천)
  - **추천 ②:** 단, 마스코트(G2-11)는 지금 넣는다.

### G2-13 둘째 줄 구성 — 웹 '날씨 + ✨', Expo '날씨 + 축제 + 화장실 + 지금 한산'

- **화면·상태:** G2-TOP-07·08·10·11, CHIP-04
- **스크린샷:** `home-top-clip.pair.png`, `chips-row-mocked-top.pair.png`, `tools-sheet-festival-restroom.pair.png`
- **웹(기준):**
  - 둘째 줄(`page.tsx:4092-4127`) = 날씨 + ✨(G2-14)뿐이다. 검색 중에는 숨긴다.
  - 축제(`FestivalBanner` 기본 chip)·화장실은 **필터·편의 시트 맨 아래 줄**에 있다(`:4591` `mt-4 flex flex-wrap gap-2`).
  - 지금 한산은 `lg` 이상에만 있다(`:4474-4553`). 390px 에는 없다.
- **Expo(현재):** `HomeScreen.tsx:700-714` 첫 칩 줄 = 날씨 · 축제 · 화장실 · 지금 한산(가로 스크롤).
  - 축제는 진행 중이면 한 줄형 '🏮 {제목} · MM.DD까지'(`ToolChips.tsx:177-190`)로 그린다.
- **차이:** 줄 구성·순서, 축제 모양(웹 폰은 늘 '축제 N'), 지금 한산은 Expo 에만 있다.
- **중요도:** P0
- **분류:** 배치 · 추가
- **고칠 방법:**
  1. 첫 칩 줄을 날씨 + (✨) 두 개로 줄인다. `row gap 8`, 가로 스크롤 아님.
  2. 축제·화장실 칩을 `FilterSheet` 맨 아래로 옮긴다.
     - 축제는 웹 chip 형만 쓴다(한 줄형 분기 제거). 웹 `FestivalBanner.tsx:256-270` 모양: `rounded-full border-line bg-white/80 px-3.5 py-2 text-[13px] font-medium text-muk-soft` + 그림자.
     - 개수 배지: `18×18 rounded-full 10px bold`. 진행 중이 있으면 `bg-terracotta text-white`, 아니면 `bg-gold/20 text-gold-deep`.
     - 화장실은 웹 `RestroomChip.tsx:37-44` 처럼 `Toilet` 15 + '화장실 N'.
  3. `CalmChip` 은 폰 폭(<1024)에서 그리지 않는다.
  4. 시트 안에서 축제·화장실을 누르면 그 시트를 위에 쌓는다(gorhom push).
- **바꿀 Expo 파일:** `HomeScreen.tsx`, `HomeOverlays.tsx`, `ToolChips.tsx`
- **문구:** 재사용 `festival.chip`·`festival.chipAria`·`restroom.chip`·`restroom.chipAria`
- **네이티브 주의:** 시트를 두 겹 쌓을 때 뒤로 가기 순서.
- **확인 방법:** `04-mocks` 를 다시 돌린다.
- **크기·의존:** S~M · G2-G07, G2-27, G2-14

### G2-14 ✨ '경주가 처음이라면'(경주 테마 대안) 없음 — 결정 필요

- **화면·상태:** 웹 전용
- **스크린샷:** `home-top-clip.pair.png`, `discovery-open-web.pair.png`
- **웹(기준):**
  - 칩(`page.tsx:4113-4126`, 실측 162,134,148×32): `liquid-glass h-8 px-3 text-[12px] font-extrabold` + ✨ 14 + ChevronDown 14 gold-deep.
  - 판(`:4307-4336`): `rounded-3xl border-gold/30 bg-white/95 p-4 shadow-[0_8px_28px_rgba(43,35,32,0.13)]`.
    - 제목 14 extrabold, 부제 11, X.
    - 테마 칩: `rounded-full border-line bg-hanji px-3 py-2 text-xs font-bold`.
  - 테마를 고르면 `POST /api/v1/recommendations`(`discovery_theme`)를 부르고 결과 판(`:4338-4405`)에 대안 3곳을 보인다.
- **Expo(현재):** 없다.
- **중요도:** P0
- **분류:** 누락 · 동작
- **포팅에 드는 것:**
  1. 테마 목록: `W:lib/gyeongjuDiscovery.ts`(순수).
  2. 문구는 `W:lib/i18n/discovery-messages.ts` 사이드 사전에 있다. Expo `M:lib/i18n/catalog.ts` 는 JSON 만 싣는다. `DISCOVERY_MESSAGES`(그리고 `AREA_DEMAND_MESSAGES`)를 표에 합쳐야 한다.
  3. `M:features/explore/logic.ts` 의 요청에 `discovery_theme` 을 넣는다.
  4. UI: 칩·판·결과 카드.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, 새 `DiscoveryPanel.tsx`, `catalog.ts`, `explore/logic.ts`
- **문구:** 재사용 `discovery.*` 전부(사이드 사전). 새 키는 없다.
- **크기·의존:** L · G2-13
- **표시:** 결정 필요
  - 선택지 ① 포팅
  - 선택지 ② 제외 유지
  - **추천 ①:** 처음 온 관광객의 핵심 흐름이고, 서버·문구가 이미 있다.

### G2-15 날씨 칩 모양 — 유리·높이 32·▾·실내 추천 금 테두리(Expo 버그)

- **화면·상태:** G2-TOP-07 접힘
- **스크린샷:** `home-top-clip.pair.png`, `chips-row-mocked-top.pair.png`
- **웹(기준):** `WeatherChip.tsx:68-83`
  - `liquid-glass h-8 gap-1.5 rounded-full border px-3 text-[12px] font-bold`, 이모지 15.
  - 실내 추천이면 `Umbrella` 13 gold-deep + 테두리 `rgba(193,154,62,0.6)`.
  - 끝에 ▾/▴ 14.
  - 실측 138×32(실내 157×32).
- **Expo(현재):** `ToolChips.tsx:70-79`
  - `CHIP`(36px, border-line, 흰), 우산 14, ▾ 없음.
  - 실내 추천 `border-gold` 가 `border-line` 과 겹쳐 실측 테두리가 `rgb(230,220,198)` 그대로다(버그).
- **중요도:** P1
- **분류:** 크기·간격 · 색·효과 · 아이콘
- **고칠 방법:** `Glass` 높이 32, px 12, gap 6, 12 bold.
  - 실내 추천이면 우산 13 + `style.borderColor='rgba(193,154,62,0.6)'`(클래스 대신 style).
  - 끝에 Chevron 14.
  - 키 낮은 폰은 `{n}℃` 만 보인다.
- **바꿀 Expo 파일:** `ToolChips.tsx`
- **문구:** 재사용 `weather.gyeongjuNow`·`calmSummary`·`riskSummary`
- **확인 방법:** `04-mocks` 를 다시 돌려 테두리색을 본다.
- **크기·의존:** S · G2-G03

### G2-16 날씨 펼침 — 웹은 칩 아래 팝오버, Expo 는 바텀 시트

- **화면·상태:** G2-TOP-07 펼침
- **스크린샷:** `weather-open.pair.png`, `weather-indoor-open.pair.png`(웹만 열림)
- **웹(기준):** `WeatherChip.tsx:84-101`
  - 판: 칩 아래 `absolute top-full mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border-line bg-white px-3.5 pb-3 pt-2.5 shadow-[0_10px_30px_rgba(43,35,32,0.18)]`. 화면 안으로 민다(`:35-42`).
  - 내용: 요약 12 semibold / 6칸 그리드(시각 10 · 이모지 16 · 기온 10 semibold) / 관측 10.
  - 실내 토글 `rounded-xl px-3 py-2 text-xs font-bold`. 켜짐 jade, 꺼짐 금.
  - 바깥을 누르면 닫힌다(`:51-58`).
- **Expo(현재):** `ToolChips.tsx:80-103` — `ModalSheet`. 요약 14, 칸 `min-h 64`(11/18/12), 토글 44px 13px.
- **차이:** 형태·위치(판 vs 시트+막), 폭(288 vs 전체), 글자 +1~2px.
- **중요도:** P0
- **분류:** 배치 · 동작
- **고칠 방법:**
  1. 칩 아래 `absolute` 팝오버로 바꾼다(폭 min(288, 화면−32), 왼쪽은 화면 안으로 보정). 스타일은 웹 값 그대로.
  2. 바깥을 누르면 닫는다(열려 있는 동안 투명 `Pressable` 을 깔거나 루트 터치 캡처).
  3. 글자 크기를 웹 값(10/16/10/10, 토글 12 bold)으로 맞춘다.
- **바꿀 Expo 파일:** `ToolChips.tsx`, `HomeScreen.tsx`(z 순서)
- **문구:** 재사용 `weather.sixHour`·`weather.observedAt`·`setup.indoorOnly`
- **네이티브 주의:** 지도 위 absolute 판은 react-native-maps 위에서도 정상이다.
- **확인 방법:** `02-top`/`04-mocks` 를 다시 돌린다.
- **크기·의존:** M · G2-15

### G2-17 축제 패널 내용·크기

- **화면·상태:** G2-TOP-08·09
- **스크린샷:** `festival-panel-web.pair.png`(웹만 — Expo 는 G2-G07, 코드 비교)
- **웹(기준):** `FestivalBanner.tsx:280-451`
  - 막 `bg-black/30`, 판 `max-h-[78vh] max-w-lg rounded-t-3xl bg-hanji p-5`.
  - 머리: 18 bold + 12 부제 + **X**.
  - 카드: `border-line bg-white/70`, 포스터 h-24.
  - 글자: 배지 10 · 기간 11(`CalendarDays` 12) · 거리 11 bold(`MapPin` 12) · 제목 14 bold · 장소·🕐·💰 11 · 라벨 10 · 소개 11 relaxed clamp3 · 더보기 11.
  - 버튼: `px-2.5 py-1.5 rounded-full text-[11px] font-bold` + 아이콘 11.
- **Expo(현재):** `ToolChips.tsx:203-276`
  - ModalSheet(흰 95%, 손잡이, 검정 35%), X 없음.
  - 글자: 배지 11 · 기간 12 · 거리 12(아이콘 없음) · 장소 12 · 소개 12/18.
  - 더보기·버튼 44px 12px.
- **차이:** 판 바탕(한지 vs 흰), X 없음, 글자 전부 +1px, 버튼 44 vs ≈31px, 카드 바탕, 막 색.
- **중요도:** P1
- **분류:** 글꼴 · 크기·간격 · 누락
- **고칠 방법:**
  1. `ModalSheet` 에 `background="hanji"` 와 머리 X 옵션을 넣는다(`Sheet.tsx:115-121`).
  2. 글자·여백을 웹 값으로 맞춘다. 카드는 p 16, 바탕 `rgba(255,255,255,0.7)`.
  3. 버튼은 보이는 크기를 웹으로 하고, `hitSlop` 으로 탭 영역 44 를 지킨다.
  4. 막을 `rgba(0,0,0,0.3)` 으로.
- **바꿀 Expo 파일:** `ToolChips.tsx`, `Sheet.tsx`
- **문구:** 재사용 `festival.*`·`compare.showOnMap`·`common.close`
- **확인 방법:** G2-G07 을 고친 뒤 `04b-panels` 를 다시 돌린다.
- **크기·의존:** S~M · G2-G07, G2-13
- **표시:** 촬영 못 함(Expo)

### G2-18 화장실 패널

- **화면·상태:** G2-TOP-10
- **스크린샷:** `restroom-panel-web.pair.png`(웹만)
- **웹(기준):** `RestroomChip.tsx:45-64`
  - 막 `bg-black/30`, 판 `max-h-[70vh] rounded-t-3xl bg-hanji p-5`, 18 bold + 12 + X.
  - 줄: `<a>` `rounded-2xl border-line bg-white/70 p-3`. 이름 14 bold · 주소 12 · `MapPin` 13 + 거리 12 bold gold-deep.
- **Expo(현재):** `ToolChips.tsx:319-344` — 흰 시트, X 없음, 줄 `min-h 56 bg-white px-12 py-10`, 거리 아이콘 없음.
- **중요도:** P2
- **분류:** 색·효과 · 아이콘
- **고칠 방법:** G2-17 의 hanji 바탕·X 를 같이 쓴다. 줄 p 12, 바탕 70%, 거리 앞 `MapPin` 13.
- **바꿀 Expo 파일:** `ToolChips.tsx`
- **크기·의존:** S · G2-G07, G2-17
- **표시:** 촬영 못 함(Expo)

### G2-19 검색 입력 중(우리 장소 일치) — 웹 지도 필터·이름표·확대, Expo 결과 목록

- **화면·상태:** G2-TOP-02(`향화`)
- **스크린샷:** `search-local-typing.pair.png`, `search-local-typing-top.pair.png`
- **웹(기준):** 목록이 없다.
  - 핀이 일치하는 곳(모든 분류)으로 바뀐다.
  - 핀마다 이름표를 단다(`page.tsx:3188-3201`: `rounded-full border-gold/50 bg-white/95 px-2.5 py-1 text-[11px] font-bold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.14)]`, yAnchor 3.2, 실측 47×27).
  - 레벨 3 + 가장 가까운 일치로 이동한다(`:3693-3703`).
  - 날씨 줄만 숨기고 **분류 칩 줄은 유지**한다(실측 y=134). Enter 는 첫 일치를 카드로 연다.
- **Expo(현재):** `HomeScreen.tsx:674-698`
  - 칩 줄 셋을 모두 숨기고 `SearchPanel`(`HomeOverlays.tsx:59-153`) 'NextSpot 장소 검색 결과' 목록을 보인다.
  - 확대·이동·이름표 없음.
- **차이:** 지도 표시 vs 목록, 칩 줄 유지 여부, 자동 확대, 이름표.
- **중요도:** P0
- **분류:** 동작 · 배치 · 추가
- **고칠 방법:**
  1. 일치가 있으면 '우리 장소' 블록을 그리지 않는다. 외부 검색은 일치가 0일 때만 한다(지금 규칙 유지).
  2. 검색 중에도 분류 칩 줄은 보인다. 첫 칩 줄만 숨긴다.
  3. 검색어가 2자 이상이고 일치가 있으면 가장 가까운 곳으로 `focusOn(…, 3)`.
  4. 일치 핀마다 이름표를 단다. `NextSpotMap` label 에 `variant:'search'` 를 추가해 웹 모양으로 그린다. 지금 label(`NextSpotMap.web.tsx:663-682`)은 축제용 색 바탕이다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, `HomeOverlays.tsx`, `NextSpotMap.web.tsx`, `NextSpotMap.tsx`, `types.ts`
- **문구:** `app.home.searchLocalTitle` 은 더 쓰지 않게 된다(삭제는 통합 때). 새 키는 없다.
- **네이티브 주의:** 구글 마커 이름표는 비용이 있다. 상한 12(웹 검색 상한).
- **확인 방법:** `02-top` 을 다시 돌린다.
- **크기·의존:** M · G2-03

### G2-20 카카오 장소 결과 줄 배치·버튼

- **화면·상태:** G2-TOP-03(+ 불러오는 중)
- **스크린샷:** `search-kakao-results.pair.png`, `search-kakao-loading.pair.png`
- **웹(기준):** `page.tsx:4145-4219`
  - 판: `rounded-2xl bg-white/95 backdrop-blur border-line shadow`.
  - 머리: `Search` 12 **gold** + 12 semibold, 출처 10.
  - 왼쪽 열: 이름 14 medium · 주소 11 · 분류 **알약** 10px(`bg-line/60`) · '대신 갈 곳 보기 >' jade 외곽 44px 13px.
  - 오른쪽 세로 열: '지도에서 보기' 금 외곽 11px 알약 + '카카오맵' 글자 링크 10px.
  - 목록 `max-h-64`. 불러오는 중은 12px 테두리 스피너.
- **Expo(현재):** `HomeOverlays.tsx:106-129`
  - 아이콘 gold-deep, 출처 11, 분류는 그냥 글자.
  - 버튼 셋을 같은 회색 `SmallAction`(44px 12 bold)으로 한 줄에 둔다.
  - 판 최대 360, `ActivityIndicator`.
- **차이:** 버튼 배치·색·크기, 분류 알약, 아이콘 색, 출처 크기.
- **중요도:** P1
- **분류:** 배치 · 색·효과 · 글꼴
- **고칠 방법:**
  1. 줄 구조를 웹처럼 왼쪽(정보 + jade 대안 버튼) / 오른쪽(금 외곽 '지도에서 보기' + 글자 링크 '카카오맵')으로 나눈다.
  2. 분류를 알약(10px, `rgba(230,220,198,0.6)`)으로 바꾼다.
  3. 아이콘을 gold 로, 출처를 10 으로 바꾸고 판에 흐림·그림자를 넣는다. 목록 최대 256.
  4. 스피너를 12px 원으로 바꾼다.
- **바꿀 Expo 파일:** `HomeOverlays.tsx`
- **문구:** 재사용 `map.placeSearch*`·`map.searchKakaoPlace`·`waiting.seeInstead`·`card.seeInsteadAria`
- **확인 방법:** `04-mocks` 를 다시 돌린다.
- **크기·의존:** S~M · G2-19

### G2-21 관광공사(TourAPI) 결과 — 사진·jade 판·버튼 색, 적재 요청(결정 필요)

- **화면·상태:** G2-TOP-04
- **스크린샷:** `search-tourapi-results.pair.png`
- **웹(기준):** `page.tsx:4225-4305`
  - 판 테두리 `jade/40`, 아이콘 jade.
  - 사진 48px `rounded-xl border-line`.
  - 버튼: **채운 jade** '지도에서 보기'(흰 11 bold) · jade 외곽 '카카오맵 길찾기' · 회색 '다음 배치 추가 요청'.
  - 적재 요청은 [W] `POST /api/v1/search/ingest-request` 이고, 누르면 '요청 접수됨'으로 잠긴다.
- **Expo(현재):** `HomeOverlays.tsx:130-149` — line 테두리, 사진 없음, 회색 버튼 둘, 적재 요청 없음.
- **중요도:** P1
- **분류:** 누락 · 색·효과
- **고칠 방법:**
  1. 이 블록만 jade 테두리·아이콘으로 바꾼다.
  2. `firstimage` 를 48px `expo-image` 로 보인다(실패 시 숨김).
  3. 버튼 색을 웹처럼 바꾼다.
  4. (결정 시) 적재 요청: 웹 `:3760` 본문 그대로 보내고, 알림은 G2-G09 알약.
- **바꿀 Expo 파일:** `HomeOverlays.tsx`, `usePlaceSearch.ts`
- **문구:** 재사용 `map.tourApiTitle`·`tourApiSource`·`placeSearchView`·`searchKakaoRoute`·`ingestRequest`·`ingestRequested`·`ingestRequestDone`·`ingestRequestFailed`
- **크기·의존:** S
- **표시:** 결정 필요(적재 요청)
  - 선택지 ① 둔다
  - 선택지 ② 제외 유지
  - **추천 ①**

### G2-22 검색 결과 없음 — 웹 떠 있는 알약, Expo 흰 카드

- **화면·상태:** G2-TOP-05
- **스크린샷:** `search-no-result.pair.png`
- **웹(기준):** `page.tsx:4134-4142` — `inline-block text-xs bg-white/90 border-line rounded-full px-3 py-1 shadow`(실측 266×26, 내용 폭). 분류 칩 줄은 남는다.
- **Expo(현재):** `HomeOverlays.tsx:66-85` — 전체 폭 흰 `Card` 안 12px 글. 칩 줄은 숨는다.
- **중요도:** P1
- **분류:** 배치 · 색·효과
- **고칠 방법:**
  1. 카드 대신 알약을 쓴다: `alignSelf flex-start, ml 8, mt -4, rgba(255,255,255,0.9), border line, rounded-full, px 12 py 4, 12px, shadow card`.
  2. Expo 전용 AI 동의 거절 안내는 G2-32 결정과 같이 정한다.
- **바꿀 Expo 파일:** `HomeOverlays.tsx`, `HomeScreen.tsx`
- **문구:** 재사용 `map.searchNoResult`·`map.searchNoResultAnywhere`
- **크기·의존:** S · G2-19

### G2-23 검색 지우기 버튼

- **화면·상태:** G2-TOP-06
- **스크린샷:** `search-cleared.pair.png`
- **웹(기준):** `page.tsx:4057-4066` — X 18 muk-soft `tap-target ml-3`. 검색어만 지운다.
- **Expo(현재):** `HomeScreen.tsx:669-671` — IconButton 상자 36, X 20. 임시 장소 핀도 같이 지운다.
- **중요도:** P2
- **분류:** 아이콘 · 동작
- **고칠 방법:** 아이콘 18, 상자 18 + `hitSlop` 13, `ml 12`. 임시 핀은 지우지 않는다(웹과 같게).
- **바꿀 Expo 파일:** `HomeScreen.tsx`
- **크기·의존:** S

### G2-24 혼잡 예측 띠(🔮) 없음 — 결정 필요

- **화면·상태:** G2-TOP-12
- **스크린샷:** `home-default.pair.png`, `forecast-plus1-web.pair.png`
- **웹(기준):** `ForecastTimeStrip`(`page.tsx:5008-5022`, `W:components/main/ForecastTimeStrip.tsx`). 표시 조건은 `:3962`.
  - 모양: 폰은 카드 바로 위 `section` 16,449,358×46 `rounded-2xl border-line bg-white px-2 py-1.5 shadow`.
  - 내용:
    - `🔮 혼잡 예측` 11 extrabold.
    - `role=slider` 225×27 `bg-hanji-deep rounded-full`. 칸 지금/+1시간 후/+2시간 후/+3시간 후 11 bold, 고른 칸은 `bg-muk text-hanji`.
    - '다른 시간' 50×32.
  - 동작: +N 을 고르면 `POST /predict/batch`(읽기)를 부른다. 그러면 핀 예측색·배지·범례·이 일대 칩이 바뀐다. 실패하면 `map.predictFail` 알림.
  - 카드가 펼쳐지면 숨는다.
- **Expo(현재):** 없다(계획, 가정 시각 D7 도 없음). 그래서 시트가 웹보다 아래(위끝 y≈672 vs 웹 띠 449·카드 503)에 놓인다.
- **중요도:** P0
- **분류:** 누락 · 동작
- **포팅에 드는 것:**
  1. RN 판 띠를 만든다. 슬라이더는 접근성 `adjustable`. '다른 시간' 은 D7 과 같이 정한다.
  2. 규칙은 `W:lib/forecastStrip.ts`(타입 import — check:shared 확인).
  3. 자료: `POST /predict/batch` 와 `GET /api/v1/area-demand/forecast`(Expo `M:features/waiting/api.ts:17` 재사용).
  4. 핀 다시 칠하기: `pinDisplay({forecastMode, forecastLevel})`(공용 markerSvg 가 지원).
  5. 자리: 시트 위끝 − 8. 펼치면 숨긴다.
  6. 카메라 띠에 넣는다(G2-01).
- **바꿀 Expo 파일:** 새 `ForecastStrip.tsx`, `HomeScreen.tsx`, `homeModel.ts`, apiClient
- **문구:** 재사용 `forecast.*`(title·now·ahead·aheadShort·basis·otherTimes·badgeArea·badgeModel·badgeShort·legendNow·legendAhead·legendPick·areaNow·loading)·`map.forecastEstimateTag`·`map.predictFail`
- **네이티브 주의:** 띠 끌기와 시트 끌기가 겹치지 않게 한다.
- **크기·의존:** L · G3, G2-01
- **표시:** 결정 필요
  - 선택지 ① 지금 포팅
  - 선택지 ② v1.1
  - **추천 ①:** 첫 화면 구성·카드 위치가 같아지고, '도착 시점 예측'이 서비스 핵심이다. '다른 시간' 프리셋은 미뤄도 된다.

---

## [CHIP] 분류 칩·필터·편의

### G2-25 분류 칩 줄 — 아이콘 없음 · 주차장 탭 없음 · 유리 · 간격 · 굵기

- **화면·상태:** G2-CHIP-01·02
- **스크린샷:** `home-top-clip.pair.png`, `chip-cafe.pair.png`, `parking-tab-web.pair.png`
- **웹(기준):** `page.tsx:4440-4470` 줄 `gap-2 overflow-x-auto`(x=16)
  - `필터·편의`(`:4443-4449`): 유리 `h-9 px-3 text-[13px] font-bold` + `SlidersHorizontal` 14.
  - 분류 5개(`:3299-3306`): 음식점 `Utensils` · 카페 `Coffee` · 관광지 `MapPin` · 문화시설 `Building2` · 주차장 `Car`.
    - 모양: `h-9 gap-1.5 px-3.5 text-[13px] font-semibold shadow-[0_2px_10px_rgba(43,35,32,0.06)]`, 아이콘 15.
    - 비활성은 유리 + 아이콘 #4b3b1d, 활성은 `bg-muk text-hanji`.
  - 실측 폭 81/71/81/90/81. `aria-pressed`.
- **Expo(현재):** `HomeScreen.tsx:715-742` — gap 6, x=12.
  - 필터·편의는 흰 13px **semibold**. 조건이 있으면 jade 가 된다(웹에는 없는 상태).
  - 분류 4개 글자만(60/50/60/70), 흰 불투명. `aria-selected`.
- **차이:** 아이콘·주차장 없음, 유리·그림자 없음, 간격·시작 위치, 굵기, jade 상태, 접근성 속성.
- **중요도:** P0
- **분류:** 누락 · 아이콘 · 색·효과 · 크기·간격
- **고칠 방법:**
  1. 아이콘 15 + gap 6, px 14, 높이 36, 13 semibold. 활성은 muk/hanji, 비활성은 `Glass` + `glass-gold-deep` 아이콘 + 그림자.
  2. 필터·편의: `Glass` + **bold**, jade 상태 제거.
  3. 줄 gap 8, 시작 16.
  4. 웹 빌드에서 `aria-pressed` 를 준다.
  5. 주차장 탭(결정 시):
     - `Car` + `category.parking`. `GET /api/v1/area-demand/parking-lots` 로 공영주차장 핀을 그린다.
     - 카드: `map.parkingEyebrow` · 이름 · 거리 · 잔여면 jade 판 · 검정 '자동차 길안내'(`parking-tab-web`).
     - 이 탭에서는 필터·편의와 예측 띠를 숨긴다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`(+ 주차장: 새 `ParkingPanel.tsx`, `homeModel`)
- **문구:** 재사용 `category.*`·`map.mobileTools`·`map.parking*`
- **확인 방법:** `01-default` 계측에서 칩 폭과 아이콘을 본다.
- **크기·의존:** 칩 S + 주차장 L · G2-G03, G2-11
- **표시:** 결정 필요(주차장 탭)
  - 선택지 ① 포팅
  - 선택지 ② 제외 유지
  - **추천 ①:** 칩 아이콘·유리는 결정과 상관없이 지금 한다.

### G2-26 음식 종류 칩 줄이 홈에 따로 나온다(웹은 시트 안에만)

- **화면·상태:** G2-CHIP-03
- **스크린샷:** `home-top-clip.pair.png`, `cuisine-hansik.pair.png`
- **웹(기준):** 폰 홈에는 음식 칩 줄이 없다. 시트 안에만 있다(`page.tsx:4586-4590`).
- **Expo(현재):** `HomeScreen.tsx:743-763` — 음식점일 때 셋째 줄 8칩(36px)이 늘 보인다. 머리가 44px 길어져 지도 띠·카메라에 영향을 준다.
- **중요도:** P0
- **분류:** 추가 · 배치
- **고칠 방법:** 해당 블록을 지운다. 고른 음식 표시는 카드 조건 칩(G3)이 맡는다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`
- **크기·의존:** S · G2-27

### G2-27 필터·편의 시트 — 구성·모양

- **화면·상태:** G2-CHIP-04·05·06
- **스크린샷:** `tools-sheet-open.pair.png`, `tools-sheet-festival-restroom.pair.png`(웹만)
- **웹(기준):** `page.tsx:4571-4595`
  - 막·판:
    - 막 `bg-muk/35`, 누르면 닫힌다. 하단 탭도 덮는다.
    - 판 `rounded-t-3xl bg-hanji px-4 pt-3 pb-[20px+safe] shadow-2xl`, 손잡이 없음, 스프링 등장.
  - 머리: 16 bold + 12 muk-soft. 닫기 `rounded-full border-line bg-white p-2` + X 18.
  - 칸 그리드:
    - 2열 gap 8: 🔥히트맵 · ♿휠체어 · 👶유모차(자료 있을 때) · 🅿주차.
    - 칸 모양 `rounded-xl border px-3 py-3 text-sm font-semibold`(175×46). 꺼짐 `border-jade/30 bg-white`, 켜짐 `border-jade bg-jade/15`.
    - **반려동물 없음.**
  - 음식 칩(음식점일 때):
    - `음식 종류` 12 bold + **한 줄 스크롤** 칩.
    - 칩 `px-3 py-1.5 text-xs font-semibold`(30px). 선택 `border-gold bg-gold/15 text-gold-deep`.
    - 첫 설정 음식은 금 링 `ring-2 ring-gold/70 ring-offset-1`.
  - 그다음 축제·화장실 칩.
- **Expo(현재):** `HomeOverlays.tsx:204-246`
  - gorhom 모달(손잡이, 흰 95%, 검정 35%).
  - 타일 `w-48% min-h 48 border-line bg-white`, 14 semibold. 히트맵 없음, 🐾 있음.
  - 음식 칩 44px 13px **여러 줄**, 선택 jade, 첫 설정 링 없음, 축제·화장실 없음.
- **차이:** 칸 구성, 바탕, 손잡이, 타일 테두리·높이, 음식 칩 크기·줄바꿈·선택색·링, 막 색.
- **중요도:** P0
- **분류:** 누락 · 추가 · 색·효과 · 크기·간격
- **고칠 방법:**
  1. `ModalSheet` 를 hanji 바탕 + 손잡이 숨김(X 로 닫기)으로 한다.
  2. 막을 `rgba(43,35,32,0.35)` 로.
  3. 타일: 높이 46, 꺼짐 테두리 `rgba(62,124,106,0.3)`, 켜짐 `rgba(62,124,106,0.15)`.
     - 첫 칸은 히트맵(G2-09 결정).
     - 🐾 는 폰 시트에서 뺀다(웹 데스크톱 툴바에만 있다).
  4. 음식 칩: 한 줄 가로 스크롤, 30px, px 12, 12 semibold. 선택 금, 첫 설정 음식은 금 링(2px 0.7 + 1px hanji 간격).
  5. 아래 줄에 축제·화장실(G2-13).
- **바꿀 Expo 파일:** `HomeOverlays.tsx`, `Sheet.tsx`, `HomeScreen.tsx`
- **문구:** 재사용 `map.mobileToolsTitle`·`mobileToolsDesc`·`heatmap`·`barrierFree`·`stroller`·`filterParking`·`foodFilters`·`cuisine.*`·`common.close`
- **네이티브 주의:** 시트 안 가로 스크롤과 시트 끌기가 겹친다(`nestedScrollEnabled`).
- **확인 방법:** G2-G07 을 고친 뒤 `02-top` 을 다시 돌린다.
- **크기·의존:** M · G2-G07, G2-09, G2-13
- **표시:** 촬영 못 함(Expo)

### G2-28 ♿·👶·실내 조건 — 웹은 저장·자동 칩 전환·안내, Expo 는 화면 상태만

- **화면·상태:** G2-CHIP-05·06·07, TOP-07 실내
- **스크린샷:** 없음(코드 비교)
- **웹(기준):**
  - `toggleRequiredAttribute`(`page.tsx:618-633`): `nextspot_setup_prefs` 에 저장하고 `track` 을 보낸다.
  - `onBarrierFreeChip`·`onStrollerChip`(`:3618, 3553`):
    - 지금 칩 후보가 0이면 칩을 바꾸고 알림(`map.barrierFreeSwitched`/`strollerSwitched`).
    - 아니면 조건 핀을 한 화면에 맞추고(`fitAttributePins` `:3573-3600`), 핀이 없으면 안내 카드를 보인다.
  - 🅿·🐾 0곳이면 알약(`:4407-4423`).
  - 실내 토글도 저장한다(`:4096-4110`).
- **Expo(현재):** `HomeScreen.tsx:393-408` — 상태만 바꾸고 선택을 비운다. 저장·전환·알림·맞춤·0곳 안내가 없다.
- **중요도:** P1
- **분류:** 동작 · 상태
- **고칠 방법:**
  1. `saveTravelContext` 로 저장한다(없으면 웹 `W:lib/travelContext.ts:164-197` 규칙으로 추가).
  2. 0곳이면 칩을 바꾸고 알림을 띄운다(G2-G09).
  3. 조건 핀은 `fitToCoordinates` + 띠 인셋으로 맞춘다.
  4. 0곳 알약을 넣는다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, `features/course/travelContext.ts`
- **문구:** 재사용 `map.barrierFreeSwitched`·`strollerSwitched`·`searchNoResult`·`filterParking`·`filterPet`·`barrierFreeOnMap`·`strollerOnMap`·`strollerNone` 계열·`strollerOff`
- **크기·의존:** M · G2-27, G2-G09

### G2-29 첫 화면 칩 자동 전환(지금 문 연 곳이 많은 칩) 없음

- **화면·상태:** G2-CHIP-09
- **스크린샷:** 없음(시각 의존 — 14시 촬영에서는 발생 안 함)
- **웹(기준):** `page.tsx:3398-3420` — 첫 칩에 영업 중인 곳이 0이면 가장 많은 칩으로 바꾸고 `map.firstViewSwitched` 알림을 띄운다.
- **Expo(현재):** 없다. 밤·휴무에 첫 칩이 웹과 달라질 수 있다.
- **중요도:** P2
- **분류:** 동작
- **고칠 방법:** `@/lib/firstViewCategory`(타입만 import — 순수)로 첫 추천 전에 판정 → `setCategory` + 알림.
- **바꿀 Expo 파일:** `HomeScreen.tsx`
- **크기·의존:** S

### G2-30 '근처의 다른 곳' 제안 카드 — Expo 가 빈 지도 탭 뒤에도 띄운다 + 모양

- **화면·상태:** G2-CHIP-08, MAP-09
- **스크린샷:**
  - `map-empty-tap.pair.png`: 빈 지도를 눌렀을 때 웹은 카드 없음, Expo 는 '카페 248곳·관광지 31곳·문화시설 8곳' 카드.
  - `synthetic-cafe-suggestion.pair.png`: 진짜 0곳일 때 양쪽 다 카드.
- **웹(기준):**
  - 조건(`page.tsx:4702-4705`): 카드 없음 && **`noRecommendation`(이 칩 후보 0)** && 제안 칩 있음.
  - 개수는 여행 조건으로 거른 수다(`:3636-3650`).
  - 모양(`:4916-4990`): `bg-white border-line rounded-2xl px-5 py-4 shadow gap-2` + 마스코트 avatar 48 + 14 semibold + 금 버튼 `border-gold/50 bg-gold/10 px-3.5 py-2 text-xs font-bold text-muk`.
  - 빈 지도를 누르면 카드만 사라진다.
- **Expo(현재):** `HomeScreen.tsx:564-569, 813-829`
  - 조건이 '선택 없음'뿐이라 빈 지도 탭 뒤에도 뜬다(버그).
  - 개수는 그 종류 전체 수다.
  - 마스코트 없음, 버튼 jade 44px 13px.
- **중요도:** P0
- **분류:** 동작 · 상태 · 색·효과
- **고칠 방법:**
  1. 조건에 '이 칩 추천 0곳(조건 적용)'을 더한다.
  2. 개수를 웹 `chipCandidates` 규칙으로 센다(순수 함수인지 확인).
  3. 모양을 마스코트 48 + 14 semibold + 금 버튼(12 bold muk, px 14 py 8, `hitSlop` 44), 카드 px 20 py 16 으로.
  4. ♿·👶·휴무 문구 분기를 넣는다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`
- **문구:** 재사용 `map.suggestTitle`·`suggestButton`·`barrierFreeElsewhere`·`strollerElsewhere`·`noRecClosedBody`
- **확인 방법:** `11-taps`·`12-synthetic` 을 다시 돌린다.
- **크기·의존:** S~M · G2-05

---

## [POP] 묶음 핀

### G2-31 같은 건물 묶음 핀 — 웹은 지도 위 말풍선, Expo 는 바텀 시트

- **화면·상태:** G2-POP-01·02, MAP-06
- **스크린샷:** `group-pin-open.pair.png`(웹 말풍선, Expo 화면엔 묶음 핀 없음 — G2-03), `synthetic-group-pin-tap.pair.png`
- **웹(기준):** `page.tsx:3139-3176`
  - 누르면 핀이 확대되고 카드가 비워진다.
  - Kakao CustomOverlay(yAnchor 1.3, zIndex 50): `bg-white/90 backdrop-blur border-line rounded-2xl p-2 shadow-[0_2px_14px_rgba(43,35,32,0.1)] gap-1 min-w-180 max-w-280 max-h-260`.
    - 제목: `text-[11px] text-gold-deep font-bold px-2 py-1 mb-1 border-b tracking-wider`.
    - 가게: `text-xs px-3 py-2.5 rounded-xl font-semibold leading-snug`.
  - 지도는 그 핀으로 `panTo` 한다. X 없이 빈 지도·다른 핀·가게를 누르면 닫힌다.
- **Expo(현재):** `HomeScreen.tsx:455-463, 899-907` + `HomeOverlays.tsx:250-275`
  - `ModalSheet`, 제목 12 bold, 줄 48px 14 semibold, `focusOn`.
- **중요도:** P0
- **분류:** 배치 · 동작
- **고칠 방법:**
  1. `NextSpotMap` 에 `popover {coordinate,title,items}` + `onPopoverPick` 를 추가한다.
     - 웹 빌드: CustomOverlay 로 웹 DOM 을 그대로.
     - 네이티브: `pointForCoordinate` 위치에 absolute RN View. 지도가 움직이면 갱신하거나 잠깐 숨긴다. `Callout` 은 안드로이드에서 안쪽 버튼을 누르기 어렵다.
  2. 핀 좌표로 단순 이동한다(띠 가운데 아님).
  3. `GroupSheet` 를 지운다.
- **바꿀 Expo 파일:** `NextSpotMap.web.tsx`, `NextSpotMap.tsx`, `types.ts`, `HomeScreen.tsx`, `HomeOverlays.tsx`
- **문구:** 재사용 `map.placesInBuilding`
- **확인 방법:** `12-synthetic` 을 다시 돌린다.
- **크기·의존:** M~L · G2-03
- **표시:** 촬영 못 함(Expo)

---

## [LOC] 위치

### G2-32 내 위치 버튼 · 위치 배너 · 위치 안내 화면(Expo 전용) — 결정 필요

- **화면·상태:** G2-LOC-01~07
- **스크린샷:** `home-default.pair.png`, `loc-prompt`·`loc-denied`·`loc-no-consent`·`loc-coarse`·`loc-outside.pair.png`
- **웹(기준):** 버튼·배너·안내 화면이 없다.
  - 거부·실패: 알약 `map.locationFallback` 3초(`page.tsx:1203-1209`).
  - 경주 밖: `map.outOfRegionStart` 세션당 1회.
  - 대략적 위치 구분 없음.
- **Expo(현재):** `HomeScreen.tsx:795-812, 908`, `HomeOverlays.tsx:280-313`
  - 버튼: `LocateFixed` 36px(실측 342,521).
  - 배너: 📍 + `app.home.locationBanner.enable`/`coarse` + `>` + X.
  - 안내 화면: 막 + 카드 + `계속`.
  - 경주 밖 알림은 sonner.
- **중요도:** P0
- **분류:** 추가 · 동작
- **고칠 방법(선택지별):**
  - ① 웹에 맞춘다: 버튼·배너를 지우고, 거부·동의 없음·실패는 `map.locationFallback` 알약, 밖은 `map.outOfRegionStart` 알약(G2-G09). 법적 동의 재진입은 마이>설정 줄(이미 있다). 안내 화면은 네이티브에만 남긴다.
  - ② Expo 전용으로 유지한다.
  - ③ 웹에도 버튼을 추가한다.
- **바꿀 Expo 파일:** `HomeScreen.tsx`, `HomeOverlays.tsx`, `locationPolicy.ts`
- **문구:** 재사용 `map.locationFallback`·`map.outOfRegionStart`. ① 이면 `app.home.locationBanner.*`·`app.home.myLocation.*` 을 더 쓰지 않는다.
- **네이티브 주의:** 안드로이드는 두 번 거부하면 다시 묻지 못한다. ① 이면 다시 켜는 길이 설정뿐이다.
- **확인 방법:** `07-location` 을 다시 돌린다.
- **크기·의존:** S~M · G2-G09, G2-04
- **표시:** 결정 필요
  - **추천 ①:** 마이>설정에 '위치 다시 허용' 안내를 둔다.
  - 촬영 못 함: LOC-04 안내 화면(헤드리스가 권한 '묻기'를 바로 거부로 처리).

---

## [NTC] 공지·점검

### G2-33 공지 배너 — 확성기 아이콘·글꼴·그림자·흐림·닫기 아이콘

- **화면·상태:** G2-NTC-01
- **스크린샷:** `notice-banner-top.pair.png`, `notice-banner.pair.png`
- **웹(기준):** `W:components/shell/PublicSettingsProvider.tsx:101-127`
  - 카드: `rounded-2xl border-gold/40 bg-white/95 px-3 py-2.5 shadow-[0_2px_14px_rgba(43,35,32,0.14)] backdrop-blur max-w-2xl gap-2`.
  - `Megaphone` 15 gold-deep, 글 12 medium muk `leading-snug`, 닫기 `X` 14 muk-soft `p-1`. `role=status`.
- **Expo(현재):** `M:lib/core/publicSettings.tsx:127-169`
  - 아이콘 없음. RN 기본 `Text` 를 써서 **시스템 글꼴**(실측 `-apple-system`), 12/17.
  - 닫기는 글자 '✕' `#5E5450`. 테두리 `rgba(176,141,87,0.4)`, 바탕 0.97.
  - 그림자·흐림 없음. `role=alert`.
- **중요도:** P1
- **분류:** 아이콘 · 글꼴 · 색·효과
- **고칠 방법:** `M:app/_layout.tsx:117-128` 에서 `renderNotice` 로 새 `M:components/AppNoticeBanner.tsx` 를 넘긴다.
  - 글: 앱 `Text` medium 12 `leading-[16.5px]`.
  - `Megaphone` 15 gold-deep, 닫기 `IconButton X 14`.
  - 카드: 테두리 `rgba(193,154,62,0.4)`, 바탕 0.95, `px 12 py 10`, `maxWidth 672`, 그림자, 웹 빌드는 흐림.
  - `accessibilityLiveRegion polite`.
- **바꿀 Expo 파일:** 새 `AppNoticeBanner.tsx`, `app/_layout.tsx`
- **문구:** 재사용 `systemNotice.dismiss`
- **확인 방법:** `08-notices` 를 다시 돌린다.
- **크기·의존:** S

### G2-34 점검 화면 — 렌치 원·공지 카드·글꼴·색

- **화면·상태:** G2-NTC-02
- **스크린샷:** `maintenance.pair.png`
- **웹(기준):** `PublicSettingsProvider.tsx:137-157`
  - 바탕 `bg-hanji`, 가운데 `max-w-sm space-y-3`.
  - 렌치 원: 56px `border-gold/30 bg-gold/10` + `Wrench` 24 gold-deep.
  - h1 20/28 bold, 본문 14 `leading-relaxed` muk-soft.
  - 공지: **카드** `rounded-2xl border-line bg-white px-4 py-3 text-[12px] leading-relaxed`.
- **Expo(현재):** `publicSettings.tsx:107-124`
  - 바탕 `#F7F3EA`, 아이콘 없음.
  - 시스템 글꼴 20 bold, 본문 14/21 `#5E5450`.
  - 공지는 카드 없이 12px 글이다.
- **중요도:** P0
- **분류:** 누락 · 글꼴 · 색·효과
- **고칠 방법:** `renderMaintenance` 로 새 `M:components/AppMaintenanceScreen.tsx` 를 넘긴다.
  - 바탕 hanji, 56px 원 + 렌치.
  - 앱 `Text` 20 bold `leading-28`, 14 muk-soft `leading-[22.75px]`.
  - 공지는 `Card` 안 12px `leading-[19.5px]`.
- **바꿀 Expo 파일:** 새 `AppMaintenanceScreen.tsx`, `app/_layout.tsx`
- **문구:** 재사용 `systemNotice.maintenanceTitle`·`maintenanceBody`
- **확인 방법:** `08-notices` 를 다시 돌린다.
- **크기·의존:** S

---

## 촬영하지 못한 상태(코드로 비교)

- **MAP-05 캐시 시설:** 두 앱의 캐시 모양이 달라 서로 시드할 수 없다. 인벤토리 권고대로 생략했다.
- **MAP-07 키 없음:** 빌드를 다시 해야 한다. SDK 차단으로 대신 찍었다(G2-08).
- **MAP-10·TOP-09 축제 지도 포커스:** Expo 축제 시트가 열리지 않는다(G2-G07). 코드상 원 색·반경·레벨(5/4)·라벨은 같다.
- **Expo 시트 상태 전부:** TOP-07 Expo 시트, TOP-08·10·11 패널, CHIP-04·05·06, POP-01·02. 원인은 G2-G07.
- **LOC-04 위치 안내 화면:** 헤드리스가 권한 '묻기'를 바로 거부로 처리해 Expo 가 거부 배너로 갔다.
- **기타:**
  - LOC-07 배너 닫음.
  - CHIP-09 첫 화면 전환: 14시 촬영이라 발생하지 않았다.
  - TOP-13 음성 비서 동작: LLM 이 차단돼 있다.
- **웹 단독 참고 그림(Expo 짝 없음):** `forecast-plus1-web`, `guide-dialog-web`, `heatmap-on-web`, `parking-tab-web`, `discovery-open-web`, `festival-panel-web`, `restroom-panel-web`.

## 열린 질문

1. 웹 첫 화면에서 1위 추천 핀이 칩 줄 바로 아래(y≈229)로 간다. 의도인가, 아니면 펼친 카드 높이로 띠를 재는 버그인가(G2-01)?
2. gorhom `BottomSheetModal` 이 웹 빌드에서 뜨지 않는 원인은 무엇이고, 네이티브에서는 정상인가(G2-G07)?
3. 안드로이드 유리 흐림(dimezis)의 성능은 괜찮은가(G2-G03)?
4. Hermes `Intl` 이 `timeZone:'Asia/Seoul'` 을 지원하는가(G2-10)?
5. 포팅 범위: 콘솔 링크(G2-G01), 위치 버튼·배너(G2-32), 예측 띠·음성·✨·히트맵·주차장 탭(G2-24·12·14·09·25).
6. 웹 `LanguageSwitcher` 의 화면 읽기 라벨이 '언어 선택'으로 하드코딩돼 있다. 웹 i18n 누락으로 보인다(G2-10).
7. 웹이 거부·경주 밖에서 '내 위치' 점을 지역 중심에 그린다. 웹을 고칠지 정해야 한다(G2-04).

## 다른 묶음에 속한 것(한 줄씩)

- **G3:** 같은 장소인데 SPOT 점수가 웹 55점 / Expo 1점이다.
- **G3:** 웹 카드 미리보기는 예측 띠 아래 y≈503 에서 시작하고, Expo 시트 위끝은 y≈672 다. 카드 높이를 비교할 때 G2-24·G01 을 같이 본다.
- **G3:** 웹 `AI 음성 비서` 알약이 카드 오른쪽 위에 겹친다(G2-12 결정과 연동).
- **G3:** 카드 행동 알림(수락·거절·킵)도 웹 `/main` 은 먹색 알약이다(G2-G09).
- **G3·전체:** 웹 카카오 마커는 `page.touchscreen.tap` 으로만 눌린다.
- **G4·G5:** 하위 화면 뒤로 아이콘이 웹 `ChevronLeft`(<) / Expo Stack 기본 `←` 로 다르다(`nav-mypage-settings-full`).
- **G5:** 설정 화면 — 웹은 언어 `<select>` + 혼잡 알림 카드, Expo 는 언어 칩 + 위치정보 동의·외부 AI 줄이다.
- **G1:** 탭 막대 `서비스 소개` 가 열 화면이 Expo 에 없다. 웹 소개 모달·`/guide` 에 대응하는 화면이 필요하다.
- **G4:** G2-G02 로 `/explore/recommend` 를 옮긴 뒤 화면 아래 여백을 다시 확인한다.
