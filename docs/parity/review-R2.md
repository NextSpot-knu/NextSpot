# 검토 R2 — G3·G4a·G4b

- 기준은 `D:\NextSpot` `yunseong` `c6374ab` 이고, 웹이 정답이다. 저장소·fixture·overlay 는 고치지 않았고 브라우저도 열지 않았다. 판정은 기존 `shots/G3|G4a|G4b` 쌍과 코드로 했다.
- G3 은 직접 확인했다. P0 8건은 전부, P1 26건 중 23건을 코드와 대조했고, 쌍 스크린샷 14장을 봤다.
- G4a·G4b 는 하위 에이전트 2개가 코드·쌍을 대조했다. 결론을 바꾸는 주장은 내가 코드로 다시 확인했다. 확인한 것은 다음과 같다.
  - sonner-native action 이 토스트를 닫지 않는 점
  - `useAlternatives` 의 TDZ
  - `cn` 에 병합이 없는 점
  - Card 기본 그림자
  - react-native-maps 의 터치 가로채기
  - 코스 지도 확대 차이(쌍)
  - 금색 대비 계산
- 공통 전제는 HANDOVER 313행이다. "일부러 다르게 만든 곳은 없다 — 11-09 추천 시트·여정 카드도 웹과 다르면 웹에 맞춘다. 지도 바탕 타일만 예외."

## 1. 빠진 차이 (새 항목)

### G3-R01 직접 고른 곳(추천 목록 밖) 카드의 도보 시간·도착 시각이 거리와 상관없이 '1분'
- 화면·상태
  - 홈에서 추천 목록(최대 5곳) 밖의 핀·검색 결과로 연 카드(직접 고른 곳)
  - 추천 실패 폴백 카드(G3-26)
- 스크린샷: `shots/G3/47-recs-error-peek.pair.png`
  - 같은 호랑이카츠(서버 거리 157m)인데 웹은 '지금 도보 2분이면 …'·'14:27 출발 → 14:29 도착', Expo 는 '지금 도보 1분이면 …'·'14:27 → 14:28' 이다.
- 웹(기준)
  - 직접 고른 시설은 `selectedFacility.spot || calculateSPOT(selectedFacility)` 를 쓴다(`apps/web/app/main/page.tsx:4777`, `:1471-1486` → `scoreFacility`).
  - 그래서 기준점(`rankingOriginRef.current ?? userLocation`)에서의 거리로 도보 분을 만든다. 식은 직선 × 1.18 ÷ 66.67 이다(`apps/web/lib/recommender.ts:330-335`).
  - 서버 항목도 `travelTime` 이 없으면 `estimateWalkingMinutes(rec.distanceM)` 이다(`recommender.ts:579-581`).
- Expo(현재)
  - `buildSelectedCandidate`(`apps/mobile/features/home/sheetModel.ts:55-65`)는 목록 밖이면 `{ facility, userPicked: true }` 만 돌려준다.
  - 그러면 `cardModel.ts:195` 의 `expectedTravel = b?.travelTime` 이 비고, `cardTimes.ts:14-16` 의 `displayWalkMinutes(undefined)` 가 1 을 낸다.
  - 결과적으로 가치 문장·출발→도착·근거 타일·SPOT 설명의 도보 분이 전부 1 이다.
- 차이: 1km 떨어진 곳도 '지금 도보 1분이면 …'으로 안내한다.
- 중요도: P0
  - 카드에서 가장 큰 문장과 도착 시각이 틀린 값이다(G3-03 과 같은 값 오류).
  - 핀을 눌러 여는 흔한 경로다.
- 분류: 상태(값 오류)
- 고칠 방법
  1. `cardModel.ts:195` 를 웹 `recToSpot` 규칙으로 바꾼다.
     - `const expectedTravel = typeof b?.travelTime === 'number' ? b.travelTime : typeof c.distanceM === 'number' ? estimateWalkingMinutes(c.distanceM) : undefined;`
     - `estimateWalkingMinutes` 는 이미 있는 웹 복사본 `~/features/explore/port/walking`(순수 TS)이다.
  2. `buildSelectedCandidate(facility, kind, visibleRecs, origin: { lat: number; lng: number })` 로 인자를 늘린다.
     - rec 이 없으면 `{ facility: place, userPicked: true, distanceM: haversineMeters(origin.lat, origin.lng, facility.latitude, facility.longitude) }` 를 돌려준다.
     - `@/lib/map/geo` 는 `homeModel.ts:7` 이 이미 import 한다.
     - 검색으로 고른(forced) rec 은 지금처럼 rec 을 그대로 쓴다.
  3. `HomeScreen.tsx:560` 호출부에 `userPoint` 를 넘기고, useMemo deps 에 `userPoint.lat`·`userPoint.lng` 를 넣는다.
  4. 테스트를 더한다.
     - `sheetModel.test.ts`: 목록 밖이면 distanceM 이 채워진다.
     - `cardModel.test.ts`: distanceM 850, travelTime 없음 → 도보 16분.
  5. 결정 필요(SPOT 표시)
     - 웹은 직접 고른 곳에도 화면 안 미러 SPOT('SPOT 59점')을 붙이고, Expo 는 붙이지 않는다.
     - 권장은 Expo 를 그대로 두고 의도된 차이로 기록하는 것이다.
     - 근거는 `apps/web/AGENTS.md:28` 'SPOT 산정은 백엔드 단일 소스 · 클라이언트에서 재구현하지 말 것'이다(G3-26 (가)와 같다).
- 바꿀 Expo 파일
  - `features/recommendation-card/cardModel.ts`(+test)
  - `features/home/sheetModel.ts`(+test)
  - `features/home/HomeScreen.tsx`
- 문구(i18n): 변화 없음
- 네이티브 주의: 없음(순수 계산)
- 확인 방법
  - `work/G3/07-variants.mjs error` 를 다시 돌린다. Expo 도 '도보 2분 · 14:27→14:29' 여야 한다.
  - 먼 핀(대릉갈비 등)을 눌러 두 앱의 분이 같은지 본다.
- 크기·의존: S · G3-26
- 표시: 결정 필요(5번)

### G3-R02 저장 상세용 카드 변형(showCompare 없음)이 없다
- 무엇이 빠졌나: 꼬리표·가치 문장·출발→도착 알약, 자동차 버튼, 사진 없는 곳의 표지, 손잡이 글자 규칙
- 화면·상태
  - 저장 탭에서 카드를 눌러 연 상세(G4-SAV-07)
  - G4a-13 은 틀만 다루고 카드 안은 'G3 소관'으로 넘겼는데, G3 에는 이 변형이 없다.
- 스크린샷: `shots/G4a/sav-07-detail-open.pair.png`(고도 커피 — 사진 없음, 영업 미확인)
- 웹(기준)
  - 저장 화면은 `RecommendationCard` 를 다음 prop 없이 부른다: `showCompare`·`compactPeek`·`showListRank`·`onPutOff`·`onDrive`(`apps/web/app/saved/page.tsx:488-533`). 그래서 `components/RecommendationCard.tsx` 는 이렇게 그린다.
  - 꼬리표 ~ 혼잡 칩
    - 가치 상자가 없다(`:1457`).
    - 음식 문장이 없다: `foodHeadline = showCompare && foodName …`(`:1035`).
    - 미리보기 문장이 없다(`:1134`).
    - 혼잡 칩은 얼굴에 남는다(`valueLineSaysCrowd: showCompare && …`, `:1124`).
  - 출발→도착
    - 혜택 칩 줄 끝의 글자다. 알약이 아니다.
    - 모양: `inline-flex gap-1.5 whitespace-nowrap text-[13px] font-semibold text-muk` + `Clock 14 text-jade`(`:1679-1687`).
  - 사진 띠
    - `(showCompare || cardImageUrls.length > 0)` 일 때만 그린다(`:1512-1513`).
    - 사진 없는 저장 장소에는 표지도 없다.
  - 손잡이
    - 글자 없는 장식 막대 `w-16 h-1.5 bg-muk/15` 이다(aria-hidden).
    - 누르면 미리보기→전체, 전체→상세로 바뀐다(`:1316-1324`).
    - 아래로 끌면 한 줄짜리 판이 된다(`:1432-1441`).
      - 이름: 14px bold, truncate, max-w 200
      - `열기 ▲` 칩: `text-[10px] text-terracotta bg-gold/10 border-gold/25 rounded-full px-2 py-0.5`(`card.open`)
  - 바닥 줄
    - 첫 줄은 [다시 안볼래요][바로 갈래요] 이고 킵이 없다(`:2258-2292`).
    - 둘째 줄은 `onDrive` 가 없으니 왼쪽이 빈 `flex-1`(`:2302`), 오른쪽이 혼잡 제보다.
- Expo(현재): 홈과 같은 판이다.
  - '줄 서는 대신' 꼬리표 + 출발→도착 jade 알약 + 머리 경고 칩 + 값 문장('도보 1분') + 이름 + SPOT 칩(`RecommendationSheet.tsx:414-447`)
  - [바로 갈래요][다시 안볼래요] (`:450-462`)와 킵(`:476-484`)
  - 영업 안내가 없으면 늘 '자동차 길안내'(`:485-493`)
  - 사진은 늘 `CardPhoto` 180px 이고, 사진이 없으면 표지를 그린다(`:543-548`).
- 차이: 저장 상세 첫 화면이 통째로 다르다. G4a 대조에서도 자동차 버튼·버튼 순서를 확인했다.
- 중요도: P1
- 분류: 배치 · 추가 · 누락
- 고칠 방법(G3-01 의 새 `RecommendationCard` 안에서 한다 — 지금 시트는 고치지 않는다)
  1. `CardContext` 에 `showCompare`(G3-12 와 같은 필드)를 넣고 `cardModel.ts` 를 웹처럼 묶는다.
     - `foodHeadline`(`:309-316`) → `ctx.showCompare && foodName ? … : null`
     - `valueLineSaysCrowd`(`:380`) → `ctx.showCompare && …`
     - 새 필드 `peekValueShown = ctx.showCompare && !!peekValueText`
  2. `showCompare=false` 이면 ValueBox 를 그리지 않는다(G3-05 6번).
     - 혜택 칩 줄 끝에 `ArrivalText` 를 붙인다: `<Icon icon={Clock} size={14} color="jade"/>` + `text-[13px] leading-[19.5px]` semibold muk `card.arrivalLine`.
     - 칩이 없어도 출발→도착이 있으면 줄을 그린다.
  3. 사진 띠는 `showCompare || model.photoUrls.length > 0` 일 때만 그린다.
  4. 손잡이와 끌어 내린 판은 G3-01(바로잡은 내용) 7번의 `compactPeek=false` 변형을 쓴다.
  5. 바닥 줄
     - `onPutOff` 가 없으면 킵을 그리지 않는다.
     - `onDrive` 가 없으면 둘째 줄 왼쪽에 `<View className="flex-1"/>` 를 둔다.
     - 순서는 G3-07 을 따른다.
  6. `features/saved/sheetSlot.tsx`
     - `<RecommendationCard compactPeek={false} showCompare={false} showListRank={false} rejectIsRemoval …/>` 로 부른다.
     - `onPutOff`·`onDrive` 는 넘기지 않는다.
  7. `cardModel.test.ts`: showCompare=false + 음식점 메뉴 → `foodHeadline` null, 혼잡 칩이 얼굴에 있다.
- 바꿀 Expo 파일
  - `features/recommendation-card/RecommendationCard.tsx`(G3-01 새 파일)
  - `cardModel.ts`(+test)
  - `features/saved/sheetSlot.tsx`
- 문구(i18n): 재사용 `card.arrivalLine` `card.open` `card.aiRec`. 새 키 없음.
- 네이티브 주의: 없음
- 확인 방법: 저장 5곳을 시드한 뒤 '고도 커피' 상세 쌍을 본다.
  - 사진 띠가 없다.
  - 출발→도착이 칩 줄 글자다.
  - 자동차 버튼이 없다.
  - 버튼이 [다시 안볼래요][바로 갈래요] 순서다.
- 크기·의존: S · G3-01, G3-07, G3-12, G4a-13
- 표시: —

### G4a-R01 앱에서 킵한 북마크의 spot 모양이 웹과 다르다 — 정렬이 깨지고 이미 저장된 행은 'SPOT 1점'
- 화면·상태
  - 저장 목록(SAV-01)과 상세(SAV-07)
  - 대상은 홈에서 '일단 킵'한 장소와 기기 간 동기화된 목록이다.
- 스크린샷: 없음. G4a 시드가 웹 모양(0~100)이라 이 차이가 가려졌다. 코드로 비교했다.
- 웹(기준)
  - 킵은 `lib/recommender` 의 `Spot` 을 그대로 저장한다(`app/main/page.tsx:2476`). `score` 는 0~100 이고(`recommender.ts:583-585`), `timeToService` 가 들어 있다.
  - 정렬은 `saved/page.tsx:98-105` 이다.
- Expo(현재)
  - `bookmarkFrom`(`actionsCore.ts:85-100`)은 `spot: { score: c.spotScore ?? 0, … }` 를 쓴다. score 는 0~1 원값이고 `timeToService` 가 없다.
  - 정렬 `features/saved/savedList.ts:51-58` 도 `timeToService` 끼리 뺀다. 그래서 한쪽에만 값이 있으면 NaN 비교가 된다.
- 차이
  1. 앱 킵과 웹 킵이 섞인 목록이 두 앱에서 모두 틀린 순서다(0.55 가 40 아래, NaN 비교).
  2. Supabase `saved_facilities.data` 에 이미 0~1 로 들어간 행은 웹 저장 상세에서도 'SPOT 1점'이다(`saved/page.tsx:495` → `RecommendationCard.tsx:1353` `Math.round(spotScore)`).
- 중요도: P1
- 분류: 상태(값 오류) · 동작
- 고칠 방법
  1. 쓰기(G3-03 과 같은 PR)
     - `actionsCore.ts:95` 를 `score: spotPoints(c.spotScore)` 로 바꾼다.
     - `timeToService: (c.breakdown?.travelTime ?? 0) + (modelWait ?? 0)` 를 더한다.
  2. 이미 저장된 행 읽기
     - `savedList.ts` 에 `normScore = (s: number) => (s <= 1 ? Math.round(s * 100) : s)` 를 둔다.
     - 이것을 `compareBookmarks`(`:53`), `savedCardInput`(`:166`), `candidateFromBookmark`(`:209`)에서 쓴다.
     - `timeToService` 가 없으면 `expectedTravel + expectedWait` 로 채워서 비교한다.
  3. 웹 담당에 넘긴다: `saved/page.tsx` 의 정렬과 `spotScore` 입력에도 같은 정규화가 필요하다.
  4. `savedList.test.ts` 에 섞인 목록 정렬 케이스를 더한다.
- 바꿀 Expo 파일
  - `features/recommendation-card/actionsCore.ts`(+test)
  - `features/saved/savedList.ts`(+test)
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법
  - 웹 모양 1건과 앱 모양 1건(0.548, timeToService 없음)을 시드한다.
  - 두 앱의 순서가 같은지, 상세가 'SPOT 55점'인지 본다.
- 크기·의존: S · G3-03
- 표시: —

### G4a-R02 저장 히어로 칩·스탯 높이
- 화면·상태: SAV-01 히어로
- 스크린샷: `shots/G4a/sav-01-hero.pair.png`
  - '저장한 장소' 칩: 웹 26.5 ↔ Expo 22
  - '저장 5곳': 웹 37.5 ↔ Expo 34.5
- 웹(기준): `saved/page.tsx:271` 은 11px 에 줄 높이 1.5 상속(16.5), `:283` 은 13px(19.5)
- Expo(현재): `app/(tabs)/saved.tsx:142`·`:154`·`:157` 에 줄 높이가 없다(normal).
- 차이: 칩 4.5px, 스탯 3px 가 낮다. G4a-02 에 빠져 있다.
- 중요도: P2
- 분류: 크기·간격
- 고칠 방법
  - G2-G05(전역 기본 줄 높이 1.5)를 하면 저절로 맞는다.
  - 하지 않으면 `:142` 에 `leading-[16.5px]`, `:154`·`:157` 에 `leading-[19.5px]` 를 넣는다.
- 바꿀 Expo 파일: `app/(tabs)/saved.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 한 줄 칩은 `includeFontPadding:false` 를 함께 확인한다.
- 확인 방법: 칩 26.5, 스탯 37.5
- 크기·의존: S · G2-G05
- 표시: —

### G4a-R03 대안 '추천 근거 자세히' 근거 칩의 바탕·굵기
- 화면·상태: EXP-08
- 스크린샷: `shots/G4a/exp-08-why-open.pair.png`(둘째 칩이 Expo 에서 굵고 흰 바탕)
- 웹(기준) — `explore/recommend/page.tsx`
  - 추정 근거·마지막 관측(`:2055-2057`, `:2066-2076`): `text-[10px] font-medium border-dashed border-line text-muk-soft`, 바탕 없음
  - 준비 중(`:2060-2062`): `font-bold bg-muk/5`
  - 오래됨(`:2079-2082`): `font-medium bg-hanji-deep text-muk-soft/70`
  - 업종 기준선(`:2035-2041`): `font-bold border-dashed border-line bg-white/70`
- Expo(현재): `AlternativeCard.tsx:365-388` 이 전부 `<Tag tone="soft">` 다.
  - `Tag.tsx:43-44` 는 dashed 면 `bg-hanji-deep` 과 `bg-white/70` 를 한 요소에 같이 붙인다. NativeWind 는 뒤에 쓴 클래스가 이기지 않는다.
  - 글자는 늘 bold 다(`:48`).
- 차이: 근거 칩의 바탕과 굵기가 다르다.
- 중요도: P2
- 분류: 색·효과 · 글꼴
- 고칠 방법
  1. `Tag` 에 두 prop 을 둔다.
     - `weight?: 'medium' | 'bold'`(기본 bold)
     - `surface?: 'none' | 'muk5' | 'hanjiDeep' | 'white70'`
  2. 바탕 클래스는 덧붙이지 말고 바꿔 끼운다.
  3. 칩별 조합
     - 추정 근거·마지막 관측: dashed line + none + medium
     - 준비 중: muk5(`rgba(43,35,32,0.05)`) + bold
     - 오래됨: hanjiDeep + `text-muk-soft/70` + medium
     - 기준선: dashed + white70 + bold
  4. G4a-20 의 `dashedEvidence` 는 이 soft 칩에 쓰지 않는다.
- 바꿀 Expo 파일: `features/explore/Tag.tsx`, `AlternativeCard.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 둥근 View 의 dashed 테두리(G4a-20 과 같다)
- 확인 방법: exp-08 확대 비교
- 크기·의존: S · G4a-20
- 표시: —

### G4a-R04 대안 'SPOT 구성' 줄 간격
- 화면·상태: EXP-08·09
- 스크린샷: `shots/G4a/exp-09-minimap.pair.png`(이름표→값 간격 웹 16 ↔ Expo 12)
- 웹(기준): `page.tsx:2186-2205` — 이름표 10px·값 11px 이 줄 높이 1.5 를 상속한다.
- Expo(현재): `AlternativeCard.tsx:472-489` 에 줄 높이가 없다.
- 차이: 간격이 4px 좁다.
- 중요도: P2
- 분류: 크기·간격
- 고칠 방법
  - G2-G05 를 하면 맞는다.
  - 하지 않으면 이름표(`:472`·`:477`·`:483`·`:488`)에 `leading-[15px]`, 값(`:473`·`:478`·`:484`·`:489`)에 `leading-[16.5px]` 를 넣는다.
- 바꿀 Expo 파일: `features/explore/AlternativeCard.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: 간격 16
- 크기·의존: S · G2-G05
- 표시: —

### G4a-R05 '🔄 다른 대안 보기' 위 간격
- 화면·상태: EXP-11
- 스크린샷: `shots/G4a/exp-01-bottom.pair.png`(웹 24 ↔ Expo 20)
- 웹(기준): 버튼을 `div.pt-1` 로 감싼다(`page.tsx:2234`).
- Expo(현재): `features/explore/RecommendScreen.tsx:284-291` 은 감싸지 않는다.
- 차이: 4px
- 중요도: P2
- 분류: 크기·간격
- 고칠 방법: `<View className="pt-[4px]">` 로 감싼다(G4a-21 과 함께).
- 바꿀 Expo 파일: `RecommendScreen.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: 위 간격 24
- 크기·의존: S · G4a-21
- 표시: —

### G4b-R01 1곳 코스에서 지도 확대 수준이 다르다(Expo 가 약 2단계 멀리) — 카메라 경합
- 화면·상태: CRS-02·30 — 1곳 계획(실제 fixture 상태), 공유→일반 전환
- 스크린샷
  - `shots/G4b/plan1-02-map.pair.png`: 웹은 100m 축척에 향화정 주변, Expo 는 시외버스터미널~동궁 범위다.
  - `plan1-01-top`, `plan1-03-mid`, `h06-shared-cta-after` 도 같다.
  - 같은 1곳인 `s41-pinfail` 은 Expo 도 레벨 4 다. 타이밍에 따라 갈린다.
- 웹(기준)
  - 계획이 생긴 뒤에만 지도를 붙인다(`app/course/page.tsx:857-859`).
  - `CourseMap.tsx:64` 에서 레벨 6 으로 만들고, `:184` `setBounds(…,80,40,40,40)`, `:187` `if (getLevel()<4) setLevel(4)`. 둘 다 즉시다.
- Expo(현재)
  - `features/course/components/CourseMapView.tsx:57-68` 은 정류지가 0일 때 `animateTo(user, { level: 6 })` 를 400ms 애니메이션으로 부른다.
  - 정류지가 오면 `fitToCoordinates` 를 부른다.
  - `NextSpotMap.web.tsx:254-261` 의 `applyCamera` 는 `map.getLevel() !== camera.level` 로 분기한다. 확대 애니메이션 중에는 시작 레벨을 돌려주므로 맞춤이 '이동만' 하고, 레벨 6 으로 끝나는 것으로 보인다. 원인은 추정이고 계측하지 않았다.
- 차이: 코스 첫 화면에서 가장 큰 요소(지도)의 범위가 다르다.
- 중요도: P1(기본 상태에서 보인다, 타이밍 의존)
- 분류: 동작 · 배치
- 고칠 방법
  1. `CourseMapView.tsx:61` → `animateTo(user, { level: 6, duration: 0 })`, `:64-67` 옵션에도 `duration: 0`.
     - 두 옵션 형에 `duration` 이 이미 있다(`features/map/types.ts:96-114`).
     - 웹처럼 즉시 움직인다.
  2. 근본 수정은 G2 몫이다. `NextSpotMap.web.tsx:245-262` 에 `targetLevelRef` 를 두고 `getLevel()` 대신 마지막으로 요청한 레벨과 비교한다.
- 바꿀 Expo 파일: `CourseMapView.tsx`, (G2) `features/map/NextSpotMap.web.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 네이티브 `animateToRegion` 은 나중 호출이 앞 애니메이션을 대신하므로 경합이 없다.
- 확인 방법: `work/G4b/cap-default.mjs plan1`, `cap-shared.mjs` 에서 Expo 도 100m 축척인지 본다.
- 크기·의존: S · G2, G4b-20
- 표시: —

### G4b-R02 헤더 제목 자간
- 화면·상태: 코스 헤더 카드(계획·오류·로그인·빈 상태)
- 스크린샷: `shots/G4b/plan3-10-header.pair.png`(제목 폭 웹 156.5 ↔ Expo 163). s10·s20·s30 도 같다.
- 웹(기준): `course/page.tsx:907` `tracking-tight`(22px → −0.55px), `:916`(18px → −0.45px)
- Expo(현재): `app/(tabs)/course.tsx:135`·`:147` 에 자간이 없다.
- 차이: 제목이 6.5px 넓다.
- 중요도: P2
- 분류: 글꼴
- 고칠 방법
  - `:135` 에 `style={{ letterSpacing: -0.55 }}`, `:147` 에 `style={{ letterSpacing: -0.45 }}` 를 준다.
  - RN 자간은 px 다. `tracking-tight`(em)를 그대로 옮기지 않는다.
- 바꿀 Expo 파일: `app/(tabs)/course.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 한글 음수 자간을 실기기에서 확인한다.
- 확인 방법: 제목 폭 156.5
- 크기·의존: S
- 표시: —

### G4b-R03 `rounded-sm` 이 웹 4px ↔ Expo 2px
- 화면·상태: 시간표 범례, 추천 이유 판
- 스크린샷: `shots/G4b/i11-gantt-card.pair.png`(범례 칸이 웹은 둥글고 Expo 는 네모)
- 웹(기준): Tailwind v4 `rounded-sm` = 4px — `page.tsx:1410`·`:1417`(범례), `:1819`(`rounded-r-xl rounded-l-sm`)
- Expo(현재)
  - NativeWind(Tailwind 3.4)의 `rounded-sm` = 2px — `CourseSections.tsx:159`·`:165`
  - `StopRows.tsx:356` 은 왼쪽 둥글기가 없다.
- 차이: 모서리 2px
- 중요도: P2
- 분류: 크기·간격
- 고칠 방법: `CourseSections.tsx:159`·`:165` → `rounded-[4px]`, `StopRows.tsx:356` 에 `rounded-l-[4px]` 를 더한다. 전역 주의는 §3.
- 바꿀 Expo 파일: `CourseSections.tsx`, `StopRows.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: i11 확대
- 크기·의존: S
- 표시: —

### G4b-R04 정류지 행 행동 줄 수치
- 화면·상태: 정류지 행(CRS-02·06)
- 스크린샷: `shots/G4b/plan3-20-row1.pair.png`
- 웹(기준) ↔ Expo(현재)

  | 요소 | 웹 | Expo |
  |---|---|---|
  | 행동 줄 | `page.tsx:1783` `gap-2 mt-2` | `StopRows.tsx:312` `mt-[6px] gap-[6px]` |
  | 추천 이유·더보기 | `:1790`·`:1801` `px-2` | `:232` `px-[10px]` |
  | 길안내 아이콘 | `:1812` 13 | `:347` 14 |
  | 자동차 | `:1838` `px-3` | `:377` `outlineBtn`(`px-[14px]`, `:233`) |
  | 시간 칩 | `:1723` 테두리 없음 | `Pill` 늘 border(`:158`·`:261`) |
  | 출처 줄 | `page.tsx:1053` `leading-relaxed` | `course.tsx:233` 16 |

- 차이: 2~3px 씩 어긋난다.
- 중요도: P2
- 분류: 크기·간격
- 고칠 방법
  - `StopRows.tsx:312` → `mt-[8px] flex-row flex-wrap items-center gap-[8px]`
  - `:232` → `px-[8px]`
  - `:347` → `size={13}`
  - `:377` → 전용 클래스 `px-[12px]`
  - `Pill` 에 `bordered?: boolean`(기본 true)을 두고 `:261` 만 false 로 바꿔 끼운다.
  - `course.tsx:233` → `leading-[18px]`
- 바꿀 Expo 파일: `StopRows.tsx`, `app/(tabs)/course.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: plan3-20 재촬영
- 크기·의존: S · G4b-14
- 표시: —

### G4b-R05 재계획 중 흐림이 즉시 바뀐다(웹은 200ms)
- 화면·상태: CRS-12
- 스크린샷: `shots/G4b/i23-dimmed.pair.png`(정지 화면이라 코드로 비교)
- 웹(기준): `page.tsx:985-988` `transition-opacity duration-200`
- Expo(현재): `app/(tabs)/course.tsx:172` `style={{ opacity: loading ? 0.5 : 1 }}`
- 차이: 전환 애니메이션이 없다.
- 중요도: P2
- 분류: 동작
- 고칠 방법
  - `Animated.View` 에 `useAnimatedStyle(() => ({ opacity: withTiming(loading ? 0.5 : 1, { duration: 200 }) }))` 를 쓴다.
  - `pointerEvents`·`accessibilityState` 는 유지한다.
  - `useReduceMotion()` 이면 즉시 바꾼다.
- 바꿀 Expo 파일: `app/(tabs)/course.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음
- 확인 방법: 핀 고정 직후 흐려지는 데 0.2초가 걸리는지 본다.
- 크기·의존: S
- 표시: —

## 2. 바로잡을 것 (기존 항목 정정)

- G3-01: 문제 7가지.
  1. 아래 위치·최대 높이 식이 G2-G01(겹치는 탭 막대, 지도가 화면 끝까지)과 맞지 않는다. 그 뒤에는 `bottom:15` 카드가 막대 뒤로 숨고, 최대 높이도 669 가 된다.
  2. 5번 제스처가 모순이다. ScrollView 를 Pan 감지기 안에 두고 `simultaneousWithExternalGesture` 로 묶으면, 스크롤 영역 안 끌기가 스크롤과 카드 이동을 둘 다 한다.
  3. 9번 삭제 범위가 ModalSheet 쪽을 깨뜨린다.
     - `SheetScrollView` 는 `HomeOverlays.tsx:261`, `ToolChips.tsx:205`·`:321` 이 모달 안에서 쓴다.
     - `Handle`·`SheetBackground`·`background`·`SHEET_ANIMATION`·`CONTAINER_A11Y` 는 `ModalSheet` 가 쓴다.
  4. 흐림이 없으면 Expo web·iOS 에서 95% 흰 판 뒤 글자가 비친다(sav-07 Expo 에서 실제로 보임).
  5. 저장(`compactPeek=false`)의 손잡이와 끌어 내린 판이 빠졌다.
  6. RN ScrollView 는 기본 `flexGrow:1` 이다. 크기 지정이 없으면 카드가 최대 높이까지 늘거나 0 으로 접힌다.
  7. '위에 검색·칩 줄이 남는다'는 틀린 묘사다. 웹 전체 카드는 분류 칩 줄(y≈232)을 덮고, 검색창과 날씨/✨ 줄만 남는다(`02-normal-first`).

  → 바로잡은 고칠 방법 전체:
  0. 순서와 기준값
     - G2-G01 뒤에 한다.
     - 바닥 기준값은 `navClearance = 116 + insets.bottom` 하나다(웹 `calc(var(--tourist-nav-clearance) + env(safe-area-inset-bottom))`, `globals.css:236-238`).
     - 값은 §3 처럼 한 곳에서 내보낸다. G2-G01 전이라면 같은 자리에 15 를 쓴다.
  1. 새 `features/recommendation-card/RecommendationCard.tsx` 를 만든다. props 는 웹 이름을 쓴다.
     - 데이터: `selected` `candidates` `excludedIds`
     - 모드: `compactPeek` `showCompare` `showListRank`(셋 다 홈 true, 저장 false)
     - 행동: `onAccept` `onDrive?` `onReject` `onPutOff?`(지금 `onKeep`) `onSeeInstead?`
     - 내용: `conditions?`/`onRemoveCondition?` `comparisonReason?` `compareAnchor?` `contextBadge?` `rejectIsRemoval?`
     - 틀·이동: `maxHeight` `onPeekChange?`(G2-24) `onViewProfile` `onViewLab`
     - 상태·행동 함수는 `RecommendationSheet.tsx:187-397` 에서 옮긴다. `scrollRef` 는 RN `ScrollView` ref 로 바꾼다.
  2. 틀은 두 겹으로 만든다. 안드로이드는 같은 View 의 overflow hidden 이 그림자를 자르기 때문이다.
     - 바깥 `Animated.View`
       - `maxHeight`, `borderRadius:24`, `boxShadow: shadows.surface`
       - 등장: opacity 0·y 18·scale 0.985 → `springs.sheet`
     - 안쪽 `View`
       - `flexShrink:1, borderRadius:24, overflow:'hidden', borderWidth:1, borderColor: colors.line`
       - 바탕: 안드로이드 `#ffffff`, 그 밖 `rgba(255,255,255,0.95)` + 흐림
       - 흐림: 웹 빌드는 `backdropFilter:'blur(40px)'`(react-native-web 이 넘긴다), iOS 는 expo-blur(G2-G03 Glass 와 같은 방식)
       - 패딩: 미리보기 12, 전체 좌우 16·위 8·아래 12. 간격: 4 / 8
       - 맨 위 2px 금 줄: `Gradient colors={['transparent','rgba(193,154,62,0.5)','transparent']}`
     - 안쪽 순서
       - 손잡이
       - 미리보기면 PeekBody
       - 저장 카드를 끌어 내린 상태면 MiniRow: 이름 + '열기 ▲'(웹 `:1432-1441`)
       - 그 밖이면 [스크롤 영역(View `flexShrink:1`) + 가장자리 흐림] + [BottomActions `flexShrink:0`]
     - ScrollView
       - `style={{ flexGrow: 0, flexShrink: 1 }}`
       - 가장자리 흐림(위 20·아래 24, 흰 95%→0, `pointerEvents="none"`)은 더 볼 내용이 있을 때만 그린다(`onScroll`·`onLayout`·`onContentSizeChange`).
  3. 제스처
     - 감지기마다 `makePan()` 으로 Pan 을 따로 만든다(제스처 하나는 감지기 하나에만 붙는다). 붙이는 곳은 손잡이, PeekBody/MiniRow, BottomActions 세 곳이다.
     - 설정
       - `Gesture.Pan().activeOffsetY([-12,12]).failOffsetX([-24,24])`
       - `onUpdate`: `dragY = translationY × sheetElastic`
         - `sheetElastic` 은 `@/lib/sheetSnap` 에서 가져온다. `Sheet.tsx:21` 이 이미 쓰는 순수 모듈이다.
       - `onEnd`: `runOnJS(settle)(dy, vy)`
         - `settle` = `nextSheetState` 로 한 칸 + `haptic('selection')` + `withSpring(0, springs.sheet)`
     - **ScrollView 는 감지기로 감싸지 않는다.** 스크롤 영역 안 끌기는 스크롤만 한다. 웹 실기기에서도 `.rec-scroll` 이 세로 이동을 먼저 갖는다.
     - 선택: 내용이 창보다 짧을 때만 켜지는 네 번째 Pan(`.enabled(contentH <= viewportH + 1)`)을 스크롤 영역 바깥 View 에 붙이면, 웹의 '스크롤할 것이 없을 때 카드 끌기'까지 맞는다.
     - Pan 이 활성되면 Pressable 누름이 취소되므로, 별도 가드는 필요 없다.
  4. 높이
     - 미리보기·전체 모두 내용 높이다.
     - `maxHeight = 홈 높이 − navClearance − insets.top − 160` 이다(웹 빌드 568).
     - 상세는 높이를 바꾸지 않고 ScrollView 안에 덧붙인다.
  5. 자리
     - 홈 아래 스택(`HomeScreen.tsx:788-831`)의 마지막 자식으로 둔다.
     - 스택에 `paddingBottom: navClearance`(지금의 `bottomInset` 대신)와 `paddingLeft/Right: insets + 16` 을 준다(웹 `inset-x-4`).
     - 스켈레톤(G3-25)과 제안 상자(G3-27)도 같은 스택·같은 틀을 쓴다.
  6. 홈 연결
     - 지도 카메라 아래 띠(`HomeScreen.tsx:253`·`:256`)는 아래 스택 높이(onLayout) + 8 로 바꾼다.
     - `tripOverlayRoom`·`sheetCoverHeight` 는 지운다(G3-28·31 바로잡은 내용).
  7. 손잡이
     - compactPeek 이면 버튼이다.
       - 문구 `card.peek.expand|collapse`
       - 막대 `h-[6px] w-[64px] rounded-full bg-muk/20` + 11px bold gold-deep
       - `accessibilityState={{expanded}}`, 높이 24 이상, 가운데 정렬
     - 아니면 장식 막대 `bg-muk/15` 다(읽기 숨김, 누르면 토글, 웹 `:1316-1324`).
  8. 새 장소와 뒤로 가기
     - id 가 바뀌면 상태를 초기화하고 `scrollTo({y:0})` 한다. compactPeek 이면 미리보기로 돌린다.
     - 안드로이드 뒤로 가기는 홈 포커스 동안 `BackHandler` 로 받는다. 전체·상세면 미리보기로 접고 `true` 를 돌려준다.
  9. 지우는 것과 남기는 것
     - 지운다: `Sheet`·`SheetWatch`·`useSheetScrollTopLock`·`SHEET_HANDLE_HEIGHT`·`ORDER`·`DEFAULT_SNAPS`·`BELOW_TOP_INDEX`, `sheetPeek.ts`(+test), `sheetModel.ts` 의 `sheetCoverHeight`·`mapBottomInset`(+test)
     - 남긴다: `ModalSheet`·`Handle`·`SheetBackground`·`background`·`SHEET_ANIMATION`·`CONTAINER_A11Y`·`SheetScrollView`/`SheetView` 재수출·`SheetState` 타입
     - 키 `app.cardSheet.handle`·`state.*` 는 통합 때 4로케일에서 함께 지운다.
  10. 네이티브 주의: 구글 지도 로고가 막대·카드 밑에 숨으면 약관 위반이다. `NextSpotMap` 에 `mapPadding` 을 연다(§3).
  11. 확인 방법(추가): Android 에서 다음을 본다.
      - 스크롤 영역 안 끌기는 스크롤만 한다.
      - 손잡이·버튼 줄 끌기는 한 칸씩 움직인다.
      - TalkBack 이 '버튼, 펼쳐짐'으로 읽는다.

- G3-02: 값 문장 줄 수는 `line-clamp-2 short:line-clamp-1` 이다(`RecommendationCard.tsx:1335`; `short` = 높이 < 720px, `globals.css:5`).
  → `numberOfLines={model.foodHeadline ? undefined : windowHeight < 720 ? 1 : 2}`

- G3-03(보완): 내용은 맞다. 서버는 0~1 이다(`apps/api/app/services/spot/score.py:302-303`).
  - `spotPoints` 는 `lib/core/spotPoints.ts` 에 둔다.
  - `AlternativeCard.tsx:137`, `ComparisonSection.tsx:138`, `StopRows.tsx:365` 도 같은 함수를 쓴다.
  - 저장 행과 정렬은 G4a-R01 이 다룬다.

- G3-05(보완): 웹 가치 상자 셋째 줄에는 `✨ contextBadge` 도 있다(`:1494-1498`, `page.tsx:4801` — 경주 테마가 켜졌을 때).
  → G2-14 를 이식하면 `rounded-full border border-jade/40 bg-jade/10 px-[8px] py-[2px] text-[11px] font-bold text-jade` 칩을 넣는다.

- G3-07(보완): 3번에서 영업 안내도 `onDrive` 도 없으면(저장) 둘째 줄 왼쪽은 빈 `flex-1` 이다(`:2302`).

- G3-08: 네이티브 주의가 틀렸다.
  1. react-native-svg 15.15.4 는 `vectorEffect="non-scaling-stroke"` 를 지원한다(`RenderableView.java:514`, iOS `RNSVGVectorEffect`).
  2. '112px 라 굵기 보정 불필요'도 틀렸다. `slice` 는 큰 배율로 늘리므로 358×112 판에서는 3.58배가 되어 1.4 가 화면 5px 가 된다.
  → 웹 그대로 쓴다: `strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity={0.5}`.
  → 바탕의 방사형·160° 그라데이션은 viewBox 없는 별도 Svg 에 그린다. 경로는 §3 을 따른다.

- G3-13: `estimateById` 는 `Record<string, unknown>` 이다(`useFacilities.ts:50`).
  → 웹처럼 `(estimateById[id] as CongestionEstimate | undefined) ?? rec.congestionEstimate ?? null` 로 쓴다(웹 `page.tsx:4885-4889`). 목록 밖 장소에도 같게 한다.

- G3-17: 5번 토큰 값이 v3 hex 다. 웹은 Tailwind v4 이고, 실제 sRGB 값은 다음과 같다(G4a-24 실측과 같다).
  - sky-500 #00a6f4 · 700 #0069a8 · 800 #00598a · 900 #024a70
  - indigo-500 #615fff · 700 #432dd7 · 900 #312c85
  → §3 의 토큰 한 벌을 쓴다.

- G3-20: 트리거 보이는 높이 34 는 카드의 기본값으로만 둔다. 대안 화면은 웹이 `className="min-h-11"` 을 넘긴다(`explore/recommend/page.tsx:1932`).
  → `CongestionReportButton` 에 `className` 을 받는다. 높이 클래스는 덧붙이지 말고 바꿔 끼운다. G4a-22 가 `min-h-[44px]` 를 넘긴다.

- G3-21: `ModalSheet` 가 `Sheet.tsx` 안에 있어서, `ModalSheet.web.tsx` 만 새로 만들면 아무것도 바뀌지 않는다. 모달 안 `SheetScrollView`(gorhom)는 시트 밖에서 던진다(`@gorhom/bottom-sheet/src/hooks/useBottomSheetInternal.ts:21`). 모양 변경을 공용 기본값에 넣으면 필터 시트(G2-27)까지 바뀐다.
  → 바로잡은 고칠 방법:
  1. G2-G07 1번을 먼저 한다. 웹 빌드에서 `enableDynamicSizing={false}` + 고정 `snapPoints` 로 열리는지 본다. 열리면 3번만 한다.
  2. 안 열리면 파일을 나눈다.
     - `components/ui/ModalSheet.tsx`: 지금 `Sheet.tsx:285-393`(gorhom)을 옮긴다.
     - `ModalSheet.web.tsx`: RN `Modal transparent animationType="fade" onRequestClose` + 바탕 `Pressable`(`rgba(43,35,32,0.40)` + `backdropFilter:'blur(4px)'`) + 아래 정렬 판(maxWidth 384) + Esc 닫기
     - 같이 쓰는 부품은 `components/ui/sheetParts.tsx` 로 옮긴다.
     - `components/ui/sheetScroll.ts` 는 gorhom 을 다시 내보내고, `sheetScroll.web.ts` 는 RN `ScrollView`·`View` 를 다시 내보낸다.
     - `index.ts` 는 `./ModalSheet`·`./sheetScroll` 에서 내보낸다.
  3. 모양은 선택 prop 으로만 바꾼다.
     - prop: `surface?: 'white' | 'hanji'`, `padding?`, `closeButton?`, `accentLine?`. 기본값은 지금 모양이다.
     - 혼잡 제보만 켠다: hanji · 24 · X(`common.close`) · 위 3px 금 줄 · 그림자 `0 -8px 40px rgba(43,35,32,0.2)` · 옵션 `py-[16px]` 간격 10.
  4. 확인: 웹 빌드에서 제보·필터·축제·화장실 시트가 열리고 목록이 스크롤되는지, Android gorhom 판이 그대로인지 본다.

- G3-22: 두 방법 모두 웹 자리(아래 96px)를 못 만든다. `toast.custom` 은 전역 Toaster 자리에 뜨고, 버튼 안 절대 배치 뷰는 카드 overflow·스크롤 안에서 잘린다.
  → `AppToaster` 옆에 이름 붙은 Toaster 를 하나 더 둔다: `<Toaster id="report" position="bottom-center" offset={96 + insets.bottom} visibleToasts={1} />`(sonner-native 0.27 `id`/`toasterId` 채널).
  → 제보 버튼은 `toast.custom(<ReportToast kind text/>, { toasterId: 'report', duration: 3200 })` 로 띄운다.
  → `ReportToast` 모양
    - `rounded-2xl px-[16px] py-[12px]`
    - 바탕 jade/terracotta, 흰 14px bold 가운데
    - 그림자 `0 8px 30px rgba(43,35,32,0.18)`
    - `accessibilityLiveRegion="polite"`
  → 기본 바탕이 겹치면 그 Toaster 에 `toastOptions={{unstyled:true}}` 를 준다.

- G3-23 ↔ G4b-25: 같은 웹 버그(`apps/web/lib/navigation.ts:17-30`)를 G3 은 P1, G4b 는 P0 로 따로 적었다.
  → 웹 작업 한 건으로 합친다. Expo 는 바꿀 것이 없다.
  → 영향 받는 곳
    - `/main`: `page.tsx:2376`·`:2379`·`:4685`(주차장)
    - `/explore/recommend`: `:993`·`:996`
    - `/course`: `:1683`·`:1686`
  → e2e 스텁(`card-facts.spec.ts:195`, `journey-loop.spec.ts:89` 외)이 `window` 를 돌려줘 버그를 가렸으니 스텁도 함께 고친다.
  → `noreferrer` 를 빼면 카카오가 Referer 를 받는다는 점을 기록한다.
  → 진행 카드 즉시 표시는 G3-23 의 웹 2번이다.

- G3-24: 휴무 건너뛰기는 거절 경로에만 해당한다. 웹 킵(`page.tsx:2418-2423`)은 휴무를 거르지 않는다. 그런데 지금 `nextAfter()`(`RecommendationSheet.tsx:290-293`)를 거절·킵이 같이 쓴다.
  → `nextCandidateAfter(…, opts?: { skipClosedToday?: boolean })` 로 바꾸고, `doReject` 만 `true` 로 부른다.
  → `doKeep` 은 지금 규칙 그대로 쓰고, `null` 이면 첫 후보(지금 장소 포함)로 되돈다.

- G3-28: `top: 96` → `top: insets.top + 96`, `maxHeight: 창 높이 − insets.top − 112`. Expo 홈은 상태 표시줄 밑부터 그리고 위 줄이 `insets.top + 8` 에서 시작하기 때문이다(`HomeScreen.tsx:651`).

- G3-31: `bottom: 15 + 8` → `bottom: navClearance + 8`(웹 `VisitCheckCard.tsx:150`). 그라데이션은 있는 토큰 `<Gradient name="goldTerracotta"/>`(`tokens.ts:94`)을 쓴다.

- G3-33: G2-G09 와 같은 새 파일을 따로 만든다. 하나로 합친다(§3). `bottom:350` 은 홈 루트가 화면 끝까지일 때(G2-G01 뒤)의 값이다.

- G3-34: G2-G01 뒤에는 `TAB_BAR_TOAST_OFFSET`(`Toast.tsx:22`, 56+8)이 막대 안에 토스트를 띄운다. 결정 ②와 상관없이 바꿔야 한다(§3).

- G4a-01: 3번 → 새 ScrollView 에 `contentContainerStyle={{ flexGrow:1, paddingHorizontal:24, paddingTop:24, paddingBottom: navClearance }}` 를 준다.
  - `flexGrow` 는 빈 상태 `flex-1 justify-center`(`saved.tsx:128`)를 지키기 위해서다.
  - 아래 여백은 웹 `saved/page.tsx:227` 이고, '최소 24'가 아니다.
  - 머리는 `<View accessible accessibilityRole="header" accessibilityLabel={t('common.appName')}>` 로 감싼다.
  - G4a-13 베일이 로고도 덮도록 화면 루트에 그린다.

- G4a-03: 웹 `animate-ping` 2s 는 키프레임이 75% 에서 끝난다.
  → 1.5초 동안 scale 1→2·opacity 0.6→0(`Easing.bezier(0,0,0.2,1)`) 후 0.5초 멈추기를 반복한다. 파일은 §3 을 따른다.

- G4a-05: Chip 공용 사용처가 많다.
  → 덧붙이지 말고 §3 의 `variant="savedFilter"` 묶음으로 한다.

- G4a-06: 예약은 `trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date }` 로 하고, 안드로이드 채널을 먼저 만든다(미설치라 미확인). 결정은 §3 알림에서 한 번에 한다.

- G4a-07: 5번 `pr-[52px]` 는 틀렸다.
  → `SavedCard.tsx:79` 의 `pr-[48px]` 를 유지한다(웹은 삭제 44 + 4).

- G4a-08: '폭 0 앵커'로 두면 알약 글자가 0 폭으로 재져서 두 줄이 된다.
  → `{ position:'absolute', top:-10, left:'25%'|'50%'|'75%', width:120, marginLeft:-60, alignItems:'center', zIndex:10 }` + `pointerEvents="none"`

- G4a-11 / G4a-27: `color` prop 은 필요 없다. `Skeleton.tsx:44` 가 `style` 을 마지막에 붙인다.
  → `style={{ backgroundColor:'rgba(241,231,211,0.6)' }}` 로 충분하다. opacity 는 주지 않는다.

- G4a-12: sonner-native 0.27 은 웹 sonner 와 세 가지가 다르다.
  - action 을 눌러도 닫히지 않는다(`src/toast-content.tsx:148-151`). cancel 만 닫는다(`:83-88`).
  - 버튼 순서가 action → cancel 이다.
  - 기본 `toast()` 에 info 아이콘이 붙는다.
  → 바로잡은 호출:
    `toast(t('saved.clearConfirm'), { id:'saved-clear-confirm', description:t('saved.clearConfirmDesc'), duration:8000, styles:{ buttons:{ flexDirection:'row-reverse', justifyContent:'flex-start' } }, action:{ label:t('saved.clearAction'), onClick:() => { toast.dismiss('saved-clear-confirm'); genRef.current += 1; setBookmarks([]); setSelected(null); void clearSavedAll(); haptic('success'); toast.success(t('saved.clearedSuccess')); } }, cancel:{ label:t('common.cancel'), onClick:() => {} } })`
  → `Alert` import(`saved.tsx:7`)를 지운다. 공용 함수는 §3 을 따른다.

- G4a-13: 2~4번이 G3-01 과 충돌한다.
  → `presentation`·`rankMode` 를 만들지 않는다. `sheetSlot.tsx` 가 북마크가 열렸을 때 다음을 그린다.
  1. 베일: `<Pressable accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={onClose} style={[StyleSheet.absoluteFill,{backgroundColor:'rgba(239,231,216,0.4)'}]}/>`
     - 웹 빌드는 `blur(2px)` 를 더한다.
     - 화면 루트에 둔다.
  2. 도크: `{ position:'absolute', left:0, right:0, bottom: navClearance, alignItems:'center' }`
     - 안쪽: `{ width:'100%', maxWidth:400, paddingHorizontal:16, maxHeight: 창높이 − navClearance − 80 }`
  3. 카드: `RecommendationCard`(G3-R02 6번)
     - 킵·자동차가 없다.
     - 배지는 웹 `:1154-1156` 규칙으로 'AI 추천'이 된다.
  → 숫자 정정
    - bottom 은 '탭막대+8'이 아니라 116(+insets)이다.
    - 둥글기 24 는 카드 자신의 값이다.
    - 높이 상한은 카드의 H−116−160 이 실제로 걸리므로, 바깥 ScrollView 를 두지 않는다.
  → 안드로이드 `BackHandler`, 웹 Esc 로 닫는다.

- G4a-15
  - 1번에 `{stackOptions}`(`RecommendScreen.tsx:138`·`:148`)와, 쓰지 않게 되는 `Stack`·`IconButton` import 삭제를 더한다.
  - G2-G02 뒤에는 `_layout.tsx:90` 이 사라지므로 `_layout` 수정이 필요 없다.
  - 아래 여백은 `navClearance + 16` 이다(웹 `:1492`·`:1498`).
  - 하드웨어 '뒤로'로 이전 화면에 가려면 `backBehavior="history"` 가 필요하다(§3).

- G4a-16: 형제 Text 는 크기·색을 따로 받아야 한다(Text 기본은 16px muk).
  → `<Text className={`text-[13px] leading-[19.5px] opacity-80 ${busy?'text-terracotta':'text-jade'}`} weight="semibold">`

- G4a-17: (a)의 마이크 자리가 틀렸다. 웹은 `clearance + safe + 0.75rem` 이다(`page.tsx:2283`, 작성자 실측 668 과 같다).
  → `right:16, bottom: navClearance + 12`

- G4a-19
  - PORTING.md 에 '문양 제외' 줄이 없다(코드 주석뿐). 이식하면 PORTING 행을 새로 적는다.
  - 그라데이션은 viewBox 없는 별도 Svg 에 그린다. 방사형은 `userSpaceOnUse`, r ≈ 0.58·√(W²+H²)/2 이다.
  - round cap/join 을 더한다.
  - vectorEffect 는 지원되므로 네이티브 확인 메모를 지운다.

- G4a-21: 두 Text 에 `text-center`, `accessibilityRole="button"` 을 준다. 숫자 ActivityIndicator 크기는 안드로이드만 지원한다. 위 4px 은 G4a-R05.

- G4a-22: 더할 것
  - `AlternativeCardProps` 에 `onReported`
  - `markReported` 는 `useCallback`(카드가 memo 다)
  - `import type { ReportLevel } from '~/features/recommendation-card/reportCore'`
  - 버튼에 `className="min-h-[44px]"`(G3-20)

- G4a-23: `handleShare`(`useAlternatives.ts:400-420`)가 결과를 return 하고, prop 은 `onShare: (rec) => Promise<ShareOutcome>` 여야 2초 체크를 그릴 수 있다. 언마운트 때 타이머를 정리한다. `Alert` import(`:3`)를 지운다.

- G4a-25: 카카오 핀 29×42 는 확인되지 않았다. 웹 마커 이미지를 먼저 잰다.

- G4a-26: (a)에 열 너비가 없다.
  → 이름표 ≈84 + 장소 3×≈145(합 520, `minWidth:520`)
  → 접힘 버튼은 38px 이다: `leading-[16px]` + hitSlop 3

- G4a-28
  - 3번은 빌드가 깨진다. `reloadKey`(`useAlternatives.ts:144`)가 원래 장소 effect(`:80-109`) 뒤에 선언되어 있어 TDZ(TS2448)가 된다.
    → `useState` 를 `:80` 위로 올린 뒤 deps 에 넣는다.
  - 대비 숫자도 틀렸다. 흰 글자 on #c19a3e 는 2.64:1 이고(3.7 아님), #705819 는 6.8:1 이다. `ErrorState.tsx:27-28` 주석도 틀렸다.
  - 파일은 69줄이다(버튼 `:50-66`).

- G4a-31: `<Stack.Screen name="explore/map" options={{headerShown:false}}/>` 를 더한다. 없으면 Redirect 전에 기본 머리가 깜빡인다. G2-G02 뒤에는 탭 안 숨은 경로로 둔다.

- G4b-01: 문제 4가지.
  - 웹 `:888` 인용에서 `pb-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))]` 가 빠졌다. `paddingBottom:24` 면 겹치는 막대 뒤로 마지막 줄이 숨는다.
  - 시트는 화면 끝까지 차야 한다(`:860`·`:885`).
  - `zIndex:1` 은 실제 지도가 있을 때만 줘야 한다. SDK 실패 판과 첫 로딩 판 위에는 시트가 겹친다.
  - 네이티브 메모가 틀렸다.
  → 바로잡은 1번:
    `<ScrollView ref={scrollRef} style={{flex:1}} contentContainerStyle={{flexGrow:1}}><View style={{height:mapHeight, zIndex: mapLive?1:0}}>{지도·뒤로·공유}</View><View style={{flexGrow:1, marginTop:-24, boxShadow:'0px -8px 30px rgba(43,35,32,0.12)'}} className="rounded-t-3xl bg-white"><View className="mt-[12px] h-[6px] w-[48px] self-center rounded-full bg-line"/><View style={{paddingHorizontal:16, paddingTop:16, paddingBottom:navClearance, gap:20}}>…</View></View></ScrollView>`
    - `mapLive` = 지도가 실제로 그려진 상태
  → 네이티브 주의 정정
    - react-native-maps 안드로이드는 ACTION_DOWN 에서 부모의 가로채기를 막는다(`MapView.java:1628-1630`). 지도에서 시작한 끌기는 지도만 움직이고, 이는 웹과 같다. `nestedScrollEnabled` 메모는 지운다.
    - 시트에 elevation 을 주지 않는다.
    - 지금 배치(`course.tsx:251`)는 구글 로고를 가린다. A 안이 약관상 맞다.
    - B 안의 `mapPadding` 은 아직 prop 이 아니다.
    - G4b-R01 의 `duration:0` 을 함께 넣는다.

- G4b-06: 새 `components/ui/NowChip.tsx` 를 만들면 세 번째 사본이 된다. 이미 `features/waiting/NowChip.tsx` 를 waiting·saved·recommend 가 쓴다.
  → §3 의 한 곳으로 모으고, `course.tsx:35-50` 의 지역 사본을 지운다.

- G4b-08: `Sheet`(지워질 3단 시트)도, 웹 빌드에서 안 열리는 `ModalSheet` 도 쓰지 않는다.
  → 웹 `<select>` 에 맞춰 RN `Modal transparent fade` + 가운데 흰 판을 쓴다.
    - 5행: `accessibilityRole="radio"` `accessibilityState={{checked}}` `min-h-[48px]`
    - 선례: `ProfileEditModal.tsx`, `LocationConsentView.tsx`
  → 저장은 그대로 localStorage 를 쓴다(네이티브도 `lib/storageInstall.ts:4` 가 깐다). 동기화는 작은 구독 store 로 한다.
  → 캐시 `preset`
    - `model.ts:166-177`·`:180-202` 와 test 를 고친다(웹 `:431`·`:583`).
    - `useCoursePlan.ts:153`(silentRefresh)·`:209`(fetchCourse deps)에도 preset 을 넣는다.

- G4b-12: vectorEffect 는 지원된다(`extractStroke.ts:18`·`:87-88`).
  → '2.5 단위' 환산은 버리고 웹 값 1.4 + non-scaling 을 쓴다.
  → 원은 `top:'54%'`, 바탕은 `colors[\`tile-${tone}-bg\`]` 이다.
  → 경로는 `components/PlacePhotoFallback.tsx` 다(§3).

- G4b-18: `cn` 은 병합하지 않는다(`cn.ts:1-2`).
  → 금 톤은 클래스를 바꿔 끼운다(`:37`·`:38`·`:45`). 그림자는 Pressable `style` 로 준다. API 는 §3 Chip.

- G4b-20: 더할 것
  - 첫 로딩 자리는 `zIndex:1` 을 받지 않는다(웹 s02 에서 시트가 위에 겹친다).
  - 시트 아래 여백은 `navClearance` 다(웹 `:1928`).
  - 내레이션은 `entering` 에 기대지 말고 shared value 로 opacity·y 를 움직인다. Expo web 은 entering 이 매번 실패한다.
  - 키 중복(`CourseSections.tsx:283`)은 맞다.

- G4b-21
  - '카드 그림자 없음'은 틀렸다. `ErrorState` 는 `<Card>`(`:37`)이고 기본 `elevation='card'` 가 그림자를 단다(`Card.tsx:25`·`:32`). → A 의 그림자 단계를 지운다.
  - 공용 사용처가 8곳이다.
  - 대비는 2.64:1 이다.
  → §3 ErrorState.

- G4b-22: 덧붙이지 말고 바꿔 끼운다.
  - `Button.tsx:71` 의 `rounded-2xl`/`px-[16px]` 와 `:87` 의 글자 크기를 조건으로 교체한다.
  - prop 이름은 §3 Button 을 따른다.
  - 카드 그림자는 `CourseSections.tsx:217`·`:256` 에 `style` 로 준다.

- G4b-23: A 를 고르면 `features/course/model.test.ts:84`(`'app.course.slotLateNight'` 단언)도 바꾼다. 아니면 `npm test` 가 실패한다.

- G4b-27
  1. `resetInputs` 는 이미 비었으면 아무것도 하지 않아야 한다: `setSequence(p=>p.length?[]:p)`, `setSelectedTypes` 같은 식, `setPins(p=>Object.keys(p).length?{}:p)`. 아니면 탭을 옮길 때마다 500ms 뒤 `POST /courses/plan` 이 나간다(`useCoursePlan.ts:107`·`:209`·`:243-248`).
  2. cleanup 은 ref 로 부른다(`resetRef.current = plan.resetInputs`).
  3. 늦은 응답은 세대 번호로 버려진다(`:166`).
  → 결정은 §3 에서 한다.

- G4b-07: `<Text>🕒</Text>` 는 16px 로 커진다.
  → `<Text className="text-[13px] leading-[19.5px]" accessibilityElementsHidden importantForAccessibility="no">🕒</Text>`

- G4b-05: 폴백이 보이는 동안은 `zIndex:1` 을 뺀다.
  → `onUnavailable` 은 G2-08 과 같은 prop 이다. 한 번만 만들고, 시간 초과는 prop 으로 받는다(홈 8000, 코스 3000 — 웹 `CourseMap.tsx:226-233`).

- G4b-19: `ChevronLeft`/`ChevronRight` import(`OrderPicker.tsx:5`)와 머리 주석(`:2-3`)도 정리한다.

## 3. 묶음 간 충돌·공용 컴포넌트

- 결정 기준(전 묶음)
  - 관련 ID: Expo 유지를 권한 G3-04·18·30·32·35 ↔ 웹에 맞추기를 권한 G4a-06·17(a)·26(a), G4b-08 A·19 A
  - 문제: HANDOVER 313행과 어긋나는 권장이 섞여 있다.
  → 기본은 웹에 맞춘다.
  → 예외는 스토어·법적·코드 규칙 근거가 있는 것만 둔다: G3-30, G5b-29, G3-35, G1-14, G3-26·G3-R01 5번(`apps/web/AGENTS.md:28`).
  → G3-32 는 근거가 '덜 귀찮다'뿐이라 기본이 웹이다. 유지하려면 사용자가 결정한다.

- 탭 막대 겹침(G2-G01)과 바닥 기준 위치
  - 관련 ID: G3-01·22·25·27·31·33·34, G4a-01·13·15·17, G4b-01·20
  → `components/navigation/TouristTabBar.tsx` 가 `NAV_CLEARANCE = 116`(웹 `--tourist-nav-clearance`)과 `useNavClearance() = 116 + insets.bottom` 을 내보낸다.
  → 모두 이 값을 쓴다. 15·24·'탭막대+8' 같은 숫자를 직접 쓰지 않는다.
  → G2-G01 을 먼저 한다.
  → `TAB_BAR_TOAST_OFFSET` 도 이 값을 기준으로 바꾼다.
  → `tokens.test.ts` `LAYOUT_ONLY` 에서 clearance 를 빼고 116 을 대조한다.
  → 네이티브 구글 로고: `NextSpotMap` 에 `mapPadding` prop 을 연다.
    - 홈은 아래 스택 높이 + 8
    - 코스는 G4b-01 A(지도가 시트 위)

- `components/ui/Sheet.tsx`(시트·모달 그릇)
  - 관련 ID: G3-01(삭제), G3-21·G2-G07(웹 모달), G4b-08, G4a-22, G2-16·31
  → 비모달 `Sheet` 는 G3-01 이 지운다. ModalSheet 부품은 남긴다.
  → 웹 ModalSheet 는 G2-G07 이 소유한다(G3-21 바로잡은 1~2번 절차, `sheetScroll.web.ts` 포함).
  → 모양은 opt-in prop 으로만 바꾼다.
  → G4b-08 은 RN `Modal` 을 쓴다.
  → 순서: G2-G07 → G3-21 → G4a-22

- `features/recommendation-card/*`
  - 관련 ID: G3-01 새 컴포넌트 ↔ G4a-13(presentation·rankMode·onKeep), G3-07(onPutOff), G3-10
  → `RecommendationCard` 하나로 하고, prop 은 웹 이름을 쓴다.
  → 순위 문구는 웹 `:1154-1156` 그대로 둔다(`rankMode` 없음).
  → 저장 변형은 G3-R02, 틀은 G4a-13(정정)이다.
  → 한 PR 로 G3 가 맡는다. G4a 는 `sheetSlot.tsx`·`saved.tsx` 만 고친다.

- 토스트
  - 관련 ID: G3-33 ↔ G2-G09(같은 새 `HomeToast.tsx`), G3-34 ↔ G2-G01·G2-G09·G4b-26, G3-22, G4a-12 ↔ G5b-35
  → `HomeToast` 하나를 G3-33 이 맡는다. G2-G09 의 HomeScreen 메시지(`:283`·`:286`·`:352`·`:414`·`:625`)도 넣는다.
  → 전역 `AppToaster` 는 G3-34 한 명세로 한 번에 바꾼다.
  → 제보 토스트는 이름 붙은 Toaster `report` 를 쓴다.
  → 되돌릴 수 없는 확인
    - `features/mypage/confirm.ts` 를 `lib/platform/confirm.ts` 로 옮겨 토스트판 `confirmDestructive()` 로 만든다(G5b-35 A).
    - G4a-12 도 이 함수를 쓴다.
    - 규칙: action 에서 `toast.dismiss(id)`, `row-reverse`, dismiss/autoClose → false

- `components/ui/Button.tsx`
  - 관련 ID: G1-20(`size md|lg|hero`·`shape 2xl|xl|full`·`tone`·`shadow`) ↔ G4b-22(`shape='pill'`·`size='sm'`)
  → G1-20 API 하나에 `size:'sm'`(13/19.5, px 20, min-h 44)만 더한다. G4b-22 는 `shape="full" size="sm"` 을 쓴다.
  → 클래스는 조건으로 바꿔 끼운다.
  → 카드 버튼(G3-20)과 대안 버튼(G4a-21)은 웹도 화면 전용이라 화면 안 Pressable 로 둔다.

- `components/ui/Chip.tsx`
  - 관련 ID: G4a-05(`selectedTone`+`count`) ↔ G4b-18(`tone`+`labelWeight`) ↔ G5b-27 ↔ G1-34·G5b-06
  - 문제: 웹 선택 모양이 화면마다 다르다(저장은 금+muk medium, 코스는 금+gold-deep bold+그림자).
  → `variant?: 'layer'(기본) | 'savedFilter' | 'courseType'`(필요하면 `'labReason'`)로 한다. 각 variant 가 웹 클래스 묶음을 통째로 갖는다.
  → `count?` 는 savedFilter 용이다. 접근성은 G1-34 방식으로 한 번 한다.

- 단색 금 대비
  - 관련 ID: G1-20 · G4a-28 · G4b-10 · G4b-21 · G5b-05
  - 사실: 흰 글자 on #c19a3e = 2.64:1(3.7 아님), on #705819 = 6.8:1
  → 한 번에 결정한다. 권장은 웹을 gold-deep 으로 바꾸는 것이다(`apps/web/lib/contrast.test.ts` 기준).
  → Expo 는 높이·아이콘·글자만 맞춘다.

- `components/ui/ErrorState.tsx`(Expo 8곳)
  - 관련 ID: G4a-28 = G4b-21, G5a-22(대기 전용 새 파일), G2-06(홈)
  → 공용은 웹 `components/ErrorState.tsx` 모양 하나로 둔다: 아이콘 없음, `rounded-full px-[16px] py-[8px]` 12px bold, hitSlop, 색은 위 결정을 따른다.
  → 대기는 웹도 화면 전용이므로 G5a-22 `BoardError` 를 그대로 둔다(variant 를 넣지 않는다). 홈은 G2 가 결정한다.

- 사진 없는 표지(PlacePhotoFallback)
  - 관련 ID: G3-08 · G4a-19 · G4b-12 · G5a-15
  - 문제: 경로가 엇갈리고(`components/ui/` ↔ `components/`), vectorEffect 판단도 엇갈린다.
  → `apps/mobile/components/PlacePhotoFallback.tsx` 하나로 한다(웹 경로와 같다).
  → 그리는 값: 1.4 + non-scaling + round cap/join + opacity 0.5 + `translate(phase*12−6)`, 그라데이션은 별도 Svg, 원은 44px·`top 54%`
  → 문양 함수는 `lib/placeEmblem.ts` 로 복사하고 PORTING 행을 적는다.
  → 사용처 4곳을 한 PR 로 바꾼다.
  → 출처 줄은 G5a-16 의 `components/ui/CreditLine.tsx` 를 CardPhoto 도 같이 쓴다.

- NowChip
  - 관련 ID: G4a-03·G5a-04(제자리 수정) ↔ G4b-06(새 파일) + `course.tsx:35-50` 사본
  → `components/ui/NowChip.tsx` 로 한 번 옮긴다. import 4곳(saved·recommend·waiting·course)을 바꾸고, 한 담당이 맡는다. 명세는 같다(G4a-03 의 ping 시간).

- LoadingReveal
  - 관련 ID: G4b-20(`components/ui/`, variant) ↔ G5a-09(`features/waiting/`)
  → `components/ui/LoadingReveal.tsx` 하나로 하고 G5a-09 가 그것을 쓴다.

- GoldenHourBadge·알림
  - 문제 1: Expo 사본이 둘이다(`Extras.tsx` GoldenHourLine ← G3-18, `waiting/GoldenHourLabel.tsx` ← G4a-09·G5a-19).
  - 문제 2: 알림 권장이 반대다(G3-18 없음 ↔ G4a-06 이식, G5a-19·G5b-10 결정 필요).
  → `components/GoldenHourBadge.tsx` 하나를 카드·저장·대기가 같이 쓴다.
  → 알림은 한 번 결정한다. 기준대로면 이식이고, `lib/core/useCongestionAlerts.ts` 하나로 저장·카드·대기·마이를 다 처리한다.

- `lib/theme/tokens.ts`
  - 관련 ID: G3-11 · G3-17(v3 값) · G4a-24(v4 `*-web`) · G4a-07
  → `*-web` = 웹 v4 기본 팔레트 sRGB 값이라는 규칙 하나로, G4a-24 값 한 벌을 쓴다.
  → `.benefit-relaxed/quiet` 는 globals.css 값으로 `tokens.test.ts` 대조에 넣는다.

- Tailwind v4(웹) ↔ v3.4(NativeWind) 이름 차이(전 묶음)
  - 예: `rounded-sm` 4↔2px, `shadow-sm`(v4 = v3 `shadow`), `blur-sm`
  → 웹 클래스를 글자 그대로 옮기지 말고 px·문자열 값으로 옮긴다.

- `cn` 병합 없음(전 묶음)
  → "prop 을 더하고 클래스를 덧붙인다"는 모든 고칠 방법(Button·Chip·Tag·ErrorState·Pill·CongestionReportButton)을 '바꿔 끼우기'로 고친다.

- 기본 줄 높이(G2-G05) ↔ 화면별 `leading-[…]` 추가(G4a-16·20·R02·R04, G4b-07·14 등)
  → G2-G05 를 먼저 한다. 그 뒤 1.5배가 아닌 값(snug·tight·relaxed·none)만 각 화면이 적고, 다시 잰다.

- CongestionReportButton(G3 소유)
  - 관련 ID: G3-20·21·22 ↔ G4a-22(대안 재사용, 웹 `min-h-11`)
  → props `{facility, isFirst, onReported, className}` 를 유지한다.
  → 순서: G3 → G4a-22

- ShareButton
  - 관련 ID: G4a-23 ↔ G4b-03(웹은 `components/ShareButton.tsx` 하나)
  → `components/ShareButton.tsx` 하나로 한다.
    - 모양: 알약 12px semibold + Share2 15, 복사 뒤 2초 Check jade
    - `style`/`className` 을 그대로 넘긴다.
    - 실패 토스트 10초, `onShare` 가 결과를 돌려준다.

- spotPoints
  - 관련 ID: G3-03 · G4a(AlternativeCard·ComparisonSection·savedList) · G4b(StopRows)
  → `lib/core/spotPoints.ts` 하나로 한다.

- `/explore/recommend` 자리
  - 관련 ID: G2-G02(탭 안으로 이동) ↔ G4a-15·31
  → G2-G02 를 먼저 한다.
  → G4a-15 는 stackOptions 삭제와 원형 버튼만 한다.
  → 하드웨어 뒤로는 `<Tabs backBehavior="history">` 로 한다(기본 firstRoute 면 홈으로 간다).
  → `explore/map` 은 탭 안 숨은 경로로 둔다.

- 탭 재진입
  - 관련 ID: G4b-27(초기화) · G5a-24(매번 조용히 새로고침) · G4a-11(재진입 스켈레톤 안 따름)
  → 한 규칙으로 한다. 화면 상태(펼침·선택·스크롤)는 웹처럼 초기화하고, 데이터는 조용히 다시 받는다. 웹의 스켈레톤 깜빡임은 따르지 않는다.

- 가정 시간(G4b-08 ↔ G5a-05 ↔ G2-24, G4b-23)
  → `lib/core/assumedTime.ts` 하나로 하고 결정은 한 번 한다.

- 음성 비서(G3-04 ↔ G2-12 ↔ G4a-17)
  → 결정은 한 번 한다. 이식하지 않으면 셋 다 의도된 차이로 기록하고, 이식하면 대안 목록 `pr-[56px]` + 마이크 `navClearance+12` 를 쓴다.

- 여행 조건 칩(G3-06) ↔ G2-28
  → 해제는 G2-28 이 만드는 '저장되는' 처리기를 부른다(웹 `removeCondition` `page.tsx:3458-3476`).

- ✨ 경주 테마(G2-14) ↔ G3-05
  → 이식하면 contextBadge 칩을 넣는다.

- 지도 SDK 실패(G2-08 ↔ G4b-05)
  → prop·그라데이션은 한 번 만들고, 시간 초과는 prop(8000/3000)으로 받는다.
  → 카메라 경합(G4b-R01)의 근본 수정은 G2 가 한다.

- 마스코트(G3-27 ↔ G1-02·31·G2-05)
  → `components/NextSpotMascot.tsx` 하나로 한다(`variant avatar|full`).

- 광원(G4a-14 ↔ G5a-02)
  → `components/ui/Glow.tsx` 하나에 프리셋을 둔다(저장 300/100, 대안 600/120, 대기 520/120).

- 같은 파일을 여러 항목이 고친다 → 파일마다 담당 하나
  - `saved.tsx`: G4a-01·02·04·05·06·10·11·12·14
  - `RecommendScreen.tsx`: G4a-14~17·21·27·29·R05
  - `AlternativeCard.tsx`: G4a-17·18·20~24·R03·R04
  - `course.tsx`: G4b-01~03·05~08·13·20·27·R02·R04·R05
  - 카드 파일: G3 전부 + G3-R01·R02

## 4. 확인 결과 요약

- P0: 22건을 모두 확인했다(G3 8 · G4a 8 · G4b 6). 정정은 17건이다(G3-01·02·21·31, G4a-01·06·12·13·15·17·22·26, G4b-01·08·19·20·25). 보완이 3건 더 있다(G3-03·05·07).
  - 그대로 따르면 깨지거나 틀린 화면이 나오는 것: G3-01·21·31, G4a-01·12·13·15·17, G4b-01·08·20
- P1: 55건을 확인했다(G3 23/26 · G4a 17 · G4b 15). 정정은 28건이다(G3 10 · G4a 11 · G4b 7).
- 새 항목: 12건이다.
  - P0 1: G3-R01
  - P1 3: G3-R02, G4a-R01, G4b-R01
  - P2 8: G4a-R02~R05, G4b-R02~R05
- 인벤토리
  - G3 상태는 전부 쌍이나 항목, 코드 비교로 덮였다.
  - G4a 에는 '차이 없음/해당 없음' 메모가 세 곳 빠졌다: EXP-12(차이 없음), EXP-21(폭 차이는 G4a-17), EXP-24(해당 없음).
  - G4b 에는 메모가 세 곳 빠졌다: CRS-17(같은 흐름, preset 만 G4b-08), CRS-31(분기 없음), CRS-12(G4b-R05).
- 추가 촬영: 없음. 기존 쌍으로 충분했다(`shots/G3/47-recs-error-peek`, `shots/G4a/sav-07-detail-open`, `shots/G4b/plan1-02-map` 등). 저장소·fixture·overlay 수정 0, 브라우저 실행 0.
