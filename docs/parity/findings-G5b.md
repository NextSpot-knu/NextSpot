# G5b 마이 — 웹 ↔ Expo 화면 비교 결과 (findings-G5b)

- 비교 대상: 웹 `http://localhost:3000`(정적 export, 기준) ↔ Expo web 빌드 `https://nextspot.expo.app`. 390×844 @2x, ko-KR, Asia/Seoul, 경주 GPS. 공유 게스트(`state:'saved'`) 하나만 썼다.
- 코드 기준: `yunseong` `c6374ab` 작업 트리. 표기 `apps/web/...:줄` · `apps/mobile/...:줄`. 저장소 파일은 하나도 고치지 않았다.
- 범위: 인벤토리 [MY] [CPN] [IMP] [INQ] [LAB] [PRV] [SETG] [SUP] + G5 공통 전제. 화면을 그리는 GET(`account/me` · `auth/v1/user` · `rest/v1/users` · `impact/summary` · `lab/pending(/count)` · `inquiries/mine` · `users/me/vector` · `coupons/mine`)은 상태마다 두 앱에 같은 mock 을 줬다(`scratch/parity/work/G5b/common.mjs`). 로그인 계정 화면은 `GET /auth/v1/user` + `GET /api/v1/account/me` mock 으로 만들었다(실제 로그인 없음).
- 쓰기: 프로필 저장(PATCH users) · 쿠폰 사용 · 실험실 칩/건너뛰기 · 문의 보내기는 정책이 가짜 성공으로 답하거나 이 그룹 mock(500·지연)이 답했다 — 운영으로 나간 쓰기 0건(`logs/blocked-writes.jsonl` 의 `G5b-*` run). 로그아웃·데이터 초기화·계정/게스트 삭제·동의 철회는 확인창까지만 보고 **취소**했다(웹 토스트 '취소' · Expo `window.confirm` dismiss).
- 스크립트: `scratch/parity/work/G5b/01~08*.mjs`, 스크린샷 `scratch/parity/shots/G5b/*.pair.png`(왼쪽 웹 · 오른쪽 Expo), 측정값 `*.measure.json`(계산된 글자·상자 스타일).

## 요약

| 중요도 | 개수 |
|---|---|
| P0 (구성·요소 누락/추가·흐름) | 8 |
| P1 (눈에 띄는 크기·간격·색·아이콘·문구·동작) | 22 |
| P2 (자세히 봐야 보이는 차이) | 8 |
| **합계** | **38** |

`결정 필요` 12건(05 08 09 10 11 19 22 29 30 33 35 36) · `네이티브 확인 필요` 7건(03 06 09 17 26 28 38) · `촬영 못 함` 3건(18 22 33).

**가장 중요한 5가지**

1. **G5b-07 마이 머리 구성이 다른 앱처럼 보인다** — 웹: 햄버거 · NextSpot 로고 · 언어 select 알약 · 종(머리 고정, 내용만 스크롤) ↔ Expo: '마이' 글자 + 톱니(머리가 내용과 함께 스크롤).
2. **G5b-01 마이 하위 화면 7개에 하단 탭 막대가 없다** — 웹은 `/mypage/*` 에도 하단 탭(마이 활성). 같은 원인으로 딥링크 뒤 '뒤로'가 홈 `/` 으로 간다(G5b-02).
3. **G5b-03 색이 들어간 카드가 전부 흰 카드로 그려진다** — Expo `Card`(`apps/mobile/components/ui/Card.tsx:31`)의 기본 `bg-white border-line` 이 화면 클래스(`bg-gold/10`·`border-gold/35`·`bg-hanji-deep`)를 이긴다. 다른 그룹 화면에도 걸린다.
4. **G5b-09(+08·10·11) 웹에만 있는 카드 4종** — 게스트 '카카오/구글로 계속하기'(Expo web 없음, 안드로이드 구글 하나), 콘솔 미리보기, 혼잡 알림 토글, 앱 안 콘솔·역할 변경 카드(Expo 는 '웹에서 열기'). 모두 결정 필요.
5. **G5b-30 개인정보·약관 문안** — 웹 7절·2026-10-31 ↔ Expo 13절·2026-11-02 + '웹에서 전체 안내 보기'. 법무 검토(`docs/MOBILE_PRIVACY_DRAFT.md`) 대기 — 결정 필요.

---

## 공통 (마이 하위 화면 전체)

### G5b-01 마이 하위 화면에 하단 탭 막대가 없다
- 화면·상태: CPN·IMP·INQ·LAB·PRV·SETG·SUP 전 상태(G5 공통 전제 '하단 탭/헤더 차이')
- 스크린샷: shots/G5b/cpn-05-list.pair.png · sup-01-form.pair.png · lab-05-list.pair.png
- 웹(기준): `BottomNav` 가 `/mypage` 와 하위 경로 모두에서 보인다 — `NAV_ROUTES` 에 `/mypage`, `startsWith(r + '/')`(`apps/web/components/shell/BottomNav.tsx:38-39`), 활성 '마이'(`:55`). 하위 화면 `main` 은 `pb-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))]`(예 `apps/web/app/mypage/coupons/page.tsx:114`, 80px `apps/web/app/globals.css:74`).
- Expo(현재): 하위 7개가 루트 Stack 위 `mypage` Stack(`apps/mobile/app/mypage/_layout.tsx:13-31`, 루트 `Stack.Screen name="mypage"` `apps/mobile/app/_layout.tsx:92`)이라 탭 막대가 가려진다. 화면 `edges={['left','right','bottom']}`.
- 차이: 하위 화면에서 하단 탭 5개가 사라진다.
- 중요도: P0
- 분류: 누락 · 배치
- 고칠 방법:
  1) 하위 화면을 마이 탭 안 중첩 Stack 으로: `app/(tabs)/mypage.tsx` → `app/(tabs)/mypage/index.tsx`, `app/mypage/{coupons,impact,inquiries,lab,privacy,settings,support}.tsx` → `app/(tabs)/mypage/`. URL 은 `/mypage/...` 그대로(그룹 폴더).
  2) `app/(tabs)/mypage/_layout.tsx` 신설: 지금 `app/mypage/_layout.tsx` 의 Stack(+G5b-02 사용자 머리) + `<Stack.Screen name="index" options={{ headerShown: false }} />` + `export const unstable_settings = { initialRouteName: 'index' };`(딥링크에서도 아래에 마이 메인이 깔린다 — 루트 `app/_layout.tsx:23` 과 같은 방식).
  3) `app/mypage/_layout.tsx` 와 루트 `app/_layout.tsx:92` 의 `<Stack.Screen name="mypage" …/>` 삭제. `(tabs)/_layout.tsx:77` `<Tabs.Screen name="mypage">` 는 그대로.
  4) 하위 화면 `Screen edges` → `['left','right']`, 마지막 요소 아래 `pb-[24px]`.
  5) 하위 화면에서 탭 '마이'를 누르면 메인으로 돌아오는지 확인(웹은 `/mypage` 이동, `BottomNav.tsx:68-77`). 아니면 `listeners.tabPress` 에서 `router.navigate('/mypage')`.
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx`(이동) · `app/mypage/*.tsx`(이동) · `app/mypage/_layout.tsx`(→`app/(tabs)/mypage/_layout.tsx`) · `app/_layout.tsx:92` · `PORTING.md`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 뒤로 키는 탭 안 스택을 먼저 pop. `useQuiet`(`features/mypage/useQuiet.ts:16`) 포커스 재조회는 중첩 스택에서도 동작. 첫 실행 게이트(`(tabs)/_layout.tsx:35-40`)가 하위 딥링크에도 걸린다(동작 같음).
- 확인 방법: `work/G5b/04-coupons-impact.mjs` 재실행 → Expo 쪽 아래 탭 막대(마이 활성); `08-behaviour.mjs` `deeplink-*.after.expo` 가 `/mypage`.
- 크기: M · 의존: G5b-02, G2(탭 막대 모양)
- 표시: —

### G5b-02 하위 화면 머리: 아이콘·제목 크기·구분선·접근성 라벨·뒤로 목적지
- 화면·상태: CPN·IMP·INQ·LAB·PRV·SETG·SUP 머리
- 스크린샷: shots/G5b/imp-03-share.pair.png · inq-05-list-tall.pair.png · nav-back-after-deeplink.pair.png
- 웹(기준): 페이지 안 `<header className="flex items-center gap-3 p-5">`(높이 68) — `ChevronLeft size 24 text-muk-soft`, 제목 `h1 text-xl font-bold font-serif tracking-wide`(20px·700·자간 0.5px 측정)(coupons `:100-111`, impact `:103-114`, lab `:209-221`, privacy `:31-41`, settings `:92-102`). 내 문의·고객지원은 `ArrowLeft` + `mr-4` + `border-b border-line`(inquiries `:111-120`, support `:81-90`). aria-label: 쿠폰·임팩트 '뒤로'(`coupons.backAria`·`impact.backAria`), 실험실·설정·개인정보 '마이페이지로 돌아가기'(`settings.backAria`·`privacy.backAria`), 내 문의 '내 문의'(`inquiries.title`), 고객지원 없음. 뒤로 = 늘 `router.push('/mypage')`(`apps/web/lib/navigation.ts:13`).
- Expo(현재): react-navigation 기본 머리(`apps/mobile/app/mypage/_layout.tsx:14-21`) — 높이 64, ←, 색 muk, 제목 Freesentation-7Bold 18px 자간 없음, 구분선 없음, 뒤로 aria-label **"(tabs), back"**(측정), 뒤로 = 스택 pop → **딥링크 뒤에는 홈 `/`**(측정: `/mypage/coupons`·`/settings`·`/support` → `/`). 메뉴에서 들어오면 `/mypage`.
- 차이: ‹ vs ←, 20→18px·자간, 68→64, 구분선 없음, 접근성 이름 오류, 딥링크 후 목적지.
- 중요도: P1
- 분류: 아이콘·이미지 · 글꼴 · 동작 · 접근성
- 고칠 방법:
  1) `features/mypage/components/SubPageHeader.tsx`: 바깥 `View` `paddingTop: insets.top` `bg-hanji`; 안 `flex-row items-center gap-[12px] p-[20px]`(bordered 변형 `gap-[16px] border-b border-line`). 뒤로 `IconButton icon={ChevronLeft|ArrowLeft} size="xl" color="muk-soft" box={24}`, 제목 `Text className="text-xl tracking-[0.5px]" weight="bold" accessibilityRole="header"`.
  2) 뒤로 `router.navigate('/mypage')`(고정 목적지).
  3) 화면별: coupons Chevron·`coupons.backAria` · impact Chevron·`impact.backAria` · lab Chevron·`settings.backAria` · privacy Chevron·`privacy.backAria` · settings Chevron·`settings.backAria` · inquiries Arrow+bordered·`inquiries.title` · support Arrow+bordered·`settings.backAria`(웹은 라벨 없음 — Expo 는 접근성상 둔다). 레이아웃 `screenOptions.header` 로 연결.
- 바꿀 Expo 파일: `app/mypage/_layout.tsx`(또는 G5b-01 후 `app/(tabs)/mypage/_layout.tsx`) · 새 `features/mypage/components/SubPageHeader.tsx`
- 문구(i18n): 재사용 `coupons.backAria` `impact.backAria` `settings.backAria` `privacy.backAria` `inquiries.title` + 각 화면 제목 키 / 새 키 없음
- 네이티브 주의: 안드로이드 기본 머리도 웹과 다르다 — 사용자 머리로 세 곳이 같아진다. 하드웨어 뒤로는 스택 pop 유지.
- 확인 방법: `08-behaviour.mjs` → `back.deeplink-*.after.expo` = `/mypage`; `04-coupons-impact.mjs` `headerInfo` → 높이 68·라벨 '뒤로'·제목 20px.
- 크기: M · 의존: G5b-01
- 표시: —

### G5b-03 색이 들어간 카드가 흰 카드로 그려진다(`Card` 기본 클래스가 화면 클래스를 이김)
- 화면·상태: MY-06(임팩트 요약 카드·줄인 대기 배너) · MY-09(실험실 카드) · MY-04/07(콘솔·역할 카드, 심사중 카드) · MY-01 안드로이드 게스트 계정 카드 · IMP-03 머리 카드·공유 카드 테두리 · CPN-05 사용 완료·만료 카드 · SETG 사장님 카드
- 스크린샷: shots/G5b/my-04-06-member-tall.crop-impactcard.png · my-07-admin-pending-tall.crop-role.png · cpn-05-list.pair.png
- 웹(기준): 임팩트 요약 `border-gold/35 bg-gradient-to-r from-gold/15 via-hanji to-jade/10`(`apps/web/components/ImpactSummaryCard.tsx:68`) · 배너 `from-gold/15 via-hanji-deep/60 to-jade/10 border-gold/30`(`apps/web/app/mypage/page.tsx:587`) · 실험실 카드 `border-jade/35 from-jade/12 via-hanji to-gold/10`(`:640`) · 사장님 `border-gold/35 from-gold/15 via-hanji to-terracotta/10`(`:140`) · 관제 `border-gold/30 bg-gold/5`(`:89`) · 심사중 `border-gold/40 bg-gold/5`(`:721`) · 게스트 계정 `from-gold/15 via-hanji to-terracotta/10 border-gold/35`(`apps/web/components/AccountSection.tsx:93`) · 임팩트 머리 카드(`apps/web/app/mypage/impact/page.tsx:156`) · 쿠폰 흐림 `bg-hanji-deep border-line opacity-70`, 사용 가능 `bg-white border-gold/40`(`coupons/page.tsx:211-213`).
- Expo(현재): `cn('rounded-2xl border border-line bg-white', …, className)`(`apps/mobile/components/ui/Card.tsx:31`) — NativeWind 는 같은 속성 두 클래스 중 CSS 순서로 고른다(`components/ui/cn.ts:1-2`). 측정: 임팩트 카드 bg `rgb(255,255,255)` border `rgb(230,220,198)`; 배너·실험실·WebLinkCard·심사중·흐린 쿠폰도 흰 바탕+line. 예외로 `border-terracotta/35`(설정 위험 카드)는 이겼다 — 순서가 우연.
- 차이: 금·비취 색조 카드 9종 이상이 흰 카드. 그라데이션은 원래 Expo 에 없음.
- 중요도: P1
- 분류: 색·효과
- 고칠 방법:
  1) `Card.tsx` 를 '없을 때만 기본값'으로:
     ```ts
     const BORDER_COLOR = /^border-(?!(?:[trblxyse]|\d+|\[\d)(?:$|-))/; // border-<색>(두께·방향 제외)
     let classes = cn('border', padded && 'p-[16px]', className);
     classes = withDefault(classes, /^bg-/, 'bg-white');
     classes = withDefault(classes, BORDER_COLOR, 'border-line');
     classes = withDefault(classes, /^rounded(-|$)/, 'rounded-2xl');
     ```
     (`withDefault` 는 `components/ui/cn.ts:8-16`.)
  2) 웹 그라데이션 카드는 카드 안 `Gradient`(`components/ui/Gradient.tsx`)를 `StyleSheet.absoluteFill` + `pointerEvents="none"`, 카드 `overflow-hidden bg-hanji`. `lib/theme/tokens.ts` `gradients` 추가(90deg): `impactCard: ['rgba(193,154,62,0.15)','#faf5ec','rgba(62,124,106,0.10)']` · `savedBanner: ['rgba(193,154,62,0.15)','rgba(241,231,211,0.6)','rgba(62,124,106,0.10)']` · `labCard: ['rgba(62,124,106,0.12)','#faf5ec','rgba(193,154,62,0.10)']` · `merchantCard`(=게스트 계정 카드) `['rgba(193,154,62,0.15)','#faf5ec','rgba(193,85,59,0.10)']`.
  3) 적용: `features/mypage/components/ImpactSummaryCard.tsx:26-31` · `app/(tabs)/mypage.tsx:154-166`(배너) · `:183-199`(실험실) · `:267-287`(WebLinkCard, 심사중 `bg-gold/5`) · `features/mypage/components/AccountSection.tsx:60` · `app/mypage/impact.tsx:56,71` · `app/mypage/coupons.tsx:115`.
- 바꿀 Expo 파일: `components/ui/Card.tsx` · `lib/theme/tokens.ts`(+`tokens.test.ts`) · 위 화면들
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 NativeWind 도 승자가 정해져 있지 않다(저장소 규칙 `components/ui/index.ts` 4번) — 1)이 양쪽을 고친다. 그라데이션 모서리는 부모 `overflow-hidden`+radius 필요.
- 확인 방법: `02-main-states.mjs` 재실행 → `my-02-states.measure.json` '나의 여행 임팩트' Expo box border `rgba(193, 154, 62, 0.35)`, 흰 바탕 아님; `cpn-05-list` 흐린 쿠폰 베이지.
- 크기: M · 의존: 없음(04·08·11·20·23 이 전제)
- 표시: 네이티브 확인 필요

### G5b-04 카드 모서리·화면 좌우 여백·카드 안쪽 여백이 웹보다 작다
- 화면·상태: MY 전체 · 하위 화면 전체
- 스크린샷: shots/G5b/my-01-guest-tall.pair.png · setg-01-guest-tall.pair.png · prv-01-tall.pair.png
- 웹(기준): 좌우 `px-6`=24(`mypage/page.tsx:491`, coupons `:114`, impact `:117`, lab `:224`, privacy `:44`, settings `:105`), 문의·고객지원 `p-6`(`inquiries:122`, `support:93`) → 카드 폭 342. 큰 카드 `rounded-3xl`=24 + `p-5`/`p-6`(프로필 `:525` p-6, 레이더 `TasteRadar.tsx:104` p-6, 메뉴 `:661`, 계정 `AccountSection.tsx:67` p-5, 콘솔·역할·실험실 p-5, 개인정보 절 `privacy:56` p-5, 설정 절 p-5, 실험실 항목 `lab:298` p-5, 상태 카드 p-8). `rounded-2xl`=16 은 통계·배너·쿠폰·문의 카드·로그아웃.
- Expo(현재): `px-[16px]`(모든 `Screen contentClassName`) → 폭 358; `Card` 기본 `rounded-2xl p-[16px]`(프로필 24·레이더 20 만 style).
- 차이: 카드가 좌우 8px씩 넓고, 모서리 24→16, 안쪽 여백 −4.
- 중요도: P1
- 분류: 크기·간격
- 고칠 방법: 1) 마이 화면 전부 `px-[16px]` → `px-[24px]`(문의·고객지원 `py-[24px]`도). 2) 웹 `rounded-3xl` 카드에 `className="rounded-3xl"`(G5b-03 이후) + `p-[20px]`(p-5) / 프로필·레이더 `p-[24px]` / 상태 카드 `p-[32px]`. 3) `features/mypage/components/parts.tsx:46` `SectionCard` 기본 `rounded-3xl p-[20px]`.
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx` · `app/mypage/*.tsx` · `features/mypage/components/{parts,AccountSection,ImpactSummaryCard,TasteRadar}.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 폴더블은 `Screen` 최대 640 안에서 같은 여백.
- 확인 방법: 측정 카드 box `x=24 w=342 radius=24px`.
- 크기: M · 의존: G5b-03
- 표시: —

### G5b-05 주 행동 버튼이 웹의 금색 단색이 아니라 금진→주칠 그라데이션이다
- 화면·상태: MY-10 저장 · CPN-05 쿠폰 사용 · IMP-03 공유 · LAB-06/07 보내기 · SUP-01 보내기 · SUP-05 돌아가기(+상태 카드 버튼 — G5b-21·24·25)
- 스크린샷: shots/G5b/my-10-edit-open.pair.png · cpn-05-list.pair.png · imp-03-share.pair.png · sup-01-form.pair.png
- 웹(기준): 모두 `bg-gold`(#c19a3e) 단색 + 흰 글자, 그림자 없음 — 모달 저장 `flex-1 py-3 rounded-xl bg-gold font-bold`(16px, `mypage/page.tsx:834`) · 쿠폰 사용 `px-3 py-1.5 rounded-lg bg-gold text-xs font-bold`, 아이콘 없음(`coupons:267`) · 공유 `w-full py-4 rounded-2xl bg-gold font-semibold`+Share2 18(`impact:251`) · 실험실 보내기 `px-4 py-2 rounded-xl bg-gold text-sm font-bold`(`lab:374,406`) · 문의 보내기 `py-4 rounded-xl bg-gold font-bold`+Send 20, 제출 중 `disabled:bg-muk-soft/40`(`support:176`) · 완료 `px-8 py-3 bg-gold font-bold rounded-xl`(`support:105`).
- Expo(현재): `Button` primary = `Gradient name="cta"`(#8a6a1c→#a8462f) + `shadows.cta` + `rounded-2xl min-h-44 text-[14px] bold`, 아이콘 14(`components/ui/Button.tsx:64-91`). 쿠폰 사용엔 웹에 없는 Compass(`app/mypage/coupons.tsx:149-156`).
- 차이: 색·그림자, 크기(56→44, 30→44), 글자 16→14px, 둥글기, 아이콘.
- 중요도: P1
- 분류: 색·효과 · 크기·간격 · 아이콘·이미지
- 고칠 방법: 1) `Button` 에 `variant="gold"`(bg-gold, 흰 글자, 그라데이션·그림자 없음) + `size`: `xs`(px-12 py-6 rounded-lg text-xs) · `sm`(px-16 py-8 rounded-xl text-sm) · `md`(px-20 py-10 rounded-xl text-sm semibold) · `lg`(py-12 rounded-xl text-base bold) · `xl`(py-16 rounded-2xl text-base). 아이콘 크기는 웹(18·20). 2) 위 화면들 교체, 쿠폰 사용 `icon={Compass}` 삭제. 3) 비활성: 모달·실험실 `opacity-50` / 문의 보내기 `bg-muk-soft/40`.
- 바꿀 Expo 파일: `components/ui/Button.tsx` · `features/mypage/components/ProfileEditModal.tsx:69` · `app/mypage/{coupons.tsx:149-156,impact.tsx:102,lab.tsx:179,201,support.tsx:83,139-146}`
- 문구(i18n): 없음
- 네이티브 주의: 없음.
- 확인 방법: 측정 — 버튼 bg `rgb(193, 154, 62)`, bgImage none, 공유 높이 56.
- 크기: M · 의존: 없음
- 표시: 결정 필요 — 흰 글자/#c19a3e 대비 4.5:1 미만(Expo `ErrorState.tsx:28` 주석이 이 이유로 금진 선택). (A) 웹과 똑같이 금 단색(권장, 대비는 웹과 함께 고침) (B) Expo 만 금진 단색.

### G5b-06 선택·펼침 상태가 Expo web 접근성 속성으로 나오지 않는다
- 화면·상태: LAB-05/06 이유 칩 · SETG 언어 칩 · SUP 유형 칩 · MY-08 '자세히'
- 스크린샷: shots/G5b/lab-06-other-note.pair.png(속성은 `inq-lab-inquiries-lab.measure.json`·`my-03-more-*.measure.json`)
- 웹(기준): 이유 칩 `aria-pressed`(`lab/page.tsx:335`) · 언어·유형은 `<select>` · '자세히' `aria-expanded`+`aria-controls`(`TasteRadar.tsx:202-203`).
- Expo(현재): `Chip` `accessibilityState={{ selected }}`(`components/ui/Chip.tsx:32`) → DOM 에 `aria-pressed`/`aria-selected` 없음(측정 null, 선택 후에도). '자세히' `accessibilityState.expanded`(`TasteRadar.tsx:165`) → `aria-expanded` 없음.
- 차이: Expo web 읽기 화면이 선택/펼침을 모른다(모양은 같음).
- 중요도: P2
- 분류: 접근성
- 고칠 방법: `Chip` 에 웹에서만 `aria-pressed={selected}`(Platform.OS==='web' 조건 spread), `accessibilityState` 는 네이티브용 유지. '자세히' Pressable 에 `aria-expanded={detailsOpen}`(RN 이 지원하는 aria prop).
- 바꿀 Expo 파일: `components/ui/Chip.tsx` · `features/mypage/components/TasteRadar.tsx:162-173`
- 문구(i18n): 없음
- 네이티브 주의: TalkBack 은 이미 accessibilityState 를 읽는다 — 네이티브 동작이 바뀌지 않아야 함.
- 확인 방법: `05-inquiries-lab.mjs` `chipsSelected[1][0].pressed === "true"`.
- 크기: S · 의존: G5b-27
- 표시: 네이티브 확인 필요

---

## 마이 메인 [MY]

### G5b-07 마이 머리 구성(로고·메뉴·언어·종 ↔ '마이'+톱니)과 머리 고정 여부
- 화면·상태: G5-MY-01(모든 상태 맨 위), G5-MY-12
- 스크린샷: shots/G5b/my-01-guest-top.pair.png · my-01-guest-scroll-end.pair.png · my-12-en-top.pair.png
- 웹(기준): `<header className="flex justify-between items-center p-5">`(높이 72, `mypage/page.tsx:464-488`) — 왼쪽 `Menu 24`(`aria-label` `mypage.menuAria`, `-m-2 p-2 rounded-full text-muk-soft`) · 가운데 로고 `nextspot-logo.png` `h-7`(측정 130×28) · 오른쪽 `LanguageSwitcher`(흰 알약 `rounded-full border-line bg-white px-3 text-sm` + Globe 16 + `<select>`, 그림자 `0 2px 14px rgba(43,35,32,.08)`, `components/LanguageSwitcher.tsx:9-29`) + `Bell 24`(`mypage.bellAria`). 메뉴·종 → `/mypage/settings`. 머리는 스크롤 밖 **고정**(`:461` `h-[100dvh] overflow-hidden`, 스크롤은 `main` `:491`). 내용 시작 y=104.
- Expo(현재): 스크롤 안 `min-h-[56px]` 행 — "마이"(`nav.mypage`, text-xl bold) + `IconButton icon={Settings} color="muk-soft" box={44}`(아이콘 20, aria "메뉴")(`app/(tabs)/mypage.tsx:94-97`). 로고·언어·종 없음(`:3-4`). 머리가 **스크롤된다**. 내용 시작 y=56.
- 차이: 요소 4 ↔ 2, 고정 ↔ 스크롤, 시작 높이 104 ↔ 56.
- 중요도: P0
- 분류: 배치 · 누락 · 동작
- 고칠 방법: 1) 머리를 스크롤 밖으로 — `Screen scroll={false}` + 머리 `View` + 내용 `ScrollView`(또는 `Screen` 에 header 슬롯 추가). 2) 머리 `flex-row items-center justify-between p-[20px]`: 왼쪽 `IconButton icon={Menu} size="xl" color="muk-soft" box={40}`(`mypage.menuAria`) → 설정; 가운데 로고 `Image`(웹 `apps/web/public/nextspot-logo.png` 505×109 를 앱 assets 로 복사, height 28, width 28·505/109, `accessibilityLabel="NextSpot"`); 오른쪽 `flex-row gap-[8px]` = 언어 알약(G5b-32 `SelectField variant="pill"`) + `IconButton icon={Bell} size="xl" color="muk-soft"`(`mypage.bellAria`) → 설정. 3) 내용 위 `mt-[16px]`×2 상당.
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx:93-97` · (선택) `components/ui/Screen.tsx` · 새 asset `assets/images/nextspot-logo.png`(@2x·@3x)
- 문구(i18n): 재사용 `mypage.menuAria` `mypage.bellAria` / 새 키 `app.mypage.languageSelect`(언어 선택 · Select language · 言語を選択 · 选择语言 — 4로케일 동시; 웹은 `LanguageSwitcher.tsx:16` 하드코딩)
- 네이티브 주의: 고정 머리 위 `insets.top`. 다크 로고 불필요(다크 모드 꺼짐).
- 확인 방법: `01-main-guest.mjs` → Expo `menu`·`bell`·`logo`·`select` 측정 생김, `my-01-guest-scroll-end` 에서 머리 유지.
- 크기: M · 의존: G5b-32
- 표시: —

### G5b-08 콘솔 미리보기 카드가 없다
- 화면·상태: G5-MY-01·04(관광객·게스트)
- 스크린샷: shots/G5b/my-01-guest-top.pair.png
- 웹(기준): `ConsolePreviewEntry` — `rounded-3xl border-gold/30 bg-gold/5 p-5`, Eye 17 + "콘솔 미리보기"(`demo.previewTitle`), `demo.previewDesc`, 2열 버튼 "사장님 콘솔"(Store 16)·"관제 대시보드"(ShieldCheck 16) `min-h-11 rounded-xl border-gold/40 bg-white text-sm font-bold text-gold-deep` → `/merchant?demo=1`·`/admin/dashboard?demo=1`(`mypage/page.tsx:106-128`, 조건 `:163-174`). account/me 5xx 여도 보인다.
- Expo(현재): 없음(`app/(tabs)/mypage.tsx:3`, 계획 §3.3·PORTING D14).
- 차이: 카드 한 장(높이 140) 누락.
- 중요도: P0
- 분류: 누락
- 고칠 방법: (A) 같은 모양 카드 + 두 버튼 `openExternalUrl(`${WEB_ORIGIN}/merchant?demo=1`)` 등, 위치 `mypage.tsx:168-177` 권한 없음 분기. (B) 유지(웹 전용) + PORTING 에 의도 기록. 권장 (B) — 관광객 앱에 사업자 데모는 심사·혼란 위험.
- 바꿀 Expo 파일: (A) `app/(tabs)/mypage.tsx`
- 문구(i18n): 재사용 `demo.previewTitle/Desc/Merchant/Admin`
- 네이티브 주의: 외부 브라우저.
- 확인 방법: (A) '콘솔 미리보기' Expo 측정 존재.
- 크기: S · 의존: G5b-03
- 표시: 결정 필요

### G5b-09 게스트 '소셜로 계속하기' 카드가 Expo web 에 없고, 안드로이드는 구글 하나를 세로로
- 화면·상태: G5-MY-01(게스트)
- 스크린샷: shots/G5b/my-01-guest-tall.pair.png · my-01-guest-scroll-end.pair.png
- 웹(기준): 그라데이션 카드 `rounded-3xl p-5 border-gold/35`, Link2 18 + `auth.guestTitle`, `auth.guestDesc`, **2열** `grid grid-cols-2 gap-2` — 카카오 `bg-[#FEE500] text-[#191600]` · 구글 `bg-white border-line`, `py-3 px-2 rounded-xl font-bold text-sm truncate`(`components/AccountSection.tsx:92-116`).
- Expo(현재): `visibleProviders` web·iOS `[]`, 안드로이드 `['google']`(`features/mypage/accountCore.ts:12-14`) → Expo web·iOS 카드 없음(`features/mypage/components/AccountSection.tsx:47-48`), 안드로이드 구글 하나 전체 폭(`:68-84`).
- 차이: Expo web 카드 누락; 안드로이드 카카오 없음·배치·색.
- 중요도: P0
- 분류: 누락 · 배치
- 고칠 방법: (A) 카카오·구글 모두(카카오 비즈 전환 + iOS Apple 로그인 동반, 계획 §7.2 M3 변경). (B) 정책 유지 + 모양만: 버튼 영역 `flex-row gap-[8px]`, 버튼 `flex-1 min-h-[44px] rounded-xl py-[12px] px-[8px]` `numberOfLines={1}`, 바탕 G5b-03 `merchantCard`. 권장 (B), 비즈 전환 후 (A).
- 바꿀 Expo 파일: `features/mypage/components/AccountSection.tsx` · (A) `accountCore.ts`, `features/auth/socialPolicy.ts`
- 문구(i18n): 재사용 `auth.guestTitle/guestDesc/continueKakao/continueGoogle`
- 네이티브 주의: 안드로이드에서만 보여 Expo web 비교로는 모양을 못 봤다.
- 확인 방법: 안드로이드 에뮬레이터 마이 화면.
- 크기: S((B)) / L((A)) · 의존: G5b-03
- 표시: 결정 필요 · 네이티브 확인 필요

### G5b-10 혼잡 알림 토글이 없다(마이·설정)
- 화면·상태: G5-MY-13, G5-SETG-09
- 스크린샷: shots/G5b/my-01-guest-scroll-end.pair.png · setg-01-guest-tall.pair.png
- 웹(기준): 마이 `CongestionAlertToggle`(`mypage/page.tsx:628-630`) · 설정 '혼잡 알림' 절(BellRing 20 gold 원 `bg-gold/10`, `settings/page.tsx:161-172`). 토글 `rounded-2xl border px-4 py-3` + 36px 원 + `alert.off`·`alert.offSub` + 스위치 44×24(`components/CongestionAlertToggle.tsx:48-109`). 헤드리스는 권한 denied → "브라우저 설정에서 알림 차단됨" 상태로 찍힘.
- Expo(현재): 없음(`app/(tabs)/mypage.tsx:3`, `app/mypage/settings.tsx:2`, PORTING D4).
- 차이: 마이 카드 1 + 설정 절 1 누락.
- 중요도: P0
- 분류: 누락
- 고칠 방법: (A) expo-notifications + 서버 푸시(웹식 앞쪽 주기 조회는 앱 백그라운드에서 불가) — v1.1. (B) 비활성 모양만 두는 것은 '되지 않는 버튼'(정직성 원칙 위반). 권장: v1 은 PORTING 에 의도로 두고 v1.1 에 (A).
- 바꿀 Expo 파일: (A) 새 `features/alerts/*`, `app/(tabs)/mypage.tsx`, `app/mypage/settings.tsx`
- 문구(i18n): (A) 재사용 `alert.*` `settings.alertTitle` / 새 키 `app.settings.alertDesc`(웹 문구는 '브라우저 알림')
- 네이티브 주의: 안드로이드 13+ POST_NOTIFICATIONS 런타임 권한.
- 확인 방법: —
- 크기: L · 의존: 서버 푸시
- 표시: 결정 필요

### G5b-11 사장님·관제 콘솔·역할 변경 카드가 '웹에서 열기' 외부 링크 카드다
- 화면·상태: G5-MY-04·07, G5-SETG-02
- 스크린샷: shots/G5b/my-05-07-merchant-kakao-tall.pair.png · my-07-admin-pending-top.pair.png · my-07-admin-pending-tall.crop-role.png · setg-02-member-tall.pair.png
- 웹(기준): 앱 안 이동 — 사장님 `rounded-3xl border-gold/35 그라데이션 p-5` + 44px `rounded-2xl bg-gold/15` 타일 Store 22 + ChevronRight 20 gold-deep → `/merchant`(`mypage/page.tsx:131-156`) · 관제 `rounded-3xl border-gold/30 bg-gold/5 p-5`, 제목 줄 안 ShieldCheck 17 + ChevronRight 18 → `/admin/dashboard`(`:78-102`) · 역할 변경 신청 `border-line bg-white`/심사중 `border-gold/40 bg-gold/5`, 제목 줄 안 UserCog/Hourglass 17 + ChevronRight 18 → `/account/business`(`:715-744`) · 설정 사장님 카드 같은 그라데이션 버튼(`settings/page.tsx:175-192`).
- Expo(현재): `WebLinkCard` — 왼쪽 아이콘 24(타일 없음) · 제목·설명 · 오른쪽 ExternalLink 16 + "웹에서 열기"(10px) · 외부 브라우저(`app/(tabs)/mypage.tsx:168-177,226-237,267-287`); 설정은 SectionCard + 보조 버튼(`app/mypage/settings.tsx:131-141`).
- 차이: 흐름(앱 안 ↔ 외부 브라우저), 모양, 영어에서 제목 두 줄(`my-12-en-tall`).
- 중요도: P0
- 분류: 동작 · 배치 · 아이콘·이미지
- 고칠 방법: (A) 정책 유지(웹 전용, 계획 §3.3) + 모양은 웹 그대로(사장님 = 44px 타일 + 꺾쇠 자리, 관제·역할 = 제목 줄 17px 아이콘), 꺾쇠 자리에 ExternalLink 16 하나만, '웹에서 열기'는 `accessibilityHint` 로. 설정 사장님 카드도 같은 카드형 버튼. (B) 콘솔을 앱에 넣음(범위 밖). 권장 (A).
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx:168-177,226-237,267-287` · `app/mypage/settings.tsx:131-141`
- 문구(i18n): 재사용 `console.openMerchant(Desc)` `console.openAdmin(Desc)` `account.roleRequestEntry(Desc)` `account.roleRequestPendingEntry(Desc)` `app.mypage.openOnWeb`
- 네이티브 주의: 외부 브라우저는 앱 로그인 세션을 공유하지 않아 웹에서 다시 로그인해야 한다(웹은 같은 세션).
- 확인 방법: `02-main-states.mjs` B·C 재촬영.
- 크기: M · 의존: G5b-03
- 표시: 결정 필요

### G5b-12 프로필 카드·통계 카드 세부
- 화면·상태: G5-MY-01·04·05
- 스크린샷: shots/G5b/my-01-guest-top.pair.png · my-05-07-merchant-kakao-top.pair.png · my-07-admin-pending-top.pair.png
- 웹(기준): 아바타 고리 `bg-gradient-to-tr from-gold to-terracotta p-0.5` + 안 `bg-hanji`, User 40 gold(`mypage/page.tsx:526-537`) · 이름 `text-2xl font-bold break-words` · 이메일 `text-sm break-all` · '프로필 수정' `min-h-11 px-5 rounded-xl border-line bg-hanji text-sm font-medium` + Edit2 14(측정 119×44, r12, 500)(`:548-555`) · 통계 `rounded-2xl p-4 gap-3 max-[420px]:gap-1.5`(390 에서 6), 저장 `Bookmark fill="currentColor"`, 숫자 `tabular-nums`(측정 165×62)(`:560-576`).
- Expo(현재): 고리 `border-2 border-gold` 단색(`app/(tabs)/mypage.tsx:116`) · '프로필 수정' `Button secondary` = 흰 바탕·`rounded-2xl`·bold·아이콘 없음(측정 90.6×44)(`:128`) · 통계 `min-h-[64px] gap-[8px]`, Bookmark 외곽선만(`Icon` 이 fill 미지원)(`:131-150`).
- 차이: 고리 그라데이션, 버튼 연필·바탕·굵기·둥글기, 북마크 채움, 통계 62↔64·간격 6↔8.
- 중요도: P1
- 분류: 아이콘·이미지 · 색·효과 · 크기·간격
- 고칠 방법: 1) 고리: 80×80 `rounded-full overflow-hidden` + `Gradient colors={[gold, terracotta]} start={{x:0,y:1}} end={{x:1,y:0}}` + 안쪽 76×76 `bg-hanji` (margin 2). 2) 버튼: `variant="hanji"`(bg-hanji border-line text-muk text-sm medium rounded-xl px-20) + Edit2 14. 3) `components/ui/Icon.tsx` 에 `fill` prop 전달, 저장 통계 `fill={colors.terracotta}`. 4) 통계 `min-h` 삭제·`gap-[6px]`·숫자 `fontVariant: ['tabular-nums']`.
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx:115-150` · `components/ui/Icon.tsx` · (선택) `components/ui/Button.tsx`
- 문구(i18n): 재사용 `mypage.editProfile/statSaved/statVisited`
- 네이티브 주의: tabular-nums 는 글꼴에 tnum 없으면 무시(무해).
- 확인 방법: '프로필 수정' box bg `rgb(250,245,236)` r12.
- 크기: S · 의존: G5b-05
- 표시: —

### G5b-13 임팩트 요약 카드·줄인 대기 배너 세부
- 화면·상태: G5-MY-06
- 스크린샷: shots/G5b/my-04-06-member-tall.crop-impactcard.png · my-06-member-records-top.pair.png
- 웹(기준): 지표 `flex flex-wrap items-baseline gap-x-2 gap-y-1`, 구분점과 지표가 따로 줄바꿈 단위(`span.contents`)라 점이 **윗줄 끝**에 남음; 지표 `text-[15px] font-black` 줄 높이 22.5(`components/ImpactSummaryCard.tsx:77-84,98-100`); aria-label `impact.summaryAria` 만(`:67`). 배너 `px-4 py-3.5 gap-3` + Hourglass 22(`mypage/page.tsx:583-598`).
- Expo(현재): 점을 다음 지표와 한 View 로 묶어 둘째 줄이 "· 줄인 예상 대기 45분"으로 시작(`features/mypage/components/ImpactSummaryCard.tsx:40-45`); 줄 높이 normal; aria-label 에 지표까지(`:28`). 배너 Card p16, Hourglass 24(`app/(tabs)/mypage.tsx:154-166`).
- 차이: 줄머리 구분점, 줄 간격, 아이콘 22↔24, 패딩, 접근성 이름.
- 중요도: P2
- 분류: 배치 · 크기·간격 · 접근성
- 고칠 방법: 1) 점을 앞 지표 뒤에 붙인다(`{text}{i < n-1 ? ' ·' : ''}` 형태의 View 묶음). 지표 `leading-[22px]`. 2) aria-label 은 Expo 쪽(지표 포함)이 낫다 — 웹은 aria-label 이 내용을 덮어 지표가 안 읽힘 → Expo 유지, 웹 개선 권장. 3) 배너 `px-[16px] py-[14px] gap-[12px]` + `Icon size={22}`.
- 바꿀 Expo 파일: `features/mypage/components/ImpactSummaryCard.tsx` · `app/(tabs)/mypage.tsx:154-166`
- 문구(i18n): 재사용 `impact.summary*` `mypage.savedBanner` `mypage.savedValue`
- 네이티브 주의: 없음.
- 확인 방법: `crop.mjs my-04-06-member-tall 80:50 170 impactcard` 재생성 → 둘째 줄 첫 글자 '줄'.
- 크기: S · 의존: G5b-03
- 표시: —

### G5b-14 AI 취향 레이더: 눈금 기준·격자·점·크기·배지·제목 자간·로딩
- 화면·상태: G5-MY-08(기본·온보딩·학습·자세히·로딩)
- 스크린샷: shots/G5b/my-01-guest-scroll-radar.pair.png · my-04-06-member-tall.pair.png · my-08-radar-learned-details.pair.png · my-08-radar-loading.pair.png
- 웹(기준): recharts 높이 240, `outerRadius="72%"`, 반지름 축 없음 → **최댓값 기준 자동 눈금**(균등 35 가 바깥 고리를 꽉 채움); 고리 5겹 + 바퀴살 8(측정 polygon 7·line 16), 꼭짓점 점 없음, 선 #c19a3e 2px·채움 22%(`components/TasteRadar.tsx:131-163`) · 제목 `tracking-wider`(0.7px)(`:107`) · 배지 `text-[10px] px-2.5 py-1`(`:113`) · 로딩 금색 20px 회전 고리 `py-10`(`:124-127`).
- Expo(현재): react-native-svg — 높이 260, viewBox 300, 반지름 92, **값/100 절대 눈금**(균등 → 작은 팔각형), 고리 4겹, 바퀴살 없음, 점 r2.5(측정 circle 8)(`features/mypage/components/TasteRadar.tsx:34-38,98-138`) · 제목 자간 없음(`:80`) · 배지 11px(`:83-84`) · 로딩 240 원 스켈레톤(`:92-95`).
- 차이: 기본 상태에서 큰 팔각형 ↔ 작은 팔각형(한눈에 보임), 격자·점·크기·배지·로딩.
- 중요도: P1
- 분류: 아이콘·이미지 · 상태(로딩) · 글꼴
- 고칠 방법: 1) `ratio = v / Math.max(...values, 1)`(recharts 자동 domain `[0, dataMax]`). 2) 고리 5겹(0.2~1.0) + 중심→축 끝 `Line` 8개(stroke line), 점 삭제. 3) `Svg height={240}`, 반지름 ≈ 0.72×min(폭,240)/2(≈86), 축 글자 11px muk-soft(오프셋 ≈ 반지름+10). 4) 제목 `tracking-[0.7px]`, 배지 `text-[10px]`. 5) 로딩 `ActivityIndicator size={20} color={colors.gold}` + `py-[40px]`.
- 바꿀 Expo 파일: `features/mypage/components/TasteRadar.tsx` · `features/mypage/tasteCore.ts`
- 문구(i18n): 재사용 `taste.*`
- 네이티브 주의: ActivityIndicator 모양은 플랫폼마다 조금 다름(허용).
- 확인 방법: `03-main-more.mjs` `learned.svg` → Expo polygon 6·circle 0·line 8.
- 크기: M · 의존: 없음
- 표시: —

### G5b-15 메뉴 행 높이·여백·줄 높이, 로그아웃 버튼 높이
- 화면·상태: G5-MY-01·09·11
- 스크린샷: shots/G5b/my-01-guest-scroll-end.pair.png · my-07-admin-pending-tall.crop-role.png
- 웹(기준): 행 `p-5` → 80(+1), 원 40, 간격 16, 라벨 `font-medium` 16px/24, 꺾쇠 20(`mypage/page.tsx:678-697`), 라벨 x=101 · 로그아웃 `py-4 rounded-2xl border-line mb-4` → 58(`:752`).
- Expo(현재): `min-h-[64px] px-[16px] py-[12px]` → 64(+1), 줄 높이 normal(`app/(tabs)/mypage.tsx:208-214`), 라벨 x=89 · 로그아웃 `my-[16px] min-h-[52px]`(`:244`).
- 차이: 메뉴 카드 325 ↔ 261, 여백 20↔16, 로그아웃 58↔52.
- 중요도: P1
- 분류: 크기·간격
- 고칠 방법: 행 `min-h-[80px] … p-[20px]`, 라벨 `leading-[24px]`; 로그아웃 `min-h-[58px] mb-[16px]`.
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx:201-224,239-249`
- 문구(i18n): 없음
- 네이티브 주의: 없음.
- 확인 방법: '여행 임팩트'·'내 쿠폰함' y 간격 81.
- 크기: S · 의존: G5b-04
- 표시: —

### G5b-16 프로필 로딩 중 화면 구성(웹 3블록만 ↔ Expo 프로필 1블록 + 나머지 즉시)
- 화면·상태: G5-MY-02
- 스크린샷: shots/G5b/my-02-loading.pair.png
- 웹(기준): `isLoading || !profile` 동안 임팩트 카드(독립) 아래 스켈레톤 3블록만 — 프로필(`rounded-3xl p-6`: 원 80·막대 1/3×24·1/2×16·알약 96×24) · 레이더(막대 2/5×16 + 원 160 60%) · 통계(`rounded-2xl p-4` + 96×24); 나머지는 그리지 않음(`mypage/page.tsx:497-516`, `else` `:517-772`).
- Expo(현재): 프로필 자리만 스켈레톤(`app/(tabs)/mypage.tsx:106-112`), 레이더(240 원)·계정·메뉴·링크는 바로 그림.
- 차이: 로딩 화면 구성이 다르다.
- 중요도: P1
- 분류: 상태(로딩·빈·오류)
- 고칠 방법: `!profile` 분기에 웹 3블록, `TasteRadar`·콘솔·`AccountSection`·실험실·메뉴·역할·로그아웃·링크를 `profile ?` 안으로(임팩트 카드는 밖 유지).
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx:99-259`
- 문구(i18n): 재사용 `common.loading`
- 네이티브 주의: 없음.
- 확인 방법: `03-main-more.mjs`(loading) → Expo 블록 3개·메뉴 없음.
- 크기: S · 의존: G5b-04
- 표시: —

### G5b-17 프로필 수정 모달: 흐림·닫기 X·입력칸·버튼·그림자, 실패 토스트가 모달 뒤에 깔림
- 화면·상태: G5-MY-10(열림·빈 이름·성공·실패)
- 스크린샷: shots/G5b/my-10-edit-open.pair.png · my-10-edit-empty.pair.png · my-10-edit-saved.pair.png · my-10-edit-failed.pair.png
- 웹(기준): 바탕 `bg-muk/40 backdrop-blur-sm` · 카드 `max-w-[360px] rounded-3xl p-6 shadow-[0_8px_32px_rgba(43,35,32,0.18)]` · 머리 행 `mb-5` 오른쪽 X(`aria-label` `common.close`) · 라벨 `mb-2` · 입력 `bg-hanji border-line rounded-xl p-3.5`(54, 포커스 gold) · 버튼 행 `mt-6 gap-3`: 취소 `py-3 rounded-xl border-line bg-hanji text-muk-soft font-semibold`(16px, 141×50) / 저장 `bg-gold font-bold`(`mypage/page.tsx:779-841`). 실패 토스트가 모달 위에 보임.
- Expo(현재): RN `Modal` — `bg-muk/40` 흐림 없음, X 없음(바탕 전체가 '닫기'), 그림자 없음, `gap-12`, `TextField` 흰 바탕 50(Expo web 은 브라우저 기본 포커스 윤곽), 버튼 secondary(흰·muk·14 bold·44)/primary 그라데이션(`features/mypage/components/ProfileEditModal.tsx:43-73`). 실패 토스트가 **모달 바탕 아래** 흐리게(`my-10-edit-failed`).
- 차이: 흐림·X·입력칸·버튼·그림자·간격, 실패 알림 가시성.
- 중요도: P1
- 분류: 색·효과 · 누락 · 크기·간격 · 상태
- 고칠 방법: 1) `BlurView`(expo-blur, 웹 4px 상당, tint light) + `bg-muk/40`. 2) 머리 행 `justify-between mb-[20px]` + `IconButton icon={X} size="lg" color="muk-soft"`(`common.close`). 3) 카드 `boxShadow: '0px 8px 32px rgba(43,35,32,0.18)'`. 4) `TextField tone="hanji"`(bg-hanji, py14) + 포커스 시 `borderColor: colors.gold`, 웹 빌드 `outlineStyle:'none'`. 5) 취소 `bg-hanji border-line text-muk-soft semibold 16px py-12 rounded-xl`, 저장 G5b-05 `gold lg`, 행 `mt-[24px] gap-[12px]`. 6) 실패 알림: 모달 안 Toaster 추가(sonner-native 다중 Toaster 지원 여부 확인) 또는 RN `Modal` 대신 화면 위 절대 배치 오버레이(웹 구조와 같음)로.
- 바꿀 Expo 파일: `features/mypage/components/ProfileEditModal.tsx` · `features/mypage/components/parts.tsx` · `app/(tabs)/mypage.tsx:73-83,261`
- 문구(i18n): 재사용 `common.close/cancel/save` `mypage.editName*`
- 네이티브 주의: 안드로이드 RN `Modal` 은 별도 창 → 루트 토스트가 **완전히 가려질** 가능성(실패해도 알림 없음). 안드로이드 BlurView 는 실험적(`experimentalBlurMethod`).
- 확인 방법: `03-main-more.mjs`(edit) → 실패 토스트가 모달 위, `[aria-label="닫기"]` 36px 버튼.
- 크기: M · 의존: G5b-05
- 표시: 네이티브 확인 필요

### G5b-18 로그아웃 뒤 이동(웹 '/' 이동 ↔ Expo 마이에 머묾)
- 화면·상태: G5-MY-11
- 스크린샷: shots/G5b/my-04-member-scroll-end.pair.png(버튼까지만)
- 웹(기준): `signOut()` → `clearUserScopedData()` → 토스트 `mypage.signedOut` → `router.push('/')`(`mypage/page.tsx:445-456`).
- Expo(현재): 토스트만, 마이에 머묾(`app/(tabs)/mypage.tsx:68-71`, `features/mypage/actions.ts:91-99`).
- 차이: 로그아웃 뒤 도착 화면.
- 중요도: P1
- 분류: 동작
- 고칠 방법: `onSignOut` 끝에 `router.replace('/')`(앱엔 랜딩이 없어 홈이 가장 가까운 대응).
- 바꿀 Expo 파일: `app/(tabs)/mypage.tsx:68-71`
- 문구(i18n): 재사용 `mypage.signedOut`
- 네이티브 주의: SIGNED_OUT 뒤 새 익명 세션 생성과 경합 없는지.
- 확인 방법: 로컬 개발 빌드(가짜 세션)에서.
- 크기: S · 의존: 없음
- 표시: 촬영 못 함(공유 세션 보호로 클릭 안 함 — 코드 비교)

### G5b-19 개발자 전용 카드(지역 전환·개발자 콘솔)가 없다
- 화면·상태: G5-MY-07(developer)
- 스크린샷: 없음
- 웹(기준): `RegionSwitchEntry`(developer + 내부 지역, `mypage/page.tsx:180-194`) · `DevConsoleEntry`(developer, 운영 빌드에선 숨김, `:54-75`).
- Expo(현재): 없음(`app/(tabs)/mypage.tsx:3`, PORTING D25).
- 차이: 개발자 계정에서만 보이는 카드 2장.
- 중요도: P2
- 분류: 누락
- 고칠 방법: 권장 — 넣지 않고 PORTING 에 '내부 전용, 의도'로. 넣으면 WebLinkCard 로 웹 `/dev`.
- 바꿀 Expo 파일: (넣을 때) `app/(tabs)/mypage.tsx`
- 문구(i18n): (넣을 때) `region.switchTitle/switchHint`
- 네이티브 주의: 없음.
- 확인 방법: —
- 크기: S · 의존: 없음
- 표시: 결정 필요

---

## 내 쿠폰함 [CPN]

### G5b-20 쿠폰 카드: 할인 칸 색·'쿠폰 사용' 버튼·흐린 카드 바탕·긴 이름·노을 광원
- 화면·상태: G5-CPN-05(D-2 · D-10 · 사용 완료 · 만료), 사용 처리 중·성공·실패
- 스크린샷: shots/G5b/cpn-05-list.pair.png · cpn-05-use-busy.pair.png · cpn-05-use-success.pair.png · cpn-05-use-failed.pair.png
- 웹(기준): 카드 `rounded-2xl` 사용 가능 `bg-white border-gold/40` · 흐림 `bg-hanji-deep border-line opacity-70`(`coupons/page.tsx:209-213`) · 스텁 `px-5 py-4 bg-gradient-to-br from-gold to-terracotta`(폭 88/74), 숫자 `text-2xl font-bold leading-none`, '할인' `text-[10px] mt-1 tracking-wide`(`:216-221`) · 유형 칩 `bg-jade/12`(`:227`) · 이름 `truncate` 1줄(`:254`) · 사용 버튼 `px-3 py-1.5 rounded-lg bg-gold text-xs font-bold`, 처리 중 "불러오는 중..."(`:262-271`) · 노을 광원 300px `bg-sunset-1/10 blur-[100px]`(`:281`).
- Expo(현재): 스텁 `min-w-[84px] bg-gold-deep` 진한 단색(`app/mypage/coupons.tsx:119-126`) · 흐린 카드 흰 바탕(G5b-03) · 칩 `bg-jade/10` · 이름 `numberOfLines={2}`(`:145`) · 사용 버튼 그라데이션 44 + Compass, 처리 중 스피너(`:149-156`) · 광원 없음.
- 차이: 스텁 그라데이션 ↔ 진한 단색(가장 눈에 띔), 버튼, 흐린 카드 바탕, 이름 1↔2줄, 스텁 폭.
- 중요도: P1
- 분류: 색·효과 · 크기·간격 · 아이콘·이미지
- 고칠 방법: 1) 스텁 `px-[20px] py-[16px] overflow-hidden`(min-w 삭제) + 사용 가능 `<Gradient name="goldTerracotta" start={{x:0,y:0}} end={{x:1,y:1}} style={StyleSheet.absoluteFill} />`, 흐림 `bg-muk-soft/15`; 숫자 `leading-[24px]`, '할인' `tracking-[0.25px]`. 2) 버튼 `gold xs`, 아이콘 삭제, 처리 중 라벨 `common.loading`. 3) 이름 `numberOfLines={1}`. 4) 칩 `rgba(62,124,106,0.12)`. 5) 광원: react-native-svg `RadialGradient` 원 300(sunset-1 10%→투명) 오른쪽 위 1/4.
- 바꿀 Expo 파일: `app/mypage/coupons.tsx` · (필요 시) `lib/theme/tokens.ts`
- 문구(i18n): 재사용 `coupons.*` `common.loading`
- 네이티브 주의: RadialGradient 는 세 플랫폼 공통.
- 확인 방법: `04-coupons-impact.mjs` → 스텁 그라데이션, 흐린 카드 베이지, 사용 버튼 높이 30.
- 크기: M · 의존: G5b-03, G5b-05
- 표시: —

### G5b-21 쿠폰·실험실의 빈/로그인 필요/오류/로딩 상태 카드(+ 쿠폰 오류 제목 누락)
- 화면·상태: G5-CPN-01~04, G5-LAB-01~04
- 스크린샷: shots/G5b/_view-cpn-states.png · _view-lab-states.png(개별: cpn-02-empty · cpn-03-auth · cpn-04-error · cpn-01-loading · lab-04-empty · lab-02-401 · lab-03-error · lab-01-loading)
- 웹(기준): 세로 가운데(`flex-1 items-center justify-center`) 카드 `bg-white border-line rounded-3xl p-8 w-full max-w-[320px]`+그림자 · 아이콘 원 `w-16 h-16 bg-gradient-to-b from-gold/20 to-gold/10 border-line` + Ticket/FlaskConical 32 gold(오류: `bg-terracotta/10 border-terracotta/20` + AlertCircle 32) · 제목 `text-xl font-bold mb-3` · 본문 `text-sm leading-relaxed mb-8 px-2` · 버튼 `bg-gold px-5 py-2.5 rounded-xl text-sm font-semibold`(+Compass 18)(`coupons/page.tsx:129-188`, `lab/page.tsx:243-281`). 쿠폰 오류 = 제목 `coupons.errorTitle` + 본문 `coupons.errorBody`(`:157-160`). 실험실 401 = 오류 카드 + '홈'(Compass)(`lab:251-259`), 빈 = 버튼 없음. 로딩: 쿠폰 티켓 모양(`coupons:115-128`), 실험실 칩 줄 카드 3장(`lab:225-242`).
- Expo(현재): `EmptyState`(위쪽 정렬, `rounded-2xl p-28`, 원 48 hanji-deep + 아이콘 24 muk-soft, 15px 제목, 보조 흰 버튼)(`components/ui/EmptyState.tsx:26-44`) · `ErrorState`(⚠️, 금진 알약+RotateCw)(`components/ui/ErrorState.tsx:30-68`) — 쿠폰 오류 **본문만**(`app/mypage/coupons.tsx:61`), 실험실 401 은 플라스크 + 보조 '홈'(`app/mypage/lab.tsx:109-114`). 로딩 `CardSkeletons`(`features/mypage/components/parts.tsx:62-74`).
- 차이: 위치·폭·둥글기·여백, 아이콘 원 크기·색, 글자 크기, 버튼, ⚠️ 이모지, 쿠폰 오류 제목 누락, 로딩 모양.
- 중요도: P1
- 분류: 상태(로딩·빈·오류) · 문구
- 고칠 방법: 1) `features/mypage/components/StateCard.tsx`: `{ tone:'gold'|'error'; icon; title?; body?; action?:{label;icon?;onPress} }`, 바깥 `flex-1 items-center justify-center`, 카드 `w-full max-w-[320px] items-center rounded-3xl` padding 32, 아이콘 원 64(세로 `Gradient` gold 20%→10% + `border-line`; 오류 `bg-terracotta/10 border-terracotta/20`) + 아이콘 32, 제목 `text-xl mb-[12px]` bold center, 본문 `text-sm leading-[22.75px] text-muk-soft mb-[32px] px-[8px]`, 버튼 `gold md` + 선택 Compass 18. 2) 쿠폰: auth/empty(Ticket·Compass 버튼) · error(AlertCircle·제목 `coupons.errorTitle`+본문·`common.retry`). 실험실: empty(버튼 없음) · 401(AlertCircle·`lab.loadError`·'홈'+Compass) · 오류(`common.retry`). 3) 로딩: `CouponSkeletons`(행 rounded-2xl: 왼쪽 w-80 hanji-deep + 막대 1/3×16·2/3×20·1/4×12, 2개) · `LabSkeletons`(rounded-3xl p-20: 막대 40%×20·33%×12 + 칩 96/112/80×32, 3개).
- 바꿀 Expo 파일: 새 `features/mypage/components/StateCard.tsx` · `features/mypage/components/parts.tsx` · `app/mypage/coupons.tsx:51-68` · `app/mypage/lab.tsx:107-118`
- 문구(i18n): 재사용 `coupons.emptyTitle/emptyBody/browse/authTitle/authBody/authCta/errorTitle/errorBody` `common.retry` `common.loading` `lab.empty/emptyDesc/loadError` `nav.home`
- 네이티브 주의: 없음.
- 확인 방법: 04·05 스크립트 재실행 → 카드 세로 가운데, 쿠폰 오류 제목.
- 크기: M · 의존: G5b-04, G5b-05
- 표시: —

### G5b-22 날짜 표기 로케일(웹 쿠폰 ko-KR 고정·문의 브라우저 로케일 ↔ Expo 앱 언어)
- 화면·상태: G5-CPN-05 발급일, G5-INQ-05 날짜 — ko 가 아닐 때
- 스크린샷: 없음(ko 는 같음 — `inq-05-list-tall.pair.png`)
- 웹(기준): 쿠폰 `toLocaleDateString('ko-KR', …)` 고정(`coupons/page.tsx:31`) → 영어에서도 "Issued 11월 1일"; 문의 `toLocaleDateString(undefined, …)`(`inquiries/page.tsx:102`) → 브라우저 언어.
- Expo(현재): 둘 다 앱 언어(`app/mypage/coupons.tsx:46`, `app/mypage/inquiries.tsx:16-22`).
- 차이: en·ja·zh 날짜 언어.
- 중요도: P2
- 분류: 문구
- 고칠 방법: (A) 권장 — 웹을 앱 언어로 고친다(웹 i18n 버그), Expo 유지. (B) 엄격히: Expo 쿠폰 'ko-KR' 고정, 문의 기기 로케일.
- 바꿀 Expo 파일: (B) `app/mypage/coupons.tsx:46` · `app/mypage/inquiries.tsx:19`
- 문구(i18n): 없음
- 네이티브 주의: (B) Hermes Intl.
- 확인 방법: `nextspot_locale=en` 시드로 촬영.
- 크기: S · 의존: 없음
- 표시: 결정 필요 · 촬영 못 함(코드 비교)

---

## 여행 임팩트 [IMP]

### G5b-23 임팩트 상세: 2열 격자(마지막 칸 반폭) ↔ 늘어나는 칸, 공유 카드 장식·여백
- 화면·상태: G5-IMP-03(전체 기록 · 출발만 1건)
- 스크린샷: shots/G5b/imp-03-record-tall.pair.png · imp-03-partial.pair.png · imp-03-share.pair.png
- 웹(기준): 머리 카드 지표 `grid grid-cols-2 gap-2`, 칸 `rounded-2xl border-line bg-white/70 px-2 py-2.5 text-[13px] font-black`(3개면 셋째 반 폭)(`impact/page.tsx:161-174`) · 공유 카드 `rounded-3xl border-gold/30 p-8 shadow-[0_8px_32px_rgba(43,35,32,0.10)] overflow-hidden` + 광원 `-top-10 -right-10 w-40 h-40 bg-gold/15 blur-[60px]` + 능선 SVG(`viewBox 0 0 400 100`, jade 8%·13%)(`:177-192`) · 'NextSpot' `tracking-widest uppercase mb-2`, 제목 `mb-1`, 부제 `mb-6` · 타일 `grid grid-cols-2 gap-3`(5개면 다섯째 반 폭, 1개도 반 폭)(`:200-239`, Tile `:265-272`).
- Expo(현재): 지표 `min-w-[45%] flex-1`(셋째 전체 폭)(`app/mypage/impact.tsx:61-67`) · 공유 카드 padding 24 `elevation="surface"`, 장식 없음(`:71-100`) · 'NextSpot' `tracking-[2px]`, 제목 mb4, 부제 mb20 · 타일 `min-w-[44%] flex-1`(마지막·단독 전체 폭)(`:75,109-120`).
- 차이: 홀수 마지막 칸 폭, 광원·능선 없음, 여백 32↔24, 그림자.
- 중요도: P1
- 분류: 배치 · 색·효과 · 크기·간격
- 고칠 방법: 1) 지표·타일 고정 2열: 부모 `flex-row flex-wrap justify-between`, 자식 폭 `'48.5%'`(gap 8)/`'48%'`(gap 12), `flex-1` 삭제. 2) 카드 `rounded-3xl border-gold/30 overflow-hidden` padding 32 + `boxShadow: '0px 8px 32px rgba(43,35,32,0.10)'`. 3) 광원: react-native-svg 원 160 RadialGradient(gold 15%→투명) `top:-40 right:-40`. 4) 능선: `Svg viewBox="0 0 400 100" preserveAspectRatio="xMidYMax slice"` 절대 아래 높이 64, Path 4개(`impact/page.tsx:188-191` 그대로, jade 0.08/0.13). 5) 'NextSpot' `tracking-[1.2px]`, 제목 `mb-[4px]`, 부제·타일 줄 `mb-[24px]`.
- 바꿀 Expo 파일: `app/mypage/impact.tsx`
- 문구(i18n): 재사용 `impact.*`
- 네이티브 주의: SVG 장식 `pointerEvents="none"`.
- 확인 방법: `imp-03-partial.pair.png` 단독 타일 반 폭.
- 크기: M · 의존: G5b-03, G5b-05
- 표시: —

### G5b-24 임팩트 시작(빈) 상태·로딩
- 화면·상태: G5-IMP-01, G5-IMP-02(기록 없음·401)
- 스크린샷: shots/G5b/_view-imp-states.png(imp-02-empty · imp-01-loading) · imp-02-401.pair.png
- 웹(기준): 카드 `w-full border-gold/30 rounded-3xl p-8 shadow-[0_8px_32px_rgba(43,35,32,0.10)]` · 아이콘 `w-14 h-14 rounded-2xl bg-gold/15` + Sparkles 26 gold-deep · 제목 `text-xl font-bold leading-snug` · 본문 `mt-2 text-sm` · 버튼 `mt-6 w-full py-4 rounded-2xl bg-gold font-semibold` + Compass 18(`impact/page.tsx:132-150`). 로딩 `p-8 rounded-3xl`: 막대 1/4×12·2/3×24·타일 4×h-24·아래 막대 1/2×16(`:118-131`).
- Expo(현재): `EmptyState`(원 48 hanji-deep, muk-soft 아이콘, 보조 흰 버튼)(`app/mypage/impact.tsx:47-53`) · 로딩 Card p16 r16 막대 2 + 타일 4, 아래 막대 없음(`:39-46`).
- 차이: 아이콘 모양, 제목 크기, 버튼(전체 폭 금 56 ↔ 작은 흰), 테두리·그림자, 로딩 막대.
- 중요도: P1
- 분류: 상태(로딩·빈·오류)
- 고칠 방법: 웹 마크업 그대로(버튼 `gold xl` + Compass → `router.navigate('/')`); 로딩 `rounded-3xl p-[32px]`, 중앙 막대 + 아래 1/2×16 추가, 타일 `w-[48%] h-[96px]`.
- 바꿀 Expo 파일: `app/mypage/impact.tsx:39-53`
- 문구(i18n): 재사용 `impact.emptyTitle/emptyBody/emptyCta` `common.loading`
- 네이티브 주의: 없음.
- 확인 방법: `imp-02-empty.pair.png` 재촬영.
- 크기: S · 의존: G5b-05
- 표시: —

---

## 내 문의 [INQ]

### G5b-25 내 문의 상태 표시(로딩 스피너+문구, 카드 없는 안내) ↔ 카드형
- 화면·상태: G5-INQ-01~04
- 스크린샷: shots/G5b/_view-inq-states.png(inq-04-empty · inq-02-401 · inq-03-error · inq-01-loading)
- 웹(기준): 카드 없이 가운데 — 로딩 금색 24px 고리 + `inquiries.loading` `py-16`(`inquiries/page.tsx:126-131`) · 401 MessageSquare 40 `text-muk-soft/50` + `text-sm` 문장(`:134-139`) · 오류 AlertCircle 40 `text-terracotta/70` + `font-semibold text-muk` + `bg-gold px-6 py-2.5 rounded-xl font-bold`(`:142-153`) · 빈: 아이콘 + 문장 + 금 버튼(`:155-166`).
- Expo(현재): 로딩 `CardSkeletons`(문구 없음) · 401·빈 `EmptyState` · 오류 `ErrorState`(`app/mypage/inquiries.tsx:43-52`).
- 차이: 카드 유무, 아이콘·굵기·색, 로딩 표시, 버튼.
- 중요도: P1
- 분류: 상태(로딩·빈·오류)
- 고칠 방법: `features/mypage/components/InlineState.tsx`(카드 없음): `items-center justify-center py-[56px]` + 아이콘 40(rgba 색) + 문장 + 선택 버튼(`gold`, `px-24 py-10 rounded-xl bold`, `mt-[20px]`). 로딩 `ActivityIndicator size={24} color={colors.gold}` + `mt-[12px] text-sm text-muk-soft` `inquiries.loading`, `py-[64px]`.
- 바꿀 Expo 파일: 새 `features/mypage/components/InlineState.tsx` · `app/mypage/inquiries.tsx:43-52`
- 문구(i18n): 재사용 `inquiries.loading/loginRequired/loadFailed/retry/empty/emptyCta`
- 네이티브 주의: ActivityIndicator 모양 차이.
- 확인 방법: `05-inquiries-lab.mjs` 재실행.
- 크기: S · 의존: G5b-05
- 표시: —

### G5b-26 문의 카드 세부(여백·줄 높이·목록 폭)
- 화면·상태: G5-INQ-05
- 스크린샷: shots/G5b/inq-05-list-tall.pair.png · inq-05-list-top.pair.png
- 웹(기준): 목록 `p-6` + `max-w-md mx-auto gap-4`(`inquiries/page.tsx:122-123`) · 본문 `p-5`, 머리 행 `mb-2`, 제목 `font-bold mb-1 break-all`, 날짜 `text-xs mb-3`, 내용 `text-sm leading-relaxed whitespace-pre-wrap break-all`(22.75) · 답변 `px-5 py-4`(`:168-202`).
- Expo(현재): `px-16 py-16 gap-16`, 본문 `p-[16px] gap-[4px]`, 내용 `mt-[8px] leading-[21px]`, 답변 `px-16 py-12`(`app/mypage/inquiries.tsx:40-84`). 긴 문자열은 두 앱 모두 넘치지 않음(측정).
- 차이: 여백 20↔16, 줄 높이 22.75↔21, 답변 세로 16↔12.
- 중요도: P2
- 분류: 크기·간격
- 고칠 방법: 본문 `p-[20px]`, 제목 아래 4·날짜 아래 12, 내용 `leading-[22.75px]`, 답변 `px-[20px] py-[16px]`.
- 바꿀 Expo 파일: `app/mypage/inquiries.tsx:54-84`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드는 `break-all` 이 없어 긴 URL 이 어절 단위로만 끊길 수 있다.
- 확인 방법: 측정 box padding 20.
- 크기: S · 의존: G5b-04
- 표시: 네이티브 확인 필요

---

## 나의 실험실 [LAB]

### G5b-27 이유 칩 크기·바탕·선택 색, 목록에서 제거(X) 버튼
- 화면·상태: G5-LAB-05·06
- 스크린샷: shots/G5b/lab-05-list.pair.png · lab-06-other-note.pair.png
- 웹(기준): 칩 `px-3 py-1.5 rounded-full border text-xs font-medium` — 기본 `bg-hanji border-line text-muk`, 선택 `bg-gold text-white border-gold`(측정 높이 30)(`lab/page.tsx:331-345`) · X `size 18 text-muk-soft`, 상자 없음(`:315-323`).
- Expo(현재): `Chip` `min-h-[40px]`(화면이 줌) `text-[13px] semibold`, 기본 `bg-white text-muk-soft`, 선택 `bg-jade-chip border-jade text-muk`(측정 40, `rgb(216,223,213)`)(`app/mypage/lab.tsx:153-164`, `components/ui/Chip.tsx:35-46`) · X `IconButton` 20 box 36(`lab.tsx:144-150`).
- 차이: 칩 높이 30↔40, 바탕, 글자 12/muk ↔ 13/muk-soft, 선택 금 ↔ 비취.
- 중요도: P1
- 분류: 크기·간격 · 색·효과 · 글꼴
- 고칠 방법: `Chip variant="lab"`(또는 `ReasonChip`): `min-h-[30px] px-[12px] py-[6px] rounded-full border`, `text-xs` medium, 기본 `bg-hanji border-line text-muk`, 선택 `bg-gold border-gold text-white`, hitSlop 위아래 7. 화면 `min-h-[40px]` 삭제. X `IconButton size={18} box={18}`.
- 바꿀 Expo 파일: `components/ui/Chip.tsx` · `app/mypage/lab.tsx:144-164`
- 문구(i18n): 재사용 `lab.reason.*` `lab.hide`
- 네이티브 주의: 큰 글자에서 `min-h` 라 잘리지 않음.
- 확인 방법: `chips` 측정 h 30, 선택 bg `rgb(193,154,62)`.
- 크기: S · 의존: G5b-06
- 표시: —

### G5b-28 메모·직접 설명 입력칸·보내기 버튼·카드 아래 줄
- 화면·상태: G5-LAB-06·07, G5-LAB-05
- 스크린샷: shots/G5b/_view-lab-edit.png(lab-06-other-note · lab-07-free-text)
- 웹(기준): 라벨 `text-sm font-semibold text-muk-soft mb-2` · textarea `bg-hanji border-line rounded-xl p-3 text-sm resize-none`, 메모 rows 3 · 직접 rows 2 · 카운터 `text-[11px] tabular-nums` · 보내기 `px-4 py-2 rounded-xl bg-gold text-sm font-bold`(`lab/page.tsx:351-412`) · 아래 줄 `mt-4 pt-3 border-t`, 버튼 `text-xs font-semibold px-2 py-1`(≈24)(`:415-433`) · 카드 `rounded-3xl p-5`(`:298`).
- Expo(현재): `TextField` 흰 바탕 `text-base` `px-14 py-12`, 높이 96/72(`app/mypage/lab.tsx:166-204`, `parts.tsx:10-27`) · 보내기 그라데이션 44 · 아래 줄 `mt-16 pt-8` + `min-h-[44px]`(`:206-227`) · 카드 p16 r16.
- 차이: 입력칸 바탕·글자·높이, 버튼, 아래 줄 높이(24↔44).
- 중요도: P1
- 분류: 크기·간격 · 색·효과
- 고칠 방법: 1) `TextField tone="hanji" size="sm"`(bg-hanji, 14px, padding 12, 줄 높이 20 → rows3 84 / rows2 64, `maxHeight` 같게 + 스크롤). 2) 보내기 `gold sm`. 3) 아래 줄 `mt-[16px] pt-[12px] border-t border-line`, 버튼 `px-[8px] py-[4px]` + `hitSlop={{top:10,bottom:10}}`. 4) 카드 `rounded-3xl p-[20px]`.
- 바꿀 Expo 파일: `app/mypage/lab.tsx:131-227` · `features/mypage/components/parts.tsx`
- 문구(i18n): 재사용 `lab.noteLabel/notePlaceholder/noteSubmit/freeText*/skip`
- 네이티브 주의: 안드로이드 멀티라인은 `maxHeight` 없으면 자란다.
- 확인 방법: `noteMeasure` textarea 84, 보내기 금.
- 크기: S · 의존: G5b-05, G5b-27
- 표시: 네이티브 확인 필요

### G5b-29 '직접 설명하기'의 외부 AI 안내 줄(Expo 전용)
- 화면·상태: G5-LAB-07(Expo 저장 상태는 AI 동의 granted)
- 스크린샷: shots/G5b/lab-07-free-text.pair.png
- 웹(기준): 라벨 아래 바로 textarea, AI 안내 없음(`lab/page.tsx:383-412`).
- Expo(현재): `AiConsentNotice` — 동의함: Sparkles + `app.aiConsent.notice` · 미동의: 입력 꺼짐 + 허용 묻기 · 거부: 안내 + '설정에서 바꾸기'(`app/mypage/lab.tsx:187-201`, `features/aiConsent/AiConsentNotice.tsx`).
- 차이: Expo 에만 안내 한 줄(+ 동의 상태에 따른 입력 비활성).
- 중요도: P1
- 분류: 추가
- 고칠 방법: 권장 — 유지(App Store 5.1.2(i)·외부 전송 고지, 계획 §8.2). 웹에도 같은 고지를 넣는 것이 맞다(웹 작업).
- 바꿀 Expo 파일: 없음(유지)
- 문구(i18n): 재사용 `app.aiConsent.*`
- 네이티브 주의: 없음.
- 확인 방법: —
- 크기: S · 의존: 없음
- 표시: 결정 필요

---

## 개인정보 및 약관 [PRV]

### G5b-30 개인정보 문안·절 수·날짜·웹 링크·위치약관 모달
- 화면·상태: G5-PRV-01, G5-PRV-02
- 스크린샷: shots/G5b/prv-01-tall.pair.png · prv-01-top.pair.png · prv-02-terms-modal.pair.png
- 웹(기준): 7절 — 수집하는 정보·데이터 저장 위치·이용 기록·부정 이용 방지·제3자 제공·이용약관·문의(`privacy.*`), "최종 업데이트 · 2026-10-31"(`privacy/page.tsx:8,15-25,70-72`).
- Expo(현재): 13절 — 위 7절 + 위치정보(+ '위치기반서비스 이용약관 전문 보기' → 모달) · 외부 AI 처리 · 처리 위탁과 국외 이전 · 보관 기간과 파기 · 데이터 삭제 · 만 14세 미만; 수집·저장·이용 기록·제3자 본문은 앱용 `app.privacy.*` · '웹에서 전체 안내 보기'(외부) · "2026-11-02"(`app/mypage/privacy.tsx:33-82`). 측정 높이 1620 ↔ 2738.
- 차이: 절 6개 추가·본문 4절 다름·날짜·버튼 2개·약관 모달.
- 중요도: P0
- 분류: 문구 · 추가
- 고칠 방법: 어느 판이 이길지 먼저 정한다. (A) 권장 — Expo 13절 판을 정본으로(위치정보법·스토어 요구 항목 포함, 최신), 법무 검토(`docs/MOBILE_PRIVACY_DRAFT.md`) 통과 후 **웹**을 같은 절·날짜로(웹도 위치·외부 AI 사용). 앱 전용 문장만 `app.privacy.*` 로 남기고 '웹에서 전체 안내 보기'는 유지. (B) 웹 7절로 Expo 축소 — 법적 고지 누락 위험(권장 안 함). 법무 검토 전엔 문구 변경 금지.
- 바꿀 Expo 파일: (A) 없음(웹 작업) · (B) `app/mypage/privacy.tsx`
- 문구(i18n): (A) 웹이 `app.privacy.*` 일부를 공용 `privacy.*` 로(4로케일 동시, 병렬 분할 금지)
- 네이티브 주의: 약관 모달·외부 링크 안드로이드 확인.
- 확인 방법: `06-privacy-settings.mjs` `sections` 두 앱 동일.
- 크기: M · 의존: 법무 검토
- 표시: 결정 필요(법무 검토 대기)

### G5b-31 개인정보 절 카드 모양(아이콘·여백·광원)
- 화면·상태: G5-PRV-01
- 스크린샷: shots/G5b/prv-01-top.pair.png
- 웹(기준): 절 `rounded-3xl p-5`, 머리 `gap-3 mb-2.5`, 원 `w-9 h-9 bg-gold/10` + 아이콘 18 gold-deep, 본문 `text-sm leading-relaxed`, 푸터 `text-xs text-muk-soft/80 px-4 py-2`, 노을 광원(`privacy/page.tsx:51-76`).
- Expo(현재): r16 p16 `gap-10`, 원 36 + 아이콘 20, 본문 `leading-[22px]`, 푸터 `text-muk-soft`, 광원 없음(`app/mypage/privacy.tsx:57-81`).
- 차이: 아이콘 18↔20, 여백, 푸터 색, 광원.
- 중요도: P2
- 분류: 크기·간격 · 아이콘·이미지
- 고칠 방법: `Icon size={18}`, `rounded-3xl p-[20px]`, 머리 `mb-[10px]`, 본문 `leading-[22.75px]`, 푸터 `text-muk-soft/80`, 광원(G5b-20 방식, 왼쪽 위).
- 바꿀 Expo 파일: `app/mypage/privacy.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 없음.
- 확인 방법: `prv-01-top.pair.png` 재촬영.
- 크기: S · 의존: G5b-04
- 표시: —

---

## 설정 [SETG]

### G5b-32 선택 상자(select) ↔ 칩: 언어(마이 머리·설정)와 문의 유형
- 화면·상태: G5-MY-12, G5-SETG-01·08, G5-SUP-01·03
- 스크린샷: shots/G5b/setg-01-guest-top.pair.png · setg-08-lang-en.pair.png · sup-01-form.pair.png · sup-03-filled.pair.png
- 웹(기준): 언어 = 흰 알약 `rounded-full border-line bg-white px-3 text-sm` + Globe 16 + `<select>`(`components/LanguageSwitcher.tsx:9-29`, 설정 `settings/page.tsx:118-120`) · 문의 유형 = `<select>` `bg-white border-line rounded-xl p-4 appearance-none`(화살표 없음, 58)(`support/page.tsx:119-130`).
- Expo(현재): 언어 칩 4개 radiogroup(선택 비취)(`features/mypage/components/LanguageSwitcher.tsx:8-23`), 마이 머리엔 없음 · 유형 칩 4개 `min-h-[44px]`(`app/mypage/support.tsx:93-106`).
- 차이: 한 줄 선택 상자 ↔ 칩 줄(카드·폼 높이), 선택 색.
- 중요도: P1
- 분류: 배치 · 동작
- 고칠 방법: `components/ui/SelectField.tsx` — `Pressable` 상자 + 누르면 `ModalSheet`(`components/ui/Sheet.tsx`)에 라디오 목록. `variant="pill"`(언어: `rounded-full border-line bg-white px-[12px] min-h-[32px]` + Globe 16 + 라벨 sm medium + ChevronDown 14 + 그림자 `0 2px 14px rgba(43,35,32,.08)`) · `variant="field"`(유형: `rounded-xl border-line bg-white p-[16px] min-h-[58px]`, 화살표 없음). Expo web 은 `Platform.OS==='web'` 일 때 진짜 `<select>` 도 가능.
- 바꿀 Expo 파일: 새 `components/ui/SelectField.tsx` · `features/mypage/components/LanguageSwitcher.tsx` · `app/mypage/settings.tsx:127-129` · `app/mypage/support.tsx:93-106` · `app/(tabs)/mypage.tsx`(머리)
- 문구(i18n): 재사용 `support.typeLabel` `support.type*` `settings.langTitle` / 새 키 `app.mypage.languageSelect`(G5b-07 과 같은 키)
- 네이티브 주의: 시트 선택지 44pt.
- 확인 방법: 설정 언어 카드 높이 ≈126, 유형 상자 58.
- 크기: M · 의존: 없음
- 표시: —

### G5b-33 Expo 전용 설정 행 3개(위치정보 동의·외부 AI·게스트 데이터 삭제)와 계정 삭제 카드 조건
- 화면·상태: G5-SETG-01·02·05·06·07·10
- 스크린샷: shots/G5b/setg-01-guest-tall.pair.png · setg-02-member-tall.pair.png · setg-06-location-consent-route.pair.png
- 웹(기준): 언어 · (테마 숨김) · 혼잡 알림 · [사장님] · 데이터 관리 · [가입 계정만 '계정 삭제' — `getAuthState()==='linked'`] · 앱 정보(`settings/page.tsx:105-248`, 조건 `:30-36,215`).
- Expo(현재): 언어 · [사장님] · **위치정보 이용 동의**(상태 + '동의 철회'/'동의하기' → `/intro?step=consent`) · **외부 AI 해석**(상태 + '허용 철회'/'허용 여부 고르기') · 데이터 관리 · **계정 판정 후 늘 삭제 카드**(가입 '계정 삭제' / 게스트 **'내 데이터 삭제'**, 판정 `account/me` `is_anonymous`) · 앱 정보(`app/mypage/settings.tsx:126-232`). 삭제 진행 중: 웹 disabled + "불러오는 중..." / Expo 스피너 + 같은 라벨(`:211-219`).
- 차이: 행 3개 추가, 삭제 카드 노출 조건·판정 출처.
- 중요도: P0
- 분류: 추가 · 동작
- 고칠 방법: 권장 — 3행 유지(위치정보법 철회 수단, App Store 5.1.2(i), 계획 §7.3·스토어 삭제 요구), 웹에도 같은 행 추가 권장(웹 작업). 판정 출처를 맞추려면 Expo '계정 삭제' 선택을 `profile.isMember`(getUser) 기준으로.
- 바꿀 Expo 파일: (판정 맞춤) `app/mypage/settings.tsx:51-53`
- 문구(i18n): 재사용 `app.settings.*` `app.mypage.deleteData*`
- 네이티브 주의: 동의 화면은 G1(CNS).
- 확인 방법: —
- 크기: S · 의존: 없음
- 표시: 결정 필요 · 촬영 못 함(삭제 진행 중 — 확인창 수락 안 함)

### G5b-34 설정 버튼·아이콘 원 색(데이터 초기화·계정 삭제·SectionCard)
- 화면·상태: G5-SETG-01·02
- 스크린샷: shots/G5b/setg-01-guest-tall.pair.png · setg-02-member-tall.pair.png
- 웹(기준): '저장 데이터 초기화' `rounded-2xl border-terracotta/30 bg-terracotta/10 px-4 py-3 text-sm font-semibold text-terracotta` + Trash2 16(`settings/page.tsx:205-212`) · '계정 영구 삭제' `rounded-2xl border-terracotta/30 px-4 py-3 … text-terracotta`(`:226`) · 원 색: 언어 `bg-jade/10`+jade, 혼잡 `bg-gold/10`+gold, 데이터 `bg-terracotta/10`+terracotta, 삭제 `bg-terracotta/10`, 앱 정보 `bg-muk/5`+muk-soft(`:110,163,197,218,236`).
- Expo(현재): 두 버튼 `Button secondary`(흰·line·muk bold)(`app/mypage/settings.tsx:200,211-219`) · `SectionCard` 원은 늘 `bg-hanji-deep`(`features/mypage/components/parts.tsx:48`).
- 차이: 위험 버튼 색, 원 색조.
- 중요도: P1
- 분류: 색·효과
- 고칠 방법: 1) `Button variant="dangerSoft"`(bg-terracotta/10 border-terracotta/30 text-terracotta semibold rounded-2xl px-16 py-12 text-sm) · `"dangerOutline"`(투명 바탕). 2) `SectionCard` 원 바탕 고정 맵 `{ jade:'bg-jade/10', gold:'bg-gold/10', 'gold-deep':'bg-gold/10', terracotta:'bg-terracotta/10', 'muk-soft':'bg-muk/5' }`(NativeWind 는 `bg-${tone}/10` 조합을 못 찾는다).
- 바꿀 Expo 파일: `components/ui/Button.tsx` · `features/mypage/components/parts.tsx:30-59` · `app/mypage/settings.tsx:199-221`
- 문구(i18n): 없음
- 네이티브 주의: 없음.
- 확인 방법: '저장 데이터 초기화' box bg `rgba(193,85,59,0.1)`.
- 크기: S · 의존: G5b-03
- 표시: —

### G5b-35 되돌릴 수 없는 동작 확인: 웹 페이지 안 토스트 ↔ Expo `window.confirm`/Alert
- 화면·상태: G5-SETG-03·04, G5-SETG-05~07
- 스크린샷: shots/G5b/setg-03-reset-confirm.pair.png · setg-04-delete-confirm.pair.png(Expo 확인창은 브라우저 창이라 스크린샷 없음 — 문구는 measure.json `dialogs`)
- 웹(기준): sonner 토스트 — `settings.resetConfirm` + `resetConfirmDesc` + '취소'·'초기화', 8초; 계정 삭제 '영구 삭제', 10초(`settings/page.tsx:40-86`).
- Expo(현재): `confirmDestructive` → `Alert.alert`(`features/mypage/confirm.ts:4-21`) → Expo web `window.confirm("제목\n\n설명")`(라벨 없음), 안드로이드 OS 대화상자.
- 차이: 토스트 ↔ 모달 대화상자, 시간 제한, 버튼 라벨(Expo web).
- 중요도: P1
- 분류: 동작
- 고칠 방법: (A) `confirmDestructive` 를 sonner-native 토스트로: `toast(title, { description, duration: 8000|10000, action: { label, onClick: () => resolve(true) }, cancel: { label, onClick: () => resolve(false) }, onDismiss/onAutoClose: () => resolve(false) })` — `AppToaster` 에 action/cancel 스타일 이미 있음(`components/ui/Toast.tsx:42-44`). (B) OS 대화상자 유지. 권장 (A).
- 바꿀 Expo 파일: `features/mypage/confirm.ts`
- 문구(i18n): 재사용 `settings.resetConfirm(Desc)` `settings.resetAction` `settings.deleteAccountConfirm(Desc)` `settings.deleteAccountAction` `common.cancel` `app.settings.*Withdraw*` `app.mypage.deleteData*`
- 네이티브 주의: TalkBack 토스트 버튼 초점 확인; G5b-01 전에는 탭 없는 화면에서 토스트가 64 위에 뜬다.
- 확인 방법: `06-privacy-settings.mjs` → Expo `dialogs` 0건, 토스트 보임.
- 크기: S · 의존: G5b-01(권장)
- 표시: 결정 필요

### G5b-36 앱 정보 버전 0.1.0 ↔ 1.0.0
- 화면·상태: G5-SETG-01
- 스크린샷: shots/G5b/setg-01-guest-tall.pair.png
- 웹(기준): `APP_VERSION='0.1.0'` 하드코딩(`settings/page.tsx:20`) → "버전 0.1.0".
- Expo(현재): `Constants.expoConfig.version`(app.json 1.0.0)(`app/mypage/settings.tsx:50`) → "버전 1.0.0".
- 차이: 표시 버전.
- 중요도: P2
- 분류: 문구
- 고칠 방법: 권장 — Expo 는 실제 앱(스토어) 버전 유지, 웹 표기는 웹 결정. 엄격히 같게는 권장 안 함.
- 바꿀 Expo 파일: 없음(유지)
- 문구(i18n): 재사용 `settings.version`
- 네이티브 주의: 네이티브 실제 빌드 버전은 `Application.nativeApplicationVersion`.
- 확인 방법: —
- 크기: S · 의존: 없음
- 표시: 결정 필요

---

## 고객지원 / 문의하기 [SUP]

### G5b-37 필수 입력 검증: 웹 `required` 말풍선(버튼 늘 활성) ↔ Expo 버튼 비활성
- 화면·상태: G5-SUP-01(빈 채로 보내기)
- 스크린샷: shots/G5b/sup-01-empty-submit.pair.png · sup-01-form.pair.png
- 웹(기준): 제목·내용 `required`, 버튼 늘 활성 — 빈 채로 누르면 브라우저 검증 말풍선 + 첫 빈 칸 초점(측정 "Please fill out this field.", 헤드리스는 영어)(`support/page.tsx:142,154,173-180`).
- Expo(현재): `canSubmit` false 면 버튼 disabled(흐린 그라데이션)(`app/mypage/support.tsx:55,139-146`), 안내 없음.
- 차이: 첫 화면 버튼 모양, 빈 칸 안내 방식.
- 중요도: P1
- 분류: 동작 · 상태
- 고칠 방법: 버튼 `disabled={submitting}` 만, 누를 때 빈 칸이면 그 칸 `focus()` + 칸 아래 `text-xs text-terracotta` 안내(또는 토스트).
- 바꿀 Expo 파일: `app/mypage/support.tsx:55-72,108-146`
- 문구(i18n): 새 키 `app.support.required`(이 항목을 채워 주세요 · Please fill out this field. · この項目を入力してください。 · 请填写此字段。 — 4로케일 동시)
- 네이티브 주의: 키보드 열린 상태에서 오류 칸으로 스크롤.
- 확인 방법: `07-support.mjs` → 버튼 opacity 1, 빈 채로 누르면 제목 칸 포커스.
- 크기: S · 의존: G5b-05
- 표시: —

### G5b-38 문의하기 입력칸·제출 중·완료 화면 세부
- 화면·상태: G5-SUP-01·03·04·05·06
- 스크린샷: shots/G5b/sup-01-form.pair.png · sup-03-filled.pair.png · _view-sup3.png(sup-04-submitting · sup-05-done) · sup-06-failed.pair.png
- 웹(기준): 입력 `p-4` → 제목 칸 58, 내용 `min-h-[200px] resize-none`(칸 안 스크롤) · 제출 중 `bg-muk-soft/40` 회색 + Send 20 + "제출 중…" · 완료 `w-20 h-20 bg-jade/15` + CheckCircle 40, 제목 `text-2xl mb-2`, 설명 `mb-8 max-w-[80%]`(두 줄), 버튼 `px-8 py-3 bg-gold rounded-xl`(`support/page.tsx:94-181`).
- Expo(현재): `TextField px-14 py-12` → 제목 칸 50, 내용 minHeight 200(Expo web 은 고정 200+스크롤, 측정) · 제출 중 흐린 그라데이션+스피너 · 완료 설명 폭 제한 없음(한 줄), 버튼 그라데이션 44(`app/mypage/support.tsx:74-147`).
- 차이: 칸 높이 58↔50, 제출 중 색, 완료 설명 줄바꿈, 버튼(G5b-05).
- 중요도: P2
- 분류: 크기·간격 · 상태
- 고칠 방법: `TextField` padding 16 변형, 제출 중 `gold` 비활성 `bg-muk-soft/40` + 아이콘 유지(스피너 대신), 완료 설명 `max-w-[80%] mb-[32px]`, 제목 `mb-[8px]`.
- 바꿀 Expo 파일: `app/mypage/support.tsx` · `features/mypage/components/parts.tsx`
- 문구(i18n): 재사용 `support.*`
- 네이티브 주의: 안드로이드 멀티라인은 내용 따라 자람 → `maxHeight: 200`.
- 확인 방법: `07b-support-done.mjs` 재실행.
- 크기: S · 의존: G5b-05
- 표시: 네이티브 확인 필요

---

## 촬영 못 한 상태

- G5-MY-03 프로필 로드 실패(Expo 전용 재시도 카드) — 사실상 도달 불가(`app/(tabs)/mypage.tsx:101-105`). 웹 대응 없음.
- G5-MY-11 로그아웃 — 공유 게스트 보호 규칙으로 누르지 않음(G5b-18, 코드 비교).
- G5-MY-13 혼잡 알림 켜짐/꺼짐 — 헤드리스 알림 권한 denied 라 웹은 '차단됨'만. Expo 해당 없음.
- G5-SUP-02 익명 안내 박스 — 세션이 없어야 보이는데 새 게스트 생성 금지. 코드상 같은 모양(웹 `support/page.tsx:163-171` ↔ Expo `support.tsx:132-137`, Card 아닌 View 라 G5b-03 영향 없음) → 차이 없음.
- G5-SETG-10 계정 삭제 진행 중 — 확인창 수락이 필요해 실행 안 함(코드 비교, G5b-33).
- G5-SETG-05~07 Expo 확인창 모양 — `window.confirm` 이라 스크린샷 불가, 문구만 수집(`prv-setg-*.measure.json` `dialogs`).
- en·ja·zh 날짜 표기(G5b-22) — 코드 비교. 마이 메인 en 은 촬영(`my-12-en-*`) — 구조 차이는 ko 와 같고, en 전용 차이는 역할 카드 제목이 '웹에서 열기' 열 때문에 두 줄이 되는 것뿐(G5b-11).
- 웹 언어 `<select>` 펼친 목록 — 네이티브 팝업이라 불가.

## 열린 질문

1. 금색 버튼(#c19a3e + 흰 글자, 4.5:1 미만)을 Expo 도 그대로 쓸지, 웹·Expo 를 함께 진하게 바꿀지(G5b-05).
2. 개인정보 정본(웹 7절 vs Expo 13절)과 법무 검토 일정(G5b-30).
3. 웹 전용 카드 4종을 앱에서도 같게 할지 — 정책(계획 §3.3·§7.2·PORTING D4·D14)과 '웹과 같게'가 충돌(G5b-08~11).
4. RN `Modal` 위로 sonner-native 토스트를 띄울 수 있는지 — 안 되면 프로필 수정 실패가 네이티브에서 안 보인다(G5b-17).
5. 확인 대화상자를 토스트로 바꿀지(G5b-35).
6. Expo web(`nextspot.expo.app`)이 배포 대상인지 — 게스트 소셜 카드가 Expo web 에서 통째로 빠지는 것(G5b-09)의 무게가 달라진다.

## 다른 그룹으로 넘길 것 (한 줄씩)

- G2: 토스트 위치·글꼴 — 웹 sonner 토스트는 하단 탭을 덮고 시스템 글꼴·검은 체크, Expo 는 탭 위 Freesentation·초록 아이콘(`my-10-edit-saved`, `cpn-05-use-success`, `lab-08-*`, `imp-03-share`).
- G2: 하단 탭 막대 모양(웹 가이드·콘솔 줄 + 흰 90% 유리 + 활성 알약, 높이 101 ↔ Expo 한지 48) — G5b-01 후 하위 화면에도 같은 문제.
- G2/전체: `Text` 기본 줄 높이(웹 1.5 ↔ Expo normal) — 메뉴 라벨·카드 제목이 체계적으로 낮다(G5b-15).
- G3·G4(Card 를 쓰는 모든 그룹): `Card` 의 `bg-*`/`border-*`/`rounded-*` 덮어쓰기 무시 버그(G5b-03).
- G1: 설정 '동의하기'가 여는 `/intro?step=consent` 동의 화면 모양.
- G3: 외부 AI 동의 묻기(`promptAiConsent`)가 Expo web 에서 `window.confirm` 하나로 줄어듦(문구 `app.aiConsent.promptTitle/Body`).
- 웹(apps/web, 기준이지만 고칠 점): `LanguageSwitcher.tsx:16` sr-only '언어 선택' 하드코딩 · 고객지원 뒤로 aria-label 없음(`support/page.tsx:83-88`) · 내 문의 뒤로 aria-label 이 '내 문의'(`inquiries/page.tsx:115`) · 임팩트 요약 카드 aria-label 이 지표를 덮음(`ImpactSummaryCard.tsx:67`) · 쿠폰 날짜 ko-KR 고정·문의 날짜 브라우저 로케일(G5b-22) · 개인정보에 위치정보·외부 AI 절 없음(G5b-30) · 실험실 '직접 설명하기' 외부 AI 고지 없음(G5b-29).
