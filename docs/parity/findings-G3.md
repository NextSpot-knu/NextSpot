# G3 홈 추천 카드·여정 — 웹(기준) ↔ Expo 비교 결과

- 작성: 2026-11-10, G3 에이전트.
- 비교 대상: 웹 `http://localhost:3000/main`(정적 export) ↔ Expo web `https://nextspot.expo.app/`.
- 조건: 390×844 @2x, ko-KR, 경주 황리단길 GPS, 공유 게스트(`state: 'saved'`).
- 범위: 인벤토리 G3 [CARD] [ACT] [NEXT] [JRN] [SIT] [TST] [PHO] + 전역 토스트(모양·위치·라이브러리·지속 시간).
- 스크린샷: `scratch/parity/shots/G3/*.pair.png`(왼쪽 웹 · 오른쪽 Expo).
- 재현 스크립트: `scratch/parity/work/G3/*.mjs`. 측정값은 `work/G3/metrics/*.json`, 로그는 `work/G3/*.log`. 상태용 덮어쓰기 응답은 `scratch/parity/overlays/G3/<변형>/`.
- 안전 조치
  - 브라우저는 모두 하네스(`openPair`/`newAppContext`)로만 열었습니다.
  - 수락·거절·킵·제보·결과 보고·저장 같은 쓰기는 하네스가 가짜 응답으로 막았습니다.
  - 쿠폰·프로필 토스트, 제보 403, 실시간 새로고침은 컨텍스트 안 `mockRoute/mockGet` 으로만 만들었습니다.
  - LLM(`travel-context/parse`)은 막은 채로 두었습니다.
  - 저장소 파일은 하나도 고치지 않았습니다.
- 웹 길안내 처리: `window.open(url,'_blank','noopener,noreferrer')` 가 늘 `null` 을 돌려줘서 앱 탭까지 카카오맵으로 넘어갑니다(G3-23). 수락 뒤 화면을 비교하려고 웹 컨텍스트에서만 `window.open` 이 가짜 창을 돌려주게 했습니다(`04-actions.mjs` 머리).

## 요약

- 발견 35건: **P0 8 · P1 26 · P2 1**. 결정 필요 8건 · 네이티브 확인 필요 2건 · 촬영 못 함 포함 3건.
- 가장 큰 차이 5가지
  1. **G3-01** 카드의 모양과 움직임이 다르다.
     - 웹: 지도 위에 좌우 16px 띄운 카드. 미리보기 225px → 전체 568px, 상세는 같은 높이 안에 덧붙인다. 손잡이 글자 버튼·탭·끌기로 바꾼다.
     - Expo: 화면 폭 전체의 3단 바텀시트(164/413/715px). 높이마다 한 판을 이어 보여 주는 11-09 방식이고, 손잡이는 눌러도 반응이 없다.
  2. **G3-03** Expo 가 서버 `spot_score`(0~1)를 그대로 반올림해서 모든 카드가 **'SPOT 1점'**(0.4x 면 'SPOT 0점')으로 보인다. 웹은 55점.
  3. **G3-07 · G3-15** 전체 카드 순서가 거꾸로다. 웹의 '상세 정보 펼치기/접기' 버튼과 바닥 고정 버튼 줄이 Expo 에 없다.
     - 웹: 가치 상자 → 사진 → 이름·SPOT → 혜택 → '상세 정보 펼치기' → 바닥 고정 버튼 두 줄.
     - Expo: 이름·바로 갈래요가 맨 위 → 킵 → 자동차·제보 → 칩 → 순위 → 메뉴 → 사진 → 상세.
  4. **G3-02 · G3-05** 미리보기 구성(손잡이 글자·메뉴 칩·SPOT 표시)과 전체 카드 첫머리의 '가치 상자'(그라데이션 테두리 상자 + 16px 큰 문장)가 다르다.
  5. **G3-21** Expo web 에서 '혼잡 제보'를 눌러도 아무것도 뜨지 않는다. gorhom `ModalSheet` 가 웹 빌드에서 열리지 않고, G2 의 '필터·편의'도 같은 증상이다. 웹은 바닥 모달 + 3지선다.

| 중요도 | 발견 |
|---|---|
| P0 | G3-01 카드 구조 · G3-02 미리보기 · G3-03 SPOT 점수 · G3-05 가치 상자 · G3-07 섹션 순서·바닥 버튼 · G3-15 상세 펼치기 버튼 · G3-21 혼잡 제보 모달 · G3-31 방문 확인 위치 |
| P1 | G3-04, 06, 08–14, 16–20, 22–30, 33–35 |
| P2 | G3-32 |

---

### G3-01 카드 구조·높이 모델 — 지도 위에 뜬 카드(미리보기/전체/상세) vs 3단 바텀시트(이어 보이기) [설계 발견]
- 화면·상태: 홈 첫 화면 → 전체 → 상세(G3-CARD-01·02·03), 끌기·탭 동작
- 스크린샷: `shots/G3/01-peek-default.pair.png`, `02-normal-first.pair.png`, `03-expanded-first.pair.png`, `05-after-interactions.pair.png`, `50z-peek-zoom.pair.png`, `61-journey-with-card-raised.pair.png`

#### 웹(기준) — 상호작용 모델
1. **자리·틀**
   - 아래 스택: `absolute inset-x-4 bottom-[calc(var(--tourist-nav-clearance)+safe-area)]`(`apps/web/app/main/page.tsx:4693`). 390px 에서 `--tourist-nav-clearance: 116px`(`apps/web/app/globals.css:236-238`).
   - 카드(`apps/web/components/RecommendationCard.tsx:1259-1277`):
     - 크기: `w-full`, `max-h-[calc(100dvh-var(--tourist-nav-clearance)-10rem)]` = 844−116−160 = **568px**.
     - 바탕·테두리: `bg-white/95 backdrop-blur-2xl border border-line rounded-3xl`(네 모서리 24px).
     - 그림자: `toss-surface`(`globals.css:617-621` = `0 1px 2px rgb(43 35 32/.05), 0 10px 30px rgb(43 35 32/.10)`).
     - 안쪽 여백: 미리보기 `p-3`(12), 전체 `px-4 pb-3 pt-2`.
     - 세로 간격: 미리보기 `gap-1`(4), 전체 `gap-2`(8).
     - 위 2px 장식선: `bg-gradient-to-r from-transparent via-gold/50 to-transparent`(`:1279`).
   - 측정(`work/G3/01-probe.log`):
     - 좌우 여백 16px.
     - 카드 아래 끝 y=728 — 탭 막대 위 15px(웹 탭 막대 top=743).
     - **미리보기 높이 225px**(503→728).
     - **전체·상세 568px**(160→728). 위에 검색·칩 줄이 남는다.
2. **세 상태는 '높이 3단'이 아니다.** 이름은 `SheetState = minimized|normal|expanded`(`apps/web/lib/sheetSnap.ts:8`)지만:
   - 미리보기 = **별도의 짧은 판**(`RecommendationCard.tsx:1326-1431`).
   - 전체 = 위쪽 스크롤 영역 + **바닥 고정 버튼 두 줄**(`:1442-2320`).
   - 상세(펼침) = 전체 카드의 스크롤 영역 안에 상세 패널을 덧붙인다(`:1742-2220`). 카드 높이는 내용 높이(최대 568px) 그대로다.
3. **상태를 바꾸는 방법**
   - (a) 손잡이 = 버튼(`:1291-1312`).
     - 모양: 64×6 막대 + 11px 굵은 금색 글자 '추천 자세히 보기'/'추천 간단히 보기'(`card.peek.expand|collapse`), `aria-expanded`.
     - 동작: 미리보기에서 누르면 전체. 전체·상세에서 누르면 상세를 닫고 미리보기.
   - (b) 미리보기의 값 문장·이름 줄 탭 → 전체(`openFromPeek :702-705`, `:1334`, `:1348`).
   - (c) 전체 카드의 이름 줄 탭 → 상세 열기/닫기(`:1586` `toggleExpand`). 열 때는 80ms 뒤 상세 위치로 부드럽게 스크롤(`:645-657`).
   - (d) '상세 정보 펼치기/접기' 버튼(`:1722-1737`, G3-15).
   - (e) 끌기: 카드 전체가 framer `drag="y"`(`:1264-1272`).
     - 판정: 놓은 위치 + 속도×0.25s 투영이 ±50px 를 넘으면 **한 칸만**(`sheetSnap.ts:10-30` `nextSheetState`). 12px 미만 움직임은 탭(`SWIPE_GUARD_PX :47`, `:628-641`).
     - 느낌: 끄는 동안 탄성 `sheetElastic`(여는 쪽 0.3 · 끝 0.08, `sheetSnap.ts:38-45`), 놓으면 제자리로 스프링(380/32).
     - 부수 동작: 높이가 바뀌면 햅틱 selection. 끌기 직후 click 한 번은 무시(`justDraggedRef :349`, `:694-705`).
4. **스크롤**
   - 전체 카드의 위쪽 내용만 `.rec-scroll`(`:1447-1451`, `overflow-y-auto overscroll-contain`) 안에서 스크롤한다. 폰에서는 스크롤 막대를 숨긴다(`globals.css:780-781`).
   - 더 볼 내용이 있으면 위 20px·아래 24px 흰 그라데이션 흐림이 생긴다(`:2253-2254`, `globals.css:789-790`).
   - 버튼 두 줄은 스크롤 밖 바닥에 고정(`:2257-2319`).
5. **움직임**
   - 등장: `initial {opacity:0, y:18, scale:0.985}` → `sheetSpring`(380/32/0.82, `:1262-1263`, `:1276`).
   - 높이 변화: framer `layout`(바깥 판) + `layout="position"`(내용, `:1284`).
   - 전체로 열 때 내용 160ms 페이드(`.sheet-content-in` `globals.css:386-388`). 상세는 height 0→auto(`:1745-1748`).
6. **새 장소**: title 이 바뀌면 상태·스크롤을 초기화하고(`:404-425`) 휴대폰은 미리보기로 다시 연다(`:436-441`).
7. **지도와의 관계**
   - 카드 열은 `pointer-events-none`, 카드만 auto(`page.tsx:4720-4727`) — 카드 좌우·위의 지도는 그대로 조작된다.
   - 카드가 미리보기가 아니면 혼잡 예측 줄을 숨긴다(`page.tsx:3962` `!compactCardExpanded`, G2 소관).
8. 같은 카드를 저장 화면이 `compactPeek` 없이(바로 전체 카드) 딤 배경 위에 쓴다(`apps/web/app/saved/page.tsx:470-535`, G4 소관).

#### Expo(현재)
- 구조: `apps/mobile/features/recommendation-card/RecommendationSheet.tsx:113-185` = gorhom `BottomSheet`(`apps/mobile/components/ui/Sheet.tsx:207-283`).
  - 3 스냅 `[peekPx ?? '27%', '52%', '90%']`(`:109`, `:147`).
  - 높이와 상관없이 **한 판**을 위부터 보여 준다(11-09 '이어 보이기', `:399-406`).
  - 가장 낮은 높이는 머리+첫 행동 줄을 재서 정한다(`sheetPeek.ts`, `:135-152`).
- 측정값
  - 폭: 화면 폭 전체(좌우 0, 상한 560 `HomeScreen.tsx:884`), 탭 막대에 붙음.
  - 높이: **미리보기 164px(631→795) · 기본 413px(382→795) · 펼침 715px(80→795)**.
  - 모서리 24(아래 모서리는 탭 막대에 묻힘).
  - 바탕: `rgba(255,255,255,0.95)`(web) / 흰색(Android).
  - 그림자: 위로 퍼지는 `0 -4px 24px rgba(43,35,32,0.10)`(`Sheet.tsx:116-122`, `:275`). 위 장식선 없음.
- 손잡이(`Sheet.tsx:147-170`): 22px, 막대만, 글자 없음, `role=slider`, aria-label '추천 카드 높이 조절'(`app.cardSheet.handle`).
  - **클릭해도 높이가 그대로**(`03-interactions.log`: 631→631). 이름·값 문장 탭도 반응이 없다.
- 끌기
  - 마우스로 손잡이를 끌면 바뀐다(631→382→80).
  - 이번 빌드에서는 **본문(제목 글자) 마우스 끌기도 동작**한다(631→382). HANDOVER 11-09b 의 '본문 끌기 안 됨'과 다르다.
  - 휠은 높이를 바꾸지 않는다.
  - 놓은 속도는 gorhom 이 판정해서 세게 튕기면 두 칸을 건너뛸 수 있다(`Sheet.tsx:202` 주석). 웹은 늘 한 칸.
- 스크롤: 90% 에서만 본문이 스크롤되고, 펼침 아래로 내려가면 맨 위로 되돌린다(`useSheetScrollTopLock`, `Sheet.tsx:39-84`).
  - **버튼이 내용과 함께 스크롤되어 사라진다.** 가장자리 흐림이 없다.

#### 차이
- 떠 있는 카드 ↔ 붙은 시트.
- 미리보기 판 ↔ 같은 판의 윗부분.
- 내용 높이 ↔ 고정 비율 3단.
- 탭으로 열고 닫기 ↔ 끌기만.
- 상세는 버튼으로 ↔ 90% 로 끌어야.
- 바닥 고정 버튼 ↔ 함께 스크롤.
- 처음 보는 사람도 다른 앱으로 본다.

- 중요도: P0
- 분류: 배치 · 동작

#### 고칠 방법(설계 — 웹 모델을 Expo 에 그대로 옮긴다)
1. **새 컴포넌트** `apps/mobile/features/recommendation-card/RecommendationCard.tsx`(웹과 같은 이름).
   - `CardBody`(`RecommendationSheet.tsx:187-397`)의 상태·행동 함수(`doAccept/doReject/doKeep/answerHours/refreshLive`, `buildCardModel`)는 그대로 옮기고, 렌더만 웹 순서로 다시 쓴다.
   - props 는 웹 `RecommendationCardProps`(`RecommendationCard.tsx:102-237`) 중 앱에 있는 것:
     - `compactPeek`(홈 true · 저장 false), `showCompare`
     - `onAccept/onDrive?/onReject/onPutOff?/onSeeInstead?`
     - `conditions/onRemoveCondition`(G3-06), `comparisonReason`(G3-14), `compareAnchor`(G3-13), `rejectIsRemoval`(저장)
2. **구조**
   ```
   <View pointerEvents="box-none" style={{ position:'absolute', left:16, right:16, bottom:15 }}>   // 탭 막대 위 15px (웹 116 − 탭 막대 101)
     <GestureDetector gesture={pan}>
       <Animated.View style={[frame, { maxHeight: containerH − 15 − 160 }]} layout={LinearTransition.springify().stiffness(380).damping(32).mass(0.82)}>
         <GoldTopLine />                         // 2px, 투명 → gold 50% → 투명 (expo-linear-gradient)
         <CardHandle state onToggle />           // 웹 :1287-1324
         {state === 'minimized' ? <PeekBody/> : (<>
            <ScrollView>{ValueBox · Photo · LiveRefresh · NameBlock · SpotInfo · BenefitChips · SeeInstead · ComparisonReason · DetailsToggle · Details(펼침일 때) · HoursPrompt}</ScrollView>
            <EdgeFades/>                         // 위 20 · 아래 24px
            <BottomActions/>                     // [다시 안볼래요][킵][바로 갈래요] / [자동차|영업 안내][혼잡 제보]
         </>)}
       </Animated.View>
     </GestureDetector>
   </View>
   ```
3. **틀 값**(웹 그대로)
   - 모서리: 네 모서리 24. 테두리: `border border-line`.
   - 바탕: `rgba(255,255,255,0.95)`(web·iOS) / `#ffffff`(Android — 흐림이 없어서. 지금 `Sheet.tsx:118` 과 같은 이유).
   - 그림자: `shadows.surface`(`apps/mobile/lib/theme/tokens.ts:104` 에 이미 있음).
   - 안쪽 여백: 미리보기 12 / 전체 좌우 16·위 8·아래 12. 세로 간격 4 / 8.
4. **손잡이**
   - `Pressable accessibilityRole="button" accessibilityLabel={t(isMin?'card.peek.expand':'card.peek.collapse')} accessibilityState={{expanded:!isMin}}`.
   - 막대 `h-[6px] w-[64px] rounded-full bg-muk/20` + 글자 `text-[11px] leading-[16px] text-gold-deep` bold, 높이 ≥24.
   - 음성 알약이 없으니 가운데 정렬(웹의 `items-center` 경우).
   - 누르면 미리보기↔전체. 전체·상세에서 누르면 상세도 닫고 미리보기.
5. **제스처**
   - `Gesture.Pan().activeOffsetY([-12, 12]).failOffsetX([-24, 24])`.
   - 움직이는 동안 `translateY = dy × (dy<0 ? elastic.top : elastic.bottom)`. `sheetElastic` 은 `@/lib/sheetSnap` 에서 그대로 import 한다(순수 모듈이라 `check:shared` 통과).
   - 놓으면 `nextSheetState(state, dy, vy)` 로 한 칸. 바뀌면 `haptic('selection')`, translateY 는 `withSpring(0, springs.sheet)`.
   - 끌기 직후 탭 한 번 무시(웹 `justDraggedRef`).
   - 전체 카드의 `ScrollView` 는 `Gesture.Native()` 와 `simultaneousWithExternalGesture` 로 묶는다.
     - **스크롤 영역 안에서 시작한 끌기는 스크롤이 먼저**다.
     - 손잡이·미리보기 판·바닥 버튼 줄에서 시작한 끌기만 높이를 바꾼다. 웹 `.rec-scroll` 이 터치를 먼저 갖는 것과 같은 뜻이다(아래 네이티브 주의).
6. **높이**
   - 미리보기·전체 모두 내용 높이(auto).
   - 전체는 `maxHeight = 홈 컨테이너 높이 − 15 − 160`. 웹과 같은 위 여백 160px — 검색·칩이 남는다.
   - 상세(펼침)는 높이를 바꾸지 않고 ScrollView 안에 덧붙인다. 버튼·이름 줄로 열 때만 80ms 뒤 상세 머리로 `scrollTo`(웹 `toggleExpand`). 끌기로 펼칠 때는 스크롤하지 않는다(웹과 같음).
7. **움직임**
   - 등장: opacity 0·translateY 18·scale 0.985 → `springs.sheet`.
   - 미리보기→전체 내용: `FadeIn.duration(160)`. 상세: `LinearTransition`.
   - `ReduceMotion.System` 을 따른다.
8. **새 장소**: `facility.id` 가 바뀌면 상태 초기화 + `scrollTo(0)` + `compactPeek` 이면 미리보기. 지금 `RecommendationSheet.tsx:126-128`, `:251-268` 의 효과를 새 컴포넌트로 옮긴다.
9. **지우는 것**
   - 추천 카드의 `Sheet`(비모달) 사용, `SheetScrollView`·`useSheetScrollTopLock`·`SHEET_HANDLE_HEIGHT`.
   - `sheetPeek.ts`(+`sheetPeek.test.ts`), `onPeekHeightChange`·`onStateChange`·`SNAPS`.
   - `Sheet` 를 쓰는 곳이 이 카드뿐이라 `components/ui/Sheet.tsx` 의 `Sheet` 는 지워도 된다. `ModalSheet` 는 남긴다(G3-21).
   - `app.cardSheet.handle`·`app.cardSheet.state.*` 키는 4로케일에서 함께 지운다.
10. **HomeScreen 연결**
    - `HomeScreen.tsx:868-885` 의 `<RecommendationSheet>` → `<RecommendationCard compactPeek showCompare …>` 로 바꿔 아래 스택(`:788-831`) 안으로 옮긴다.
    - 지도 가려진 띠(`mapBottomInset`, `sheetModel.ts:77-98`)와 여정 카드 자리(`tripOverlayRoom`)는 비율 대신 카드 `onLayout` 높이 + 15 로 계산한다.
11. **11-09 '이어 보이기'와의 관계**
    - 11-09 사용자 요청(높이와 상관없이 같은 판 · 놓으면 3단 정렬 · 가장 낮은 높이 재기)은 11-10 결정으로 대체된다. 근거: HANDOVER 11-10b '11-09 추천 시트·여정 카드도 웹과 다르면 웹에 맞춘다'.
    - 남길 생각: '펼친 뒤에만 예측 API' — 웹도 상세를 펼쳐야 `/predict/day`, 근거를 열어야 `/predict/golden-hour` 를 부른다(G3-18).
    - '큰 글자에서 바로 갈래요가 잘리지 않게'는 웹 모델(내용 높이 + 스크롤 영역만 줄어듦 + 버튼 바닥 고정)로 자연히 풀린다.
12. **저장 화면**(G4): `apps/mobile/features/saved/sheetSlot.tsx:24-40` 도 같은 컴포넌트를 `compactPeek={false}` 로 쓴다. 웹처럼 딤 배경 + 가운데 아래 카드(`saved/page.tsx:473-490`).

- 바꿀 Expo 파일:
  - `features/recommendation-card/RecommendationCard.tsx`(새로)
  - `features/recommendation-card/RecommendationSheet.tsx`(지우거나 얇은 별칭)
  - `features/recommendation-card/sheetPeek.ts`(+test 삭제)
  - `components/ui/Sheet.tsx`(비모달 `Sheet` 삭제), `components/ui/index.ts`
  - `features/home/HomeScreen.tsx`, `features/home/sheetModel.ts`(+test), `features/home/homeModel.ts`(여정 자리)
  - `features/saved/sheetSlot.tsx`, `features/recommendation-card/index.ts`
- 문구(i18n): 재사용 `card.peek.expand` `card.peek.collapse` `card.detailsExpand` `card.detailsCollapse`. 새 키 없음. 삭제 `app.cardSheet.handle` `app.cardSheet.state.minimized|normal|expanded`(4로케일 동시).
- 네이티브 주의
  - Android 는 `backdrop-blur` 가 없으니 흰색 불투명.
  - RNGH Pan ↔ ScrollView 경합은 Android 에서 `simultaneousWithExternalGesture` + `nestedScrollEnabled` 로 확인해야 한다.
  - 웹 실제 폰에서 '스크롤 영역 안 끌기'가 스크롤인지 카드 끌기인지(framer `touch-action` 규칙)는, 헤드리스 CDP 터치로는 카드 끌기로 나왔다. 실기기 Chrome 으로 한 번 확인해서 같은 우선순위를 정한다.
  - Android 뒤로 가기는 웹에 대응이 없다. 권장: 전체·상세면 미리보기로 접기만.
- 확인 방법
  - `work/G3/01-probe.mjs`·`03-interactions.mjs` 를 다시 실행해서 본다:
    - 카드 좌우 16px · 탭 막대 위 15px.
    - 미리보기 높이 ±4px(웹 225).
    - 전체 최대 568(G2 가 탭 막대를 웹과 같게 바꾼 뒤).
    - 손잡이 클릭으로 미리보기↔전체, 끌기는 한 칸씩.
    - 스크롤해도 버튼 줄이 바닥에 남는지.
  - Android 에뮬레이터: 스크롤/끌기 경합, TalkBack 이 손잡이를 '버튼, 펼쳐짐/접힘'으로 읽는지.
- 크기: L · 의존: G3-02·05·07·15(내용), G2(탭 막대 높이 → 아래 여백), G4(저장 화면)
- 표시: 네이티브 확인 필요(제스처 우선순위)

### G3-02 미리보기(peek) 구성·순서·크기
- 화면·상태: 홈 첫 화면 G3-CARD-01. 변형 — 마감 임박·긴 이름(`59z`), 관광지(`59y`), 오늘 휴무(`42-closedtoday-peek`)
- 스크린샷: `shots/G3/50z-peek-zoom.pair.png`, `01-peek-default.pair.png`, `59z-closing-peek.pair.png`, `59y-attraction-peek.pair.png`, `42-closedtoday-peek.pair.png`
- 웹(기준) `RecommendationCard.tsx:1287-1431` — 카드 225px
  1. 손잡이 줄: 막대 + '추천 자세히 보기' 11px 굵은 금색. 오른쪽에 음성 알약(G3-04).
  2. 값 문장: `text-[14px] font-extrabold leading-snug`(19.25px). 음식 문장이 아니면 2줄 제한(`:1332-1345`).
  3. 이름: `h3 font-serif text-base(16px) font-bold leading-tight`, **한 줄 말줄임**(`truncate`).
     - 옆에 SPOT `span rounded-md border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[11px] font-extrabold text-gold-deep` 'SPOT 55점' — 누를 수 없고 ⓘ 도 없다.
     - 그 옆에 `ChevronUp 14`.
  4. 칩 줄 `mt-1.5 gap-1.5`
     - 출발→도착: `rounded-md border border-jade/30 bg-jade/15 px-2 py-0.5 text-[11px] font-extrabold text-jade` + 시계 12(`:1360-1365`).
     - 화살표 문장일 때만 '도착 시 영업'.
     - 혼잡 칩: 얼굴과 같은 규칙, 작은 판(`:1138-1147`).
     - '오늘 휴무': `rounded-md border bg-terracotta/10 border-terracotta/30 text-[11px]`.
     - **메뉴 칩**: 전폭 `rounded-lg border-gold/35 bg-gold/10 px-2 py-1 text-[12px] font-bold` + 아이콘 14. '대표 메뉴'는 화면에 안 보이는 sr-only(`:1384-1391`).
  5. 버튼 줄 `gap-2`
     - '바로 갈래요 (도보 길안내)': `min-h-11 rounded-2xl cta-primary px-3 py-2 text-xs(12px) font-bold` + 그림자 `0 4px 14px rgba(168,70,47,.28)`.
     - '다시 안볼래요': `rounded-2xl border border-line bg-hanji-deep px-2 py-2 text-xs font-bold text-muk-soft`.
     - 직접 고른 곳이면 둘째 자리가 '대신 갈 곳 보기' `border-jade/40 bg-jade/10 text-jade`.
- Expo(현재) `RecommendationSheet.tsx:414-464` — 시트 164px
  1. 손잡이: 막대만.
  2. **꼬리표 줄**: '지금 먹으러 갈 곳' 12px terracotta + 출발→도착 `rounded-full bg-jade/15 px-[8px] py-[1px]` 12px + **머리 경고 칩**('도착 후 마감 임박'·'오늘 휴무'·혼잡, `HEAD_CHIP_KEYS :111`).
  3. 값 문장: 15px/20 extrabold, 2줄.
  4. 이름: serif 18px/24, **2줄** + SPOT 버튼 'SPOT 1점 ⓘ'(G3-03).
  5. 버튼: `Button` 14px. 다시 안볼래요는 흰 바탕·먹 글자.
  - **메뉴 칩 없음**, ChevronUp 없음.
- 차이
  - 순서: 웹은 손잡이 글자 → 값 문장 → 이름·SPOT → 칩 → 버튼. Expo 는 꼬리표·출발도착·경고 칩 → 값 문장 → 이름·SPOT → 버튼.
  - Expo 에만 있음: 꼬리표, 마감 임박 칩. 웹에만 있음: 메뉴 칩, ChevronUp.
  - 글자 크기: 웹 14/16/11/12 ↔ Expo 15/18/12/14.
  - 긴 이름: 웹 1줄 말줄임 ↔ Expo 2줄.
  - 다시 안볼래요: 웹 한지 진 바탕·먹 연 글자 ↔ Expo 흰 바탕·먹 글자.
- 중요도: P0
- 분류: 배치 · 누락 · 추가 · 크기·간격 · 글꼴 · 색·효과
- 고칠 방법
  1. G3-01 의 `PeekBody` 를 웹 `:1330-1431` 그대로 만든다(위 값).
  2. 칩 규칙
     - 출발→도착: `model.showArrivalLine`.
     - '도보 N분' 칩: 값 문장이 없을 때만(홈은 늘 있으니 안 나온다).
     - '도착 시 영업': 화살표 문장(`compareHeaderText`)이고 영업 예상일 때만. 이를 위해 `CardModel` 에 `compareHeaderText`·`foodHeadline` 을 따로 내보낸다. 지금은 `valueSentence` 로 합쳐져 있다(`cardModel.ts:325`).
     - 혼잡 칩: `crowdChipOnFace` 일 때 작은 판. '오늘 휴무': `model.closedToday`.
     - 마감 임박·심야 칩은 미리보기에 두지 않는다(웹은 전체 카드 혜택 칩에만).
  3. 메뉴 칩은 `model.faceMenu` 를 전폭으로. '대표 메뉴'는 `accessibilityLabel` 에만(`faceMenu.kind==='menu'`).
  4. 이름 `numberOfLines={1}` + `ellipsizeMode="tail"`, 값 문장 `numberOfLines={foodHeadline ? undefined : 2}`.
  5. 값 문장·이름 줄 탭 → 전체(G3-01).
  6. SPOT 은 `Text` 칩(누를 수 없음)으로, ⓘ 빼고.
  7. 버튼은 G3-20 의 웹 버튼 스타일.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`(PeekBody), `cardModel.ts`(필드 2개)
- 문구(i18n): 재사용 `card.peek.spot` `card.arrivalLine` `card.peek.walk` `compare.benefitOpen` `card.closedToday` `card.signatureMenu` `card.accept` `card.acceptAria` `card.reject` `card.rejectAria` `waiting.seeInstead` `card.seeInsteadAria`. 새 키 없음.
- 네이티브 주의
  - Android 한국어 줄바꿈은 U+2060(`Text.tsx:56`)이다. 1줄 말줄임과 함께 써도 된다.
  - 큰 글자 1.6배에서 카드가 길어지면 미리보기도 길어진다(웹과 같음).
- 확인 방법: `01-probe.mjs` 미리보기 쌍 + `07-variants.mjs closing|closedtoday`. 측정값 `metrics/01-peek-*.json` 의 글자 크기·순서를 대조.
- 크기: M · 의존: G3-01, G3-03, G3-20

### G3-03 SPOT 점수가 'SPOT 1점'으로 보인다(점수 배율 오류)
- 화면·상태: 모든 카드(미리보기·전체·SPOT 설명). 같은 장소(향화정 `spot_score: 0.548`)
- 스크린샷: `shots/G3/52z-name-spot-zoom.pair.png`, `50z-peek-zoom.pair.png`, `_smoke/home.pair.png`
- 웹(기준)
  - 서버 0~1 값을 `score01 = spotScore <= 1 ? spotScore : spotScore/100; score = Math.round(score01*100)` 으로 바꾼다(`apps/web/lib/recommender.ts:583-585`).
  - 결과: 'SPOT 55점'(`RecommendationCard.tsx:1353`). 전체 카드 큰 숫자 55(`:1643-1645`, 0에서 굴러 올라가는 카운트업).
- Expo(현재)
  - `const spotScore = Math.round(c.spotScore ?? 0)`(`apps/mobile/features/recommendation-card/cardModel.ts:193`) → **1점**, 0.4x 면 0점(`RecommendationSheet.tsx:438`, `:444`).
  - 킵 저장값도 원값 그대로 `spot.score: c.spotScore ?? 0`(`actionsCore.ts:95`). 웹은 55를 저장한다(`page.tsx:2476`).
  - 대안 화면은 이미 바르게 바꾼다(`features/explore/AlternativeCard.tsx:137`).
- 차이: 모든 추천이 1점으로 보여서 서비스의 핵심 숫자가 틀린다.
- 중요도: P0
- 분류: 상태(값 오류)
- 고칠 방법
  1. `cardModel.ts` 에 아래 함수를 두고 `:193` 을 `spotPoints(c.spotScore)` 로 바꾼다.
     ```
     export function spotPoints(raw?: number|null): number {
       if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
       return Math.round(raw <= 1 ? raw * 100 : raw);
     }
     ```
  2. `actionsCore.ts:95` 도 `score: spotPoints(c.spotScore)`. 이미 100 단위로 저장된 옛 북마크도 `raw > 1` 이라 그대로 나온다.
  3. `AlternativeCard.tsx:137` 도 같은 함수로 합친다.
  4. `cardModel.test.ts` 에 0.548→55, 54.8→55, null→0 케이스를 추가한다.
- 바꿀 Expo 파일: `features/recommendation-card/cardModel.ts`, `actionsCore.ts`, `cardModel.test.ts`, `features/explore/AlternativeCard.tsx`
- 문구(i18n): 변화 없음(`card.peek.spot`).
- 네이티브 주의: 없음(순수 계산).
- 확인 방법: 앱 테스트 + `01-probe.mjs` 로 미리보기 'SPOT 55점' 확인, 저장 화면 SPOT(G4).
- 크기: S · 의존: 없음

### G3-04 카드 안 'AI 음성 비서' 알약(웹 전용)
- 화면·상태: 미리보기 손잡이 오른쪽, 전체 카드 가치 상자 첫 줄 오른쪽
- 스크린샷: `shots/G3/50z-peek-zoom.pair.png`, `02-normal-first.pair.png`
- 웹(기준)
  - `voiceSlot`(`page.tsx:4709-4716`, `:4903`)이 두 자리에 들어간다: 미리보기 손잡이 줄 오른쪽(`RecommendationCard.tsx:1313`), 전체 카드 가치 상자 첫 줄 `ml-auto`(`:1470`).
  - 모양: 검은 알약 `bg-muk` 104×36, '🎙 AI 음성 비서' 13px extrabold 한지색(`data-testid=voice-pill`).
  - 알약이 있으면 손잡이 글자는 왼쪽 정렬(`:1304`).
- Expo(현재): 없음. 음성 비서는 v1.1 범위(인벤토리 6.1 D1, PORTING).
- 차이: 카드 오른쪽 위의 큰 검은 알약 유무, 손잡이 글자 정렬.
- 중요도: P1
- 분류: 누락
- 고칠 방법: 결정에 따른다.
  - (가, 권장) 이식하지 않는다. 음성 STT/TTS·`/voice/turn` 은 별도 과제다. Expo 손잡이는 웹의 '알약 없을 때' 모양(막대·글자 가운데 정렬)으로 둔다 → 추가 작업 없음.
  - (나) 이식한다. 알약 자리만 같은 크기(36px)로 두면 가짜 버튼이 생기므로 비권장.
- 바꿀 Expo 파일: (가) 없음
- 문구(i18n): (나)일 때 `map.voice*`/`recommend.voice*` 재사용.
- 네이티브 주의: (나)는 expo-speech·마이크 권한·외부 AI 동의(E3)와 얽힌다.
- 확인 방법: 결정 기록.
- 크기: S(가) / L(나) · 의존: G2(TOP-13 마이크)
- 표시: 결정 필요

### G3-05 전체 카드 첫머리 '가치 상자'가 없다
- 화면·상태: 전체 카드 맨 위(G3-CARD-02). 음식점(음식 문장)·관광지(혜택 문장) 두 형태
- 스크린샷: `shots/G3/51z-head-zoom.pair.png`, `02-normal-first.pair.png`, `71-attraction-full.pair.png`
- 웹(기준) `RecommendationCard.tsx:1457-1502`
  - 상자: `rounded-2xl border border-terracotta/25 bg-gradient-to-r from-terracotta/10 via-gold/10 to-jade/10 px-3 py-2`.
  - 첫 줄 `gap-x-2`
    - 꼬리표 `pt-0.5 text-[12px] font-bold text-terracotta`('지금 먹으러 갈 곳'·'줄 서는 대신'·'지금 가까운 추천').
    - 출발→도착 `rounded-full bg-jade/15 px-2.5 py-0.5 text-[13px] font-extrabold text-jade` + 시계 14. (+ 음성 알약)
  - 둘째 줄 문장: `mt-0.5 text-[16px] font-extrabold leading-snug`(22px).
  - 혜택 형태는 **이름을 넣고** 도보 칸을 강조한다(`:1476-1486`): `{이름} · [도보 N분](rounded-full bg-jade/15 px-2 text-jade) · 도착 시 영업 · 취향 N% 일치`. 예: '금관총 · 도보 6분 · 도착 시 영업'.
  - 셋째 줄: 가정 시각·맥락·조건 칩(`:1487-1501`, G3-06).
- Expo(현재)
  - 상자 없음. 꼬리표·출발도착·문장이 머리 텍스트 줄이다(`RecommendationSheet.tsx:416-432`, 15px).
  - 혜택 형태도 이름 없이 '도보 6분 · 도착 시 영업'(`cardModel.ts:326` `peekValueText`).
  - 상세 맨 위에 이름 + 같은 문장을 한 번 더 그린다(`:659-667`).
- 차이
  - 카드에서 가장 큰 그라데이션 상자와 16px 문장이 없다.
  - 혜택 문장에 이름·도보 강조가 빠졌다.
  - 문장이 상세에서 되풀이된다(웹에는 없음).
- 중요도: P0
- 분류: 누락 · 글꼴 · 색·효과
- 고칠 방법
  1. `ValueBox` 컴포넌트를 만든다.
     - 바탕: 가로 `LinearGradient`, 시작 `rgba(193,85,59,0.10)` → 가운데 `rgba(193,154,62,0.10)` → 끝 `rgba(62,124,106,0.10)`.
     - 테두리 `rgba(193,85,59,0.25)` 1px, 모서리 16, 여백 12/8.
  2. 첫 줄: `model.compareKicker`(12px bold terracotta) + 출발→도착(13px extrabold, `rounded-full bg-jade/15 px-[10px] py-[2px]`, 시계 14).
  3. 문장(16px extrabold lh 22)
     - `model.foodHeadline ?? model.compareHeaderText` 가 있으면 그 글.
     - 없으면 `title · ` + 도보 칸(`rounded-full bg-jade/15 px-[8px] text-jade` 안쪽 Text) + 열림·취향 조각.
  4. 셋째 줄: 조건 칩(G3-06).
  5. 상세 맨 위의 '이름 + 문장 반복'(`:659-667`)은 지우고 웹의 이름 막대로 바꾼다(G3-16).
  6. 저장 화면(`showCompare=false`)은 웹처럼 상자를 그리지 않는다(`:1457`, `:1503-1508`).
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`(ValueBox), `cardModel.ts`
- 문구(i18n): 재사용 `compare.foodKicker` `compare.headerKicker` `compare.nearbyKicker` `compare.atTimeKicker` `card.arrivalLine` `compare.benefitWalk` `compare.benefitOpen` `compare.benefitTaste`. 새 키 없음.
- 네이티브 주의: 문장 안 '도보 N분' 둥근 바탕은 겹친 `Text` 의 backgroundColor 로는 둥글게 안 된다. `View` 를 문장 안에 넣을 수 없으니 flex-wrap 줄(이름 · [칸] · 나머지)로 나눠 그린다. 한국어 줄바꿈 차이가 생길 수 있다.
- 확인 방법: `02-sections.mjs`·`11-attraction.mjs` 쌍. `metrics/04-content-web.json` 의 value-box 값과 대조.
- 크기: M · 의존: G3-01, G3-06

### G3-06 여행 조건 칩('🚶 도보 20분 이내 ✕')이 카드에 없다
- 화면·상태: 전체 카드 가치 상자 셋째 줄(저장된 첫 설정이 '도보 20분')
- 스크린샷: `shots/G3/02-normal-first.pair.png`, `51z-head-zoom.pair.png`
- 웹(기준)
  - `cardConditions`(`page.tsx:3436-3453`)가 칩 목록을 만든다: 도보 제한이 지금 카드에 맞을 때 '🚶 도보 {n}분 이내', 실내 '🏠 실내', '♿ 휠체어', '👶 유모차'.
  - 칩 모양: `h-7 rounded-full border border-jade/40 bg-white/85 px-2.5 text-[12px] font-bold text-jade` + X 12.
  - 누르면 그 조건을 풀고 다시 추천한다(`removeCondition :3458-3476`). 접근 이름 '{name} 조건 해제'(`RecommendationCard.tsx:1222-1237`).
- Expo(현재)
  - 옮기지 않았다(`cardModel.ts:6` '여행 조건 칩(홈 화면 소관)').
  - 홈의 도보 제한·편의 조건(`HomeScreen.tsx:291-294` `homeRequestContext`)은 카드에 보이지 않는다.
- 차이: 지금 걸린 조건을 카드에서 보고 바로 푸는 길이 없다.
- 중요도: P1
- 분류: 누락 · 동작
- 고칠 방법
  1. HomeScreen 에서 웹 규칙대로 조건 목록을 만든다.
     - walk: `travelContext.maxWalkMinutes` 가 있고, 서버가 도보 제한을 풀지 않았고, 카드 도보 분 ≤ 제한일 때. `relaxWalkLimit` 을 쓴 응답이면 감춘다(웹 `walkLimitRelaxed`).
     - indoor: `indoor` 이면. barrierFree: `convenience.accessible`. stroller: `convenience.stroller`.
  2. 카드 `conditions` prop 으로 넘겨 가치 상자 셋째 줄에 그린다.
  3. `onRemoveCondition(key)`
     - walk → 저장된 조건에서 도보 제한 키를 뺀다(`relaxWalkLimit`).
     - 나머지 → `toggleConvenience`/`toggleIndoor` 로 끈다.
     - 그다음 `track('context_applied', …)`.
- 바꿀 Expo 파일: `features/home/HomeScreen.tsx`, `features/recommendation-card/RecommendationCard.tsx`
- 문구(i18n): 재사용 `condition.walk` `condition.walkName` `condition.indoor` `condition.indoorName` `condition.barrierFree` `condition.barrierFreeName` `condition.stroller` `condition.strollerName` `condition.removeAria`. 새 키 없음.
- 네이티브 주의: 칩 높이 28px — 탭 영역은 hitSlop 으로 44.
- 확인 방법: 기본 시드(도보 20분)로 `02-sections.mjs` 쌍. 칩을 탭한 뒤 추천을 다시 요청하는지(fixture 로그) 확인.
- 크기: M · 의존: G3-05, G2(필터·편의 상태)

### G3-07 전체 카드의 섹션 순서와 바닥 고정 버튼 두 줄
- 화면·상태: 전체 카드(G3-CARD-02), 스크롤 단계별
- 스크린샷: `shots/G3/02-normal-first.pair.png`, `04-scroll-00.pair.png`~`04-scroll-05.pair.png`, `53z-buttons-zoom.pair.png`, `46-single-peek.pair.png`(직접 고른 곳)
- 웹(기준) 순서(`RecommendationCard.tsx`)
  - 스크롤 영역
    1. 가치 상자 `:1457`
    2. 사진 `:1513`
    3. 실시간 새로고침 `:1563`
    4. 순위 배지·메뉴 칩·이름 + SPOT 배지 `:1585`
    5. SPOT 설명 `:1658`
    6. 혜택 칩 `:1679`
    7. (직접 고른 곳) '대신 갈 곳 보기' 전폭 버튼 `:1698`
    8. (2·3위) 추천 이유 `:1713`
    9. '상세 정보 펼치기' `:1722`
    10. (펼침) 상세 `:1742`
    11. 영업 확인 질문 `:2222`
  - **스크롤 밖 바닥 고정**
    - 줄1 [다시 안볼래요][일단 킵하고⏎다음 후보 볼래요][바로 갈래요 (도보 길안내)] `:2258-2293`
    - 줄2 [자동차 길안내 또는 영업 안내문][혼잡 제보] `:2294-2319`
- Expo(현재) 순서(`RecommendationSheet.tsx`)
  1. 머리(꼬리표·문장·이름·SPOT) + [바로 갈래요][다시 안볼래요] `:414-464`
  2. 영업 확인 질문 `:465`
  3. SPOT 설명 `:471`
  4. [킵(한 줄)] `:472-484`
  5. [자동차][혼잡 제보] `:485-500`
  6. 본문 칩 `:502`
  7. 순위 배지 `:515`
  8. 메뉴 `:524`
  9. 추천 이유 `:536`
  10. 사진 `:543`
  11. 새로고침 `:550`
  12. 상세 `:572`
  - 모두 한 스크롤 판 안이라 버튼이 위로 스크롤되어 사라진다.
  - 직접 고른 곳이면 '대신 갈 곳 보기'가 첫 줄 둘째 자리에 오고, '다시 안볼래요'는 킵 줄로 내려간다(`:458-475`).
- 차이
  - 흐름: 웹은 '무엇을 주는가 → 어떤 곳인가 → 행동'(버튼은 늘 바닥). Expo 는 '이름·행동 먼저 → 부가 정보'.
  - 바로 갈래요 위치: 웹 바닥 줄 오른쪽 끝 · Expo 맨 위 왼쪽.
  - 버튼 순서: 웹 거절·킵·수락 · Expo 수락·거절 / 킵 / 자동차·제보.
  - '대신 갈 곳 보기' 자리.
- 중요도: P0
- 분류: 배치
- 고칠 방법
  1. G3-01 의 `FullBody` 를 웹 순서 1~11로 쌓고, `BottomActions` 를 ScrollView 밖에 둔다.
  2. 줄1: 세 버튼 `flex-1 gap-[8px]`, `pt-[4px]`. `onPutOff` 가 없으면(저장 화면) 킵 버튼을 그리지 않는다.
  3. 줄2: `needsHoursConfirmation && kakaoPlaceUrl` 이면 안내문, 아니면 `onDrive` 가 있을 때 자동차 버튼. 오른쪽에 혼잡 제보.
  4. '대신 갈 곳 보기'
     - 미리보기 둘째 버튼(G3-02).
     - 전체 카드 7번 전폭 버튼: `min-h-11 rounded-2xl border-jade/40 bg-jade/10 text-[13px] font-bold text-jade` + ChevronRight 15.
     - 바닥 줄의 '다시 안볼래요'는 그대로 둔다.
  5. 버튼 모양은 G3-20.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`
- 문구(i18n): 재사용 `card.reject` `card.putOff`(줄바꿈 유지) `card.accept` `card.drive` `card.checkHoursKakaoHint` `waiting.seeInstead` + aria 키. 새 키 없음.
- 네이티브 주의: 바닥 줄이 고정이라 키보드와는 상관없다. 큰 글자에서 바닥 줄 두 줄이 늘면 스크롤 영역이 줄어든다(웹과 같음).
- 확인 방법: `02-sections.mjs` 를 다시 돌려 스크롤해도 버튼 줄이 같은 자리인지 본다. `04-scroll-*` 순서를 대조한다.
- 크기: M · 의존: G3-01

### G3-08 사진 띠 — 높이 112 vs 180, 사진 없는 표지 문양, 출처 표시
- 화면·상태: 전체 카드 사진(G3-CARD-09) — 사진 있음 · 사진 없음(피자옥 변형)
- 스크린샷: `shots/G3/02-normal-first.pair.png`, `45-nophoto-full.pair.png`, `45-nophoto-full-scrolled.pair.png`
- 웹(기준) `RecommendationCard.tsx:1513-1560`
  - 틀: 높이 **112px**(`.rec-photo` `globals.css:765`), `rounded-2xl border border-line`.
  - 아래층 `PlacePhotoFallback`(`apps/web/components/PlacePhotoFallback.tsx`)
    - 바탕 `.place-tile`: `color-mix(tile 13%, hanji-deep)` + 한지 방사형 + 160° 선형(`globals.css:330-336`).
    - 장소별 **경주 문양**: 기와·원형 문·탑·물결·창살 5종, `viewBox 0 0 100 112`, 선 1.4·투명도 .5, `phase` 로 옆으로 민다.
    - 가운데(세로 54%) 44px 원(`bg-hanji/90 ring-1 ring-current/40 shadow-[0_2px_10px_rgba(43,35,32,0.12)]`) 안에 유형 아이콘 20(선 1.8).
  - 사진은 로드 뒤 300ms 페이드.
  - 공사 사진이면 왼쪽 아래 'ⓒ한국관광공사': `bottom-1.5 left-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold`.
  - 사진이 없으면 오른쪽 아래 '카카오맵에서 사진 보기': `h-11 rounded-full border-line bg-white/95 px-3 text-[12px] font-bold` + 카메라 14 + 그림자.
  - Wikimedia·경주시 사진은 사진 아래 출처 줄(`PhotoCreditLink`).
- Expo(현재) `CardPhoto.tsx:23-169`, 시트가 `height={180}` 을 넘긴다(`RecommendationSheet.tsx:547`)
  - 높이 **180px**. 바탕 단색(`tile-*-bg`) + 가운데 44px 원 안 아이콘. 문양 없음(`CardPhoto.tsx:19-20` 주석).
  - 사진 전환 200ms.
  - 크레딧 칩 `bottom-[6px] left-[6px]` 11px/14.
  - 카카오 링크 `min-h-[44px] bottom-[8px] right-[8px]`, 그림자 없음.
  - 출처 줄 10px 밑줄.
- 차이
  - 사진 높이가 68px 차이 나서 카드 첫 화면에 들어가는 내용이 달라진다.
  - 사진 없는 곳(음식점·카페 대부분)의 표지가 문양 없는 단색판이다.
- 중요도: P1
- 분류: 크기·간격 · 아이콘·이미지
- 고칠 방법
  1. 높이 112(`RecommendationCard` 에서 `height={112}`).
  2. `PlacePhotoFallback` 을 `react-native-svg` 로 옮긴다.
     - 웹 파일의 `scallopRows/roundelEmblem/pagodaEmblem/waveEmblem/latticeEmblem` 경로 계산은 순수 함수라 그대로 복사한다.
     - `Svg viewBox="0 0 100 112" preserveAspectRatio="xMidYMid slice"` + `Path stroke={tile} strokeWidth={1.4} opacity={0.5} transform translate(phase*12−6)`.
     - 바탕: `tile-*-bg` + 방사형(react-native-svg `RadialGradient`) + 160° 선형(`LinearGradient`).
     - 원: `ring` 대신 1px 테두리 `tile` 40% + 그림자.
  3. 크레딧·카카오 링크 위치·그림자를 웹 값으로.
  4. 공용 컴포넌트로 두어 대기·대안·저장(다른 묶음의 같은 차이)도 쓰게 한다.
- 바꿀 Expo 파일: `features/recommendation-card/CardPhoto.tsx`, 새 `components/ui/PlacePhotoFallback.tsx`(또는 `features/shared/`)
- 문구(i18n): 재사용 `card.photoCredit` `card.photoOnKakao` `common.cityPhotoCredit`. 새 키 없음.
- 네이티브 주의
  - SVG `vectorEffect=non-scaling-stroke` 는 react-native-svg 에 없다. 112px 높이 고정이라 선 굵기 보정은 필요 없다.
  - Android 그림자는 `elevation` 대신 `boxShadow`(RN 0.76+ 새 아키텍처). 지금 토큰과 같은 방식.
- 확인 방법: `07-variants.mjs nophoto` 쌍(표지 모양), `02-normal-first` 사진 높이 측정.
- 크기: M · 의존: G3-01 · 다른 묶음(G4 EXP·G5 WAI 표지)과 공용

### G3-09 실시간 정보 새로고침 행과 성공 뒤 동작
- 화면·상태: 전체 카드 사진 아래(contentid 있는 TourAPI 장소), 성공(live-detail 가로채기)
- 스크린샷: `shots/G3/02-normal-first.pair.png`, `80-live-refresh-toast.pair.png`
- 웹(기준) `RecommendationCard.tsx:1563-1581`
  - 버튼: `h-9`(36px) `rounded-full border-gold/60 bg-white px-3.5 text-[13px] font-bold text-gold-deep` + RefreshCw 15(도는 동안 회전).
  - 옆에 '출처: ⓒ한국관광공사 TourAPI' 12px semibold. 성공하면 '✓ 방금 갱신 · HH:MM' 칩.
  - 성공 시(`:845-863`)
    - **상세를 펼친다**(`setIsExpanded(true)`).
    - 새로 받은 첫 줄로 스크롤한다. 이름 막대 높이만큼 띄운다(`revealRefreshedRow :662-672`).
    - 그 줄을 1.5초 반짝인다(`.live-flash`).
    - sonner 성공 토스트, 10초 잠금.
- Expo(현재) `RecommendationSheet.tsx:550-570`
  - 버튼: `min-h-[44px] rounded-full … px-[14px]` 13px. 출처 글과 칩(12px)은 같다.
  - 성공 시(`:363-390`): 칩·토스트·반짝임만 한다. 반짝임은 배경 gold/15(웹은 gold 26% + jade 테두리 빛이 사라지는 애니메이션).
  - **상세를 열거나 스크롤하지 않는다.**
- 차이
  - 버튼 높이 36 ↔ 44.
  - 성공 뒤: 웹은 바뀐 줄로 데려가고 Expo 는 제자리.
- 중요도: P1
- 분류: 크기·간격 · 동작
- 고칠 방법
  1. 버튼 보이는 높이 36(`h-[36px]`), 탭 영역은 `hitSlop` 4로 44.
  2. 성공 시 `setExpanded(true)` 후 120ms·450ms 두 번 `scrollTo(첫 반짝 줄 y − 이름 막대 높이 − 8)`(웹 `revealRefreshedRow`).
  3. 반짝임: Reanimated 로 배경 `rgba(193,154,62,0.26)`→투명 + 테두리 2px `rgba(62,124,106,0.6)`→투명, 1.5초 ease-out(`globals.css:810-823`).
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`, `CardParts.tsx`(DetailRow 반짝임)
- 문구(i18n): 재사용 `card.liveRefresh` `card.liveCredit` `card.liveRefreshed` `card.liveRefreshedToast`. 새 키 없음.
- 네이티브 주의: 없음.
- 확인 방법: `12-toasts.mjs`(live-detail 가로채기) 쌍 — 상세가 열리고 운영 시간 줄로 스크롤되는지.
- 크기: S · 의존: G3-15, G3-16

### G3-10 순위 배지·메뉴 칩·이름·SPOT 배지·SPOT 설명 상자
- 화면·상태: 전체 카드 4·5번. 1위 · 3위(핀 탭) · SPOT 설명 열림
- 스크린샷: `shots/G3/52z-name-spot-zoom.pair.png`, `04-scroll-01.pair.png`, `91-pin-rank3-full.pair.png`
- 웹(기준) `RecommendationCard.tsx:1585-1675`
  - 왼쪽 묶음(누르면 상세 열기)
    - 순위 배지 `rounded-lg px-2.5 py-1 text-[11px] font-black` + Sparkles 12. 목록 안이면 **`cta-primary` 금→주칠 그라데이션** + `shadow-sm`, 밖이면 `bg-gold/15 text-gold-deep`.
    - 근거 칩 '주변이 덜 붐비는 곳'/'조금 뒤 가면 덜 붐빔'(`:1599-1609`).
    - 메뉴 칩 전폭 `rounded-lg border-gold/35 bg-gold/10 px-2 py-1 text-[13px] font-bold`(아이콘 14, '대표 메뉴'는 sr-only).
    - 이름 `font-serif text-[20px] font-bold leading-tight tracking-tight`.
  - 오른쪽 SPOT **60×60 상자** `rounded-2xl border px-2 py-1.5 shadow-sm`
    - 닫힘 `border-gold/40 bg-gradient-to-b from-gold/20 to-gold/5`, 열림 `border-gold bg-gold/20`.
    - 안에 'SPOT 점수 ⓘ' 12px bold + 숫자 22px black + '점' 11px(카운트업).
  - 설명 상자는 이 블록 바로 아래(`:1658-1675`).
- Expo(현재)
  - 순위 배지: 칩·버튼들 아래에 따로(`RecommendationSheet.tsx:515-522`), **단색 terracotta**.
  - 메뉴: 그 아래 상자(`:524-534`). '대표 메뉴 ' 글자가 **보이게** 앞에 붙는다.
  - 이름: 머리(18px). SPOT: 작은 칩 'SPOT 1점 ⓘ'(12px).
  - 설명 상자: 첫 행동 줄 아래(`:471`).
  - 근거 칩(arrival_action) 없음.
- 차이
  - 배지 색: 그라데이션 ↔ 단색.
  - 블록 구성: 이름 왼쪽·점수 오른쪽 상자 ↔ 흩어짐.
  - '대표 메뉴' 글자 노출, 이름 20 ↔ 18, SPOT 상자 ↔ 칩.
  - 근거 칩 누락, 설명 상자 위치.
- 중요도: P1
- 분류: 배치 · 색·효과 · 글꼴 · 누락
- 고칠 방법
  1. `NameBlock`
     - 왼쪽 `flex-1`(누르면 상세 토글):
       - 배지: 목록 안이면 `Gradient name="cta"` + 흰 글자, 밖이면 `bg-gold/15 text-gold-deep`.
       - 근거 칩: `model` 에 `chipArrivalAction` 을 추가한다(웹 `:974` `demandDisclosure.showQualitativeLevel ? arrivalAction : undefined`). 색은 jade 또는 sky `#0369a1` 계열.
       - 메뉴 칩 13px. '대표 메뉴'는 `accessibilityLabel` 로만.
       - 이름 20px serif.
     - 오른쪽 `SpotBadge` 60×60(위 값). 카운트업은 Reanimated `useDerivedValue` 로 0→값 600ms, 동작 줄이기면 즉시.
  2. `SpotInfo` 를 이 블록 바로 아래로 옮긴다.
  3. 순위 문구는 그대로 `cardRankText`.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`, `cardModel.ts`
- 문구(i18n): 재사용 `card.rankBadgeTop` `card.rankBadge` `card.nextCandidate`류(`cardRankText`) `card.selectedPlace` `recommend.alternativeBasis.crowd|timing` `card.signatureMenu` `card.spotScoreLabel` `card.pointSuffix` `card.spotTooltipAria` `card.spotTooltipTitle` `card.spotInfoIntro` `card.spotInfoPlace` `card.spotInfoTaste` `card.spotInfoTime` `card.spotInfoTimeWait` `card.spotInfoPerk`. 새 키 없음.
- 네이티브 주의: 그라데이션 배지는 `Gradient`(expo-linear-gradient). 이미 `Button` 이 쓴다.
- 확인 방법: `02-sections.mjs`, `14-pin-rank.mjs` 쌍.
- 크기: M · 의존: G3-03, G3-07

### G3-11 혜택 칩 줄 — 자리·크기·등급 색
- 화면·상태: 전체 카드 6번. 실측 한산 변형(`41`), 오늘 휴무(`42`), 마감 임박(`43`)
- 스크린샷: `shots/G3/41-measured-full-scrolled.pair.png`, `42-closedtoday-full-scrolled.pair.png`, `43-closing-longname-full.pair.png`
- 웹(기준)
  - 칩 줄 `flex flex-wrap gap-x-2.5 gap-y-1.5`(`RecommendationCard.tsx:1679-1689`) 하나에 혼잡·영업·마감 임박·오늘 휴무·대기·타임세일을 이름 블록 아래 모은다.
  - `BenefitChip`: `h-8 rounded-full border px-3 text-[14px] font-bold`(`apps/web/components/main/BenefitChip.tsx:35`).
  - 색(`globals.css:795-806`)
    - 여유: `border rgb(16 185 129/.35) bg rgb(16 185 129/.10) text #047857`.
    - 한산: **파랑** `border rgb(29 78 216/.35) bg rgb(29 78 216/.10) text #1d4ed8`.
    - 보통 gold, 혼잡 terracotta. 추정은 점선.
- Expo(현재)
  - 마감 임박·오늘 휴무·혼잡은 머리(꼬리표 줄)의 **작은 칩**(12px, `RecommendationSheet.tsx:428-430`).
  - 나머지는 자동차 줄 아래 본문 칩(`:502-508`).
  - 색 표 `CardParts.tsx:10-25`
    - 여유 = `border-line bg-hanji-deep` + jade 글자.
    - **한산 = `border-line bg-hanji-deep` + gold-deep 글자**(측정: '방문객 5분 전: 한산' rgb(112,88,25)).
- 차이
  - 칩이 두 곳으로 갈라졌다.
  - 머리 칩 12px ↔ 14px/32px.
  - 여유·한산 색이 지도 핀·범례(초록·파랑)와 다르다.
- 중요도: P1
- 분류: 배치 · 색·효과 · 크기·간격
- 고칠 방법
  1. `HEAD_CHIP_KEYS` 갈래를 없애고 `model.faceChips` 전부를 이름 블록 아래 한 줄에 둔다. 순서는 웹 그대로(`cardModel.ts:386-396` 이 이미 웹 순서).
  2. `CardParts.tsx` TONE 을 바꾼다.
     - `relaxed: 'border-[rgba(16,185,129,0.35)] bg-[rgba(16,185,129,0.10)]'`, 글자 `#047857`.
     - `quiet: 'border-[rgba(29,78,216,0.35)] bg-[rgba(29,78,216,0.10)]'`, 글자 `#1d4ed8`.
     - `lib/theme/tokens.ts` 에 `benefit-relaxed`·`benefit-quiet` 색 이름으로 추가하고, 웹 `globals.css` 와의 `tokens.test.ts` 대조 대상에 넣는다.
  3. `small` 변형은 미리보기 혼잡 칩(웹 `:1140` `rounded-md px-2 py-0.5 text-[11px]`)에만 쓴다.
- 바꿀 Expo 파일: `features/recommendation-card/CardParts.tsx`, `RecommendationCard.tsx`, `lib/theme/tokens.ts`(+`tokens.test.ts`)
- 문구(i18n): 재사용(칩 문구 그대로). 새 키 없음.
- 네이티브 주의: 없음.
- 확인 방법: `07-variants.mjs measured|closedtoday|closing` 쌍, 칩 색 측정(`metrics/41-measured-peek-*.json`).
- 크기: S · 의존: G3-07

### G3-12 관광지·문화시설 카드에 Expo 만 '도착 시 영업 예상' 칩을 붙인다
- 화면·상태: 비음식점(금관총) 전체 카드
- 스크린샷: `shots/G3/71-attraction-full.pair.png`
- 웹(기준)
  - `/main` 은 늘 `showCompare` 라 혜택 문장에 '도착 시 영업'이 이미 들어 있다.
  - 칩은 다음 경우에만 붙는다(`RecommendationCard.tsx:1242-1249`): `open_expected && showCompare && compareHeaderText` / `open_expected && !showCompare`.
  - 그래서 금관총 카드는 칩이 없다.
- Expo(현재)
  - 조건 `cardModel.ts:391`: `open_expected && !compareHeaderText && foodHeadline === null`.
  - 결과: 혜택 문장('도보 6분 · 도착 시 영업') 아래에 '도착 시 영업 예상' 칩이 **한 번 더** 붙는다.
- 차이: 같은 사실을 두 번 말하는 칩이 Expo 에만 있다.
- 중요도: P1
- 분류: 추가
- 고칠 방법
  - `CardContext` 에 `showCompare`(홈 true · 저장 false)를 넣는다.
  - `:388`·`:391` 을 웹 조건 그대로 바꾼다(`showCompare && compareHeaderText` / `!showCompare`).
  - `cardModel.test.ts` 에 금관총형(혜택 문장, open_expected) 케이스를 추가한다.
- 바꿀 Expo 파일: `features/recommendation-card/cardModel.ts`, `cardModel.test.ts`, 호출부(`RecommendationCard.tsx`, 저장 `savedList.ts` 경로)
- 문구(i18n): 변화 없음.
- 네이티브 주의: 없음.
- 확인 방법: `11-attraction.mjs` 쌍.
- 크기: S · 의존: 없음

### G3-13 혼잡 추정 값이 다르다 — 최신 추정 피드·기준 명소 등급을 카드에 안 넘김
- 화면·상태: '추천 근거 자세히' 안 혼잡 칩·신선도 줄(추정만 있는 평소 상태), 화살표 문장 판정
- 스크린샷: `shots/G3/04-scroll-04.pair.png` — 웹 '추정 혼잡: 보통 · 14:03 관측' / Expo '추정 혼잡: 혼잡 · 13:13 관측'
- 웹(기준)
  - 카드에 넘기는 추정은 **추정 피드 최신값 우선**: `estimateById[id] ?? 응답의 congestionEstimate`(`page.tsx:4885-4889`, 랭킹 병합 `:2214`).
  - 기준 명소 등급 `compareAnchorLevel` 은 그 명소 시설 자신의 '지금' 혼잡이다(`anchorContextFor :2624-2655` → `anchorNowLevel`).
  - 두 앱 모두 같은 피드·같은 경계(`congestionThreshold 75`)를 받았다(`work/G3/13-data-probe.log` — 향화정 피드 level 0.4445, 관측 14:33).
- Expo(현재)
  - `useFacilities` 가 `estimateById` 를 만들지만 홈이 받지 않는다(`HomeScreen.tsx:131` `const { facilities, loading, error, reload } = useFacilities()`).
  - 그래서 카드가 추천 응답 속 추정(fixture 0.7539, 13:13)만 쓴다.
  - `compareAnchor` 도 안 넘겨서(`:868-885`) 기준 명소 등급을 주차 근거로만 판정한다.
- 차이
  - 혼잡 칩 문구(보통 ↔ 혼잡)와 관측 시각이 다르다.
  - 화살표 문장('A 혼잡 → B 여유') 선택이 달라질 수 있다.
- 중요도: P1
- 분류: 상태(값) · 문구
- 고칠 방법
  1. `HomeScreen.tsx:131` 에서 `estimateById` 를 받는다.
  2. `buildSelectedCandidate`(`features/home/sheetModel.ts:55-68`)에 `estimateById` 인자를 더해 `congestionEstimate: estimateById[facility.id] ?? rec.congestionEstimate ?? null` 로 덮는다(직접 고른 곳도).
  3. 기준 명소는 웹 `anchorContextFor` 를 옮긴다.
     - 이름 = `rec.breakdown.areaDemandTourismEvidence.referenceName`.
     - 시설 = `facilities.find(f => f.name === 이름)`.
     - 등급 = `anchorNowLevel({congestionLevel, congestionSource, congestionIsCurrent, congestionTimestamp, congestionEstimate: estimateById[anchor.id]})`(`features/recommendation-card/compareHeader.ts:83`).
     - 거리 = tourism `distanceM`.
     - 이것을 카드 `compareAnchor` prop 으로 넘긴다.
- 바꿀 Expo 파일: `features/home/HomeScreen.tsx`, `features/home/sheetModel.ts`(+test)
- 문구(i18n): 변화 없음.
- 네이티브 주의: 없음(피드는 5분 폴링 — 웹과 같음).
- 확인 방법: `02-sections.mjs` 의 근거 패널 쌍에서 두 앱 칩·관측 시각이 같아지는지 본다.
- 크기: S · 의존: G3-17

### G3-14 2·3위 카드의 '추천 이유' 상자가 없다
- 화면·상태: 핀으로 3위(우직)를 고른 전체 카드. 1위는 '추천 근거 자세히' 안
- 스크린샷: `shots/G3/91-pin-rank3-full.pair.png`, `04-scroll-03.pair.png`
- 웹(기준)
  - 보이는 상위 3곳을 1위와 비교한 문장(`spotComparisonById`, `page.tsx:1118-1144`)을 만들고, 카드 순위와 같을 때만 넘긴다(`:4788-4791`).
  - 2·3위: 얼굴에 상자(`RecommendationCard.tsx:1713-1718`).
    - 상자 `rounded-xl border-jade/20 bg-jade/5 px-3 py-2`, '추천 이유' 11px extrabold jade + 12px semibold 문장.
    - 예: '베스트 추천과 조건이 비슷해요'.
  - 1위: 근거 패널 안(`:1925-1930`). 예: '취향 51% 일치 · 도보 3분'.
- Expo(현재): 시트는 `comparisonReason` 을 받을 준비가 있지만(`RecommendationSheet.tsx:536-541`, `:578`) 홈이 넘기지 않는다. 어느 순위에서도 안 보인다.
- 차이: 상자 누락(2·3위 얼굴, 1위 근거 패널).
- 중요도: P1
- 분류: 누락
- 고칠 방법
  1. HomeScreen 에 `spotComparisonById` 를 만든다.
     - 대안 화면이 이미 쓰는 앱 이식본 `features/explore/port/spotComparison.ts`(`buildSpotComparisons`·`formatSpotComparison`, 사용 예 `features/explore/RecommendScreen.tsx:82`)를 쓴다.
     - 입력: `visibleRecs.slice(0,3)`(거절·저장 제외)을 웹 필드(`preference, travelMinutes, scoringMode, rankingWaitMinutes, areaDemandPenaltyMinutes, parking/tourism evidence, couponRate`)로 넣는다.
  2. 카드 순위(`rank`)와 비교 순위가 같을 때만 `comparisonReason` 으로 넘긴다.
  3. 카드에서는 웹 자리(혜택 칩·대신 갈 곳 보기 아래)에 상자를 그린다.
- 바꿀 Expo 파일: `features/home/HomeScreen.tsx`, `features/recommendation-card/RecommendationCard.tsx`
- 문구(i18n): 재사용 `recommend.spotComparison.*`(사이드 사전). 새 키 없음.
- 네이티브 주의: 없음.
- 확인 방법: `14-pin-rank.mjs` 쌍(3위), `02-sections.mjs` 근거 패널(1위).
- 크기: S · 의존: G3-07

### G3-15 '상세 정보 펼치기/접기' 버튼이 없다(상세가 늘 붙어 있음)
- 화면·상태: 전체 카드 9번 → 상세 펼침(G3-CARD-03)
- 스크린샷: `shots/G3/02-normal-first.pair.png`, `03-expanded-first.pair.png`, `04-scroll-02.pair.png`
- 웹(기준) `RecommendationCard.tsx:1722-1737`
  - 전폭 버튼 `min-h-10 rounded-2xl border border-gold/40 bg-gold/5 px-3 py-2 text-[13px] font-bold text-gold-deep` + ChevronDown/Up 15.
  - 글자·접근명 '상세 정보 펼치기'↔'상세 정보 접기', `aria-expanded`/`aria-controls`.
  - 누르면 상세를 덧붙이고 80ms 뒤 상세 머리로 스크롤한다(`:645-657`).
  - **상세는 이 버튼(또는 이름 줄 탭·위로 끌기)으로 열 때만 존재한다.** 펼쳐야 `/predict/model-info`→`/predict/day` 를 부른다(`:585-604`).
- Expo(현재)
  - 버튼 없음. 상세(`Details`, `RecommendationSheet.tsx:572-581`, `:635-753`)가 늘 판 끝에 붙어 있고, 90% 로 끌어야 보인다.
  - 예측 호출은 그 장소에서 처음 90%에 닿을 때(`:216-248`).
- 차이
  - 상세에 닿는 유일한 키보드·스크린리더 경로가 없다.
  - 상세 여부를 사용자가 고르지 못한다.
- 중요도: P0
- 분류: 누락 · 동작 · 접근성
- 고칠 방법
  1. `DetailsToggle` 버튼(위 값, `accessibilityRole="button"` `accessibilityState={{expanded}}`). 라벨은 보이는 글자와 같은 키.
  2. `expanded` 상태일 때만 `Details` 를 렌더하고 높이 애니메이션을 준다.
  3. 예측 호출 조건을 `expanded`(상세 열림)로 바꾼다 — `DayForecast enabled={expanded}`(골든타임은 G3-18).
  4. 이름 줄 탭도 같은 토글로.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`, `Extras.tsx`
- 문구(i18n): 재사용 `card.detailsExpand` `card.detailsCollapse`. 새 키 없음.
- 네이티브 주의: TalkBack 이 '펼쳐짐/접힘'을 읽는지.
- 확인 방법: `02-sections.mjs` — 버튼 탭 후 상세가 보이고 '상세 정보 접기'로 바뀌는지. `/predict/model-info` 가 그때 나가는지(`08-forecast.mjs` 로그).
- 크기: S · 의존: G3-01

### G3-16 상세 정보 패널 — 이름 막대·두 칸 배치·크기·소개 줄 수·'상세 리뷰 보기' 링크
- 화면·상태: 상세 펼침(G3-CARD-03·10)
- 스크린샷: `shots/G3/04-scroll-02.pair.png`, `04-scroll-03.pair.png`, `80-live-refresh-toast.pair.png`
- 웹(기준) `RecommendationCard.tsx:1752-1900`
  1. **이름 막대 sticky**: `-mx-1 border-b border-line bg-white/95 px-1 py-1.5 backdrop-blur` + MapPin 13 gold-deep + 13px extrabold 1줄. 본문은 `space-y-3 pt-3 text-xs`.
  2. 대표 메뉴 칩: `rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-semibold`.
  3. 운영 시간·휴무일 **두 칸** `grid-cols-2 gap-3`. 이름표 10px bold muk-soft, 값 12px.
  4. 소개: 이름표 10px + 12px `leading-relaxed` **6줄**.
  5. 주소·전화 **두 칸**. 전화는 `a` 12px bold 밑줄 gold-deep.
  6. 웹사이트/외부 채널(호스트명).
  7. **'상세 리뷰 보기 ↗'**: 카카오 장소 링크가 있을 때, 오른쪽 정렬 12px bold 밑줄.
  8. 💡 사유 13px.
- Expo(현재) `RecommendationSheet.tsx:635-731`
  1. 위 선 + 이름 14px + **값 문장 반복**(sticky 아님).
  2. 메뉴 칩.
  3. 운영 시간·휴무일 **세로**.
  4. 소개: 11px 이름표 + 13px/20 **8줄**.
  5. 주소·전화·홈페이지 세로, 값 13px. 전화·홈페이지는 44px 누름 영역.
  6. 💡 사유.
  - **'상세 리뷰 보기 ↗' 없음.**
- 차이
  - 이름 막대(고정) ↔ 이름 + 문장 반복.
  - 2칸 ↔ 1칸(높이가 훨씬 길다).
  - 글자 10/12 ↔ 11/13, 소개 6 ↔ 8줄.
  - 리뷰 링크 누락.
- 중요도: P1
- 분류: 배치 · 크기·간격 · 누락
- 고칠 방법
  1. ScrollView `stickyHeaderIndices` 로 이름 막대(웹 값)를 상세 머리에 붙인다.
  2. 운영 시간·휴무일, 주소·전화를 `flex-row gap-[12px]` 두 칸(`flex-1 min-w-0`)으로.
  3. 이름표 10px bold, 값 12px, 소개 `numberOfLines={6}` lh 19.5.
  4. `model.kakaoPlaceUrl` 이 있으면 '상세 리뷰 보기 ↗' 링크(오른쪽 정렬, `openExternalUrl`).
  5. 전화·홈페이지 링크는 보이는 글자 높이 16, 탭 영역만 `hitSlop`.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`(Details), `CardParts.tsx`(DetailRow 크기)
- 문구(i18n): 재사용 `card.signatureMenu` `card.hours` `card.closedDays` `card.about` `card.address` `card.phone` `card.website` `card.externalChannel` `card.viewReviews`. 새 키 없음.
- 네이티브 주의
  - `stickyHeaderIndices` 는 ScrollView 의 직계 자식 기준이다. 상세 머리를 직계 자식으로 둔다.
  - Android 에서 2칸 배치는 큰 글자(1.6배)에서 줄이 많아진다(웹과 같음).
- 확인 방법: `02-sections.mjs` 스크롤 쌍, `metrics/04-content-*.json` 크기 대조.
- 크기: M · 의존: G3-15

### G3-17 '추천 근거 자세히' 패널 — 빠진 타일·줄, 혼잡 칩 색, 주변 수요 상자 색
- 화면·상태: 상세 → '추천 근거 자세히' 열림(G3-CARD-04)
- 스크린샷: `shots/G3/04-scroll-03.pair.png`, `04-scroll-04.pair.png`, `04-scroll-05.pair.png`, `48-forecast-mocked-bottom.pair.png`
- 웹(기준) `RecommendationCard.tsx:1904-2213`
  - 틀: `rounded-2xl border border-line`(바탕 없음). 버튼: `px-3 py-2.5 text-[12px] font-bold`.
  - 패널 `space-y-3 border-t px-3 pb-3 pt-3` 안 순서:
    1. (1위) 추천 이유.
    2. 시간 타일 `bg-gradient-to-br from-gold/10 to-gold/5 border-gold/20 rounded-2xl p-3`
       - **오른쪽 위 시계 24 장식(투명도 .2)**, 숫자 24px black + '분' 12px.
       - **경로 출처 줄**: '실제 걷는 길 기준 · © OpenStreetMap' / '직선거리 기반 추정'(11px semibold).
       - 옆에 취향 타일 110px(숫자 20px jade, 카운트업).
    3. **출발·도착(·식사/관람) 타임라인 타일** `bg-hanji-deep border-line rounded-2xl px-4 py-3`. 점 8px gold/jade, 시각 10px bold, '이동 N분' 칩.
    4. 근거 칩: 혼잡 칩은 **등급색**(예: '추정 혼잡: 보통' gold 점선) + 신선도 점선 칩.
    5. 주변 수요 상자 **하늘색** `text-[11px] text-sky-800 bg-sky-500/10 border-sky-500/20 rounded-xl px-3 py-2`.
       - 주차 상자 `border-sky-500/20 bg-white/55`(제목 sky-900, 보조 10px sky-700).
       - 관광 상자 **남색** `border-indigo-500/20 text-indigo-900`(보조 indigo-700).
    6. 축제 보정 → 골든타임 → 오늘 예측(G3-18).
- Expo(현재) `RecommendationSheet.tsx:733-747`, `:755-852`
  - 틀: `Card`(흰 바탕).
  - 시간 타일: 단색 gold/10, 장식 없음, **경로 출처 줄 없음**.
  - **타임라인 타일 없음.**
  - 혼잡 칩 **무채색**(`border-line bg-white/70` 먹 글자 10px). 영업 증거는 닫힘이어도 늘 jade.
  - 주변 수요 상자 **금색·무채색**(`border-gold/20 bg-gold/5`, 글자 muk).
- 차이: 요소 2개 누락(경로 출처, 타임라인), 색 체계 3곳 다름.
- 중요도: P1
- 분류: 누락 · 색·효과
- 고칠 방법
  1. 시간 타일에 `travelSource` 줄(`card.travelRoute|travelEstimate`, 11px semibold). `cardModel` 에 `travelSource: c.breakdown?.travelSource` 를 추가한다.
  2. 타임라인 타일: 웹 `:1972-1999` 그대로.
     - 선 2px line, 점 gold/jade 8px + 4px 한지 진 테두리.
     - 시각 `formatClock`, 라벨 '출발'/'도착'/'식사|관람'. `times.service` 가 있으면 셋째 점.
  3. 근거 칩의 혼잡 칩은 미리보기 작은 판(등급색·점선)으로(웹 `crowdChip(true)`).
  4. 영업 증거 칩: 닫힘이면 terracotta.
  5. 주변 수요 상자 색을 웹 sky/indigo 값으로. tokens 에 추가한다:
     - `area-sky-*`: `#0c4a6e`(900), `#075985`(800), `#0369a1`(700), 바탕 `rgba(14,165,233,0.10)`, 테두리 `rgba(14,165,233,0.20)`.
     - `area-indigo-*`: `#312e81`, `#4338ca`, 테두리 `rgba(99,102,241,0.20)`.
  6. 틀은 바탕 없는 1px line 테두리.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`(WhyPanel), `cardModel.ts`, `lib/theme/tokens.ts`
- 문구(i18n): 재사용 `card.travelRoute` `card.travelEstimate` `card.travel` `card.depart` `card.arrive` `card.dine` `card.view` `card.availability*` `recommend.*`(사이드 사전). 새 키 없음.
- 네이티브 주의: 없음.
- 확인 방법: `02-sections.mjs` 의 `04-scroll-03~05` 쌍.
- 크기: M · 의존: G3-13, G3-15

### G3-18 골든타임·오늘 시간대별 예측 — 자리·모양·호출 시점
- 화면·상태: 근거 패널 끝(웹) / 상세 끝(Expo), 예측 응답 가로채기(`08-forecast.mjs mock`)
- 스크린샷: `shots/G3/48-forecast-mocked-bottom.pair.png`, `49-forecast-mocked-why-closed.pair.png`, `48-forecast-live-bottom.pair.png`
- 웹(기준): 둘 다 **'추천 근거 자세히' 안**(`RecommendationCard.tsx:2168-2211`)
  - 골든타임 `GoldenHourBadge`(`apps/web/components/GoldenHourBadge.tsx:110-135`)
    - `rounded-md border bg-jade/10 border-jade/30 px-2 py-0.5 text-[10px] font-bold text-jade` '🕐 오늘 한산: 16~17시'.
    - '알림 받기'(Bell 10, 10px, 브라우저 알림 — 인벤토리 D5).
  - 예측
    - `border-t border-line/70 pt-3`, 시계 13 + '오늘 시간대별 혼잡 예측' 11px bold.
    - 막대 `h-10 gap-[2px]`: 최저 시각 jade, 나머지 `gold/35`(rgba(193,154,62,.35)), `rounded-sm`.
    - 눈금 10px `muk-soft/70`, '가장 한산한 시간 · 오후 4시' 11px bold jade.
  - 호출(`work/G3/08-forecast.log`): 상세를 열 때 `/predict/model-info`→`/predict/day`, **근거를 열 때** `/predict/golden-hour`.
- Expo(현재)
  - 자리: 근거 카드 **밖**, 상세 맨 끝(`RecommendationSheet.tsx:749-750`). 근거를 닫아도 보인다(`49`).
  - 골든타임: `min-h-[32px] rounded-full px-[10px] py-[4px] 12px`, 알림 버튼 없음(`Extras.tsx:18-44`).
  - 예측: 제목 12px, 막대색 `rgba(184,150,90,0.35)`(`Extras.tsx:106`), 눈금 10px muk-soft, 최저 시각 12px.
  - 호출: 그 장소에서 시트를 처음 90%에 올리면 셋 다 부른다(`RecommendationSheet.tsx:216-248`).
- 차이
  - 자리: 근거 안 ↔ 상세 끝(늘 보임).
  - 크기 10/11 ↔ 12, 막대색, 알림 버튼, 호출 시점.
- 중요도: P1
- 분류: 배치 · 크기·간격 · 색·효과 · 동작
- 고칠 방법
  1. `GoldenHourLine`·`DayForecast` 를 WhyPanel 안 마지막(축제 보정 다음)으로 옮긴다.
  2. 크기·색
     - 골든타임 `rounded-md px-[8px] py-[2px] text-[10px]`.
     - 예측 제목 11px, 최저 시각 11px.
     - 막대색 `rgba(193,154,62,0.35)`, 눈금 `muk-soft` 70%.
  3. 호출: `DayForecast enabled={detailsExpanded}`. `GoldenHourLine` 은 근거 패널이 열렸을 때 마운트한다(웹처럼 마운트 = 호출).
  4. '알림 받기'는 결정한다.
     - (가, 권장) 앱 v1 은 알림 없음 유지(계획 §3.1 · D5).
     - (나) expo-notifications 로컬 예약.
- 바꿀 Expo 파일: `features/recommendation-card/Extras.tsx`, `RecommendationCard.tsx`
- 문구(i18n): 재사용 `golden.badge` `card.todayForecast` `card.forecastAria` `card.oClock` `card.bestTime` `card.hourAm` `card.hourPm`. (나)면 `golden.notifyCta` `golden.notifyAria` `golden.notifyScheduled` `golden.notifyTitle` `golden.notifyBody`.
- 네이티브 주의: (나)는 Android 13+ 알림 권한이 필요하다.
- 확인 방법: `08-forecast.mjs mock` 을 다시 돌려, 근거를 닫으면 두 앱 모두 안 보이는지와 요청 순서 로그를 비교한다.
- 크기: S · 의존: G3-15, G3-17
- 표시: 결정 필요('알림 받기')

### G3-19 영업 확인 질문 — 자리와 크기
- 화면·상태: 영업 미확인 음식점(청온채 `needs_confirmation`, 운영시간 없음)에서 '바로 갈래요'(ACT-01b)
- 스크린샷: `shots/G3/44-hours-prompt.pair.png`, `44-hours-peek.pair.png`
- 웹(기준)
  - 동작: 미리보기에서 누르면 카드를 전체로 펴고 카카오 장소를 새 창으로 연다. 질문 상자는 **스크롤 영역 끝(바닥 버튼 바로 위)** 에 두고 화면 안으로 끌어온다(`RecommendationCard.tsx:1189-1200`, `:427-432`, `:2222-2249`).
  - 상자 `rounded-2xl border-gold/30 bg-gold/10 p-3`. 질문 12px extrabold, 안내 11px leading-relaxed.
  - 버튼 3칸 `grid-cols-3 gap-2 mt-3`, 각 `rounded-xl px-2 py-2 text-[11px] font-bold`(약 31px). 영업 중 jade, 닫힘 terracotta, 잘 모르겠어요 흰 바탕·line.
  - 오류 10px.
  - 바닥 줄2 의 자동차 자리에는 '출발 전에 카카오맵에서 영업시간을 먼저 보여 드려요.'(11px).
- Expo(현재) `RecommendationSheet.tsx:317-329`, `:465-467`, `:603-633`
  - 시트를 기본(52%)으로 올리고, 상자는 **머리·첫 행동 줄 바로 아래**에 둔다.
  - 질문 13px, 안내 11px/16, 버튼 `min-h-[44px]` 12px, 오류 11px.
- 차이: 자리(바닥 버튼 위 ↔ 첫 버튼 아래), 버튼 높이 31 ↔ 44px, 글자 12/11 ↔ 13/12.
- 중요도: P1
- 분류: 배치 · 크기·간격
- 고칠 방법
  1. 새 카드의 스크롤 영역 끝(11번)에 두고, 열릴 때 `scrollToEnd`(웹 `scrollIntoView({block:'nearest'})`).
  2. 미리보기에서 열리면 전체로(`compactPeek && minimized` → normal).
  3. 크기는 웹 값, 버튼 보이는 높이 31 + `hitSlop` 으로 44.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`
- 문구(i18n): 재사용 `card.hoursCheckQuestion` `card.hoursCheckPrivacy` `card.hoursOpen` `card.hoursClosed` `card.hoursUnsure` `card.hoursReportFailed` `card.checkHoursKakaoHint`(사이드 사전). 새 키 없음.
- 네이티브 주의: 카카오맵 앱이 앞으로 왔다가 돌아왔을 때 상자가 보이는 자리여야 한다. AppState active 때 `scrollToEnd` 를 한 번 더.
- 확인 방법: `07-variants.mjs hours` 쌍.
- 크기: S · 의존: G3-07

### G3-20 바닥·미리보기 버튼 모양(다시 안볼래요·킵·바로 갈래요·자동차·혼잡 제보)
- 화면·상태: 미리보기 버튼 줄, 전체 카드 바닥 두 줄
- 스크린샷: `shots/G3/53z-buttons-zoom.pair.png`, `50z-peek-zoom.pair.png`, `02-normal-first.pair.png`
- 웹(기준) `RecommendationCard.tsx:2258-2319`, `apps/web/components/CongestionReportButton.tsx:143-160`
  - 다시 안볼래요: `min-h-11 flex-1 bg-hanji-deep border border-line rounded-2xl py-2.5 text-xs(12) font-bold text-muk-soft`.
  - 킵: 같은 바탕 + Bookmark 14(누르면 Check 14 jade) + **두 줄 글자** '일단 킵하고⏎다음 후보 볼래요' `whitespace-pre-line leading-tight`.
  - 바로 갈래요: `cta-primary rounded-2xl text-xs font-bold` + 그림자 `0 4px 14px rgba(168,70,47,.28)`. 세 칸 폭이 약 101px 라 '바로 갈래요 (도보⏎길안내)' 두 줄이 된다. 측정 높이 52px.
  - 자동차: `min-h-11 rounded-xl border-line bg-white text-[12px] font-bold text-muk-soft`.
  - 혼잡 제보: `px-3 py-2 rounded-full border text-xs font-bold` + Users 14(높이 34px). 첫 제보면 jade 톤 '지금 붐비나요? 알려 주세요'.
  - 누름 피드백 `.toss-pressable`: 0.96 축소 + 밝기 .94(`globals.css:356-371`).
- Expo(현재)
  - `Button`(`components/ui/Button.tsx:70-89`): 보조 버튼은 **흰 바탕 + 먹 글자 14px**, 주 버튼 14px, 모두 `rounded-2xl px-[16px] py-[8px] min-h-[44px]`.
  - 킵: 한 줄 '일단 킵하고 · 다음 후보 볼래요', 전폭. 줄바꿈을 ' · '로 바꾼다(`RecommendationSheet.tsx:480`).
  - 자동차: `rounded-2xl` 14px 먹.
  - 제보 트리거: `min-h-[44px]`(`CongestionReportButton.tsx:72-80`).
- 차이
  - 바탕: 한지 진 ↔ 흰.
  - 글자: 12 ↔ 14, 먹 연 ↔ 먹.
  - 킵: 두 줄 ↔ 한 줄. 자동차 모서리: 12 ↔ 16. 제보 높이: 34 ↔ 44px.
- 중요도: P1
- 분류: 색·효과 · 글꼴 · 크기·간격 · 문구
- 고칠 방법
  1. 카드 전용 버튼 3종을 웹 클래스 그대로 만든다. `Button` 의 variant 를 늘리지 말고 카드 파일 안에 `CardActionButton` 을 둔다.
     - reject/keep: `bg-hanji-deep border border-line rounded-2xl text-[12px] text-muk-soft font-bold min-h-[44px] py-[10px]`.
     - accept: `Gradient cta` + 흰 12px bold + `shadows.cta`.
  2. 킵 글자는 `t('card.putOff')` 그대로(줄바꿈 유지, `textAlign:center`, lh 15).
  3. 자동차: `rounded-xl bg-white border-line text-[12px] text-muk-soft`.
  4. 제보 트리거: 보이는 높이 34 + `hitSlop` 5.
  5. 누름 피드백은 `Pressable`(scale .96·dim) 그대로.
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`, `CongestionReportButton.tsx`
- 문구(i18n): 재사용 `card.putOff`(줄바꿈 그대로) 외 G3-07 과 같음. 새 키 없음.
- 네이티브 주의: 12px 글자는 큰 글자 1.6배에서 19px 가 된다. 세 칸에서 세 줄이 될 수 있다(웹도 같음).
- 확인 방법: `53z-buttons-zoom` 다시(`09-zooms.mjs`).
- 크기: S · 의존: G3-07

### G3-21 혼잡 제보 — Expo web 에서 모달이 열리지 않음 + 모달 모양 차이
- 화면·상태: 전체 카드 '지금 붐비나요? 알려 주세요' → 모달(ACT-05)
- 스크린샷: `shots/G3/30-report-modal.pair.png`(Expo 쪽은 열리지 않은 화면), `30z-expo-report-after-click.expo.png`, `30z-expo-report-after-tap.expo.png`
- 웹(기준) `CongestionReportButton.tsx:187-279`
  - body 포털. 폰에서는 **아래 정렬** 모달 `items-end`.
  - 바탕막: `bg-muk/40 backdrop-blur-sm`, 누르면 닫힘.
  - 판: `max-w-sm bg-hanji border-line rounded-t-3xl p-6 gap-5` + 위 3px 금 장식선 + 그림자 `0 -8px 40px rgba(43,35,32,.2)`.
  - 머리: 제목 '지금 이곳 얼마나 붐비나요?' serif 18px bold + 장소 12px + **X 닫기**(18).
  - 3칸 `grid-cols-3 gap-2.5`, 각 `py-4 rounded-2xl border-2 bg-white/60`(이모지 24 · 14px bold · 10px 설명). 누르면 바로 제출한다.
  - '제보 중…' 줄, 바닥 안내 10px. Esc 로 닫힌다.
- Expo(현재) `CongestionReportButton.tsx:82-122` + `components/ui/Sheet.tsx:305-393`(`ModalSheet` = gorhom `BottomSheetModal`)
  - **Expo web 빌드에서 버튼을 눌러도(클릭·터치 탭 모두) 아무것도 뜨지 않는다.** `work/G3/06z-expo-report-debug.log`: 3초 뒤에도 제목 0·radio 0.
  - G2 의 '필터·편의'(`work/G2/diag-sheet*.mjs`)도 같은 증상이다.
  - 코드상 모양: 손잡이 22px, 바탕 흰 95%, 바탕막 검정 .35, 여백 16, X 없음, 옵션 `min-h-[88px] py-[12px]`.
- 차이
  - 웹 빌드에서 기능이 동작하지 않는다.
  - 열린다 해도 바탕색(한지 ↔ 흰), 여백 24 ↔ 16, 장식선·X 닫기·흐림 바탕막이 빠져 있다.
- 중요도: P0
- 분류: 동작 · 색·효과 · 누락
- 고칠 방법
  1. 원인 확인: `BottomSheetModalProvider`(`app/_layout.tsx:75`) 포털이 react-native-web 운영 빌드에서 `present()` 를 그리지 않는지 본다. `ModalSheet` 를 쓰는 화면(필터·편의, 그룹 핀, 혼잡 제보, 지금 한산)이 모두 영향을 받는다.
  2. 해법(권장): `components/ui/ModalSheet.web.tsx` 를 따로 둔다. 웹에서는 RN `Modal transparent animationType="fade"` + 아래 정렬 판으로 그리고, 네이티브는 gorhom 그대로.
  3. 모양을 웹 값으로 맞춘다.
     - 판 `bg-hanji rounded-t-[24px] p-[24px] gap-[20px]` + 3px `LinearGradient`(투명→gold 60%→투명).
     - 머리 오른쪽 `IconButton X`(`common.close`).
     - 바탕막 `rgba(43,35,32,0.40)`. 흐림은 web 만 `backdropFilter`.
     - 판 폭 `max-w 384`.
  4. 옵션 `py-[16px]`, 간격 10.
- 바꿀 Expo 파일: `components/ui/Sheet.tsx`(ModalSheet), 새 `components/ui/ModalSheet.web.tsx`, `features/recommendation-card/CongestionReportButton.tsx`
- 문구(i18n): 재사용 `report.title` `report.selectAria` `report.quietDesc` `report.moderateDesc` `report.busyDesc` `report.submitting` `report.footer` `common.close` `congestion.*`. 새 키 없음.
- 네이티브 주의
  - Android 에서는 gorhom 모달이 열릴 가능성이 크다(웹 판 전용 문제로 보임). 실기기에서 '혼잡 제보'·'필터·편의'를 눌러 확인한다.
  - 네이티브 판에도 X 닫기·한지 바탕은 같게.
- 확인 방법: `06-report.mjs` 를 다시 돌려 Expo 에 radiogroup 3개가 보이는지, 선택 후 토스트(G3-22)를 본다.
- 크기: M · 의존: G2(필터·편의 같은 원인)
- 표시: 네이티브 확인 필요 · 촬영 못 함(Expo 모달)

### G3-22 혼잡 제보 결과 토스트 — 웹 전용 색 토스트 vs sonner
- 화면·상태: 제보 성공(하네스 가짜 200) · 403(로컬 가로채기)
- 스크린샷: `shots/G3/31y-web-report-toast-1500ms.web.png`, `33y-web-report-403-toast.web.png`, `31-report-success-toast.pair.png`(Expo 는 모달이 안 열려 촬영 못 함)
- 웹(기준) `CongestionReportButton.tsx:76-80`, `:163-185`
  - 버튼 자체 포털 토스트. 위치 `fixed bottom-24`(96px) 가운데 `max-w-sm px-4`.
  - 안쪽 `rounded-2xl px-4 py-3 text-sm(14) font-bold text-white text-center` + 그림자 `0 8px 30px rgba(43,35,32,.18)`.
  - 색: **성공 jade 바탕 · 실패 terracotta 바탕**. 3.2초, `role=status aria-live=polite`.
  - 측정: 3,704,384,44(390 폭에서 좌우 3px).
  - 실패 시 모달은 열린 채.
- Expo(현재) `CongestionReportButton.tsx:53`, `:56`: `toast.success(…)`/`toast.error(…)`(sonner-native, 한지 바탕 + 아이콘, 4초, 탭 막대 위).
- 차이: 단색 강조 토스트 ↔ 일반 토스트, 위치 96px ↔ 탭 막대 위 64px, 3.2 ↔ 4초.
- 중요도: P1
- 분류: 색·효과 · 동작
- 고칠 방법
  1. `toast.custom`(sonner-native) 또는 버튼 안 Reanimated 절대 배치 뷰로 웹 토스트를 그대로 만든다.
     - 위치: 화면 아래 96px, 좌우 3(`max-w 384` 가운데).
     - 바탕 `colors.jade`/`colors.terracotta`, 흰 14px bold 가운데, 모서리 16, 그림자.
     - 들어올 때 opacity 0·y 12 → 1·0. 3200ms 뒤 사라짐. `accessibilityLiveRegion="polite"`.
  2. 실패 시 모달 유지(지금과 같음).
- 바꿀 Expo 파일: `features/recommendation-card/CongestionReportButton.tsx`
- 문구(i18n): 재사용 `report.success` `report.authError` `report.cooldownError` `report.failError`. 새 키 없음.
- 네이티브 주의: 탭 막대 높이가 G2 로 바뀌면 96px 가 막대와 겹치는지 다시 본다(웹은 막대 101px 위에 반쯤 걸친다).
- 확인 방법: G3-21 해결 뒤 `06-report.mjs`.
- 크기: S · 의존: G3-21
- 표시: 촬영 못 함(Expo)

### G3-23 '바로 갈래요' 뒤 흐름 — 웹은 앱 탭까지 카카오맵으로 넘어감(웹 버그로 보임) · 진행 카드가 돌아와야 뜸
- 화면·상태: ACT-01 수락 직후, 자동차 길안내(ACT-04)
- 스크린샷: `shots/G3/06-accept-toast.pair.png`, `07-journey.pair.png`, `07b-journey-after-return.pair.png`, `27-journey-car.pair.png`
- 웹(기준)
  - `openWalkingDirections`/`openDrivingDirections`(`apps/web/lib/navigation.ts:17-30`)는 `window.open(url,'_blank','noopener,noreferrer')` 의 반환값이 없으면 `location.href = url` 로 넘어간다.
  - `noopener` 를 주면 브라우저는 **늘 null** 을 돌려준다. 그래서 새 탭과 함께 **앱 탭도 카카오맵으로 이동**한다. `work/G3/04z-debug-journey.log`: 수락 뒤 같은 탭의 localStorage 가 카카오 도메인 것으로 바뀌었다.
  - 돌아오면(뒤로) `/main` 이 다시 열리며 진행 카드가 뜬다.
  - 같은 탭에 머무르는 경우(가짜 창으로 막았을 때)에는 진행 카드가 **탭 복귀(`visibilitychange`) 전까지 안 뜬다**. `handleAccept`(`page.tsx:2329-2381`)가 `nextspot:trip-navigating` 을 보내지 않기 때문이다(`ActiveJourneyCard.tsx:46-63`).
- Expo(현재)
  - `openBrowserAsync`(웹은 새 창만). 카드는 그대로 ✓ 표시.
  - 진행 카드는 `tripEvents.emit` 으로 **즉시** 뜬다(`tripLoop.ts:125`, `07-journey`).
- 차이: 수락 뒤 화면 — 웹은 카카오맵으로 떠났다가 돌아오면 홈 + 진행 카드. Expo 는 홈에 남아 진행 카드 + 카드 ✓.
- 중요도: P1
- 분류: 동작
- 고칠 방법: 결정한다.
  - (가, 권장) Expo 는 지금 흐름을 유지한다(웹 버그를 따라 하지 않는다). 웹 쪽 작업:
    - `lib/navigation.ts` 를 `const w = window.open(url, '_blank'); if (w) { w.opener = null; } else { location.href = url; }` 로 고친다.
    - 수락 직후 `window.dispatchEvent(new Event('nextspot:trip-navigating'))` 를 보내 진행 카드를 바로 띄운다.
  - (나) Expo 도 같은 탭 이동을 흉내 낸다 — 비권장.
- 바꿀 Expo 파일: (가) 없음. 웹 파일 `apps/web/lib/navigation.ts`, `app/main/page.tsx:2329-2381` — 웹 작업.
- 문구(i18n): 변화 없음.
- 네이티브 주의: 네이티브는 카카오맵 앱(`kakaomap://`)으로 나갔다 돌아오는 흐름이라, 웹의 '돌아와야 뜸'과 체감이 같다.
- 확인 방법: 웹 수정 뒤 `04-actions.mjs` 를 `window.open` 가짜 없이 실행해서 앱 탭이 `/main` 에 남는지 본다.
- 크기: S · 의존: 없음
- 표시: 결정 필요

### G3-24 다음 후보 규칙 — 오늘 휴무 확정 곳 건너뛰기 · 킵 소진 시 되돌기
- 화면·상태: 1위 거절 → 다음 후보(2위가 오늘 휴무 '매주 화요일'), 킵을 계속 눌러 후보 소진(NEXT-01·02)
- 스크린샷: `shots/G3/58z-next-after-reject-closed.pair.png`, `41-measured-next-after-reject.pair.png`
- 웹(기준)
  - 거절 후보는 서버 순위에서 **오늘 휴무 확정 시설을 빼고** 고른다(`page.tsx:2514-2522` `openToday`) → 우직(3위).
  - 킵은 후보가 소진되면 처음 순위로 되돈다(`:2418-2423`).
- Expo(현재)
  - `nextCandidateAfter`(`features/recommendation-card/actionsCore.ts:55-66`)는 제외 목록만 본다 → **호랑이카츠(오늘 휴무)** 를 다음 카드로 보여 준다.
  - 킵·거절이 소진되면 `null` → 카드 닫힘 + 제안 상자.
- 차이: 문 닫은 곳을 추천으로 띄운다(웹이 막는 사고). 킵 소진 처리도 다르다.
- 중요도: P1
- 분류: 동작
- 고칠 방법
  1. `nextCandidateAfter(candidates, id, excluded, { skipClosedToday: true })` — `isClosedToday(features.rest_date_raw ?? features.restDateRaw) === true` 면 건너뛴다. `@/lib/restDate` 는 이미 `cardModel` 이 쓰는 순수 모듈이다.
  2. 킵 경로(`doKeep`, `RecommendationSheet.tsx:309-316`)는 `null` 이면 첫 후보로 돌아간다(지금 장소 포함, 웹 `rankedFacilities.filter(voicePass)` 와 같게).
  3. `actionsCore.test.ts` 에 두 케이스를 추가한다.
- 바꿀 Expo 파일: `features/recommendation-card/actionsCore.ts`(+test), `RecommendationCard.tsx`
- 문구(i18n): 변화 없음.
- 네이티브 주의: 없음.
- 확인 방법: `07-variants.mjs measured`(2위 휴무 시드) — 거절 뒤 두 앱 모두 우직이 나오는지.
- 크기: S · 의존: 없음

### G3-25 첫 추천을 기다리는 동안(로딩) — 스켈레톤 카드 + 문구 vs 막대 3개
- 화면·상태: by-type 응답 9초 지연(`07-variants.mjs loading`)
- 스크린샷: `shots/G3/40-loading-2s.pair.png`, `40b-loading-6s.pair.png`, `40c-loading-done.pair.png`
- 웹(기준) `page.tsx:4749-4773`
  - 카드 자리: `role=status aria-live=polite` `rounded-3xl border-line bg-white/95 p-5 toss-surface` + 손잡이 막대.
  - **돌림표(14px, gold/30 테두리·gold-deep 윗변) + '지금 덜 붐비는 가까운 곳을 고르고 있어요…'(13px extrabold)**.
  - 막대 2개: `h-6 w-4/5 rounded-lg`, `h-3 w-3/5 rounded-full`(hanji-deep pulse).
  - **최대 3.5초**(`FIRST_PICK_WAIT_MS :406`) 뒤 화면 안 계산 카드(D16)를 띄운다. `40b` 6초 시점에는 이미 카드.
- Expo(현재) `RecommendationSheet.tsx:169-176`
  - 27% 시트 안 막대 3개(20/14/44px). 문구·돌림표 없음. `role=progressbar` '불러오는 중...'.
  - 응답이 올 때까지 기다린다(최대 20초 `HomeScreen.tsx:101`).
- 차이: 문구·돌림표 누락, 틀(카드 ↔ 시트), 3.5초 뒤 동작.
- 중요도: P1
- 분류: 상태(로딩) · 누락
- 고칠 방법
  1. G3-01 카드 틀과 같은 `CardSkeleton`(위 값). 돌림표는 테두리 원 회전, 또는 `ActivityIndicator color=gold-deep size 14`.
  2. 3.5초 뒤 동작은 G3-26 결정에 따른다(웹처럼 즉시 카드 / 계속 대기).
- 바꿀 Expo 파일: `features/recommendation-card/RecommendationCard.tsx`(CardSkeleton), `features/home/HomeScreen.tsx`
- 문구(i18n): 재사용 `map.pickingFirst`. 새 키 없음.
- 네이티브 주의: 동작 줄이기면 pulse 를 멈춘다.
- 확인 방법: `07-variants.mjs loading` 쌍.
- 크기: S · 의존: G3-01, G3-26

### G3-26 추천 실패·후보 소진 때의 대체(인벤토리 D16)
- 화면·상태: by-type 503(`07-variants.mjs error`), 유일 후보 거절(`single`)
- 스크린샷: `shots/G3/47-recs-error-peek.pair.png`, `46-single-exhausted.pair.png`
- 웹(기준)
  - 서버가 실패하면 화면 안 SPOT 미러(`lib/recommender.ts` `rankFacilitiesDegraded`)로 '영업 확인' 후보만 매겨 카드를 띄운다(`page.tsx:2219-2232`) → 호랑이카츠 'SPOT 59점' + '다시 안볼래요'.
  - 거절로 서버 순위가 바닥나도 같은 미러로 다음 카드를 띄운다(`:2524-2531`) → '선택한 장소' + '대신 갈 곳 보기'.
- Expo(현재)
  - 실패하면 가까운 곳 하나를 '직접 고른 곳'처럼 보여 준다(`HomeScreen.tsx:314-316`, `:368-378`) → SPOT 없음 + '대신 갈 곳 보기'.
  - 소진하면 카드 닫힘 + 제안 상자(G3-27).
  - 시트의 오류·빈 판(`RecommendationSheet.tsx:176-180`)은 `sheetStatus` 가 loading|ready 만 줘서 홈에서 닿을 수 없다(`features/home/sheetModel.ts:70-72`).
- 차이: 실패·소진 화면이 다르다(웹은 점수 있는 카드가 이어진다).
- 중요도: P1
- 분류: 상태(오류·빈)
- 고칠 방법: 결정한다.
  - (가, 권장) 웹 미러를 옮기지 않는다.
    - 근거: `apps/web/AGENTS.md`('SPOT 점수는 백엔드 단일 소스, 클라이언트에서 재구현하지 말 것', recommender.ts 는 단계적 제거 대상), 계획 §3.4('실패하면 다시 시도').
    - 대신 웹과 **같은 카드 틀**로 오류 판(`recommend.loadFailed` + '다시 시도')이 보이게, `sheetStatus` 에 `error`(by-type 실패)를 살린다.
    - 소진은 G3-27 제안 상자.
  - (나) 웹과 똑같이 미러를 앱 `lib/` 에 다시 써서 점수 카드를 띄운다 — 비권장(점수 계산이 두 벌).
- 바꿀 Expo 파일: (가) `features/home/sheetModel.ts`(+test), `features/home/HomeScreen.tsx`, `RecommendationCard.tsx`
- 문구(i18n): 재사용 `recommend.loadFailed` `common.retry` `app.cardSheet.emptyTitle` `map.noRecBody`. 새 키 없음.
- 네이티브 주의: 없음.
- 확인 방법: `07-variants.mjs error|single`.
- 크기: M · 의존: G3-01, G3-25
- 표시: 결정 필요

### G3-27 후보 소진 '다른 곳 제안' 상자 모양·변형
- 화면·상태: 후보 소진(NEXT-02). Expo 만 도달(웹은 미러로 이어져서 이번 데이터로는 안 뜸)
- 스크린샷: `shots/G3/46-single-exhausted.pair.png`(Expo), 웹은 코드
- 웹(기준) `page.tsx:4916-4994`
  - `category-suggestion` `rounded-2xl border-line bg-white px-5 py-4 shadow-[0_2px_14px_rgba(43,35,32,0.06)] items-center gap-2 text-center`.
  - **마스코트**(`NextSpotMascot w-12`, `/mascot/nextspot-guide.webp`) + 제목 14px semibold.
  - 전부 오늘 휴무면 12px 설명 `map.noRecClosedBody`.
  - 칩 `rounded-full border-gold/50 bg-gold/10 px-3.5 py-2 text-xs font-bold text-muk`.
  - 휠체어·유모차 조건이면 문구·'지도에서 보기'·'유모차 조건 끄기' 변형(`:4945-4991`).
- Expo(현재) `HomeScreen.tsx:813-829`
  - `rounded-2xl border-line bg-white p-[16px]`, 마스코트 없음.
  - 칩 `min-h-[44px] border-jade/40 bg-jade/10 px-[14px]` 13px **jade**.
  - 휴무·조건 변형 없음.
- 차이: 마스코트·색(금 ↔ 옥)·여백·변형 누락.
- 중요도: P1
- 분류: 누락 · 색·효과 · 크기·간격
- 고칠 방법
  1. 웹 값으로 상자·칩 스타일.
  2. 마스코트 이미지(`apps/web/public/mascot/nextspot-guide.webp`)를 `apps/mobile/assets/images/` 로 복사해 `expo-image` 48px 로 그린다. 아바타 판: 둥근 + `border-gold/35`, `object-position 50% 22%`, `scale 1.48`.
  3. 변형을 옮긴다.
     - 전부 오늘 휴무(`noRecClosedBody`).
     - 휠체어·유모차(`barrierFreeElsewhere|strollerElsewhere`, `…OnMap`, `placeSearchView`, `strollerOff`).
     - 홈에 같은 계산(웹 `attributePinsHere`·`attributePinChips`·`strollerPinsNone`)을 G2 편의 조건과 함께 옮긴다.
- 바꿀 Expo 파일: `features/home/HomeScreen.tsx`(또는 `HomeOverlays.tsx`), `assets/images/`
- 문구(i18n): 재사용 `map.suggestTitle` `map.suggestButton` `map.noRecClosedBody` `map.barrierFreeElsewhere` `map.strollerElsewhere` `map.barrierFreeOnMap` `map.strollerOnMap` `map.placeSearchView` `map.strollerOff`. 새 키 없음.
- 네이티브 주의: 없음.
- 확인 방법: 웹이 미러로 소진되지 않는 한 쌍 비교가 어렵다. 웹에 시설 목록을 한 칩 1곳으로 가로채서(`overlays/G3`) 다시 찍는다.
- 크기: S · 의존: G3-26, G2
- 표시: 촬영 못 함(웹)

### G3-28 진행 중 여행 카드 — 자리·구성·크기
- 화면·상태: JRN-01(도보 · 자동차), 카드를 올린 상태
- 스크린샷: `shots/G3/07b-journey-after-return.pair.png`, `54z-journey-zoom.pair.png`, `27-journey-car.pair.png`, `61-journey-with-card-raised.pair.png`, `60-journey-seeded.pair.png`
- 웹(기준) `apps/web/components/main/ActiveJourneyCard.tsx:185-269`
  - 자리: `absolute z-30 top-24 left-4 right-4`. 위 96px 라 검색창 아래 절반과 칩 줄을 덮는다.
  - 틀: `max-h-[calc(100dvh-7rem)] overflow-y-auto rounded-2xl border border-jade/30 bg-white/95 backdrop-blur p-4 toss-surface`.
  - 등장: opacity 0·y −12·scale .98 → 스프링.
  - 줄 순서:
    1. '활성 여정' 12px bold jade.
    2. 'OO(으)로 이동 중' 16px bold **1줄**.
    3. '도보 약 N분 기준'(또는 '자동차로 안내 중이에요.') 12px.
    4. 3칸 버튼 `grid-cols-3 gap-2 mt-3 text-xs font-bold` `rounded-xl py-2`(약 32px). 도착 jade 흰 글자 / 아직 line / 상황 변경 gold/10 + RefreshCw 12.
    5. '도보 길안내 다시 열기' 12px bold gold-deep + Navigation 12.
  - 추천 카드 위에 겹쳐 늘 보인다.
- Expo(현재) `apps/mobile/features/recommendation-card/ActiveJourneyCard.tsx:243-356`, 자리 `HomeScreen.tsx:836-866`
  - 자리: 칩 줄 아래(약 y 236).
  - 틀: `Card`(흰 바탕 · **line 테두리** · 그림자 surface).
  - 줄 순서:
    1. '활성 여정 · OO(으)로 이동 중' 한 줄(12px jade + 16px, 2줄까지).
    2. 버튼 `min-h-[44px]` 12px.
    3. 그 아래 '도보 약 N분 기준'.
    4. 다시 열기(44px).
  - 남은 높이가 78 미만이면 감춘다(`features/home/homeModel.ts:482`, `:518-536`). 그 안에서만 스크롤.
- 차이
  - 자리: 위 96 겹침 ↔ 칩 줄 아래.
  - 테두리색. 머리 두 줄 ↔ 한 줄.
  - 도보 줄 위치: 제목 아래 ↔ 버튼 아래.
  - 버튼 32 ↔ 44px.
  - 자리가 부족할 때 감춤(웹은 늘 위에 겹친다).
- 중요도: P1
- 분류: 배치 · 색·효과 · 크기·간격
- 고칠 방법
  1. 자리: 홈 위쪽 `top: 96`(웹 `top-24`), 좌우 16, `maxHeight: 화면 높이 − 112`(웹 `100dvh−7rem`).
     - 추천 카드보다 위 층(zIndex). 겹침을 허용한다(웹과 같음).
     - `pickTripOverlay` 의 '자리 없으면 감춤'은 지운다.
  2. 틀: `rounded-2xl border border-jade/30 bg-white/95 p-[16px]` + `shadows.surface`.
  3. 머리: '활성 여정'을 따로 한 줄(12px bold jade) → 제목 16px bold `numberOfLines={1}` → 도보/자동차 줄 12px muk-soft(`mt-[2px]`).
  4. 버튼 3칸: `gap-[8px] mt-[12px]` `rounded-xl py-[8px]` 12px bold(보이는 높이 32 + `hitSlop`).
  5. 다시 열기: `mt-[8px]` 12px bold gold-deep(+ hitSlop).
  6. 웹 `top-24` 가 검색창을 덮는 것이 의도인지는 G2 와 함께 확인한다(아래 '다른 묶음').
- 바꿀 Expo 파일: `features/recommendation-card/ActiveJourneyCard.tsx`, `features/home/HomeScreen.tsx`, `features/home/homeModel.ts`(+test)
- 문구(i18n): 재사용 `trip.active` `trip.heading` `trip.walkEstimate` `trip.driveBasisHint` `trip.arrived` `trip.stillGoing` `trip.changed` `trip.resumeDirections` `trip.resumeDriving`. 새 키 없음.
- 네이티브 주의: 상황 변경 입력 중 키보드가 카드를 가리는 문제(11-09 기록)는, 겹침 배치에서 `KeyboardAvoidingView` 또는 지금의 `revealFocusedInput` 을 유지해 확인한다.
- 확인 방법: `10-journey-seeded.mjs` 쌍(시드로 바로 진행 카드).
- 크기: M · 의존: G3-01(카드 겹침 순서)

### G3-29 '상황 변경' 패널 — 닫기 X, 버튼 색, 입력·칩 크기, 잘림
- 화면·상태: SIT-01 열림, SIT-03 입력·'조건 확인'(LLM 막힘 → 해석 실패 문구), 칩 선택, SIT-04 갈아타기
- 스크린샷: `shots/G3/08-sit-open.pair.png`, `09-sit-typing.pair.png`, `10-sit-parse-blocked.pair.png`, `10b-sit-chips-bottom.pair.png`, `11-sit-chip-selected.pair.png`, `12-sit-replaced.pair.png`
- 웹(기준) `ActiveJourneyCard.tsx:201-255`
  - 높이 0→auto 로 펼친다. `mt-3 border-t pt-3`.
  - 순서
    1. '무엇이 달라졌나요?' 12px bold(라벨).
    2. '이 조건으로 재추천' **jade 단색** `rounded-xl py-2 text-xs`.
    3. 안내 `rounded-xl bg-terracotta/10 px-3 py-2 text-xs`, 재시도 `rounded-lg border-terracotta/40 py-1.5`.
    4. 입력 `min-h-16 rounded-xl border-line px-3 py-2 text-xs`.
    5. '조건 확인' `rounded-xl border-jade/30 bg-jade/5 text-jade py-2 text-xs`.
    6. 힌트 11px.
    7. 칩 `rounded-full border px-2.5 py-1 text-[11px] font-semibold`. 선택: jade 테두리·jade/10·jade 글자.
    8. [취소][이 조건으로 재추천(jade)].
  - 열자마자 칩까지 다 보인다(카드 최대 높이 `100dvh−7rem` 안에서 스크롤).
- Expo(현재) `ActiveJourneyCard.tsx:280-343`
  - 머리 줄 오른쪽 **X 닫기**(웹에 없음).
  - 재추천은 **금→주칠 그라데이션** `Button`(44px 14px).
  - 외부 AI 안내(G3-30).
  - 입력 13px. '조건 확인'은 흰 보조 버튼(먹 14px).
  - 칩 `Chip` `min-h-[32px] px-[12px] py-[6px] text-[13px]`(선택 `border-jade bg-jade-chip` 먹 글자).
  - 취소·재추천 `Button`.
  - 여정 카드가 칩 줄과 시트 사이 남은 높이 안이라 **칩 대부분이 잘려 안쪽 스크롤로만 보인다**(`10b`).
- 차이: 닫기 X 추가, 주 버튼 색(jade ↔ CTA 그라데이션), 글자 12/11 ↔ 13/14, 칩 크기·선택색, 펼친 내용이 잘림.
- 중요도: P1
- 분류: 추가 · 색·효과 · 크기·간격 · 배치
- 고칠 방법
  1. X 닫기를 지운다. 웹은 '취소'로 닫는다(칩 영역이 늘 보이므로).
  2. 버튼을 웹 값으로.
     - 재추천 `bg-jade rounded-xl py-[8px] text-[12px] font-bold text-white`(비활성 50%).
     - 조건 확인 `border-jade/30 bg-jade/5 text-jade`. 취소 `border-line`.
  3. 입력: 12px `min-h-[64px] rounded-xl px-[12px] py-[8px]`.
  4. 칩: 카드 안 `ChoiceChip`(웹 `:272-274` 값). 앱 공용 `Chip` 은 그대로 둔다.
  5. 잘림은 G3-28 의 자리 변경(최대 높이 `화면−112`)으로 해결된다.
  6. 펼침 애니메이션 `interactionSpring`(460/34/0.72 = `springs.interaction`).
- 바꿀 Expo 파일: `features/recommendation-card/ActiveJourneyCard.tsx`
- 문구(i18n): 재사용 `trip.changeTitle` `trip.confirmContext` `trip.changePlaceholder` `trip.parse` `trip.parsing` `trip.manualHint` `trip.noContext` `trip.walkChip` `trip.availableChip` `setup.twoHoursPlus` `trip.attribute.*` `setup.excludeVisited` `common.cancel` `common.loading` `common.retry` `category.*`. 새 키 없음.
- 네이티브 주의: 키보드 — 입력이 카드 아래쪽이라 Android `adjustResize` 와 함께 카드 스크롤로 입력을 보이게 한다(지금 `revealFocusedInput` 재사용).
- 확인 방법: `04-actions.mjs`(08~12 쌍).
- 크기: S · 의존: G3-28

### G3-30 외부 AI 전송 동의 안내(Expo 전용, 인벤토리 E3)
- 화면·상태: 상황 변경 열림 — 동의 안 정함 / 허용 안 함 / 허용
- 스크린샷: `shots/G3/62-sit-consent-unknown.pair.png`, `62-sit-consent-declined.pair.png`, `08-sit-open.pair.png`(허용: 한 줄 안내)
- 웹(기준): 동의 개념 없음 — 입력 칸이 늘 켜져 있다(`ActiveJourneyCard.tsx:228`).
- Expo(현재) `features/aiConsent/AiConsentNotice.tsx:16-66`
  - 안 정함: 금 테두리 상자(제목·본문·[허용 안 함][허용]) + 입력 비활성.
  - 허용 안 함: 회색 상자 + '설정에서 바꾸기' + 입력 비활성.
  - 허용: ✨ 한 줄 안내.
- 차이: 웹에 없는 상자·안내 줄, 동의 전 입력 불가.
- 중요도: P1
- 분류: 추가
- 고칠 방법: 결정한다.
  - (가, 권장) 유지. 앱 심사·처리방침(외부 AI 전송 동의, 계획 §8.2)에 묶인 의도된 차이다. 허용 상태의 한 줄 안내만 웹과 시각 차이로 남는다.
  - (나) 웹과 같게 제거 — 앱 처리방침·설정의 철회 줄과 함께 바꿔야 해서 비권장.
  - (다) 반대로 웹에 같은 동의를 넣는다(웹 담당 결정).
- 바꿀 Expo 파일: (가) 없음
- 문구(i18n): `app.aiConsent.*`(현행).
- 네이티브 주의: 없음.
- 확인 방법: 결정 기록.
- 크기: S · 의존: 없음
- 표시: 결정 필요

### G3-31 방문 확인 카드 — 화면 아래(웹) vs 위(Expo), 단계별 구성
- 화면·상태: '도착했어요' → ask → 혼잡 → 평가 → 완료(JRN-02~04)
- 스크린샷: `shots/G3/13-visit-ask.pair.png`, `55z-visit-ask-zoom.pair.png`, `14-visit-congestion.pair.png`, `15-visit-feedback.pair.png`, `16-visit-completed.pair.png`
- 웹(기준) `apps/web/components/main/VisitCheckCard.tsx:142-307`
  - 자리: body 포털 `fixed z-[55] left-1/2 -translate-x-1/2 bottom-[calc(116px+8px)] w-full max-w-sm px-4`. **화면 아래 가운데(탭 막대 위 8px), 추천 카드 위에 겹친다.**
  - 판: `bg-white/95 backdrop-blur-2xl border-line rounded-3xl p-4 shadow-[0_8px_30px_rgba(43,35,32,0.16)]` + 위 2px jade 장식선. X(16) `top-3 right-3`.
  - **단계 점이 맨 위**(`mb-3`, 높이 1.5px, 현재 28·나머지 10).
  - ask 단계
    - 36px 원(`bg-jade/10 border-jade/25`) 안 MapPin 18 + 제목 14px bold.
    - **설명이 제목 바로 아래** 11px.
    - 버튼 `py-2.5 text-xs`: [아직이요(한지 진·먹 연·line)][네, 다녀왔어요(**gold→terracotta** 그라데이션 + 그림자 `0 4px 14px rgba(193,85,59,.25)`)].
  - 혼잡 단계: 제목 + **안내문이 버튼 위** + 3칸(`rounded-2xl border-line bg-hanji-deep px-2 py-2 text-xs`) + '닫기' 글자.
  - 평가 단계: 이름 + 문구 + [👎 별로(한지 진)][👍 좋았어요(**jade/15 · jade 테두리 · jade 글자**)].
  - 완료 단계: 36px jade 원 Check(스프링 회전) + 제목·설명 + '내 쿠폰함' **jade 단색** `rounded-2xl py-2.5` + '닫기'.
  - 단계 전환: x 18→0.
- Expo(현재) `VisitCheckCard.tsx:175-255`, 자리 `HomeScreen.tsx:836-866`
  - 자리: **화면 위 칩 줄 아래** overlay. 남은 높이가 78 미만이면 감춘다.
  - 판: `Card rounded-3xl`(line 테두리 · 장식선 없음). X `IconButton md` 오른쪽 위 4px.
  - **단계 점이 맨 아래**(`mt-[12px]`).
  - ask 단계: MapPin 아이콘(원 없음) + 제목 14px → 버튼(`Button` 보조 흰 / 주 **cta 금진→주칠**, 44px 14px) → **설명이 버튼 아래**.
  - 혼잡 단계: 제목 → 3칸(`min-h-[60px]`) → **안내문이 아래** → 닫기.
  - 평가 단계: [👎 보조 흰][👍 **주 CTA 그라데이션**].
  - 완료 단계: '내 쿠폰함' **CTA 그라데이션**.
- 차이
  - 화면 위치가 정반대(아래 ↔ 위).
  - 점·설명·안내문 위치.
  - 버튼 색: 그라데이션 금→주칠·jade ↔ cta.
  - 크기: 32 ↔ 44px, 12 ↔ 14px.
  - 장식선·아이콘 원.
- 중요도: P0
- 분류: 배치 · 색·효과 · 크기·간격
- 고칠 방법
  1. 자리
     - 홈 화면 바닥에서 `bottom: 15 + 8`(탭 막대 위 — 웹 `nav clearance + 8`), 가운데 `maxWidth 384`, 좌우 16, 추천 카드보다 위 층.
     - 진행 카드(위)와 함께 보일 수 있다(웹은 둘 다 띄운다). 방문 확인은 아래, 진행 카드는 위로 나뉘므로 `pickTripOverlay` 의 '한 번에 하나' 규칙은 없앤다.
  2. 판: `bg-white/95 border-line rounded-3xl p-[16px]` + 그림자 `0 8px 30px rgba(43,35,32,0.16)` + 위 2px jade 그라데이션 줄. X 는 `top 12 right 12` 16px.
  3. 단계 점을 맨 위로(`mb-[12px] pr-[32px]`).
  4. ask: 36px 원 + 아이콘 18, 설명은 제목 아래, 버튼은 웹 값(아직이요 한지 진 / 네 `LinearGradient #c19a3e→#c1553b` + 그림자).
  5. 혼잡: 안내문을 제목 아래로.
  6. 평가: 좋았어요 `bg-jade/15 border-jade/40 text-jade`.
  7. 완료: '내 쿠폰함' `bg-jade` 흰 12px.
  8. 단계 전환 x 18→0(`springs.interaction`).
- 바꿀 Expo 파일: `features/recommendation-card/VisitCheckCard.tsx`, `features/home/HomeScreen.tsx`, `features/home/homeModel.ts`(+test)
- 문구(i18n): 재사용 `visit.*` `report.title` `report.footer` `report.quietDesc|moderateDesc|busyDesc` `congestion.*` `mypage.menuCoupons` `common.close`. 새 키 없음.
- 네이티브 주의
  - 추천 카드 위에 겹치므로 카드 버튼 탭과 겹치지 않게 zIndex·`pointerEvents` 를 확인한다.
  - 안전 영역(제스처 막대)은 탭 막대가 이미 처리한다.
- 확인 방법: `04-actions.mjs`(13~16 쌍).
- 크기: M · 의존: G3-01, G3-28

### G3-32 여정 카드 다시 보이기 규칙 — '아직 가는 중'·30분 타이머
- 화면·상태: 진행 카드 '아직 가는 중' 뒤, 수락 30분 경과(코드 비교)
- 스크린샷: 없음(코드)
- 웹(기준)
  - '아직 가는 중' = 화면 상태만 비운다(`ActiveJourneyCard.tsx:198`). 탭 복귀·`nextspot:trip-navigating` 때 다시 뜬다.
  - 방문 확인은 마운트·탭 복귀·도착 이벤트 때만 확인한다. 30분 타이머 없음(`VisitCheckCard.tsx:68-88`).
- Expo(현재)
  - '아직 가는 중' = 그 여정을 실행 내내 숨긴다(`ActiveJourneyCard.tsx:59-61`, `:258` `hiddenTrips`).
  - 방문 확인은 30분이 차는 순간 타이머로 다시 확인한다(`VisitCheckCard.tsx:80-101`). 화면 포커스·AppState 때도 확인.
- 차이: 다시 나타나는 때가 다르다. Expo 쪽이 덜 귀찮고 더 정확하다.
- 중요도: P2
- 분류: 동작
- 고칠 방법: 결정한다.
  - (가, 권장) Expo 유지. 앱은 백그라운드 복귀가 잦아서, 웹 규칙이면 '아직 가는 중'이 계속 되살아난다.
  - (나) 웹과 같게: `hiddenTrips` 를 화면 상태로 바꾸고 타이머를 없앤다.
- 바꿀 Expo 파일: (가) 없음
- 문구(i18n): 변화 없음.
- 네이티브 주의: 없음.
- 확인 방법: 결정 기록.
- 크기: S · 의존: 없음
- 표시: 결정 필요

### G3-33 토스트 체계 — 웹 `/main` 알약(한 칸·3초·화면 아래 350px) vs Expo sonner(쌓임·4초)
- 화면·상태: 바로 갈래요(인사+안내), 쿠폰, 다시 안볼래요, 킵, 자동차, 방문 완료(TST-01·03·04)
- 스크린샷: `shots/G3/06-accept-toast.pair.png`, `56z-accept-toast-zoom.pair.png`, `20-reject-toasts.pair.png`, `57z-reject-toast-zoom.pair.png`, `24-keep-toast.pair.png`, `26-drive-toast.pair.png`, `81-accept-coupon-profile-toasts.pair.png`, `82-accept-toasts-3s.pair.png`, `16-visit-completed.pair.png`
- 웹(기준)
  - `/main` 로컬 **한 칸** `showToast`(`page.tsx:659-670`). 새 메시지가 앞 메시지를 덮고 **3000ms** 뒤 사라진다.
  - 렌더 `page.tsx:5150-5156`
    - 바깥: `fixed bottom-[350px] left-1/2 z-50 max-w-sm px-4 animate-toast`. 아래에서 20px 올라오며 0.25s(`globals.css:714-727`).
    - 안쪽: `bg-muk/90 backdrop-blur-md text-hanji text-xs(12px) px-5 py-3 rounded-full font-medium break-keep w-max max-w-full shadow-[0_2px_14px_rgba(43,35,32,0.14)]`.
  - 측정: 바로 갈래요를 누르면 **'카카오맵에서 도보를 선택해 주세요.' 한 개만** 보인다(인사는 바로 덮인다). 상자 103,454,185,40.
  - 쓰는 곳: 인사·도보/자동차 안내·쿠폰·킵·거절·방문 완료·'혼잡 답 저장 안 함'·화면의 기타 안내(`page.tsx:2353`, `2372-2378`, `2487`, `2567`, VisitCheck `showToast`).
- Expo(현재)
  - 전부 sonner-native(`apps/mobile/components/ui/Toast.tsx:24-47`, G3-34).
  - 바로 갈래요는 **인사 + 안내 두 개가 쌓여** 보인다(`actions.ts:85-93`). 쿠폰·프로필까지 오면 셋이 쌓여 카드 버튼을 가린다(`81`).
  - 4000ms, 탭 막대 위.
- 차이: 모양(어두운 알약 ↔ 밝은 카드), 자리(아래에서 350px ↔ 탭 막대 위), 개수(1 ↔ 2~3), 지속(3 ↔ 4초).
- 중요도: P1
- 분류: 색·효과 · 배치 · 동작
- 고칠 방법
  1. 홈 전용 `useHomeToast()`(한 칸 상태 + 3000ms 타이머)와 `HomeToastPill` 을 홈 화면에 둔다. 웹이 `showToast` 를 쓰는 메시지는 모두 이것으로 옮긴다:
     - `actions.ts` 의 인사·`trip.selectWalking`·`trip.driveBasisHint`·`map.couponIssued`·`map.savedToast`·`map.rejectToast`.
     - `VisitCheckCard` 의 `visit.thanks`·`visit.congestionNotRecorded`.
     - 홈의 기타(`cuisine.noMatch`, `map.outOfRegionStart`, `map.locationFallback`, `map.closingSoon*` 등 — 웹이 `showToast` 인 것만, `page.tsx` 호출 목록은 인벤토리 TST-04).
     - `actions.ts` 는 토스트 함수를 인자로 받게 바꾼다. 저장 화면처럼 홈 밖에서 쓰면 sonner 로.
  2. 알약 값
     - 자리: 화면 아래에서 350px(390×844 기준, 화면 높이 비율이 아니라 고정 px), 가운데, `maxWidth 384`.
     - 바탕 `rgba(43,35,32,0.9)`, 글자 `colors.hanji` 12px medium 가운데, `px 20 py 12`, `rounded-full`, 그림자.
     - 들어올 때 y 20→0·opacity 0→1, 0.25s.
  3. sonner 로 남는 것: 프로필 토스트(`card.profileToast` + 보기), 실험실 힌트(`lab.hint`, `toast.info`), 실시간 새로고침 성공. 웹도 이 셋은 sonner 다(`page.tsx:2394`, `:2588`, `RecommendationCard.tsx:859`).
- 바꿀 Expo 파일: 새 `features/home/HomeToast.tsx`, `features/home/HomeScreen.tsx`, `features/recommendation-card/actions.ts`, `VisitCheckCard.tsx`, `RecommendationCard.tsx`(호출부)
- 문구(i18n): 재사용(위 키들). 새 키 없음.
- 네이티브 주의
  - 350px 는 웹 화면 기준 위치다. 큰 화면(폴드 펼침)에서도 같은 px 로 둔다(웹도 고정).
  - 접근성: 웹 알약은 role 이 없다. 앱은 `accessibilityLiveRegion="polite"` 를 붙여도 화면 차이는 없다.
- 확인 방법: `04-actions.mjs`·`05-reject-keep-drive.mjs` 의 0.5초 쌍 — 웹과 같은 위치에 알약 하나.
- 크기: M · 의존: G3-34

### G3-34 sonner 토스트 모양·자리(전역) — 글꼴·아이콘·행동 버튼·아래 여백·쌓임
- 화면·상태: 프로필 토스트(+보기), 실험실 힌트(+보기), 실시간 새로고침 성공, 그 밖의 앱 전역 sonner 토스트(앱 전체 74곳)
- 스크린샷: `shots/G3/57z-reject-toast-zoom.pair.png`, `81-accept-coupon-profile-toasts.pair.png`, `80-live-refresh-toast.pair.png`
- 웹(기준) `apps/web/components/shell/ThemeToaster.tsx:17-30`(sonner 2.0.7)
  - 아래 가운데, `richColors`. 바탕 hanji·1px line·글자 muk(인라인), `backdrop-blur-md`.
  - 자리: 폰(≤600px)은 sonner 기본 **아래 16px**(`MOBILE_VIEWPORT_OFFSET`) → **탭 막대 위에 겹친다**(측정: 16,770,358,58).
  - 토스트 상자: `padding 16 · radius 8 · 그림자 0 4px 12px rgba(0,0,0,.1) · 13px · gap 6`(`node_modules/sonner/dist/styles.css`).
  - **글꼴은 sonner 기본 `ui-sans-serif, system-ui…`**(측정: 'ui-sans-serif 13px 500'). 앱 글꼴 Freesentation 이 아니다.
  - 아이콘: 기본 `toast()` 는 **없음**. `toast.success/info` 는 아이콘이 있고 색은 muk 로 덮여 검정.
  - 행동 버튼 '보기': **오른쪽 인라인, 24px, 검정(#171717) 바탕·흰 12px·모서리 4**.
  - 4000ms, 3개까지 **겹쳐 쌓인다**(접힌 스택, gap 14).
- Expo(현재) `apps/mobile/components/ui/Toast.tsx:22-47`(sonner-native 0.27)
  - 자리: 탭 막대 위 64px(`TAB_BAR_TOAST_OFFSET`).
  - 바탕 hanji·line·`shadows.surface`. 제목 **Freesentation SemiBold 14px**.
  - 기본 변형이 `info` 라 **모든 토스트에 파란 (i) 아이콘**이 붙는다(`node_modules/sonner-native/src/constants.ts:37`).
  - 행동 버튼: **글자 아래 줄의 44px 금진 바탕 둥근 버튼**.
  - 4000ms. `enableStacking:false` 라 **펼쳐서 세로로 나열**된다.
- 차이
  - 자리: 탭 막대에 겹침 ↔ 위.
  - 글꼴: 시스템 ↔ Freesentation.
  - 아이콘: 기본 없음 ↔ 늘 있음.
  - 행동 버튼: 작은 검정 인라인 ↔ 큰 금색 아래 줄.
  - 쌓임: 접힘 ↔ 나열.
- 중요도: P1
- 분류: 색·효과 · 글꼴 · 아이콘·이미지 · 배치
- 고칠 방법
  1. `AppToaster`
     - `offset = 16 + insets.bottom`(웹 폰 여백). 탭 막대와 겹침을 받아들일지는 결정(아래).
     - `enableStacking` true(웹 접힌 스택).
     - `toastOptions.style` 에 `borderRadius: 8, padding: 16, boxShadow: '0px 4px 12px rgba(0,0,0,0.1)'`, `titleStyle.fontSize 13`(글꼴은 결정).
     - 기본 변형 아이콘 끄기: 호출부를 `toast()` → `toast(msg, { icon: null })` 로 하거나, `Toaster icons={{ info: null }}` 로 끈 뒤 `toast.info` 를 쓰는 곳만 아이콘을 넘긴다.
  2. 행동 버튼
     - `actionButtonStyle: { minHeight: 24, height: 24, paddingHorizontal: 8, borderRadius: 4, backgroundColor: '#171717' }`, 글자 12px medium 흰색.
     - 같은 줄 오른쪽에 둔다. sonner-native 의 `action` 배치가 아래 줄이면 `toast.custom` 으로 웹 레이아웃을 그린다.
  3. 지속 4000(같음).
- 바꿀 Expo 파일: `components/ui/Toast.tsx`, (아이콘 정책에 따라) `toast(` 호출부
- 문구(i18n): 변화 없음.
- 네이티브 주의
  - Android 에서 탭 막대 위 16px 에 겹치면 탭이 가려진다(웹도 같음).
  - 시스템 글꼴을 따르면 Android 는 기기 글꼴(삼성 원 UI 등)로 바뀐다.
- 확인 방법: `12-toasts.mjs` 쌍 — 위치·크기·버튼.
- 크기: S · 의존: 없음(전역 — 다른 묶음 화면 토스트도 함께 바뀐다)
- 표시: 결정 필요
  - ① 글꼴: 웹은 sonner 기본 시스템 글꼴이라 앱 글꼴과 어긋난다 — **웹 버그로 보인다**. 권장: 웹 `ThemeToaster` 에 `toastOptions.className:'font-sans'` 를 더하고, Expo 는 Freesentation 13px 유지.
  - ② 자리: 웹처럼 탭 막대에 겹칠지. 권장: 웹을 고쳐 막대 위로(`mobileOffset={{ bottom: 'calc(var(--tourist-nav-clearance) + 8px)' }}`), Expo 는 지금 자리 유지.

### G3-35 사장님 사진 메뉴(⋯)·신고·숨기기 — Expo 전용(인벤토리 E4)
- 화면·상태: 사장님 사진이 있는 장소(가로챈 `features.merchant_photo.path`) — 사진 오른쪽 위 ⋯ → [사진 신고][이 사진 숨기기]
- 스크린샷: `shots/G3/41-measured-photo-menu.pair.png`
- 웹(기준): 메뉴 없음. 사장님 사진도 그냥 첫 사진이다(`RecommendationCard.tsx:915-925`).
- Expo(현재) `CardPhoto.tsx:119-153`
  - 로드된 사장님 사진에만 ⋯ `IconButton`(흰 90% 원).
  - 누르면 사진 아래 두 버튼(신고 terracotta·숨기기 회색, 44px).
  - 신고는 `Alert`(웹 빌드는 `window.confirm`) 뒤 `inquiries` insert. 숨기기는 `nextspot_hidden_photos`(`photoSafety.ts`).
- 차이: 웹에 없는 버튼·동작.
- 중요도: P1
- 분류: 추가
- 고칠 방법: 결정한다.
  - (가, 권장) 유지. Play 정책(사용자 생성 콘텐츠 신고·차단) 대응이라 웹과 다른 의도된 차이로 기록한다. 모양(⋯ 원 `bg-white/90`, 버튼 `rounded-2xl border-line`)은 지금대로.
  - (나) 웹에도 같은 메뉴를 넣는다(웹 담당).
  - (다) 제거 — 정책 위험.
- 바꿀 Expo 파일: (가) 없음
- 문구(i18n): `app.cardSheet.photoMenu|photoReport|photoHide|photoReportTitle|photoReportBody|photoReportSend|photoReported|photoReportFailed|photoHidden`(현행).
- 네이티브 주의: 신고 확인은 네이티브 Alert 다(웹 빌드는 `window.confirm` 이라 스크린샷에 안 잡힌다).
- 확인 방법: 결정 기록.
- 크기: S · 의존: G3-08
- 표시: 결정 필요

---

## 촬영 못 한 상태 · 코드로만 비교한 것
- **Expo 혼잡 제보 모달·결과 토스트**: Expo web 에서 `ModalSheet` 가 열리지 않는다(G3-21·22).
- **웹 '다른 곳 제안' 상자**: 웹은 후보가 바닥나도 화면 안 SPOT 미러로 다음 카드를 띄워서 이번 데이터로는 안 뜬다(G3-27).
- **늦은 밤 '늦은 시간 · 출발 전 영업 확인'(`likely_closed_unknown`)·'도착 시 휴무 확인'**: 시계 고정이 필요해 찍지 않았다. 두 앱 모두 `@/lib/restDate` 같은 함수(`cardModel.ts:249-252`)라 판정은 같고, 칩 자리는 G3-11 과 같다.
- **Wikimedia·경주시 사진 출처 줄**: fixture 에 해당 사진이 없다(G3-08). 코드상 같은 문구·같은 판정.
- **상황 변경 해석 성공(LLM) · 재추천 0건/시간 초과/오류**: LLM 을 막은 채라 '해석 실패' 판만 찍었다. 문구·예산(3초)·`replanOutcome` 공유는 같고 모양 차이는 G3-29 와 같다.
- **코드로만 비교(같은 문구·같은 규칙)**: 영업 확인 질문의 저장 실패·403 경로, 프로필 토스트 '보기' 이동, 혼잡 제보 보상 배지('🎯 n/3', '🎟️ +1'), 방문 확인 '혼잡 답 저장 안 함' 문장.
- **사진 신고 확인창**: Expo web 은 `window.confirm` 이라 스크린샷에 안 잡힌다(G3-35).
- **Expo 시트의 오류·빈 판**: 홈에서 도달 불가(`sheetModel.ts:70-72`, G3-26).

## 열린 질문
- 웹 실제 폰에서 전체 카드 스크롤 영역 안 손가락 끌기가 '스크롤'인지 '카드 끌기'인지(framer `drag="y"` + 안쪽 `overflow-y-auto`) 모른다. CDP 터치로는 카드 끌기였다. Expo 제스처 우선순위(G3-01)를 정하려면 실기기 Chrome 확인이 필요하다.
- Expo `ModalSheet` 미표시가 웹 판 전용인지 — Android 개발 빌드에서 '혼잡 제보'·'필터·편의'로 확인.
- G2 가 탭 막대를 웹 높이(약 101px, 가이드 줄 포함)로 바꾸는지. 카드 아래 여백 15px·최대 높이 568 계산이 그 높이에 걸린다.
- 웹 진행 카드 `top-24` 가 검색창 아래 절반·칩 줄을 덮는 것이 의도인지(웹 기준이라 그대로 옮긴다고 적었다).
- 결정 대기: G3-04(음성 알약) · G3-18(골든타임 알림) · G3-23(수락 뒤 흐름) · G3-26(실패 폴백) · G3-30(AI 동의) · G3-32(다시 보이기 규칙) · G3-34(토스트 글꼴·자리) · G3-35(사진 신고).

## 다른 묶음에 넘길 것
- **G2**
  - 탭 막대 높이·바탕: 카드 아래 여백 15px 와 최대 높이 계산이 걸린다. 웹 막대 top 743, 높이 101.
  - Expo web `ModalSheet`(필터·편의·그룹 핀·지금 한산)가 열리지 않는 같은 원인 — G3-21 해법(`ModalSheet.web.tsx`)을 공유.
  - 혼잡 예측 줄은 웹에서 카드가 미리보기일 때만 카드 바로 위에 뜬다(`page.tsx:3962`). 카드 상태를 G2 에 넘겨야 한다.
  - 웹 진행 카드(`top-24`)가 검색창을 덮는 겹침 — 상단 영역 배치 판단.
- **G4**
  - 저장 화면 상세는 같은 카드(`compactPeek=false`, 딤 배경, 킵·자동차 없음)로. G3-01 새 컴포넌트에 맞춰 `features/saved/sheetSlot.tsx` 를 정리한다.
  - 킵 저장값 `spot.score` 가 0~1 원값이다(`actionsCore.ts:95`). 저장 목록 SPOT 표시를 확인한다(G3-03 함수 공유).
- **G4·G5**: 사진 없는 표지(경주 문양) 공용 컴포넌트(G3-08) — 대안·대기 화면도 같은 차이.
- **웹 담당**
  - `lib/navigation.ts` 의 `noopener` 때문에 앱 탭까지 카카오맵으로 넘어가는 버그, 수락 직후 진행 카드가 안 뜨는 것(G3-23).
  - sonner 토스트가 앱 글꼴이 아닌 시스템 글꼴로 그려지고 탭 막대와 겹치는 것(G3-34).
