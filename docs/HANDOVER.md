# HANDOVER — 현재 상태 (정본)

> "지금 어디까지 왔고 무엇이 남았나"만 담는다. 2026-08-28까지의 세션 기록(§-45 → §6, 음수 번호가 최신)은
> [`archive/HANDOVER_LOG.md`](./archive/HANDOVER_LOG.md)에 그대로 있다. 이 문서는 400줄을 넘기지 않는다 —
> 넘치면 "최근 세션"의 가장 오래된 항목을 로그 파일 맨 위로 옮긴다(`scripts/check-docs.mjs`가 강제).

## 배포 상태

- **2026-11-01 01:4x KST main `168f979..0747801`(사용자 "병합해" — `yunseong` fast-forward 25커밋, API·웹·스키마·문서. `0747801` CI 4잡 green · e2e 534).** Render 수동 배포 · 마이그레이션 적용 · Vercel·`/health` 확인은 사람 작업(아래 10-31c ①~⑧). 되돌림 = main 을 `168f979` 로(API·웹 함께). 10-31b·c 작업(영업시간·관제·사장님 + 서울 S1·S2·S5·S6 + 게스트 답 그림자 모드). 순서는 **API(Render Manual Deploy) 먼저 → 웹 바로 뒤**, 마이그레이션 `20261031120000`·`20261031130000` 은 **API 배포 직후 적용**(그 전에도 깨지지는 않는다 — `130000` 전에는 API 가 옛 RPC 로 돌아가고, 그때 게스트 답은 평가만 남긴다 — 닫힌 쪽 폴백). API 배포 전에 Render `SEOUL_CITYDATA_TARGETS` 정리·종로 4곳 이름 확인(아래 "사람 작업 대기"). `feature/donggi`(3커밋, 10-30)는 LanguageSwitcher·NowChip·ShareButton 만 건드려 `git merge-tree` 로 겹침 없이 합쳐진다. **이번 밤 범위는 `0747801` 까지다** — S3(`cc6b299..d22aeef`, 아래 2026-11-01)는 사람 작업 11-01 ①~⑥ 준비가 된 뒤 따로 올린다(`git push origin <sha>:main` 으로 범위를 정한다).
- **2026-10-24 KST main 갱신 예정(웹·스키마·API 테스트·문서 — `feat/merchant-wait-1024` 뒤 `feat/merchant-photos-1024`).** 사장님 가게 사진(아래 2026-10-24). 마이그레이션 `20261024090000` 은 PR CI 초록 뒤 Supabase MCP 로 적용. API 코드 무변경 — Render 배포 불필요.
- **2026-10-24 KST main `9cf767c..49c2067`(PR #22, 웹·스키마·문서) + 표 적용.** 익명 이용 분석 `public.usage_events`(아래 2026-10-23). CI 4잡 green · Vercel 프로덕션 반영. 표는 10-24 Supabase MCP(`apply_migration`, PM 지시)로 적용 + `NOTIFY pgrst` — 확인: RLS on · anon INSERT 201 · anon SELECT 거부(42501) · 목록 밖 이벤트 400 · 보관 예약 `23 18 * * *`(cron 4→5개), 검증 행은 지움. API 무변경.
- **2026-10-22 KST main 갱신 예정(e2e·문서 — `test/night-e2e-1022`, PR #21).** 밤 23시 이후에만 깨지던 e2e 두 원인(PR #13 에서 테스트 수정만 분리 — `4a37ab4`·`c678db4`). 웹·API 무변경.
- **2026-10-22 23:53 KST API 반영 `a9ecd92`(PR #20, main `9bd5584..a9ecd92` 22:39 KST 푸시).** LLM 전체 스위치 `LLM_ENABLED` 기본 꺼짐 → Upstage 호출 0(아래 2026-10-22b). **Render 가 자동 배포하지 않아** PM 이 Manual Deploy — 싱가포르 `/health` `deploy.commit=a9ecd921cb02` · healthy · 스냅샷 ready · 1,747곳. main CI 는 e2e 잡이 두 번 실패(Playwright 설치 8분 초과 · 23시 이후 e2e — PR #21). 되돌림 = Render env `LLM_ENABLED=true`(재시작) 또는 이 커밋 revert.
- **2026-10-22 21:43 KST main `b6d428e..e2a1b0e`(PR #19 fast-forward, PM "push" — 웹·e2e·문서만).** main e2e 빨간불(10-19~) 정리 · 관제 데모 튕김 수정 · 휴대폰 미리보기 한 줄 줄임(아래 2026-10-22). PR CI · main CI(run 39780712139) 4잡 green — e2e 518 통과 · 실패 0 · flaky 0(10-11 뒤 첫 초록). Vercel 프로덕션 `dpl_6obwmrWUvtonWSGH2GZACmM2hqif` READY, 싱가포르 `/health` healthy · `deploy.commit=f80454c07ba1` 그대로(재시작 없음). 되돌림 = Vercel `dpl_95jwYS6iC13PbgftCzFsDQf4myiL`(`b6d428e`).
- **2026-10-21 KST main 갱신 예정(웹·문서만).** 탭 이동 때 동일한 테마 속성을 반복 기록하던 동작을 제거했다. Vercel 배포·사용자 환경의 글꼴 깜빡임 확인은 푸시 뒤 대기. API·스키마 무변경.
- **2026-10-21 KST main `7dba684..`(이번 기록 커밋).** 추천 카드 상세를 대표메뉴 → 운영시간·휴무일 → 소개 → 주소·전화번호 순서로 배치하고, 서울 검증 테이블의 `service_role` GRANT를 마이그레이션에 명시했다. Vercel 배포·라이브 확인은 푸시 뒤 확인 대기. SQL은 원격 DB에 적용하지 않았다.
- **2026-10-21 KST main 갱신 예정(이 기록 커밋, 웹·문서만).** 추천 메뉴 이름의 말줄임을 풀어 전체 폭에서 줄바꿈하고, '일단 킵하고' 뒤 버튼 문구를 줄바꿈. Vercel 배포·라이브 확인은 푸시 뒤 확인 대기. API·스키마 무변경. 되돌림 = 이 기록 커밋 revert.
- **2026-10-21 KST main `24de2ab`(웹·문서만).** '바로 갈래요' 버튼에 도보 길안내 문구를 화면에도 명시. Vercel 배포·라이브 확인은 확인 대기. API·스키마 무변경. 되돌림 = `24de2ab` revert.
- **2026-10-21 KST main `2f1d119`(웹·문서만).** 추천 카드의 세 버튼 문구를 선택 의도가 드러나게 바꾸고 휴대폰 미리보기에 출발·도착 시각을 바로 표시. Vercel 배포·라이브 확인은 확인 대기. API·스키마 무변경. 되돌림 = `2f1d119` revert.
- **2026-10-21 KST main `4ae4274`(웹·문서만).** 음식점 추천 첫 문장에 메뉴·도보 시간·확인된 대기 예상 시간을 표시하고 모바일 미리보기에 다음 후보 버튼 추가. Vercel 배포·라이브 확인은 확인 대기. API·스키마 무변경. 되돌림 = `4ae4274` revert.
- **2026-10-21 KST main `8d4b56b..`(이 기록 커밋, 웹·문서만).** 추천 카드의 메뉴 표시 대비 강화. Vercel 배포·라이브 확인은 푸시 뒤 확인 대기. API·스키마 무변경. 되돌림 = 이 기록 커밋 revert.
- **2026-10-21 KST main `ee5bf19..`(이 기록 커밋, 웹 CSS·문서만).** 1366×650 추천 카드 상세 펼치기 첫 화면 노출 수정. Vercel 프로덕션 배포·라이브 화면 확인은 푸시 뒤 확인 대기. API·스키마 무변경, Render 재시작 없음. 되돌림 = 이 기록 커밋 revert.
- **2026-10-19 낮 KST main `f80454c..20a42fe`(PM "푸시해" · "그냥 바로 올려" — 웹·문서만: `/main` 지도 위 탐색 층 유리 라이트 35% · 야간 40% · 날씨 알약 유리, 아래 2026-10-19).** PR #18 의 web·api·schema·docs 4잡과 Vercel 미리보기 통과(e2e 는 푸시 시점에 진행 중 — 푸시는 PM 지시로 먼저), 로컬은 마지막 값 조정 뒤 web lint·typecheck·test·build·check-docs·e2e `map-time-strip` 통과. Vercel 프로덕션 배포 완료·라이브 CSS 에 35%/40% 확인, API `/health` `deploy.commit=f80454c07ba1` 그대로(재시작 없음). 되돌림 = Vercel `dpl_2D3C72kz7f2dC42CUE85CZ3DiYZr`(10-12 웹 그대로).
- **API 싱가포르 이전(2026-10-09 KST 21시, PM).** 새 Render 서비스 `nextspot-t2ib`(srv-db4dg1d9fdbs73bk7lo0, Singapore, `0.5c-512mb`, Dockerfile `./apps/api/Dockerfile` · 컨텍스트 `./apps/api` — 대시보드 수동 생성이라 Blueprint 밖) → https://nextspot-t2ib.onrender.com. Vercel `NEXT_PUBLIC_FASTAPI_URL`(Config 형식) 교체 뒤 프로덕션 재배포 `dpl_6st1eMPc85jHbBCukXnyNmiU3PFr`(같은 `05af862`) — 번들에 새 주소 3·오리건 0, 라이브 /main·/waiting·/course 정상·API 실패·CORS 오류 0(10-09 클라우드 세션 확인). 같은 게스트로 by-type 첫 호출 서버 시간 오리건 ≈2.9초 → 싱가포르 ≈0.75초(표본 1). Actions 변수 `BACKEND_HEALTH_URL` 교체 끝. Vault 수집 URL 2개(`configure_*_collection`) 교체 · Render Build Filters 설정도 PM 이 끝냈다(10-09). **남은 것**: `render.yaml`(Blueprint 는 아직 오리건 서비스를 관리) 정리. 오리건 `nextspot-api` 는 2026-10-22 PM 이 정지했고(503), 정지 뒤에도 10분 수집 버킷이 들어와 pg_cron 이 싱가포르로 가는 것을 확인했다(아래 2026-10-22). 되돌림 = Vercel `dpl_BQEyd1sREmLTUDpYWtRwZZmo3ij4`.
- **main = 프로덕션.** main push가 Vercel(web)·Render(api)를 자동 배포한다. **2026-10-12 23:4x KST main `3a61300..dd16c03` + 이 기록 커밋(PM "해결해" — API: `/health` 에 `deploy.commit`·`deploy.service` · 수동 `deploy-verify.yml` · 문서, 아래 2026-10-12) — api ruff · pytest 2479 · check-docs 재실행 통과(푸시 직전). 싱가포르 `/health` 의 `deploy.commit` 이 이 푸시의 끝 커밋으로 바뀌면 Render 반영 확인. 되돌림 = API 는 이 범위 revert(웹 무변경 — Vercel `dpl_2D3C72kz7f2dC42CUE85CZ3DiYZr` 그대로).** 그 전 **2026-10-11 낮 KST main `dc56bab..7fbaa67` + 이 기록 커밋(PR #17 fast-forward, PM "go ahead" — 웹·문서만: 실서비스 기준 UI 정리 · 카드 앞 대표 메뉴 · 휠체어·유모차 · 탐색 층 Liquid Glass · 데스크톱 툴바 줄바꿈 · 첫 방문 기기 언어 · 원칙 문서, 아래 2026-10-10) — PR CI green(`7fbaa67` 4잡, e2e 포함). API·스키마 무변경, Build Filters 설정 뒤라 Render 는 다시 뜨지 않아야 한다. Vercel 프로덕션 id · 라이브 확인은 사람 확인 대기. 되돌림 = Vercel `dpl_Fy1mTVx5F8vRcV9V3w1KzozpbDpk`(`dc56bab`).** 그 전 **2026-10-09 23:07 KST main `e324134..dc56bab`(PR #12 문서만 — HANDOVER) — Vercel 프로덕션 `dpl_Fy1mTVx5F8vRcV9V3w1KzozpbDpk`(= PR #13 반영 전 되돌림 지점).** 그 전 **2026-10-09 21:38~21:40 KST main `05af862..e324134`(PM 지시로 GitHub rebase 병합 — PR #16 `e9436c6` warmup·uptime 주소를 `BACKEND_HEALTH_URL` 로 · #14 `..1b4a5f9` 심사 화면 3차 웹 수정 · #15 `e324134` `render.yaml` 플랜 `0.5c-512mb`) — main CI green(run 37931572863, 4잡, e2e 포함), Vercel 프로덕션 `dpl_6nXsUfioNU1dvJsYmCZVJsKLGVVf` READY · 별칭 `nextspot-nu.vercel.app`. 라이브 확인(클라우드 세션): 번들에 `nextspot-t2ib` 4·오리건 0 · 새 코드(별칭 '천마총(대릉원)' · `course-widen-time`) 들어감 · 390px en 스모크 — /main 첫 카드 6.0초, /course 30분 조건에서 'Allow 60 min and search again' 버튼, /mypage 'Guest Explorer', API 실패 0(`/account/me` 401 은 로그인 전 게스트 경로 — 정상). API 코드는 안 바뀜 — Render 가 다시 떴는지는 대시보드로(Build Filters 설정 뒤 첫 푸시). 되돌림 = Vercel `dpl_6st1eMPc85jHbBCukXnyNmiU3PFr`(`05af862` + 싱가포르 주소).** 그 전 **2026-10-07 15:47 KST main `c347129..05af862`(CI 만 — e2e 잡 상한 15 → 30분) — main CI green(run 37583488645, 4잡), Vercel 프로덕션 `dpl_BQEyd1sREmLTUDpYWtRwZZmo3ij4` READY(웹 코드 무변경). 10-09 클라우드 세션 재확인: origin/main·Vercel id 그대로, 예약 워크플로 정상(학습 제외 — 아래 2026-10-09). 되돌림 = Vercel `dpl_4VwJyqBNkn5yYZqsNKrGiPJf41mn`(push 2).** 그 전 **2026-10-07 15:31 KST main `f031140..c347129`(push 2 = 배치 B1~B5 웹·문서만, PR #11, 아래 2026-10-07) — PR CI green(e2e 12분 43초), Vercel 프로덕션 `dpl_4VwJyqBNkn5yYZqsNKrGiPJf41mn` READY 15:32, Render 는 재배포하지 않음(API 파일이 안 바뀌면 다시 뜨지 않는다 — 10분 `/health` 40회 200, 프로세스 그대로), 라이브 확인: 데스크톱 랜딩 '이렇게 써 보세요' 바로가기 5·자동 팝업 없음, 🔮 혼잡 예측 '+2시간 후' → '+2시간 후 예측' 배지 2.7초·카드 '+2시간 후 기준', 첫 카드 1.6~2.9초(배포 직후 첫 1분은 24초 — 캐시 빔), /waiting 다수결 한 줄, 사장님·관제 데모, 5명 동시 첫 방문 5xx·429 0. 되돌림 = Vercel `dpl_Gx96gkGe2D7ZAEdRoTefpc3W1dcs`(push 1). 그 전 2026-10-07 01:29 KST `0be9872..f031140`(push 1 = B0 + 배치 A + C1, PR #10, 아래 2026-10-06) — CI green, Vercel `dpl_Gx96gkGe2D7ZAEdRoTefpc3W1dcs`, Render 재시작 01:30·`/health` 44회 200, 골굴사 검색 127693, 데스크톱·폰 스모크.** 그 전 origin/main 은 `0be9872`(10-02 `release/1002`, 아래 2026-10-02 — 이 줄에 배포 확인 기록 없음). 그 전 확인된 반영은 2026-09-30 01:24 KST `dd2afc9`(사용자 푸시, `f0f440b` 위 fast-forward) — 추천 카드 합성 id 수정 `afa4ec0`(아래 2026-09-29b) · P3 배치 B csr 커널(스위치 꺼진 채 memo — API 동작 불변, 아래 2026-09-29c) · 문서. CI green(4잡, e2e 포함 01:28 KST) · Vercel 번들에 `afa4ec0` 확인 · Render `/health` 새 프로세스(참조 스냅샷 ready·1,684곳, `parking_history` rpc) — 데스크톱 확인 09-30 01:30. 그 전 2026-09-29 오후 `f0f440b`(= `release/0930`, CI green 15:44 KST) — API 재설계 P3 배치 A(아래 2026-09-28e) · 대기 보드 웹 27건(아래 2026-09-29). Vercel 은 이 번들을 낸다(09-29 23시, i18n 청크 해시가 로컬 빌드와 같음 — 데스크톱 확인). Render 배포 커밋은 `/health` 로는 안 보인다(`reference_snapshot` ready·1,684곳, `parking_history.mode=rpc`). 그 전 2026-09-29 새벽 야간 배치 — API 재설계 P2a(주차 이력 행렬 · 스위치 `AREA_DEMAND_SOURCE` 기본 `rpc` = 손님 쪽 동작 불변, 아래 2026-09-28d) · Wikimedia 사진 출처 줄·ⓒ 표시 자리 · P0b 웹 7건(아래 2026-09-28c). 그 전 2026-09-28 P0c 일배치·수집 경보(`367514c`, 아래 2026-09-28b). 그 전 같은 날 API 참조 스냅샷 P0a·P1(`fd5af2d`..`4d56afa`, 아래 2026-09-28 — 사용자가 직접 푸시, Render 가동 확인: `/health.reference_snapshot` ready·1,682곳, 지도 TTFB 0.24~0.54초·304 동작). 그 전 2026-09-27 TourAPI 일배치 재시도(`58c8bfc`). 그 전 같은 날 Supabase 키 공백 정리(아래 2026-09-26c 끝). 그 전 2026-09-26 Supabase 연결 격리(`bd44110`, 아래 2026-09-26c). 그 전 같은 날 관제 대시보드 추정·예측·시나리오 모드(`990b315`..`c2f97ad`, 아래 2026-09-26b). 그 전 같은 날 운영 긴급 수정·메모리·관광객 CPU(`0ae42b8`..`6b80f50`, 아래 2026-09-26). 그 전 2026-09-25 API OOM 대응(`0408bd7`..`0ce394d`). 그 전 2026-09-22 `ec127ee`, 09-21 —
  `fafdd06`+(심사용 계정 안내 + yunseong 데모 콘솔·비교 헤더·데이터 절 통합, 아래 `2026-09-21b`·`c`; 그전 `374254c`·소개 개편
  `a3b8a6b` 포함). `/guide`는 줄·혼잡으로 잃는 여행 시간과 주변 대안·이동 코스라는
  문제·해결 한 화면만 남겼다. Vercel 응답에서 새 제목·문제 카드·해결 카드가 있고 이전 취향 서사와 기술 설명은 없는 것을 확인했다.
  사람이 마지막으로 배포 결과를 눈으로 확인한 시점은 2026-09-08(관리자 대시보드·통계/성과 리포트 화면) — **09-20 시각 확인 대기**.
  규칙: main에 푸시한 쪽(에이전트 포함)이 위 줄의 날짜를 갱신하고, Vercel·Render 배포를 눈으로 본 사람이 확인 날짜를 적는다.
- **CI 는 이제 `yunseong` 푸시에서도 돈다**(`ci.yml` 트리거에 추가, 09-08). 그전에는 `main` 과 PR 뿐이라
  PR 없이 fast-forward 하는 이 저장소에서는 **CI 를 처음 보는 시점이 곧 배포 시점**이었다 —
  실제로 09-06 승격 뒤 e2e 잡이 이틀간 빨간불인 채 main 이 계속 배포됐다. 승격 전에 CI 초록을 확인할 것.
- Web: https://nextspot-nu.vercel.app — 루트 `vercel.json`이 `npm run build --workspace=apps/web` → `apps/web/out`.
  Vercel 대시보드에 Root Directory를 **설정하지 않는다**(설정하면 워크스페이스 빌드가 깨진다).
- API: https://nextspot-api.onrender.com (`/health`, `/docs`) — `render.yaml` Blueprint, docker, `plan: free`.
  **실제 플랜은 Starter**(`0.5c-512mb` · 0.5 CPU · 512 MB · 슬립 없음 — 10-09 PM 대시보드 확인). `render.yaml` 의 `free` 는
  틀린 값이라 이 파일이 바뀌는 푸시의 Blueprint 동기화가 무료(0.1 CPU · 슬립)로 되돌릴 수 있다 — `fix/render-plan-starter` 로 고친다.
  **리전: API 는 오리건, Supabase 는 싱가포르**(10-09 PM 확인) — DB 왕복이 태평양을 건넌다(기존 기록의 '오리건↔서울'은 틀렸다).
  Render 는 리전을 바꿀 수 없어 이전 = 싱가포르에 새 서비스 + API 주소 교체(Vercel `NEXT_PUBLIC_FASTAPI_URL` · Vault 수집 URL 2개 ·
  Actions 변수 `BACKEND_HEALTH_URL` · `warmup.yml`·`uptime.yml`) — 절차는 아래 2026-10-09 항목. PM 이 시간 될 때(심사 1차 뒤 권장).
  `render.yaml` 에 빌드 필터가 없다. 웹·문서만 푸시에 Render 가 다시 뜨지 않은 근거는 10-07 push 2 관측 1회뿐이다 —
  대시보드 Build Filters 를 확인하기 전에는 낮 푸시가 API 를 재시작할 수 있다고 본다.
- DB · Auth · Storage: Supabase 팀 프로젝트. 원격 마이그레이션 적용 상태는 아래 "마이그레이션 확인" 쿼리로만 믿는다.
- 스케줄: **Supabase pg_cron**이 10분 주기(`nextspot-area-demand-primary`/`-retry`)로
  `POST /api/v1/area-demand/snapshots/collect`를 서비스 토큰으로 호출(헤더 이름은 `X-Admin-Authorization: Bearer` —
  pg_cron 함수가 아직 이 이름을 쓴다. 정식 `X-Service-Token`도 함께 수용, `authz.py`). GitHub Actions 예약은 **네 개** —
  `ingest`(매일 KST 04:00) · `train-recommendation-model`(매주 월 03:00 KST — **08-23 이후 매주 실패**, 아래 "사람 작업 대기") ·
  `area-demand-alert`(매시 28분 예약, 실제 발화는 3~7시간 간격 — Supabase `area_demand_snapshots` 최신 행이 35분보다 오래면 실패) ·
  `warmup`(API Keep-Warm, 10분 예약 — `/api/v1/warmup`·`/health`, 역시 best-effort: **실제 발화는 4~7시간 간격**,
  10-06 20:37 ~ 10-09 07:34 UTC 12회 — 캐시 예열을 보장하지 않는다. API 를 깨워 두는 것은 pg_cron 10분 수집이다). `collect-area-demand`·`uptime`은 수동이다.
  `area-demand-alert`는 09-28 이후 실행마다 Supabase 단계로 실제 판정한다(skip 아님 — 09-29 데스크톱이 Actions 단계 결과로 확인).
  Supabase 시크릿이 없으면 옛 API 판정(`BACKEND_HEALTH_URL`), 그것도 없으면 skip.
- 환경변수 이름·위치·시크릿 목록: [`DEPLOY_AND_ENV.md`](./DEPLOY_AND_ENV.md).
- 심사 계정: `openapi@naver.com`(merchant, 이풍녀 구로쌈밥·맥심가옥 소유) · `openapi@gmail.com`(admin).
  비밀번호는 저장소에 없고 `apps/api/scripts/seed_judge_accounts.py`가 `JUDGE_ACCOUNT_PASSWORD` env로 시드한다.
  개발자 부트스트랩 계정은 구글 OAuth 1개, `/dev`는 마지막 developer 강등을 거부한다.

## 우선순위

1. **실서비스 창업 방향(2026-10-31~)** — 공모전은 우수상으로 끝났고(11-05 시상), 모두의 창업 2차 **로컬 트랙 1라운드**에 진출했다(다음 관문은 2라운드 지역 예선).
   작업 기준은 '진짜 서비스할 수 있는 앱'이다. 순서는 [`PRODUCT_EVALUATION_PLAN.md`](./PRODUCT_EVALUATION_PLAN.md) §5(진행 §7),
   경주 통신사 데이터 전에 서울로 실시간 유동인구 시스템을 미리 구축하는 계획은 [`SEOUL_TESTBED_PLAN.md`](./SEOUL_TESTBED_PLAN.md)(10-31 S0·S1·S2·S5·S6 · 11-01 S3·S4 구현 끝, main 미반영 — **S4 는 홍대 CSV 반출(사람 작업) 대기**, 받으면 홍대 1차(예비) 결과 · 종로는 수집 쌓인 뒤 재실행만. 게스트 답 실시간 전환(D3)은 그림자 모드 2주 측정 뒤).
   세션마다 `/health`·Actions·04:00 적재를 확인하고, API 를 건드리는 main 반영은 KST 밤에만.
   **모바일 앱 재구현(11-01 계획, 검토 대기)** — Expo React Native, 관광객 화면 전부를 v1 로 [`MOBILE_APP_PLAN.md`](./MOBILE_APP_PLAN.md). 11-02 답 반영(SDK 57 · CAPTCHA 끔 · Z Fold7 · 지도 키는 사용자 Google Cloud). Expo 조직(M6)이 생기면 1단계부터.
2. **사람 작업 대기** 처리 — 특히 오늘 밤 배포 전 10-31c 작업(Render 서울 대상지 변수·종로 이름 확인·마이그레이션 2개), `JWT_SECRET` 시크릿(주간 학습), 배치 D 의 D3·D6, 실사진 DB 정리 ①~③ 적용 여부(아래).
3. **심사 화면 3차 남은 PM 결정** — 웹 수정(PR #14)은 10-09 main 반영. 남은 것은 순위·데이터 쪽 결정(아래 2026-10-09 "다음·미결").
4. **PR #13 `fix/llm-rate-limits-1009` 병합** — "알려진 이슈" ③ 의 구현 + 밤 e2e 수정. CI green(`c678db4`), KST 밤 PM 병합만 남음("사람 작업 대기" 맨 위).
5. 심사 뒤: "알려진 이슈" ①·② 결정 · 보안 진단 상·중 항목 · `ingest.yml` 리포트 artifact 보존 ·
   `apps/web/lib`·`apps/api/app/services` 점진 이동(`AGENTS.md` "새 파일은 어디에") ·
   [`archive/IMPROVEMENT_PLAN.md`](./archive/IMPROVEMENT_PLAN.md) "2026-08-21 갱신" 절 미완 항목 재확인.

## 사람 작업 대기

외부 콘솔 접근이 필요해 코드로 못 하는 일. 끝나면 줄을 지우고 "최근 세션"에 한 줄 남긴다.

- [ ] **모두의 창업 선정 취소·환수 조항 서면 확인(2026-10-31 추가 · 로컬 트랙 1라운드에도 적용)** — 2차 공고(중기부 제2026-511호) 공통 유의사항: 정부·지자체 주관 타 공모전 수상 이력이 공개돼 있거나 이미 상용화(서비스)된 아이디어는 선정 취소·상금 환수될 수 있다. 1라운드가 곧 '아이디어 선정'이라 최악이면 선정 취소 + 창업활동자금 200만 원 환수다. 신청(~9/17)·1R 발표(10/16) 때는 수상 이력이 없었다는 점이 유리하지만 조항에 기준일이 없다. 관광공모전 출품·수상 사실과 공개 웹 상태를 먼저 밝히고 대경권 로컬 트랙 운영기관·소상공인시장진흥공단(1357)에 서면으로 묻는다. 답 전에는 현장 베타를 미룬다. 같은 김에 로컬 트랙 2R 지역 예선 제출물·마감(미확인 — 12/1 은 일반/기술 트랙 제3자 정리)과, 2R 진출 시 협약 기간 내 사업자등록 의무도 확인한다(`PRODUCT_EVALUATION_PLAN.md` '최신 소식').
- [ ] **(10-31c ① · API 배포 전) Render `SEOUL_CITYDATA_TARGETS` 정리** — `nextspot-t2ib` 환경변수에 옛 5곳 값이 있으면 **지운다**(코드 기본값 9곳·주기 포함을 쓴다) 또는 새 값으로 바꾼다. 빈 값으로 두면 503 `seoul_targets_missing` 으로 서울 수집이 멈춘다. 표기는 `DEPLOY_AND_ENV.md` §2.
- [ ] **(10-31c ②) `20261031120000_crowd_zones.sql` 적용 + `NOTIFY pgrst, 'reload schema';`**(서울 S1 구역 표) — 확인 `select count(*) from public.zones;` → 9. 적용 전에도 수집은 돌고 정규화 표 이중 저장만 상태에 '표 없음'으로 남는다.
- [ ] **(10-31c ③ · API 배포 전) 종로 4곳 대상지명 확인** — 이름이 서울 API 와 글자까지 같아야 수집된다. 한 곳에 1회씩(일 한도 4회 사용, 로컬 `apps/api/.env` 필요):
```powershell
cd D:\NextSpot\apps\api; $env:PYTHONUTF8='1'
.\.venv\Scripts\python.exe -c "import asyncio, httpx; from app.core.config import settings; from app.services import seoul_citydata_service as s
async def main():
    async with httpx.AsyncClient(timeout=10) as c:
        for n in ['경복궁','북촌한옥마을','인사동','창덕궁·종묘']:
            try:
                d = s.parse_citydata(await s.fetch_citydata(c, settings.SEOUL_OPENDATA_KEY.strip(), n), n)
                print(n, 'OK', d['area_cd'], d['congest_lvl'], d['observed_at'])
            except s.SeoulCitydataError as e:
                print(n, 'FAIL', e.code, e.upstream_code)
asyncio.run(main())"
```
  기대: OK 4줄(POI008 · POI066 · POI078 · POI012). `FAIL seoul_area_mismatch` 면 이름이 다르다 → `config.py` 기본값 · `SEOUL_ZONES` · 마이그레이션 시드를 함께 고친다.
- [ ] **(10-31c ④) `20261031130000_guest_crowd_answer_shadow.sql` 적용 + `NOTIFY pgrst, 'reload schema';`**(D3 그림자 모드) — API 배포 직후. 확인은 아래 "마이그레이션 확인" 20번과 그 아래 두 쿼리(`observed_%` 열 · cron 잡 `nextspot-network-hash-retention`). 같은 김에 Render 에 전용 `NETWORK_HASH_SALT`(강한 무작위 값)를 넣는 것을 권한다 — 없으면 `JWT_SECRET` 에서 파생해 동작은 하지만 용도가 다른 비밀에 묶인다.
- [ ] **(10-31c ⑤) Turnstile 켜기** — Cloudflare Invisible 위젯 → Vercel `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + 웹 배포 → Supabase Auth CAPTCHA(Turnstile 비밀 키 — 이곳에만) → 익명 로그인 IP 한도 낮추기(지금 300/h — 10-06 상향, 기본 30/h). **CAPTCHA 는 모든 로그인 경로에 토큰을 싣는 웹(D3 보안 수정)이 main 에 배포된 뒤에만 켠다 — 그 전에 켜면 이메일 로그인·가입·비밀번호 재설정이 막힌다**(Supabase CAPTCHA 는 프로젝트 전체에 걸린다). 켠 뒤 게스트→회원 전환·OAuth 콜백이 되는지 한 번 확인. **⚠ 보류 확정(11-02 사용자 — 모바일 앱 계획 A7): 켜지 않는다. 켜면 네이티브 앱의 익명·이메일 로그인이 막힌다(Turnstile 은 네이티브 SDK 가 없다). 익명 로그인 한도 300/h 는 앱 출시 전 생성 수를 보고 정한다.**
- [ ] **(10-31c ⑥) 개인정보처리방침 + 앱 안 개인정보 안내 — 출시 전 전문가 확인** — 게스트 방문 확인 답에 네트워크 대역 해시를 남긴다(목적: 악용 방지·답 품질, 보관 30일, 원본 IP 는 서버 메모리에만 최대 30분). Turnstile 을 켜면 Cloudflare 를 제3자 처리자로 적는다. 앱 안 안내(`/mypage/privacy` '부정 이용 방지' 절, 4로케일, 갱신일 2026-10-31)는 넣었다 — 법률 검토는 따로 필요하다.
- [ ] **(10-31c ⑦ · ④ 적용 2주 뒤) 게스트 답 실시간 전환 결정** — `GET /api/v1/admin/metrics/guest-answers?days=14` 의 일치율·공유 네트워크 비율을 보고 정한다. 켜기 전에 운영 로그로 `client_ip`(XFF 마지막 값)가 Render 뒤에서 실제 손님 IP 인지 확인한다(프록시 hop 이 붙으면 전원이 한 IP — "보안 진단" 중 항목과 같은 관측). 켜려면 Render `GUEST_CROWD_ANSWERS_LIVE=true`(재시작) **와** 웹 문구 `visit.guestCongestionNote`(4로케일) 변경을 함께.
- [ ] **(10-31c ⑧) '인사동·익선동' → '인사동' 확인(사용자)** — 서울시 공식 목록에 한 곳으로 없어 인사동(POI078)만 넣었다(익선동은 POI116). 익선동을 `@3+1` 로 10번째에 더해도 주 768 · 최악 912회/일로 한도 안이다(`SEOUL_TESTBED_PLAN.md` §6 S2).
- [ ] **(11-01 S3 ① · main 반영 전) 격리 사전 확인(읽기 전용)** — `select id, name, latitude, longitude from public.facilities where latitude between 37.41 and 37.72 and longitude between 126.76 and 127.19;` 가 **0행**이어야 한다(아니면 `20261101090000` 이 23514 로 통째 롤백된다).
- [ ] **(11-01 S3 ②) 순서: API 배포 → `20261101090000_facility_region_isolation.sql` → `20261101091000_zone_population_baseline.sql` → `NOTIFY pgrst, 'reload schema';` → 웹.** `20261031120000`(10-31c ②)이 먼저다. 090000 은 끝에서 `region_isolation_status()` 가 1 이 아니면 스스로 실패한다. 확인은 "마이그레이션 확인" 21·22번과 그 아래 쿼리. 마이그레이션 전 API 는 지역 열이 없으면(42703) 경주만 그대로 돈다.
- [ ] **(11-01 S3 ③) region-guard** — 변수 `BACKEND_HEALTH_URL` 이 있는지 확인하고 `REGION_GUARD_AUTO_DEACTIVATE` 는 **두지 않는다**(사용자 결정: 자동 비활성화). main 반영 뒤 `region-guard.yml` 을 한 번 수동 실행 — 기대 `ok`(적용 전이면 `not_applied`). **롤백 규칙**: `/health` 에 `capabilities.region_isolation` 이 없는 커밋으로 API·main 을 되돌리기 전에 `update public.facilities set is_active=false where region<>'gyeongju';`. `containment_failed` 면 090000 을 SQL Editor 에서 다시 적용한다.
- [ ] **(11-01 S3 ④) 서울 장소 적재** — 시험용 관광객 계정(일반 tourist, 다른 용도 금지)을 만들고 GitHub Secrets `REGION_PROBE_TOURIST_EMAIL`·`REGION_PROBE_TOURIST_PASSWORD` 등록(없으면 실제 실행이 exit 3). ② 뒤 `ingest-seoul.yml` 을 `dry_run=true` 로 돌려 TourAPI 호출 수를 보고, `dry_run=false` 로 다시 — 매핑 단계 `active_unmapped_count = 0` 확인. region-guard 가 한 번 끊었다면 격리 복구 뒤 `reactivate=true`.
- [ ] **(11-01 S3 ⑤ · 선택) 서울 구역 경계** — OA-21285 '서울시 주요 121장소 영역.zip' 을 빈 폴더에 받아 `python -I apps/api/scripts/build_seoul_zone_polygons.py <zip>` → 생긴 GeoJSON 커밋 → `ingest-seoul` `map_zones=true`. 그 전에는 반경 원으로 매핑한다.
- [ ] **(11-01 S3 ⑥) 개발자 계정 서울 리허설** — 실기기에서 지역 전환 → 지도 구역 원·라벨(e2e 는 카카오 SDK 를 대역으로 써 못 봤다) · 카드·코스·대기판의 구역 줄 · 서울에서 공유·제보·체감 혼잡 질문·쿠폰함이 없는지.
- [ ] **(11-01 S4 ① · 읽기 전용) 홍대 CSV 반출** — 운영 DB 는 읽기만. SQL 은 [`SEOUL_TESTBED_PLAN.md`](./SEOUL_TESTBED_PLAN.md) §6 'S4' 부록 블록(또는 `apps/api` 에서 `.\.venv\Scripts\python scripts/crowd_dispersion_replay.py sql --cluster hongdae --from 2026-09-20 --to <오늘 KST>`). SQL Editor 결과 한도 'No limit' · 문장 하나씩 · 결과 바닥 행 수를 Q0 목록과 대조 · 파일 이름은 각 블록 머리 주석대로 · 엑셀로 열어 저장하지 않기 · 저장은 저장소 밖 `$HOME\nextspot-s4\hongdae`(같은 절 ②·③). 받으면 에이전트에게 폴더를 알려 준다 → `run --label pilot` → 홍대 1차 결과(집계만 커밋, 원본 CSV 는 커밋하지 않음).
- [ ] **(11-01 S4 ② · 종로 수집 4주쯤 뒤) 종로 확인 실행** — 같은 반출(`--cluster jongno`)을 받아 깨끗한 체크아웃에서 `run --cluster jongno --label confirmatory --expect-criteria <홍대 검토 뒤 고정한 해시>`. 코드 변경 없음(커밋 안 된 변경이 있으면 종료 4). 종로 수집은 10-31c 배포(Render)부터 쌓인다.
- [ ] **(11-01 모바일 ② · 웹에도 해당) 위치정보법 확인** — 웹은 이미 로그인 사용자 id 와 함께 좌표를 API 로 보내고, 추천 기록에 후보별 거리를 남긴다. 위치기반서비스사업 신고(소상공인은 개시 1개월 안)·위치기반서비스 이용약관 동의·이용 확인자료 보존·만 14세 미만 처리가 필요한지 법무 확인. 근거 조문과 앱 설계 반영은 [`MOBILE_APP_PLAN.md`](./MOBILE_APP_PLAN.md) §8.2·M20.
- [ ] **(11-01 모바일 ①) 앱 계획 검토 + 스토어 권한 준비** — [`MOBILE_APP_PLAN.md`](./MOBILE_APP_PLAN.md) 남은 것: Expo 조직 만들기(M6) · Google Cloud 프로젝트 + 결제 계정 + 'Maps SDK for Android' 키(A21 — 제한은 1단계 SHA-1 뒤) · 진석 님 권한은 §8.1(App Store Connect 팀·API 키, Play Console 초대·서비스 계정, Expo 조직, 안드로이드 Google Maps 키). 키 파일(.p8·서비스 계정 JSON)은 저장소·채팅에 올리지 않는다.
- [ ] **Render API 자동 배포 고치기(10-22 재확인 — API 변경 `a9ecd92` 가 자동 배포되지 않아 PM Manual Deploy, 10-14 `f80454c` 도 수동)** — 원인 후보는 아래 ② Build Filters 경로 또는 ④ Auto-Deploy 'After CI Checks Pass'(그날 main CI 가 인프라·밤 e2e 로 실패). 가장 간단한 길: `nextspot-t2ib` Settings → **Deploy Hook** URL 을 GitHub Secret `RENDER_DEPLOY_HOOK` 으로 등록 → 에이전트가 main API 변경 뒤 배포·확인까지 한다. 기존 점검 항목: 대시보드에서 ① 실패한 서비스가 싱가포르 `nextspot-t2ib` 인지 오리건 `nextspot-api` 인지 · 그 커밋과 로그 첫 오류 줄(Events) ② `nextspot-t2ib` Settings → Branch `main` · **Build Filters 포함 경로가 저장소 루트 기준 `apps/api/**`**(서비스 폴더 기준 `app/**` 이면 API 변경이 영원히 배포되지 않는다) ③ 워크스페이스 Integrations → Notifications 가 '실패만'이면 성공 메일은 원래 오지 않는다 ④ `nextspot-t2ib` Settings → Auto-Deploy 가 **'On Commit'** 인지(→ 확인되면 `deploy-verify.yml` 의 push 트리거를 켠다 — 'After CI Checks Pass' 면 켜지 않는다) · Build Filters 에 무시 경로를 두었다면 알려 줄 것(워크플로 대상과 맞춘다). 실패가 싱가포르였고 원인이 남아 있으면 #13 병합 전에 Manual Deploy → "Deploy latest commit" 로 통과 확인. 코드 쪽 재현은 통과(아래 2026-10-12).
- [ ] **음식 카드 사진 — GitHub → Settings → Variables `GYEONGJU_CITY_PHOTO_ENABLED=true`**(10-10 PM 지적 "음식 카드에 사진이 안 뜬다"). 운영 음식점 1,121곳 중 1,082곳·카페 556곳 중 538곳이 사진이 없다 — 거의 전부 카카오 로컬 행이고 카카오 장소 API 는 사진을 주지 않는다. 경주시 「메뉴별음식점」 사진 보강은 이 변수가 꺼져 있어 `features.city_photo` 0행. 전제(웹 '사진: 경주시' 출처)는 main 에 있다(`lib/photoCredit.ts`). 켜면 다음 04:00 적재부터 매칭된 사진 없는 행에 들어간다(10-02 시뮬레이션 첫 밤 약 39곳 — 전체를 덮지는 못한다). 나머지는 카드의 '카카오맵에서 사진 보기'(PR #17)가 받는다.
- [ ] **(선택) 휠체어·유모차 필터 데이터 — data.go.kr '한국관광공사_무장애 여행 정보'(15101897, KorWithService2) 활용신청**(10-10 PM "무장애 필터가 안 와닿는다"). 지금 판정은 TourAPI 상세 글에 '휠체어·엘리베이터' 같은 낱말이 있는지뿐이라 운영 1,728곳 중 2곳(김유신묘·천마총, 음식점·카페 0곳)이다. 신청되면 공식 항목(휠체어 대여·승강기·장애인 화장실 등)으로 적재·필터를 바꾼다(API — 밤 배포, 경주 표본 수는 적재 전엔 모름). 칩 이름은 10-10 '무장애' → '휠체어·유모차' 로 바꿨다(PR #17).
- [ ] **PR #13 병합(KST 밤 · API 재시작)** — [`#13`](https://github.com/NextSpot-knu/NextSpot/pull/13) head `c678db4`, CI 4잡 green · 충돌 없음(10-10 확인). GitHub 에서 **'Create a merge commit'**(가지에 'update branch' 병합 커밋이 있어 rebase 는 거절될 수 있다). 에이전트의 병합 호출은 권한 분류기가 '프로덕션 배포'로 막는다(10-10) — PM 이 누르거나 "merge #13" + 권한 규칙. 되돌림: 웹 Vercel `dpl_Fy1mTVx5F8vRcV9V3w1KzozpbDpk`, API 는 #13 커밋 revert. 병합 뒤: main CI · 싱가포르 `/health` · `/travel-context/parse` 한 번.
- [ ] **심사 대비 배치 D(아래 2026-10-06) — D1 끝(2026-10-06 사용자 설정: Supabase Auth Rate Limits 익명 로그인 30 → **300/h per IP**, `DEPLOY_AND_ENV.md` 1-2)**: D2 끝(10-07 사용자 '계속' = 권장안 그대로 — ① 유지 ② 승인 ③ 34회 수용 ④ 데이터만 — ④ 숨기기 SQL 은 10-08 ~19:25 KST PM 적용, 아래 2026-10-09) — 당시 결정 4가지: ① 밤의 첫 화면 자동 칩 전환(계획 밖) 유지/끄기 ② 앞면 취향 일치율 규칙(60% 이상·후보마다 다를 때만, 50% 문턱 질문과 함께) ③ 차가운 심사 여정 Render 호출 수(계획 12회 — 잰 값은 아래) 수용 여부와 배포 직후 밤 5세션 스모크 ④ 관광지 1위가 교육청 체험관·상점가·먹자골목인 것(데이터·순위 — 21번 미룸, 데이터만 재분류 / 관광지 후보에서 제외 / I28 열린 관광지 단계 중 택1) · D3 심사 가게(이풍녀 구로쌈밥·맥심가옥) `coupon_rate` < 15% 와 `system_settings`(점검 꺼짐·공지 빔) 읽기 확인 — 심사 예상 주 아침마다 · D4 월정교 시드 연결만(PM_STEPS 6·7) · D5 반려동물 API 활용신청(🐾 원할 때) · D6 배포 뒤 `openapi@naver.com`·`openapi@gmail.com` 로그인 첫 화면 확인 · D7(선택) 심사일 전날 밤 API Keep-Warm 수동 1회.
- [ ] **P2a shadow 게이트** — Render `AREA_DEMAND_SOURCE=shadow` 는 **2026-09-30 01:37 KST 가동**(사용자 설정, `/health`: ready·rows 5,352·lots 4·failures 0·동기화 31초). **10-01 01:37 이후**(재시작 1회 포함) 게이트와 go/no-go 측정 → `matrix`.
      순서·게이트·되돌림(`rpc`, 재시작 1~2분)·볼 것은 [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md) "P2a 전환 절차".
- [ ] **P3 배치 A Render 로그 확인**(09-29 `f0f440b` 로 반영) — 예열은 Keep-Warm 워크플로가 이미 부른다(반영 뒤 06:53Z·10:36Z 실행). Render 로그에서 `walking_graph_presnap`·`warmup_run_done` 이 보이는지, `merchant_boost_timesale_fetch_failed`·`availability_evidence_unavailable`(추천·by-type·지도)이 늘지 않았는지. 되돌림 env `WALKING_ROUTE_KERNEL=legacy`(재시작) — 아래 2026-09-28e. 반영 전 PM 확인으로 적었던 두 가지(영업 근거 한 번 조회의 실패 범위가 `/infrastructures` 지도에도 적용 · 기존 테스트 두 곳 변경)는 이미 운영에 있다.
- [ ] **P3 배치 B csr 로그 확인** — Render `WALKING_ROUTE_KERNEL=csr` 는 **2026-09-30 01:37 KST 설정**(shadow 와 같은 저장·재시작). `/health` 에는 커널 칸이 없어 로그로만 본다. 로그 `walking_graph_csr_loaded origin=bin`(적재 수십 ms)·`walking_graph_presnap kernel=csr`(시설 ~1,684곳) 확인, Render Metrics 메모리가 전보다 ~20MB 낮은지. 되돌림 `memo`(재시작). 아래 2026-09-29c.
- [ ] **(`release/1002` 가 main 에 들어간 뒤, 다음 04:00 적재 전) 실사진 DB 정리** — 순서 무관(새 적재의 중복 가드가 늦어도 중복 카드를 막는다).
      ① 신라고분정보센터를 3532127 로: `update public.facilities set contentid = '3532127' where id = '70231629-3666-45b1-b701-2c37bfe62d5c' and contentid = '3442528';`
      (옛 3442528 은 적재 제외 목록에 있어 새 행이 되지 않는다 — ① 전까지는 밤 적재가 이 행을 갱신하지 않는다.) ② Kakao 행 6곳을 TourAPI 레코드에 잇기(다음 밤 TourAPI 사진·운영시간을 받는다):
      ```sql
      update public.facilities f set contentid = v.cid, contenttypeid = 39
        from (values ('f1847615-43c8-40f8-8121-88f3e5821d56'::uuid, '2839014'),  -- 료미
                     ('0691289a-148c-4acc-af4a-ff39c8499574'::uuid, '2904048'),  -- 신라제면 경주황리단길점
                     ('528ec40e-b547-4a42-8bbc-cf3d4defbe40'::uuid, '2989036'),  -- 경주대릉빵
                     ('d276e585-3464-4ac2-a83c-888a8c80d257'::uuid, '2907335'),  -- 늘곰탕
                     ('4e02d74c-16f5-4d5a-aaa5-b127a1068a43'::uuid, '2904191'),  -- 양지식당
                     ('d8da8528-10f1-4460-bcaa-2c0915881e70'::uuid, '2902488')   -- 황남밀면
             ) as v(id, cid)
       where f.id = v.id and f.contentid is null;
      ```
      (선택 — 가드가 찾은 사진 있는 같은 가게, PM 확인 후 같은 모양으로: 스테이550 경주점 `84f94145-e879-405d-a57d-c93cf478a5e9`→2903989 ·
      훌림목 `fd01f6bf-09b5-4066-97be-9139e46ad8ef`→2902567 · 올리브 `982c2c3b-6e05-40bc-b424-231a2dba9077`→2904334 · 프롬상록
      `d71be8d4-bf3b-4a2e-97b4-0f1c2a6bbb9a`→2903779 · 1894사랑채 `1804451a-9545-4d4b-9733-4c6681277dd6`→2902799 · 물방아삼계탕 경주본점
      `c9f6a2ea-af17-489d-b764-92f776c14b15`→132984.) ③ 중복 Kakao 행 숨기기 — 표시가 있어야 밤 적재가 다시 켜지 않는다(`features.manual_hidden`).
      대구갈비 본점(`7effe6b1…`)은 진가네대구갈비(`43adadcf…`)와 주소(북정로 5)·전화(054-772-1384)·영업시간이 같다(09-29 TourAPI 대조 — 확인됨).
      백년손님은 주소가 다르다(TourAPI 포석로1050번길 32 ↔ Kakao 첨성로99번길 20, 78m) — 카카오맵에서 같은 가게로 보일 때만 넣는다:
      ```sql
      update public.facilities
         set is_active = false,
             features = coalesce(features, '{}'::jsonb) || jsonb_build_object('manual_hidden',
                        jsonb_build_object('reason', 'TourAPI 행과 같은 가게 — 중복 카드', 'decided', '2026-09-29'))
       where id in ('0a2aa7ae-93dd-445b-b3a2-8f7cf2e738f3',   -- 이재원의과자공방(Kakao) = TourAPI 2840291 이재원과자공방
                    '7effe6b1-c2ce-4f6f-8552-8d081b145fb6',   -- 대구갈비 본점(Kakao) = TourAPI 403845 진가네대구갈비
                    'c3857ec8-092f-419a-8ea3-aade4eb12d5d');  -- 백년손님(Kakao) = TourAPI 2906690 — 위 확인 뒤에만(아니면 이 줄을 빼고 앞 줄 끝을 ');' 로)
      ```
      ④ 황리단길 생활문화센터(3451999)는 운영 DB 에 행이 없다(09-29 읽기 확인) — 코드가 적재하지 않으므로 SQL 불필요. 행이 보이면 ③ 과 같은 표시로 숨긴다.
      ⑤ **웹의 '사진: 경주시' 출처가 운영에 뜬 것을 확인한 뒤에만** GitHub → Settings → Variables 에 `GYEONGJU_CITY_PHOTO_ENABLED=true`(기본 꺼짐 — 그 전에는 경주시 사진을 넣지 않는다).
      ⑥ (선택 · 추천) 시드 관광지 두 카드에 TourAPI 사진 잇기 — 새 코드는 같은 곳이라 새 카드로 넣지 않는다. 같은 행(혼잡 기록 유지)이 다음 밤부터 사진·소개·운영시간을 받는다.
      교촌마을은 종류가 문화시설 → 관광지, 운영시간이 '상시 개방'으로 바뀐다(월정교는 수용 인원 400 → 300). 스냅샷 기반 되돌림 SQL 과 함께 PM_STEPS "관광지 두 곳 잇기"(6·7번 파일):
      `update public.facilities set contentid = v.cid, contenttypeid = 12 from (values ('f3000000-0000-0000-0000-000000000004'::uuid, '월정교', '2603509'), ('f4000000-0000-0000-0000-000000000002'::uuid, '경주 교촌마을', '128676')) as v(id, name, cid) where facilities.id = v.id and facilities.name = v.name and facilities.contentid is null;`
      ⑦ (선택 · **main 반영 전에** 결정하면 코드 한 줄) 관광지 보류 4곳을 넣을지 · 카드 두 장 5쌍 정리(위 09-29 항목 ⓐ·ⓑ — 추천: 대릉원 일원·금장대 수변공원·흥무로 벚꽃길은 넣지 않기, 월성이랑 숨기기). 새 카드 빼기는 반영 전이면 `EXCLUDED_CONTENTIDS` 한 줄.
      기존 카드 숨기기·반영 뒤 결정은 첫 04:00 적재 뒤 SQL(PM_STEPS "관광지 결정 대기" 8번 파일은 쌍마다 한 줄 고르고 남길 카드가 없으면 멈춘다): `update public.facilities set is_active = false, features = coalesce(features, '{}'::jsonb) || jsonb_build_object('manual_hidden', jsonb_build_object('reason', '한 곳에 카드 두 장 — PM 결정', 'decided', '2026-09-29', 'tag', 'attraction-overlap-0929', 'was_active', is_active)) where contentid in ('<숨길 contentid>') and not coalesce(features ? 'manual_hidden', false);`
      되돌림(9번 파일): `update public.facilities set is_active = coalesce((features -> 'manual_hidden' ->> 'was_active')::boolean, true), features = features - 'manual_hidden' where features -> 'manual_hidden' ->> 'tag' = 'attraction-overlap-0929';`
- [ ] **경주시 공공저작물 담당에 사진 사용 확인 메일 1통**(054-779-6791, 10월 심사 전) — 「메뉴별음식점」 API(data.go.kr 15114465, 이용허락범위 제한 없음)의
      대표 사진을 관광 안내 웹 카드에 출처('사진: 경주시')를 붙여 보여 준다는 내용. 시 사진 다운로드 사이트(공익·개인 이용 한정)는 쓰지 않는다.
- [ ] **폰 스모크(390px)** — 09-29 반영분(P0b 웹·사진 출처 · 대기 보드 27건): `/waiting` 4로케일(사진 없는 장소 표지·야간 18시 이후 색·줄 단위 자르기) · `/explore/recommend` 사진 대체 · 관제 장소 표 검색. 실시 기록이 없다.
- [ ] **공공 API 키 회전** — `TOURAPI_KEY`·`KMA_API_KEY`·`PARKING_API_KEY`·`GYEONGJU_FOOD_API_KEY`. httpx INFO 로그가 쿼리스트링째 전체 URL을 남겨 Render 로그 이력에 키가 있을 수 있다(09-28 `d9639c2` 로 차단). 새 키 발급 → Render·GitHub Secrets 갱신.
- [ ] Render `nextspot-api` 환경변수 `SUPABASE_SERVICE_ROLE_KEY` 끝의 줄바꿈 지우기(09-27 발견 — 코드가 이미 걷으므로 급하지 않다. 저장하면 재배포된다).
- [ ] **`ADMIN_API_TOKEN` 회전** — 구 값은 한때 `NEXT_PUBLIC_`으로 번들에 실렸던 값이라 공개된 것으로 취급.
      순서(서버는 단일 값만 비교하므로 Render 변경과 Vault 갱신 사이엔 수집이 실패한다 — 둘을 같은 10분 슬롯 안에 처리):
      새 값 생성 → Render에 `SERVICE_API_TOKEN` 추가(그 순간부터 이것만 유효, 기존 `ADMIN_API_TOKEN`은 둔다) →
      Supabase Vault `nextspot_area_demand_admin_token` 갱신 → GitHub Actions Secret `SERVICE_API_TOKEN` 추가 →
      다음 10분 수집 정상 확인 → `ADMIN_API_TOKEN`을 새 값으로 교체.
- [ ] **Kakao 개발자 콘솔** — 개인 개발자 → 비즈 앱 전환(`account_email` 스코프가 GoTrue에 고정돼 있어 이것 없이는
      KOE205가 안 풀린다). 앱 이름이 아직 "Induspot" — 동의 화면에 그대로 나온다 → "NextSpot".
- [ ] **Google 로그인 화면이 "<프로젝트ref>.supabase.co(으)로 계속" 이라고 뜨는 것 → "NextSpot"으로.** Google은 OAuth 콜백 주소의
      루트 도메인을 보여주는데 Supabase Auth 콜백이 `<ref>.supabase.co`라 그렇다(Supabase 공식 문서도 같은 설명).
      무료 경로: Google Cloud 콘솔 → Google Auth Platform → **Branding**에서 앱 이름 `NextSpot`, 로고(정사각 120px 이상),
      개인정보처리방침·약관 링크, **Authorized domains**에 `nextspot-nu.vercel.app`(Search Console로 소유 확인 선행) →
      **Publishing status = Publish**(email·profile·openid 같은 비민감 스코프만이라 즉시) → **브랜드 인증 신청**(며칠 소요).
      인증 전까지는 도메인 줄이 그대로이고 "확인되지 않은 앱" 경고가 뜰 수 있다. 유료 경로: Supabase **Custom Domain**
      애드온으로 `auth.<우리도메인>`을 콜백으로 쓰면 우리 도메인이 뜬다(도메인 보유 필요). 로그 §-43.
- [ ] **Supabase Auth Site URL**이 `localhost:3000`이면 Vercel 도메인으로(대시보드에서만 확인 가능).
- [ ] **Render `ALLOWED_ORIGINS`** — Vercel 도메인으로 지정해야 엄격 모드(해당 오리진만 + credentials). 미지정 시 와일드카드.
- [ ] **Render 로그에서 `X-Forwarded-For` 원 헤더 모양 1회 확인** — 리미터의 IP 추출 방향(첫 항목/마지막 항목/`CF-Connecting-IP`)을
      정하기 위한 관측(보안 진단 중 항목). 결과를 이 문서 "알려진 이슈"에 적는다.
- [ ] **심사 계정 2개 브라우저 로그인 확인** — `openapi@naver.com` → `/merchant`, `openapi@gmail.com` → `/admin/dashboard`.
- [ ] **주간 학습 `train-recommendation-model` 이 08-23 이후 7회 연속 실패 — GitHub Actions Secret `JWT_SECRET` 추가.**
      7회차(10-04, run 37233349285) 로그 끝: `ValidationError … JWT_SECRET must be a non-empty secret` — 시크릿 누락으로
      `app.core.config` 가 부팅하지 못한다. 검증 오류가 이 한 건이라 `ADMIN_API_TOKEN` 은 들어 있다는 것만 확인된다 — 없는 시크릿은
      빈 문자열로 넘어오고 `SUPABASE_URL`·`SUPABASE_ANON_KEY`·`SUPABASE_SERVICE_ROLE_KEY` 는 빈 값도 검증을 통과한다.
      워크플로가 넘기는 시크릿 5개(`SUPABASE_URL`·`SUPABASE_ANON_KEY`·`SUPABASE_SERVICE_ROLE_KEY`·`JWT_SECRET`·`ADMIN_API_TOKEN`)가
      Settings → Secrets 에 모두 있는지 같이 본다. 추가 뒤 `workflow_dispatch` 1회 →
      로그 끝 줄이 `verified observations N < M`·`seven-day holdout` 이면 학습 자료 게이트가 일부러 멈춘 것(자료가 차기 전까지는 정상 정지).
- [ ] `docs/MERCHANT_CONSOLE_RBAC_PLAN.md`(로컬 전용, 심사 자격증명 포함이라 미커밋)가 새 클론에는 없다 — 원본 보유자가
      필요하면 보관. 없어도 운영에는 지장 없음(내용은 로그 §-44에 요약).

## 알려진 이슈

결정이 필요한 것(①~③)과 알고 있지만 지금은 두는 것.

- ① **집중률 상대지수를 절대 점유율처럼 섞는다** — `app/services/area_demand_service.py`의 0.7/0.3 블렌딩.
  관광공사 집중률은 지점별 기준선 대비 상대값이라 "100 = 만석"이 아니다. 사용자에게 보이는 숫자가 바뀌는 문제라 데이터를 놓고 결정.
- ② **developer의 좌석 방송이 `verified`로 학습에 들어간다** — 소유자가 아닌 사람의 방송은 `single_report`로 낮추는 안.
- ③ **인증 없는·게스트 LLM/쓰기 경로에 유량 제한이 없다** — 순서는 아래 "보안 진단"대로: `travel-context/parse`·
  `preferences/parse`(상) → `/voice/turn`·`events/track`·`search/ingest-request`. (`/reports/*` 는 2026-10-30 게스트 차단 + IP 쿨다운.)
- **일요일 휴무 오판(버그, 10-31 재현) — `yunseong` 에서 고침(`9f3c77f` · `9b65fbe`, 아래 2026-10-31b), main 반영 전까지 운영은 그대로** — "매주 월요일 휴무"처럼 요일이 적힌 휴무 문구의 가게가 일요일마다 `closed_confirmed` 가 된다(운영 정규식이 '요일'의 '일'에 걸린다).
  웹(`lib/restDate.ts`)도 같은 판정이라 **API·웹을 함께** 반영해야 고쳐진다(API 먼저 — 옛 API 는 새 웹의 `stroller` 요청을 거절한다). 상세는 [`PRODUCT_EVALUATION_PLAN.md`](./PRODUCT_EVALUATION_PLAN.md) §7 P0-1.
- **게스트 차단 빈틈 — `yunseong` 에서 그림자 모드로 막음(`c1daf72`, 아래 2026-10-31c), main 반영 + `20261031130000` 적용 전까지 운영은 그대로** — 방문 확인의 체감 혼잡(`PATCH /recommendations/{id}/outcome` 의 `observed_congestion`)은 아직 게스트를 받는다.
  DB 트리거가 `user_report` 로 옮겨 계정 둘이 일치하면 corroborated 가 된다(`20260820123000:83-95`). 같은 문서 P0-2 · D3. `c1daf72` 보안 검토 지적은 후속 커밋에서 고쳤다(모든 로그인 경로 CAPTCHA 토큰 · 옛 RPC 폴백은 게스트 평가만 · 등록 사용자 방문 답은 예전처럼 제한 없음 · 게스트 30분 쿨다운 · 앱 안 개인정보 안내).
- **main 의 e2e 가 KST 23:29 이후 CI 에서 실패한다(PR #13 병합 전까지)** — e2e 고정 장소가 '하루 종일'을 `'00:00~23:59'` 로 적어, 앱의 '도착 뒤 30분 안 마감 제외'(`lib/restDate.ts` `isRecommendationOpen`)에 밤마다 걸린다. 앱 버그가 아니라 시험 고정값 문제. 고침은 #13 의 `c678db4`(`'24시간'`). 그 전에 밤 main CI 가 빨가면 rec-card·category-chips·doc-crosswalk 음성부터 의심.
- 스테이징이 없다 — **실 DB는 읽기만**, 쓰기 검증은 로컬 대역으로(08-28에 실 DB에 가짜 verified 3행을 쓴 전례).
- 프로필 캐시가 프로세스 내부(30초) — 워커 1개라 지금은 무해, `--workers N`을 붙이면 공유 무효화 필요.
- 메인 지도 `/infrastructures` 응답이 2.5초 경계에 걸려 폴백 경로로 돌던 문제는 타임아웃을 4초로 올려 완화(08-28).
  근본 해결은 지도용 경량 응답 분리(`overview_i18n` 64KB 제외).
- `20260905090000_congestion_logs_column_grants.sql`은 09-03에 만든 미래 날짜 파일이다. **새 마이그레이션은 이보다 큰
  타임스탬프**를 써야 `RESET_AND_SETUP.sql` 안의 적용 순서가 유지된다(원격 적용은 SQL Editor 수동 — CLI 링크는 없다).
- 원격 DB에 마이그레이션이 파일명 순서와 다르게 적용된 이력이 있다 — 순서를 가정하지 말고 아래 쿼리로 실측.
- 죽은 i18n 키 53개는 AST 분석(동적 `t(\`ns.${x}\`)` 패턴 전수 대조) 후 2026-09-04에 4로케일에서 삭제했다(823 → 770 leaf).
  `parity.test.ts`·`check-i18n-keys.mjs`는 죽은 키를 잡지 못한다 — 문자열을 없앨 때는 4 JSON에서 같이 지운다.

### 보안 진단 (2026-09-04, 읽기 전용 코드 감사 — Critical 없음)

결정·구현이 필요한 순서. 각 항목은 코드 근거가 있고, 고치기 전 재검증할 것.

- **상 — 비인증·게스트 LLM 호출이 무제한.** `POST /travel-context/parse`(인증·제한 없음, `routers/travel_context.py`)와
  `POST /preferences/parse`(익명 JWT 허용, 제한 없음)는 요청마다 Upstage 호출을 낼 수 있다. 일일 예산은 검색 재작성에만 있다
  (`config.py` `SEARCH_REWRITE_DAILY_BUDGET`). 조치: `routers/search.py`의 `_check_rate_limit`를 두 경로에 재사용 +
  `services/llm_client.py`에 전역 일일 예산 + `preferences/parse`는 `is_anonymous` 거부.
- **중 — X-Forwarded-For 해석 방향 미검증.** 모든 IP 리미터(검색·추적·음성·실시간 상세, 2026-10-30 부터 제보 쿨다운도)가
  `app/core/client_ip.py` 한 함수로 마지막 항목을 쓴다. Render가 hop을 덧붙이면 전원이 한 키(자기 DoS — 제보는 같은 장소 30분에
  한 계정만), 아니면 첫 항목이 위조 가능. 조치: Render에서 원 헤더를 1회 로깅해 모양을 확인한 뒤 그 함수에서
  `CF-Connecting-IP`/`True-Client-IP` 우선으로 바꾼다.
- **중 — 토큰 회전·CORS**: 위 "사람 작업 대기"의 `ADMIN_API_TOKEN` 회전과 `ALLOWED_ORIGINS`(현재 와일드카드 — 제3자 페이지가
  방문자 브라우저로 비인증 쓰기·LLM 경로를 두드릴 수 있어 IP 제한이 무력화된다).
- **하** — `bvr_insert_own` RLS에 `document_path` 접두 검사가 없다(API만 검사) → 마이그레이션에
  `document_path IS NULL OR document_path LIKE auth.uid()::text || '/%'` 추가 · `LEGACY_CONSOLE_TOKENS=true`인데 토큰이 코드
  기본값이면 부팅 거부 · Dockerfile 비루트 `USER` · 운영에서 `/docs` 노출 유지 여부 결정 · JWT `issuer` 검증 추가와
  `compare_digest`에 bytes(비ASCII 헤더 500 방지) · 파이썬 의존성 잠금 파일 + `pip-audit` CI · Actions 액션 SHA 고정.
- **양호 — 건드리지 말 것**: 추적 파일·이력에 시크릿 없음 · 전 테이블 RLS + `users.role` 상승 이중 차단(정책+트리거) ·
  SECURITY DEFINER RPC 전부 PUBLIC/anon/authenticated에서 REVOKE · 버킷 비공개·서명 URL 300초·심사 후 증빙 삭제 ·
  IDOR 가드는 토큰 주체만 사용 · 기계 토큰 상수시간 비교 · `sw.js`는 API 미캐시 · open redirect 차단(`safeNext`) ·
  원격 데이터 `dangerouslySetInnerHTML` 없음 · 모델 `pickle.load` 전 sha256 검증 · `npm audit --omit=dev` 0건.

## 마이그레이션 확인

읽기 전용 점검 쿼리(Supabase SQL Editor). 적용 후에는 **`NOTIFY pgrst, 'reload schema';`** — PostgREST가 스키마를
캐시해서 이걸 빼먹으면 새 컬럼·테이블을 한동안 못 보고 백엔드가 폴백 경로로 돈다.

⚠️ **15번(`20260906120000_admin_override_source`)은 코드가 이미 main에 있다**(`3fa2980`, 09-06 배포분).
CHECK 제약이 원격에 없으면 관리자 수동 혼잡 입력(`POST /admin/facilities/{id}/congestion`)이 **통째로 500**이다 —
데모 전에 15번부터 확인할 것.

```sql
with checks(seq, migration, applied) as (values
  (1, '20260710172000_congestion_source_honesty', (select count(*)>0 from pg_constraint
      where conname='congestion_logs_source_check' and pg_get_constraintdef(oid) like '%seed%')),
  (2, '20260719120000_recommendation_snapshot', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='recommendations' and column_name='recommendation_snapshot')),
  (3, '20260721120000_localdata_sources', to_regclass('public.facility_source_refs') is not null),
  (4, '20260819120000_recommendation_trust_loop', to_regclass('public.model_registry') is not null),
  (5, '20260820123000_connect_congestion_collection', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='congestion_logs' and column_name='origin_outcome_id')),
  (6, '20260825190000_add_facility_availability_reports', to_regclass('public.facility_availability_reports') is not null),
  (7, '20260827140000_rbac_roles_and_ownership', to_regclass('public.facility_owners') is not null),
  (8, '20260902130000_role_change_requests', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='business_verification_requests' and column_name='requested_role')),
  (9, '20260904120000_area_demand_points_rpc', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'area_demand_points_near')),
  (10, '20260904200000_business_documents_bucket', exists (select 1 from storage.buckets where id='business-documents')),
  (11, '20260905090000_congestion_logs_column_grants',
      not has_table_privilege('anon','public.congestion_logs','SELECT')
      and has_column_privilege('anon','public.congestion_logs','facility_id','SELECT')),
  (12, '20260903120000_nickname_source', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='users' and column_name='nickname_source')),
  (13, '20260904090000_account_deletion_fk_fix', exists (select 1 from pg_constraint
      where conname='business_verification_requests_user_id_fkey' and pg_get_constraintdef(oid) like '%ON DELETE CASCADE%')),
  (14, '20260904091000_inquiries_insert_ownership', exists (select 1 from pg_policies
      where schemaname='public' and tablename='inquiries' and policyname='inquiries_insert_own_or_anonymous')),
  (15, '20260906120000_admin_override_source', (select count(*)>0 from pg_constraint
      where conname='congestion_logs_source_check' and pg_get_constraintdef(oid) like '%admin_override%')),
  (16, '20261023090000_usage_events', to_regclass('public.usage_events') is not null
      and has_column_privilege('anon','public.usage_events','event','INSERT')
      and not has_table_privilege('anon','public.usage_events','SELECT')),
  (17, '20261024090000_merchant_photos', exists (select 1 from storage.buckets where id='facility-photos' and public)
      and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'set_merchant_photo')),
  (18, '20261024100000_usage_summary', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'usage_summary')
      and not has_function_privilege('anon', 'public.usage_summary(integer)', 'EXECUTE')),
  (19, '20261031120000_crowd_zones', to_regclass('public.zones') is not null
      and to_regclass('public.zone_crowd_snapshots') is not null and to_regclass('public.facility_zones') is not null),
  (20, '20261031130000_guest_crowd_answer_shadow', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='recommendation_outcomes' and column_name='observed_answer_mode')
      and exists (select 1 from cron.job where jobname='nextspot-network-hash-retention')),
  (21, '20261101090000_facility_region_isolation', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='facilities' and column_name='region')
      and exists (select 1 from pg_policies where tablename='facilities'
                   and policyname='facilities_public_region_only' and permissive='RESTRICTIVE')),
  (22, '20261101091000_zone_population_baseline', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'zone_population_baseline'))
)
select seq, migration, case when applied then '적용됨' else '미적용' end as status
from checks order by seq;
```

19·20번은 따로도 본다. 19 — `select count(*) from public.zones;` = 9, 수집이 돈 뒤 `select zone_id, count(*) from public.zone_crowd_snapshots group by 1;`.
20 — `select column_name from information_schema.columns where table_name='recommendation_outcomes' and column_name like 'observed_%';`(`observed_answer_mode`·`observed_at`·`observed_network_hash` 가 보여야 한다) · `select jobname from cron.job where jobname='nextspot-network-hash-retention';` 1행.
21 — `select public.region_isolation_status();` → 1 · `select policyname, permissive, roles from pg_policies where tablename in ('facilities','recommendations','user_feedback') and policyname like '%region_only';` → RESTRICTIVE 3행(`{anon,authenticated}`) · `select tgname from pg_trigger where tgname like '%region%';` → 7행(자식 표 6 + `trg_facilities_freeze_region`) · anon 으로는 `region_isolation_status`·`region_guard_contain` 실행 거부.

## 최근 세션

최신이 위. 10개를 넘으면 가장 오래된 항목을 `archive/HANDOVER_LOG.md` 맨 위로 옮긴다.

## 2026-11-02 — 모바일 앱 계획 답 반영 · CI 시계 의존 테스트 수정

- 도구·브랜치: Claude Code / `yunseong`
- 커밋: `d9c6ad4`(테스트) + 이 기록(문서)
- 한 것: 사용자 답을 [`MOBILE_APP_PLAN.md`](./MOBILE_APP_PLAN.md) 에 반영 — SDK 는 57 로 시작(스토어 빌드 조건을 맞추는 가장 낮은 버전, 2027-04 iOS 27 SDK 전에 58 이상으로), CAPTCHA 끔 확정, 폰 Z Fold7(접힘·펼침 점검 추가)·에뮬레이터 허락, 지도 키는 사용자 Google Cloud, 게스트 문의에 선택 이메일 칸 권장. CI api 잡이 11-02 부터 실패 — S4 때 넣은 보정 라우트 테스트가 고정 날짜 표본을 실제 시계 28일 창으로 잘라 `rank_gate` 가 'insufficient' 가 됐다. 라우트 경로도 고정 시각을 쓰게 테스트만 고쳤다.
- 검증: api ruff · pytest 4004 · check-docs. 다른 파일의 시계 의존 테스트를 찾으려던 시계 이동 실행은 도구 충돌로 접었다(CI 로 잡는다).
- 다음·미결: Expo 조직(M6) 생기면 모바일 1단계. 고정 `NOW` 를 쓰면서 라우트는 실제 시계를 쓰는 테스트가 다른 파일에도 있을 수 있다.
- 사람 작업: "사람 작업 대기" 11-01 모바일 ① 갱신(Expo 조직 · Google Maps 키).

## 2026-11-01c — 모바일 앱(iOS·Android) 재구현 계획(검토 대기)

- 도구·브랜치: Claude Code(조사 에이전트 4 — 화면 목록 · 웹 전용 의존성 · 공유 가능 로직 · 외부 규정) / `yunseong`
- 커밋: 이 기록 포함 1건(문서만 — 코드·스키마 무변경)
- 한 것: 사용자 요청 "현재 NextSpot 을 모바일 앱으로 재구현 — 범위·프레임워크·작업 방식 문서화"(조건: Expo · WebView 금지 · 지도 교체·위치 권한 문구 · EAS → TestFlight·Play 비공개 테스트, 진석 님 권한). [`MOBILE_APP_PLAN.md`](./MOBILE_APP_PLAN.md): v1 = 관광객 화면 전부(사장님·관제·개발자는 웹), Expo SDK 58(첫날 호환 확인, 막히면 57) + Expo Router + react-native-maps(래퍼로 교체 가능), 스타일은 NativeWind·Uniwind 확인 뒤, 웹 `lib` 순수 모듈 97개는 복사 없이 import, `apps/mobile` 은 루트 workspaces 에서 뺀 독립 패키지, 위치 권한 문구 4로케일 초안, 스토어 심사 점검표(4.8 Apple 로그인·토큰 철회, Play 12명×14일, 위치정보법 확인), 에이전트 단계 1~5.
- 검증: 레드팀 에이전트 1개가 코드·공식 문서로 반박 검토(높음 6 · 중간 7 · 낮음 10 — 전부 반영). 결론을 바꾸는 지적은 코드로 재확인: 웹 `lib` 순수 모듈 일부가 API·Supabase 클라이언트를 import(→ Metro 어댑터 치환), 재설정 메일이 PKCE 라 다른 기기에서 실패(→ `token_hash` + `/auth/confirm`), 접속 로그·추천 기록 거리로 위치가 남음(→ M22), 위치 권한 안내 화면은 버튼 하나(Apple HIG). check-docs.
- 다음·미결: ★ 질문 답 → 1단계(호환 확인 · 해석 설정 · Expo 뼈대 + 공용 층 에이전트 3). 위치정보법 법무 확인은 웹에도 걸린다(사람 작업 모바일 ②).
- 사람 작업: "사람 작업 대기" 11-01 모바일 ①(계획 검토 · 스토어 권한 준비) · ②(위치정보법 확인). 10-31c ⑤(Turnstile 켜기)는 M7 답 전 보류 표시.

## 2026-11-01b — 서울 테스트베드 S4: 분산 결정 재생 평가(오프라인) · 지표 약점 4건 보완

- 도구·브랜치: Claude Code(ultracode 워크플로 21 에이전트 + 수정·독립 재검토 에이전트) / `yunseong`(S3 위, main 미반영)
- 커밋: `eec81e5`(KST 달력 · 지표 보완) · `66d6ab9`(재생) · `54f0c43`(리허설 화면) + 이 기록(문서)
- 한 것: 사용자 지시 "홍대 1차 결과까지, 종로는 재실행만 가능하게". 읽기 전용 반출 SQL → CSV 검증 로더(운영 수집 사슬 그대로) → 실제 엔진 경로 재생(미래 정보 없음, 도보 상한 20분 · 라우터 이동) → V3(대안 2곳 이상 결정에서 엔진 − 가장 가까운 곳, 판정 하한 = min(날짜 블록 부트스트랩, 날짜 군집 t)) · V2 절제 · V4 예보 대 지속 → JSON·마크다운·화면 요약. 판정 인자는 CRITERIA 해시(지금 `bc852a570864`, 홍대 검토 뒤 고정)로 묶고, 종로 확인 실행은 `--expect-criteria` 필수 · 커밋 안 된 변경이면 거부. 설계·결정 규칙·한계는 [`SEOUL_TESTBED_PLAN.md`](./SEOUL_TESTBED_PLAN.md) §6 'S4'.
- 검증: 3렌즈 반박 검증 → 수정 2라운드 → 남은 Med 3건 수정 → 독립 재검토(누설·선택 편향·실행 가능성 — High 0, Med 2) → 수정. 합성 홍대 40일·종로 16일을 두 번씩 돌려 바이트 동일, 깨끗한 복제본에서 종로 확인 실행 명령 종료 0. 마지막 트리에서 api ruff · pytest 4004 · build_reset(무변경) · check-docs · web lint 0 error(경고 148 그대로)·typecheck·test 131·build. e2e 는 CI.
- 다음·미결: 홍대 CSV 를 받으면 `run --label pilot` → 1차(예비) 결과 보고 · 집계 요약만 커밋(원본 CSV 금지) → 기준 해시 고정. 홍대는 엔진이 가장 가까운 곳과 갈릴 수 있는 출발지가 홍대 관광특구 하나라 예비·참고 결과다. 결정 대기 Q-S4-1~11 은 기본값으로 돈다. 보정 순위 관문은 보고 전용(Q-S4-3).
- 사람 작업: "사람 작업 대기" 11-01 S4 ①(홍대 반출) · ②(종로 확인 실행).

## 2026-11-01 — 서울 테스트베드 S3: 개발자 전용 내부 지역 · 구역 실측 엔진 연결 · DB 지역 격리

- 도구·브랜치: Claude Code(ultracode 워크플로 24 에이전트 + 수정·검토 에이전트) / `yunseong`(`0747801` 위, main 미반영)
- 커밋: `cc6b299`(DB 격리·region-guard) · `40d6034`(서울 적재·매핑) · `b563db2`(API 지역 판정·엔진) · `50ed9b8`(리허설 화면 개발자 전용) · `d22aeef`(웹) + 이 기록(문서)
- 한 것: 사용자 결정 — 서울은 **developer 만**(admin·심사 계정 포함 그 밖은 0), 서울에선 제보·자리 알림·타임세일·공유·경주 전용 위젯 끔, region-guard 자동 비활성화 켬, 인사동 유지, 순위는 절대 단계. 엔진 검증(리허설) 화면도 서울 실측을 보여 개발자 전용으로 바꿨다(사용자 확인: 관광공모전이 끝나 심사 계정 노출은 필요 없다). 설계·동작은 [`SEOUL_TESTBED_PLAN.md`](./SEOUL_TESTBED_PLAN.md) §6 'S3' 와 커밋 본문.
- 검증: 6 작업 묶음 구현 → 통합 → 4 렌즈(보안·경주 불변·엔진·웹) 반박 검증 → 수정 3회 → 남은 Med 4건·Low 다수를 API·웹 에이전트가 고치고 다른 검토자 2명이 다시 봄(High·Med 0 까지). 마지막 트리에서 api ruff · pytest 3739 · web lint 0 error(경고 148 그대로)·typecheck·test 131·build · build_reset(추가만) · check-docs. 마이그레이션은 PGlite 시나리오(57+ 검사)만 — 실 Supabase 미시험. e2e 는 바뀐 spec 만 로컬, 전체는 CI.
- 다음·미결: 받아들인 잔여 — ① developer 에서 강등된 사람은 자기 서울 추천 행을 브라우저로 계속 읽는다(RLS 소유자 절) — 강등 때 그 행을 지우거나 라벨을 바꾸는 것은 사람 판단 ② 운영 PostgREST 가 임베드 JSON 경로 필터를 받는지 미확인(model-trust 는 실패하면 닫힌 쪽 폴백) ③ 내부 지역 `pack` 을 쓰는 효과 일부(saved 등)는 재확인 때 다시 돈다(무해). S4(재생 평가)는 사용자가 ultracode 로.
- 사람 작업: "사람 작업 대기" 11-01 S3 ①~⑥(사전 확인 쿼리 · 적용 순서 · region-guard · 시험 계정 비밀·적재 · 구역 경계 · 리허설). 계획의 Render 변수 `INTERNAL_REGION_*` 는 없다(코드에 developer 고정).

## 2026-10-31c — 서울 테스트베드 S1·S2·S5·S6 + 게스트 답 그림자 모드(D3) + 문서 답변

- 도구·브랜치: Claude Code / `yunseong`(`4c31b0b` 위, main 미반영)
- 커밋: `47ee20c`..`c1daf72`(12건 — 문서 `47ee20c`·`ef04eef`·`45f5dc9`·`eb3a88b` · 서울 `b6cb50a`·`20096dd`·`c534783`·`65a45ff`·`4052f68`·`22ecc1d`·`8c0de61` · D3 `c1daf72`) + 이 기록(문서)
- 한 것: 상세는 커밋 본문 · [`SEOUL_TESTBED_PLAN.md`](./SEOUL_TESTBED_PLAN.md) §6 진행표 · [`PRODUCT_EVALUATION_PLAN.md`](./PRODUCT_EVALUATION_PLAN.md) §7.
  - 문서 답: 두 계획 문서에 사용자가 단 답·질문(A1·A2·A6·A3·A3', S0 A~E 결과)에 답하고 반영했다. D6 확정(도착 확인 때 쿠폰), D3 은 '받되 2주 그림자 모드 뒤 실시간 여부 결정'. S0 은 사용자 SQL 로 끝났다(5곳 09-20부터 10분, `140000` 적용).
  - 서울: S1 공급원 층 `services/crowd/` + 구역 표 `20261031120000` + 수집기 이중 저장 · S2 9곳(종로 4곳, '인사동'만 — 확인 필요) · 주기 재설계(홍대 권역 10분 · 종로/검증 30분, 주 720 · 최악 864회/일, 동시 조회 4, 조회 45초·실행 80초 마감) · S5 [`CROWD_DATA_CONTRACT.md`](./CROWD_DATA_CONTRACT.md)·통신사 어댑터 틀·합성 격자·계약 테스트 · S6 관리자 '실시간 데이터 리허설'(`pipeline`·`decision_quality`).
  - D3: 게스트 방문 확인 답은 `guest_shadow`(DB 트리거가 `is_anonymous` 로 분류) · 게스트 방문 답에 1인 1표(등록 사용자는 제한 없음) · 네트워크 키(대역 HMAC, 30일 pg_cron) · 측정 `GET /admin/metrics/guest-answers` · 스위치 `GUEST_CROWD_ANSWERS_LIVE`(꺼짐) · Turnstile 기반(키 있을 때만). 구현마다 렌즈가 다른 독립 검토를 돌렸고 `c534783`·`4052f68`·`22ecc1d`·`8c0de61` 이 그 수정이다.
- 검증: 마지막 `c1daf72` 에서 api ruff · pytest 3267 · OpenAPI(추가만) · build_reset(추가만) · web lint(0 error)·typecheck·test 118·build · check-docs. 마이그레이션은 PGlite 시나리오만(실 Supabase 미시험). **커밋 메시지 정정**: `c534783` 의 'pytest 3221' 은 S6 변경이 함께 있던 트리에서 센 값이다. 같은 커밋의 '조회 최악 85초 → 35초' 에서 실제 이전 기본값은 버킷당 6곳(75초)이었고, 35초는 `4052f68` 이 마감(조회 45초 · 실행 80초)으로 다시 고쳤다.
- 다음·미결: main 반영은 오늘 밤 KST(API 먼저 → 웹, 마이그레이션은 API 배포 직후 — 위 "배포 상태"). **S3(엔진 연결)·S4(재생 평가)는 사용자가 ultracode 로 직접** 한다. D3 실시간 전환은 `130000` 적용 2주 뒤 측정으로 정한다. `c1daf72` 보안 검토 지적은 후속 커밋에서 고쳤다. 실시간 전환 전 결정할 것: 게스트+계정 혼합 일치의 약점(L3), 버린 시도의 측정 누락(L7), DB 동작의 CI 검증(L8). S5 남은 결정: 분위수 기준('평소 대비'·'절대 붐빔') · 잠정 임계값.
- 사람 작업: "사람 작업 대기" 10-31c ①~⑧(Render 서울 대상지 변수 · 마이그레이션 2개 · 종로 이름 확인 · Turnstile · 처리방침 · 2주 뒤 전환 결정 · 인사동 확인). 해결된 '서울 수집 0건'·`140000` 적용 줄은 지웠다(S0 확인).

## 2026-10-31b — 승인 없이 할 수 있는 개선안 착수(관제·사장님·추천·영업시간) · 모두의 창업 로컬 트랙 1R 정정

- 도구·브랜치: Claude Code / `yunseong`(`e5703d6` 위, main 미반영)
- 커밋: `a648898` · `fe80cda` · `cfbb1fe` · `9f3c77f` · `5af16c7` · `7a94335` · `97bc930` · `9b65fbe` · 이 기록(9건)
- 한 것: 사용자 지시로 [`PRODUCT_EVALUATION_PLAN.md`](./PRODUCT_EVALUATION_PLAN.md) 개선안 중 결정·사람 작업이 필요 없는 것을 네 에이전트(추천 코어 · 관광객 웹 · 관제 · 사장님)로 나눠 구현하고, 렌즈가 다른 검토 에이전트로 거듭 검증했다. 항목별 상태·후속은 §7.
  - 관제: 운영 화면의 시나리오 값 제거 · 근거 없으면 안전 '판정 불가' · 효과 지표 재정의 · 관리자·개발자 계정 제외. 사장님: 성적표(노출·도착·길안내 정의, 직전 기간 대비, 7/30일, 세일 비용 안내).
  - 추천·관광객: 일요일 휴무 오판 수정 + 웹·API 공용 판정표 · 확인 등급이 모자라면 다음 등급으로 채움(음식점·카페 요청만, A4) · 수락 기록 · '대신 갈 곳 보기' · 유모차 분리 · 임팩트 정리. 영업시간 해석은 운영 대비 나빠진 날 154 → 0(정답지), 보류 세트 꼭 고칠 1건까지 6차에 걸쳐 고쳤다.
  - 문서: 공모전 우수상 · 실서비스 창업 방향 · [`SEOUL_TESTBED_PLAN.md`](./SEOUL_TESTBED_PLAN.md) 재작성(경주 통신사 데이터로 공급원만 바꾸는 구조). 모두의 창업은 사용자 정정으로 **로컬 트랙 1라운드**로 고치고 수상·상용화 선정 취소 조항이 1R 에도 걸린다고 정리했다.
  **동작 변경(공개)**: 효과 지표·임팩트·사장님 노출 숫자가 전보다 작다(정의가 엄격해짐, 의도). 웹이 `stroller` 를 보내므로 **API 먼저 배포**해야 한다(옛 API 는 422 — 웹이 한 번 빼고 다시 보내긴 한다).
- 검증: api ruff · pytest 3028 · OpenAPI 스냅샷(필드 삭제 없음) · web lint(0 error)·typecheck·test 117·build · check-docs · 스키마 파리티. CI e2e 는 `5af16c7` 에서 사장님 화면 key 중복으로 2건 실패 → `97bc930` 에서 고침(로컬 CI 조건 42건 통과).
- 다음·미결: main 반영은 사용자 지시 뒤 KST 밤, **API(Render 수동 배포) 먼저 · 웹 바로 뒤**. 보류: P0-2(D3) · P0-6(D8) · P1-3(서울 — Q1~Q8 답 받음, Q2·Q6 수정안 확인과 S0 A~D 결과 뒤 S1) · P2·P3. 후속 목록은 §7.
- 사람 작업: 모두의 창업 조항 서면 확인(위 "사람 작업 대기" 첫 줄 — 로컬 트랙 2R 마감 · 사업자등록 의무 확인 포함).

## 2026-10-31 — 제품 평가·다음 작업 계획 + 서울 테스트베드 이해 정리(검토 대기)

- 도구·브랜치: Claude Code / `yunseong`(`e8b64ed` 위)
- 커밋: 이 기록 포함 1건(문서만 — 코드·스키마 무변경)
- 한 것: 사용자 요청으로 공모전 이후 할 일을 정리했다.
  - 평가 기준: 2026 공고문 원본 배점(가점 2종·PT 상위 5팀 포함)에 다른 대회(범정부 공공데이터·AI 창업, 병무청 합동, 서울시 빅데이터, 예비관광벤처, 혁신제품)와 품질 프레임워크(Nielsen·ISO 25010·KRDS·KWCAG·UNWTO·ETIS)를 더했다.
  - 평가: 관광객·사장님·기관·공통 관점을 각각 다른 검토 에이전트가 코드 근거로 채점했고, 핵심 주장은 메인 세션이 다시 확인했다.
  - 결과: [`PRODUCT_EVALUATION_PLAN.md`](./PRODUCT_EVALUATION_PLAN.md)(평균 관광객 2.6 · 사장님 2.1 · 기관 2.0 · 공통 3.0, Phase 0~3, 결정 D1~D7).
  - 서울 건은 문서·코드만 읽고 [`SEOUL_TESTBED_PLAN.md`](./SEOUL_TESTBED_PLAN.md)(검토 대기)로 정리했다. 요지: 지금까지는 추정기 검증이고, '분산 알고리즘 유효성'은 새 평가 층(분산 결정 재생)이 필요하다. 질문 10개가 있다.
  - 색인의 `CONGESTION_ENGINE_PLAN.md` '초안' 표기를 바로잡았다.
- 검증: check-docs. 일요일 휴무 오판은 `open_status_at_arrival` 직접 실행으로 재현했다(위 "알려진 이슈").
- 다음·미결: 사용자 검토 뒤 Phase 0(일요일 휴무 버그 · 게스트 방문 확인 체감 혼잡 · 운영 시나리오 값 제거 · 안전 '판정 불가' · 문구 정리)부터.
- 사람 작업: Phase 0-7 의 세 건(`JWT_SECRET` 시크릿 · Render Deploy Hook · 서울 수집 점검 SQL)은 이미 "사람 작업 대기"에 있는 항목이다.

## 기록 규칙

세션이 끝나면 "최근 세션" 맨 위에 아래 템플릿으로 추가한다. 제목 형식은 `## YYYY-MM-DD — 제목`(같은 날 두 번째는
`YYYY-MM-DDb`, 세 번째는 `c`). 번호를 매기지 않는다 — 번호는 충돌한다(로그 파일의 -20·-27·-28·-29가 그 흔적).

```markdown
## YYYY-MM-DD — 제목 한 줄
- 도구·브랜치: Claude Code / yunseong
- 커밋: abc1234..def5678 (n건)
- 한 것: (3줄 이내 — 상세는 커밋 본문에)
- 검증: pytest N passed · ruff · web lint/typecheck/test/build · check-docs
- 다음·미결: (다음 세션이 이어받을 것)
- 사람 작업: (외부 콘솔 작업이 생겼으면 "사람 작업 대기"에도 추가)
```

- "배포 상태"의 main 해시와 확인 날짜는 배포를 눈으로 확인한 사람이 갱신한다.
- "사람 작업 대기"·"알려진 이슈"는 끝나면 줄을 **지운다**(완료 표시로 남기지 않는다). 이력은 커밋과 로그 파일에 있다.
- 항목이 10개를 넘으면 가장 오래된 항목을 통째로 `archive/HANDOVER_LOG.md`의 안내문 아래에 붙인다. 이 문서는 400줄 이하.
