# G1 첫 실행·인증 — 웹 ↔ Expo 화면 동등성 비교 결과

- 작성: 2026-11-10, `yunseong` `c6374ab` 작업 트리(저장소 파일 수정 없음).
  - 기준 = 웹(`apps/web`, http://localhost:3000 정적 export).
  - 비교 대상 = Expo web 빌드(https://nextspot.expo.app).
  - 조건: 390×844 @2x · ko-KR · Asia/Seoul · 경주 GPS.
- 범위: [LND] [GDE] [CNS] [SET] [LGN] [FPW] [CB] [GATE] + 시드 레시피(인벤토리 §G1).
- 표기: `W:` = `apps/web/`, `M:` = `apps/mobile/`. 줄 번호는 `c6374ab` 기준.
- 촬영 자료:
  - `shots/G1/*.pair.png` — 왼쪽 웹 · 오른쪽 Expo, 75장.
  - 측정값 `shots/G1/*.measure.json` — computed style 실측.
  - 실행 기록 `shots/G1/_run-*.measure.json`.
  - 스크립트 `work/G1/{lib,lnd,cns_set,auth,festival}.mjs`. 예: `node scratch/parity/work/G1/lnd.mjs b`(부분 실행 인자는 각 파일 머리말).
- 안전:
  - 브라우저는 모두 하네스 `openPair` 로 열었고 `state: 'saved' | 'first-run'` 만 썼다. 새 게스트 0 — `guest-ledger.json` 1명 그대로.
  - 로컬 응답(`mockRoute`/`mockGet`)으로 답한 요청: 인증(`token?grant_type=password`, `PUT /auth/v1/user`, `recover`), `GET /api/v1/events`, `GET /api/v1/users/me/vector`.
  - 정책 로그의 쓰기는 전부 가짜 응답이다 — blocked-write: `PATCH /rest/v1/users` 2, `PUT /auth/v1/user` 2, `POST /events/track` 2.
  - 추천 POST 는 모두 fixture.
- 촬영 주의: Expo 호스트(EAS)가 글꼴 TTF 요청에 **429** 를 준 순간이 있다. 그때 찍힌 2장(SET-06, GATE-01)이 대체 글꼴(serif)로 나와 다시 찍어 교체했다('다른 묶음' 의 글꼴 폴백 참고).

## 요약

- 발견 34건 — **P0 7 · P1 17 · P2 10**. 결정 필요 15건, 네이티브 확인 필요 4건, 촬영 못 함 2건(+상태 일부).
- 큰 그림: 첫 실행 묶음은 "같은 앱"으로 보이지 않는다.
  - 웹: **한 화면짜리 랜딩**(마스코트·로고·가운데 알약 칩·노을 그라데이션) 위에 **'서비스 소개' 전체화면 모달**을 첫 방문에 자동으로 띄우고, '바로 시작' → `/setup` 으로 간다.
  - Expo: **칩 4개 언어 줄 + 전체폭 카드 + 소개 본문을 이어 붙인 긴 스크롤 화면** 하나로 합쳤다. **Expo 전용 위치정보 동의 단계**가 끼고, 소개를 다시 열 길이 없다.
  - 인증 화면(로그인·재설정·콜백)은 구성은 같다. 다른 점은 바탕 그라데이션, 버튼 크기(웹 52px/16px vs Expo 44px/14px), 소셜 영역, 심사 계정 안내다.
- 가장 중요한 5건
  1. **G1-02** 첫 화면 구성 — 마스코트·로고·노을 배경 없음, 헤드라인 22px Black → 28px Bold, 가치 칩(가운데 알약) → 전체폭 카드, CTA 알약+chevron → 전체폭 사각. (P0)
  2. **G1-03 + G1-08** '서비스 소개' — 웹은 첫 방문 자동 모달이고 랜딩·하단 탭 버튼으로 언제든 다시 연다. Expo 는 본문을 첫 화면에 인라인으로 붙였고 다시 여는 진입점이 없다. 모달 머리·히어로·바로가기·생태계·데이터·계획 절도 누락. (P0)
  3. **G1-14** Expo 에만 있는 위치기반서비스 약관 동의 단계(약관 모달·저장 실패 토스트 포함) — 웹에 없는 화면이 첫 실행에 끼어든다. (P0, 결정 필요)
  4. **G1-01** 첫 실행·재방문 흐름 — 웹은 게이트 없음(딥링크 바로 열림)·재방문 때마다 랜딩·push 이동. Expo 는 게이트가 모든 경로를 `/intro` 로 replace 하고 재방문은 홈 직행. (P0, 결정 필요)
  5. **G1-31** 404 — Expo 는 카드 하나가 화면 맨 위(y=0)에 붙는 레이아웃 버그. 마스코트·큰 '404'·보조 링크·브랜드 줄도 없다. (P0)
- 그 밖의 P0: **G1-23** 소셜 로그인 영역 — Expo web 0개, 안드로이드는 구글 하나·보조 버튼 모양(결정 필요).
- 여러 발견이 함께 기대는 공용 수정:
  - **G1-20** — Expo `Button` 에 `size`·`shape`·`tone` 추가(웹 주요 버튼 52px·16px·rounded-xl/알약·단색 금 재현).
  - G1-02 의 마스코트·로고 자산.
  - G1-08 의 `GuideModal`/`GuideContent` 이식.

### 결정 필요 목록

G1-01 첫 실행 흐름·게이트 · G1-07 콘솔 입구 줄 · G1-09 바로가기 5줄 · G1-11 FAQ1 문구 · G1-12 생태계·데이터·계획 절 · G1-13 `/guide` 라우트 · G1-14 위치정보 동의 단계 · G1-20 단색 금 버튼 대비 · G1-22 심사 계정 안내 · G1-23 소셜 로그인 · G1-25 게스트 목적지 · G1-27 재설정 안내문 · G1-30 콜백 분기 · G1-32 오류 화면 문구 · G1-33 PWA 설치 배너

---

## [LND] 첫 화면 — web `/` ↔ Expo `/intro`(소개 단계)

### G1-01 첫 실행·재방문 흐름과 첫 실행 게이트가 웹과 다르다
- 화면·상태: G1-LND-03, G1-LND-05, G1-GATE-01, G1-GATE-02, 재방문 콜드 스타트
- 스크린샷: shots/G1/LND-03_start-tap_web-setup_vs_expo-consent.pair.png, shots/G1/GATE-01_first-run_deeplink_saved.pair.png, shots/G1/LND-01_first-visit_web-modal-autoopen_vs_expo-intro.pair.png, shots/G1/GDE-01_after-close.pair.png
- 웹(기준):
  - 게이트 없음 — 첫 방문에도 `/saved`·`/main` 등 어떤 주소든 그 화면이 바로 뜬다(GATE-01 왼쪽).
  - 첫 실행 순서:
    - `/` 랜딩. 폰 폭이고 `nextspot_intro_seen` 이 없으면 0.9초 뒤 소개 모달이 자동으로 열린다 `W:app/page.tsx:113-151`.
    - '바로 시작' 또는 **화면 빈 곳 탭**(`onRootTap` `:83-86`, 루트 `onClick` `:155`)으로 시작.
    - `go()` `:66-79` 가 `nextspot_setup_prefs` 가 없으면 `router.push('/setup')`, 있으면 `/main` 으로 보낸다.
  - 재방문: PWA `start_url: "/"`(`W:public/manifest.webmanifest`) → 열 때마다 랜딩이 먼저, '바로 시작'/빈 곳 탭으로 `/main`.
  - 이동은 `router.push` — 뒤로가기로 직전 화면(랜딩)에 돌아온다(`/login` `:97-101`, `/setup` 뒤로 `W:app/setup/page.tsx:63`).
- Expo(현재):
  - `FirstRunGate`(`M:features/onboarding/FirstRunGate.tsx:243-256`, 판정 `M:features/onboarding/firstRunCore.ts:33-48,73-80`)가 `/login`·`/forgot-password`·`/auth/callback` 을 뺀 모든 경로를 `/intro` 로 `replace` 한다(GATE-01 오른쪽: `/saved` → `/intro`).
  - 첫 실행: `/intro` 소개 → 같은 경로에서 위치정보 동의(G1-14) → `/setup`(replace) → `/`(replace).
  - 재방문: 첫 실행 기록이 다 있으면 홈 탭으로 바로 — 랜딩 없음.
  - 빈 곳 탭 시작 없음. 소개 → 로그인은 `router.replace('/login')` `M:app/intro.tsx:63-66`(뒤로가기로 소개에 못 돌아감).
- 차이: 딥링크 처리, 단계 수(2 vs 3), 재방문 첫 화면, 빈 곳 탭, 뒤로가기 결과.
- 중요도: P0
- 분류: 동작
- 고칠 방법:
  1. **권장안 A** — 게이트는 유지(앱 관례 + 법적 동의 단계 보호)하고, 소개 단계 화면을 웹 랜딩 그대로 만든다(G1-02·G1-03). 거기에 웹 동작 두 가지를 맞춘다.
     - (a) 랜딩 빈 곳 탭 = '바로 시작': 랜딩 루트를 `Pressable`(`noFeedback`)로 감싸 `onPress={start}`. 안쪽 버튼·링크는 각자 `Pressable` 이라 RN 응답자 규칙상 부모로 새지 않는다.
     - (b) 소개 → 로그인은 `router.push('/login')` 로(뒤로가기 = 소개). 로그인 성공·게스트 진행은 지금처럼 `replace`(`M:app/login.tsx:72,145`)라 소개가 스택 밑에 남지 않는다 — `intro.tsx:60-62` 주석의 문제는 이 replace 로 막힌다. 수정 뒤 동의 화면이 두 번 쌓이지 않는지 확인.
  2. **대안 B** — 재방문 콜드 스타트마다 랜딩 먼저(웹과 완전 동일). `M:app/(tabs)/_layout.tsx` 첫 렌더에서 실행당 1회 메모리 플래그로 `/intro?view=landing` 에 보낸다(G1-15 의 `view=landing` 분기 재사용). 매번 한 번 더 눌러야 해 비권장.
  3. **대안 C** — 게이트 제거(딥링크 바로 열기, 첫 설정은 홈 시트로). 동의 단계(G1-14)와 충돌해 비권장.
- 바꿀 Expo 파일: `M:app/intro.tsx`(A), `M:app/(tabs)/_layout.tsx`(B), `M:features/onboarding/FirstRunGate.tsx`·`firstRunCore.ts`(C)
- 문구(i18n): 재사용 없음 / 새 키 없음
- 네이티브 주의: 안드로이드 하드웨어 뒤로가기 — push 로 바꾸면 로그인에서 뒤로 = 소개, 소개에서 뒤로 = 앱 종료가 되어야 한다. `M:app/_layout.tsx` 의 `gestureEnabled:false` 는 iOS 스와이프만 막는다.
- 확인 방법: `node scratch/parity/work/G1/lnd.mjs e`(LND-03), `node scratch/parity/work/G1/auth.mjs r`(GATE-01) 재촬영 + 에뮬레이터에서 소개 → 로그인 → 뒤로.
- 크기: M · 의존: G1-02, G1-03, G1-14, G1-15
- 표시: 결정 필요

### G1-02 첫 화면(웹 폰 랜딩 ↔ Expo 소개 단계)의 구성·모양이 다르다
- 화면·상태: G1-LND-01/02(웹), G1-LND-05(Expo), G1-LND-07
- 스크린샷: shots/G1/LND-02_landing-top_vs_intro-top.pair.png, shots/G1/LND-02_full.pair.png, shots/G1/LND-07_lang-en_top.pair.png, 측정 shots/G1/LND-02_landing.measure.json
- 웹(기준) `W:app/page.tsx:153-373`(폰 배치):
  - 한 화면(390×844 스크롤 없음), 내용 세로 가운데 `z-10 flex w-full flex-1 flex-col items-center justify-center px-6 pb-8 pt-14 text-center` `:240-242`.
  - 배경:
    - `bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/25` `:156`(#faf5ec → #f1e7d3 → #e8895a 25%).
    - 가운데 금빛 광원 `w-[300px] h-[300px] bg-gold/15 rounded-full blur-[100px]` `:164`.
    - 아래 노을 광원 `w-[420px] h-[280px] bg-sunset-1/20 blur-[120px]` `:223`.
    - 능선 SVG — `viewBox 0 0 1440 240`, `preserveAspectRatio xMidYMax slice`, `h-[26vh] min-h-[140px]`, jade fillOpacity 0.08·0.08·0.13·0.13 경로 4개 `:227-237`.
    - 반딧불이 10개 — CSS 애니메이션, 위치·주기 고정 배열 `:169-220`.
  - 위→아래(실측 y):
    1. 마스코트 `NextSpotMascot variant="full"` `:245-248` — 80×100, aspect 4/5, `rounded-[28%]`, `shadow-[0_10px_28px_rgba(43,35,32,0.14)]`. 화면 높이 ≤700 이면 `w-14`, ≤660 이면 숨김. 이미지 `W:public/mascot/nextspot-guide.webp`, `object-[50%_42%]`(`W:components/NextSpotMascot.tsx:24,37`). y=108.
    2. 지역 배지 `mt-3 px-3 py-1.5 rounded-full bg-gold/15 border border-gold/30 text-xs font-bold text-gold-deep`(148×30, 700) `:251-253`.
    3. 로고 이미지 `h-14`(259×56, `W:public/nextspot-logo.png`, `<h1>` 안, alt "NextSpot") `:255-274`.
    4. 헤드라인 `mt-4 text-[22px] font-black leading-[1.25] tracking-tight`(900, 22/27.5, 자간 −0.55px) `:277-279`.
    5. 부제 `mt-2.5 max-w-sm text-[15px] text-muk-soft leading-relaxed`(15/24.4) `:280-282`.
    6. 가치 칩 4개 `:285-298` — 가운데 줄바꿈 알약 `mt-4 flex max-w-md flex-wrap justify-center gap-2`. 칩 `rounded-2xl border border-line/70 bg-white/70 fractal-glass px-3.5 py-2 text-sm font-semibold leading-snug shadow-[0_1px_2px_rgba(43,35,32,0.05)]`(내용 폭, 14px/600/19.25).
    7. '바로 시작' 알약 `mt-6 min-h-[52px] rounded-full cta-primary px-10 text-[17px] font-bold shadow-[0_8px_24px_rgba(168,70,47,0.28)]` + `ChevronRight 20`(161×52) `:302-311`.
    8. 축제 배너(G1-05).
    9. 데이터 출처 줄(G1-06).
    10. '로그인 / 회원가입'(밑줄 글자 14px 600 muk-soft) · '서비스 소개'(G1-07) `:335-350`.
    11. 콘솔 링크 줄(G1-07) `:354-372`.
- Expo(현재) `M:app/intro.tsx:94-123`, `M:features/onboarding/GuideSections.tsx:59-79`:
  - 긴 스크롤(내용 높이 1914px), 위 정렬 `px-[20px] pb-[32px] pt-[16px]` `intro.tsx:96`, 바탕 단색 `bg-hanji`.
  - 위→아래:
    1. 언어 칩 줄(G1-04).
    2. 배지 `rounded-full border border-gold/30 bg-white px-[14px] py-[6px]` + 12px **semibold** `GuideSections.tsx:63-65`.
    3. 헤드라인 `text-[28px] leading-[38px]` **bold** `:66-68`.
    4. 부제 `text-sm leading-[22px]` `:69`.
    5. 가치 4줄 **전체폭 카드** `mt-[20px] w-full gap-[8px]` — `rounded-2xl border border-line bg-white px-[14px] py-[10px]`, 14px **medium** `:70-76`.
    6. '바로 시작' 전체폭 `Button`(rounded-2xl, 14px, chevron 없음) `intro.tsx:107`.
    7. '로그인 / 회원가입' 전체폭 보조 버튼 `:108`.
    8. 소개 본문 카드(G1-03).
  - 마스코트·로고·광원·능선·반딧불이 없음.
- 차이:
  - 요소 누락: 마스코트·로고.
  - 배치: 한 화면 가운데 vs 긴 스크롤 위 정렬.
  - 글꼴: 헤드라인 22px Black vs 28px Bold, 부제 15 vs 14, 칩 600 vs 500.
  - 모양: 칩 알약 vs 전체폭 카드, CTA 알약+chevron+17px vs 전체폭 사각 14px, 로그인 밑줄 글자 vs 보조 버튼.
  - 배경: 그라데이션·광원·능선 vs 단색.
- 중요도: P0
- 분류: 배치 (+ 누락, 글꼴, 색·효과)
- 고칠 방법:
  1. **자산.**
     - `W:public/mascot/nextspot-guide.webp` → `M:assets/images/mascot-guide.webp`, `W:public/nextspot-logo.png` → `M:assets/images/nextspot-logo.png`(그대로 복사).
     - 공용 `M:components/NextSpotMascot.tsx` 추가 — variant `full`·`avatar`, 웹 `W:components/NextSpotMascot.tsx:10-41` 값. G1-31 도 사용.
  2. **새 `M:features/onboarding/LandingBackdrop.tsx`**(absolute fill, `pointerEvents="none"`).
     - (a) `Gradient`(`M:components/ui/Gradient.tsx`) 세로 3단 `colors=['#faf5ec','#f1e7d3', <landing-sunset-end>]`, `start={{x:0.5,y:0}} end={{x:0.5,y:1}}`. 끝색은 sunset-1(#e8895a) 25% 를 hanji 위에 섞은 값 ≈ `#f6dac7` — `M:lib/theme/tokens.ts` 에 `landing-sunset-end` 로 추가하고 `tokens.test.ts` 에 계산식 기록.
     - (b) 광원 2개를 react-native-svg `RadialGradient` 로(CSS blur 대체): 가운데 원 300×300(gold #c19a3e stopOpacity 0.15 → 0), 아래 가운데 타원 420×280(sunset-1, 0.2 → 0).
     - (c) 능선: `<Svg viewBox="0 0 1440 240" preserveAspectRatio="xMidYMax slice">`, `position:absolute; bottom:0; left:0; right:0; height: Math.max(0.26*windowHeight, 140)`. 경로 `d` 4개는 `W:app/page.tsx:233-236` 그대로, `fill={colors.jade}`.
     - (d) 반딧불이: Reanimated 반복(웹 배열 `:194-205` 그대로), `useReduceMotion()` 이면 정지 — 결정 시 생략 가능.
  3. **`GuideHero` 를 `LandingHero` 로 다시 쓴다**(`GuideSections.tsx:59-79` 교체). 열 `flex-1 items-center justify-center px-[24px] pb-[32px] pt-[56px]`.
     - 마스코트 80×100. `useWindowDimensions().height ≤ 700` → 56×70, `≤ 660` → 숨김. `boxShadow:'0px 10px 28px rgba(43,35,32,0.14)'`.
     - 배지 `mt-[12px] rounded-full border border-gold/30 bg-gold/15 px-[12px] py-[6px]` + Text `text-xs text-gold-deep` weight **bold**(`EmojiLine` 의 `gap-[6px]` → `gap-[4px]`).
     - 로고 `expo-image` 높이 56 · 폭 259(=56×505/109), `accessibilityRole="header" accessibilityLabel="NextSpot"`.
     - 헤드라인 `mt-[16px] max-w-[448px] text-center text-[22px] leading-[27.5px]` weight `black` + `style={{letterSpacing:-0.55}}`.
     - 부제 `mt-[10px] max-w-[384px] text-center text-[15px] leading-[24.4px] text-muk-soft`.
     - 칩 줄 `mt-[16px] max-w-[448px] flex-row flex-wrap justify-center gap-[8px]`. 칩 `rounded-2xl border px-[14px] py-[8px]` + `style={{borderColor:'rgba(230,220,198,0.7)', backgroundColor:'rgba(255,255,255,0.7)', boxShadow:'0px 1px 2px rgba(43,35,32,0.05)'}}`, 글자 `text-sm leading-[19.25px] text-muk` weight `semibold`.
  4. **'바로 시작' — 내용 폭 알약.** `Pressable` `mt-[24px] min-h-[52px] flex-row items-center gap-[6px] overflow-hidden rounded-full px-[40px]` + `style={{boxShadow:'0px 8px 24px rgba(168,70,47,0.28)'}}`. 안에 `<Gradient name="cta" style={StyleSheet.absoluteFill} pointerEvents="none"/>` + Text `text-[17px] text-white` bold + `Icon ChevronRight size={20} color="white"`(또는 G1-20 `Button size="hero" shape="full"`).
  5. **그 아래 순서.**
     - 축제 배너(G1-05) → 데이터 출처 줄(G1-06).
     - `mt-[4px] flex-row flex-wrap items-center justify-center` 줄: '로그인 / 회원가입' 글자 버튼(`Pressable min-h-[44px] justify-center px-[12px]`, Text `text-sm text-muk-soft` semibold + 밑줄(색 line, G1-18 의 안드로이드 주의)) · `·`(muk-soft) · `GuideButton compact`(G1-07).
     - 콘솔 줄(G1-07).
  6. `intro.tsx:96` 은 `Screen scroll` 을 유지(작은 화면 대비)하되 `contentClassName` 을 3번 열 구조로 바꾸고, 소개 본문은 빼서 모달로 옮긴다(G1-03).
- 바꿀 Expo 파일: `M:app/intro.tsx`, `M:features/onboarding/GuideSections.tsx`(→ `LandingHero`), 새 `M:features/onboarding/LandingBackdrop.tsx`, 새 `M:components/NextSpotMascot.tsx`, `M:lib/theme/tokens.ts`(+`tokens.test.ts`), `M:assets/images/`(2개)
- 문구(i18n): 재사용 `landing.badge` `landing.tagline` `landing.subline` `landing.value1`~`value4` `landing.ctaStart` `landing.ctaLogin` / 새 키 없음
- 네이티브 주의:
  - 안드로이드엔 CSS blur 가 없다 → 광원은 SVG 반경 그라데이션.
  - `fractal-glass`(backdrop-blur 8px)는 안드로이드에서 흐림 없이 흰 70% 판으로 충분(UI 규칙 7).
  - `expo-image` `contentPosition` 은 안드로이드 지원. 자간 em → px.
- 확인 방법: `node scratch/parity/work/G1/lnd.mjs b` → LND-02_landing-top_vs_intro-top, LND-02_full, LND-07_lang-en_top 재촬영. `LND-02_landing.measure.json` 의 tagline(22px/900)·value1(14px/600, 내용 폭)·ctaStart(161×52) 비교. 360×640 에서 마스코트 숨김 확인.
- 크기: L · 의존: G1-03(본문 이동), G1-04~G1-07(같은 화면 요소), G1-20(버튼)

### G1-03 소개 본문이 첫 화면에 인라인 — 웹은 첫 방문에 자동으로 여는 '서비스 소개' 모달
- 화면·상태: G1-LND-01, G1-LND-05, G1-GDE-01
- 스크린샷: shots/G1/LND-01_first-visit_web-modal-autoopen_vs_expo-intro.pair.png, shots/G1/LND-05_s1_problem.pair.png ~ shots/G1/LND-05_s5_bottom.pair.png
- 웹(기준): 랜딩에는 소개 본문이 없다. 폰 폭 첫 방문이면 0.9초 뒤 가이드 버튼을 프로그램으로 눌러 전체화면 `<dialog>`(G1-08)를 연다 `W:app/page.tsx:113-151`. 열림을 확인한 뒤에야 `nextspot_intro_seen='1'` 을 저장한다(4회 실패해도 저장). 닫으면 랜딩.
- Expo(현재): 문제·해결·이런 분께·FAQ·출처 줄(`GuideSections`)을 '바로 시작'·'로그인' 아래에 인라인으로 붙였다 `M:app/intro.tsx:119-121` → 첫 화면이 1914px 스크롤 페이지. 자동 모달 없음.
- 차이: 모달 vs 인라인, 첫 방문 자동 노출 유무.
- 중요도: P0
- 분류: 배치
- 고칠 방법:
  1. `intro.tsx:119-121` 의 `<GuideSections />` 삭제.
  2. G1-08 의 `GuideModal` 을 소개 단계에서 자동으로 연다. 모듈 변수 `guideAutoShown` 으로 실행당 1회:
     `useEffect(() => { if (step !== 'intro' || guideAutoShown) return; const id = setTimeout(() => { guideAutoShown = true; openGuide(); }, 900); return () => clearTimeout(id); }, [step])`
  3. 저장 플래그 주의:
     - Expo 는 `nextspot_intro_seen` 을 '소개 단계 끝'으로 쓴다(`M:features/onboarding/firstRunCore.ts:38-39`). 모달이 열릴 때 쓰면 `subscribeFirstRun` 이 즉시 동의 단계로 바꿔 버린다.
     - 웹처럼 '한 번만'이 꼭 필요하면 새 저장 키(`nextspot_intro_modal_seen`)를 따로 둔다.
     - 아니면 지금처럼 '바로 시작'·'로그인'에서만 `markIntroSeen()` — 권장(새 키 없이 실행당 1회).
- 바꿀 Expo 파일: `M:app/intro.tsx`, `M:features/onboarding/GuideModal.tsx`(G1-08)
- 문구(i18n): 재사용 없음(모달 문구는 G1-08) / 새 키 없음
- 네이티브 주의: RN `Modal` — 안드로이드 뒤로가기는 `onRequestClose` 로 닫기.
- 확인 방법: `node scratch/parity/work/G1/lnd.mjs a`(LND-01) 재촬영 — 양쪽 모두 소개 모달이 떠 있어야 한다.
- 크기: S(모달 제외) · 의존: G1-08, G1-02

### G1-04 언어 선택 — 웹은 오른쪽 위 지구본 셀렉트 알약(랜딩·로그인·소개 모달), Expo 는 칩 4개(소개)·없음(로그인)
- 화면·상태: G1-LND-07, G1-LGN-01, G1-GDE-01(모달 윗줄)
- 스크린샷: shots/G1/LND-02_landing-top_vs_intro-top.pair.png, shots/G1/LND-07_lang-en_top.pair.png, shots/G1/LGN-01_login-tab_top.pair.png, shots/G1/GDE-01_s0_top.pair.png
- 웹(기준): `LanguageSwitcher` `W:components/LanguageSwitcher.tsx:12-28`.
  - 모양: `<label>` 알약 `inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 text-sm text-muk shadow-[0_2px_14px_rgba(43,35,32,0.08)]`, 왼쪽 `Globe 16 text-muk-soft`, 네이티브 `<select>`(현재 언어 14px medium + 아래 화살표, `py-1.5`) ≈116×34.
  - 위치: 랜딩 `absolute top-4 right-4 z-20` `W:app/page.tsx:159-161`, 로그인 같은 자리 `W:app/login/page.tsx:192-194`, 소개 모달 윗줄 오른쪽 `W:components/guide/GuideContent.tsx:54-57`.
- Expo(현재): 소개만 `Chip` 4개 줄(오른쪽 정렬, 선택 = jade 테두리 + `bg-jade-chip`) `M:app/intro.tsx:98-102`. 로그인·재설정에는 없음 `M:app/login.tsx:148-272`.
- 차이: 모양(알약+목록 vs 칩 줄), 로그인·모달 누락.
- 중요도: P1
- 분류: 배치 / 누락
- 고칠 방법:
  1. 새 `M:components/LanguageSwitcher.tsx`.
     - `Pressable` 알약 `flex-row items-center gap-[6px] rounded-full border border-line bg-white px-[12px] py-[6px]` + `style={{boxShadow:'0px 2px 14px rgba(43,35,32,0.08)'}}` + `hitSlop`(44pt).
     - 안: `Icon Globe size={16} color="muk-soft"`, 현재 언어 이름(`LOCALES` 의 label) `text-sm text-muk` medium, `Icon ChevronDown size={16}`.
     - 누르면 `ModalSheet`(`M:components/ui/Sheet.tsx`)에 4줄(선택 줄에 `Check`) → `setLocale(code)`.
  2. 배치: 랜딩(G1-02) `absolute top-[16px] right-[16px] z-20`, 로그인 같은 자리, 소개 모달 윗줄(G1-08).
  3. `intro.tsx:98-102` 칩 줄 삭제.
  4. a11y: `accessibilityLabel={t('app.intro.languageLabel')}`. 참고 — 웹의 sr-only 라벨은 '언어 선택'을 **한국어로 하드코딩**했다 `W:components/LanguageSwitcher.tsx:16`. en·ja·zh 에서도 한국어로 읽히는 웹 쪽 버그라, 웹도 같은 키로 고치기를 권장한다.
- 바꿀 Expo 파일: 새 `M:components/LanguageSwitcher.tsx`, `M:app/intro.tsx`, `M:app/login.tsx`, `M:features/onboarding/GuideContent.tsx`(G1-08)
- 문구(i18n): 재사용 `app.intro.languageLabel` · `LOCALES` label / 새 키 없음
- 네이티브 주의: 안드로이드에는 웹 `<select>` 같은 기본 드롭다운 컨트롤이 없다 — 바텀시트 목록이 가장 가깝다(@expo/ui 미설치).
- 확인 방법: LND-02, LND-07, LGN-01 재촬영(`lnd.mjs b`, `auth.mjs l`).
- 크기: M · 의존: G1-02, G1-08

### G1-05 축제 배너 — 웹 랜딩은 진행 중 축제를 '바로 시작' 아래 카드로, Expo 소개에는 없음
- 화면·상태: G1-LND-01/02(축제 진행 중일 때)
- 스크린샷: shots/G1/LND-02b_festival-banner.pair.png — `GET /api/v1/events` 를 진행 중 축제 1건으로 모의(촬영일엔 실제 진행 중 축제가 없어 배너가 숨어 있었다).
- 웹(기준): `W:app/page.tsx:314-316` `<div className="mt-4 flex w-full justify-center empty:hidden"><FestivalBanner variant="banner"/></div>` → `W:components/main/FestivalBanner.tsx:206-238`.
  - 버튼: `flex w-full max-w-[24rem] items-center gap-3 rounded-2xl border border-terracotta/35 bg-white/90 py-2 pl-2 pr-3 text-left shadow-[0_4px_18px_rgba(43,35,32,0.08)]`.
  - 포스터 48×48 `rounded-xl object-cover`(없으면 `bg-terracotta/10` 안 🏮 20px).
  - 1줄: `text-[12px] font-bold text-terracotta` "🏮 지금 경주 축제" + `font-semibold text-muk-soft` "· 11.20까지"(+ "· 외 N건").
  - 2줄: 이름 `text-[14px] font-bold truncate`(ko 만).
  - 3줄: `text-[11px] text-muk-soft` "출처: ⓒ한국관광공사". 오른쪽 `ChevronRight 16`.
  - 누르면 지도 화면과 같은 축제 패널. 진행 중 축제가 없으면 자리째 숨김.
- Expo(현재): 소개에 없음. 같은 데이터·패널은 홈 `FestivalChip`(`M:features/home/ToolChips.tsx:134-160` `loadFestivalEvents`, 시트 `:200-`)에만.
- 차이: 배너 누락(축제 기간에만 보임).
- 중요도: P1
- 분류: 누락
- 고칠 방법:
  1. `ToolChips.tsx` 의 `FestivalEvent`·`loadFestivalEvents`·축제 시트 내용을 `M:features/home/festival.ts` + `FestivalSheet.tsx` 로 빼서 공유.
  2. 새 `FestivalBanner`(banner 모양) — 웹 값 그대로.
     - `Pressable w-full max-w-[384px] flex-row items-center gap-[12px] rounded-2xl border border-terracotta/35 py-[8px] pl-[8px] pr-[12px]` + `style={{backgroundColor:'rgba(255,255,255,0.9)', boxShadow:'0px 4px 18px rgba(43,35,32,0.08)'}}`.
     - 포스터 `expo-image` 48×48 `borderRadius 12`(실패·없음 → 🏮 상자 `bg-terracotta/10`).
     - 위 세 줄 글자, `Icon ChevronRight size={16} color="muk-soft"`.
     - 모델·날짜는 `@/lib/festivalBanner`(`festivalBannerModel`·`festivalDateLabel`). 이름 줄은 ko 에서만.
  3. G1-02 랜딩 '바로 시작' 아래 `mt-[16px]`. 진행 중 축제가 없으면 아무것도 그리지 않는다.
- 바꿀 Expo 파일: `M:features/home/ToolChips.tsx`(추출), 새 `M:features/home/festival.ts`·`FestivalSheet.tsx`·`FestivalBanner.tsx`, 랜딩(`LandingHero`)
- 문구(i18n): 재사용 `festival.bannerLabel` `festival.bannerUntil` `festival.bannerMore` `festival.bannerCredit` `festival.bannerAria` / 새 키 없음
- 네이티브 주의: TourAPI 포스터가 http 일 수 있음 → `toHttpsImageUrl`(ToolChips 에 이미 있음) 사용.
- 확인 방법: `node scratch/parity/work/G1/festival.mjs` 재촬영.
- 크기: M · 의존: G1-02 · G2(홈 축제 칩)와 코드 공유

### G1-06 데이터 출처 줄 — 웹은 첫 화면의 밑줄 버튼(누르면 소개 '데이터' 절 펼침+스크롤), Expo 는 맨 아래 정적 글자
- 화면·상태: G1-LND-04
- 스크린샷: shots/G1/LND-04_data-attribution-tap.pair.png, shots/G1/LND-04b_data-fresh-card.pair.png, shots/G1/LND-05_s5_bottom.pair.png
- 웹(기준):
  - 버튼 `W:app/page.tsx:322-330` — `button mt-2 min-h-11 rounded-lg px-3 text-[13px] font-semibold text-muk underline decoration-line underline-offset-4`(294×44) + `ChevronRight 14` + sr-only `dataTab.footerHint`.
  - 누르면 `requestGuideDataSection()` → 소개 모달 열기 → `<details data-data-fold>` open + `scrollIntoView({behavior:'smooth'})`(`W:components/guide/GuideDataSection.tsx:53-63`).
  - 데이터 절 = 출처 표 10행(가로 스크롤) + 신선도 카드(`GET /api/v1/freshness`, 로딩·성공·폴백) + 주석.
- Expo(현재): `GuideSections` 맨 끝 `text-center text-xs text-muk-soft` 정적 글자 `M:features/onboarding/GuideSections.tsx:144` — 누를 수 없고 첫 화면 밖(y≈1866).
- 차이: 위치(첫 화면 vs 맨 아래), 모양(13px 600 muk 밑줄+chevron vs 12px 400 muk-soft), 동작 없음.
- 중요도: P1
- 분류: 동작 / 누락
- 고칠 방법:
  1. 랜딩(G1-02) 축제 배너 아래 `mt-[8px]`: `Pressable min-h-[44px] flex-row items-center gap-[4px] rounded-lg px-[12px]` + Text `text-[13px] text-muk` semibold 밑줄(색 line) + `Icon ChevronRight size={14}`; `accessibilityLabel={`${t('landing.dataAttribution')}, ${t('dataTab.footerHint')}`}`.
  2. 누르면 `openGuide({ focus: 'data' })` — `GuideModal` 이 데이터 절을 펼친 채 열고, `ScrollView` ref 로 그 절 `onLayout` 의 y 까지 `scrollTo({ y, animated: true })`.
  3. 데이터 절(표+신선도) 구현은 G1-12. 이식하지 않기로 하면 이 줄은 출처 문구만 담은 작은 `ModalSheet` 를 연다.
- 바꿀 Expo 파일: 랜딩(`LandingHero`), `M:features/onboarding/GuideModal.tsx`, 새 `M:features/onboarding/GuideDataSection.tsx`
- 문구(i18n): 재사용 `landing.dataAttribution` `dataTab.footerHint` `dataTab.*` `freshness.*` / 새 키 없음
- 네이티브 주의: RN 에 table 이 없다 — `ScrollView horizontal` 안 640px 폭 행(웹 `min-width:640px` `W:components/guide/guide.module.css:850-856`). 세로 ScrollView 안 중첩이라 안드로이드 `nestedScrollEnabled`.
- 확인 방법: LND-04 재촬영(Expo 도 모달+펼친 데이터 절이 보여야 함).
- 크기: M · 의존: G1-08, G1-12

### G1-07 '서비스 소개' 버튼과 콘솔 입구 줄 — 웹 첫 화면에 있고 Expo 에 없다
- 화면·상태: G1-LND-02, G1-GDE-01(진입), G1-GDE-04
- 스크린샷: shots/G1/LND-02_landing-top_vs_intro-top.pair.png
- 웹(기준):
  - `W:app/page.tsx:335-350` '로그인 / 회원가입' · `GuideButton compact`(`W:components/guide/GuideProvider.tsx:13-24`) — `CircleHelp 20` + "서비스 소개" `text-xs font-medium`, `rounded-xl text-muk-soft`, `min-h-11 px-3`, `aria-label` "NextSpot 알아보기", `aria-haspopup="dialog"`.
  - 아래 콘솔 줄 `:354-372` `mt-1 text-[13px] font-semibold text-muk-soft` — `Store 14` "사장님 콘솔" · `Landmark 14` "관제 대시보드"(각 `min-h-10 px-2 underline decoration-line underline-offset-4`).
  - 콘솔 목적지는 `consoleLinks(account)` — 게스트는 `/merchant?demo=1`·`/admin/dashboard?demo=1` `W:lib/consoleLinks.ts:12-28`.
- Expo(현재): 둘 다 없음.
- 차이: 누락.
- 중요도: P1
- 분류: 누락
- 고칠 방법:
  1. `GuideButton`(G1-08 `GuideModal.tsx` 에서 export): `Pressable min-h-[44px] flex-row items-center gap-[8px] rounded-xl px-[12px]` + `Icon CircleHelp size={20} color="muk-soft"` + Text `text-xs text-muk-soft` medium `guide.label`, `accessibilityRole="button" accessibilityLabel={t('guide.title')}` → `openGuide()`. 랜딩 줄(G1-02 5번)에 둔다.
  2. 콘솔 줄(결정 필요): 앱에는 콘솔이 없다(인벤토리 D14).
     - A — 같은 모양 줄. 누르면 `WebBrowser.openBrowserAsync(`${WEB_ORIGIN}${consoleLinks(null).merchant}`)`(`WEB_ORIGIN` `M:lib/platform/shareUrls.ts`, 마이 '웹에서 열기' 카드와 같은 방식).
     - B — 빼기(관광객 앱).
     - 권장 A(첫 화면을 웹과 같게, 비용 작음).
- 바꿀 Expo 파일: 랜딩(`LandingHero`), `M:features/onboarding/GuideModal.tsx`
- 문구(i18n): 재사용 `guide.label` `guide.title` `nav.merchantShort` `nav.adminShort` / 새 키 없음
- 네이티브 주의: lucide-react-native 1.66 에 `CircleHelp`·`Store`·`Landmark` 있음.
- 확인 방법: LND-02 재촬영.
- 크기: S · 의존: G1-08
- 표시: 결정 필요(콘솔 줄)

---

## [GDE] 서비스 소개 모달·`/guide`

### G1-08 '서비스 소개' 모달 자체가 없다 — 진입점·끈적한 머리·히어로, 그리고 Expo `/intro` 닫기 모드
- 화면·상태: G1-GDE-01, G1-LND-06
- 스크린샷: shots/G1/GDE-01_s0_top.pair.png, shots/G1/GDE-01_full.pair.png, shots/G1/GDE-01_after-close.pair.png, 측정 shots/G1/GDE-01.measure.json
- 웹(기준):
  - 모달 `W:components/guide/GuideProvider.tsx:60-69`: `<dialog>` 전체화면 `h-[100dvh] w-screen bg-hanji`, 열리면 body 스크롤 잠금.
  - 끈적한 머리 `:63-67` `sticky top-0 border-b border-line bg-hanji/95 px-5 py-3 backdrop-blur-xl` — "NextSpot"(14px 600) + `ml-2` "서비스 소개"(400 muk-soft), 오른쪽 닫기 44×44 `rounded-full border border-line` + `X 20`(aria "소개 닫기"). Esc·X 로 닫힘(닫으면 원래 화면 그대로).
  - 진입점: 랜딩 '서비스 소개'(G1-07), 하단 탭 막대 윗줄 왼쪽 compact 버튼 `W:components/shell/BottomNav.tsx:160`(탭 화면 전부 — G2 NAV), 데스크톱 레일 `:148`.
  - 본문 머리(모바일 CSS `W:components/guide/guide.module.css:232-268`):
    - 윗줄 `.topline` padding 16/20 — `guide.hint` 10px muk-soft(max-w 180) + 언어 선택 `W:components/guide/GuideContent.tsx:54-57`.
    - 히어로 `.hero` padding 28/20/46 + 반경 그라데이션 2개(gold 15% @82%/30%, jade 8% @16%/85% `:35-37`).
    - eyebrow `guide.eyebrow` 11px 800 gold-deep 자간 .04em mb 17.
    - 제목 `guide.heroTitle`(pre-line 두 줄) `clamp(40px,12.5vw,56px)`(390 폭 48.75px) 800 줄높이 1.08 자간 −.065em.
    - 본문 `guide.heroBody` 15px 줄높이 1.75 muk-soft margin 22/26.
    - CTA `.primary` 전체폭 알약 bg muk·글자 hanji 15px 700 min-h 50 padding 13/26 gap 10 + `ArrowRight 18` "기다림 없는 다음 장소 찾기" → `/setup` `GuideContent.tsx:61-69`.
  - (첫 방문 자동 열림 때는 닫기 버튼에 금색 포커스 링이 보인다 — `closeRef.focus()` + focus-visible. 앱 재현 불필요.)
- Expo(현재):
  - 모달 없음. 앱 안에서 소개를 다시 여는 곳이 없다(`grep '/intro'` — 첫 실행 게이트·`/intro?step=consent` 뿐).
  - 주소로 `/intro` 를 열면 '닫기 모드' — 랜딩 머리(G1-02 의 Expo 형태) + 전체폭 '닫기' 보조 버튼 `M:app/intro.tsx:110-117` + 본문 카드(`GuideSections`).
  - '닫기' → `canGoBack ? back : replace('/')`(GDE-01_after-close: 홈으로 간다; 웹은 닫아도 랜딩 그대로).
- 차이: 모달·머리·히어로·진입점 누락, 다른 화면(닫기 모드)으로 대체, 닫은 뒤 위치.
- 중요도: P0
- 분류: 누락 / 배치
- 고칠 방법:
  1. **새 `M:features/onboarding/GuideModal.tsx`.**
     - `GuideProvider`(context `openGuide(opts?: { focus?: 'data' })`, `M:app/_layout.tsx` 에서 Stack 을 감쌈) + RN `Modal`(`animationType="fade"`, `presentationStyle="fullScreen"`, `statusBarTranslucent`, `onRequestClose={close}`).
     - 안: `View flex-1 bg-hanji` + 위 안전 영역.
     - 머리 줄(ScrollView 밖이라 늘 위 고정): `flex-row items-center justify-between border-b border-line px-[20px] py-[12px]` + `style={{backgroundColor:'rgba(250,245,236,0.95)'}}`. Text "NextSpot" `text-sm` semibold + 안쪽 Text `ml-[8px] text-muk-soft` regular `guide.label`. 닫기 `IconButton icon={X} size="lg" box={44} className="rounded-full border border-line" accessibilityLabel={t('guide.close')}`.
     - 그 아래 `ScrollView` 에 `GuideContent`.
  2. **새 `M:features/onboarding/GuideContent.tsx`**(웹 `GuideContent.tsx` 순서 그대로).
     - 윗줄 `flex-row items-center justify-between px-[20px] py-[16px]` — hint `text-[10px] text-muk-soft max-w-[180px]` + `LanguageSwitcher`(G1-04).
     - 히어로: 패딩 `px-[20px] pt-[28px] pb-[46px]` + SVG 반경 그라데이션 2개.
       - eyebrow `text-[11px] text-gold-deep` extrabold `letterSpacing:0.44` `mb-[17px]`.
       - 제목 `fontSize = clamp(40, width*0.125, 56)` extrabold, `lineHeight = fontSize*1.08`, `letterSpacing = -fontSize*0.065`.
       - 본문 `text-[15px] leading-[26.25px] text-muk-soft mt-[22px] mb-[26px]`.
       - CTA `Pressable min-h-[50px] w-full flex-row items-center justify-center gap-[10px] rounded-full bg-muk px-[26px] py-[13px]` + Text `text-[15px] text-hanji` bold + `Icon ArrowRight size={18} color="hanji"`. 누르면 모달을 닫고, 첫 실행이면 소개의 `start()`, 아니면 `router.push('/setup')`.
     - 그 아래: 바로가기(G1-09) → 문제·해결(G1-10) → 이런 분께·FAQ(G1-11) → 생태계·데이터·계획(G1-12).
  3. **진입점:** 랜딩 `GuideButton`(G1-07). 탭 화면의 웹 하단 막대 윗줄 '서비스 소개' 버튼은 G2 하단 탭 발견과 함께 처리한다(같은 `openGuide()` 호출).
  4. **`/intro` 닫기 모드 제거**(`intro.tsx:110-117`): `step===null` 이고 `params.step!=='consent'` 이면 `router.replace('/guide')`(G1-13) 또는 홈으로 보내며 `openGuide()`.
- 바꿀 Expo 파일: 새 `M:features/onboarding/GuideModal.tsx`, 새 `M:features/onboarding/GuideContent.tsx`, `M:app/_layout.tsx`, `M:app/intro.tsx`
- 문구(i18n): 재사용 `guide.title` `guide.label` `guide.close` `guide.hint` `guide.eyebrow` `guide.heroTitle` `guide.heroBody` `guide.explore` / 새 키 없음
- 네이티브 주의:
  - RN Text 는 `guide.heroTitle` 의 `\n` 을 줄바꿈으로 그린다(웹 pre-line 과 같은 결과 — 이 경우엔 맞음).
  - sonner-native 토스트는 RN Modal 위에 안 보일 수 있다 — 모달 안 토스트 금지.
- 확인 방법: `node scratch/parity/work/G1/lnd.mjs c` 의 Expo 단계를 `getByRole('button', { name: 'NextSpot 알아보기' })` 로 모달을 여는 것으로 바꿔 GDE-01_s0~s8·GDE-01_full 재촬영.
- 크기: L · 의존: G1-04, G1-07, G1-09~G1-12, G2(하단 탭 윗줄)

### G1-09 '이렇게 써 보세요'(핵심 기능 바로가기 5줄)가 없다
- 화면·상태: G1-GDE-01, G1-GDE-04
- 스크린샷: shots/G1/GDE-01_s1_shortcuts.pair.png, shots/G1/GDE-03_guide-page_top.pair.png
- 웹(기준): `W:components/guide/FeatureShortcuts.tsx:28-94`, CSS `guide.module.css:325-496`(모바일 `:475-496`).
  - 판: padding 14 · radius 22 · border line · bg hanji 94% · shadow `0 24px 80px rgba(43,35,32,0.10)`.
  - 머리: "이렇게 써 보세요" 20px 800 + 힌트 "누르면 그 화면으로 바로 가요" 13px muk-soft.
  - 줄 5개(gap 8): `min-height 68, padding 10/12, gap 12, radius 18, border line, bg hanji-deep`.
    - 아이콘 상자 40×40 radius 12 bg gold 18% + 아이콘 20 gold-deep(Map·Compass·RefreshCw·Mic·Building2).
    - 번호 13px 800 gold-deep + 이름 15px 750, 설명 13px muk-soft, `ChevronRight 18`.
  - 목적지:
    1. 혼잡 예측 지도 `/main?focus=forecast`
    2. 대안 추천 카드 `/main`
    3. 실시간 관광정보 `/main?focus=live`
    4. AI 음성 비서 `/main?focus=voice`
    5. 가게 타임세일·지역 관제 — 콘솔 알약 2개(32px `border 1.5 line bg hanji 13px 700`, 왼쪽 52px 들여)
- Expo(현재): 없음(`M:features/onboarding/GuideSections.tsx:5` 주석 '기능 바로가기 — 탭이 그 역할').
- 차이: 누락.
- 중요도: P1
- 분류: 누락
- 고칠 방법(결정 필요): 앱에 없는 기능(1 예측 지도 D8, 4 음성 비서 D1, 5 콘솔 D14)이 섞여 있다.
  - A — 같은 모양, 목적지는 2 → `router.push('/')`+모달 닫기, 3 → `/`(카드의 실시간 정보), 1·4 → 기능 이식 전까지 숨김, 5 → 콘솔 웹 열기(G1-07 A).
  - B — 절 생략(지금).
  - 권장 A.
  - 구현: 새 `M:features/onboarding/FeatureShortcuts.tsx` — 위 수치 그대로(`View` 판 + `Pressable` 줄; 아이콘 상자 `h-[40px] w-[40px] items-center justify-center rounded-xl` + `style={{backgroundColor:'rgba(193,154,62,0.18)'}}`). 목록은 `W:lib/featureShortcuts.ts` 를 `@/lib/featureShortcuts` 로 재사용(순수 모듈인지 `npm run check:shared` 로 확인).
- 바꿀 Expo 파일: 새 `M:features/onboarding/FeatureShortcuts.tsx`, `M:features/onboarding/GuideContent.tsx`
- 문구(i18n): 재사용 `featureMap.title` `featureMap.hint` `featureMap.{forecast,card,live,voice,console}.{label,desc}` `nav.merchantConsole` `nav.adminDashboard` / 새 키 없음
- 네이티브 주의: 없음.
- 확인 방법: GDE-01_s1_shortcuts 재촬영.
- 크기: M · 의존: G1-08
- 표시: 결정 필요

### G1-10 문제 → 해결 판의 모양이 다르다(웹: 바깥 판 + 진한 해결 카드 + 'NextSpot ↓' 연결)
- 화면·상태: G1-GDE-01, G1-LND-05
- 스크린샷: shots/G1/GDE-01_s2_problem.pair.png, shots/G1/GDE-01_s3_solution.pair.png
- 웹(기준) `W:components/guide/GuideContent.tsx:72-102`, CSS(모바일) `guide.module.css:104-215,270-306,314-321`:
  - 절 padding 8px 20px 48px.
  - 바깥 판 `.answer` padding 12 · radius 24 · border line · bg hanji 92% · shadow `0 24px 80px rgba(43,35,32,0.10)`.
  - 문제 카드 padding 22/18 · radius 18 · border line · bg hanji-deep.
    - 라벨 "관광객의 문제" 11px 800 gold-deep 자간 .09em mb 8.
    - 제목 21px 750 줄높이 1.3 자간 −.035em.
    - 항목 3개(mt 18 gap 10) 각 `padding 12/13 · radius 15 · border line · bg hanji · 12px 650 줄높이 1.5` + 아이콘 20 gold-deep(Clock·Route·MapPin).
  - 연결 줄: 높이 50, "NextSpot" 11px 800 gold-deep 자간 .12em + `ArrowRight 22` 90° 회전(↓).
  - 해결 카드: bg muk·글자 hanji — 라벨 gold, 항목 바탕 hanji 9%, 아이콘 gold.
  - 결과 줄 "대기는 줄이고, 경주는 한 곳 더." 15px bold gold-deep 가운데, 판 안 해결 카드 아래(padding 15/8/3).
- Expo(현재) `M:features/onboarding/GuideSections.tsx:86-116`: 흰 `Card` 두 장(p 16, gap 10, 그림자 card).
  - 라벨 12px bold muk-soft(문제)/jade(해결), 제목 16px bold.
  - 항목은 테두리 없는 줄(아이콘 18 **terracotta/jade** + 14px regular).
  - 결과 줄은 해결 카드 안 14px bold gold-deep 왼쪽 정렬. 연결 줄 없음.
- 차이: 바깥 판·진한 해결 카드·연결 줄 누락, 글자 크기(제목 21 vs 16, 항목 12 vs 14, 라벨 11 vs 12), 아이콘 색, 항목 칸 테두리.
- 중요도: P1
- 분류: 색·효과 / 글꼴 / 배치
- 고칠 방법: `GuideContent` 의 `AnswerPanel` 을 웹 값으로 만든다.
  - 바깥 판: `View rounded-[24px] border border-line p-[12px]` + `style={{backgroundColor:'rgba(250,245,236,0.92)', boxShadow:'0px 24px 80px rgba(43,35,32,0.10)'}}`. 판 그룹에 `accessibilityLabel={t('guide.answerLabel')}`.
  - 문제 카드: `rounded-[18px] border border-line bg-hanji-deep px-[18px] py-[22px]`.
    - 라벨 `text-[11px] text-gold-deep` extrabold `letterSpacing:0.99` `mb-[8px]`.
    - 제목 `text-[21px] leading-[27.3px]` extrabold `letterSpacing:-0.735`.
    - 항목 `mt-[18px] gap-[10px]`, 줄 `flex-row items-center gap-[10px] rounded-[15px] border border-line bg-hanji px-[13px] py-[12px]` + Text `text-[12px] leading-[18px]` bold(650→bold, 토큰 규칙) + `Icon size={20} color="gold-deep"`.
  - 연결 줄: `h-[50px] flex-row items-center justify-center gap-[10px]` — Text "NextSpot" `text-[11px] text-gold-deep` extrabold `letterSpacing:1.32` + `Icon ArrowDown size={22} color="gold-deep"`.
  - 해결 카드: `bg-muk`, 같은 패딩. 라벨 `text-gold`, 제목·항목 `text-hanji`, 항목 바탕 `style={{backgroundColor:'rgba(250,245,236,0.09)'}}` 테두리 없음, 아이콘 gold.
  - 결과 줄: `px-[8px] pb-[3px] pt-[15px] text-center text-[15px] leading-[22.5px] text-gold-deep` bold `letterSpacing:-0.3`.
- 바꿀 Expo 파일: `M:features/onboarding/GuideContent.tsx`(또는 `GuideSections.tsx` 를 고쳐 재사용)
- 문구(i18n): 재사용 `guide.problemLabel` `guide.problemTitle` `guide.problemWait/Route/Miss` `guide.solutionLabel` `guide.solutionTitle` `guide.solutionTiming/Alternative/Route` `guide.resultLine` `guide.answerLabel` / 새 키 없음
- 네이티브 주의: 큰 blur(80px) boxShadow 는 안드로이드 새 아키텍처에서 그려짐 — 스크롤 성능 확인.
- 확인 방법: GDE-01_s2_problem, GDE-01_s3_solution 재촬영.
- 크기: M · 의존: G1-08

### G1-11 '이런 분께'·'자주 묻는 질문' 모양과 FAQ 1번 문구가 다르다
- 화면·상태: G1-GDE-01, G1-LND-05
- 스크린샷: shots/G1/GDE-01_s4_audience.pair.png, shots/G1/GDE-01_s5_faq.pair.png, shots/G1/GDE-01_s6_faq4.pair.png
- 웹(기준) `W:components/guide/GuideContent.tsx:107-132`, CSS `guide.module.css:568-609,781-792,963-1020`:
  - 절마다 padding 48/20. kicker 13px 800 gold-deep 자간 .09em mb 14 — "이런 분께"·"FAQ". 절 제목 25px 800 줄높이 1.22 자간 −.045em.
  - 이런 분께 목록 mt 28 gap 10, 각 줄 카드 `padding 16/18 · radius 16 · border line · bg hanji-deep · 15px 650 줄높이 1.6` + `CheckCircle2 18 jade`(mt 3, gap 10).
  - FAQ `<dl>` mt 28 위 테두리 line, 항목 padding 16/4 아래 테두리 line, 질문 16px 700 줄높이 1.5, 답 mt 6 15px muk-soft 줄높이 1.75.
  - FAQ 1번 `guide.faq1Q` "가입이나 앱 설치가 필요한가요?" / `guide.faq1A` "아니요. 웹에서 바로 쓸 수 있고, 저장한 장소는 쓰던 기기에 그대로 남아요."
- Expo(현재) `M:features/onboarding/GuideSections.tsx:118-142`:
  - kicker 없음, 절 제목 16px bold.
  - 이런 분께는 카드 없는 줄(아이콘 18 jade + 14px regular 줄높이 20, gap 8).
  - FAQ 항목은 **흰 카드**(`rounded-2xl border-line bg-white px-[14px] py-[12px]`, 질문 14px bold, 답 14px 줄높이 20). 절 사이 16px.
  - FAQ 1번은 앱 키 `app.intro.faq1Q` "가입해야 쓸 수 있나요?" / `app.intro.faq1A` `:27`.
- 차이:
  - 글꼴: 제목 25 vs 16, 이런 분께 15/650 vs 14/400, FAQ 질문 16 vs 14·답 15 vs 14.
  - kicker 누락, 절 간격(96 vs 16).
  - 카드/구분선 구조가 반대 — 웹: 이런 분께=카드·FAQ=구분선, Expo: 이런 분께=줄·FAQ=카드.
  - FAQ1 문구.
- 중요도: P1
- 분류: 글꼴 / 배치 / 문구
- 고칠 방법:
  1. 공통 `SectionHead`: kicker `text-[13px] text-gold-deep` extrabold `letterSpacing:1.17` `mb-[14px]` + 제목 `text-[25px] leading-[30.5px]` extrabold `letterSpacing:-1.125`. 절 패딩 `px-[20px] py-[48px]`.
  2. 이런 분께 `mt-[28px] gap-[10px]`. 줄 `flex-row items-start gap-[10px] rounded-2xl border border-line bg-hanji-deep px-[18px] py-[16px]` + `Icon CheckCircle2 size={18} color="jade"`(`mt-[3px]`) + Text `flex-1 text-[15px] leading-[24px]` bold.
  3. FAQ `mt-[28px] border-t border-line`. 항목 `border-b border-line px-[4px] py-[16px]`(카드 아님), 질문 `text-base leading-[24px]` bold, 답 `mt-[6px] text-[15px] leading-[26.25px] text-muk-soft`.
  4. FAQ1 문구(결정 필요): 웹 문구는 '웹에서 바로 쓸 수 있고' — 앱에선 사실이 아니다. A 앱 키 유지(권장) · B 웹 키로 통일.
- 바꿀 Expo 파일: `M:features/onboarding/GuideContent.tsx`(`GuideSections.tsx`)
- 문구(i18n): 재사용 `guide.audienceKicker` `guide.audienceTitle` `guide.audience1`~`5` `guide.faqKicker` `guide.faqTitle` `guide.faq2Q`~`faq7A`. FAQ1 은 결정에 따라 `app.intro.faq1Q/A` 또는 `guide.faq1Q/A` / 새 키 없음
- 네이티브 주의: dl/dt/dd 대신 View+Text. 질문 Text 에 header 역할은 주지 않는다(웹 dt 와 같게).
- 확인 방법: GDE-01_s4·s5·s6 재촬영.
- 크기: S · 의존: G1-08
- 표시: 결정 필요(FAQ1 문구)

### G1-12 생태계('지역과 함께')·'데이터'·'계획' 절이 Expo 에 없다
- 화면·상태: G1-GDE-01(아래쪽), G1-GDE-02
- 스크린샷: shots/G1/GDE-01_s7_impact.pair.png, shots/G1/GDE-01_s8_end.pair.png, shots/G1/GDE-02_data-fold-open.pair.png, shots/G1/GDE-02_plan-fold-open.pair.png, shots/G1/LND-04b_data-fresh-card.pair.png
- 웹(기준) `W:components/guide/GuideContent.tsx:136-231`, `W:components/guide/GuideDataSection.tsx:83-147`, CSS `guide.module.css:568-1014`:
  1. **생태계**
     - kicker "지역과 함께", 제목 "나에게 좋은 선택이,\n지역의 새로운 기회로."(25px pre-line), 본문 15px 줄높이 1.8.
     - 역할 카드 4(관광객·지역 상인·관광기관·지역 주민) — padding 20/18 radius 17 bg hanji-deep, 아이콘 22 gold-deep, 이름 17px 750 mt 14, 본문 15px 줄높이 1.75.
     - 콘솔 데모 알약 2(전체폭 min-h 44 · border 1.5 line · radius 999 · 15px 700 + `ArrowRight 16`), 주석 13px + 로그인 링크 2.
  2. **'데이터' 접힘**
     - 요약 줄: 가운데 `Database 17` + "데이터" 15px 700 gold-deep + `ChevronDown 18`, 위 테두리.
     - 펼치면: kicker·제목·요약, 출처 표 10행(가로 스크롤, 13px, 머리 12.5px 800 bg hanji-deep, 오퍼레이션 12px 고정폭 gold-deep), 신선도 카드, 주석.
     - 신선도 카드(`GET /api/v1/freshness`): 로딩 `dataTab.freshLoading` / 성공 `dataTab.freshLabel` + 상대 시각 / 실패 `dataTab.freshFallback`.
  3. **'계획' 접힘** — 12주 실증 3단계(번호 원 40), 사업 모델 3카드, 미래 문단.
- Expo(현재): 없음(`M:features/onboarding/GuideSections.tsx:5-6` 주석 '공모전 심사용 절 — 대회 종료', '데이터 접힘 절(출처 한 줄로 대신)').
- 차이: 절 3개 누락.
- 중요도: P1
- 분류: 누락
- 고칠 방법(결정 필요):
  - A 셋 다 이식.
  - B 데이터 절(첫 화면 출처 줄 G1-06 의 목적지 + 공공데이터 출처 표기) + 생태계(콘솔 알약은 웹 열기)만.
  - C 지금처럼 생략.
  - 권장 B(계획 절은 공모전 전용). 다만 '웹과 같게' 원칙을 그대로 따르면 A.
  - 구현(B): 새 `M:features/onboarding/GuideDataSection.tsx`.
    - 접힘 줄 `Pressable flex-row items-center justify-center gap-[8px] border-t border-line px-[24px] py-[22px]` + `Icon Database size={17} color="gold-deep"` + Text `text-[15px] text-gold-deep` bold + `Icon ChevronDown size={18}`(펼치면 180° 회전).
    - 펼침 = `SectionHead`(G1-11) + `dataTab.summary`(15px 줄높이 27).
    - 표: `ScrollView horizontal`, 640 폭, 4칸 행. 머리 행 `bg-hanji-deep` 12.5px extrabold, 기관 칸 extrabold, 오퍼레이션 `fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' })` 12px gold-deep.
    - 신선도 카드: `apiClient.getFreshness()`(이미 있음 `M:lib/core/apiClient.ts:89`), 상대 시각 `@/lib/freshness` `relativeParts`. 그 뒤 `dataTab.note`.
    - 생태계는 위 수치 그대로(카드 4 + 알약 2 → `WebBrowser.openBrowserAsync`).
- 바꿀 Expo 파일: 새 `M:features/onboarding/GuideDataSection.tsx`, `M:features/onboarding/GuideContent.tsx`
- 문구(i18n): 재사용 `guide.navImpact` `guide.impactTitle` `guide.impactBody` `guide.tourist`·`merchant`·`admin`·`resident`(+`Body`) `dataTab.*` `freshness.*` `guide.planBadge` `guide.pilot*` `guide.business*` `guide.futureBody` `guide.weeks` `guide.consoleLoginMerchant` `guide.consoleLoginAdmin` / 새 키 없음
- 네이티브 주의: 신선도는 공개 GET(쓰기 없음). 가로 표는 세로 스크롤 안 중첩 — 안드로이드 `nestedScrollEnabled`.
- 확인 방법: GDE-01_s7·s8, GDE-02 재촬영(Expo 에도 같은 접힘 줄 클릭 단계 추가).
- 크기: L(A) / M(B) · 의존: G1-08, G1-06
- 표시: 결정 필요

### G1-13 `/guide` 페이지 — 웹 전용 라우트, Expo 는 404
- 화면·상태: G1-GDE-03
- 스크린샷: shots/G1/GDE-03_guide-page_top.pair.png, shots/G1/GDE-03_guide-page_full.pair.png
- 웹(기준): `W:app/guide/page.tsx:7-18` — 머리 `border-b border-line px-5 py-4`(왼쪽 "NextSpot" 600, 오른쪽 `ArrowLeft 16` "여행 시작하기"(`guide.back`) → `/main`) + `GuideContent`(모달과 같은 본문). 앱 안 링크는 없다(주소 직접·외부 공유).
- Expo(현재): 라우트 없음 → `+not-found`(G1-31 의 맨 위 카드).
- 차이: 누락.
- 중요도: P2
- 분류: 누락
- 고칠 방법(결정 필요):
  - A 새 `M:app/guide.tsx` — `Screen` + 위 머리 줄 + `GuideContent`(G1-08), '여행 시작하기' → `router.replace('/')`. 첫 실행 게이트 통과 목록(`M:features/onboarding/firstRunCore.ts:67`)에 넣을지 결정.
  - B 만들지 않음.
  - 권장 A(G1-08 을 하면 거의 비용 없음).
- 바꿀 Expo 파일: 새 `M:app/guide.tsx`
- 문구(i18n): 재사용 `guide.label` `guide.back` / 새 키 없음
- 네이티브 주의: 앱 링크(유니버설·앱 링크)로 `/guide` 를 받으려면 별도 설정.
- 확인 방법: `node scratch/parity/work/G1/lnd.mjs d`.
- 크기: S · 의존: G1-08
- 표시: 결정 필요

---

## [CNS] 위치정보 이용 동의 — Expo 전용

### G1-14 위치기반서비스 이용약관 동의 단계 — Expo 에만 있는 화면(약관 모달·저장 실패 토스트·재진입 포함)
- 화면·상태: G1-CNS-01 ~ G1-CNS-06
- 스크린샷: shots/G1/CNS-01_consent-default.pair.png, shots/G1/CNS-02a_one-check.pair.png, shots/G1/CNS-02b_both-checks.pair.png, shots/G1/CNS-03_terms-modal_top.pair.png, shots/G1/CNS-03_terms-modal_bottom.pair.png, shots/G1/CNS-04a_after-agree_setup.pair.png, shots/G1/CNS-05_save-failed-toast.pair.png, shots/G1/CNS-06_consent-only-reentry.pair.png, 측정 shots/G1/CNS-01_consent.measure.json
- 웹(기준): 동의 단계 없음 — '바로 시작' 다음이 바로 `/setup`(LND-03). 위치는 브라우저 권한 창뿐(G2 LOC).
- Expo(현재) `M:features/onboarding/LocationConsentView.tsx:103-185`, 호스트 `M:app/intro.tsx:68-89`:
  - 화면 구성(위→아래):
    - 제목 24px bold "위치기반서비스 이용약관 동의" + 리드 14/22.
    - 흰 `Card` — 요약 4개(14px bold + 14/20), 링크 "위치기반서비스 이용약관 · 전문 보기"(14px semibold gold-deep 밑줄).
    - 체크 줄 2개(min-h 48 rounded-2xl, 체크 시 jade 테두리 + jade/10) + 14세 안내 12/18.
    - '동의하고 계속'(primary, 두 체크 전 비활성 opacity 50 — 실측 `aria-disabled=true`) · '동의하지 않고 계속'(ghost).
  - '전문 보기' = RN `Modal pageSheet`. 웹 빌드에서는 전체화면 `role=dialog aria-modal=true`, 머리 18px bold + '닫기' ghost, 조항 8개 + 시행일.
  - 저장 실패 시 `toast.error(app.consent.saveFailed)` 후 진행(CNS-05). 이 토스트가 설정 화면 하단 바를 일부 덮는다('다른 묶음' G3).
  - 첫 실행 뒤 `/intro?step=consent` 로 동의만 다시 연다(CNS-06).
  - 실측 저장값: 동의 `{"decision":"granted","ageConfirmed":true,"termsVersion":"2026-11-draft2",…}`, 거절 `{"decision":"declined","ageConfirmed":false,…}`.
- 차이: Expo 전용 화면 1개(+모달·토스트) — 첫 실행 단계가 하나 더 있다.
- 중요도: P0
- 분류: 추가
- 고칠 방법(결정 필요):
  1. **A — 유지.** 앱이 위치기반서비스를 직접 제공하므로 약관 동의가 필요하다는 전제(계획 §6.2①·M20). 웹과 다르다는 점을 결정 기록에 남기고 모양만 맞춘다 — 위 여백 32(설정 화면과 같게, G1-15), 주 버튼 크기(G1-20).
  2. **B** — 웹에도 같은 동의 단계 추가(웹은 브라우저 권한만 쓰므로 법무 판단 필요).
  3. **C** — 첫 실행에서 빼고, 위치를 처음 쓸 때(홈 '내 주변 추천 켜기' 배너·내 위치 버튼) 동의 화면을 띄운다.
     - 첫 실행 흐름이 웹(소개 → 설정)과 같아지고 '수집 전 동의'도 지킨다.
     - 홈은 처음엔 황리단길 중심으로 시작(지금 '동의하지 않고 계속'과 같은 상태).
  - 권장: C(흐름 일치 + 법적 요건 유지). 법무가 '설치 직후 동의'를 요구하면 A.
- 바꿀 Expo 파일(C):
  - `M:features/onboarding/firstRunCore.ts` — consent 단계 제거(`:40-44`).
  - `M:app/intro.tsx` — consent 분기는 `consentOnly` 경로만 남김.
  - `M:features/home/useUserLocation.ts` — 동의 없으면 `LOCATION_CONSENT_ROUTE` push(이미 `:203`).
- 문구(i18n): 재사용 `app.locationTerms.*` `app.consent.*`(4로케일 이미 있음) / 새 키 없음
- 네이티브 주의: 안드로이드 뒤로가기 — 동의 화면에서의 동작 정의(C 면 이전 화면).
- 확인 방법: `node scratch/parity/work/G1/cns_set.mjs c`(C 면 `lnd.mjs e` 의 LND-03 에서 Expo 도 바로 `/setup` 이어야 함).
- 크기: S(A) / M(C) · 의존: G1-01
- 표시: 결정 필요

---

## [SET] 첫 설정 — web `/setup` ↔ Expo `/setup`

### G1-15 설정 머리 — 웹은 뒤로 버튼이 늘 있고(→ 랜딩) 위 여백 32px, Expo 는 첫 실행에서 뒤로 버튼이 없고 위 여백 16px
- 화면·상태: G1-SET-01, G1-SET-05
- 스크린샷: shots/G1/SET-01_default_top.pair.png, shots/G1/SET-05_setup-with-back.pair.png, shots/G1/CNS-04a_after-agree_setup.pair.png
- 웹(기준) `W:app/setup/page.tsx:58-77`:
  - `main px-5 py-8`(위 32) → 머리 `flex items-center justify-between mb-8`.
  - 왼쪽 뒤로 44×44 `rounded-xl border border-line bg-white text-muk-soft` + `ArrowLeft 20`(aria "뒤로", 실측 x20 y32). 누르면 `router.push('/')`(랜딩) `:61-68`.
  - 오른쪽 '건너뛰기' `:69-76`.
- Expo(현재) `M:app/setup.tsx:68-92`:
  - `Screen contentClassName="px-[20px] pb-[24px] pt-[16px]"`(위 16) → 모든 내용이 웹보다 16px 위.
  - 뒤로 버튼은 `router.canGoBack()` 일 때만 보인다 `:70-81`(첫 실행 replace 흐름에서는 빈 `View`).
  - 누르면 `router.back()`. SET-05: 마이 → 취향 CTA 로 들어오면 뒤로 = 마이(웹은 같은 버튼이 `/` 랜딩).
- 차이: 첫 실행 화면 왼쪽 위 버튼 누락, 세로 16px 어긋남, 뒤로 목적지.
- 중요도: P1
- 분류: 배치 / 동작
- 고칠 방법:
  1. `setup.tsx:68` `pt-[16px]` → `pt-[32px]`.
  2. 뒤로 버튼을 늘 그린다(지금 `IconButton` 값 그대로 — box 44, rounded-xl, border line, bg white, muk-soft).
  3. 누르면:
     - `canGoBack()` 이면 `back()`(앱 스택 관례 — 웹의 '늘 랜딩'과 다름은 G1-01 결정에 포함).
     - 아니면(첫 실행) `router.replace('/intro?view=landing')`.
     - `intro.tsx` 에 `params.view === 'landing'` 이면 단계와 상관없이 랜딩(G1-02)을 그리고 '바로 시작' → `nextFirstRunRoute()` 로 가는 분기를 추가한다. 이 분기는 **`step === 'setup'` 분기(`intro.tsx:91-92`)보다 먼저** 둔다 — 지금은 `<Screen>{null}</Screen>` 이라 빈 화면이 된다.
- 바꿀 Expo 파일: `M:app/setup.tsx`, `M:app/intro.tsx`
- 문구(i18n): 재사용 `common.back` / 새 키 없음
- 네이티브 주의: 안드로이드 하드웨어 뒤로도 같은 목적지(라우터 기본 동작 + 첫 실행 분기 확인).
- 확인 방법: `node scratch/parity/work/G1/cns_set.mjs s`(SET-01_default_top), `node scratch/parity/work/G1/auth.mjs r`(SET-05).
- 크기: S · 의존: G1-02

### G1-16 2번 질문 제목 줄바꿈 — 웹은 한 줄 "어떤 음식을 좋아하세요?", Expo 는 두 줄
- 화면·상태: G1-SET-01, G1-SET-06
- 스크린샷: shots/G1/SET-01_default_top.pair.png, shots/G1/SET-06_en_top.pair.png
- 웹(기준): `setup.step2` = "어떤 음식을\n좋아하세요?" 를 `h2 text-sm font-bold`(white-space normal)로 그려 `\n` 이 공백이 된다 `W:app/setup/page.tsx:92,140`.
- Expo(현재): RN Text 는 `\n` 을 줄바꿈으로 그린다 `M:app/setup.tsx:121,214` → 두 줄, 번호 원이 두 줄 가운데로(+20px). en "What food / do you like?" 도 같다.
- 차이: 줄 수·높이.
- 중요도: P1
- 분류: 배치 / 문구
- 고칠 방법: `setup.tsx` `Section` 제목을 `{title.replace(/\s*\n\s*/g, ' ')}` 로 그린다(키 문구는 그대로 — 다른 화면이 줄바꿈을 쓸 수 있음).
- 바꿀 Expo 파일: `M:app/setup.tsx`
- 문구(i18n): 재사용 `setup.step2` / 새 키 없음
- 네이티브 주의: 없음.
- 확인 방법: SET-01_default_top, SET-06_en_top 재촬영.
- 크기: S

### G1-17 '시작하기' 하단 영역 — 웹은 내용 위 그라데이션 스티키(경계선 없음, 글자 16, 그림자 0 8 20), Expo 는 위 테두리 고정 바(글자 14, 그림자 0 4 14)
- 화면·상태: G1-SET-01 ~ G1-SET-03
- 스크린샷: shots/G1/SET-01_s3_bottom.pair.png, shots/G1/SET-02_selected_s2_requirements.pair.png, shots/G1/SET-01_full.pair.png
- 웹(기준) `W:app/setup/page.tsx:112-121`:
  - `sticky bottom-0 z-10 -mx-5 mt-4 bg-gradient-to-t from-hanji from-70% to-hanji/0 px-5 pt-5 pb-[calc(1rem+env(safe-area-inset-bottom))]` — 내용이 그라데이션 밑으로 비쳐 사라지고 경계선이 없다.
  - 버튼 `min-h-[52px] w-full rounded-2xl cta-primary text-base font-bold shadow-[0_8px_20px_rgba(168,70,47,0.28)]`.
  - 저장 중 `disabled:opacity-60` + 글자 "저장 중...".
- Expo(현재) `M:app/setup.tsx:187-200`:
  - 스크롤 밖 `View border-t border-line bg-hanji px-[20px] pt-[12px]`(paddingBottom inset+12) — 1px 위 선 + 불투명 바탕.
  - `Button` 글자 14px(`M:components/ui/Button.tsx:87`), 그림자 `0 4px 14px`(`M:lib/theme/tokens.ts:106`), 저장 중 돌림표.
- 차이: 경계선 유무, 위 여백 20 vs 12, 아래 16 vs 12, 버튼 글자 16 vs 14, 그림자.
- 중요도: P1
- 분류: 색·효과 / 크기·간격
- 고칠 방법:
  1. 바를 `ScrollView` 위에 겹치는 절대 배치(`position:'absolute', left:0, right:0, bottom:0`)로 바꾼다. 바탕은 `Gradient` 세로(`colors=['rgba(250,245,236,0)','#faf5ec','#faf5ec']`, `locations=[0,0.3,1]`, start `{x:0.5,y:0}` end `{x:0.5,y:1}`), `border-t border-line` 삭제.
  2. 패딩 `px-[20px] pt-[20px]`, `paddingBottom: insets.bottom + 16`.
  3. `Screen` 내용 아래 여백을 바 높이만큼(`pb-[108px]` ≈ 20 + 52 + 16 + 여유) 늘려 마지막 토글이 가리지 않게.
  4. 버튼: G1-20 `size="lg" shadow="ctaLg"`(글자 16, 그림자 `0px 8px 20px rgba(168,70,47,0.28)`).
  5. 저장 중: 웹처럼 글자만 "저장 중..." + 투명도 0.6 — `Button` 에 `loading` 대신 `disabled` + `showSpinner={false}` + `disabledOpacity={0.6}`(G1-20).
- 바꿀 Expo 파일: `M:app/setup.tsx`, `M:components/ui/Button.tsx`(G1-20)
- 문구(i18n): 재사용 `setup.start` `setup.saving` / 새 키 없음
- 네이티브 주의: 안드로이드 제스처 내비 영역(`insets.bottom`) 포함. 바 위로 토스트가 겹치지 않는지(G3).
- 확인 방법: SET-01_s3_bottom, SET-01_full 재촬영.
- 크기: S · 의존: G1-20

### G1-18 칩 격자 폭·선택 칩 그림자·'건너뛰기' 밑줄 색(미세)
- 화면·상태: G1-SET-01, G1-SET-02
- 스크린샷: shots/G1/SET-01_default_top.pair.png, shots/G1/SET-02_selected_top.pair.png, shots/G1/SET-02_selected_s1_walk.pair.png
- 웹(기준):
  - 칩 `grid grid-cols-2 gap-2.5` / `grid-cols-3`(350 폭에서 170 / 110px, 오른쪽 끝 맞음) `W:app/setup/page.tsx:87,93,96,99`.
  - 선택 칩 `border-muk bg-muk text-hanji shadow-[0_2px_10px_rgba(43,35,32,0.18)]` `:154`.
  - '건너뛰기' `underline underline-offset-4 decoration-line/80`(연한 베이지 밑줄) `:73`.
- Expo(현재):
  - `w-[48%]` / `w-[31%]` + `gap-[10px]`(168 / 108.5px — 오른쪽 끝이 2~4px 모자람) `M:app/setup.tsx:243`.
  - 선택 칩 그림자 없음 `:244`.
  - '건너뛰기' 밑줄 = 글자색 muk-soft `:88`.
- 차이: 칩 폭 2~4px, 선택 그림자, 밑줄 색.
- 중요도: P2
- 분류: 크기·간격 / 색·효과
- 고칠 방법:
  1. 칩 행을 2개(또는 3개)씩 `flex-row gap-[10px]` 로 나누고 자식 `flex-1`(그리드와 같은 폭).
  2. 선택 칩 `style={active ? { boxShadow: '0px 2px 10px rgba(43,35,32,0.18)' } : undefined}`.
  3. 건너뛰기 `style={{ textDecorationLine: 'underline', textDecorationColor: 'rgba(230,220,198,0.8)' }}`.
- 바꿀 Expo 파일: `M:app/setup.tsx`
- 문구(i18n): 없음
- 네이티브 주의: RN `textDecorationColor` 는 iOS 만 — 안드로이드는 글자색 밑줄이 된다. 같게 하려면 밑줄 대신 글자 아래 1px View(`bg-line/80`).
- 확인 방법: SET-01_default_top, SET-02_selected_top 재촬영.
- 크기: S
- 표시: 네이티브 확인 필요(밑줄 색)

### G1-19 '시작하기'·'건너뛰기' 뒤 동작 — 저장 중 표시, push vs replace
- 화면·상태: G1-SET-03, G1-SET-04
- 스크린샷: shots/G1/SET-03_start-pressed_immediate.pair.png(누른 직후 60ms 에 이미 홈 — 저장 중 표시는 못 잡음)
- 웹(기준): `finish()` `W:app/setup/page.tsx:34-55` — 저장 → `track('context_applied')` → `router.push('/main')`(뒤로가기 = `/setup`). 버튼 "저장 중..." + 비활성.
- Expo(현재): `M:app/setup.tsx:41-64` — 저장 → track → `markSetupSeen()` → `router.replace(nextFirstRunRoute())`(첫 실행 끝 → `/`, 뒤로가기로 설정에 못 돌아감). 버튼 돌림표.
- 차이: 이동 방식(뒤로가기 결과), 저장 중 표시(코드 비교). 저장 값은 같다 — 실측 두 앱 `nextspot_setup_prefs` 가 같은 JSON(`shots/G1/_run-cns-set.measure.json` 의 `afterStart`·`afterSkip`).
- 중요도: P2
- 분류: 동작
- 고칠 방법:
  1. 저장 중 표시 → G1-17 5번.
  2. 이동 방식은 유지 권장(첫 실행 단계로 되돌아가지 않는 앱 규칙) — 차이만 기록. 원하면 첫 실행이 아닐 때(마이 → 설정)만 `push`.
- 바꿀 Expo 파일: `M:app/setup.tsx`(선택)
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 뒤로가기로 설정 화면이 다시 뜨지 않는 현재 동작 유지.
- 확인 방법: SET-03 재촬영 + 수동 뒤로가기.
- 크기: S · 의존: G1-17
- 표시: 촬영 못 함(저장 중 상태 — 이동이 즉시)

### G1-20 주 버튼·보조 버튼의 높이·글자·모서리 — Expo `Button` 은 늘 높이 44 · 글자 14 · rounded-2xl · 그라데이션
- 화면·상태: G1-LND-02(바로 시작), G1-SET-01(시작하기), G1-LGN-01/02(제출·게스트), G1-FPW-01/04(재설정 링크·로그인), G1-CB-02(마이페이지로)
- 스크린샷: shots/G1/LGN-01_login-tab_top.pair.png, shots/G1/FPW-01_default.pair.png, shots/G1/FPW-04_sent.pair.png, shots/G1/CB-02_generic-failure.pair.png, shots/G1/SET-01_s3_bottom.pair.png, 측정 shots/G1/LGN-01_login.measure.json·FPW-01.measure.json·FPW-04.measure.json·CB-02.measure.json
- 웹(기준) 실측:

  | 버튼 | 웹(파일:줄) | 높이 · 글자 · 모서리 · 색 |
  |---|---|---|
  | 랜딩 바로 시작 | `W:app/page.tsx:307` | 52 · 17px 700 · 알약(내용 폭 161) · cta 그라데이션 + chevron |
  | 설정 시작하기 | `W:app/setup/page.tsx:117` | 52 · 16px 700 · 16 · cta + 그림자 0 8 20 |
  | 로그인/회원가입 제출 | `W:app/login/page.tsx:281` | 52(py-3.5) · 16px 700 · 12 · cta, 그림자 없음 |
  | 게스트로 둘러보기 | `W:app/login/page.tsx:329` | 46 · 14px 700 · 12 · 흰 바탕 + line |
  | 재설정 링크 보내기 | `W:app/forgot-password/page.tsx:68` | 52 · 16px 700 · 12 · **단색 bg-gold(#c19a3e)** |
  | 재설정 완료 '로그인' | `W:app/forgot-password/page.tsx:55` | 46 · 14px 700 · 12 · 흰 바탕 + line |
  | 콜백 '마이페이지로' | `W:app/auth/callback/page.tsx:143` | 48 · 16px 700 · 알약(px 24, 121 폭) · **단색 bg-gold** |
- Expo(현재): 모두 `Button` `M:components/ui/Button.tsx:70-89`.
  - `min-h-[44px] px-[16px] py-[8px] rounded-2xl`, 글자 `text-[14px] leading-[18px]` bold.
  - primary = cta 그라데이션 + 그림자 `0 4px 14px`(`tokens.ts:106`), secondary = 흰 바탕 + line.
  - 실측 44 · 14px · 16 모서리(콜백 97×44).
- 차이:
  - 높이 −8(52→44) / −4(48→44) / −2(46→44), 글자 −2~3px, 모서리 16 vs 12/알약.
  - 재설정·콜백은 단색 금 vs 그라데이션, 랜딩은 알약·chevron 없음.
- 중요도: P1
- 분류: 크기·간격 / 색·효과
- 고칠 방법:
  1. **`Button` prop 추가.** UI 규칙 4(같은 속성 클래스 충돌) 때문에 size·shape 는 삼항으로 한 클래스만 붙인다.
     - `size?: 'md' | 'lg' | 'hero'` — lg = `min-h-[52px] py-[14px]` + 글자 `text-base leading-[24px]`; hero = lg + 글자 `text-[17px]` + 내용 폭 + 오른쪽 chevron.
     - `shape?: '2xl' | 'xl' | 'full'` — xl = `rounded-xl`, full = `rounded-full`.
     - `tone?: 'cta' | 'gold'` — gold = `bg-gold` 단색, 그라데이션·그림자 없음.
     - `shadow?: 'cta' | 'ctaLg' | 'ctaHero' | 'none'` — ctaLg `0px 8px 20px rgba(168,70,47,0.28)`, ctaHero `0px 8px 24px rgba(168,70,47,0.28)` → `tokens.ts` `shadows` 에 추가.
     - `showSpinner?: boolean`(기본 true), `disabledOpacity?: number`(기본 0.5).
  2. **화면별 적용.**
     - 설정 시작하기: `size="lg" shadow="ctaLg"`(2xl 유지).
     - 로그인/회원가입 제출: `size="lg" shape="xl" shadow="none"`.
     - 게스트·재설정 완료 로그인: `variant="secondary" shape="xl" className="min-h-[46px]"`.
     - 재설정 링크: `size="lg" shape="xl" tone="gold"`.
     - 콜백 마이페이지로: `tone="gold" shape="full" className="min-h-[48px] px-[24px]"` + 글자 16(`size="lg"` 높이만 48로).
     - 랜딩 바로 시작: `size="hero" shape="full" shadow="ctaHero"`(G1-02 4번).
- 바꿀 Expo 파일: `M:components/ui/Button.tsx`, `M:lib/theme/tokens.ts`(+test), `M:app/setup.tsx`, `M:app/login.tsx`, `M:app/forgot-password.tsx`, `M:app/auth/callback.tsx`, `M:app/intro.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 단색 금(#c19a3e) 위 흰 글자는 대비 약 3.7:1(앱 주석 `M:components/ui/ErrorState.tsx:28`) — 웹 그대로 하면 대비 기준(4.5:1, `docs/DESIGN_PRINCIPLES.md`) 미달. 결정 필요: 웹 그대로 / 둘 다 금 진(#705819)·cta 로 조정(웹도 같이 고침).
- 확인 방법: LGN-01, FPW-01, FPW-04, CB-02, SET-01_s3 재촬영 + 측정 JSON 높이(52/46/48).
- 크기: M · 의존: 없음(G1-02·15·17·21·24·26·29 가 이 prop 을 쓴다)
- 표시: 결정 필요(단색 금 대비)

---

## [LGN] 로그인 / 회원가입 — web `/login` ↔ Expo `/login`

### G1-21 로그인 화면 바탕·세로 정렬 — 웹은 노을 그라데이션 + 금빛 광원, 내용이 짧으면 세로 가운데; Expo 는 단색 · 늘 위 정렬
- 화면·상태: G1-LGN-01, G1-LGN-02
- 스크린샷: shots/G1/LGN-01_login-tab_top.pair.png, shots/G1/LGN-02_signup-tab_top.pair.png, shots/G1/LGN-01_login-tab_full.pair.png
- 웹(기준) `W:app/login/page.tsx:191-201`:
  - 루트 `flex flex-col items-center justify-center min-h-[100dvh] bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/20 px-6 pt-[4.5rem] pb-10`.
  - 광원 `absolute top-1/3 left-1/2 w-[280px] h-[280px] bg-gold/12 rounded-full blur-[100px]` `:197`.
  - 제목 `text-3xl font-serif font-bold mb-1`(30/36) y=72 — 로그인 탭은 내용이 길어 위에서 시작.
  - 회원가입 탭은 내용이 짧아 세로 가운데(제목 y≈225).
- Expo(현재) `M:app/login.tsx:149-155`: 단색 `bg-hanji`, `Screen scroll contentClassName="px-[24px] pb-[40px] pt-[48px]"` — 늘 위 정렬(제목 y=48), 광원 없음.
- 차이: 바탕(아래로 갈수록 노을색 vs 단색), 세로 위치(로그인 탭 24px 위, 회원가입 탭 약 177px 위), 광원.
- 중요도: P1
- 분류: 배치 / 색·효과
- 고칠 방법:
  1. 새 `M:features/auth/AuthBackdrop.tsx`(`absolute fill`, pointerEvents none).
     - `Gradient` 세로 3단 `['#faf5ec', '#f1e7d3', <auth-sunset-end>]` — 끝색 = sunset-1 20% 를 hanji 위에 섞은 값 ≈ `#f5ddcc`(tokens `auth-sunset-end` + 계산식).
     - 금빛 광원 = react-native-svg 반경 그라데이션 원(지름 280, 중심 x 50% · y 33%, gold 12% → 0).
  2. `login.tsx` `Screen contentClassName` → `flex-1 justify-center px-[24px] pb-[40px] pt-[72px]`. `Screen` 의 `contentContainerStyle flexGrow:1`(`M:components/ui/Screen.tsx:58`) 덕에 짧으면 가운데, 길면 위에서 시작한다(웹과 같은 동작).
  3. 같은 `AuthBackdrop` 을 재설정(G1-26, 광원 없음 옵션)에 재사용.
- 바꿀 Expo 파일: `M:app/login.tsx`, 새 `M:features/auth/AuthBackdrop.tsx`, `M:lib/theme/tokens.ts`
- 문구(i18n): 없음
- 네이티브 주의: 키보드가 올라오면 가운데 정렬이 흔들린다 — iOS `KeyboardAvoidingView padding` 유지, 안드로이드 `adjustResize` 확인.
- 확인 방법: `node scratch/parity/work/G1/auth.mjs l` → LGN-01, LGN-02 재촬영.
- 크기: S · 의존: G1-04(언어 선택이 같은 자리)

### G1-22 공모전 심사용 계정 안내와 `?next=` 미리 채움 — 웹에만
- 화면·상태: G1-LGN-01, G1-LGN-10, G1-LGN-11
- 스크린샷: shots/G1/LGN-01_login-tab_top.pair.png, shots/G1/LGN-11_judge-fill.pair.png, shots/G1/LGN-10_next-merchant.pair.png
- 웹(기준): 로그인 탭에만 `JudgeAccountHint` `W:app/login/page.tsx:224-233` → `W:components/JudgeAccountHint.tsx:55-91`.
  - 상자 `rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3`(342×173), 제목 13px bold gold-deep "공모전 심사용 계정".
  - 두 행 — 라벨 12px muk-soft / 이메일 14px 600 + '입력' 버튼 `rounded-lg border border-gold/40 bg-white px-2.5 py-1 text-xs font-bold text-gold-deep`. 끝줄 12px 안내.
  - '입력' → 이메일 채움 + 비밀번호 포커스(LGN-11).
  - `?next=/merchant`·`/admin…` 이면 그 계정 1행 + 이메일 칸 미리 채움 `:56-60`(LGN-10), 가입 탭 전환 시 비움 `:212`.
- Expo(현재): 없음(`M:app/login.tsx:5` 주석 '대회 종료'). `?next` 는 허용 목록만 `M:features/auth/postLoginDest.ts:19`.
- 차이: 173px 상자 누락(로그인 탭 아래 요소가 전부 위로 당겨짐), 미리 채움 없음.
- 중요도: P1
- 분류: 누락
- 고칠 방법(결정 필요):
  - A 웹에서도 빼기(대회 종료 — 웹 쪽 정리).
  - B Expo 에 이식(콘솔 없는 앱에서는 쓸모가 적음). 고르면 새 `M:features/auth/JudgeAccountHint.tsx` — 위 값 그대로, 계정은 `@/lib/judgeAccounts`(순수 모듈이면 재사용 — `check:shared` 확인).
  - C 차이 유지.
  - 권장 A 또는 C.
- 바꿀 Expo 파일: (B) 새 `M:features/auth/JudgeAccountHint.tsx`, `M:app/login.tsx`
- 문구(i18n): 재사용 `judgeAccount.title` `judgeAccount.merchant` `judgeAccount.admin` `judgeAccount.fill` `judgeAccount.fillAria` `judgeAccount.password` / 새 키 없음
- 네이티브 주의: 없음.
- 확인 방법: LGN-01, LGN-11, LGN-10 재촬영.
- 크기: S
- 표시: 결정 필요

### G1-23 소셜 로그인 영역 — 웹은 '또는' + 카카오(노랑)·구글, Expo web 은 없음, 안드로이드는 구글 하나(보조 버튼 모양)
- 화면·상태: G1-LGN-01, G1-LGN-08
- 스크린샷: shots/G1/LGN-01_login-tab_full.pair.png
- 웹(기준) `W:app/login/page.tsx:293-319`(로그인 탭에만):
  - 구분선 `flex items-center gap-3 my-5`(선 `h-px flex-1 bg-line` + "또는" 12px muk-soft).
  - 카카오 `flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm bg-[#FEE500] text-[#191600]`(342×44).
  - 구글 `bg-white text-muk border border-line`(342×46).
  - 누르면 `signInOAuth` 리다이렉트, 진행 중 disabled + 8초 안전망.
- Expo(현재) `M:app/login.tsx:239-262`, 규칙 `M:features/auth/socialPolicy.ts:17-23`:
  - `Platform.OS !== 'android'` 이면 목록 0 → Expo web·iOS 에서 구분선·버튼 영역 전체가 없다(iOS 는 `app.auth.iosSocialNote` 안내).
  - 안드로이드는 `KAKAO_LOGIN_ENABLED=false` 라 구글 하나. 모양은 `Button variant="secondary"`(흰 바탕+line, 14px, rounded-2xl, 44) — 카카오 노랑 버튼 없음.
- 차이: Expo web 에서 약 130px 영역 누락, 안드로이드 카카오 누락·구글 버튼 모양 차이.
- 중요도: P0
- 분류: 누락
- 고칠 방법(결정 필요):
  1. 안드로이드: 카카오 비즈 앱 전환(사람 작업 — HANDOVER 기록) 뒤 `KAKAO_LOGIN_ENABLED=true`. 버튼은 웹 값으로:
     - 카카오 `Pressable min-h-[44px] items-center justify-center rounded-xl py-[12px]` + `style={{ backgroundColor: '#FEE500' }}` + Text `text-sm` bold `style={{ color: '#191600' }}`(새 토큰 `kakao-yellow`·`kakao-ink`).
     - 구글 `Button variant="secondary" shape="xl" className="min-h-[46px]"`(G1-20).
     - 버튼 사이 `gap-[8px]`(지금 값 = 웹 gap-2, 같음).
  2. 구분선은 지금 값이 웹과 같다(`my-[20px] gap-[12px]`, h-px line, 12px muk-soft).
  3. Expo web(미리보기)·iOS: 정책상 0개 유지(App Store 4.8, 계획 §7.2) — 웹과 다른 점으로 기록.
- 바꿀 Expo 파일: `M:app/login.tsx`, `M:features/auth/socialPolicy.ts`(카카오 켜기), `M:lib/theme/tokens.ts`
- 문구(i18n): 재사용 `login.or` `auth.continueKakao` `auth.continueGoogle` `auth.linkError` / 새 키 없음
- 네이티브 주의: 이 비교는 Expo web 만 봤다 — 안드로이드 실기기에서 구글 버튼 모양·`openAuthSessionAsync` 흐름 확인 필요. 카카오 OAuth 는 카카오 콘솔 설정(사람 작업).
- 확인 방법: 에뮬레이터 `nextspot_phone` 에서 `/login` 캡처(Expo web 은 정책상 늘 0개).
- 크기: S
- 표시: 결정 필요, 네이티브 확인 필요

### G1-24 로그인 폼 컨트롤 치수 — 탭(40 vs 44·그림자), 입력칸(50 vs 48·자리글자 색), '비밀번호를 잊으셨나요?' 간격, 게스트 버튼
- 화면·상태: G1-LGN-01, G1-LGN-02
- 스크린샷: shots/G1/LGN-01_login-tab_top.pair.png, shots/G1/LGN-02_signup-tab_top.pair.png, 측정 shots/G1/LGN-01_login.measure.json
- 웹(기준) `W:app/login/page.tsx`:
  - 탭 판 `flex bg-white border border-line rounded-2xl p-1 mb-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]`(342×50) `:204`.
  - 탭 `flex-1 py-2.5 rounded-xl text-sm font-bold`(166×40, 선택 `bg-gold text-white`) `:214-216`.
  - 입력 `label flex items-center gap-2 bg-white border border-line rounded-xl px-3.5 py-3`(342×50) + `Mail/Lock/User 18 muk-soft`, 자리글자 `placeholder:text-muk-soft/70` `:236-246`. 폼 `flex flex-col gap-3`.
  - '비밀번호를 잊으셨나요?' `self-end inline-flex min-h-6 items-center px-1 text-xs text-muk-soft underline`(106×24, 제출 버튼 아래 12px) `:285-289`.
- Expo(현재):
  - 탭 판 342×54 그림자 없음, 탭 `min-h-[44px]`(166×44) `M:app/login.tsx:158-175`.
  - 입력 `min-h-[48px]` `M:features/auth/AuthTextField.tsx:24`, 자리글자 `colors['muk-soft']`(100%) `:33`.
  - 찾기 링크 `min-h-[44px]`(106×44 — 제출 버튼 아래 약 33px, 아래 요소가 20px 밀림) `M:app/login.tsx:231`.
- 차이: 탭 높이 +4·그림자 없음, 입력 높이 −2·자리글자 진함, 찾기 링크 줄 +20px.
- 중요도: P1
- 분류: 크기·간격
- 고칠 방법:
  1. 탭 판 `style={{ boxShadow: shadows.card }}`(0 2 14 0.06 — 같은 값), 탭 `min-h-[40px] py-[10px]` + `hitSlop={{ top: 2, bottom: 2 }}`(44 탭 영역 유지).
  2. `AuthTextField` 컨테이너 `min-h-[50px] py-[12px]`, `TextInput` `minHeight: 24` + `paddingVertical: 0`, `placeholderTextColor="rgba(107,93,79,0.7)"`(재설정 화면에도 반영됨).
  3. 찾기 링크 `min-h-[24px]` + `hitSlop={{ top: 10, bottom: 10 }}`(보이는 크기는 웹, 누르는 영역 44).
  4. 게스트 버튼 → G1-20(46, xl).
- 바꿀 Expo 파일: `M:app/login.tsx`, `M:features/auth/AuthTextField.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 TextInput 기본 위아래 패딩(8~10px)을 0 으로 해야 50 이 맞는다.
- 확인 방법: LGN-01, LGN-02 재촬영 + 측정 JSON(tabOn h=40, input h=50, forgot h=24).
- 크기: S · 의존: G1-20

### G1-25 로그인 동작 차이 — 바쁨 표시, Enter 제출, 이메일 형식 검사, 게스트 목적지, 로그인 뒤 목적지
- 화면·상태: G1-LGN-03 ~ G1-LGN-07, G1-LGN-09
- 스크린샷: shots/G1/LGN-04a_login-busy.pair.png, shots/G1/LGN-04b_invalid-credentials-toast.pair.png, shots/G1/LGN-03_empty-submit-toast.pair.png, shots/G1/LGN-05a_server-error-toast.pair.png, shots/G1/LGN-05b_email-not-confirmed-toast.pair.png, shots/G1/LGN-06a_signup-weak-password-toast.pair.png, shots/G1/LGN-06b_signup-email-exists-toast_tab-login.pair.png, shots/G1/LGN-06c_signup-confirm-sent-toast.pair.png(토스트 문구·탭 전환은 두 앱 같음 — 토스트 모양은 G3)
- 웹(기준):
  - 바쁨: 제출 `disabled:opacity-50`(글자 그대로, 돌림표 없음), 소셜 버튼도 비활성, **게스트 버튼은 활성** `W:app/login/page.tsx:278-334`.
  - Enter: `<form onSubmit>` — 어느 칸에서든 Enter 로 제출(가입 탭 포함). 이메일 `type=email`(required 없음) → 형식이 틀리면(예 `abc`) 브라우저가 제출을 막고 말풍선을 띄운다(코드 확인; 빈 칸은 통과 → 토스트).
  - 게스트: 늘 `router.push('/setup')` `:326-332`(재방문자도 설정을 다시 보게 됨).
  - 성공 뒤: 로그인 `/main`, 가입 `/setup`, `?next` 우선, 심사용 사장님 이메일 → `/merchant`, admin → `/admin/dashboard` `W:lib/postLoginDest.ts:40-73`.
- Expo(현재):
  - 바쁨: `Button loading`(돌림표 + 글자, opacity 50), **게스트 버튼도 비활성** `M:app/login.tsx:220-226,266`.
  - Enter: 비밀번호 칸 `returnKeyType="go"` 는 로그인 탭에서만 제출 `:202-203`. 가입 탭 비밀번호·닉네임 Enter 는 아무 일 없음. 이메일 형식 검사 없음(서버로 감).
  - 게스트: `canGoBack ? back() : replace(nextFirstRunRoute())` `:139-146`.
  - 성공 뒤: 로그인 `/`, 가입 `/setup`, `?next` 허용 목록만, 역할 분기 없음 `M:features/auth/postLoginDest.ts:12-43`.
- 차이: 위 다섯 가지.
- 중요도: P2
- 분류: 동작
- 고칠 방법:
  1. 바쁨: 제출 `Button showSpinner={false}`(G1-20), 게스트 버튼의 `disabled={busy}` 제거.
  2. Enter: 가입 탭 비밀번호 `onSubmitEditing` → 닉네임 포커스, 닉네임 `returnKeyType="go" onSubmitEditing={() => void handleSubmit()}`.
  3. 이메일 형식: 권장 — 그대로(서버 오류 → `login.loginError`), 차이만 기록. 맞추려면 `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` 검사 후 새 키 토스트.
  4. 게스트 목적지(결정 필요): 웹 동작은 재방문자에게 설정을 다시 묻는다 — 웹 쪽 개선(첫 실행이 아니면 `/main`)이 맞아 보인다. Expo 는 유지 권장.
  5. 성공 목적지: `/main` ↔ `/` 는 같은 홈. 역할 분기는 콘솔이 웹 전용이라 앱에서 불가 — 유지.
- 바꿀 Expo 파일: `M:app/login.tsx`, `M:components/ui/Button.tsx`(G1-20)
- 문구(i18n): (선택, 3번) 새 키 `app.auth.emailInvalid` — ko "이메일 형식을 확인해 주세요." / en "Check the email format." / ja "メールアドレスの形式を確認してください。" / zh "请检查电子邮箱格式。"
- 네이티브 주의: 안드로이드 키보드 '다음/이동' 버튼은 `returnKeyType` 으로.
- 확인 방법: `auth.mjs l` 재촬영(LGN-04a 의 Expo 버튼에 돌림표가 없고 게스트 버튼이 활성).
- 크기: S
- 표시: 결정 필요(게스트 목적지), 촬영 못 함(성공 뒤 이동 — 하네스가 로그인 차단)

---

## [FPW] 비밀번호 찾기 — web `/forgot-password` ↔ Expo `/forgot-password`

### G1-26 재설정 화면 모양 — 바탕 그라데이션, 뒤로 42/44, 제출 단색 금(52·16px), 전송 중 글자
- 화면·상태: G1-FPW-01, G1-FPW-03, G1-FPW-04, G1-FPW-05
- 스크린샷: shots/G1/FPW-01_default.pair.png, shots/G1/FPW-03_sending.pair.png, shots/G1/FPW-04_sent.pair.png, shots/G1/FPW-05_failed-toast.pair.png, 측정 shots/G1/FPW-01.measure.json·FPW-04.measure.json
- 웹(기준) `W:app/forgot-password/page.tsx`:
  - 루트 `min-h-[100dvh] bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/20 px-6 py-8` `:39`.
  - 뒤로 `mb-8 rounded-xl border border-line bg-white p-2.5` + `ArrowLeft 20`(42×42) `:41`.
  - 제목 `text-2xl font-bold font-serif`(y 106) `:44`, 설명 `mt-2 mb-7 text-sm text-muk-soft` `:45`.
  - 입력 `rounded-xl px-3.5 py-3`(50) `:62`.
  - 제출 `w-full rounded-xl bg-gold py-3.5 font-bold text-white disabled:opacity-50`(단색 금, 52, 16px). 전송 중 글자가 "불러오는 중..."(`common.loading`)으로 바뀐다 `:68-70`.
  - 완료 상자 `rounded-2xl border border-jade/30 bg-jade/10 p-5 text-sm leading-relaxed`(그라데이션 위라 더 짙은 녹회색) `:48`. '로그인' `w-full rounded-xl border border-line bg-white py-3 text-sm font-bold`(46) `:55`.
  - 실패: CAPTCHA 거절이면 `login.captchaFailed`, 그 밖 `password.requestFailed` `:25-30`(이 빌드엔 Turnstile 키가 없어 실제로는 둘째만).
- Expo(현재) `M:app/forgot-password.tsx`:
  - 단색 `bg-hanji` `:49`. 뒤로 `IconButton box={44}` `:52-59`. 제목 y 108. 입력 48.
  - 제출 `Button`(그라데이션·44·14px) — 전송 중 돌림표 + 원래 글자 `:88`.
  - 완료 상자 같은 클래스 `:66`, '로그인' `Button variant="secondary"`(44·2xl) `:70`.
  - 실패는 모두 `password.requestFailed`(CAPTCHA 분기 없음 — 앱은 CAPTCHA 안 씀).
- 차이: 바탕, 뒤로 버튼 2px, 제출 색(단색 vs 그라데이션)·크기, 전송 중 표시(글자 교체 vs 돌림표), 완료 '로그인' 모양.
- 중요도: P1
- 분류: 색·효과 / 크기·간격 / 상태(로딩)
- 고칠 방법:
  1. 바탕 `AuthBackdrop`(G1-21, 광원 없음).
  2. 뒤로 `IconButton box={42}`(hitSlop 이 44 를 채움).
  3. 제출 `Button size="lg" shape="xl" tone="gold" showSpinner={false} disabled={busy} label={busy ? t('common.loading') : t('password.requestSubmit')}`(G1-20).
  4. 완료 '로그인' `variant="secondary" shape="xl" className="min-h-[46px]"`.
  5. 입력 50(G1-24).
- 바꿀 Expo 파일: `M:app/forgot-password.tsx`, `M:features/auth/AuthBackdrop.tsx`
- 문구(i18n): 재사용 `common.loading` `password.requestSubmit` `login.tabLogin` / 새 키 없음
- 네이티브 주의: 단색 금 대비(G1-20 결정).
- 확인 방법: `node scratch/parity/work/G1/auth.mjs f` 재촬영.
- 크기: S · 의존: G1-20, G1-21, G1-24

### G1-27 재설정 화면의 Expo 전용 안내문(`app.auth.resetOpensOnWeb`) — 입력 아래 + 완료 상자 둘째 문단
- 화면·상태: G1-FPW-01, G1-FPW-04
- 스크린샷: shots/G1/FPW-01_default.pair.png, shots/G1/FPW-04_sent.pair.png
- 웹(기준): 안내문 없음(웹은 같은 브라우저에서 `/auth/reset-password` 로 끝난다).
- Expo(현재): 입력 아래 `ml-[4px] text-xs leading-[18px] text-muk-soft` `M:app/forgot-password.tsx:87`, 완료 상자 둘째 문단 `:68` — "메일의 링크는 웹 브라우저에서 열려요. 새 비밀번호는 웹에서 정한 뒤, 앱에서 그 비밀번호로 로그인해 주세요." 제출 버튼이 약 48px 아래로 밀린다.
- 차이: 추가 문구(두 곳).
- 중요도: P1
- 분류: 추가 / 문구
- 고칠 방법(결정 필요): 앱엔 재설정 화면이 없어(D13) 사실을 알리는 문장이다.
  - A 완료 상자에만 두고 입력 아래 문장은 지운다(첫 화면은 웹과 같게, 정보는 보낸 뒤에) — 권장.
  - B 둘 다 유지.
  - C 둘 다 삭제(사용자가 웹에서 끝나는 걸 모름 — 비권장).
- 바꿀 Expo 파일: `M:app/forgot-password.tsx`
- 문구(i18n): 재사용 `app.auth.resetOpensOnWeb` / 새 키 없음
- 네이티브 주의: 없음.
- 확인 방법: FPW-01 재촬영.
- 크기: S
- 표시: 결정 필요

### G1-28 재설정 빈 값 제출 — 웹은 브라우저 기본 말풍선, Expo 는 "이메일과 비밀번호를…" 토스트(문구가 틀림)
- 화면·상태: G1-FPW-02
- 스크린샷: shots/G1/FPW-02_empty-submit.pair.png
- 웹(기준): `input type=email required` `W:app/forgot-password/page.tsx:66` — 빈 값이면 제출이 막히고 입력칸 아래 브라우저 말풍선이 뜬다(실측 'Please fill out this field.' — 한국어 브라우저면 '이 입력란을 작성하세요.'). 입력칸 테두리 금색(포커스).
- Expo(현재): `toast.error(t('login.needFields'))` "이메일과 비밀번호를 입력해 주세요." `M:app/forgot-password.tsx:30-33` — 이 화면엔 비밀번호 칸이 없다. 토스트는 화면 아래.
- 차이: 표시 방식(입력칸 말풍선 vs 아래 토스트), 문구 오류.
- 중요도: P2
- 분류: 문구 / 상태
- 고칠 방법:
  1. 이메일 전용 문구 — 새 키 `app.auth.emailRequired`.
  2. 표시: 앱엔 브라우저 말풍선이 없으니 입력칸 아래 인라인 오류로 — `AuthTextField` 에 `error?: string` prop(입력칸 테두리 `border-gold` + 아래 `mt-[4px] ml-[4px] text-xs text-dan-red`) + `focus()`. 토스트를 유지해도 문구만 고치면 해소.
- 바꿀 Expo 파일: `M:app/forgot-password.tsx`, (인라인 오류) `M:features/auth/AuthTextField.tsx`
- 문구(i18n): 새 키 `app.auth.emailRequired` — ko "이메일을 입력해 주세요." / en "Enter your email." / ja "メールアドレスを入力してください。" / zh "请输入电子邮箱。"
- 네이티브 주의: 없음.
- 확인 방법: FPW-02 재촬영.
- 크기: S

---

## [CB] OAuth 콜백 — web `/auth/callback` ↔ Expo `/auth/callback`

### G1-29 콜백 화면 모양 — 스피너(40px 링 vs ActivityIndicator 36), 실패 버튼(단색 금 알약 16px vs 그라데이션 2xl 14px)
- 화면·상태: G1-CB-01, G1-CB-02
- 스크린샷: shots/G1/CB-01_spinner.pair.png, shots/G1/CB-02_generic-failure.pair.png, shots/G1/CB-02a_generic-failure_after-timeout.pair.png, 측정 shots/G1/CB-01.measure.json·CB-02.measure.json
- 웹(기준) `W:app/auth/callback/page.tsx:125-163`:
  - 가운데 정렬 `min-h-screen bg-hanji px-6 text-center`.
  - 처리 중: `w-10 h-10 rounded-full border-[3px] border-gold/25 border-t-gold animate-spin mb-4`(40px 링) + 14px muk-soft `:158-159`.
  - 실패: 제목 `text-lg font-serif font-bold mb-2`(18/28) `:130`, 설명 `text-sm text-muk-soft mb-6 max-w-xs break-keep`.
  - 주 버튼 알약 `px-6 py-3 rounded-full bg-gold text-white font-bold`(121×48, 16px, 단색 금) `:143`. '로그인' `mt-3 px-4 py-2 text-sm text-muk-soft underline`(36) `:150`. 둘 다 `animate-fade-in`.
- Expo(현재) `M:app/auth/callback.tsx:38-63`:
  - 처리 중 `ActivityIndicator size="large" color={colors.gold}`(36) + `mt-[16px]` `:59-60`.
  - 실패: 제목 18 bold, 설명 `mb-[24px] max-w-[320px]`, 주 버튼 `Button`(97×44, 14px, 그라데이션, rounded-2xl, 그림자) `:48`, '로그인' `min-h-[44px] px-[16px]` `:49-55`. 페이드 없음.
- 차이: 스피너 크기·모양, 주 버튼 모양·색·크기, 페이드.
- 중요도: P2
- 분류: 아이콘·이미지 / 크기·간격
- 고칠 방법:
  1. 스피너: `View h-[40px] w-[40px] rounded-full` + `style={{ borderWidth: 3, borderColor: 'rgba(193,154,62,0.25)', borderTopColor: colors.gold }}` 를 Reanimated 회전(1초 linear 반복, reduce motion 이면 정지). 아래 간격 `mb-[16px]`.
  2. 주 버튼 G1-20 `tone="gold" shape="full"` + `min-h-[48px] px-[24px]` + 글자 16.
  3. 페이드: Reanimated `entering={FadeIn}`(웹 `animate-fade-in` 지속 시간은 `W:app/globals.css` 값 확인 후 동일하게).
- 바꿀 Expo 파일: `M:app/auth/callback.tsx`
- 문구(i18n): 재사용 `auth.callbackLoading` `auth.callbackFailedTitle` `auth.callbackFailedDesc` `auth.callbackBackToMypage` `login.tabLogin` / 새 키 없음
- 네이티브 주의: 안드로이드 `ActivityIndicator` 는 머티리얼 원이라 웹 링과 더 다르다 → 커스텀 링 권장.
- 확인 방법: `node scratch/parity/work/G1/auth.mjs c` 재촬영.
- 크기: S · 의존: G1-20

### G1-30 콜백 분기 — 웹의 재설정 링크 실패·'이미 연결된 계정'(쿼리)·자동 재시도, 대기 시간
- 화면·상태: G1-CB-01(지속 시간), G1-CB-03, G1-CB-05, G1-CB-06
- 스크린샷: shots/G1/CB-03_already-linked.pair.png, shots/G1/CB-05_recovery-failure.pair.png
- 웹(기준): 쿼리를 읽는다 `W:app/auth/callback/page.tsx:35-64,126-154`.
  - `?error…&error_code=identity_already_exists&retry=1` → "이미 연결된 계정이에요"(retry 없으면 같은 공급자로 자동 재로그인).
  - `?next=/auth/reset-password` 실패 → 제목 "비밀번호 재설정" + `password.invalidLink` + '재설정 링크 보내기'(→ `/forgot-password`).
  - 처리 중 최대 8.1초(300ms×27 폴링).
- Expo(현재): URL 쿼리를 읽지 않는다 `M:app/auth/callback.tsx:4-9`.
  - 받은편지함·진행 기록(`nextspot_oauth_pending`)으로 판단 — 기록이 없으면 즉시 일반 실패, 있으면 최대 1.5초.
  - 재설정 분기 없음(앱에 재설정 화면 없음, D13).
  - '이미 연결됨'은 딥링크 오류 코드로만 `M:features/auth/callbackDecision.ts:42-48`.
- 차이: 실패 화면 종류·문구·버튼, 대기 시간.
- 중요도: P2
- 분류: 동작 / 상태
- 고칠 방법(결정 필요): 앱 OAuth 는 딥링크 수신 구조라 웹 쿼리 방식과 같을 필요가 없다. 권장 — 유지(재설정 메일 링크는 웹에서 끝남, G1-27 안내와 일관). '이미 연결된 계정' 화면은 딥링크에 `error_code` 가 올 때 그린다 — 안드로이드 실기기 확인.
- 바꿀 Expo 파일: 없음(유지 시)
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 `+native-intent` 로 들어온 오류 딥링크로 already_linked 화면 확인 필요.
- 확인 방법: 안드로이드 수동.
- 크기: —
- 표시: 결정 필요, 네이티브 확인 필요

---

## [GATE] 첫 실행 게이트 · 셸 · 에러/404

게이트 흐름 자체는 G1-01 에서 다룬다. GATE-02 덮개 패널은 너무 짧아 촬영하지 못했다 — 코드상 한지색 전체 덮개이고, 웹 대응은 없다.

### G1-31 404 화면 — Expo 는 화면 맨 위에 붙은 카드 하나(레이아웃 버그), 웹의 마스코트·큰 404·보조 링크·브랜드 줄·광원 없음
- 화면·상태: G1-GATE-05, (Expo) G1-GDE-03
- 스크린샷: shots/G1/GATE-05_404.pair.png, shots/G1/GDE-03_guide-page_top.pair.png, 측정 shots/G1/GATE-05_404.measure.json
- 웹(기준) `W:app/not-found.tsx:23-63`:
  - `main relative min-h-screen bg-hanji px-6 py-16`(위 64).
  - 광원 2개(`bg-sunset-1/10` 왼쪽 위, `bg-gold/10` 오른쪽 아래, 520px `blur-[120px]`) `:25-26`.
  - 가운데 열(max-w-md), 위→아래:
    1. 마스코트 아바타 96px(원형, `border-gold/35`, 이미지 `scale-[1.48]` `object-[50%_22%]`) `mb-6` `:29`.
    2. "404" `font-serif text-[64px] font-black leading-none tracking-tight text-gold-deep/85 tabular-nums` `:32`.
    3. 제목 `mt-4 text-[22px] font-black leading-snug tracking-tight`(22/30.25, y 264) `:36-38`.
    4. 본문 `mt-2 text-[14px] leading-relaxed text-muk-soft` `:39-41`.
    5. 주 알약 `mt-8 min-h-12 rounded-full bg-gradient-to-r from-gold to-terracotta px-7 text-[15px] font-bold text-white shadow-[0_4px_14px_rgba(193,85,59,0.25)]` + `MapPin 18` "지도로 돌아가기" → `/main` `:44-50`(165×48).
    6. 보조 알약 `mt-3 min-h-11 rounded-full border border-line bg-white/90 px-5 text-[13px] font-bold` + `Compass 16 gold-deep` "분산 코스 보기" → `/course` `:53-59`.
    7. 브랜드 줄 `mt-10 text-[11px] text-muk-soft/80` `:61-63`.
- Expo(현재) `M:app/+not-found.tsx:12-17`:
  - `Screen className="flex-1 justify-center bg-hanji"` — `justify-center` 가 바깥 View 에만 걸리고, 안쪽 내용 View(`flex-1 px-[16px]`, `M:components/ui/Screen.tsx:68-73`)는 위에서 시작한다.
  - 결과: `EmptyState` 카드(흰 바탕·line 테두리·padding 28·그림자 card)가 **화면 맨 위 y=0 에 붙는다**.
  - 제목 15px bold, 설명 13px, 보조 버튼 '지도로 돌아가기'(흰 2xl 112×44) → `router.replace('/')`.
- 차이: 배치 깨짐(맨 위에 붙음), 요소 누락(마스코트·404·보조 링크·브랜드 줄·광원), 글자 크기(22 vs 15, 14 vs 13), CTA(그라데이션 알약+아이콘 vs 흰 버튼).
- 중요도: P0
- 분류: 배치 / 누락
- 고칠 방법: `+not-found.tsx` 를 웹 구조로 다시 쓴다.
  - 틀: `Screen contentClassName="flex-1 items-center px-[24px] pt-[64px] pb-[64px]"` + 광원 2개(react-native-svg 반경 그라데이션, absolute).
  - 위→아래:
    1. `NextSpotMascot variant="avatar"`(G1-02 공용 컴포넌트) — 96×96 원형 `borderWidth:1 borderColor:'rgba(193,154,62,0.35)'`, 이미지 `contentPosition={{ top: '22%' }}` + `transform:[{ scale: 1.48 }]`, `mb-[24px]`.
    2. Text "404" `text-[64px] leading-[64px]` weight black `style={{ color: 'rgba(112,88,25,0.85)', letterSpacing: -1.6, fontVariant: ['tabular-nums'] }}`.
    3. 제목 `mt-[16px] text-center text-[22px] leading-[30.25px]` black `letterSpacing:-0.55`.
    4. 본문 `mt-[8px] text-center text-[14px] leading-[22.75px] text-muk-soft`.
    5. 주 알약 `Pressable mt-[32px] min-h-[48px] flex-row items-center gap-[8px] overflow-hidden rounded-full px-[28px]` + `Gradient name="goldTerracotta"`(토큰 있음 `M:lib/theme/tokens.ts:94`) + `boxShadow:'0px 4px 14px rgba(193,85,59,0.25)'` + `Icon MapPin 18 white` + Text 15 bold white → `router.replace('/')`.
    6. 보조 알약 `mt-[12px] min-h-[44px] flex-row items-center gap-[6px] rounded-full border border-line px-[20px]` + `style={{ backgroundColor: 'rgba(255,255,255,0.9)', boxShadow: '0px 2px 10px rgba(43,35,32,0.06)' }}` + `Icon Compass 16 gold-deep` + Text 13 bold → `router.replace('/course')`.
    7. 브랜드 줄 `mt-[40px] text-[11px] leading-[17.9px]` `style={{ color: 'rgba(107,93,79,0.8)' }}`.
- 바꿀 Expo 파일: `M:app/+not-found.tsx`, `M:components/NextSpotMascot.tsx`(G1-02 와 공유)
- 문구(i18n): 재사용 `notFound.title` `notFound.body` `notFound.backToMap` `notFound.exploreCourse` `notFound.brandLine` / 새 키 없음
- 네이티브 주의: 첫 실행이 안 끝났으면 게이트가 404 대신 `/intro` 로 보낸다(웹과 다름 — G1-01).
- 확인 방법: `node scratch/parity/work/G1/cns_set.mjs g` 의 GATE-05_404 재촬영.
- 크기: M · 의존: G1-02(마스코트 자산)

### G1-32 렌더 오류 화면 — 웹 `error.tsx`(금빛 원 경고 아이콘·영어 줄·금 버튼) vs Expo `ErrorState` 카드(⚠️ 이모지)
- 화면·상태: G1-GATE-06
- 스크린샷: 없음(촬영 못 함 — 렌더 오류를 안전하게 일으킬 수단이 없어 코드로 비교)
- 웹(기준) `W:app/error.tsx:29-44`:
  - 가운데 정렬 bg-hanji px-6.
  - 원 64px `rounded-full bg-gold/15 border border-gold` 안 `AlertTriangle 28 text-gold-deep`, `mb-6` `:30`.
  - `h1 text-xl font-bold mb-2` "문제가 발생했어요" `:33` → "Something went wrong." 14px muk-soft mb-1 `:34` → "잠시 후 다시 시도해 주세요." 14px mb-8 `:35`.
  - 버튼 `inline-flex gap-2 px-6 py-3 rounded-xl bg-gold text-white font-bold` + `RotateCcw 16 strokeWidth 2.5` "다시 시도".
  - 문구는 하드코딩(i18n 안 씀 — 제공자 트리가 무너졌을 수 있어서).
- Expo(현재) `M:components/AppErrorBoundary.tsx:15-39` → `ErrorState` `M:components/ui/ErrorState.tsx:30-69`:
  - 흰 Card(테두리 terracotta 25%, padding 32) 안 ⚠️ 30px 이모지, `common.error` 14px semibold.
  - 알약 `bg-gold-deep min-h-[44px] px-[18px]` + `RotateCw 14` + 13px bold `common.retry`.
  - 둘째·셋째 줄 없음.
- 차이: 카드 vs 맨 화면, 아이콘(원+AlertTriangle vs 이모지), 문구 2줄 누락, 버튼 모양·색(금 xl vs 금 진 알약)·글자 크기.
- 중요도: P2
- 분류: 아이콘·이미지 / 문구
- 고칠 방법: `AppErrorBoundary` 를 `ErrorState` 대신 웹 구조로 그린다.
  - `View flex-1 items-center justify-center bg-hanji px-[24px]`.
  - 원 `h-[64px] w-[64px] items-center justify-center rounded-full border border-gold` + `style={{ backgroundColor: 'rgba(193,154,62,0.15)' }}` + `Icon AlertTriangle size={28} color="gold-deep"`, `mb-[24px]`.
  - Text `text-xl` bold `common.error` `mb-[8px]` → 둘째·셋째 줄.
  - 버튼 `Pressable flex-row items-center gap-[8px] rounded-xl bg-gold px-[24px] py-[12px]` + `Icon RotateCcw size={16} strokeWidth={2.5} color="white"` + Text 16 bold white `common.retry`.
  - 둘째·셋째 줄 문구(결정 필요): A 웹처럼 하드코딩(한국어 + 영어 줄) · B 새 키 `app.error.retryHint` 로 셋째 줄을 번역하고 영어 줄은 ko 에서만 — 권장 B.
- 바꿀 Expo 파일: `M:components/AppErrorBoundary.tsx`
- 문구(i18n): 재사용 `common.error` `common.retry` / 새 키(B) `app.error.retryHint` — ko "잠시 후 다시 시도해 주세요." / en "Please try again in a moment." / ja "しばらくしてからもう一度お試しください。" / zh "请稍后再试。"
- 네이티브 주의: 루트가 죽으면 글꼴·제공자가 없다 — 지금처럼 훅 없이 `createTranslator` 유지. 아이콘은 lucide(react-native-svg)라 그려진다.
- 확인 방법: 개발 빌드에서 임시 `throw` 로 확인(하네스로는 불가).
- 크기: S
- 표시: 촬영 못 함, 결정 필요(문구)

### G1-33 PWA 설치 배너 — 웹 재방문자에게만, Expo 없음(설치된 앱)
- 화면·상태: G1-GATE-03
- 스크린샷: shots/G1/GATE-03_web-install-banner.pair.png(`nextspot_visit_count` 시드 + `beforeinstallprompt` 강제)
- 웹(기준) `W:components/shell/InstallPrompt.tsx`:
  - 방문 2회 이상 + 스누즈 없음 + `beforeinstallprompt` 때 아래쪽 카드(흰 95% 유리, `rounded-3xl`, N 아이콘, "홈 화면에 추가하고 더 빠르게", '나중에'·'설치').
  - 실측: 랜딩에는 탭 막대가 없는데 `bottom-[calc(var(--tourist-nav-clearance)+8px…)]` 로 떠서 **'바로 시작' 버튼을 반쯤 가린다**(웹 쪽 버그로 보임).
- Expo(현재): 없음(설계상 미이식, D15).
- 차이: 누락(앱에는 의미 없음).
- 중요도: P2
- 분류: 누락
- 고칠 방법(결정 필요): 권장 — 이식하지 않음. 웹 쪽은 랜딩 `/` 에서 배너를 띄우지 않거나 `--tourist-nav-clearance` 를 0 으로 해야 한다(이 비교 범위 밖, 기록만).
- 바꿀 Expo 파일: 없음
- 문구(i18n): 없음
- 네이티브 주의: —
- 확인 방법: —
- 크기: —
- 표시: 결정 필요

### G1-34 선택·체크 상태가 Expo web 접근성 트리에 안 나온다(`accessibilityState` → aria 미변환)
- 화면·상태: G1-SET-02(칩·토글), G1-CNS-02(체크), G1-LGN-02(탭)
- 스크린샷: shots/G1/SET-02_selected_top.pair.png(겉모습은 같음). 근거: `shots/G1/_run-cns-set.measure.json` 의 `a11y`·`a11ySel`·`c.afterBoth`, `shots/G1/_run-auth.measure.json` 의 `tabsA11y`.
- 웹(기준): 설정 칩·토글 `button aria-pressed=true/false` `W:app/setup/page.tsx:152,166` — 실측 선택한 7개 모두 `aria-pressed="true"`. (로그인 탭은 웹도 상태 속성이 없다 — 웹 개선 여지.)
- Expo(현재):
  - 상태를 `accessibilityState` 로 준다 — 칩 `{{ selected }}`(`M:app/setup.tsx:238`, 공용 `M:components/ui/Chip.tsx:32`), 토글·체크 `{{ checked }}`(`M:app/setup.tsx:259`, `M:features/onboarding/LocationConsentView.tsx:80`), 로그인 탭 `{{ selected }}`(`M:app/login.tsx:166`).
  - react-native-web 0.21.4 는 `accessibilityState` 를 DOM 으로 옮기지 않는다. `aria-checked`·`accessibilityChecked` 같은 납작한 prop 만 받는다(`node_modules/react-native-web/dist/modules/createDOMProps/index.js:168-170`).
  - 실측: `aria-selected`·`aria-checked` 가 선택 뒤에도 모두 null. (`disabled` prop 은 `aria-disabled` 로 나온다.)
  - 인벤토리 G1-SET-01 의 'RNW aria-selected' 가정은 틀렸다.
- 차이: 화면 읽기 프로그램이 선택·체크 상태를 못 읽음(Expo web).
- 중요도: P2
- 분류: 접근성
- 고칠 방법:
  - 상태를 RN 0.71+ 의 `aria-*` prop 으로 함께 준다(네이티브도 같은 뜻으로 받는다) — 칩 `aria-selected={active}`, 토글·체크 `aria-checked={active}`, 탭 `aria-selected={mode === m}`.
  - 한 곳에서 처리하려면 `M:components/ui/Pressable.tsx` 에서 받은 `accessibilityState` 를 `aria-selected`/`aria-checked`/`aria-disabled`/`aria-busy` 로 펼쳐 넘긴다(공용 `Chip` 은 G2 소유 — 같이 반영).
  - 웹의 `aria-pressed` 와 꼭 같게 하려면 Expo web 에서만 `{...(Platform.OS === 'web' ? { 'aria-pressed': active } : {})}`.
- 바꿀 Expo 파일: `M:components/ui/Pressable.tsx`(일괄) 또는 `M:app/setup.tsx`, `M:features/onboarding/LocationConsentView.tsx`, `M:app/login.tsx`, `M:components/ui/Chip.tsx`
- 문구(i18n): 없음
- 네이티브 주의: 안드로이드 TalkBack 은 `accessibilityState` 를 이미 읽는다 — 네이티브는 문제없을 가능성이 높다(확인 필요). Expo web 빌드 전용 문제.
- 확인 방법: `node scratch/parity/work/G1/cns_set.mjs s` → `_run-cns-set.measure.json` 의 `s.a11ySel.expo` 가 선택 7개를 돌려줘야 한다.
- 크기: S
- 표시: 네이티브 확인 필요

---

## 촬영 못 한 상태

- G1-SET-03 '저장 중...' — 저장이 동기라 누른 직후 60ms 에 이미 홈(양쪽). 코드 비교(G1-19·G1-17).
- G1-LGN-07 로그인·가입 성공 뒤 이동 — 하네스가 sign-in/sign-up 을 막는다. 성공 응답 모의는 공유 세션을 깨뜨릴 수 있어 하지 않았다. 코드 비교(G1-25).
- G1-LGN-08 소셜 버튼 누름 — OAuth authorize 이동이 차단됨. 웹 버튼 모양만 비교(G1-23), 안드로이드 미확인.
- G1-CB-04 콜백 성공(게스트 병합) — code 교환이 필요해 재현 불가. G1-CB-06 중복 방지 — 코드만.
- G1-GATE-02 게이트 덮개 — 수 ms.
- G1-GATE-04 점검 화면 — G2 소관.
- G1-GATE-06 렌더 오류 화면 — 안전한 유발 수단 없음(G1-32 코드 비교).
- G1-GDE-04 바로가기 줄 이동 — Expo 에 대응 없음(G1-09). 웹 이동 결과는 G2 홈 화면이라 찍지 않았다.
- 참고: G1-CNS-03 약관 모달의 slide 애니메이션은 정지 컷만(웹 빌드 RN Modal = 전체화면 `role=dialog`).

## 열린 질문

1. 첫 실행 흐름(G1-01)과 위치정보 동의(G1-14)를 어떻게 할지 — 둘이 같이 정해져야 G1-02·G1-03·G1-15 의 범위가 정해진다.
2. 웹의 공모전 전용 요소(심사 계정 안내 G1-22, 계획 절 G1-12, 콘솔 링크 G1-07)를 정리할지, Expo 에 이식할지 — '웹이 기준' 원칙과 '대회 종료' 메모가 충돌한다.
3. 단색 금 버튼(웹 재설정·콜백) 대비 3.7:1 — 웹도 바꿀지(G1-20).
4. 안드로이드 실기기 확인 필요: 소셜 버튼(G1-23), `accessibilityState` 낭독(G1-34), 밑줄 색(G1-18), 콜백 오류 딥링크(G1-30), 한국어 낱말 줄바꿈(U+2060).
5. 하네스 메모: EAS 호스트가 글꼴 TTF 에 429 를 주면 Expo 컷이 serif 로 찍힌다. 재촬영 전 `work/G1/lib.mjs` 의 `ensureExpoFonts()` 로 확인한다. 다만 지금은 '안 쓰는 굵기'도 미로드로 잡으니, status `error` 만 실패로 보는 게 정확하다.

## 다른 묶음 소관 — 눈에 띈 전역 이슈(한 줄씩)

- **G2(글자):** Expo web 은 한국어 `keep-all` 이 없어 음절 단위로 끊긴다.
  - 예: 설정 설명 "…맞춰 보여드려 / 요."(SET-01), 동의 리드 "위치기반서비 / 스를"(CNS-01), FAQ 답 "미 / 리 보여"(GDE-01_s5).
  - `M:components/ui/Text.tsx:56` 은 iOS·안드로이드만 처리한다. 웹은 `style={{ wordBreak: 'keep-all', overflowWrap: 'break-word' }}` 필요.
  - `M:components/ui/index.ts` 주석의 '줄바꿈은 Text 가 기본으로 한다'는 웹 빌드에선 사실이 아니다.
- **G2(글꼴):** Expo 글꼴 패밀리가 `'Freesentation-7Bold'` 하나뿐이라 TTF 로드 실패 시 브라우저 기본 serif 로 그려진다. 웹은 `'Apple SD Gothic Neo','Malgun Gothic',system-ui` 폴백이 있다(`W:app/globals.css:122`). 웹 빌드에서 폴백 스택 추가 권장.
- **G2(하단 탭):** 웹 탭 막대 윗줄의 '서비스 소개 · 사장님 콘솔 · 관제 대시보드' 줄이 Expo 에 없다 — G1-08 모달 진입점과 같은 일.
- **G3(토스트):**
  - 웹 sonner 토스트는 Freesentation 이 아닌 시스템 글꼴·넓은 자간·검은 원 아이콘(!/✓)·2줄 줄바꿈이다. Expo sonner-native 는 Freesentation bold·빨간 X/녹색 체크 외곽선이다(LGN-03·LGN-06c·FPW-02).
  - Expo 토스트 위치가 탭 막대(56+8) 기준이라, 탭 없는 화면(/login·/setup·/forgot-password)에서 바닥에서 약 72px 위에 뜨고 /setup 에서는 고정 하단 바를 덮는다(CNS-05).
- **G5(마이):** 마이 '선호를 설정하면…' CTA → `/setup` 은 두 앱 모두 있다. 다만 웹 `/setup` 의 뒤로 버튼은 마이에서 와도 랜딩(`/`)으로 간다(G1-15 — 웹 쪽 이상 동작일 수 있음).
