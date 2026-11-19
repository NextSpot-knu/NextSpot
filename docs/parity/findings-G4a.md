# G4a 저장·대안 — 웹(기준) ↔ Expo 화면 비교 결과

- 범위: [SAV] 웹 `/saved` ↔ Expo `/saved`, [EXP] 웹 `/explore/recommend` ↔ Expo `/explore/recommend`, [EXM] 웹 `/explore/map` ↔ Expo(없음).
- 기준 코드: `yunseong` `c6374ab`(작업 트리). 웹 `app/saved/page.tsx`·`app/explore/recommend/page.tsx`·`components/RecommendationComparison.tsx` 는 Expo 이식 기준 커밋 `0d145a1` 이후 바뀌지 않았다(`git log 0d145a1..HEAD` — ko.json 의 다른 키만 바뀜). 그래서 아래 차이는 '이식하면서 생긴 차이'이고, 웹이 그 뒤에 바뀌어 생긴 차이는 없다.
- 실행: 공용 하네스(390×844 @2x, ko-KR, Asia/Seoul, 공유 게스트 `state:'saved'`). 웹 `http://localhost:3000`, Expo `https://nextspot.expo.app`. 화면에 보인 Expo 동작은 전부 작업 트리 코드와 맞았다(배포판과 코드가 어긋난 곳 없음).
- 시드·모킹(전부 화면 쪽, 운영 쓰기 0): 저장 목록은 공용 픽스처 장소 5곳을 웹 `handlePutOff` 모양(`spot.score` 0~100)으로 `nextspot_saved_facilities` 에 시드. 골든타임·혼잡 추정 피드는 `mockGet`. 대안 목록은 `overlays/G4a/<변형>/`(픽스처 복사본, 추정 시각만 '지금−3분'으로 다시 찍음). 정책 로그(G4a 실행 전체): fixture 88 · mocked 79 · blocked-write 35(API 7, saved_facilities 28) — 가입·LLM·픽스처 누락·토큰 갱신 실패·운영 401/5xx 0. 콘솔 오류는 일부러 만든 500 뿐.
- 스크린샷: `scratch/parity/shots/G4a/*.pair.png`(왼쪽 웹 · 오른쪽 Expo). 스크립트·측정값: `scratch/parity/work/G4a/`(`out/*.json` 에 계산된 스타일 값).
- 측정 숫자는 브라우저 `getComputedStyle`·`getBoundingClientRect` 값이다(CSS px). Expo 글자는 react-native-web 이 `div` 로 그린다.

## 요약

| 중요도 | 개수 | ID |
|---|---|---|
| **P0** | 8 | G4a-01, 06, 12, 13, 15, 17, 22, 26 |
| **P1** | 17 | G4a-03, 04, 05, 07, 08, 10, 16, 18, 19, 21, 23, 24, 25, 28, 29, 30, 31 |
| **P2** | 6 | G4a-02, 09, 11, 14, 20, 27 |
| 합계 | **31** | `결정 필요` 7건(06·13·15·17·19·26·30), `네이티브 확인 필요` 6건(06·12·13·15·18·25) |

가장 중요한 5개

1. **G4a-15 대안 화면 맨 위** — 웹은 내용 안 44px 흰 원형 '지도 보기' 버튼(스크롤하면 사라짐, 누르면 **항상 `/main`**), Expo 는 약 64px 네이티브 스택 헤더(위에 고정, 30×30 화살표, 접근 이름 **`"(tabs), back"`**, 누르면 **이전 화면** — 대기 탭에서 왔으면 `/waiting`). 첫인상·뒤로 가기 목적지·접근성이 모두 다르다.
2. **G4a-13 저장 카드 상세** — 웹은 화면 전체를 덮는 베일 + 아래 가운데 떠 있는 카드(밖 누르기·Esc 로 닫힘), Expo 는 베일 없는 바텀시트. Expo 에만 '일단 킵하고 · 다음 후보 볼래요' 버튼, 머리 칩 웹 'AI 추천' ↔ Expo '선택한 장소', '바로 갈래요' 는 웹이 카카오맵 열기만, Expo 는 서버 수락·여정 기록까지.
3. **G4a-17 🎙 음성 비서 없음 → 대안 카드 폭이 다르다** — 웹은 48px 🎙 버튼 + 목록 오른쪽 56px 비움(`max-md:pr-14`)이라 카드 302px, Expo 358px. 웹만 '바로 갈래요 (도보 길안내)'·혜택 칩·근거 칩이 두 줄.
4. **G4a-22 혼잡 제보 버튼 없음** — 웹 보조 행동 줄의 '지금 붐비나요? 알려 주세요'/'혼잡 제보' 가 Expo 에 없다. Expo 에 같은 모양·API 의 `features/recommendation-card/CongestionReportButton.tsx` 가 이미 있다.
5. **G4a-26 '순서 자세히' → '상위 추천 비교하기'** — 웹은 가로 표(`min-w-[520px]`, 옆으로 밀어 보기), Expo 는 지표별 세로 묶음(의도적 변경). 그 밖의 P0: G4a-01 저장 화면 로고 머리 없음, G4a-06 '한산해지면 알림 받기' 행·골든타임 '알림 받기' 없음, G4a-12 '전체 초기화' 확인(웹 화면 안 토스트 버튼 ↔ Expo 브라우저 `confirm`·안드로이드 시스템 Alert).

참고: 대안 화면에 '테마 칩'은 웹에도 없다(`discoveryTheme` 은 `/main` 만). 머리글 제목 분기, 붐빔 알약 판정, 영역 한 줄, 종류 폴백 안내, 👍/👎 뒤 '기록했어요', '다른 대안 보기' 토스트, 보류 삭제 반영, 정렬·필터 자동 복귀는 두 앱이 같은 문구·같은 판정으로 나왔다 — 차이는 모양·배치·빠진 요소·몇몇 동작이다.

---

## [SAV] 저장 — 웹 `/saved` ↔ Expo `/saved`

### G4a-01 저장 화면 틀 — 로고 머리 없음 · 바깥 여백 24px→16px
- 화면·상태: G4-SAV-01·03·04(목록·로딩·빈 상태 모두)
- 스크린샷: `shots/G4a/sav-01-list-top.pair.png`, `sav-03-loading.pair.png`, `sav-04-empty.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:219-224` `<header class="flex justify-center items-center p-5 border-b border-line">` 안에 로고 `/nextspot-logo.png`(505×109, `h-7 w-auto` = 높이 28, 폭 ≈130, `alt="NextSpot"`). 머리 높이 69px(28+20+20+선 1). 머리는 스크롤 영역 **밖** — 목록을 내려도 위에 남는다. 본문 `main` `p-6`(사방 24px) `overflow-y-auto`(`:227`) — 히어로 x=24, 폭 342, y=93.
- Expo(현재): `apps/mobile/app/(tabs)/saved.tsx:116` `Screen … contentClassName="px-[16px] pb-[24px] pt-[16px]"` — 머리 없음, 히어로 x=16, 폭 358, y=16. 탭 헤더도 없음(`app/(tabs)/_layout.tsx:48` `headerShown:false`). 로고 그림 파일도 앱에 없다(`apps/mobile/assets/images/`).
- 차이: 첫 화면 위 69px 로고 띠가 Expo 에 없고, 내용이 좌우로 8px씩 넓다(카드 342 ↔ 358). 로딩·빈 상태도 같다.
- 중요도: P0
- 분류: 누락 · 배치
- 고칠 방법:
  1) `apps/web/public/nextspot-logo.png` → `apps/mobile/assets/images/nextspot-logo.png` 복사(앱은 라이트만이라 다크용 불필요).
  2) `saved.tsx` 를 `Screen`(스크롤 없음, `edges` 위·좌·우, `contentClassName="px-0"`) 안에 ① 머리 `View className="items-center justify-center border-b border-line p-[20px]"` + `expo-image` `<Image source={require('~/assets/images/nextspot-logo.png')} style={{ height: 28, width: 130 }} contentFit="contain" accessibilityLabel={t('common.appName')} accessibilityRole="header" />` ② 그 아래 `ScrollView`(flex-1) 로 나눈다 — 머리가 스크롤 밖에 남아야 웹과 같다.
  3) 스크롤 내용 여백 `p-[24px]`(아래는 탭 막대 위 여유 유지, 최소 24). 목록 간격 `gap-[16px]` 유지(웹 `gap-4`).
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/saved.tsx`, 새 `apps/mobile/assets/images/nextspot-logo.png`
- 문구(i18n): 재사용 `common.appName` — 새 키 없음
- 네이티브 주의: 안드로이드 상태 표시줄 inset 은 머리 **위**(바깥 View paddingTop)에.
- 확인 방법: 저장 5곳 시드 후 `sav-01-list-top` 재촬영 — 로고 중심 x=195, 머리 아래 선 y≈69, 히어로 x=24·폭 342. 끝까지 내려도 로고가 위에 남는지.
- 크기: S · 의존: G4a-14(같은 파일), G2(하단 탭 높이 — 아래 여백)
- 표시: —

### G4a-02 히어로 블록 세부 — 별 채움 · 스탯 그림자 · 제목 자간 · 줄 높이
- 화면·상태: G4-SAV-01
- 스크린샷: `shots/G4a/sav-01-hero.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:269-294` — 칩 별 `:272` `<Star size={11} className="fill-gold/60">`(채운 별, 선 gold-deep). 제목 `:276` `text-[22px] font-black leading-[1.15] tracking-tight`(줄 25.3px, 자간 −0.55px). 설명 `:279` `text-[13px] leading-relaxed`(21.1px). 스탯 줄 `:282` `pt-0.5`, 스탯 `:283` `shadow-[0_2px_10px_rgba(193,154,62,0.16)]`.
- Expo(현재): `apps/mobile/app/(tabs)/saved.tsx:141` `Icon Star size="xs"(12) color="gold-deep"`(빈 별), 제목 `:148` `leading-[26px]` 자간 없음, 설명 `:151` `leading-[19px]`, 스탯 `:153` 그림자 없음, 스탯 줄 `:152` 위 여백 없음.
- 차이: 별 채움/빈 별·11↔12, 제목 자간, 설명 줄 높이 21.1↔19, 스탯 금빛 그림자 없음.
- 중요도: P2
- 분류: 아이콘·이미지 · 글꼴 · 색·효과
- 고칠 방법: 1) 별은 `lucide-react-native` `Star` 를 직접 `size={11} color={colors['gold-deep']} fill="rgba(193,154,62,0.6)"` 로(또는 `Icon` 에 `fill?: string` prop 추가). 2) 제목 `text-[22px] leading-[25px] tracking-[-0.55px]`, 설명 `leading-[21px]`. 3) 스탯 View `style={{ boxShadow: '0px 2px 10px rgba(193,154,62,0.16)' }}`, 스탯 줄 `pt-[2px]`.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/saved.tsx`(필요 시 `components/ui/Icon.tsx`)
- 문구(i18n): 없음
- 네이티브 주의: 음수 자간은 안드로이드 한글에서 붙어 보일 수 있음 — 실기기 확인.
- 확인 방법: `sav-01-hero` 확대 비교.
- 크기: S · 의존: G2(전역 글꼴·자간 규칙)
- 표시: —

### G4a-03 NowChip 모양 — 시계 아이콘·맥박 고리 없음, 글자 11px(웹 10px)
- 화면·상태: G4-SAV-01 히어로(대안 머리글은 G4a-16)
- 스크린샷: `shots/G4a/sav-01-hero.pair.png`, `exp-01-header.pair.png`
- 웹(기준): `apps/web/components/NowChip.tsx:27-41` `inline-flex items-center gap-1 rounded-full bg-hanji-deep/70 border border-line px-2 py-0.5 text-[10px] font-medium text-muk-soft` + `<Clock size={11}>` + 6px 비취 점(뒤 `animate-ping` 2s 고리, 움직임 줄이기면 숨김) + "현재 HH:MM 기준". 실측 102.5×21.
- Expo(현재): `apps/mobile/features/waiting/NowChip.tsx:21-28` `gap-[6px] px-[10px] py-[3px]`, 시계 없음, 점만(맥박 없음), `text-[11px]`. 실측 99.7×21.
- 차이: 시계 아이콘 없음, 글자 11↔10, 좌우 여백 10↔8, 점 맥박 없음.
- 중요도: P1
- 분류: 아이콘·이미지 · 크기·간격
- 고칠 방법: 1) View `className="flex-row items-center gap-[4px] self-start rounded-full border border-line bg-hanji-deep/70 px-[8px] py-[2px]"`. 2) 점 앞 `<Icon icon={Clock} size={11} color="muk-soft" />`. 3) 글자 `text-[10px] leading-[15px]` medium. 4) 점 두 겹 — 뒤 겹 Reanimated `scale 1→2`·`opacity 0.6→0`·2000ms 반복(`useReduceMotion()` 이면 생략, 언마운트 때 `cancelAnimation`).
- 바꿀 Expo 파일: `apps/mobile/features/waiting/NowChip.tsx`(대기·저장·대안 공용)
- 문구(i18n): 재사용 `common.nowTime`
- 네이티브 주의: 반복 애니메이션 정리.
- 확인 방법: 저장 히어로·대기 머리 칩 확대(아이콘 11, 글자 10, 높이 21).
- 크기: S · 의존: G5(대기 탭 공용), G4a-16
- 표시: —

### G4a-04 '전체 초기화' 버튼 — 웹 주칠 알약 ↔ Expo 흰 보조 버튼
- 화면·상태: G4-SAV-01 히어로
- 스크린샷: `shots/G4a/sav-01-hero.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:287-292` `ml-auto inline-flex min-h-11 items-center rounded-full border border-terracotta/30 bg-terracotta/10 px-4 text-xs font-bold text-terracotta` → 82×44, 12px/16 bold #c1553b, 주칠 10% 바탕·30% 테두리, 알약.
- Expo(현재): `apps/mobile/app/(tabs)/saved.tsx:161` `<Button variant="secondary">` → 흰 바탕·`border-line`·먹 14px/18 bold·`rounded-2xl`(16).
- 차이: 색(주칠 ↔ 흰·먹), 글자 12↔14, 모서리(알약 ↔ 16px).
- 중요도: P1
- 분류: 색·효과 · 글꼴
- 고칠 방법: `Button` 대신 `Pressable` `accessibilityRole="button"` `className="ml-auto min-h-[44px] flex-row items-center rounded-full border border-terracotta/30 bg-terracotta/10 px-[16px]"` + `<Text className="text-[12px] leading-[16px] text-terracotta" weight="bold">{t('saved.clearAll')}</Text>`.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/saved.tsx`
- 문구(i18n): 재사용 `saved.clearAll`
- 네이티브 주의: 없음
- 확인 방법: `sav-01-hero` 재촬영 — 82×44 주칠 알약.
- 크기: S · 의존: G4a-12
- 표시: —

### G4a-05 분류 필터 칩 — 개수 알약 · 선택색(금↔비취) · 높이 44↔32 · 가로 스크롤↔줄바꿈
- 화면·상태: G4-SAV-01·02
- 스크린샷: `shots/G4a/sav-02-chiprow.pair.png`, `sav-02-filter-cafe.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:297-323` — 줄 `:298` `flex gap-2 overflow-x-auto no-scrollbar px-1 pb-1`(한 줄 가로 스크롤, 5개면 '문화시설' 화면 밖). 칩 `:309-313` `min-h-11 rounded-full border px-3.5 text-[13px] font-medium gap-1.5`, 선택 `bg-gold/15 border-gold text-muk`, 비선택 `bg-white border-line text-muk-soft`(실측 73.7×44). 개수는 따로 알약 `:316` `text-[11px] font-bold rounded-full px-1.5`, 선택 `bg-gold/25 text-gold-deep`, 비선택 `bg-hanji-deep text-muk-soft`. `aria-pressed`.
- Expo(현재): `saved.tsx:165-183` `flex-row flex-wrap gap-[6px] px-[4px]`(줄바꿈) + `components/ui/Chip.tsx:35-46` `min-h-[32px] px-[12px] py-[6px]`, 선택 `border-jade bg-jade-chip`, 13px semibold, 라벨 `"카페 1"` 한 문자열(실측 55.6×32), `aria-selected`.
- 차이: 선택색 금↔비취, 개수 표시 방식, 높이 44↔32, 굵기 500↔600, 넘칠 때 가로 스크롤↔줄바꿈.
- 중요도: P1
- 분류: 색·효과 · 크기·간격 · 배치
- 고칠 방법: 1) `Chip.tsx` 에 `selectedTone?: 'jade' | 'gold'`(기본 jade — 홈 칩 그대로)와 `count?: number` 추가. gold 선택 `border-gold bg-gold/15` + `text-muk`, 비선택 `border-line bg-white` + `text-muk-soft`; 높이 `min-h-[44px] px-[14px] gap-[6px]`, 글자 `text-[13px] leading-[19.5px]` medium; `count` 가 있으면 라벨 뒤 `rounded-full px-[6px]` 알약(선택 `bg-gold/25` + `text-[11px] font-bold text-gold-deep`, 비선택 `bg-hanji-deep` + `text-muk-soft`). `accessibilityLabel` 은 `"카페 1"` 유지. 2) `saved.tsx:166` 을 `<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}>` 로.
- 바꿀 Expo 파일: `apps/mobile/components/ui/Chip.tsx`, `apps/mobile/app/(tabs)/saved.tsx`
- 문구(i18n): 재사용 `saved.filterAll`, `category.*`
- 네이티브 주의: 세로 스크롤 안 가로 `ScrollView` — 안드로이드 `nestedScrollEnabled` 확인.
- 확인 방법: `sav-02-chiprow` — 높이 44, 금 선택, 개수 알약, 마지막 칩 화면 밖.
- 크기: M · 의존: 없음(Chip 기본값 유지라 G2 홈 칩 영향 없음)
- 표시: —

### G4a-06 웹 전용 알림 — '한산해지면 알림 받기' 행 + 골든타임 '알림 받기' 버튼 없음
- 화면·상태: G4-SAV-09, G4-SAV-01(골든타임 줄)
- 스크린샷: `shots/G4a/sav-09-alert-default.pair.png`(알림 권한 default — 폰 첫 방문과 같은 OFF 행), `sav-09-alert-row.pair.png`, `sav-01-card1.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:326-328` → `components/CongestionAlertToggle.tsx:47-118` 칩 줄 아래 한 줄 카드(약 60px) `rounded-2xl border px-4 py-3 shadow-[0_2px_14px_…0.06]`, 왼쪽 36px 원(`bg-jade/10 text-jade` 종 18px), 14px semibold "한산해지면 알림 받기"(`alert.off`) + 12px "저장한 장소가 한산해지면 알려드려요"(`alert.offSub`), 오른쪽 44×24 스위치. 켜짐(`alert.on/onSub`, 금색·`BellRing` 맥박)·거부(`alert.denied/deniedSub`)·미지원(`alert.unsupported`) 상태. `lib/useCongestionAlerts.ts` — 켜면 권한 요청, 3분(`POLL_INTERVAL_MS`)마다 `/api/v1/infrastructures` 를 읽어 한산해지면 로컬 알림. 골든타임 `components/GoldenHourBadge.tsx:107-135` 라벨 옆 "🔔 알림 받기"(`golden.notifyCta`) → 오늘 `start` 시 로컬 알림 예약, 이후 "예약됨". (헤드리스 Chromium 기본 권한이 `denied` 라 비교는 `Notification.permission='default'` 로 맞춰 찍음.)
- Expo(현재): 둘 다 없음 — `apps/mobile/app/(tabs)/saved.tsx:3` "알림은 앱 v1 에 없다", `features/waiting/GoldenHourLabel.tsx:1-2`. 의도된 제외(인벤토리 D4·D5).
- 차이: 목록 위 알림 행과 카드마다 '알림 받기' 버튼이 없어 목록 위치·카드 모양이 달라진다.
- 중요도: P0
- 분류: 누락 · 동작
- 고칠 방법(선택지): (a) **이식(권장)** — `npx expo install expo-notifications`; ① 새 `lib/core/useCongestionAlerts.ts`(웹 훅 그대로, 키 `nextspot_congestion_alerts_enabled`·`_notified`, 3분 폴링은 `AppState` active 일 때만, 알림 `Notifications.scheduleNotificationAsync({ content, trigger: null })`) ② 새 `features/saved/CongestionAlertToggle.tsx`(웹 값 그대로) 를 칩 줄 아래 `px-[4px] -mt-[4px] mb-[4px]` ③ `GoldenHourLabel` 에 같은 "알림 받기" — 오늘 `start:00` `trigger: { type: 'date', date }`, 뒤엔 "예약됨"·`BellRing`. (b) 제외 유지. 추천: (a) — 웹도 서버 푸시 없이 '켜져 있는 동안' 로컬 알림이라 계획 §3.2 의 서버 푸시 전제가 동등에는 필요 없다.
- 바꿀 Expo 파일: 새 `apps/mobile/lib/core/useCongestionAlerts.ts`, 새 `apps/mobile/features/saved/CongestionAlertToggle.tsx`, `apps/mobile/app/(tabs)/saved.tsx`, `apps/mobile/features/waiting/GoldenHourLabel.tsx`, `apps/mobile/app.json`, `package.json`
- 문구(i18n): 재사용 `alert.off`, `alert.offSub`, `alert.on`, `alert.onSub`, `alert.checkFailed`, `golden.notifyCta`, `golden.notifyAria`, `golden.notifyScheduled`, `golden.notifyScheduledAria`, `golden.notifyTitle`, `golden.notifyBody`. 새 키(4로케일): `app.alert.denied`("기기 설정에서 알림이 꺼져 있어요"), `app.alert.deniedSub`("알림을 켜려면 설정에서 NextSpot 알림을 허용해 주세요"), `app.alert.unsupported` — 웹 문구가 '브라우저'라.
- 네이티브 주의: 안드로이드 13+ `POST_NOTIFICATIONS`·알림 채널. 백그라운드면 폴링 정지(웹 탭 숨김과 같은 뜻). Expo web 판은 `expo-notifications` 웹 지원이 제한적 → 브라우저 `Notification` 분기.
- 확인 방법: 칩 줄 아래 행, 켜면 권한 요청 → 켜짐 모양, 에뮬레이터에서 `/infrastructures` 한산 모킹 → 알림.
- 크기: L · 의존: G5(대기 골든타임 '알림 받기', 마이 알림 줄 G5-MY-13)
- 표시: 결정 필요 · 네이티브 확인 필요

### G4a-07 저장 카드 틀·머리 — 그림자 · 순위 배지 · 삭제 버튼 · 이름 줄 · '여유' 점 색
- 화면·상태: G4-SAV-01, 긴 이름
- 스크린샷: `shots/G4a/sav-01-card-wait.pair.png`, `sav-01-card-green.pair.png`, `sav-10-longname-card.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx` — 카드 `:351-355` `p-4 rounded-2xl border bg-white border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)]`(선택 `bg-gold/15 border-gold`). 배지 `:359-366` `absolute top-3 left-3 h-8 w-8 rounded-full border-2 border-white text-[13px] font-extrabold text-white shadow-[0_2px_8px_rgba(193,154,62,0.45)]`, 1위 `bg-gradient-to-br from-gold to-gold-deep`, 그 외 `bg-gold`. 이름 `:377` `text-lg font-bold` 18px/**28px**, 줄 제한 없음(긴 이름 3줄). 혼잡 글자 `:197` `text-[10px]`, 점 `:177-182` green→**`bg-emerald-500`**(v4 ≈ #00bc7d), blue→jade. 삭제(폰) `:390-397` 44×44 `rounded-xl bg-terracotta/10`, `Trash2 size={16}`, 카드 안쪽 위 16·오른쪽 20.
- Expo(현재): `apps/mobile/features/saved/SavedCard.tsx` — 카드 `:58-60` 그림자 없음. 배지 `:67-77` 그림자 없음, 1위 `bg-gold-deep` 단색. 이름 `:93-95` `leading-[24px]` + `numberOfLines={2}`('…'로 잘림). 혼잡 글자 `:89` 11px, 점 `:12-18` green→**`bg-jade`**(한산과 같은 색). 삭제 `:130-137` `absolute right-[8px] top-[8px]`, 아이콘 `size="lg"`(20).
- 차이: 카드 그림자, 1위 배지 그라데이션·금빛 그림자, 이름 줄 높이·2줄 자르기, 혼잡 글자 10↔11, '여유' 점 에메랄드↔비취, 삭제 위치(8px 바깥·위)·아이콘 20↔16.
- 중요도: P1
- 분류: 색·효과 · 크기·간격 · 아이콘·이미지
- 고칠 방법: 1) 카드 `style={{ boxShadow: shadows.card }}`. 2) 배지 `style={{ boxShadow: '0px 2px 8px rgba(193,154,62,0.45)' }}`, 1위는 안쪽 `<Gradient colors={[colors.gold, colors['gold-deep']]} start={{x:0,y:0}} end={{x:1,y:1}} style={StyleSheet.absoluteFill} />`(바깥 그림자 View / 안쪽 overflow-hidden View 두 겹). 3) 이름 `text-[18px] leading-[28px]`, `numberOfLines` 제거. 4) 혼잡 글자 `text-[10px] leading-[15px]`; `DOT.green='bg-emerald-500'`(v3 #10b981) — 정확히는 `tokens.ts` 에 `'emerald-500-web': '#00bc7d'`. 5) 삭제 `absolute right-[20px] top-[16px]`, `<Icon icon={Trash2} size={16} color="terracotta" />`, 이름 줄 `pr-[52px]`. (배지는 G4a-18 의 공용 `RankBadge` 로.)
- 바꿀 Expo 파일: `apps/mobile/features/saved/SavedCard.tsx`, (선택) `apps/mobile/lib/theme/tokens.ts`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드는 같은 View 의 `overflow-hidden` 이 그림자를 자름 → 두 겹.
- 확인 방법: 세 클립 재촬영 — 그림자, 1위 그라데이션, 긴 이름 3줄, 초록 점, 삭제 위치.
- 크기: S · 의존: G4a-08, G4a-18
- 표시: —

### G4a-08 저장 카드 타임라인 — 연결선·알약 자리 · 글자 크기
- 화면·상태: G4-SAV-01(2노드 / 검증 대기 3노드)
- 스크린샷: `shots/G4a/sav-01-card-wait.pair.png`, `sav-01-card1.pair.png`, `sav-01-list-tall.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:417-458` — 상자 `mt-4 bg-hanji border border-line rounded-2xl px-4 py-3 flex-col gap-3`; 머리 `:418` `px-1 mb-1`, "총 소요 시간" `text-[10px] font-semibold`, 값 `text-sm font-extrabold text-gold-deep`. 노드 줄 `:424` `relative` 위 **연결선** `:426` `absolute top-[3px] left-4 right-4 h-[2px] rounded-full bg-gradient-to-r from-gold/20 via-gold/45 to-gold/20`. **알약이 선 위에** `:429-435` 이동 `absolute top-[-10px]` `left-[25%]`(이용 노드 있을 때)/`left-1/2` `-translate-x-1/2` `text-[10px] font-medium text-jade bg-hanji px-1.5 py-0.5 rounded border-jade/25`; 대기 `left-[75%]` `text-[11px] … text-gold-deep border-gold/25`. 노드 `:438-456` `w-12`, 점 `w-2 h-2 ring-4 ring-hanji mb-1.5`, 시각 `text-[10px] font-bold`, 라벨 `text-[10px] mt-0.5`. 실측 카드 243px.
- Expo(현재): `apps/mobile/features/saved/SavedCard.tsx:98-126` 상자 `gap-[10px]`, 알약을 노드 위 **따로 한 줄**(`:107-120`, 왼쪽), 연결선 없음, 시각 `text-[12px]`(`:24`), 라벨 11px(`:27`), 머리 라벨 11px, 이동 알약 11px, 점 고리 없음. 실측 257px(+14).
- 차이: 알약 자리, 연결선 없음, 글자 크기, 카드 14px 높음.
- 중요도: P1
- 분류: 배치 · 글꼴 · 크기·간격
- 고칠 방법: 1) `:107-120` 삭제, 노드 줄 `relative`. 2) 연결선 `<Gradient colors={['rgba(193,154,62,0.2)','rgba(193,154,62,0.45)','rgba(193,154,62,0.2)']} start={{x:0,y:0.5}} end={{x:1,y:0.5}} style={{ position:'absolute', top:3, left:16, right:16, height:2, borderRadius:1 }} />`. 3) 알약은 폭 0 앵커로 가운데 — `<View style={{ position:'absolute', top:-10, left: tl.service ? '25%' : '50%', width:0, alignItems:'center', zIndex:10 }}><View className="rounded border border-jade/25 bg-hanji px-[6px] py-[2px]"><Text className="text-[10px] leading-[15px] text-jade" weight="medium">…</Text></View></View>`; 대기는 `left:'75%'`·`text-[11px] text-gold-deep`·`border-gold/25`. 4) `TimelineNode` `w-[48px]`, 점 `style={{ boxShadow: '0 0 0 4px #faf5ec' }}`·`mb-[6px]`, 시각 `text-[10px] leading-[15px]` bold, 라벨 `mt-[2px] text-[10px] leading-[15px]`. 5) 상자 `gap-[12px]`, 머리 `px-[4px] mb-[4px]`, 머리 라벨 `text-[10px]`, 값 `text-[14px] leading-[20px]`.
- 바꿀 Expo 파일: `apps/mobile/features/saved/SavedCard.tsx`
- 문구(i18n): 재사용 `saved.totalTime`, `saved.travelLabel`, `saved.waitLabel`, `saved.depart`, `saved.arrive`, `saved.dine`, `saved.view`
- 네이티브 주의: −10px 알약이 잘리지 않게 노드 줄·상자 `overflow` visible. 큰 글자에서 알약·시각 겹침(웹도 같음).
- 확인 방법: `sav-01-card-wait` 재촬영 — 알약 중심 25%/75%, 카드 243px.
- 크기: M · 의존: G4a-07
- 표시: —

### G4a-09 골든타임 라벨 크기 — 글자 11↔10px, 높이 25↔21px
- 화면·상태: G4-SAV-01(골든타임 모킹 16~17시)
- 스크린샷: `shots/G4a/sav-01-card-green.pair.png`
- 웹(기준): `apps/web/components/GoldenHourBadge.tsx:107-110` `px-2 py-0.5 rounded-md text-[10px] font-bold border bg-jade/10 border-jade/30 text-jade`(109.7×21), 저장 카드 `mt-2`(`saved/page.tsx:462`).
- Expo(현재): `apps/mobile/features/waiting/GoldenHourLabel.tsx:29-31` `px-[8px] py-[4px]`, `text-[11px]`(119.3×25).
- 차이: 글자 1px·위아래 2px씩 큼.
- 중요도: P2
- 분류: 크기·간격
- 고칠 방법: 안쪽 View `py-[2px]`, Text `text-[10px] leading-[15px]`('알림 받기'는 G4a-06).
- 바꿀 Expo 파일: `apps/mobile/features/waiting/GoldenHourLabel.tsx`
- 문구(i18n): 재사용 `golden.badge`
- 네이티브 주의: 없음
- 확인 방법: 라벨 높이 21.
- 크기: S · 의존: G5, G4a-06
- 표시: —

### G4a-10 빈 상태 카드 — 웹 금빛 카드·그라데이션 CTA ↔ Expo 공용 EmptyState
- 화면·상태: G4-SAV-04, G4-SAV-06 뒤
- 스크린샷: `shots/G4a/sav-04-empty-card.pair.png`, `sav-04-empty.pair.png`, `sav-06-cleared.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:244-261` — 카드 `:245` `max-w-[320px] p-8 rounded-3xl border-line bg-white shadow-[0_2px_14px_…0.06]`(320×293). 원 `:246` 64px `bg-gradient-to-b from-gold/20 to-gold/10 border border-line`, `Star size=32 text-gold fill-gold/40`, 아래 24. 제목 `:249` `text-xl font-bold`(20/28), 아래 12. 본문 `:250` `text-sm leading-relaxed`(14/22.75) `px-2`, 아래 32. 버튼 `:254-260` `min-h-11 px-5 rounded-full bg-gradient-to-r from-gold to-terracotta text-white text-sm font-bold shadow-[0_4px_14px_rgba(193,85,59,0.25)]` + `Compass 18`(132.8×44) → `/main`.
- Expo(현재): `saved.tsx:129-134` → `components/ui/EmptyState.tsx:26-45` 폭 358, 패딩 28, 모서리 16, 원 48px `bg-hanji-deep` + 빈 별 24 `muk-soft`, 제목 15/21, 설명 13/19, `Button variant="secondary"`(흰·먹, 아이콘 없음) → `/`.
- 차이: 카드 폭·모서리·패딩, 아이콘·원 크기, 제목 20↔15, 본문 14↔13, CTA 그라데이션+나침반 ↔ 흰 버튼.
- 중요도: P1
- 분류: 색·효과 · 크기·간격 · 아이콘·이미지
- 고칠 방법: 공용 `EmptyState` 는 두고 저장 전용 블록: `<View className="w-full max-w-[320px] items-center self-center rounded-3xl border border-line bg-white p-[32px]" style={{ boxShadow: shadows.card }}>` → 원 `<Gradient colors={['rgba(193,154,62,0.2)','rgba(193,154,62,0.1)']} start={{x:0.5,y:0}} end={{x:0.5,y:1}} style={{ width:64, height:64, borderRadius:32, borderWidth:1, borderColor: colors.line, alignItems:'center', justifyContent:'center', marginBottom:24 }}>` + `Star size={32} color={colors.gold} fill="rgba(193,154,62,0.4)"` → 제목 `text-center text-[20px] leading-[28px] mb-[12px]` bold → 본문 `text-center text-[14px] leading-[23px] text-muk-soft px-[8px] mb-[32px]` → 버튼 `Pressable min-h-[44px] flex-row items-center gap-[8px] overflow-hidden rounded-full px-[20px]` + `<Gradient name="goldTerracotta" style={StyleSheet.absoluteFill} />` + 바깥 `boxShadow: '0px 4px 14px rgba(193,85,59,0.25)'` + `Icon Compass size={18} color="white"` + 14px bold 흰 글자.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/saved.tsx`(또는 새 `features/saved/SavedEmpty.tsx`)
- 문구(i18n): 재사용 `saved.emptyTitle`, `saved.emptyBody`, `saved.browseMap`
- 네이티브 주의: 그라데이션 버튼 두 겹(그림자 잘림). 흰 글자 on 금 대비는 웹과 같은 값.
- 확인 방법: `sav-04-empty-card` — 320 폭, 원 64, 제목 20, 그라데이션 알약 132×44.
- 크기: S · 의존: 없음
- 표시: —

### G4a-11 로딩 스켈레톤 — 첫 줄 점·카드 그림자 · 재진입 때 스켈레톤
- 화면·상태: G4-SAV-03, 탭 재진입
- 스크린샷: `shots/G4a/sav-03-loading.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:230-241` 카드 `p-4 space-y-3 shadow-[…0.06] animate-pulse`; 첫 줄 64×20 막대 + 12px 원; 둘째 `h-5 w-2/3`; 셋째 `h-16 bg-hanji-deep/60 rounded-2xl`. 웹은 `/saved` 에 들어올 때마다 다시 마운트 → 동기화 끝날 때까지 스켈레톤(`:94-127`, 로컬 목록이 있어도).
- Expo(현재): `saved.tsx:117-126` 첫 막대 96×20·원 없음·셋째 불투명·그림자 없음. 탭이 마운트를 유지해 첫 진입만 스켈레톤, 재진입은 로컬 목록을 바로 보이고 뒤에서 동기화(`useFocusEffect` `:66-70`).
- 차이: 첫 줄 모양·그림자·셋째 농도; 재진입 때 웹만 스켈레톤.
- 중요도: P2
- 분류: 상태(로딩·빈·오류) · 동작
- 고칠 방법: 1) 첫 줄 `<View className="flex-row items-center gap-[8px]"><Skeleton width={64} height={20} /><Skeleton width={12} height={12} radius={9999} /></View>`, 셋째 블록 색 `rgba(241,231,211,0.6)`(`Skeleton` 에 `color` prop 추가 — opacity 와 깜빡임이 곱해지지 않게), 카드 `style={{ boxShadow: shadows.card }}`. 2) 재진입 스켈레톤은 맞추지 않기를 권장(웹 깜빡임) — 맞추려면 `load()` 시작에 `setLoading(true)`.
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/saved.tsx`, (선택) `apps/mobile/components/ui/Skeleton.tsx`
- 문구(i18n): 재사용 `common.loading`
- 네이티브 주의: 없음
- 확인 방법: 동기화 GET 12초 보류(`work/G4a/saved2.mjs` B)로 `sav-03-loading` 재촬영.
- 크기: S · 의존: G4a-27(Skeleton color prop 공유)
- 표시: —(재진입 동작만: 권장 = 현행 유지)

### G4a-12 '전체 초기화' 확인 — 웹 화면 안 토스트 버튼 ↔ Expo 브라우저 `confirm`/시스템 Alert
- 화면·상태: G4-SAV-06
- 스크린샷: `shots/G4a/sav-06-clear-confirm.pair.png`(Expo 대화상자는 스크린샷에 안 잡힘), `sav-06-cleared.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:152-173` sonner `toast(t('saved.clearConfirm'), { description: t('saved.clearConfirmDesc'), duration: 8000, action: { label: t('saved.clearAction'), … }, cancel: { label: t('common.cancel') } })` — 화면 아래 토스트에 "취소"(회색)·"초기화"(검정), 화면을 막지 않고 8초 뒤 사라지면 변화 없음.
- Expo(현재): `apps/mobile/app/(tabs)/saved.tsx:93-110` `Alert.alert(title, message, [취소, 초기화(destructive)])` → Expo web `window.confirm("모든 저장된 스팟을 초기화할까요?\n\n삭제된 목록은 되돌릴 수 없습니다.")`(실측), 안드로이드 시스템 대화상자(화면을 막는 모달).
- 차이: 확인 UI 종류·위치·막힘, 버튼 모양.
- 중요도: P0
- 분류: 동작 · 배치
- 고칠 방법: `Alert.alert` → sonner-native `toast`(`components/ui/Toast.tsx`; `ToastProps` 에 `action`·`cancel` 있음 — `node_modules/sonner-native/lib/typescript/src/types.d.ts:64-65`): `toast(t('saved.clearConfirm'), { description: t('saved.clearConfirmDesc'), duration: 8000, action: { label: t('saved.clearAction'), onClick: () => { genRef.current += 1; setBookmarks([]); setSelected(null); void clearSavedAll(); haptic('success'); toast.success(t('saved.clearedSuccess')); } }, cancel: { label: t('common.cancel'), onClick: () => {} } })`. 버튼 색(Expo action 금 진 ↔ 웹 검정)은 전역 Toaster 과제(G2).
- 바꿀 Expo 파일: `apps/mobile/app/(tabs)/saved.tsx`
- 문구(i18n): 재사용 `saved.clearConfirm`, `saved.clearConfirmDesc`, `saved.clearAction`, `saved.clearedSuccess`, `common.cancel`
- 네이티브 주의: TalkBack 이 8초 안에 토스트 버튼에 닿는지 확인(웹도 같은 제약). 시스템 Alert 를 버리면 '뒤로'로 닫던 동작이 없어진다.
- 확인 방법: '전체 초기화' → 토스트+두 버튼(Playwright `dialog` 0회) → '초기화' → 빈 상태+완료 토스트.
- 크기: S · 의존: G2(토스트 전역)
- 표시: 네이티브 확인 필요

### G4a-13 저장 카드 상세 — 베일+떠 있는 카드 ↔ 베일 없는 바텀시트 · 킵 버튼 추가 · 머리 칩 문구 · '바로 갈래요' 동작
- 화면·상태: G4-SAV-07
- 스크린샷: `shots/G4a/sav-07-detail-open.pair.png`, `sav-07-detail-closed.pair.png`
- 웹(기준): `apps/web/app/saved/page.tsx:473-538` — 베일 `:478-483` `<button aria-label="닫기" class="absolute inset-0 z-20 bg-hanok/40 backdrop-blur-[2px]">`(한옥색 #efe7d8 40% + 2px 흐림, 누르거나 Esc `:80-87` 로 닫힘; 주석은 '어두워진다'지만 실제는 밝은 베일). 카드 자리 `:486-487` 하단 탭 위 가운데, `max-w-[400px] px-4`(좌우 16 띄움), 최대 높이 `100dvh − nav − 5rem`, 안에서 스크롤 — 사방 둥근 떠 있는 카드. 카드 `:488-534` `RecommendationCard` 에 `onAccept`·`onReject` 만 — **`onPutOff` 없음**(킵 버튼 안 그림, `components/RecommendationCard.tsx:2266`), `rank`·`showListRank` 없음 → 머리 칩 **"AI 추천"**(`card.aiRec`, `:1154-1156`). '바로 갈래요' `:519-524` 카카오맵 `link/to/…` 새 창 **만**. '다시 안볼래요' = 저장에서 빼기 + `saved.removedFromSaved`.
- Expo(현재): `saved.tsx:202-208` → `features/saved/sheetSlot.tsx:24-40` → `RecommendationSheet`(`openAs="normal"`, 52%): 베일 없음 — 목록이 그대로 보이고, 비모달 시트라 시트 밖(목록)을 누르면 그 아래 카드가 눌린다(코드상). Esc 로 안 닫힘(실측), 보이는 닫기 단추 없음(손잡이 끌기만). 폭 가득·위 모서리만 둥근 시트가 탭 막대에 붙음. **'일단 킵하고 · 다음 후보 볼래요'** 추가(`RecommendationSheet.tsx:477-484` 무조건). 머리 칩 **"선택한 장소"**(`cardModel.ts:402` `cardRankLabel(null)` → `card.selectedPlace`). '바로 갈래요'는 시트가 서버 수락·여정 기록·길안내까지 하고 `onAccept=onClose`(`sheetSlot.tsx:3-7,31`) — 홈에 진행 중 여정 카드가 생김. Expo web 은 시트 바탕(흰 95%, `components/ui/Sheet.tsx:118`)으로 뒤 글자가 비침.
- 차이: 겉모양(베일·떠 있는 카드 ↔ 시트), 닫는 방법, 킵 버튼 추가, 머리 칩 문구, 수락 동작·쓰기(카드 내부 구성은 G3 소관).
- 중요도: P0
- 분류: 배치 · 추가 · 동작 · 문구
- 고칠 방법: 1) 베일: `SavedSheetSlot` 이 `bookmark` 가 있을 때 시트 아래·목록 위에 `<Pressable accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(239,231,216,0.4)' }]} />`(흐림: Expo web `backdropFilter: 'blur(2px)'`, iOS `expo-blur` `BlurView intensity≈10`, 안드로이드 없음). Esc 는 Expo web `keydown`. 2) 떠 있는 카드: G3 와 합의해 `RecommendationSheet` 에 `presentation?: 'sheet' | 'docked'` — `docked` 면 `position:absolute; left:16; right:16; bottom: 탭막대+8; maxHeight: 창높이 − 탭막대 − 80; borderRadius: 24` 안에 `ScrollView` 로 `CardBody`. 저장만 `docked`. 3) 킵 버튼: `RecommendationSheet.tsx:477-484` 를 `{props.onKeep ? <Button … /> : null}`(웹 `onPutOff &&` 규칙) — 홈이 `onKeep` 을 넘기는지 확인. 4) 머리 칩: `rankMode?: 'list' | 'saved'` — `saved` 면 `cardModel` 이 `rank ? rankBadge : 'card.aiRec'`(`cardModel.ts:402`), `sheetSlot.tsx` 에서 `rankMode="saved"`. 5) '바로 갈래요' — 결정 필요: (a) 웹과 같게 저장에서는 카카오맵만(`kakaoDrivingHandoff`, 웹 `link/to/`) / (b) 여정 기록 유지(웹 누락일 수 있음 — 웹을 고치는 쪽). 추천: (b)를 웹에 반영하자고 제안, '웹과 같게' 원칙이면 (a).
- 바꿀 Expo 파일: `apps/mobile/features/saved/sheetSlot.tsx`, `apps/mobile/app/(tabs)/saved.tsx`, `apps/mobile/features/recommendation-card/RecommendationSheet.tsx`, `apps/mobile/features/recommendation-card/cardModel.ts`
- 문구(i18n): 재사용 `common.close`, `card.aiRec`, `saved.removedFromSaved`
- 네이티브 주의: 베일을 시트보다 아래 z(시트 제스처 방해 X). 안드로이드 '뒤로'로 상세 닫기(`BackHandler`) = 웹 Esc. 시트 반투명은 Expo web 만(안드로이드 흰색).
- 확인 방법: 카드 탭 → 베일·좌우 16px 떠 있는 카드·베일 탭으로 닫힘·킵 버튼 없음·"AI 추천".
- 크기: L · 의존: G3(`RecommendationSheet`·`cardModel` 소유 — 3·4번은 G3 와 같은 PR), G2
- 표시: 결정 필요(5번) · 네이티브 확인 필요

### G4a-14 배경 광원 없음 — 저장·대안 화면의 은은한 노을·금빛 번짐
- 화면·상태: G4-SAV-01·04, G4-EXP 전 상태
- 스크린샷: `shots/G4a/sav-04-empty.pair.png`, `exp-01-top.pair.png`(웹 위쪽이 분홍빛)
- 웹(기준): 저장 `apps/web/app/saved/page.tsx:541-542` `absolute top-1/4 left-1/4 w-[300px] h-[300px] bg-sunset-1/10 rounded-full blur-[100px]` + `bottom-[-10%] right-[-10%] w-[300px] h-[300px] bg-gold/10 … blur-[100px]`. 대안 `apps/web/app/explore/recommend/page.tsx:1494-1495` `top-[-20%] left-[-10%] w-[600px] h-[600px] bg-sunset-1/10 blur-[120px]` + `bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-gold/10 blur-[120px]`.
- Expo(현재): 평평한 `bg-hanji`(`components/ui/Screen.tsx:43`).
- 차이: 웹 바탕에 노을(#e8895a 10%)·금(#c19a3e 10%) 번짐.
- 중요도: P2
- 분류: 색·효과
- 고칠 방법: 새 `components/ui/Glow.tsx` — `react-native-svg` `RadialGradient`(색 10% → 0) 원 두 개를 스크롤 밖 내용 뒤(`pointerEvents="none"`)에. 저장: 노을 원 중심 (폭×0.25+150, 높이×0.25+150) 반경 ≈250, 금 원 오른쪽 아래; 대안: 600px·blur 120 값(반경 ≈420).
- 바꿀 Expo 파일: 새 `apps/mobile/components/ui/Glow.tsx`, `apps/mobile/app/(tabs)/saved.tsx`, `apps/mobile/features/explore/RecommendScreen.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드엔 CSS blur 가 없어 SVG 근사가 유일.
- 확인 방법: 빈 상태 화면 위·아래 색 비교(웹 위쪽 분홍기).
- 크기: S · 의존: G2(대기·코스도 같은 광원이면 공용)
- 표시: —

---

## [EXP] 대안 — 웹 `/explore/recommend` ↔ Expo `/explore/recommend`

### G4a-15 맨 위 — 웹 원형 '지도 보기' 버튼 ↔ Expo 스택 헤더 · 뒤로 목적지 · 접근 이름
- 화면·상태: G4-EXP-01, EXP-25(대기 탭에서 들어옴)
- 스크린샷: `shots/G4a/exp-01-topbar.pair.png`, `exp-01-topbar-nav.pair.png`, `exp-25-from-waiting-nav.pair.png`, `exp-01-bottom.pair.png`(Expo 헤더가 스크롤해도 남음)
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:1501-1508` 내용 안 첫 줄 `w-11 h-11 rounded-full bg-white/90 border border-line shadow-[0_2px_10px_rgba(43,35,32,0.1)] text-muk` + `ArrowLeft 18`, `aria-label="지도 보기"`(`recommend.backToMap`), 자리 (16,32), **내용과 함께 스크롤**. 누르면 **언제나 `router.push('/main')`**(실측 대기 탭에서 와도 `/main`). 브랜드 칩 위 끝 y=113.
- Expo(현재): `apps/mobile/app/_layout.tsx:90` 네이티브 헤더(약 64px, 한지색, 그림자 없음 `RecommendScreen.tsx:118`, **위에 고정**). 실측 뒤로 단추 30×30 맨 화살표 `<a aria-label="(tabs), back">`(11,17). `app/_layout.tsx:23-25` `unstable_settings.initialRouteName:'(tabs)'` 로 주소 직접 진입도 `canGoBack()` 참 → `RecommendScreen.tsx:121-130` 의 `IconButton("지도 보기")` 는 **안 그려진다**(실측). 누르면 **이전 화면**(실측 `/waiting`). 브랜드 칩 위 끝 y=89.
- 차이: 모양, 자리(내용 안·스크롤 ↔ 고정 64px), 목적지(항상 지도 ↔ 이전 화면), 접근 이름("지도 보기" ↔ "(tabs), back"), 탭 영역 44↔30.
- 중요도: P0
- 분류: 배치 · 동작 · 접근성
- 고칠 방법: 1) `app/_layout.tsx:90` → `options={{ headerShown: false }}`; `RecommendScreen.tsx:115-133` `Stack.Screen` 블록 삭제. 2) `Screen` `edges={['top','left','right','bottom']}`, `contentClassName="gap-[20px] px-[16px] pt-[32px] pb-[32px]"`(웹 `p-4`+`py-4`, `space-y-5`). 3) 스크롤 내용 첫 자식: `<Pressable accessibilityRole="button" accessibilityLabel={t('recommend.backToMap')} onPress={() => router.navigate('/')} className="h-[44px] w-[44px] items-center justify-center self-start rounded-full border border-line bg-white/90" style={{ boxShadow: '0px 2px 10px rgba(43,35,32,0.1)' }}><Icon icon={ArrowLeft} size={18} color="muk" /></Pressable>`. 4) 하드웨어 '뒤로'·iOS 스와이프는 '이전 화면'(웹 브라우저 뒤로와 같은 뜻) 유지 — 결정 필요. 5) `originOk` 아닌 분기(`:135-144`)도 같은 틀.
- 바꿀 Expo 파일: `apps/mobile/app/_layout.tsx`, `apps/mobile/features/explore/RecommendScreen.tsx`
- 문구(i18n): 재사용 `recommend.backToMap`
- 네이티브 주의: 위 안전 영역 필수(상태 표시줄). iOS 가장자리 스와이프는 그대로. 헤더 접근 이름 "(tabs), back" 이 TalkBack 에서도 같은지(이 고침으로 헤더가 사라짐).
- 확인 방법: 주소 직접·대기 탭 경유 둘 다 흰 원 버튼·스크롤 시 사라짐·누르면 홈. `work/G4a/probe-back.mjs`.
- 크기: S · 의존: G2(이 화면의 하단 탭 유무)
- 표시: 결정 필요(하드웨어 뒤로 — 추천: 이전 화면 유지) · 네이티브 확인 필요

### G4a-16 머리글 — NowChip 없음 · 브랜드 칩·붐빔 알약·제목 세부
- 화면·상태: G4-EXP-01·03·25
- 스크린샷: `shots/G4a/exp-01-header.pair.png`, `exp-25-from-waiting-top.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:1511-1548` — 칩 줄 `:1512-1517` `flex flex-wrap items-center gap-2` = 브랜드 칩(`px-2.5 py-1 text-[11px] font-bold`, 높이 26.5) + **`<NowChip />`**. 제목 `:1524` `leading-[1.2] tracking-tight`(26.4, −0.55px). 붐빔 알약 `:1529-1543` `inline-flex flex-wrap items-center gap-1.5 px-3 py-1 text-[13px] font-bold`(높이 29.5) + 8px 점(붐빔이면 `animate-pulse`) + 추정이면 **따로** `<span class="font-semibold opacity-80">· 추정</span>`. 설명 `:1546` `leading-relaxed`(21.1).
- Expo(현재): `RecommendScreen.tsx:156-193` 브랜드 칩만(높이 22), 제목 `leading-[27px]` 자간 없음, 알약 `:170-189` 높이 25·정적 점·" · 추정" 을 같은 Text 에 붙임(불투명 100%), 설명 `leading-[20px]`.
- 차이: "현재 HH:MM 기준" 칩 없음, 칩·알약 4~5px 낮음, 추정 꼬리표 간격·흐림, 점 맥박, 제목 자간.
- 중요도: P1
- 분류: 누락 · 크기·간격 · 글꼴
- 고칠 방법: 1) `:157-159` → `<View className="flex-row flex-wrap items-center gap-[8px]">{브랜드칩}<NowChip /></View>`(`~/features/waiting/NowChip`, 모양 G4a-03). 2) 브랜드 칩 Text `leading-[16.5px]`. 3) 알약 Text `leading-[19.5px]`, 추정 꼬리표를 형제 Text `font-semibold opacity-80`(간격 `gap-[6px]`)로 분리, 붐빔 점 Reanimated opacity 1→0.5 반복(움직임 줄이기면 정지). 4) 제목 `tracking-[-0.55px] leading-[26px]`, 설명 `leading-[21px]`.
- 바꿀 Expo 파일: `apps/mobile/features/explore/RecommendScreen.tsx`
- 문구(i18n): 재사용 `common.nowTime`, `recommend.headerBrand`, `recommend.originBusy`, `recommend.originCalm`, `wait.estimatedTag`
- 네이티브 주의: 없음
- 확인 방법: 붐빔 추정 피드 모킹(`work/G4a/recommend1.mjs` E1)으로 `exp-01-header`.
- 크기: S · 의존: G4a-03
- 표시: —

### G4a-17 🎙 AI 음성 비서 없음 → 목록 오른쪽 56px 비움 · 카드 폭 302↔358
- 화면·상태: G4-EXP-22, EXP-01(카드 모양 전체)
- 스크린샷: `shots/G4a/exp-01-top.pair.png`, `exp-06-card1.pair.png`, `exp-01-tall.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:2280-2359` 대안이 있고 `speechSynthesis` 가 있으면 오른쪽 아래(하단 탭 위 12px) 고정 48px 원 `bg-muk text-hanji shadow-[0_4px_14px_rgba(43,35,32,0.22)]` 🎙(`recommend.listenCta`, 실측 (326,668)) — TTS 로 추천 이유를 읽고 음성 명령을 받는다(자막·음소거·카드 강조 `border-gold ring-2 scale-[1.02]`). 목록 `:1583` `max-md:pr-14`(56px) → 카드 **302px**: '바로 갈래요 (도보 길안내)' 두 줄(52.5px), 혜택·근거 칩 두 줄. 빈·오류·스켈레톤도 같은 폭.
- Expo(현재): 없음(`RecommendScreen.tsx:1-2`, PORTING:33, 인벤토리 D1). 목록 `:224` 여백 없음 → **358px**, 한 줄. 카드 1 높이 웹 578 ↔ Expo 482.
- 차이: 떠 있는 🎙 없음, 카드 폭·줄바꿈·높이 전부 다름.
- 중요도: P0
- 분류: 누락 · 배치
- 고칠 방법(선택지): (a) **이식** — `npx expo install expo-speech` + 음성 인식 모듈(개발 빌드), 웹 `lib/voice/*` 중 순수 부분은 `@/lib/voice/...` import 가능 여부를 `npm run check:shared` 로 확인; 48px 버튼은 스크롤 밖 `position:absolute right:16 bottom:16+안전영역`, 목록 `pr-[56px]`, 카드 강조 상태 추가. (b) 버튼 없이 `pr-[56px]` 만 — 빈 띠라 비추천. (c) 제외 유지. 추천: '같게' 원칙이면 (a), 비용이 크면 (c) 로 두고 의도된 차이로 명시.
- 바꿀 Expo 파일: (a) 새 `apps/mobile/features/explore/VoiceControl.tsx`, 새 `apps/mobile/lib/platform/speech.ts`, `RecommendScreen.tsx`, `AlternativeCard.tsx`, `package.json`, `app.json`(마이크 권한)
- 문구(i18n): 재사용 `recommend.listenCta`, `recommend.stopAria`, `recommend.muteAria`, `recommend.unmuteAria`, `recommend.assistantName`, `recommend.listening`, `recommend.interpreting`, `recommend.speakingDefault`, `recommend.canRespondByVoice`, `recommend.voiceHint`, `recommend.sttUnsupportedHint`, `recommend.stateSpeaking`·`stateListening`·`stateThinking`, `voice.pill`, `recommend.ttsUnsupported`, `recommend.micDenied`. 새 키: `app.voice.micPermission`(권한 설명, 4로케일).
- 네이티브 주의: 안드로이드 마이크 권한·음성 인식 서비스 유무, Expo Go 불가, 한국어 TTS 음성 유무. Expo web 은 Web Speech API 그대로 가능.
- 확인 방법: 카드 폭 302, 🎙 (326,668) 48×48, '바로 갈래요' 두 줄.
- 크기: L · 의존: G2(홈 🎙 음성 알약)
- 표시: 결정 필요

### G4a-18 순위 배지 — 카드 모서리 밖 32px ↔ 칩 줄 안 28px
- 화면·상태: G4-EXP-06
- 스크린샷: `shots/G4a/exp-06-card1.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:1695-1702` `absolute -top-2 -left-2 z-10 h-8 w-8 rounded-full border-2 border-white text-[13px] font-extrabold text-white shadow-[0_2px_8px_rgba(193,154,62,0.45)]`, 1위 `bg-gradient-to-br from-gold to-gold-deep`, `aria-hidden`. 실측 카드 기준 (−7,−7) 32px.
- Expo(현재): `apps/mobile/features/explore/AlternativeCard.tsx:152-154` 칩 줄 맨 앞 28×28, 1위 `bg-gold-deep` 단색, 그림자 없음, `accessibilityLabel={String(index+1)}`.
- 차이: 자리, 크기 32↔28, 그라데이션·그림자, 읽기 노출.
- 중요도: P1
- 분류: 배치 · 크기·간격 · 접근성
- 고칠 방법: `:152-154` 삭제, 카드 View(`:141-145`) 맨 앞에 `<View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position:'absolute', top:-8, left:-8, zIndex:10, width:32, height:32, borderRadius:16, borderWidth:2, borderColor:'#fff', boxShadow:'0px 2px 8px rgba(193,154,62,0.45)', alignItems:'center', justifyContent:'center', backgroundColor: index === 0 ? undefined : colors.gold }}>` + 1위면 안쪽 `Gradient [gold, gold-deep] {0,0}→{1,1}` + 13px extrabold 흰 숫자. 저장 카드와 같은 배지라 새 `components/ui/RankBadge.tsx` 로 공용화.
- 바꿀 Expo 파일: `apps/mobile/features/explore/AlternativeCard.tsx`, 새 `apps/mobile/components/ui/RankBadge.tsx`, `apps/mobile/features/saved/SavedCard.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 카드 `overflow` visible 유지. 안드로이드 `zIndex` 가 형제 `PhotoCover`(overflow-hidden) 위인지 실기기 확인.
- 확인 방법: `exp-06-card1` — 배지가 (−8,−8)에 걸침.
- 크기: S · 의존: G4a-07
- 표시: 네이티브 확인 필요

### G4a-19 사진 없는 표지 — 경주 문양 SVG·선 아이콘 ↔ 단색 + 이모지
- 화면·상태: G4-EXP-07(사진 없음)
- 스크린샷: `shots/G4a/exp-07-cover.pair.png`, `exp-07-nophoto-top.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:1706-1707` → `components/PlacePhotoFallback.tsx:99-137` + `app/globals.css:331-337` `.place-tile`: 바탕 `color-mix(tile 13%, hanji-deep)` 위 `radial-gradient(circle at 50% 50%, hanji 45% → 투명 58%)` + `linear-gradient(160deg, tile 12% → 투명 72%)`; 문장 `viewBox 0 0 100 112` `xMidYMid slice`, 장소별 문양(`placeVisual().motif` 기와·수막새·석탑·물결·문살) 선 1.4·타일색·불투명 0.5·`translate(phase*12−6)`; 유형 그림 lucide `Utensils·Coffee·Mountain·Landmark·MapPin` 20px(선 1.8, 타일색), 44px 원 `bg-hanji/90 ring-1 ring-current/40 shadow-[0_2px_10px_rgba(43,35,32,0.12)]`, 세로 **54%**.
- Expo(현재): `apps/mobile/features/explore/PhotoCover.tsx:66-72` 단색 `bg-tile-*-bg` + 44px 한지 원 안 **이모지**(`:32-38` 🍴☕⛰️🏛️📍), 세로 50%. 문양·그라데이션·원 테두리·그림자 없음(PORTING '문양 제외').
- 차이: 문양 없음, 선 그림 ↔ 컬러 이모지, 원 테두리·그림자, 54%↔50%, 바탕 명암.
- 중요도: P1
- 분류: 아이콘·이미지
- 고칠 방법: 1) 문양 경로 함수(`PlacePhotoFallback.tsx:24-90`)는 순수 — 웹을 손댈 수 있으면 `apps/web/lib/placeEmblem.ts` 로 빼서 `@/lib/placeEmblem` 공유(`check:shared` 통과), 아니면 Expo 에 복사 + PORTING 기록. 2) 새 `apps/mobile/components/PlacePhotoFallback.tsx`(react-native-svg 15.15.4): `Svg viewBox="0 0 100 112" preserveAspectRatio="xMidYMid slice"` 에 `RadialGradient`(#faf5ec .45 → 0 at 58%)·`LinearGradient`(160deg ≈ x1 .33 y1 0 → x2 .67 y2 1, tile 12% → 0 at 72%) Rect 둘 + 문양 `Path stroke={tile} strokeWidth={1.4} opacity={0.5} fill="none" vectorEffect="non-scaling-stroke" transform={`translate(${shift} 0)`}`, 바탕 기존 `tile-*-bg`. 3) 원 `position:absolute left:'50%' top:'54%' width:44 height:44 marginLeft:-22 marginTop:-22 borderRadius:22 backgroundColor:'rgba(250,245,236,0.9)' borderWidth:1 borderColor: tile 40% boxShadow:'0px 2px 10px rgba(43,35,32,0.12)'` + 같은 lucide 아이콘 20px `strokeWidth={1.8}` `color={tile}`. 4) `PhotoCover.tsx` 와 대기 `features/waiting/PlaceTile.tsx` 가 같이 쓰게.
- 바꿀 Expo 파일: 새 `apps/mobile/components/PlacePhotoFallback.tsx`, `apps/mobile/features/explore/PhotoCover.tsx`, (G5) `apps/mobile/features/waiting/PlaceTile.tsx`, `apps/mobile/PORTING.md`
- 문구(i18n): 없음
- 네이티브 주의: `vectorEffect` 안드로이드 지원·`slice` 확대 때 선 굵기 확인.
- 확인 방법: 사진 없는 대안(`overlays/G4a/variants`)으로 `exp-07-cover`.
- 크기: M · 의존: G5(대기 표지), G3(카드 사진 표지가 같으면)
- 표시: 결정 필요(PORTING 의도된 제외 — 추천: 이식)

### G4a-20 카드 세부 글자·여백 — 칩 높이, 이름 자간·줄높이, SPOT 그림자, 추정 칩 점선, 영업 질문 패널·👍👎 글자
- 화면·상태: G4-EXP-06·12·13·15
- 스크린샷: `shots/G4a/exp-06-card1.pair.png`, `exp-06-chips-wait-coupon.pair.png`, `exp-13-hours-panel-zoom.pair.png`, `exp-15-voted.pair.png`
- 웹(기준) ↔ Expo(현재):
  - 종류·순위 칩 `page.tsx:1748,1752` `text-[10px] font-bold px-2 py-0.5 rounded-md`(높이 21) ↔ `features/explore/Tag.tsx:39-48` 'sm' 줄높이 normal(높이 17).
  - 이름 `:1768` `text-[22px] font-extrabold tracking-tight mt-1.5 leading-snug`(30.25, −0.55px) ↔ `AlternativeCard.tsx:161` `leading-[28px]`. 대표 메뉴 `:1773` 12px/18 ↔ `:165` 줄높이 normal.
  - SPOT 상자 `:1781` 그림자 `0 2px 10px rgba(193,154,62,0.16)`, 라벨 `:1782` `uppercase tracking-wide` ↔ `:172-182` 그림자 없음.
  - 앞면 추정 칩 `:1826-1831` `border-dashed border-gold/60|jade/60` **바탕 없음** ↔ `Tag.tsx:45` dashed → 테두리 `*/30` + `bg-gold/10` 과 `bg-white/70` 이 한 요소에 같이 붙음(규칙 4 위반, 실측 `bg-white/70`).
  - 근거 칩 `:2046-2056` 점선 `*/60 bg-white/70` ↔ 점선 `*/30`.
  - 영업 질문 패널 `:1861-1876` 질문 12px extrabold, 버튼 11px, `grid-cols-3 gap-2` ↔ `AlternativeCard.tsx:238` 13px, 버튼 `:247,255,263` 12px.
  - 👍/👎 `:1909,1917` 11px `px-2.5` ↔ `:299,307` 12px. '기록했어요' `:1900` 11px `px-1` ↔ `:288` 12px `py-[12px]`.
  - '추천 이유' 라벨 `:1992` `uppercase tracking-wide` ↔ `:339` 자간 없음.
- 차이: 1~4px·자간·그림자·점선 농도.
- 중요도: P2
- 분류: 크기·간격 · 글꼴 · 색·효과
- 고칠 방법: 1) `Tag.tsx`: 'sm' Text `leading-[15px]`; `dashed` 를 `variant: 'solid' | 'dashedFace' | 'dashedEvidence'` 로 — `dashedFace` 는 `border-dashed` + tone 60% 테두리 + 바탕 없음, `dashedEvidence` 는 `border-dashed bg-white/70` + tone 60%; `BOX[tone]` 의 테두리·바탕을 나눠 조합(같은 속성 클래스 둘 금지). 2) 이름 `leading-[30px] tracking-[-0.55px]`, 메뉴 `leading-[18px]`. 3) SPOT 상자 `boxShadow '0px 2px 10px rgba(193,154,62,0.16)'`, 라벨 `tracking-[0.25px]`. 4) 영업 질문 12px, 버튼 11px; 👍/👎 11px; '기록했어요' 11px `px-[4px]` + `min-h-[44px] justify-center`.
- 바꿀 Expo 파일: `apps/mobile/features/explore/Tag.tsx`, `apps/mobile/features/explore/AlternativeCard.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드는 둥근 View 의 `borderStyle:'dashed'` 를 못 그리는 경우가 있다 — 실기기 확인, 안 되면 SVG 테두리.
- 확인 방법: 확대 비교, `work/G4a/out/recommend1.json`.
- 크기: S · 의존: G4a-17(폭)
- 표시: —

### G4a-21 주 행동·'다른 대안 보기' 버튼 모양 — 모서리·글자·색·그림자
- 화면·상태: G4-EXP-06·11
- 스크린샷: `shots/G4a/exp-06-card1.pair.png`, `exp-01-bottom.pair.png`, `exp-11-refreshing.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx` — 줄 `:1880` `grid grid-cols-2 gap-2`; '바로 갈래요' `:1881-1887` `min-h-11 px-2 py-2.5 cta-primary rounded-xl font-bold text-[13px] leading-tight shadow-sm`(모서리 12, 그림자 `0 1px 3px rgba(0,0,0,.1), 0 1px 2px −1px rgba(0,0,0,.1)`); '자동차 길안내' `:1888-1894` `min-h-11 rounded-xl border border-line bg-white px-2 py-2 text-[12px] font-bold leading-tight text-muk-soft`; '🔄 다른 대안 보기' `:2236-2252` `min-h-11 w-full py-3 bg-white border border-line rounded-xl text-muk-soft font-semibold text-xs toss-surface`, 진행 중 14px 고리 + `recommend.loadingMore`, `disabled:opacity-50`.
- Expo(현재): `AlternativeCard.tsx:275-283` 공용 `Button`(`components/ui/Button.tsx:63-93`): `rounded-2xl`(16), 14px/18 bold, primary 그림자 `0 4px 14px rgba(168,70,47,0.28)`, secondary 글자 먹. '다른 대안 보기' `RecommendScreen.tsx:284-291` `Button variant="secondary" block` 14px bold 먹·그림자 없음.
- 차이: 모서리 12↔16, 글자 13/12↔14, 보조 글자 먹 연↔먹, 굵기(다른 대안 semibold↔bold), 그림자 종류.
- 중요도: P1
- 분류: 크기·간격 · 글꼴 · 색·효과
- 고칠 방법(공용 `Button` 은 두고 화면 전용): 1) 주 `Pressable min-h-[44px] flex-1 items-center justify-center overflow-hidden rounded-xl px-[8px] py-[10px]` + 바깥 `boxShadow '0px 1px 3px rgba(0,0,0,0.1), 0px 1px 2px -1px rgba(0,0,0,0.1)'` + `<Gradient name="cta" style={StyleSheet.absoluteFill} />` + 13px/16 bold 흰. 2) 자동차 `min-h-[44px] flex-1 items-center justify-center rounded-xl border border-line bg-white px-[8px] py-[8px]` + 12px/15 bold `text-muk-soft`. 3) 다른 대안 `min-h-[44px] w-full flex-row items-center justify-center gap-[8px] rounded-xl border border-line bg-white py-[12px]` + `boxShadow: shadows.surface` + 12px semibold `text-muk-soft`, 진행 중 14px `ActivityIndicator`(muk-soft) + `recommend.loadingMore`, `opacity-50`.
- 바꿀 Expo 파일: `apps/mobile/features/explore/AlternativeCard.tsx`, `apps/mobile/features/explore/RecommendScreen.tsx`
- 문구(i18n): 재사용 `card.accept`, `card.drive`, `recommend.seeOther`, `recommend.loadingMore`
- 네이티브 주의: 그라데이션+그림자 두 겹.
- 확인 방법: 세 장 재촬영 — 모서리 12, 글자 13/12, 다른 대안 그림자.
- 크기: S · 의존: G4a-17, G3(추천 카드 버튼 규칙과 맞춰 볼 것)
- 표시: —

### G4a-22 혼잡 제보 버튼 없음(보조 행동 줄)
- 화면·상태: G4-EXP-16
- 스크린샷: `shots/G4a/exp-06-card1.pair.png`('지금 붐비나요? 알려 주세요'), `exp-06-chips-wait-coupon.pair.png`('혼잡 제보')
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:1925-1955` 👍👎 다음 `<CongestionReportButton facility={{id,name}} isFirst={rec.congestionSource === 'none'} className="min-h-11" onReported={…}>` — 근거 없으면 비취 알약 "지금 붐비나요? 알려 주세요"(`report.triggerFirst`, `bg-jade/10 border-jade/35 text-jade`), 아니면 "혼잡 제보"(`report.trigger`, `bg-hanji-deep border-line text-muk-soft`), `Users 14`, 12px bold, `px-3 py-2 rounded-full`. 제보 → `POST /api/v1/reports/congestion` → 카드를 '방금 제보' 실측으로(`:1933-1952`: 한산 .2·보통 .5·혼잡 .8, `congestionSource:'measured'`, `congestionLogSource:'user_report'`, `congestionIsCurrent:true`, 지금 시각).
- Expo(현재): 없음 — `AlternativeCard.tsx:4` "옮기지 않은 것: 현장 혼잡 제보 버튼". 같은 모양·API 버튼이 이미 있음: `features/recommendation-card/CongestionReportButton.tsx:24-81`(`facility`, `isFirst`, `onReported`).
- 차이: 대안 화면에서 혼잡 제보 불가(참여 기능 누락), 보조 줄 모양도 다름.
- 중요도: P0
- 분류: 누락 · 동작
- 고칠 방법: 1) `AlternativeCard.tsx:286-319` 에서 👍/👎(또는 '기록했어요') 뒤·공유 앞에 `<CongestionReportButton facility={{ id: rec.facility.id, name: rec.facility.name }} isFirst={rec.congestionSource === 'none'} onReported={(level) => props.onReported(rec, level)} />`. 2) `useAlternatives.ts` 에 `markReported(rec, level)` — `setRecommendations(cur => cur.map(it => it.recommendationId === rec.recommendationId ? { ...it, congestionLevel: level === '한산' ? 0.2 : level === '보통' ? 0.5 : 0.8, congestionSource: 'measured', congestionTimestamp: new Date().toISOString(), congestionLogSource: 'user_report', congestionIsStale: false, congestionIsCurrent: true } : it))`, `RecommendScreen` 에서 연결. 3) `:4` 주석·PORTING 갱신.
- 바꿀 Expo 파일: `apps/mobile/features/explore/AlternativeCard.tsx`, `apps/mobile/features/explore/useAlternatives.ts`, `apps/mobile/features/explore/RecommendScreen.tsx`, `apps/mobile/PORTING.md`
- 문구(i18n): 재사용 `report.trigger`, `report.triggerFirst`, `report.triggerAria`, `report.*`(모달)
- 네이티브 주의: 버튼 안 `ModalSheet` 는 `BottomSheetModalProvider` 안 — 루트 Stack 아래라 이미 충족. 게스트 403 안내는 컴포넌트가 처리.
- 확인 방법: 비취 알약 표시, 시트 → '한산' → (쓰기는 하네스가 가짜 200) '추천 근거 자세히' 근거가 '방문객 제보'로.
- 크기: S · 의존: G3(버튼 소유 — 재사용)
- 표시: —

### G4a-23 공유 버튼 — 웹 아이콘 알약 ↔ Expo '🔗 공유' 사각, 실패 안내
- 화면·상태: G4-EXP-16
- 스크린샷: `shots/G4a/exp-06-card1.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:1958-1972` → `components/ShareButton.tsx:68-75` `inline-flex items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 py-1.5 text-xs font-semibold text-muk-soft` + `min-h-11`, `Share2 15`(복사 뒤 2초 `Check` 비취). 실측 65×44. 실패 `toast.error(common.shareFailed, { description: url, duration: 10000 })`. 주소 `window.location.origin` + `&ref=share`.
- Expo(현재): `AlternativeCard.tsx:311-318` `rounded-lg border-line bg-hanji-deep px-[10px]` + "🔗 공유" 12px(👍👎 와 같은 사각). 실패 `Alert.alert(common.shareFailed, url)`(`useAlternatives.ts:417`). 주소 운영 웹 고정(`lib/platform/shareUrls.ts`, D26).
- 차이: 모양·아이콘, 복사 뒤 체크 없음, 실패 안내 토스트↔대화상자.
- 중요도: P1
- 분류: 아이콘·이미지 · 색·효과 · 동작
- 고칠 방법: 1) `<Pressable accessibilityRole="button" accessibilityLabel={t('common.share')} className="min-h-[44px] flex-row items-center gap-[6px] rounded-full border border-line bg-white/80 px-[12px] py-[6px]"><Icon icon={copied ? Check : Share2} size={15} color={copied ? 'jade' : 'muk-soft'} /><Text className="text-[12px] text-muk-soft" weight="semibold">{t('common.share')}</Text></Pressable>`, `copied` 는 결과 `'copied'` 일 때 2초. 2) `useAlternatives.ts:417` → `toast.error(tt('common.shareFailed'), { description: url, duration: 10000 })`. 3) 주소 origin 은 앱 특성상 고정 유지.
- 바꿀 Expo 파일: `apps/mobile/features/explore/AlternativeCard.tsx`, `apps/mobile/features/explore/useAlternatives.ts`
- 문구(i18n): 재사용 `common.share`, `common.linkCopied`, `common.shareFailed`
- 네이티브 주의: 안드로이드는 네이티브 공유 시트가 먼저(웹 `navigator.share` 와 같은 뜻).
- 확인 방법: 65×44 둥근 알약.
- 크기: S · 의존: G4b(코스 공유 버튼)
- 표시: —

### G4a-24 '추천 근거 자세히' 주변 수요 박스 색 — 하늘·쪽빛 ↔ 무채색
- 화면·상태: G4-EXP-08
- 스크린샷: `shots/G4a/exp-08-why-open.pair.png`, `exp-09-minimap.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:2104-2174` 바깥 `text-[11px] leading-snug text-sky-800 bg-sky-500/10 border border-sky-500/20 rounded-xl px-3 py-2`, 모드 `text-[10px] text-sky-700`, 합성 안내 `mt-1 text-sky-800/80`, 주차 상자 `mt-2 rounded-lg border border-sky-500/20 bg-white/55 px-2.5 py-2`(제목 `text-sky-900`, 반경 `text-[10px] text-sky-700`), 관광 상자 `border-indigo-500/20 bg-white/55 text-indigo-900`(근거 `text-indigo-700`, 면책 `text-indigo-700/90`). v4 sRGB: sky-500 #00a6f4, sky-700 #0069a8, sky-800 #00598a, sky-900 #024a70, indigo-500 #615fff, indigo-700 #432dd7, indigo-900 #312c85.
- Expo(현재): `AlternativeCard.tsx:411-465` 바깥 `border-line bg-white/70`, 안 `border-line bg-white`, 글자 `muk`/`muk-soft`.
- 차이: 하늘색 상자·글자 ↔ 흰·회갈색.
- 중요도: P1
- 분류: 색·효과
- 고칠 방법: `lib/theme/tokens.ts` colors 에 `'sky-500-web'`·`'sky-700-web'`·`'sky-800-web'`·`'sky-900-web'`·`'indigo-500-web'`·`'indigo-700-web'`·`'indigo-900-web'`(위 hex) 추가(또는 v3 기본 `sky-*`·`indigo-*` — 색 약간 다름). `:412` → `rounded-xl border border-sky-500-web/20 bg-sky-500-web/10 px-[12px] py-[8px]`, 제목 `text-[11px] leading-[15px] font-bold text-sky-800-web`, 모드 `text-[10px] text-sky-700-web`, 합성 안내 `text-sky-800-web/80`, 주차 상자 `mt-[8px] rounded-lg border border-sky-500-web/20 bg-white/55 px-[10px] py-[8px]`(제목 `text-sky-900-web`, 반경 `text-sky-700-web`), 관광 상자 `border-indigo-500-web/20 bg-white/55`(글자 `-900-web`/`-700-web`). 바깥 `gap` 대신 웹처럼 `mt-[4px]`·`mt-[8px]`. `tokens.test.ts` 에 새 토큰.
- 바꿀 Expo 파일: `apps/mobile/lib/theme/tokens.ts`(+ `tokens.test.ts`), `apps/mobile/features/explore/AlternativeCard.tsx`
- 문구(i18n): 재사용 `recommend.areaEvidenceCount`, `recommend.areaDemand*`, `recommend.parkingEvidence*`, `recommend.tourismEvidence*`
- 네이티브 주의: 없음
- 확인 방법: `exp-08-why-open` 하늘색 상자.
- 크기: S · 의존: 없음
- 표시: —

### G4a-25 미니맵 — 높이 96↔112 · 카카오 기본 핀 ↔ 금빛 점
- 화면·상태: G4-EXP-09
- 스크린샷: `shots/G4a/exp-09-minimap.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:211-216` `w-full h-24 md:h-28 rounded-xl overflow-hidden border border-line`(폰 **96px**), level 3·끌기/확대 없음 + `new kakao.maps.Marker({position})`(**카카오 기본 파란 핀**, `:187-190`). 키 없으면 📍 "경주 관광지/위치 미리보기" 판(`:197-208`).
- Expo(현재): `apps/mobile/features/explore/MiniMapPreview.tsx:23-31` `h-[112px]`, 마커 `kind:'dot'` 금빛 16px(`:19-21`).
- 차이: 높이 +16, 표시 마커 모양(지도 바탕은 달라도 됨).
- 중요도: P1
- 분류: 크기·간격 · 아이콘·이미지
- 고칠 방법: 1) `:25` `h-[96px]`. 2) `features/map/types.ts` 에 마커 `kind:'default'` — `NextSpotMap.web.tsx` 는 `new kakao.maps.Marker({ position })`, 네이티브 `NextSpotMap.tsx` 는 파란 물방울 핀(react-native-svg 29×42, 아래 끝 기준점). `MiniMapPreview` 마커를 `{ kind: 'default', id: 'place', coordinate: center, title: name }`. 3) 키 없을 때 Expo 는 단색 상자 — 웹처럼 📍 + `recommend.mapPreviewRegion`·`recommend.mapPreviewLabel` 판(`MAP_AVAILABLE=false` 분기).
- 바꿀 Expo 파일: `apps/mobile/features/explore/MiniMapPreview.tsx`, `apps/mobile/features/map/types.ts`, `apps/mobile/features/map/NextSpotMap.web.tsx`, `apps/mobile/features/map/NextSpotMap.tsx`
- 문구(i18n): 재사용 `recommend.mapPreviewRegion`, `recommend.mapPreviewLabel`
- 네이티브 주의: 네이티브 바탕은 구글/애플(허용) — 핀은 색·크기·기준점만 맞춘다.
- 확인 방법: 미니맵 높이 96, 가운데 파란 핀.
- 크기: M · 의존: G2(지도 컴포넌트 소유)
- 표시: 네이티브 확인 필요

### G4a-26 '순서 자세히' → 비교 펼침 — 웹 가로 표 ↔ Expo 지표별 세로 묶음
- 화면·상태: G4-EXP-10(접힘·펼침)
- 스크린샷: `shots/G4a/exp-10-order-collapsed.pair.png`, `exp-10-order-expanded.pair.png`, `exp-10-order-expanded-tall.pair.png`
- 웹(기준): `apps/web/components/RecommendationComparison.tsx` — 접힘 `:74-86`(버튼 `:82` `mt-3 … rounded-xl border-gold/30 bg-gold/10 py-2.5 text-xs font-bold` 높이 ≈36, 상자 `mb-4`). 펼침 `:87-127` 제목 `font-bold text-muk`(**16px**) + 닫기 `X 17`(맨 아이콘), Top3 요약, **표** `:95-123` `<div class="overflow-x-auto"><table class="w-full min-w-[520px] text-xs text-center">` 머리 줄 "비교 항목 | 1. 고도 커피 | 2. No Words | 3. 호랑이카츠", `divide-y divide-line`, 칸 `px-2 py-2 font-semibold` — 보이는 폭 324라 3번째 열은 밀어야 보임(실측 520/324). 질문 칩 `:124` `rounded-full px-3 py-1.5 text-xs font-bold` + `Sparkles 12`(≈30).
- Expo(현재): `apps/mobile/features/explore/ComparisonSection.tsx:164-229` 제목 14px, 닫기 36px 상자 20px X, 표 대신 지표마다 "N. 장소명 — 값" 세로 묶음(`:185-199`), 질문 칩 `min-h-[44px]`(`:208`), 접힘 버튼 `min-h-[44px]`(`:118`). 머리 주석 `:1-2` 가 의도된 변경이라 적음.
- 차이: 표(행=지표·열=장소) ↔ 목록, 길이(Expo 2배 이상), 제목 16↔14, 칩·버튼 30/36↔44.
- 중요도: P0
- 분류: 배치 · 크기·간격
- 고칠 방법(선택지): (a) **웹과 같은 표** — `:185-199` 를 `<ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={{ width: 520 }}>` + 머리 줄(`flex-row`; 첫 칸 왼쪽 `compare.metric` 12px bold, 장소 칸 가운데 `${rank}. ${name}` 12px bold `px-[8px] py-[8px]`) + 6개 행(첫 행 제외 `border-t border-line`; 라벨 12px semibold `text-muk-soft` 왼쪽 `py-[8px]`; 값 12px semibold `text-muk` 가운데 `px-[8px] py-[8px]`). 제목 `text-[16px]`, 닫기 `Icon X size={17}`(맨 아이콘, `hitSlop` 으로 44), 질문 칩 `rounded-full border border-jade/30 bg-jade/10 px-[12px] py-[6px]` 12px bold + `Sparkles 12`(`hitSlop` 7), 접힘 버튼 `py-[10px]`(`hitSlop` 4), 상자 `mb-[16px]`. (b) 세로 묶음 유지. 추천: (a) — 가로 밀기 표가 불편하다면 웹도 함께 바꾸는 것이 맞다(한쪽만 바꾸지 않기).
- 바꿀 Expo 파일: `apps/mobile/features/explore/ComparisonSection.tsx`
- 문구(i18n): 재사용 `compare.title`, `compare.metric`, `compare.spot`, `compare.preference`, `compare.walkWait`, `compare.congestion`, `compare.openStatus`, `compare.coupon`, `compare.open`, `compare.question.*`, `recommend.spotComparison.*`
- 네이티브 주의: 세로 안 가로 `ScrollView`(`nestedScrollEnabled`), 큰 글자에서 행 높이 맞춤.
- 확인 방법: `exp-10-order-expanded` — 표 머리 줄·가로 밀기.
- 크기: M · 의존: 없음
- 표시: 결정 필요

### G4a-27 로딩 스켈레톤(대안) — 카드 패딩·그림자·사진 블록 농도
- 화면·상태: G4-EXP-02
- 스크린샷: `shots/G4a/exp-02-loading-origin.pair.png`, `exp-02-loading-list.pair.png`, `exp-02-skeleton-card.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:1586-1595` `bg-white p-5 rounded-2xl border border-line toss-surface animate-pulse gap-3`(패딩 20, 판 그림자), 사진 `h-36 bg-hanji-deep/60 rounded-xl`, 제목 `h-5 w-2/3`, 칩 `h-7 w-20`·`w-24`, 버튼 `h-11 rounded-xl mt-1`. 머리글 제목 스켈레톤 `:1519-1522` 는 같음.
- Expo(현재): `RecommendScreen.tsx:226-241` 패딩 16, 그림자 없음, 사진 블록 불투명, 버튼 위 여백 없음.
- 차이: 패딩 20↔16, 그림자, 사진 농도 60↔100%, 버튼 4px.
- 중요도: P2
- 분류: 상태(로딩·빈·오류) · 크기·간격
- 고칠 방법: `:229` `p-[20px]` + `boxShadow: shadows.surface`, 사진 `Skeleton height={144} radius={12}` 색 `rgba(241,231,211,0.6)`(G4a-11 의 `color` prop), 버튼 `Skeleton height={44} radius={12} style={{ marginTop: 4 }}`.
- 바꿀 Expo 파일: `apps/mobile/features/explore/RecommendScreen.tsx`, (선택) `apps/mobile/components/ui/Skeleton.tsx`
- 문구(i18n): 재사용 `recommend.preparing`
- 네이티브 주의: 없음
- 확인 방법: `overlays/G4a/loading` 으로 `exp-02-skeleton-card`.
- 크기: S · 의존: G4a-17, G4a-11
- 표시: —

### G4a-28 오류 상태 — '다시 시도' 버튼 색·크기·아이콘 · 재시도 범위
- 화면·상태: G4-EXP-18
- 스크린샷: `shots/G4a/exp-18-error-box.pair.png`, `exp-18-error.pair.png`, `exp-18-retry.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:2212-2216` → `components/ErrorState.tsx:15-25` `p-8 rounded-2xl border-terracotta/25 shadow-[…0.06]`, ⚠️ `text-3xl`, 14px semibold, 버튼 `px-4 py-2 rounded-full bg-gold text-white text-xs font-bold`(금 #c19a3e, 12px, ≈32 높이, 아이콘 없음). 다시 시도 = `window.location.reload()`(원래 장소·세션·온보딩 판정부터 다시).
- Expo(현재): `apps/mobile/components/ui/ErrorState.tsx:30-73` 버튼 `min-h-[44px] rounded-full bg-gold-deep px-[18px]`(#705819, 13px, `RotateCw 14`) — 주석 `:24-25` 대비 때문에 바꿨다고 적음. 다시 시도 = `retry()`(`useAlternatives.ts:225`, 목록만 다시; 원래 장소는 다시 안 읽음).
- 차이: 색(대비 3.7↔4.5+), 크기 32↔44, 글자 12↔13, 아이콘, 재시도 범위(화면 결과는 같음).
- 중요도: P1
- 분류: 색·효과 · 크기·간격 · 동작
- 고칠 방법(공용 컴포넌트라 결정 후): 1) 웹과 같게 — 버튼 `rounded-full bg-gold px-[16px] py-[8px]` 12px bold 흰, 아이콘 제거, `hitSlop={{top:6,bottom:6}}`. 2) 또는 웹 `components/ErrorState.tsx` 를 Expo 값으로 올려 두 앱을 맞춤(대비 기준 `docs/DESIGN_PRINCIPLES.md` — 추천). 3) 재시도 범위: `useAlternatives` 원래 장소 effect deps 에 `reloadKey` 추가.
- 바꿀 Expo 파일: `apps/mobile/components/ui/ErrorState.tsx`(또는 웹 `apps/web/components/ErrorState.tsx`), `apps/mobile/features/explore/useAlternatives.ts`
- 문구(i18n): 재사용 `recommend.loadFailed`, `common.retry`
- 네이티브 주의: 없음
- 확인 방법: `overlays/G4a/error` 로 `exp-18-error-box`.
- 크기: S · 의존: G2·G4b·G5(같은 `ErrorState` 화면 전부 — 한 번에 결정)
- 표시: —

### G4a-29 빈 상태(대안 0곳) — 웹 그라데이션 알약 CTA·이모지 위치 ↔ Expo EmptyState
- 화면·상태: G4-EXP-17
- 스크린샷: `shots/G4a/exp-17-empty-box.pair.png`, `exp-17-empty.pair.png`
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:2219-2229` `flex-col items-center gap-3 rounded-2xl border border-line bg-white px-5 py-6 text-center toss-surface`, 이모지 없이 15px bold 문구 → `min-h-11 px-5 rounded-full cta-primary text-[13px] font-bold shadow-[0_4px_14px_rgba(168,70,47,0.28)]` 버튼 안 "🧭 지도에서 다른 곳 둘러보기". 실측 302×128.5.
- Expo(현재): `RecommendScreen.tsx:272-278` `EmptyState emoji="🧭"` → 위 30px 이모지, 패딩 28, 옅은 카드 그림자, `Button variant="secondary"`(흰·먹, 이모지 없음). 실측 358×183.
- 차이: 🧭 위치, 버튼 색(주 그라데이션 ↔ 흰), 패딩·그림자, 높이.
- 중요도: P1
- 분류: 배치 · 색·효과
- 고칠 방법: 전용 블록 — `<View testID="recommend-empty-next" className="w-full items-center gap-[12px] rounded-2xl border border-line bg-white px-[20px] py-[24px]" style={{ boxShadow: shadows.surface }}>` + `<Text className="text-center text-[15px] leading-[22px]" weight="bold">{t('recommend.emptyNext')}</Text>` + 주 버튼(`Pressable min-h-[44px] flex-row items-center gap-[6px] overflow-hidden rounded-full px-[20px]` + `Gradient name="cta"` + `boxShadow: shadows.cta` + 장식 🧭(읽기 숨김) + 13px bold 흰 `recommend.exploreMap`) → `/`.
- 바꿀 Expo 파일: `apps/mobile/features/explore/RecommendScreen.tsx`
- 문구(i18n): 재사용 `recommend.emptyNext`, `recommend.exploreMap`
- 네이티브 주의: 그라데이션+그림자 두 겹.
- 확인 방법: `overlays/G4a/empty` 로 `exp-17-empty-box`.
- 크기: S · 의존: G4a-17
- 표시: —

### G4a-30 웹 전용 온보딩 모달 · 자연어 선호 입력
- 화면·상태: G4-EXP-23
- 스크린샷: `shots/G4a/exp-23-onboarding.pair.png`(웹: `nextspot_onboarding_done` 없음 + 추천 기록 0건 HEAD 모킹)
- 웹(기준): `apps/web/app/explore/recommend/page.tsx:2362-2470` 전체 모달(`fixed inset-0 z-50 bg-muk/40 backdrop-blur-md`, 흰 카드 `max-w-sm p-6 rounded-3xl`): 🎯 "맞춤형 추천 온보딩", 설명, 자연어 입력(+🎤), "AI로 선호 분석하기 ✨"(`POST /api/v1/preferences/parse` 실 쓰기), "또는 직접 선택", 분류 4버튼, "선택 완료 (0/3+)". 닫기·Esc 없음. 조건 `:735-751`: `recommendations` 개수 0 **그리고** `nextspot_onboarding_done` 없음 — 이때 대안 조회 안 함.
- Expo(현재): 없음(D2·D3). 첫 실행 게이트의 첫 설정이 '시작하기'·'건너뛰기' 모두 `nextspot_onboarding_done='1'` 을 씀(`features/onboarding/setupPrefs.ts:43-48`, `app/setup.tsx:41-44,85`) — 앱 사용자는 이 조건을 만족할 수 없다.
- 차이: 웹에서 첫 설정을 거치지 않은 새 사용자만 본다. '첫 설정을 마친 사용자' 끼리는 두 앱 모두 모달 없음.
- 중요도: P1
- 분류: 누락 · 동작
- 고칠 방법(선택지): (a) 같은 조건으로 이식(앱에서는 사실상 안 뜸). (b) 현행 유지 — 앱 첫 설정이 같은 역할. 추천: (b), PORTING 에 '앱은 첫 설정이 모달을 대신함' 명시. 자연어 선호 입력만 원하면 첫 설정 화면 별도 과제.
- 바꿀 Expo 파일: (a) 새 `apps/mobile/features/explore/OnboardingModal.tsx`, `RecommendScreen.tsx`, `useAlternatives.ts` / (b) `apps/mobile/PORTING.md`
- 문구(i18n): (a) 재사용 `recommend.onboardingTitle`, `recommend.onboardingBody`, `recommend.nlLabel`, `recommend.nlPlaceholder`, `recommend.nlAnalyzeCta`, `recommend.nlAnalyzing`, `recommend.nlGetRecs`, `recommend.orSelectManually`, `recommend.selectDone`, `recommend.selectAtLeast3`, `recommend.savingSettings`, `recommend.speakByVoice`
- 네이티브 주의: (a) 자연어 분석은 외부 AI 전송 — Expo AI 동의(`nextspot_ai_consent`) 흐름 필요.
- 확인 방법: (b) 해당 없음.
- 크기: (a) L / (b) S · 의존: G1(첫 설정)
- 표시: 결정 필요

---

## [EXM] 탐색 지도 — 웹 `/explore/map` ↔ Expo(없음)

### G4a-31 `/explore/map` — 웹은 `/main` 으로, Expo 는 '길을 잘못 드셨어요'
- 화면·상태: G4-EXM-01
- 스크린샷: `shots/G4a/exm-01-explore-map.pair.png`
- 웹(기준): `apps/web/app/explore/map/page.tsx:5-13` 마운트 후 `router.replace('/main')`(옛 주소·북마크 호환). 실측 최종 `/main`.
- Expo(현재): 라우트 없음(`apps/mobile/app/explore/` 에 `recommend.tsx` 만) → `+not-found` "길을 잘못 드셨어요 / 찾으시는 페이지가 없어요. 지도로 돌아가 다시 시작해 보세요. / 지도로 돌아가기"(실측).
- 차이: 같은 주소 → 웹 지도, Expo 404(한 번 더 눌러야 지도).
- 중요도: P1
- 분류: 동작
- 고칠 방법: 새 `apps/mobile/app/explore/map.tsx`: `import { Redirect } from 'expo-router'; export default function ExploreMapRedirect() { return <Redirect href="/" />; }` — 첫 실행 게이트는 그대로 앞에서 막는다.
- 바꿀 Expo 파일: 새 `apps/mobile/app/explore/map.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 딥링크 `…/explore/map` 도 같은 파일로 처리.
- 확인 방법: `work/G4a/exm.mjs` → Expo 최종 `/`.
- 크기: S · 의존: 없음
- 표시: —

---

## 촬영 못 한 상태(코드로만 비교)

- G4-SAV-10 게스트 vs 로그인 — 화면 분기 없음(같은 코드 경로), 원격 병합만 다름.
- G4-EXP-14 길안내 수락 — 쓰기·외부 창이 많아 누르지 않음. 코드상 같은 토스트 2개(`recommend.acceptStart` + `trip.selectWalking`/`trip.driveBasisHint`). Expo 만 '실제 내 위치일 때' 출발지를 넘김(`useAlternatives.ts:255-266`; 웹 `lib/navigation.ts:17-30` 은 출발지 없음; Expo web 은 같은 https 링크).
- G4-EXP-16 공유 누른 결과(클립보드/네이티브 공유 — 헤드리스 비결정). 모양만 비교(G4a-23).
- G4-EXP-19 가드·이름+종류 진입, G4-EXP-20 위치 거부 토스트 — 같은 판정·문구(코드 대조).
- G4-EXP-22 음성 비서 동작 중(TTS/STT) — 누르지 않음.
- 사진 출처 줄 — 픽스처에 출처가 붙는 사진이 없어 도달 못 함(같은 판정 `creditForDisplayedPhoto`, 10px/14 밑줄).
- '순서 자세히' 질문 칩 답변(LLM) — 하네스가 막음(`compare.explainFailed` 상자, 같은 모양 코드).
- '다른 대안 보기' 실패 토스트(`recommend.refreshError`) — 같은 흐름 코드.

## 열린 질문

1. G4a-13 저장 상세 '바로 갈래요': 웹(카카오맵만)과 Expo(서버 수락·여정 기록) 중 어느 쪽이 의도인가 — 웹 쪽 누락일 수 있다.
2. G4a-28 오류 버튼: 웹 금(흰 글자 3.7:1)과 Expo 금 진(4.5:1+) 중 어느 쪽으로 두 앱을 맞출지.
3. G4a-26·G4a-17: 웹의 가로 밀기 표·56px 음성 여백이 폰에서 '정답'인지, 웹도 바꿀 후보인지.
4. 웹 저장 상세 베일 주석은 '어두워진다'인데 실제 `bg-hanok`(#efe7d8) 40% 라 밝은 베일 — 웹 의도와 다른지(웹 버그 의심, 맞춘다면 지금 값).
5. G4a-11: 웹 `/saved` 가 들어올 때마다 로컬 목록이 있어도 스켈레톤을 보이는 것이 의도인가.

## 다른 묶음에 넘길 것

- G2: 대안 화면에서 웹은 하단 탭+가이드 줄(홈 활성)이 보이고 Expo 는 탭이 없다(스택 화면) — `exp-01-top.pair.png`.
- G2: 토스트 전역 모양·위치 — 웹 sonner 는 하단 탭을 덮고 체크·action 버튼 검정, Expo 는 탭 막대 위 64px·비취 체크·action 금 진. 탭 없는 대안 화면에서도 Expo 토스트가 64px 떠 있다(`sav-05-delete-toast`, `sav-06-clear-confirm`, `exp-15-voted`).
- G2: 공용 `ErrorState`·`EmptyState`·`Button`·`Chip` 모양이 웹 화면별 값과 다르다(G4a-04·05·10·28·29) — 공용을 바꿀지 화면별로 그릴지 한 번에 결정.
- G3: 저장 상세 시트 안 카드 구성(웹 'AI 추천'·대표 메뉴 줄 ↔ Expo '줄 서는 대신'·도보 머리 순서), Expo web 시트 반투명(`Sheet.tsx:118`).
- G3: 킵 버튼을 `onKeep` 있을 때만·`rankMode` prop(G4a-13 3·4번) — `RecommendationSheet`·`cardModel` 소유.
- G3: 길안내 링크 차이(웹 `link/map/`·출발지 없음 ↔ Expo 출발지 있으면 `kakaomap://route?…by=foot`) — 안드로이드 동작 차이(D27).
- G5: `NowChip`(G4a-03)·`GoldenHourLabel`(G4a-09)·장소 표지(G4a-19)는 대기 보드와 같은 컴포넌트 — 같이 고친다.
- G4b: 공유 버튼 모양(G4a-23)이 코스 화면과 같은 과제.
