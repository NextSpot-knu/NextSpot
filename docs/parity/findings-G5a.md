# G5a 대기 보드('지금 출발하면?') — 웹 ↔ Expo 비교 결과

- 대상: 웹 `/waiting`(`apps/web/app/waiting/page.tsx`, 기준) ↔ Expo `/waiting` 탭(`apps/mobile/app/(tabs)/waiting.tsx` + `apps/mobile/features/waiting/*`). Expo 는 웹 빌드(`https://nextspot.expo.app`, react-native-web)로 봤다.
- 조건: 하네스 `openPair`(390×844 @2x, ko-KR, Asia/Seoul, 황리단길 GPS, 공유 게스트 `state:'saved'`). 2026-11-10 14:01~14:17 KST(화요일)에 찍었다. 저장소 파일은 고치지 않았다.
- 데이터: 기본 보드는 공유 픽스처와 실시간 읽기 GET 으로 그렸다. 나머지 상태는 `mockRoute`/`mockGet` 로 by-type 응답·추정 피드·권역 곡선·골든타임을 메모리에서 만들었다. 공유 픽스처를 복사해 값만 바꿨고, 실서버 POST 는 없다. 시나리오 정의는 `scratch/parity/work/G5a/scenarios.mjs`, 실행은 `work/G5a/0{1..4}-*.mjs`, 측정값은 `work/G5a/out/*.json`.
- 표기: 웹 `W:` = `apps/web/`, Expo `M:` = `apps/mobile/`. 측정값은 CSS 픽셀(390 폭 기준).

## 요약

| 중요도 | 개수 | ID |
|---|---|---|
| P0 | 4 | G5a-01, G5a-05, G5a-09, G5a-16 |
| P1 | 8 | G5a-04, G5a-06, G5a-11, G5a-12, G5a-15, G5a-19, G5a-21, G5a-22 |
| P2 | 13 | G5a-02, G5a-03, G5a-07, G5a-08, G5a-10, G5a-13, G5a-14, G5a-17, G5a-18, G5a-20, G5a-23, G5a-24, G5a-25 |
| 합계 | 25 | |

가장 중요한 5가지
1. **G5a-09 로딩 상태가 다른 앱처럼 보인다.** 웹은 내레이션 머리(맥동 핀, 문장, 진행 바)와 3칸 고스트 스켈레톤을 보여 준다. Expo 는 평평한 판 2장(80%+30%)뿐이고 둘째 판이 섹터 밖으로 넘친다.
2. **G5a-01 뒤로 버튼이 없다.** Expo 는 히어로부터 64px 위에서 시작한다.
3. **G5a-05 가정 시간 셀렉트·배지·'{시각} 기준' 줄이 없다.** 웹 히어로에는 흰 44px 컨트롤 줄이 늘 있다. 결정 필요.
4. **G5a-16 Wikimedia·경주시·사장님 사진을 빼서 출처 줄이 없고, 대표 카드 순서가 바뀐다.** 데이터에 따라 생긴다.
5. **G5a-12 글자 1px 큼과 G5a-11 카드 높이 늘어남.** 거의 모든 카드에 보인다.

차이가 **없던** 것(확인함):
- 문구: 한국어·영어 문구가 같은 키로 같다.
- 내용: 섹터 순서, 사진 출처 사례를 뺀 카드 순서, 대기 분·등급·한산 줄·도착 시각이 같다.
- 한 등급 보드: 판정('이 일대' 줄과 '도보 N분')이 같다.
- 오늘 휴무: 배지와 맨 뒤로 보내기가 같다.
- 문화시설 1·2곳 격자가 같다.
- 카드를 누른 뒤 이동 주소가 글자 그대로 같다: `/explore/recommend?facilityId=…&lat=35.83762127831&lng=129.208798933628&type=restaurant&from=waiting`.
- 저장된 결과를 먼저 그리는 캐시: 두 앱 모두 로더 없이 바로 그린다.
- 전부 실패할 때: 두 앱 모두 16번 요청한 뒤 오류 카드를 띄운다(4.9초 / 5.5초).
- 문서 제목: 둘 다 `NextSpot`.

---

### G5a-01 맨 위 '지도로 돌아가기' 뒤로 버튼 없음
- 화면·상태: 모든 상태의 맨 위
- 스크린샷: shots/G5a/01-default-top.pair.png, 10-graded-top.pair.png, 30-empty.pair.png
- 웹(기준): `W:app/waiting/page.tsx:1135-1142` `<button aria-label={t('waiting.backAria')} onClick={() => router.push('/main')} className="toss-pressable flex shrink-0 items-center justify-center w-11 h-11 rounded-full bg-white/90 border border-line shadow-[0_2px_10px_rgba(43,35,32,0.1)] text-muk …"><ArrowLeft size={18}/></button>`. 측정: (16,16) 44×44. 그 아래 `space-y-5`(20px) 뒤에 히어로가 y=80 에서 시작한다.
- Expo(현재): 버튼이 없다. 히어로가 y=16 에서 시작한다(`M:app/(tabs)/waiting.tsx:69-71`, 탭 화면이라 뺐다).
- 차이: 44px 원형 버튼이 없고, 화면 전체가 64px 위로 올라가 있다.
- 중요도: P0 · 분류: 누락
- 고칠 방법:
  1) `waiting.tsx` 바깥 스택(70행) 맨 앞에 버튼을 넣는다: `<Pressable accessibilityRole="button" accessibilityLabel={t('waiting.backAria')} onPress={() => router.navigate('/')} className="h-[44px] w-[44px] self-start items-center justify-center rounded-full border border-line bg-white/90" style={{ boxShadow: '0px 2px 10px rgba(43, 35, 32, 0.1)' }}><Icon icon={ArrowLeft} size={18} color="muk" /></Pressable>`. `ArrowLeft` 는 lucide-react-native, `Pressable`·`Icon` 은 `~/components/ui` 에서 가져온다.
  2) 이동 대상은 웹 `/main` 에 해당하는 Expo 홈 `'/'` 다.
  3) 버튼과 히어로 사이 간격 20px 는 G5a-03 에서 함께 맞춘다.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/waiting.tsx`
- 문구(i18n): 재사용 `waiting.backAria` / 새 키 없음
- 네이티브 주의: 탭 화면에 뒤로 버튼을 두는 것은 플랫폼 관례와 다르다. `navigate('/')` 는 탭만 바꾸므로 화면 스택이 쌓이지 않는다.
- 확인 방법: `node scratch/parity/work/G5a/02-scenarios.mjs graded` 로 `10-graded-top` 를 찍는다. Expo 버튼이 (16,16,44,44), 히어로가 y=80 인지, 누르면 주소가 `/` 가 되는지 본다.
- 크기: S · 의존: G5a-03
- 표시: 결정 필요 — (a) 웹과 같게 넣는다(권장), (b) 탭 관례대로 빼고 차이로 남긴다.

### G5a-02 페이지 배경의 노을·금빛 흐림 광원 없음
- 화면·상태: 모든 상태. 짧은 화면(빈·오류·로딩)에서 잘 보인다.
- 스크린샷: 30-empty.pair.png, 38-error.pair.png
- 웹(기준): `W:app/waiting/page.tsx:1127-1130`. `main` 은 `relative overflow-hidden` 이고, 안에 원 두 개가 깔린다.
  - 위: `absolute top-[-20%] left-[-10%] w-[520px] h-[520px] rounded-full bg-sunset-1/10 blur-[120px]`
  - 아래: `bottom-[-10%] right-[-10%] … bg-gold/10 blur-[120px]`
  - 측정(빈 상태): 왼쪽 위 `#f9efe5`, 오른쪽 위 `#f9ede2`, 왼쪽 아래 `#f6eedf`.
- Expo(현재): `bg-hanji` 단색 `#faf5ec`(`waiting.tsx:69`).
- 차이: 웹은 위·아래 가장자리가 복숭아·금빛으로 물들고, Expo 는 평평하다.
- 중요도: P2 · 분류: 색·효과
- 고칠 방법:
  1) 스크롤 내용 맨 앞에 `pointerEvents="none"` 인 `absolute` 장식 두 개를 둔다. 위 원은 `top:'-20%', left:'-10%'`, 아래 원은 `bottom:'-10%', right:'-10%'`, 크기는 각각 520×520.
  2) 원은 `react-native-svg` 의 `RadialGradient` 로 그린다. 위 원은 sunset-1 0.10 → 0, 아래 원은 gold 0.10 → 0. RN 에는 CSS blur 가 없어서 이렇게 흉내 낸다.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/waiting.tsx`(또는 새 파일 `features/waiting/BoardGlow.tsx`)
- 문구(i18n): 없음
- 네이티브 주의: 스크롤 안에 넣어야 웹처럼 내용과 함께 움직인다.
- 확인 방법: `02-scenarios.mjs empty` 를 찍고, 두 그림의 가장자리 픽셀 색을 이 문서와 같은 방법(PIL)으로 비교한다.
- 크기: S · 의존: 없음

### G5a-03 상단 블록 사이 간격과 바닥 여백
- 화면·상태: 모든 상태
- 스크린샷: 01-default-top.pair.png, 06-culture.pair.png
- 웹(기준): `page.tsx:1133` 은 `space-y-5`(20px), 출처 줄(`:1214`)은 `-mt-2` 다. 그래서 간격은 히어로→출처 12px, 출처→'이 일대' 줄 또는 보드 20px, 줄→보드 20px 이다. 바닥은 nav 여유 116px(`W:app/globals.css:237`)라 마지막 판과 하단 탭 사이가 16.5px 다. 측정: 히어로 아래 286.8 → 출처 298.8.
- Expo(현재): `waiting.tsx:70` 의 `gap-[16px]` 하나로 모든 간격이 16px 다. 바닥은 `pb-[24px]`(69행)라 마지막 판과 탭 막대 사이가 25px 다.
- 차이: 히어로→출처 +4px, 출처→보드 −4px, 줄→보드 −4px, 바닥 +8px.
- 중요도: P2 · 분류: 크기·간격
- 고칠 방법:
  1) 70행을 `gap-[20px]` 로 바꾸고, 출처 `Text`(112행)에 `-mt-[8px]` 를 준다.
  2) 69행의 `pb-[24px]` 를 `pb-[16px]` 로 바꾼다.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/waiting.tsx`
- 문구(i18n): 없음 · 네이티브 주의: 없음
- 확인 방법: (출처 줄 y − 히어로 아래 끝) = 12, (보드 y − 출처 아래 끝) = 20 인지 잰다.
- 크기: S · 의존: G5a-01, G2(하단 탭 높이)

### G5a-04 NowChip — 시계 아이콘·맥동 점 없음, 글자·여백 다름
- 화면·상태: 히어로(모든 상태)
- 스크린샷: 12-graded-hero-zoom.pair.png
- 웹(기준): `W:components/NowChip.tsx:29-40`.
  - 칩: `inline-flex items-center gap-1 rounded-full bg-hanji-deep/70 border border-line px-2 py-0.5 text-[10px] font-medium text-muk-soft`
  - 내용: `<Clock size={11}/>` → 6px jade 점 + `animate-ping [animation-duration:2s] opacity-60` 후광(감속 모드면 숨김) → `common.nowTime`
  - 측정: 102.5×21, 글자 10px/15px
- Expo(현재): `M:features/waiting/NowChip.tsx:20-24` 는 `gap-[6px] px-[10px] py-[3px]`, 글자 11px 다. 점만 있고 후광과 시계 아이콘이 없다. 측정 99.7×21.
- 차이: 시계 아이콘 없음, 점이 맥동하지 않음, 글자 1px 큼, 여백 2px 다름.
- 중요도: P1 · 분류: 아이콘·이미지
- 고칠 방법:
  1) 컨테이너를 `gap-[4px] px-[8px] py-[2px]`, 글자를 `text-[10px] leading-[15px]` 로 바꾼다.
  2) 점 앞에 `<Icon icon={Clock} size={11} color="muk-soft" />` 를 넣는다.
  3) 점을 6×6 상자로 감싸고, 그 안에 `absolute` jade 원을 하나 더 둔다. Reanimated 로 scale 1→2, opacity 0.6→0 을 2000ms 동안 `Easing.bezier(0,0,0.2,1)` 로 반복한다. `useReduceMotion()` 이 참이면 그리지 않는다.
- 바꿀 Expo 파일: `apps/mobile/features/waiting/NowChip.tsx`
- 문구(i18n): 재사용 `common.nowTime`
- 네이티브 주의: 화면이 포커스를 잃으면 반복 애니메이션을 멈춰 배터리를 아낀다.
- 확인 방법: `12-graded-hero-zoom` 그림과 `out/01-baseline.json` 의 `probeNow` 를 본다.
- 크기: S · 의존: 없음

### G5a-05 '가정 시간' 셀렉트·'가정: …' 배지·'{시각} 기준' 줄 없음
- 화면·상태: 히어로(모든 상태), 가정 시간을 고른 보드
- 스크린샷: 01-default-top.pair.png, 41-assumed-sat-afternoon.pair.png
- 웹(기준):
  - 컨트롤 `page.tsx:1190-1203`: `<label className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-xs font-medium shadow-[0_2px_10px_rgba(43,35,32,0.06)]">` 안에 🕒 + `timeSim.label` + `<select aria-label>`(bold muk). 선택지는 `ASSUMED_TIME_PRESETS`(`W:lib/api-client.ts:662-668`). 측정 168.7×44. 최단 대기 칩과 같은 `flex-wrap` 줄(`:1177`)에 있다.
  - 배지 `:1204-1208`: `rounded-full bg-gold/15 border border-gold/40 px-2.5 py-1 text-[11px] font-bold text-gold-deep` 로 `timeSim.badge` 를 보인다.
  - 한 등급 줄 `:1225-1230`: 가정 시간일 때 `wait.areaAt`.
  - 동작: 저장 키는 `nextspot_assumed_at` 이고 `/main`·`/course` 와 공유한다(`page.tsx:670-680`). by-type 요청의 `assumed_at` 에 고른 시각이 들어간다(측정 `2026-11-14T05:00:00.000Z` = 토 14:00 KST, `:927,954`, `api-client.ts:696-715`). 대기 계산 기준 시각(`:720-737`), 권역 곡선(`:785-787`), 캐시 적중 조건(`:847`)도 이 값을 따른다.
- Expo(현재): 없다. by-type 은 늘 `assumedAt: null` 을 보내고(`M:features/waiting/useWaitingBoard.ts:127,149`), 캐시는 'now' 만 받는다(`boardCache.ts:21`). PORTING 의 의도적 제외(인벤토리 D7)다.
- 차이: 웹 히어로에만 44px 컨트롤(+배지) 줄이 있다. 빈 상태 본문 "가정 시간을 바꾸면…"이 Expo 에서는 가리킬 곳이 없다(G5a-21).
- 중요도: P0 · 분류: 누락
- 고칠 방법(포팅할 때):
  1) 새 공용 모듈 `apps/mobile/lib/core/assumedTime.ts` 를 만든다. 웹의 `ASSUMED_TIME_PRESETS`·`getStoredAssumedPreset`·`setStoredAssumedPreset`·`assumedAtIsoForPreset` 를 그대로 옮긴다. 웹의 window 이벤트 대신 `subscribe(fn)` 구독자 집합으로 변경을 알린다. 홈·코스도 이 모듈을 함께 쓴다.
  2) `useWaitingBoard.ts` 를 고친다.
     - 프리셋을 구독하고, 127·149행 `recommendByType` 의 `null` 자리에 `assumedAtIsoForPreset(preset)` 를 넣는다.
     - 기준 시각 `baseAtMs`(가정이면 그 시각, 아니면 `nowMs`)로 `estimateWait({baseAt})` 와 `arrivalHourOf` 를 계산한다.
     - 가정 시간이면 권역 곡선을 `fetchAreaDemandCurve(signal, baseAtMs)`(`M:features/waiting/api.ts:30`)로 받는다.
     - 프리셋이 바뀌면 진행 중 조회를 끊고 로더부터 다시 시작한다.
     - `boardCache` 에 `preset` 을 저장하고 읽는다.
  3) `waiting.tsx` 히어로를 고친다.
     - 91-109행을 늘 그리는 `flex-row flex-wrap items-center gap-[8px] pt-[2px]` 줄로 바꾼다.
     - 칩 뒤에 닫힌 셀렉트 모양 `Pressable` 을 둔다. 모양: `min-h-[44px] flex-row items-center gap-[6px] rounded-xl border border-line bg-white px-[12px]`, 그림자 `0px 2px 10px rgba(43,35,32,0.06)`. 내용: 🕒, `timeSim.label`(12px medium muk-soft), 현재 라벨(12px bold muk), `ChevronDown` 12.
     - 누르면 `Sheet` 나 `@expo/ui` Picker 로 선택지 5개를 보인다.
     - 가정 시간이면 배지를 단다: `rounded-full border border-gold/40 bg-gold/15 px-[10px] py-[4px]`, 11px bold gold-deep.
  4) '이 일대' 줄(124행)은 가정 시간이면 `t('wait.areaAt',{time,label})` 를 쓴다.
- 바꿀 Expo 파일: `lib/core/assumedTime.ts`(새), `features/waiting/useWaitingBoard.ts`, `features/waiting/boardCache.ts`, `app/(tabs)/waiting.tsx`
- 문구(i18n): 재사용 `timeSim.label`, `timeSim.now`, `timeSim.weekdayNoon`, `timeSim.friEve`, `timeSim.satAfternoon`, `timeSim.sunMorning`, `timeSim.badge`, `wait.areaAt` / 새 키 없음
- 네이티브 주의: RN 에는 `<select>` 가 없어서, 닫힌 모양만 웹과 같게 만들 수 있다.
- 확인 방법: `02-scenarios.mjs assumed` 처럼 Expo 에도 `nextspot_assumed_at` 을 넣고 `41-assumed-sat-afternoon` 을 비교한다. `out/02-scenarios.json` 의 `assumed:requestBodies` 에서 `assumed_at` ISO 가 웹과 같은지 본다.
- 크기: L · 의존: G2(홈 예측 띠), G4(코스 G4-CRS-23)
- 표시: 결정 필요 — (a) 세 화면 공용으로 포팅(권장), (b) 웹에서도 뺀다(이 작업 범위 밖), (c) Expo 는 계속 빼고 빈 상태 문구만 고친다.

### G5a-06 한 등급이 아닌 보드에서 히어로 범례 줄이 없음
- 화면·상태: 비균일 보드(실서비스에서 흔함), 빈·오류·로딩 상태
- 스크린샷: 21-mixed-top.pair.png, 30-empty.pair.png, 38-error.pair.png
- 웹(기준): `page.tsx:1168-1172` 는 범례를 늘 그린다: `<p className="text-[11px] text-muk-soft/90 leading-relaxed">{uniform ? t(legendUniformKey) : showsAnyCalmLine ? t('wait.legend') : t('wait.legendArrival')}</p>`. 측정: "카드마다 도착할 때의 붐빔을 보여드려요."
- Expo(현재): `waiting.tsx:87-89` 는 한 등급 보드일 때만 그린다.
- 차이: 비균일·빈·오류·로딩에서 Expo 히어로에 한 줄(18px)이 빠진다.
- 중요도: P1 · 분류: 문구
- 고칠 방법: 87-89행을 조건 없이 `<Text className="text-[11px] leading-[18px] text-muk-soft/90">{uniform ? t(crowd.legendUniformKey) : view.showsAnyCalmLine ? t('wait.legend') : t('wait.legendArrival')}</Text>` 로 그린다.
- 바꿀 Expo 파일: `app/(tabs)/waiting.tsx`
- 문구(i18n): 재사용 `wait.legend`, `wait.legendArrival` / 새 키 없음
- 네이티브 주의: 없음
- 확인 방법: `02-scenarios.mjs mixed empty` 를 찍고 `21`·`30` 그림을 비교한다.
- 크기: S · 의존: 없음

### G5a-07 출처 줄 끝 괄호 덧붙임이 가운데서 끊김(en·ja·zh)
- 화면·상태: 출처 줄. ko 는 한 줄이라 같고, 다른 언어에서 접힐 때 다르다.
- 스크린샷: 52-en-top.pair.png
- 웹(기준): `page.tsx:1214-1216` 의 `TrailingNoteText`(`W:lib/trailingNote.ts` `splitTrailingNote`)가 끝 괄호를 한 덩어리로 묶는다. en: "…TourAPI" / "(unless credited otherwise)".
- Expo(현재): `waiting.tsx:112` 는 평문이다. en: "…TourAPI (unless" / "credited otherwise)".
- 차이: 괄호 덧붙임이 둘로 갈라진다.
- 중요도: P2 · 분류: 문구
- 고칠 방법:
  1) `@/lib/trailingNote` 로 `{lead, note}` 를 나눈다. 순수 함수라 Expo 가 그대로 가져올 수 있다.
  2) `{lead}<Text>{note.replace(/ /g,'\u00a0')}</Text>` 로 그린다.
  3) 같은 출처 줄을 쓰는 대안 화면과 함께 쓰려면 `components/ui/TrailingNoteText.tsx` 로 만든다.
- 바꿀 Expo 파일: `app/(tabs)/waiting.tsx`(+선택 `components/ui/TrailingNoteText.tsx`)
- 문구(i18n): 재사용 `waiting.dataAttribution`
- 네이티브 주의: 없음
- 확인 방법: `03-extra.mjs` 의 `52-en-top` 그림을 비교한다.
- 크기: S · 의존: 없음

### G5a-08 줄 높이·자간 — 칩·알약이 2~5px 낮고 문단 줄 간격이 좁음
- 화면·상태: 모든 보드 상태
- 스크린샷: 12-graded-hero-zoom, 13-graded-card-zoom, 11-graded-restaurant
- 웹(기준): `leading-*` 를 따로 안 준 글자는 기본 `line-height: 1.5` 를 물려받는다. 측정 높이:
  - 브랜드 칩 26.5(`:1149`), 개수 알약 24.5(`:1297`)
  - 카드 칩 21(`:465`), 행 칩 26.5(`:520`)
  - 골든 배지 21(`GoldenHourBadge.tsx:112`), 최단 대기 칩 37.5(`:1179`)
  - '이 일대' 줄 20(`:1221`), 행 출발 제안 16.5(`:1438`)
  - 명시된 값: 제목 22/25.3 + 자간 −0.55px(`:1157`), 부제 13/21.125(`:1162`), 범례·출처 11/17.875, 섹터 이름 15/18.75(`:1294`)
- Expo(현재): 줄 높이가 `normal` 이다. 측정 높이:
  - 브랜드 칩 22, 개수 20, 카드 칩 18, 행 칩 24
  - 골든 25(여백 4px 라 오히려 큼), 최단 대기 칩 35(그림자 없음), '이 일대' 16
  - 제목 22/26 자간 0, 부제 13/19, 범례·출처 11/16, 섹터 이름 15/normal
- 차이: 칩·알약이 낮고, 문단이 촘촘하고, 제목 자간이 조금 넓다.
- 중요도: P2 · 분류: 글꼴
- 고칠 방법: 아래 값을 각 클래스에 명시한다.
  - `waiting.tsx`: 74 `leading-[16.5px]` · 81 `leading-[25.3px] tracking-[-0.55px]` · 84 `leading-[21px]` · 88 `leading-[18px] text-muk-soft/90` · 97 `leading-[19.5px]`, 그리고 93행 상자에 `boxShadow:'0px 2px 10px rgba(193,154,62,0.16)'` · 112 `leading-[18px]` · 123 `leading-[20px]`
  - `SectorBoard.tsx`: 134 `leading-[18.75px]` · 138 `leading-[16.5px]`
  - `WaitingCards.tsx`: 칩 `leading-[15px]`(카드)·`leading-[16.5px]`(행) · 257 `leading-[16.5px]` · 252 `leading-[20.6px]`
  - `GoldenHourLabel.tsx:29-31`: `py-[2px] leading-[15px]`
- 바꿀 Expo 파일: `app/(tabs)/waiting.tsx`, `features/waiting/SectorBoard.tsx`, `WaitingCards.tsx`, `GoldenHourLabel.tsx`, `NowChip.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드는 글꼴 위아래 여백(`includeFontPadding`) 때문에 1~2px 다를 수 있다. G2 가 `Text` 기본 줄 높이를 1.5배로 정하면 이 목록의 절반이 저절로 풀린다.
- 확인 방법: `02-scenarios.mjs graded` 를 돌리고 `out/02-scenarios.json` 의 `graded:card`·`graded:hero` 높이를 위 웹 값과 맞춰 본다.
- 크기: M · 의존: G5a-12, G2

### G5a-09 로딩 상태 — 내레이션 머리·진행 바·핀 없음, 스켈레톤 모양이 다름
- 화면·상태: 첫 진입 로딩(캐시 없음), 부분 보드 아래 자리표시
- 스크린샷: 31-loading-early, 32-loading-step3, 33-loading-skeleton-scrolled, 34-partial-top, 35-partial-skeleton-below
- 웹(기준): `page.tsx:1246-1247` 의 `<LoadingReveal variant="waiting"/>`(`W:components/LoadingReveal.tsx`).
  - 머리 `:88-128`
    - 틀: `section role="status" aria-live="polite"`, `rounded-2xl border border-gold/25 bg-white/90 px-5 py-5 shadow-[0_8px_30px_rgba(43,35,32,0.08)]`, 오른쪽 위 금빛 흐림 원.
    - 핀: 48px 상자. 맥동 링(`border-2 border-gold/45`, 2.1s 동안 scale .9→2·opacity .6→0)과 44px `bg-gold/10` 원 + `MapPin` 22/2.3.
    - 글자: 'NextSpot'(11px bold uppercase tracking-wide, 화면엔 'NEXTSPOT'), 제목 14px bold, 단계 문장 12px(1.2초마다 step1→step3 에서 멈춤, 0.4초 페이드업).
    - 진행 바: `h-1.5 bg-line` 위 금 막대가 28초 동안 0→46%→68%→76%→94%.
  - 스켈레톤 `:132-201`
    - 섹터 판 2벌: `rounded-3xl bg-white/55 p-3` + 그림자.
    - 판 머리: 32px 칩, 96×16 줄, 44×20 개수 알약.
    - 카드: 3칸 격자 `h-72`(288px)에 블러 고스트(순위 원·사진 그라데이션·글줄·칩·대기 상자)와 행 2개.
  - 부분 보드: `:1460` 에서 판 1벌만.
- Expo(현재): `waiting.tsx:38` 의 `BoardSkeleton`(`M:features/waiting/BoardSkeleton.tsx:7-33`).
  - 머리·진행 바·핀이 없다.
  - 판은 `bg-white/60` 에 그림자가 없고, 개수 알약이 없다.
  - 카드 자리는 80%×316 과 30%×316 이다. 합이 100% 를 넘어 **둘째 판이 섹터 테두리 밖으로 넘친다**.
  - 행 자리는 68px 2개이고, 단색 판이 숨쉬듯 깜빡인다. 라이브 영역이 없다.
- 차이: 첫 진입 로더가 통째로 다르다.
- 중요도: P0 · 분류: 상태(로딩)
- 고칠 방법:
  1) 새 파일 `features/waiting/LoadingReveal.tsx` 로 웹 머리를 옮긴다.
     - 카드: `rounded-2xl border border-gold/25 bg-white/90 px-[20px] py-[20px] overflow-hidden`, 그림자 `0px 8px 30px rgba(43,35,32,0.08)`, 128px `bg-gold/15` 장식 원을 `right:-40, top:-48` 에 둔다.
     - 핀: 링은 Reanimated 로 scale .9→2·opacity .6→0, 2100ms `Easing.bezier(.2,0,0,1)` 반복, 감속 모드면 숨김. 그 안에 44px `bg-gold/10` 원과 `MapPin` 22/2.3 gold-deep, 원 그림자 `0px 2px 10px rgba(193,154,62,0.25)`.
     - 글자: 'NextSpot'(`text-[11px] uppercase tracking-wide` bold gold-deep), 제목(14px bold `leading-snug`), 단계 문장(12px muk-soft, 1200ms 마다 0→2 에서 멈춤, `FadeInUp` 400ms).
     - 진행 바: `mt-[16px] h-[6px] rounded-full bg-line overflow-hidden` 안의 금 막대 너비를 `withSequence(withTiming('46%',1120), withTiming('68%',1400), withTiming('76%',1960), withTiming('94%',23520))` 로, `Easing.bezier(.25,.6,.35,1)`.
     - 알림: `accessibilityLiveRegion="polite"`, 웹 빌드는 `role="status"` 와 `aria-live="polite"`.
  2) `BoardSkeleton.tsx` 의 `SectorSkeleton` 을 웹 모양으로 다시 짠다.
     - 판: `rounded-3xl border border-line/70 bg-white/55 p-[12px] gap-[10px]` + 그림자 `shadows.card`.
     - 판 머리: 32×32 r12 `bg-gold/20`, 96×16, `ml-auto` 44×20 알약.
     - 카드: **같은 폭 3칸** `flex-row gap-[8px]`, 각 칸 `flex-1 h-[288px] rounded-2xl border border-line bg-white/80 overflow-hidden`.
     - 고스트(불투명도 .75): 28px 원 `bg-gold/70`, h-112 `Gradient` [hanji-deep, gold/25, jade/20], 글줄 `bg-muk/45`·`bg-muk/25`, 칩 jade/35·gold/40, 대기 상자 `h-[24px] rounded-lg border-gold/40 bg-gold/25`.
     - 행 2개: `rounded-2xl border-line bg-white/80 px-[14px] py-[12px]`(36px 원, 글줄, 칩).
     - 80%/30% 판은 지운다(넘침도 함께 사라진다).
  3) `waiting.tsx:38` 은 `<LoadingReveal/>`(머리 + 판 2벌, `gap-[24px]`)로, 63행 부분 보드 아래는 새 `SectorSkeleton` 1벌로 바꾼다.
- 바꿀 Expo 파일: `features/waiting/LoadingReveal.tsx`(새), `features/waiting/BoardSkeleton.tsx`, `app/(tabs)/waiting.tsx`
- 문구(i18n): 재사용 `loadingReveal.waiting.title`, `loadingReveal.waiting.step1`, `loadingReveal.waiting.step2`, `loadingReveal.waiting.step3` / 새 키 없음('NextSpot' 은 웹도 글자 그대로 박혀 있음)
- 네이티브 주의: RN 에는 CSS blur 가 없다. 불투명도로 흉내 내는 쪽을 권하고, `expo-blur` 는 안드로이드에서 실험적이다. Reanimated 의 퍼센트 너비 애니메이션은 동작한다.
- 확인 방법: `02-scenarios.mjs loading partial` 로 `31`(0.4초)·`32`(3초)·`33`·`35` 를 찍는다. `loading:a11y` 측정에서 Expo 에도 `role=status` 가 잡히는지 본다.
- 크기: L · 의존: G5a-10

### G5a-10 섹터 판 — 그림자·흐림 없음, 바탕 투명도 다름
- 화면·상태: 모든 섹터 판
- 스크린샷: 02-restaurant, 22-mixed-restaurant
- 웹(기준): `page.tsx:1282-1285` `rounded-3xl border border-line/70 bg-white/55 fractal-glass p-3 shadow-[0_2px_14px_rgba(43,35,32,0.06)]`. `.fractal-glass` 는 `backdrop-filter: blur(8px)` 다(`W:app/globals.css:753-756`).
- Expo(현재): `M:features/waiting/SectorBoard.tsx:125` `bg-white/60 p-[12px]`. 그림자와 흐림이 없다.
- 차이: 판이 바탕에 붙어 보이고, 바탕이 5% 더 하얗다.
- 중요도: P2 · 분류: 색·효과
- 고칠 방법:
  1) `bg-white/55` 로 바꾸고 `style={{boxShadow: shadows.card}}`(`M:lib/theme/tokens.ts:102`, 웹과 같은 값)를 준다.
  2) 흐림은 G5a-02 의 광원을 넣을 때만 `expo-blur` 로 고려한다.
- 바꿀 Expo 파일: `features/waiting/SectorBoard.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 판에 `overflow-hidden` 을 주면 그림자가 잘린다.
- 확인 방법: 판의 계산된 `box-shadow`·`background-color` 를 웹 값과 비교한다.
- 크기: S · 의존: G5a-02

### G5a-11 대표 카드 높이 — 웹은 316px 고정(온전한 줄만), Expo 는 늘어남
- 화면·상태: 대표 카드(대기 줄이 많을 때, 긴 이름·메뉴·소개)
- 스크린샷: 13-graded-card-zoom, 50-long-text-card
- 웹(기준): `page.tsx:255-311` 의 `CardIntro`.
  - 소개 블록이 `grow basis-0 min-h-[16.5px] overflow-hidden` 이라, 카드 높이(`min-h-[316px]`, `:1333`)에서 대기 스탯을 뺀 자리만 받는다.
  - `fitWholeLines`(`W:lib/wholeLines.ts`)가 온전한 줄 수만큼만 남기고 `-webkit-line-clamp` 를 건다. 한 줄도 안 들어가면 그 문단을 숨긴다.
  - 측정: 대기 줄이 많은 카드(S1)는 316px 이고 소개가 1줄로 줄었다. 긴 이름 카드도 316px 이고 소개가 숨었다.
- Expo(현재): `M:features/waiting/WaitingCards.tsx:148-165` 에서 이름·메뉴·소개가 각각 `numberOfLines={2}` 로 고정이다. 측정: S1 343px, 긴 이름 360px(세 장 모두).
- 차이: Expo 카드가 27~44px 길고, 웹이 줄이거나 숨기는 소개가 Expo 에는 2줄 그대로 남는다.
- 중요도: P1 · 분류: 크기·간격
- 고칠 방법:
  1) 소개 블록을 `View style={{flexGrow:1, flexBasis:0, minHeight:16.5, overflow:'hidden'}}` 로 바꾼다.
  2) 두 번에 나눠 그린다. 첫 렌더는 최대 2줄로 그리면서 각 문단의 높이(`onLayout`)를 명시한 줄 높이로 나눠 줄 수를 센다(이름 16.5, 메뉴·소개 13.75). 블록 높이와 함께 `fitWholeLines`(`@/lib/wholeLines`, 순수 함수)에 넣고, 나온 값을 `numberOfLines` 로 준다. 0 이면 그 문단을 그리지 않는다. 문단 사이 여백(gapBefore)은 메뉴 2, 소개 4.
  3) 카드는 `min-h-[316px]` 를 유지한다.
- 바꿀 Expo 파일: `features/waiting/WaitingCards.tsx`
- 문구(i18n): 없음
- 네이티브 주의: react-native-web 은 `onTextLayout` 을 지원하지 않으므로 높이 ÷ 줄 높이로 센다(웹 코드도 같은 방식). 반올림은 `Math.round`.
- 확인 방법: `03-extra.mjs` 를 돌려 `out/03-extra-long.json` 의 `cardHeights` 가 Expo 도 `[316,316,316]` 인지, `graded:geometry.cards` 높이가 316 인지 본다.
- 크기: M · 의존: G5a-12 를 먼저

### G5a-12 카드·행·칩·배지 글자 크기 +1px, 카드 하단 띠 높이
- 화면·상태: 대표 카드, 행, 골든 배지, NowChip, 히어로 칩
- 스크린샷: 13-graded-card-zoom, 11-graded-restaurant, 14-graded-rows-zoom

| 요소 | 웹 `W:app/waiting/page.tsx` | Expo | Expo 바꿀 값 |
|---|---|---|---|
| 카드 이름 | `:300` 12px bold / 16.5 | `WaitingCards.tsx:150` 13px / 17 | `text-[12px] leading-[16.5px]` |
| 메뉴 | `:303` 10px bold / 13.75 | `:154` 11px / 15 | `text-[10px] leading-[13.75px]` |
| 소개 | `:307` 10px / 13.75 | `:159` 11px / 15 | `text-[10px] leading-[13.75px]` |
| 대기 머리줄 상자 | `:455` 12px extrabold, 상자 26.5 | `:67` 13px / 18, 상자 28 | `text-[12px] leading-[16.5px]` |
| 카드 등급·추정·휴무 칩 | `:465,470,475` 10px, 칩 21 | `:75,82,89` 11px, 칩 18 | `text-[10px] leading-[15px]` |
| 카드 한산 줄 | `:485` 10px bold / 13.75 | `:96` 11px / 15 | `text-[10px] leading-[13.75px]` |
| 하단 '대신 갈 곳 보기' 띠 | `:1367-1369` 11px / 13.75, `py-1.5 px-1`, 셰브런 13, 띠 26.8 | `:166-170` 12px / 16, `min-h-[36px]`, 셰브런 14, 띠 36 | `min-h-[36px]` 삭제, `text-[11px] leading-[13.75px]`, `Icon size={13}` |
| 행 칩 | `:520,525,539` 11px, 칩 26.5 | `:187,194,211` 12px, 칩 24 | `text-[11px] leading-[16.5px]` |
| 행 한산·'추정' 글자 | `:530,535` 11px | `:200,205` 12px | `text-[11px]` |
| 골든 배지 | `GoldenHourBadge.tsx:112` 10px, 21 | `GoldenHourLabel.tsx:29-31` 11px, 25 | `text-[10px] leading-[15px] py-[2px]` |
| 최단 대기 칩 안 '추정' | `:1184` 10px | `waiting.tsx:102` 11px | `text-[10px]` |
| NowChip | `NowChip.tsx:29` 10px | `features/waiting/NowChip.tsx:22` 11px | G5a-04 |

- 차이: Expo 글자가 체계적으로 1px 크고, 하단 띠가 9px 높다. 그래서 메뉴가 2줄로 접히고 카드가 길어진다(G5a-11).
- 중요도: P1 · 분류: 글꼴
- 고칠 방법:
  1) 표의 '바꿀 값' 대로 클래스를 바꾼다.
  2) 166행 하단 띠는 `flex-row items-center justify-center gap-[2px] border-t border-line/70 px-[4px] py-[6px]` 만 남긴다. 카드 전체가 버튼이라 띠에 따로 누르는 높이가 필요 없다.
- 바꿀 Expo 파일: `features/waiting/WaitingCards.tsx`, `GoldenHourLabel.tsx`, `NowChip.tsx`, `app/(tabs)/waiting.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 큰 글자 설정에서는 최대 1.6배까지만 커진다(기존 기본값).
- 확인 방법: `graded:card` 측정의 글꼴 크기와 상자 높이를 표의 웹 값과 맞춰 보고, `13-graded-card-zoom` 에서 메뉴가 한 줄인지 본다.
- 크기: S · 의존: 없음

### G5a-13 한국어 줄바꿈 — Expo 웹 빌드가 음절 사이에서 끊음
- 화면·상태: 카드 소개·메뉴, 행 이름 등 여러 줄 한국어
- 스크린샷: 13-graded-card-zoom(Expo 소개 "한옥으" / "로"), 50-long-text-card
- 웹(기준): `W:app/globals.css:167-170` `html:lang(ko) body { word-break: keep-all; overflow-wrap: break-word }`, 머리줄 `break-keep`(`page.tsx:455-457`). 측정 `word-break: keep-all`.
- Expo(현재): `M:components/ui/Text.tsx:56` 은 안드로이드에만 U+2060 을 넣고 iOS 는 `hangul-word` 를 쓴다. 웹 빌드는 아무것도 하지 않아 `word-break: normal` 이다.
- 차이: Expo 웹에서 한국어 낱말이 줄 끝에서 쪼개진다.
- 중요도: P2 · 분류: 글꼴
- 고칠 방법: `Text.tsx` 에서 `Platform.OS==='web'` 이고 언어가 ko 이면 스타일 `{wordBreak:'keep-all', overflowWrap:'break-word'}` 를 붙인다. react-native-web 이 이 스타일을 CSS 로 그대로 낸다.
- 바꿀 Expo 파일: `components/ui/Text.tsx`(전역 — G2 가 맡는다)
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드(U+2060)와 iOS(hangul-word)의 실제 줄바꿈 자리가 웹과 같은지 기기에서 확인해야 한다.
- 확인 방법: `13-graded-card-zoom` 에서 Expo 소개가 낱말 단위로 접히는지 본다.
- 크기: S · 의존: G2
- 표시: 네이티브 확인 필요

### G5a-14 대표 카드 순위 원 — 1위 그라데이션·그림자 없음
- 화면·상태: 대표 카드 왼쪽 위 1·2·3 원
- 스크린샷: 13-graded-card-zoom
- 웹(기준): `page.tsx:1342-1349` `absolute top-1.5 left-1.5 h-7 w-7 rounded-full border-2 border-white text-[13px] font-extrabold text-white shadow-[0_2px_8px_rgba(193,154,62,0.45)]`. 1위는 `bg-gradient-to-br from-gold to-gold-deep`, 2·3위는 `bg-gold`.
- Expo(현재): `WaitingCards.tsx:133` 1위 `bg-gold-deep` 단색, 2·3위 `bg-gold`, 그림자 없음.
- 차이: 1위 원 톤이 다르고, 세 원 모두 그림자가 없다.
- 중요도: P2 · 분류: 색·효과
- 고칠 방법:
  1) 바깥 래퍼에 `boxShadow:'0px 2px 8px rgba(193,154,62,0.45)'` 를 준다.
  2) 안쪽 원은 `overflow-hidden` 으로 두고, 1위만 `<Gradient colors={[colors.gold, colors['gold-deep']]} start={{x:0,y:0}} end={{x:1,y:1}} style={StyleSheet.absoluteFill}/>` 를 깐다. `Gradient` 는 colors·start·end 를 직접 받는다.
- 바꿀 Expo 파일: `features/waiting/WaitingCards.tsx`
- 문구(i18n): 없음
- 네이티브 주의: iOS 는 `overflow:hidden` 인 뷰의 그림자를 자르므로 래퍼를 나눠야 한다.
- 확인 방법: `graded:geometry.rank` 의 `bgImg`·`shadow` 를 웹과 비교한다.
- 크기: S · 의존: 없음

### G5a-15 사진 없는 장소 표지 — 웹 '경주 문양 + 유형 그림 받침' vs Expo '단색 + 이모지'
- 화면·상태: 사진이 없거나, 아직 안 받았거나, 깨진 카드(112px)와 행 썸네일(48px)
- 스크린샷: 23-nophoto-restaurant, 24-nophoto-tile-zoom, 25-nophoto-row-thumb-zoom, 36-cached-150ms
- 웹(기준): `W:components/PlacePhotoFallback.tsx:88-135`.
  - 판: `.place-tile`(`globals.css:332-338`) — 바탕 tile 13% 섞은 한지색, 가운데 밝은 방사형, 160deg 선형.
  - 문양: 장소마다 정해진 SVG 한 점(기와·수막새·석탑·물결·문살, `viewBox 0 0 100 112`, `xMidYMid slice`). 선은 tile 색 1.4, 불투명도 .5, 좌우 −6~+6 비낌.
  - 받침: 세로 54% 자리에 44px 원(`bg-hanji/90 ring-1 ring-current/40`, 그림자 `0 2px 10px rgba(43,35,32,.12)`), 안에 lucide 20px/1.8. 그림은 Utensils·Coffee·Mountain·Landmark·MapPin(`:16-22`).
  - 색: slate `#5b6878`, indigo `#465a8c`, stone `#77736c`.
  - 대표 카드 한 줄에서는 문양이 겹치지 않게 `placeVisualsForRow` 를 쓴다(`page.tsx:1319`). 행 썸네일도 같은 표지다.
- Expo(현재): `M:features/waiting/PlaceTile.tsx:43-49` 는 `bg-tile-*-bg` 단색 위 이모지(카드 30px, 행 20px)다. PORTING 의 의도적 생략이다.
- 차이: 사진 없는 카드의 모양이 완전히 다르고, 사진을 받는 동안에도 보인다.
- 중요도: P1 · 분류: 아이콘·이미지
- 고칠 방법:
  1) 공용 `components/PlacePhotoFallback.tsx` 를 새로 만든다. 웹 파일의 문양 경로 함수(`scallopRows`·`roundelEmblem`·`pagodaEmblem`·`waveEmblem`·`latticeEmblem`, `EMBLEM`)를 그대로 옮긴다. `react-native-svg` 의 `<Svg viewBox="0 0 100 112" preserveAspectRatio="xMidYMid slice"><Path … stroke={tile} strokeWidth={1.4} opacity={0.5} vectorEffect="non-scaling-stroke" transform={`translate(${shift} 0)`}/></Svg>` 로 그린다.
  2) 판 바탕은 토큰 `tile-*-bg` 위에 `RadialGradient`(한지 45%→58% 투명)와 160deg `LinearGradient`(tile 12%→72% 투명)를 겹친다.
  3) 44px 원은 `bg-hanji/90`, 1px 테두리 tile 40%, 그림자를 주고, 안에 `Icon` 20/1.8 tile 색을 둔다.
  4) `PlaceTile` 의 이모지 자리를 이 표지로 바꾸고, `SectorBoard` 대표 카드 줄에는 `placeVisualsForRow` 결과를 넘긴다.
- 바꿀 Expo 파일: `components/PlacePhotoFallback.tsx`(새), `features/waiting/PlaceTile.tsx`, `features/waiting/SectorBoard.tsx`, `features/waiting/WaitingCards.tsx`
- 문구(i18n): 없음(장식)
- 네이티브 주의: react-native-svg 가 `vectorEffect` 를 지원한다. 대안 화면 `PhotoCover` 도 같은 표지를 쓰게 하면 화면 사이 모양이 맞는다(G4).
- 확인 방법: `02-scenarios.mjs nophoto` 로 `24`·`25` 그림을 비교한다.
- 크기: M · 의존: G4
- 표시: 결정 필요 — (a) 공용 표지로 포팅(권장), (b) 이모지 유지.

### G5a-16 사진 후보 — Wikimedia·경주시·사장님 사진을 빼서 출처 줄이 없고 대표 카드 순서가 바뀜
- 화면·상태: 섹터에 Wikimedia(관광지)·경주시(음식점)·사장님 사진만 있는 장소가 있을 때. 데이터에 따라 생긴다 — 공유 픽스처에는 없어서 목으로 재현했다.
- 스크린샷: 26-photo-sources-restaurant, 27a-photo-credit-zoom, 27b-photo-credit-zoom
- 웹(기준):
  - 사진 후보: `page.tsx:592-595` `[merchantPhotoUrl(features), ...photoCandidates(imageUrl, galleryImages)]`.
  - 대표 카드: `creditedPhotoUrls`(`:1323`)를 쓴다. 행 썸네일은 `uncreditedPhotoUrls`(`:117-119,1403`)를 쓴다.
  - 출처 칸(`:1377-1379`): 출처 후보가 있는 줄이면 `min-h-9 pt-2`, 없으면 `min-h-4`. 사진이 다 보인 뒤에만 `PhotoCreditLink stacked`(`W:components/PhotoCreditLink.tsx:51-63`, 10px/14px underline muk-soft, 원문 새 창)를 단다. 경주시는 `common.cityPhotoCredit`.
  - 정렬 동점 판정(`:1272`): `hasPhoto: creditedPhotoUrls(...).length > 0`.
  - 측정(같은 추정 등급 5곳 목): 대표 = 호랑이카츠(Wikimedia + "Jane Doe (Wikimedia) / CC BY-SA 4.0"), 우직(경주시 + "사진: 경주시"), 청온채(사장님 사진). 행 = 피자옥, 향화정.
- Expo(현재):
  - `M:features/waiting/boardData.ts:170-185` 의 `photoUrlsOf` 가 wikimedia·gyeongju 주소를 빼고, 사장님 사진은 아예 다루지 않는다.
  - 정렬은 `M:features/waiting/boardView.ts:85` `hasPhoto: row.imageUrls.length>0` 다. 출처 UI 가 없다.
  - 측정(같은 목): 대표 = 피자옥, 향화정(이모지), 호랑이카츠(이모지). 행 = 우직, 청온채(이모지). 출처 줄 0개.
- 차이: 같은 데이터에서 대표 1위가 다른 장소이고, 사진 3장이 표지로 바뀌며, 출처 줄이 없다.
- 중요도: P0 · 분류: 동작
- 고칠 방법:
  1) `BoardRow` 에 `imageSource`·`cityPhoto` 를 더하고 `...photoCreditFeatures(features)` 로 채운다. `imageUrls` 는 `[merchantPhotoUrl(features), ...photoCandidates(imageUrl, gallery)]` 에서 중복과 빈 값을 뺀 목록이다. 필요한 함수는 모두 `M:features/explore/port/photoCredit.ts` 에 이미 있다(`merchantPhotoUrl` 은 `env.supabaseUrl` 을 쓴다). https 변환은 그릴 때 `toHttpsImageUrl` 로 한다. `photoUrlsOf`·`needsCredit` 는 지우고 `boardData.test.ts` 를 새 규칙으로 고친다.
  2) `boardView.ts:85` 를 `hasPhoto: creditedPhotoUrls(row.imageUrls, {imageSource: row.imageSource, cityPhoto: row.cityPhoto ?? null}).length > 0` 으로 바꾼다.
  3) 대표 카드는 `creditedPhotoUrls` 로 사진을 고른다. 각 카드를 `<View style={{width}}>` 로 감싸고, 카드 아래에 출처 칸 `min-h-[36px] pt-[8px]`(rowMayCredit) 또는 `min-h-[16px]` 를 둔다. 사진이 다 받아진 뒤 `creditForDisplayedPhoto` 가 있으면 출처 링크를 그린다. 링크는 `M:features/explore/PhotoCover.tsx:87-108` 의 출처 줄을 작가 한 줄·라이선스 한 줄짜리 공용 `components/ui/CreditLine.tsx` 로 빼서 쓴다. `rowMayCredit = topRows.some(r => mayShowPhotoCredit(creditedPhotoUrls(r.imageUrls, f), f))`.
  4) 행 썸네일은 `imageUrls` 에서 `isWikimediaUrl`·`isCityPhotoUrl` 을 뺀 목록을 쓴다.
- 바꿀 Expo 파일: `features/waiting/boardData.ts`, `boardView.ts`, `SectorBoard.tsx`, `WaitingCards.tsx`, `PlaceTile.tsx`, `features/explore/PhotoCover.tsx`(출처 줄 분리) + `components/ui/CreditLine.tsx`(새)
- 문구(i18n): 재사용 `common.cityPhotoCredit` / 새 키 없음
- 네이티브 주의: 출처 링크는 `openExternalUrl`(외부 브라우저)로 연다. 사장님 사진은 공개 버킷이라 인증 없이 받는다.
- 확인 방법: `02-scenarios.mjs photos` 를 돌리고 `photos:order` 를 본다. Expo `firstSector` 가 [호랑이카츠, 우직, 청온채], 사진 3장, 출처 줄 2개면 같다.
- 크기: M · 의존: G5a-18, G4
- 표시: 결정 필요 — (a) 웹처럼 출처 줄과 함께 세 종류 사진을 쓴다(권장 — Expo 대안 화면은 이미 출처 줄이 있다), (b) 계속 빼되 정렬 판정만 맞춘다.

### G5a-17 카드·행 그림자·바탕, 행 셰브런 색·크기
- 화면·상태: 대표 카드(2·3위), 행
- 스크린샷: 03-restaurant-rows, 14-graded-rows-zoom
- 웹(기준):
  - 카드: `page.tsx:1333-1337` 그림자 `0 2px 14px rgba(43,35,32,.06)`, 2·3위 바탕 `bg-white/90`.
  - 행: `:1410` `bg-white/90` + 같은 그림자.
  - 셰브런: `:1446-1450` `size 18`, `text-muk-soft/50`.
- Expo(현재): 카드 `WaitingCards.tsx:129` 와 행 `:242` 는 `bg-white` 에 그림자가 없다. 셰브런 `:262` 은 20px, muk-soft 100%.
- 차이: 그림자가 없고, 행 화살표가 크고 진하다.
- 중요도: P2 · 분류: 색·효과
- 고칠 방법:
  1) 2·3위 카드를 `bg-white/90` 로 바꾸고, 바깥 래퍼에 `boxShadow: shadows.card` 를 준다(카드가 `overflow-hidden` 이라 래퍼에).
  2) 행도 `bg-white/90` 과 `shadows.card`.
  3) 셰브런은 `<Icon icon={ChevronRight} size={18} color="rgba(107, 93, 79, 0.5)"/>`.
- 바꿀 Expo 파일: `features/waiting/WaitingCards.tsx`
- 문구(i18n): 없음
- 네이티브 주의: iOS 그림자 잘림은 G5a-14 와 같은 방법으로 피한다. 캐러셀 `contentContainerStyle` 에 세로 여백 2~4px 를 준다.
- 확인 방법: `graded:geometry` 의 `cards`·`row`·`chevron` 값을 웹과 비교한다.
- 크기: S · 의존: 없음

### G5a-18 카드 줄 아래 간격 — 출처 칸·점 줄·골든 빈 줄
- 화면·상태: 대표 카드 → 점 → 골든 → 행 사이(모든 섹터)
- 스크린샷: 11-graded-restaurant, 06-culture, 28-single-card-sector
- 웹(기준):
  - 카드 래퍼: `grid-rows-[1fr_auto]` + 출처 칸 `min-h-4`(16px, 출처 후보가 있으면 36px), `page.tsx:1329,1377`.
  - 점: `SwipeDots.tsx:27` `mt-2`, 높이 6.
  - 골든: `page.tsx:1391-1395` `<div className="mt-2">` 가 배지가 숨어도 늘 생겨 빈 8px 를 남긴다.
  - 행: `mt-2.5`.
  - 측정(S1): 카드 아래 375.2 → 점 399.2 → 점 끝 405.2 → 골든 416.2 → 첫 행 447.2.
- Expo(현재):
  - 출처 칸이 없다.
  - 점: `SectorBoard.tsx:52` `mt-[8px] min-h-[24px]`.
  - 골든: 176행에서 배지가 있을 때만 `mt-[8px]`.
  - 측정: 카드 아래 401 → 점 418 → 점 끝 424 → 골든 441 → 첫 행 476.
- 차이: 카드→점이 7px 짧고, 점→골든이 6px 길다. 1~2곳 섹터에서는 판이 24px 짧다.
- 중요도: P2 · 분류: 크기·간격
- 고칠 방법:
  1) 카드마다 아래에 출처 칸을 둔다(G5a-16 3번, 출처 후보가 없으면 16px).
  2) 점 줄은 `mt-[8px] h-[6px]` 로 바꾼다(`min-h-[24px]` 삭제, 누르는 자리가 필요하면 `hitSlop`).
  3) 골든은 `committed && topRows[0]` 일 때 `<View className="mt-[8px]">` 로 감싸고, `GoldenHourLabel` 자체의 `mt` 는 지운다.
- 바꿀 Expo 파일: `features/waiting/SectorBoard.tsx`, `WaitingCards.tsx`, `GoldenHourLabel.tsx`
- 문구(i18n): 없음 · 네이티브 주의: 없음
- 확인 방법: `graded:geometry` 의 y 간격과 `mixed:sectorGeom` 섹터 높이를 웹과 비교한다.
- 크기: S · 의존: G5a-16

### G5a-19 골든타임 배지 크기 + '알림 받기' 버튼 없음
- 화면·상태: 다 찬 보드, 섹터 1위 골든타임이 있을 때
- 스크린샷: 11-graded-restaurant, 19-swipe-2of3, 53-en-restaurant
- 웹(기준): `W:components/GoldenHourBadge.tsx:110-134`.
  - 배지: `px-2 py-0.5 rounded-md text-[10px] font-bold border bg-jade/10 border-jade/30 text-jade`, 내용 "🕐 오늘 한산: 16~17시", 측정 109.7×21.
  - 버튼(`Notification` 이 있을 때): `inline-flex gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold border bg-white/70 border-line text-muk-soft` + `Bell 10` + `golden.notifyCta`. aria-label 은 `golden.notifyAria`, 측정 58.5×21.
  - 누르면: 권한을 받고 시작 시각에 로컬 알림을 예약한다. 버튼은 `BellRing` + `golden.notifyScheduled`(jade, 비활성)로 바뀐다. 헤드리스에서도 버튼이 보였다(권한은 denied).
- Expo(현재): `GoldenHourLabel.tsx:28-34` 는 배지만 있다(`py-[4px] text-[11px]`, 측정 119.3×25). 알림 버튼이 없다(PORTING '알림 없는 v1', 인벤토리 D5).
- 차이: 배지가 조금 크고, '알림 받기' 버튼이 없다.
- 중요도: P1 · 분류: 누락
- 고칠 방법:
  1) 배지 크기는 G5a-12 표대로 맞춘다.
  2) 배지 옆에 `Pressable` 을 둔다: `flex-row items-center gap-[2px] rounded-md border border-line bg-white/70 px-[6px] py-[2px]` + `Icon Bell 10` + 10px bold `golden.notifyCta`, 라벨은 `golden.notifyAria`. 예약 후에는 `BellRing`·`golden.notifyScheduled`·jade·비활성으로 바꾼다.
  3) 동작: Expo 웹은 웹과 같은 `Notification` + `setTimeout`. 네이티브는 `expo-notifications` 의 `requestPermissionsAsync` + `scheduleNotificationAsync({content:{title: t('golden.notifyTitle'), body: t('golden.notifyBody',{start,end})}, trigger:{date}})`. 알림을 못 쓰는 환경이면 버튼을 숨긴다.
- 바꿀 Expo 파일: `features/waiting/GoldenHourLabel.tsx`(+ `package.json`·`app.json` 에 expo-notifications)
- 문구(i18n): 재사용 `golden.badge`, `golden.notifyCta`, `golden.notifyScheduled`, `golden.notifyAria`, `golden.notifyScheduledAria`, `golden.notifyTitle`, `golden.notifyBody` / 새 키 없음
- 네이티브 주의: 새 네이티브 빌드가 필요하다. 안드로이드 13+ 알림 권한과 정확한 알람 정책을 확인해야 한다. 저장 화면 골든타임(G4)도 같은 컴포넌트를 쓴다.
- 확인 방법: `02-scenarios.mjs graded` 에서 `graded:geometry.notify` 가 Expo 에도 생기는지, 배지가 21px 인지 본다.
- 크기: M(네이티브 알림까지는 L) · 의존: G4
- 표시: 결정 필요 — (a) 버튼까지 포팅, (b) 배지 크기만 맞춘다(지금 의도).

### G5a-20 캐러셀 스냅 — Expo 웹 빌드는 카드 중간에서 멈춤
- 화면·상태: 3곳 이상 섹터의 가로 넘김
- 스크린샷: 19-swipe-2of3
- 웹(기준): `page.tsx:1309` `snap-x snap-mandatory`, 카드 `:1329` `snap-start`. 측정 `scroll-snap-type: x mandatory`.
- Expo(현재): `SectorBoard.tsx:149-167` 의 `FlatList` 는 `snapToInterval`·`decelerationRate="fast"` 를 쓰지만, react-native-web 에서는 측정 `scroll-snap-type: none` 이다. 점 표시는 스크롤을 따라 1/3→2/3 으로 정상 갱신된다.
- 차이: Expo 웹에서 카드가 반쯤 걸친 채 멈출 수 있다.
- 중요도: P2 · 분류: 동작
- 고칠 방법: 웹 빌드에서만 `FlatList` `style` 에 `{scrollSnapType:'x mandatory'}`, 각 카드 래퍼에 `{scrollSnapAlign:'start'}` 를 준다.
- 바꿀 Expo 파일: `features/waiting/SectorBoard.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 네이티브는 `snapToInterval` 로 이미 붙는다.
- 확인 방법: Expo 웹에서 120px 만 끌었다 놓아 0 또는 274 위치로 붙는지, `graded:swipe` 의 `snap` 값을 본다.
- 크기: S · 의존: 없음
- 표시: 네이티브 확인 필요

### G5a-21 빈 상태 — CTA 가 금빛 그라데이션 알약 대신 흰 보조 버튼, 이모지·여백 작음
- 화면·상태: 네 유형 모두 빈 응답
- 스크린샷: 30-empty
- 웹(기준): 화면 전용 `EmptyState`(`page.tsx:1469-1484`).
  - 카드: `bg-white rounded-2xl border border-line shadow p-8 space-y-3`.
  - 🗺️ 36px(줄 40), 제목 15px bold(22.5), 본문 13px muk-soft(21.125).
  - CTA: `<Link href="/main" className="… min-h-11 px-5 rounded-full cta-primary text-[13px] font-bold shadow-[0_4px_14px_rgba(168,70,47,0.28)]">` — 그라데이션, 흰 글자.
  - 측정: 카드 358×229.6.
- Expo(현재): 공용 `M:components/ui/EmptyState.tsx:28-43`.
  - 패딩 28, 간격 10, 이모지 30, 제목 15/21(h1), 본문 13/19.
  - CTA 는 `Button variant="secondary"` 로 흰 바탕·선·먹 글자 14px `rounded-2xl`(`waiting.tsx:40-49`).
  - 측정: 카드 358×212.
- 차이: 주 버튼 색·모양, 이모지 크기, 여백, 줄 간격이 다르다. 본문은 가정 시간을 가리키는데 Expo 에는 그 컨트롤이 없다(G5a-05).
- 중요도: P1 · 분류: 상태(빈)
- 고칠 방법:
  1) 화면 전용 `features/waiting/BoardEmpty.tsx` 를 만든다. 공용 `EmptyState` 는 다른 묶음 화면이 써서 건드리지 않는다.
     - 카드: `Card` 패딩 32, `items-center gap-[12px]`, 그림자 card.
     - 🗺️ `text-[36px] leading-[40px]`, 제목 `text-[15px] leading-[22.5px]` bold(헤더 역할 없음), 본문 `text-[13px] leading-[21px] text-muk-soft`.
     - CTA: `Pressable` `min-h-[44px] overflow-hidden rounded-full px-[20px]` 안에 `<Gradient name="cta" style={StyleSheet.absoluteFill}/>` 를 깔고, 그림자 `shadows.cta`, 13px bold 흰 글자 `waiting.emptyCta`. 누르면 `router.navigate('/')`.
  2) `waiting.tsx:40-49` 를 `<BoardEmpty/>` 로 바꾼다.
  3) 가정 시간을 포팅하지 않으면 본문을 새 키로 바꾼다.
- 바꿀 Expo 파일: `features/waiting/BoardEmpty.tsx`(새), `app/(tabs)/waiting.tsx`
- 문구(i18n): 재사용 `waiting.emptyTitle`, `waiting.emptyBody`, `waiting.emptyCta` / 새 키(가정 시간을 포팅하지 않을 때만) `app.waiting.emptyBody` 를 ko·en·ja·zh 4로케일에 함께 추가
- 네이티브 주의: 없음
- 확인 방법: `02-scenarios.mjs empty` 를 돌리고 `empty:probe` 의 카드 229.6px 와 CTA 그라데이션을 확인한다.
- 크기: S · 의존: G5a-05

### G5a-22 오류 상태 — 버튼이 금 진 단색 + 회전 아이콘, 메시지 글자·이모지 다름
- 화면·상태: by-type 전부 실패(자동 재시도 뒤)
- 스크린샷: 38-error
- 웹(기준): 화면 전용 `ErrorState`(`page.tsx:1486-1501`).
  - 카드: `border-terracotta/25 p-8 space-y-3` + 그림자.
  - ⚠️ 36px, 메시지 15px bold(22.5).
  - 버튼: `min-h-11 px-5 rounded-full cta-primary text-[13px] font-bold` + 그림자, 아이콘 없음.
  - 측정: 카드 358×196.5, 버튼 82.2×44 그라데이션.
- Expo(현재): 공용 `M:components/ui/ErrorState.tsx:82-111`.
  - 카드: `role="alert"`, 패딩 32, 간격 12.
  - ⚠️ 30px, 메시지 14px semibold.
  - 버튼: `bg-gold-deep` 단색 `px-[18px]` + `RotateCw` 14px.
  - 측정: 카드 358×190, 버튼 98.5×44.
- 차이: 버튼 바탕·아이콘·그림자가 다르고, 메시지가 1px 작고 얇으며, 이모지가 작다.
- 중요도: P1 · 분류: 상태(오류)
- 고칠 방법:
  1) 화면 전용 `features/waiting/BoardError.tsx` 를 만든다. 공용 `ErrorState` 는 코스·쿠폰·문의·실험실·대안·홈·추천 시트가 함께 쓴다.
     - 카드: 패딩 32, `gap-[12px]`, 테두리 `rgba(193,85,59,0.25)`, 그림자 card.
     - ⚠️ `text-[36px] leading-[40px]`, 메시지 `text-[15px] leading-[22.5px]` bold.
     - 버튼: `min-h-[44px] rounded-full px-[20px] overflow-hidden` + `Gradient name="cta"` + 그림자 cta + 13px bold 흰 `common.retry`, 아이콘 없음.
     - 읽기 화면 알림(`announceForAccessibility`)은 남긴다.
  2) `waiting.tsx:39` 를 `<BoardError message={t('waiting.fetchError')} onRetry={retry}/>` 로 바꾼다.
- 바꿀 Expo 파일: `features/waiting/BoardError.tsx`(새), `app/(tabs)/waiting.tsx`
- 문구(i18n): 재사용 `waiting.fetchError`, `common.retry`
- 네이티브 주의: 없음
- 확인 방법: `02-scenarios.mjs error` 를 돌리고 `error:probe` 의 버튼 `bgImg` 그라데이션과 메시지 15px 를 확인한다.
- 크기: S · 의존: 없음

### G5a-23 '다시 시도' 동작 — 계속 실패하면 Expo 가 자동 재시도를 한 번 더 붙임
- 화면·상태: 오류 상태에서 '다시 시도'를 눌렀는데 또 실패할 때
- 스크린샷: 38-error(시작 상태)
- 웹(기준): `page.tsx:1249` 는 `resetBackoff()` 와 `fetchBoard()` 만 부른다. 자동 재시도 표식 `retriedRef`(`:819`)와 `serviceUnavailableRetriedRef`(`:824`)는 그대로 둔다. 측정(503 유지): 요청 8건, 2.2초 만에 다시 오류.
- Expo(현재): `useWaitingBoard.ts:226-231` 의 `retry` 가 두 표식을 되돌린다. 측정: 요청 16건, 로더 4.8초. 첫 실패는 두 앱 모두 16건으로 같다.
- 차이: 실패가 이어질 때 Expo 로더가 2배 오래 돌고 요청도 2배다.
- 중요도: P2 · 분류: 동작
- 고칠 방법:
  1) 웹과 같게 228·229행을 지운다.
  2) 웹 쪽이 실수로 보이면 웹을 고치는 별도 결정이 필요하다 — 그때는 Expo 를 그대로 둔다.
- 바꿀 Expo 파일: `features/waiting/useWaitingBoard.ts`
- 문구(i18n): 없음 · 네이티브 주의: 없음
- 확인 방법: `node scratch/parity/work/G5a/04-retry.mjs` 를 돌려 `retryStillFailing` 의 Expo 가 8건·약 2.2초인지 본다.
- 크기: S · 의존: 없음

### G5a-24 다시 열 때 새로고침 — 웹은 방문마다 조용히, Expo 는 5분 지났을 때만
- 화면·상태: 다른 탭에 갔다가 대기 보드로 돌아옴
- 스크린샷: 촬영 못 함(시간이 지나야 보이는 동작) — 코드로 비교
- 웹(기준): 대기 보드가 라우트라서 돌아올 때마다 다시 마운트된다. 캐시를 먼저 그린 뒤 by-type 4건을 로더 없이 다시 받는다(`page.tsx:840-853, 1019-1023, 882`).
- Expo(현재): 탭이 마운트된 채 남는다. `useFocusEffect` 는 마지막 성공에서 5분이 넘었을 때만 새로고침한다(`useWaitingBoard.ts:31, 206-214`).
- 차이: 5분 안에 돌아오면 Expo 는 요청 없이 이전 보드를 그대로 보인다.
- 중요도: P2 · 분류: 동작
- 고칠 방법: 212행을 `if (hasResultsRef.current) void fetchBoard();` 로 바꾸고 `REFRESH_AFTER_MS` 를 지운다. 첫 포커스는 지금처럼 건너뛴다.
- 바꿀 Expo 파일: `features/waiting/useWaitingBoard.ts`
- 문구(i18n): 없음
- 네이티브 주의: 탭을 오갈 때마다 4건씩 나가므로 서버 부하는 웹 사용자와 같아진다.
- 확인 방법: 홈↔대기를 1분 안에 두 번 오가면서 by-type POST 가 매번 4건씩 나가는지 본다(`policyEvents()`).
- 크기: S · 의존: 없음
- 표시: 결정 필요 — (a) 웹과 같게 매번(권장), (b) 서버 부하를 이유로 5분 규칙 유지.

### G5a-25 접근성 — 제목 h1 남발, aria-busy 없음, 점 줄 slider, 카드 라벨·로더 알림 차이(Expo 웹 빌드)
- 화면·상태: 모든 상태
- 스크린샷: — (DOM 측정: `graded:geometry`·`loading:a11y`·`partial:busy`)
- 웹(기준): 화면 제목 `h1`(`:1157`), 섹터 `h2`(`:1294`), 빈 제목 `p`. 보드에 `aria-busy={loading}`(`:1253`). 점 줄 `aria-hidden`(`SwipeDots.tsx:27`). 카드는 버튼 안 글자를 그대로 읽는다. 로더 `role="status" aria-live="polite"`. 오류 카드에는 역할이 없다.
- Expo(현재): `accessibilityRole="header"` 가 웹 빌드에서 모두 `h1` 이 된다(`waiting.tsx:81`, `SectorBoard.tsx:134`, `EmptyState.tsx:38`). `accessibilityState={{busy}}`(`waiting.tsx:51`)는 DOM 에 `aria-busy` 를 만들지 않는다(측정: 없음). 점 줄은 `role="slider" aria-label="음식점"` 인데 값이 없다(`SectorBoard.tsx:52-58`). 카드는 `aria-label="1 / 3, 청온채, 예상 대기 약 3분, 대신 갈 곳 보기"` 다. 로더는 aria-label 만 있다. 오류 카드는 `role="alert"`.
- 차이: 읽기 화면에서 제목 구조·로딩 알림·점 줄이 다르다. Expo 쪽이 더 나은 부분도 있다.
- 중요도: P2 · 분류: 접근성
- 고칠 방법:
  1) 섹터 이름에 `aria-level={2}` 를 주고, 빈 상태 제목에서는 헤더 역할을 뺀다(G5a-21).
  2) 보드 `View` 에 `aria-busy={loading}` 을 직접 준다.
  3) 웹 빌드에서만 점 줄을 숨긴다. 네이티브의 `adjustable`('음식점, 1 / 3' + 위아래 쓸기)은 남긴다.
  4) 로더 알림은 G5a-09 가 맡는다. 카드 라벨과 오류 `alert` 은 유지하기를 권한다.
- 바꿀 Expo 파일: `app/(tabs)/waiting.tsx`, `features/waiting/SectorBoard.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 네이티브는 제목 단계가 없고, `adjustable`·`busy` 가 그대로 동작한다. 1·3번은 웹 빌드에만 해당한다.
- 확인 방법: 웹 빌드 DOM 에서 `h2` 4개, `[aria-busy]`, 점 줄 `aria-hidden` 을 확인한다.
- 크기: S · 의존: G5a-09, G5a-21
- 표시: 네이티브 확인 필요

---

## 촬영하지 못한 상태
- '알림 받기'를 누른 뒤 '예약됨' 상태: 헤드리스 권한이 denied 이고 README 가 누르지 말라고 해서 코드로만 비교했다(G5a-19).
- Expo 탭 복귀 새로고침(5분 규칙): 시간 경과 동작이라 코드로 비교했다(G5a-24).
- 세션이 없을 때 로더를 유지하고 다시 묻는 흐름, `SIGNED_IN` 뒤 스스로 다시 채우는 흐름: 게스트를 새로 만들어야 해서 하지 않았다. 두 앱 코드 흐름은 같다(웹 `page.tsx:907-921, 1029-1036`, Expo `useWaitingBoard.ts:111-121, 217-224`).
- 오프라인: 오류 상태와 같은 코드 경로라 따로 찍지 않았다.
- 캐러셀 3/3: 2/3 만 찍었다.
- 웹 hover·포커스 고리: 폰 기준이라 제외했다.

## 열린 질문
1. 탭 화면인 Expo 에 웹의 뒤로 버튼을 그대로 둘지(G5a-01).
2. 가정 시간 프리셋을 세 화면에 포팅할지(G5a-05). 빈 상태 문구(G5a-21)가 이 결정에 달려 있다.
3. 골든타임 알림을 네이티브 알림 모듈까지 넣을지(G5a-19). 새 네이티브 빌드가 필요하다.
4. 웹의 두 동작이 의도치 않은 것으로 보인다: 재시도할 때 자동 재시도 표식을 되돌리지 않는 것(G5a-23), 골든 배지가 없어도 빈 8px 줄이 남는 것(G5a-18, `page.tsx:1391-1395`). 그래도 이 문서는 웹을 기준으로 맞추는 안을 적었다.

## 다른 묶음에 넘길 것
- G2: 하단 탭 막대가 다르다. 웹은 101px 유리 막대에 '서비스 소개·사장님 콘솔·관제 대시보드' 줄과 활성 알약이 있고, Expo 는 약 50px 한지 막대다. 대기 보드 아래 끝을 덮는 높이가 달라진다.
- G2: 전역 줄 높이. 웹은 기본 1.5 를 물려받고 Expo `Text` 는 `normal` 이다(G5a-08).
- G2: 누름 피드백. 웹 `.toss-pressable` 은 scale .96 + brightness .94, Expo `Pressable` 은 opacity .88 + scale .96 이다.
- G2: Expo 웹 빌드에 한국어 `keep-all` 줄바꿈이 없다(G5a-13, 전역 `Text`).
- G4: 대안 화면 `PhotoCover` 와 사진 없는 표지·출처 줄을 공용으로 묶는다(G5a-15, G5a-16). 코스 가정 시간(G4-CRS-23)과 공용 모듈을 함께 정한다(G5a-05). 저장 화면 골든타임 배지(G5a-19)도 같은 컴포넌트다.
- 메인 세션: 05:11Z 무렵 `nextspot.expo.app`(EAS Hosting 무료 등급)이 문서·글꼴 요청에 429 를 냈다. 하네스의 429 대기는 API 요청에만 걸린다.
