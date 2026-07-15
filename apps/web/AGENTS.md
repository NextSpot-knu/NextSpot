# apps/web — NextSpot 웹 (Next.js)

관광객용 앱(`app/main`, `app/explore`, `app/saved`, `app/mypage`, `app/setup`),
경북문화관광공사 B2G 관제 대시보드(`app/admin/*`), 사장님 콘솔(`app/merchant/*`)을 포함하는 Next.js 앱.

- **빌드:** `next build` — `next.config.ts`의 `output: 'export'` 정적 export. 서버 액션/route handler 사용 금지.
- **검증:** `npm run lint` · `npm run typecheck`(tsc --noEmit, `**/*.test.ts` 제외) · `npm run test`(tsx로
  `lib/voiceIntent.test.ts` 실행 — jest/vitest 없음) · `npm run build`. 네 개 모두 CI web job과 동일.
- **데이터 접근:** 읽기는 `lib/supabase.ts`(anon 키, RLS 적용), 백엔드 호출은 `lib/api-client.ts`(FastAPI `/api/v1/*`).
  service_role 키는 절대 클라이언트에 두지 않는다. 관리자 쓰기는 FastAPI 관리자 엔드포인트 경유.
- **api-client 규약:** camelCase↔snake_case 재귀 자동 변환 — 호출부는 camelCase만 사용.
  401은 `isAuthError()`로 서버 장애와 구분해 안내 UI로 처리(무한 재시도 금지).
  `lib/supabase.ts`는 전 요청 6초 타임아웃 후 데모 폴백 — "데이터가 안 나오는" 증상은 이것부터 의심.
- **i18n:** next-intl 아님 — 자체 `lib/i18n/I18nProvider.tsx`. 언어 4종(ko/en/ja/zh), 문자열은
  `lib/i18n/messages/{ko,en,ja,zh}.json`의 중첩 키. 사용은 `const t = useT(); t('key', {var})`.
  **키 추가 시 4개 JSON 동시 반영**(패리티 0 missing 유지). 비-ko 첫 렌더에 한국어가 잠깐 보이는 것은
  정적 export의 의도된 트레이드오프 — 하이드레이션 버그로 오인해 "고치지" 말 것.
- **스타일:** Tailwind CSS v4 CSS-first — 토큰은 `app/globals.css`의 `@theme inline` 단일 정의점
  (관광객=한지 라이트 `bg-hanji/text-muk`, 관리자=한옥 웜다크 `bg-hanok*`, 강조=단청 계열).
  인라인 hex 대신 토큰 클래스 사용. shadcn/ui 없음. 토스트는 `app/layout.tsx`의 전역 Toaster(sonner) 1개만.
- **상태:** 외부 스토어 없음 — React 로컬 state + 컨텍스트. 영속은 localStorage `nextspot_*` 키 패턴.
- **모바일:** viewport `viewportFit: 'cover'` — 하단 고정 요소는
  `pb-[calc(...+env(safe-area-inset-bottom))]` 패턴(기존 사례: `components/BottomNav.tsx`).
- **타입:** 신규 코드 `any` 금지 — eslint의 warn 강등은 기존 부채(WS-D) 때문이며 error 복원 예정.
- **지도:** Kakao Maps JS SDK. 키는 `NEXT_PUBLIC_KAKAO_*` 환경변수로만 주입(하드코딩 금지).
- **SPOT 점수:** 산정은 백엔드(`apps/api/app/services/spot/`)가 단일 소스. 클라이언트에서 재구현하지 말 것.
  `lib/recommender.ts`는 데모/폴백용 미러로 아직 실사용 중 — 가중치는 `shared-types`의 SPOT_WEIGHTS만 참조,
  하드코딩 금지(단계적 제거 대상, docs/IMPROVEMENT_PLAN.md WS-D 참조).
- **음성비서:** 공용 훅 `lib/useVoiceAssistant.ts` + `components/VoiceAssistantOrb.tsx`를 사용. 페이지 인라인 재구현 금지.
- 루트 가이드는 [`../../AGENTS.md`](../../AGENTS.md), 피벗 백로그는 `docs/NEXTSPOT_PIVOT.md` 참조.
