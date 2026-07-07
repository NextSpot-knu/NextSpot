# apps/web — NextSpot 웹 (Next.js)

관광객용 앱(`app/main`, `app/explore`, `app/saved`, `app/mypage`, `app/setup`)과
경북문화관광공사 B2G 관제 대시보드(`app/admin/*`)를 포함하는 Next.js 앱.

- **빌드:** `next build` — `next.config.ts`의 `output: 'export'` 정적 export. 서버 액션/route handler 사용 금지.
- **데이터 접근:** 읽기는 `lib/supabase.ts`(anon 키, RLS 적용), 백엔드 호출은 `lib/api-client.ts`(FastAPI `/api/v1/*`).
  service_role 키는 절대 클라이언트에 두지 않는다. 관리자 쓰기는 FastAPI 관리자 엔드포인트 경유.
- **지도:** Kakao Maps JS SDK. 키는 `NEXT_PUBLIC_KAKAO_*` 환경변수로만 주입(하드코딩 금지).
- **SPOT 점수:** 산정은 백엔드(`apps/api/app/services/spot/`)가 단일 소스. 클라이언트에서 재구현하지 말 것
  (`lib/recommender.ts`는 드리프트 이력이 있어 단계적 제거 대상 — docs/IMPROVEMENT_PLAN.md WS-D 참조).
- **음성비서:** 공용 훅 `lib/useVoiceAssistant.ts` + `components/VoiceAssistantOrb.tsx`를 사용. 페이지 인라인 재구현 금지.
- 루트 가이드는 [`../../AGENTS.md`](../../AGENTS.md), 피벗 백로그는 `docs/NEXTSPOT_PIVOT.md` 참조.
