# HANDOVER — 현재 상태 (정본)

> "지금 어디까지 왔고 무엇이 남았나"만 담는다. 2026-08-28까지의 세션 기록(§-45 → §6, 음수 번호가 최신)은
> [`archive/HANDOVER_LOG.md`](./archive/HANDOVER_LOG.md)에 그대로 있다. 이 문서는 400줄을 넘기지 않는다 —
> 넘치면 "최근 세션"의 가장 오래된 항목을 로그 파일 맨 위로 옮긴다(`scripts/check-docs.mjs`가 강제).

## 배포 상태

- **main = 프로덕션.** main push가 Vercel(web)·Render(api)를 자동 배포한다. **2026-10-07 15:47 KST main `c347129..05af862`(CI 만 — e2e 잡 상한 15 → 30분) — main CI green(run 37583488645, 4잡), Vercel 프로덕션 `dpl_BQEyd1sREmLTUDpYWtRwZZmo3ij4` READY(웹 코드 무변경). 10-09 클라우드 세션 재확인: origin/main·Vercel id 그대로, 예약 워크플로 정상(학습 제외 — 아래 2026-10-09). 되돌림 = Vercel `dpl_4VwJyqBNkn5yYZqsNKrGiPJf41mn`(push 2).** 그 전 **2026-10-07 15:31 KST main `f031140..c347129`(push 2 = 배치 B1~B5 웹·문서만, PR #11, 아래 2026-10-07) — PR CI green(e2e 12분 43초), Vercel 프로덕션 `dpl_4VwJyqBNkn5yYZqsNKrGiPJf41mn` READY 15:32, Render 는 재배포하지 않음(API 파일이 안 바뀌면 다시 뜨지 않는다 — 10분 `/health` 40회 200, 프로세스 그대로), 라이브 확인: 데스크톱 랜딩 '이렇게 써 보세요' 바로가기 5·자동 팝업 없음, 🔮 혼잡 예측 '+2시간 후' → '+2시간 후 예측' 배지 2.7초·카드 '+2시간 후 기준', 첫 카드 1.6~2.9초(배포 직후 첫 1분은 24초 — 캐시 빔), /waiting 다수결 한 줄, 사장님·관제 데모, 5명 동시 첫 방문 5xx·429 0. 되돌림 = Vercel `dpl_Gx96gkGe2D7ZAEdRoTefpc3W1dcs`(push 1). 그 전 2026-10-07 01:29 KST `0be9872..f031140`(push 1 = B0 + 배치 A + C1, PR #10, 아래 2026-10-06) — CI green, Vercel `dpl_Gx96gkGe2D7ZAEdRoTefpc3W1dcs`, Render 재시작 01:30·`/health` 44회 200, 골굴사 검색 127693, 데스크톱·폰 스모크.** 그 전 origin/main 은 `0be9872`(10-02 `release/1002`, 아래 2026-10-02 — 이 줄에 배포 확인 기록 없음). 그 전 확인된 반영은 2026-09-30 01:24 KST `dd2afc9`(사용자 푸시, `f0f440b` 위 fast-forward) — 추천 카드 합성 id 수정 `afa4ec0`(아래 2026-09-29b) · P3 배치 B csr 커널(스위치 꺼진 채 memo — API 동작 불변, 아래 2026-09-29c) · 문서. CI green(4잡, e2e 포함 01:28 KST) · Vercel 번들에 `afa4ec0` 확인 · Render `/health` 새 프로세스(참조 스냅샷 ready·1,684곳, `parking_history` rpc) — 데스크톱 확인 09-30 01:30. 그 전 2026-09-29 오후 `f0f440b`(= `release/0930`, CI green 15:44 KST) — API 재설계 P3 배치 A(아래 2026-09-28e) · 대기 보드 웹 27건(아래 2026-09-29). Vercel 은 이 번들을 낸다(09-29 23시, i18n 청크 해시가 로컬 빌드와 같음 — 데스크톱 확인). Render 배포 커밋은 `/health` 로는 안 보인다(`reference_snapshot` ready·1,684곳, `parking_history.mode=rpc`). 그 전 2026-09-29 새벽 야간 배치 — API 재설계 P2a(주차 이력 행렬 · 스위치 `AREA_DEMAND_SOURCE` 기본 `rpc` = 손님 쪽 동작 불변, 아래 2026-09-28d) · Wikimedia 사진 출처 줄·ⓒ 표시 자리 · P0b 웹 7건(아래 2026-09-28c). 그 전 2026-09-28 P0c 일배치·수집 경보(`367514c`, 아래 2026-09-28b). 그 전 같은 날 API 참조 스냅샷 P0a·P1(`fd5af2d`..`4d56afa`, 아래 2026-09-28 — 사용자가 직접 푸시, Render 가동 확인: `/health.reference_snapshot` ready·1,682곳, 지도 TTFB 0.24~0.54초·304 동작). 그 전 2026-09-27 TourAPI 일배치 재시도(`58c8bfc`). 그 전 같은 날 Supabase 키 공백 정리(아래 2026-09-26c 끝). 그 전 2026-09-26 Supabase 연결 격리(`bd44110`, 아래 2026-09-26c). 그 전 같은 날 관제 대시보드 추정·예측·시나리오 모드(`990b315`..`c2f97ad`, 아래 2026-09-26b). 그 전 같은 날 운영 긴급 수정·메모리·관광객 CPU(`0ae42b8`..`6b80f50`, 아래 2026-09-26). 그 전 2026-09-25 API OOM 대응(`0408bd7`..`0ce394d`). 그 전 2026-09-22 `ec127ee`, 09-21 —
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
  다른 문서·기록은 '0.5 CPU/512MB'(유료 Starter 모양)로 적는다 — 실제 플랜은 Render 대시보드로만 확인된다(10-09 미확인).
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

1. **심사 기간 운영 유지** — 1차 심사자료는 09-21 제출 끝. 1차 기능 심사는 10월 중(날짜 미공지 — 심사위원이 라이브 URL 에
   혼자 들어와 심사 계정으로 로그인, TourAPI 호출 이력도 본다) · 10-21 본선 발표 · 10-28 발표 심사 · 11-05 시상(PM 안내 기준 —
   저장소 문서에는 없다). 세션마다 `/health`·Actions·04:00 적재를 확인하고, API 를 건드리는 푸시는 KST 밤에만.
   데모 전 체크리스트는 [`contest/DEMO_SCENARIO.md`](./contest/DEMO_SCENARIO.md) §0.
2. **사람 작업 대기** 처리 — 특히 `JWT_SECRET` 시크릿(주간 학습), 배치 D 의 D3·D6, 실사진 DB 정리 ①~③ 적용 여부(아래).
3. **심사 화면 3차(웹만)** — 라이브 재감사 → 웹 수정 → PR(아래 2026-10-09 "다음·미결").
4. **`fix/llm-rate-limits-1002`** — "알려진 이슈" ③ 의 구현. main 위로 다시 올리고 게이트 → KST 밤(API 변경).
5. 심사 뒤: "알려진 이슈" ①·② 결정 · 보안 진단 상·중 항목 · `ingest.yml` 리포트 artifact 보존 ·
   `apps/web/lib`·`apps/api/app/services` 점진 이동(`AGENTS.md` "새 파일은 어디에") ·
   [`archive/IMPROVEMENT_PLAN.md`](./archive/IMPROVEMENT_PLAN.md) "2026-08-21 갱신" 절 미완 항목 재확인.

## 사람 작업 대기

외부 콘솔 접근이 필요해 코드로 못 하는 일. 끝나면 줄을 지우고 "최근 세션"에 한 줄 남긴다.

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
- [ ] **서울 수집이 0건이다 — 원인 확인**(2026-09-20 20:38 KST 기준 `seoul_citydata_snapshots` 0행).
      표는 생겼고 Render 배포·인증키도 들어갔으며 API 엔드포인트도 살아 있다(401 = 인증 필요, 404 아님).
      남은 후보는 **수집 URL 시크릿 미설정**이 가장 유력하다. SQL Editor 에서 순서대로:
      ```sql
      -- 1) 잡이 걸려 있나
      select jobname, schedule, active from cron.job where jobname like 'nextspot-seoul%';
      -- 2) URL 시크릿이 있나(없으면 3번을 실행한다)
      select name from vault.decrypted_secrets where name like 'nextspot_seoul%';
      -- 3) 수집 URL 연결(한 번만)
      select public.configure_seoul_citydata_collection(
        'https://nextspot-api.onrender.com/api/v1/engine-validation/seoul/collect');
      -- 4) 지금 한 번 호출
      select public.request_seoul_citydata_collection(false);
      -- 5) 결과 확인(10초쯤 뒤)
      select status_code, left(content, 300) from net._http_response order by created desc limit 3;
      select area_nm, bucket_at, congest_lvl, live_lot_count, level_est
        from public.seoul_citydata_snapshots order by bucket_at desc limit 10;
      ```
      5번이 200 이고 표에 행이 생기면 이후는 10분마다 자동이다. 401 이면 Vault 의 서비스 토큰이
      Render 의 값과 다른 것이고, 503 `seoul_key_missing` 이면 Render 환경변수가 아직 반영되지 않은 것이다.
- [ ] **`20260920140000_seoul_citydata_retry_budget.sql` 적용** — 인증키 일 한도가 **1,000회**로 확인됐다(사용자).
      대상지 5곳 · 주 호출 10분 주기 = 하루 720회라 정상일 때는 맞지만, 주 호출이 계속 실패하는 날에는
      보충 호출(현재 10분 주기)이 720회를 더 써 한도를 넘긴다. 이 마이그레이션이 보충만 시간당 2회로 줄여
      최악의 날도 960회로 묶는다. 주 호출 주기는 그대로 둔다(검증 지표가 10분 버킷 위에 있다).

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
  `preferences/parse`(상) → `/reports/*`(중) → `/voice/turn`·`events/track`·`search/ingest-request`.
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
- **중 — 게스트가 혼잡 근거를 오염시킬 수 있다.** `/reports/congestion`·`/reports/availability`가 `is_anonymous`를 검사하지
  않고 쿨다운 키가 (user, facility)라 새 익명 세션마다 우회된다. 두 게스트가 맞장구치면 `corroborated`가 된다.
  조치: `routers/account.py`처럼 비익명 요구 + IP 키 쿨다운.
- **중 — X-Forwarded-For 해석 방향 미검증.** 세 리미터(`search.py`·`tracking.py`의 `_client_ip`, `recommendations.py`의 `_voice_client_ip`)가
  마지막 항목을 쓴다. Render가 hop을 덧붙이면 전원이 한 키(자기 DoS), 아니면 첫 항목이 위조 가능. 조치: Render에서 원 헤더를
  1회 로깅해 모양을 확인한 뒤 `CF-Connecting-IP`/`True-Client-IP` 우선으로 통일.
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
      where conname='congestion_logs_source_check' and pg_get_constraintdef(oid) like '%admin_override%'))
)
select seq, migration, case when applied then '적용됨' else '미적용' end as status
from checks order by seq;
```

## 최근 세션

최신이 위. 10개를 넘으면 가장 오래된 항목을 `archive/HANDOVER_LOG.md` 맨 위로 옮긴다.

## 2026-10-09 — 클라우드 세션 상태 재확인 · HANDOVER 동기화(문서만) · 심사 화면 3차 중단 기록

- 도구·브랜치: Claude Code(클라우드) / `claude/nextspot-continuation-hiebei`(origin/main `05af862` 위, 문서만 — PR #12) · 코드는 PR #13 `fix/llm-rate-limits-1009` · PR #14 `fix/judge-view-r3`
- 커밋: d46cddc + 이 갱신
- 한 것: 상태 재확인 — origin/main `05af862` 그대로 · 그 CI(run 37583488645) green · Vercel 프로덕션 `dpl_BQEyd1sREmLTUDpYWtRwZZmo3ij4` = `05af862` READY · 열린 PR·이슈 0 · 04:00 적재는 10-07·10-08 첫 시도 실패 → 자동 재시도 성공, 10-09 첫 시도 성공 · `area-demand-alert` 전부 성공 · 주간 학습 7회 연속 실패(원인 `JWT_SECRET` — "사람 작업 대기"). 라이브 `/health`·웹은 **못 봤다**(클라우드 환경 egress 정책이 `nextspot-api.onrender.com`·`nextspot-nu.vercel.app` 을 막음).
  문서: D2-④ 숨기기(교육청 발명체험교육관 TourAPI 3453929)는 10-08 ~19:25 KST PM 이 적용 — 대기 줄 삭제(DB 는 이 세션이 읽지 못해 미확인) · 우선순위를 심사 기간 기준으로 · Keep-Warm 실제 간격 · `plan: free`·빌드 필터 없음 · 학습 실패 원인.
- 검증: check-docs
- 3차 감사(같은 날 저녁, 클라우드): 10-07 노트북 3차는 10-08 19:25 KST 세션 한도로 끊겨 산출물 없이 사라졌고(캡처는 노트북에만) 새로 했다. 라이브 05af862 를 데스크톱 1366·1536·1920 · 폰 390·360 × ko·en·ja·zh × 라이트·다크 × 11화면 = 139쪽 캡처(익명 세션 1개, API 는 첫 호출만 실제·나머지 캐시 재생 — Render 실호출 수십 건) + 카드 상호작용 실측. **환경 제약**: Kakao 지도 SDK·사이트 글꼴(jsDelivr)·TourAPI/Wikimedia 사진 호스트가 egress 정책에 막혀 지도·사진·글꼴은 못 봤다(잘림 판정은 근사). push 1 뒤 메모 중 이미 해결: 1536×730 '상세 정보 펼치기' 첫 화면 안(하단 557px, 1366·1920 도) · SPOT 설명은 카드 흐름 안 상자(펼쳐도 버튼 674px) · 폰 펼친 카드 위끝 173/160px 로 검색창(107px) 안 가림 · ♿ 저장 뒤 하이드레이션 오류 없음 · /waiting 빈 상태 행동형 문구 · 관제 데모 알약 단일 · 브랜드 404 · 콘솔 데모 입구. 새로 찾아 고친 것(PR #14 `fix/judge-view-r3`, 웹만): '경주가 처음이라면' 신라 핵심 산책·한옥 카페가 눌러도 무반응(기준점 별칭 '대릉원(천마총)' ↔ 운영 이름 '천마총(대릉원)') · 코스가 여행 시간 때문에 비면 막다른 길 → '여행 시간을 {n}분으로 늘려 다시 찾기' · 마이페이지 게스트 이름·연결 문구가 en·ja·zh 에서 한국어. PM 결정으로 넘김: 가정 시간을 바꿔도 1위가 그대로(웹은 다시 요청, 서버 순위 — 21번) · en·ja·zh 장소 소개 한국어 원문(I32) · 코스 첫 정류지 '추정 혼잡' · 첫 카드에 혼잡 정보 없음(24시간 넘은 관측 숨김) · 콜드 캐시 로딩 · 대기 분 올림/반올림. 외부 평가 2건(PM 공유, 71·79점)의 항목은 라이브로 하나씩 대조 — 콘솔 로그인 필요·404·마이 임팩트 무반응·축제 재열기·부정 문구('영업시간 미확인'·'N일 전 기준')는 이미 해결이거나 재현 안 됨.
- 다음·미결: `fix/llm-rate-limits-1002` 는 main 위로 다시 올려 PR #13 `fix/llm-rate-limits-1009`(search.py 충돌 해결, CI 전부 초록 — e2e 포함) — main 반영(API 재시작)은 PM. 원격 `-1002` 는 지워도 된다. 노트북 전용 `perf/waiting-board-1002`(`f7471f2` 유형별 리팩터 · `2cde078` `/waiting` 한 요청 보드, `WAITING_BOARD_ENDPOINT` 기본 꺼짐)은 심사 뒤, 원하면 PM 이 원격에 올린다 · Keep-Warm 이 4~7시간마다라 심사일 캐시 예열을 믿을 수 없다 — pg_cron 이 `/api/v1/warmup` 도 10분마다 부르는 잡(마이그레이션 + SQL Editor 적용)을 PM 결정으로 · 실사진 DB 정리 ①~③ 적용 여부 미확인(10-03 전 예정이었다) — 적용됐으면 줄을 지우고 ⑤ 변수 확인.
- 사람 작업: Actions Secret `JWT_SECRET`(+ 시크릿 5개 확인) · Render 대시보드에서 실제 플랜과 Build Filters 확인 · 클라우드 세션 환경의 허용 도메인에 `nextspot-nu.vercel.app`·`nextspot-api.onrender.com`·`*.supabase.co`(라이브 확인·3차 감사 전제) · PR #12·#13·#14 main 반영(이 세션의 main 푸시는 권한 분류기가 막는다 — GitHub 에서 병합하거나 권한 규칙 추가) · 3차 화면 확인용 추가 허용 도메인 `dapi.kakao.com`·`*.daumcdn.net`·`cdn.jsdelivr.net`·`tong.visitkorea.or.kr`·`upload.wikimedia.org`

## 2026-10-07 — 심사 화면 배치 B(B1~B5): 랜딩 바로 가기 · 추천 카드·음성 비서 · 혼잡 예측 줄 · 콘솔 배치 · 대기 보드·대안·코스 → `fix/judge-view-1007`

- 도구·브랜치: Claude Code(데스크톱) · 레인 4개 병렬 구현(레인마다 독립 리뷰 → 수정) + 통합 / `fix/judge-view-1007`(main `f031140` 위에 `jv2/core2`·`jv2/landing`·`jv2/consoles`·`jv2/pages` 를 이 순서로 `--no-ff` 병합 — 레인 커밋 33건)
- 커밋: 1c661b0..f13f1ff (병합 4건 + 통합 후속 3건) + 이 기록 + 리뷰 수정 `f4dc88b` 과 그 기록. **웹만**(API·DB 변경 없음)
- 한 것: **B1** 데스크톱 랜딩 = 두 칸 히어로(바로 시작·데이터 띠) + '이렇게 써 보세요' 다섯 줄(기능설명서 §5 순서 — 1~4번은 `/main?focus=`, 5번은 사장님 콘솔·관제 대시보드), 데스크톱 자동 모달 없음(폰은 첫 방문 한 번), 진행 중 축제만 배너. **B2** 카드 앞면 = 가치 상자 · 사진 · '실시간 정보 새로고침' · 이름 + 60px SPOT 배지(누르면 40/40/20 상자) · 혜택 칩 · 출발→도착 · '상세 정보 펼치기'(첫 화면), 근거 원자료는 '추천 근거 자세히' 뒤, 첫 카드는 서버 1위를 스켈레톤으로 최대 3.5초, 'AI 음성 비서' 알약·자막 막대, '양식 먹고 싶어' = 🍽 칩, 음성은 고른 언어로(I21). **B3** 화면 아래 '🔮 혼잡 예측' 줄(지금·+1·+2·+3시간 후, 끌기·방향키) + 예측 배지 + 추천 핀 예측 등급 재채색(PM 4.2a) · 등급 핀(24시간 안 실측만 칠함, 순위 핀 금테·번호) · 조건부 범례 · 두 줄 툴바(🍽 메뉴 ▾ · 출처 칩 하나) · 폰 머리 ≤280px. **B4** 사장님 콘솔 두 열 · 폰 바로 가기 바 · 진행 중 배너('추천 반영 중' · '손님 화면에서 보기' → `/main?place=`) · 0 없는 성적표, 관제 ①→②→③ 순서 · 단계 바 · KPI 32px · 관광객과 같은 히트맵 척도 · 리포트 A4 인쇄 · 폰 '관제 메뉴' 서랍(I30). **B5** /waiting 한 등급 보드는 한 줄·한산 먼저·'대신 갈 곳 보기', /explore 머리글 하나·누른 곳 둘레 같은 종류·앞면 혜택만, /course 정류지 먼저·도착 시각, /mypage 레이더 4로케일, 일·중 조판, 익명 로그인 거절 뒤 재시도 창·자가 회복(I22).
- 통합: 충돌은 4로케일 JSON 뿐(키 단위 3-way — 같은 키는 `card.whyToggle` 하나, e2e 가 기대하는 pages 값). 후속 `d6c7d12` — 지도 위에서 연 소개 모달 바로가기가 /main 에 불을 켜게(`onMainFocus` 구독) · 랜딩 '바로 시작' cta-primary · 1번 줄 설명 '붐빔을 색으로' · /waiting '지금' 곡선 = 세션 곡선(혼잡 예측 줄과 같은 값) · 일·중 랜딩 제목이 한국어보다 커지지 않게 · 여행 조건으로 칩 후보가 0곳이어도 검색·핀으로 고른 카드는 남김. 새 e2e `doc-crosswalk`(`51eb6fd`) — §5 다섯 기능과 입구를 문서의 말 그대로 1536×730·390×844 에서. `f13f1ff` — /explore/recommend 가 주소의 좌표로 시작(대기 보드에서 누르면 경주 중심 기준 추천 POST 가 한 번 더 나가던 경합, 통합 e2e 가 잡음).
- 동작 변화(PM 확인용): 데스크톱 첫 화면이 히어로 + 바로 가기(자동 모달 없음, 빈 곳 클릭으로 시작 안 함) · 카드 앞면 배치 전부(사실은 한 번만, 원자료는 '추천 근거 자세히' 뒤) · 첫 카드 최대 3.5초 스켈레톤(서버 0곳·오류면 즉시 카드) · 보라 오브 → 'AI 음성 비서' 알약 · 음식점 기본 탭에서 술집 태그(camelCase 포함) 제외 · 가정 시간 고르기는 '다른 시간 ▾' 안(툴바 select·'가정:' 알약 없음) · 핀 모양·히트맵 덩어리 줄어듦 · 툴바 두 줄·메뉴 드롭다운 · 주 버튼 색 짙어짐 · 콘솔 레이아웃·관제 순서·히트맵 색 · /waiting 한산 먼저 · /explore·/course 앞면 정리 · /explore 는 대기 보드에서 와도 추천 요청 한 번(전에는 가끔 두 번) · en 'Walk there'·'Est. crowd' · 일·중 시스템 글꼴. **관심 없어요 뒤 다음 카드는 '베스트 추천'**(거절한 곳을 뺀 목록의 1위 — 계획 표의 '2번째 추천' 과 다름, 음성 '다음' 은 '2번째 추천'). **빠져 있던 것(리뷰 10-07)**: ⚠️ **밤의 첫 화면 자동 칩 전환은 계획 밖(B2 에 없음, phase 1 이 일부러 뺀 것) — PM 결정 필요**: 첫 /main 에서 온보딩 칩에 카드가 없으면(주로 밤·다크 시간) 칩을 지금 문 연 곳이 많은 쪽으로 스스로 옮기고 '지금 문 연 곳이 많은 {칩}부터 보여드려요' 알림(/setup 에서 고른 칩을 덮는다). 거절이면 `maybeSwitchFirstView` 를 끈다 — 빈 칩은 A5 제안 카드가 덮는다 · 검색 결과는 Enter·음성 검색일 때만 카드가 된다(`0771b02`) · 축제 0건이면 🏮 칩 숨김 · '손님 화면에서 보기' 는 새 탭 · 수락·거절 뒤 세션에 한 번 '취향 프로필에 반영했어요 · 보기' 알림 · ko 음성은 점수가 가장 높은 한국어 목소리(`pickVoice`, 예전 첫 ko-KR) · 관제 '관측 대기' 표기 삭제(I72).
- 검증: web lint 0 errors(경고 153)·typecheck·test 105파일·build · e2e 전체 494건(3320, 워커 2) — 첫 회 492 통과·2 실패: fixed-overlays 음성 버튼 1건은 단독 재실행 통과(흔들림), recommend-fallback-type 1건은 진짜(/explore 좌표 경합 — `f13f1ff` 로 고침, 고치기 전 같은 화면 4번에 1번 재현·고친 뒤 12/12) → 고친 뒤 전체 494/494 통과 · 새 doc-crosswalk 16건 · `d6c7d12` 의 조건 밖 검색 카드는 doc-crosswalk 가 고치기 전 실패 · api ruff + pytest 2478 · check-docs · RESET_AND_SETUP 재생성 무변경 · 실서버·라이브 부하 없음(전부 스텁)
- 리뷰 수정(10-07 `f4dc88b`, 통합 뒤 독립 리뷰 27건 → 이 브랜치): **대기 보드 다수결 한 줄** — 카드 80% 이상이 같은 등급이면 '지금 경주 시내 중심 {등급} · 추정' 한 줄 + 그 카드들은 '도보 N분', 다른 등급 카드만 자기 등급(새벽 23장 '보통' + 1장 '여유' 가 23번 되풀이되던 것) · **'이 일대' 한 규칙** — /main 칩도 시내 중심 반경 1.5km 장소들의 가운데값(예전엔 경주 전역 가운데값이라 /main '여유' · 대안·대기 '보통'), 추정 피드는 /main·/waiting·/explore 가 4분 동안 한 스냅숏을 나눠 쓴다 · **앞면 취향 일치율은 장소를 가를 때만**(60% 이상 · 후보마다 다를 때 — 게스트 '취향 51% 일치' 가 모든 카드·미리보기·음성·대안 칩에 붙던 것, SPOT 상자·근거에는 남음) · **사장님 ① 콜아웃은 차트의 최저점만**(그 점이 10~21시 밖이면 없음 — 06:50 '10시가 가장 한가' 가 오르기만 하는 차트와 어긋났다) · **호출** — '손님 화면에서 보기' 새 탭(`?place=`)은 세션 프리페치를 하지 않음, 혼잡 예측 줄이 받은 정시를 /waiting 곡선이 다시 묻지 않음(정시 단위 세션 캐시) · **화면** — /explore·/waiting·/course 주 버튼 cta-primary · 레이더 축 ko '무장애'·en 'Barrier-free' · 펼친 미리보기 손잡이에 '추천 간단히 보기' 글자 · 데스크톱(≥1024) 음성 자막은 카드 왼쪽 지도 위(가치 문장을 덮지 않음) · /explore 음성은 먹빛 '🎙 AI 음성 비서' 알약(폰은 둥근 🎙, 목록 오른쪽 56px 를 비워 카드를 덮지 않음) · /waiting 폰 두 칸, 1~2곳 섹션은 전폭 · 데스크톱 /main 알림은 예측 줄 위 · +N 카드 머리 '이 시간대 추천'(예전 '가까운 추천' — 걸어서 16분에도) · 폰 미리보기 '🕒 +2시간 후' · 관제 데모 폰 단계 바 고정 · 대안 전환율 표 폰 3칸 · 레이더 '실시간 학습 반영' 은 이 브라우저에서 수락·거절·좋아요/별로예요 뒤에만 · en 검색 'Search Gyeongju places' · 'New here?' · 사진 없는 음식점 표지는 나란한 수저 · ja·zh 폰 예측 칸 짧은 이름('+2時間'·'+2小时' — D2 화면을 찍다 칸 넘침 발견). 시험: 다수결·가운데값·이 일대·앞면 취향·콜아웃·레이더 배지 단위 + e2e(다수결 보드, 데스크톱 자막 자리, `?place` 새 탭 무프리페치, 둘째 줄을 축제·화장실 칩까지 세운 채 잘림 0 — 4로케일 × 1366·1536, ja·zh 폰 칸, 대안 카드가 🎙 밑으로 안 들어감, 여정 호출 수 `journey-budget`), merchant `?place` 시험의 조건부 건너뛰기 삭제. 규칙이 바뀌어 고친 고정값: photo-fallback·waiting-uniform 보드는 등급을 갈라 둠, photo-credit 카드 줄은 testid, judge-copy 취향 0.51→0.81(51% 숨김 시험 추가), place-search en 문구, 콜아웃 시험의 새벽 3시 섞인 곡선은 이제 콜아웃 없음. **여정 호출 수(정적 빌드 · 스텁)**: 랜딩→/setup→/main→+2시간 후→카드→/waiting→사장님 콘솔 = **34회**(랜딩 5 · setup 1 · /main 12[세션 프리페치 5 포함] · +2h 3 · /waiting 13[보드 4 · 곡선 5 · 골든아워 4] · 콘솔 데모 0), 고치기 전 36 — 계획 12회와의 차이는 D2 ③ PM 결정. 손대지 않음: 관광지 1위 데이터(D2 ④) · 폰 순위 핀이 머리 밑에 걸리는 것(보이는 띠로 지도 맞춤 — 첫 화면 지도 틀·♿ 맞춤 시험과 얽혀 미룸) · `/main?focus=forecast` 히트맵이 거의 비는 것(PM 선택: 그대로 / +1·+2시간 미리 고르기) · TourAPI '21시간 전 동기화'(04:00 적재 확인 — 운영). 검증: web lint 0 errors(경고 153)·typecheck·test 107파일·build · e2e 전체 502/502(3320, 워커 2 — 첫 회 495 통과·3 실패는 /waiting 레이아웃·다수결에 묶인 시험, 고친 뒤 통과) · check-docs · 화면 다시 찍음 `after2/integrated`(d04~d15·d22~d25·p05~p16 + D2 묶음 `d2_{ja,zh}_{light,dark}_{face,forecast_2h,why}__{1536,390}`, 라이브 읽기 28회 탐색·쓰기 차단).
- 다음·미결: **미룬 것** — 툴바 둘째 줄 축제 이름 칩('🏮 {축제 이름}', 랜딩 레인의 compact 모양은 있음 — 지금은 '🏮 축제 N' 칩) · 차가운 심사 여정 Render 12회 예산(정적 빌드로 잰 34회 — 위 리뷰 수정 줄, D2 ③) · 5세션 동시 스모크(배포 직후 KST 밤) · I32 번역 없는 소개 숨김(C2 미승인) · 15번 수락률 재정의(안 함) · 순위를 바꾸는 API(21번, 심사 뒤) · 대기 분 올림/반올림 통일 · 관제 로그인 버튼 대비(I86 범위 밖) · 1366×650 사장님 ④ 좌석 버튼은 오른쪽 열 안에서 조금 스크롤 · 죽은 키 `guide.sourceTour`. **PM 서명 대기(D2)** — 화면 묶음 `scratchpad/judge1006/after2/{core2,landing,consoles,pages}`(목업) + `after2/integrated`(라이브 데이터, ja·zh 카드·예측 줄·근거 라이트/다크 390/1536 포함) — 같은 서명에서 결정 4가지(위 '사람 작업 대기' D2).
  **배포 순서·되돌림**: 웹만이지만 main 푸시는 Render 도 다시 띄운다(`render.yaml` 에 경로 필터 없음) — **KST 밤에만**, PM 승인 뒤. 푸시 전 Vercel 현재 프로덕션 id(지금 `dpl_Gx96gkGe2D7ZAEdRoTefpc3W1dcs`)를 적는다. 되돌림: Vercel instant rollback 으로 그 id, 또는 `f031140..` 범위를 최신부터 `git revert`(병합 4건은 `-m 1`, 통합 후속이 병합 내용에 기대므로 병합만 골라 되돌리지 않는다). 배포 뒤 1536×730·390 라이브 스모크(F1~F5 를 문서의 말로, ⓒ한국관광공사 출처 4화면, 심사 계정 2개 첫 화면 — D6).
- 사람 작업: D2 화면 서명 · D6(배포 뒤) — "사람 작업 대기" 맨 위 배치 D 줄.

## 2026-10-06 — 심사 화면 "더 쉽게 눈에 띄게": 심사위원 시점 감사 → B0 + 배치 A + C1 통합 → `fix/judge-view-1006`

- 도구·브랜치: Claude Code(데스크톱) · 감사 워크플로(심사위원 시점으로 기능설명서 §5 다섯 기능을 1536×730·390 에서 실측 → 계획 → 레드팀) + 레인 6개 병렬 구현(레인마다 독립 리뷰 → 수정) + 통합 / `fix/judge-view-1006`(origin/main `0be9872` 위에 `jv/core`·`jv/waiting`·`jv/nav`·`jv/merchant`·`jv/admin`·`jv/api` 를 이 순서로 `--no-ff` 병합 — 레인 커밋 47건)
- 커밋: 4de5a73..6f01510 (병합 6건 + 통합 후속 5건) + 이 기록
- 감사: 데스크톱 심사위원은 카드 첫 줄이 스스로를 부정하고("지금 첨성대 혼잡 → 대신 첨성대"), 카드 표면에 내부 산식·"서울 실측 보정"·46일 전 관측이 보이며, 사장님 콘솔·관제 대시보드 입구가 없고, 실계정 사장님 콘솔에 ① 예상 혼잡이 없다. 계획은 28개 결정의 권장안을 따른다(15번 수락률 재정의 제외).
- 한 것(레인별): **core** B0 폰 카드 미리보기·관광객 말 SPOT 근거 + A2 첫 줄은 정말 덜 붐비는 *다른* 곳일 때만 화살표(아니면 '도보 N분 · 도착 시 영업 · 취향 N% 일치')·24시간 넘은 관측 숨김·서울 표기 제거 + A3 근거 원자료는 '상세 정보 펼치기' 뒤 + A4 시간 칸=칩의 합·'상시 개방'=영업·'영업시간 미확인' 칩 없음·시간 줄 나눔·전화 `tel:`·미학습이면 /predict/day 안 부름 + A5 카테고리 칩·♿ 막다른 길 없음 + A7 검색 결과를 검색창 바로 아래에 출처와 함께 + A12 토스트·주차 출처·SPOT 점수·분산 코스·경주 밖 안내. **waiting** A8 대기 보드 첫 섹션부터 그리기·문구. **nav** A1 레일·폰 줄 콘솔 입구, 심사용 사장님 로그인 → /merchant, 게스트 /merchant 로그인 카드 · A6 /setup 시작하기 고정 · A11 화면 전환 transform 제거(시트·고정 요소가 화면 기준)·한국어 낱말 줄바꿈·로그인 언어 칩 · A12 마이페이지 예시 숫자 제거·서비스 소개 데이터 표. **merchant** A9 ① 예상 혼잡 항상(미학습이면 업종 요일·시간대 '예측')·한가한 시간 → 타임세일·개발자 문구와 데모 배지 정리. **admin** A10 첫 화면 KPI 4개·추천 신뢰도 맨 아래·'산식 보기'·한국어 메뉴·엔진 검증 메뉴 숨김·403 사유 표시. **api** C1 키워드 검색 법정동 47/130 + 경주 후필터 + 0건 미캐시 + 분당 12회 · 추천 사유 분 표기를 웹 규칙과 같게 · 심사용 관리자(`openapi@gmail.com`) 전체 설정 저장·장소 삭제 403.
- 통합: 충돌 2곳 — 추천 화면 음성 버튼 위치(같은 수정 두 벌 → core 쪽 하나), 관제 403 사유(admin 의 서버 detail 표시로 합치고 api 의 웹 사본 모듈 삭제). model-info 요청 함수 하나로 · 죽은 서울 키·스타일 삭제 · 병합 뒤 e2e 5개 스펙을 바뀐 계약에 맞춤(typesetting 은 폰 미리보기를 먼저 펼치게) · 시연 대본·Q&A·데이터 활용 문서 갱신.
- 동작 변화(PM 확인용): `openapi@naver.com` 로그인(next 없음) → /merchant · 모든 관광객 화면에 콘솔 입구 2개 · 게스트 /mypage 예시 숫자·로그아웃 없음(09-21 결정 뒤집음, PM 4.19a) · 24시간 넘은 관측은 어디에도 안 보임(09-20 '관측은 남긴다' 뒤집음, /waiting 순서가 바뀔 수 있음) · 카드 큰 숫자 +1분 가능 · 한국어 전역 keep-all · 관제 메뉴에서 엔진 검증 숨김(URL 은 열림) · 키워드 검색 분당 12회·0건 미캐시(TourAPI 호출 조금 늘 수 있음) · 사장님 콘솔 model-info 1회가 실패 batch 7회를 대신함.
- 검증: web lint 0 errors(경고 152)·typecheck·test 81파일·build 39쪽 · e2e 전체 282건(3300, 워커 2) 281 통과 · 1 실패는 진짜 실패(typesetting 이 미리보기 뒤 버튼을 기다림)라 고친 뒤 그 스펙 15/15 · api ruff + pytest 2478 · check-docs · RESET_AND_SETUP 재생성 무변경.
- 리뷰 수정(10-07, 통합 뒤 독립 리뷰 → 이 브랜치): ♿ 를 켜면 핀 수가 아니라 **카드에 오를 수**로 칩을 고르고, 어디에도 없으면 무장애 핀으로 지도를 맞추고 카드 자리에 '♿ 무장애 확인 장소 N곳이 지도에 있어요 · 지도에서 보기'(밤 관광지에서 카드·제안·토스트 없는 빈 지도였다) · /explore/recommend 개인화 추천이 비면 같은 유형 by-type 을 한 번 더(빈 경우에만 Render 호출 +1), 그래도 없으면 머리글 '…모았어요' 없이 '지도에서 다른 곳 둘러보기' 버튼 하나('다시 찾아볼까요?·반경을 넓히면' 빈 상자 삭제) · 데스크톱 제안 카드를 톱바 오른쪽 열 실측 아래로(셋째 줄 출처 칩을 덮었다) · /waiting 대기·순서·한산 시각은 5분 박자, 도착 시각 글자만 30초(30초마다 카드가 자리를 바꿀 수 있었다) · 한산 줄이 하나도 없는 보드는 머리글·범례가 한산 시각을 약속하지 않음 · en 'KTO' 4곳 → Korea Tourism Organization, 관광 '상대지수' → '관광 인기도'(ko·en·ja, zh 와 맞춤) · 사장님 데모 칩은 새 키 `demo.sampleChip`('예시 화면'), 관제 데모의 `demo.badgeShort` 는 라이브와 같은 '데모 데이터'로 되돌림 · TourAPI 검색 블록 제목 '경주 장소 검색 결과'(불국사 검색에 음식점 '불국사밀면'이 '관광지' 제목 아래 섰다 — 계획 A7 문구에서 벗어남) · 폰 미리보기 손잡이에 '추천 자세히 보기' 글자 · 야간 음식 세부 칩(`bg-white/85`) 야간 바탕 · 시연 대본의 '관제 주체인 경북문화관광공사' 문구 정리. 리뷰가 짚은 배치 B 몫(카드 '상세 정보 펼치기' 첫 화면·폰 펼친 카드가 검색창을 가림·SPOT 툴팁·카드 사실 반복·랜딩·시간 띠·콘솔 배치)은 그대로 B. 검증: web lint 0 errors(경고 152)·typecheck·test 82파일·build · e2e 전체 286건(3300, 워커 2) 전부 통과 · 심사 경로 화면 다시 찍음(♿·/explore 빈 대안·/waiting 머리글·검색 제목·폰 미리보기·야간 칩·관제 데모) · 새 e2e 4건은 고치기 전 화면에서 실패 · check-docs.
- 다음·미결: **미룬 것** — 배치 B1~B5(랜딩·카드 재배치·지도 시간 띠·콘솔 레이아웃·/waiting·/explore·/course), 순위를 바꾸는 API(I28 개방형 관광지 등급·I09 서버 카테고리 게이트·I01/I06 장소별 예측·I33 — 심사 뒤), 15번 수락률 재정의(안 함). **PM 서명 대기** — B0 화면(D2), 화살표 다섯째 조건(관광 지수만으로 정한 기준지 등급이면 화살표 없음)·'취향 N% 일치' 50% 하한, en '{time} 도착' 문구('Arriving {time}'), 대기 분 정수화 — /main 카드는 올림(A4), 서버 사유(`card_minutes.wait_minutes`)·/explore 대기 칸·Top 3 표·/waiting 은 반올림이라 9.2분이 '10분'·'9분'으로 갈릴 수 있다(모델 미학습인 지금은 /main 카드에 대기 칸이 없어 화면에 안 드러남) — 제안: B2/B5 때 한 릴리스로 올림 통일(`tests/services/test_card_minutes.py` 가 웹 규칙과 대조). **심사 뒤** — 엔진 검증 메뉴 되살리기(`AdminSidebar.tsx` `HIDDEN_FROM_MENU`), 서버 `visit_confirmations_note` 빼기.
  **배포 순서·되돌림(한 경로)**: 이 브랜치는 웹과 API(C1)를 함께 담고, main 푸시 한 번이 Vercel·Render 를 **같이** 배포한다(`render.yaml` 에 자동 배포 끄기 없음 — 웹만 먼저 내보낼 수 없다. C1 병합 `2c0219c` 위에 웹 403 충돌 해결과 뒤 커밋이 얹혀 API 만 떼어 낼 수도 없다). 그래서 **main 푸시 자체를 KST 밤(심사가 없을 시간)에만** 한다 — 낮에 푸시하면 Render 512MB 인스턴스가 재시작해 메모리 캐시·분당 제한 상태가 비는 순간 심사위원이 들어올 수 있다. 푸시 전에 둘 다 적는다: Vercel 현재 프로덕션 배포 id, Render "이전 배포". 되돌림: 웹은 그 id 로 Vercel instant rollback, API 는 그 Render 배포 재배포(또는 `0be9872..` 범위의 커밋을 최신부터 차례로 `git revert` — 병합 6건은 `-m 1` — 해 푸시. 통합 후속 커밋이 병합 내용에 기대므로 병합만 골라 되돌리지 않는다). 배포 뒤 `/health`·메모리, `GET /api/v1/search/keyword?q=골굴사` 가 contentid 127693 을 주는지, `?q=불국사` 에 불국사가 나오는지, 1536×730·390 라이브 스모크(F1~F5, ⓒ한국관광공사 출처 4화면, 심사 계정 2개 첫 화면). `60d80ad`(사유 올림)는 `599a7a2`(웹 규칙 그대로)와 함께만 나간다 — 같은 레인이라 이 브랜치에서는 늘 함께다.
- 사람 작업: 배치 D — D1(Supabase 익명 로그인 300/h)은 10-06 밤 사용자가 끝냄. 나머지는 "사람 작업 대기" 맨 위.

## 2026-10-02 — 실사진 적재(경주시 사진 · 법정동 목록 · 관광지 17곳) + 웹 '사진: 경주시' 출처 → `release/1002`

- 도구·브랜치: Claude Code(노트북) · 리뷰 워크플로(웹·적재 2렌즈 → 반박 검증) / `release/1002`(main `e8cfb33` 위 — 09-29 노트북에만 있던 `feat/real-photos-ingest`·`web/city-credit` 를 10-02 원격에 올리고 코드 커밋만 옮김, 그쪽 HANDOVER 커밋 5건은 이 항목으로 합침) + 데스크톱 `docs/switches-0930` 2건
- 커밋: 526ff09..1a47316(적재 9건) · e5f3d41..14b65b5(웹 5건) · 001d358·dd92462(데스크톱 기록) · 이 기록
- 한 것: ① 경주시 「메뉴별음식점」 대표 사진을 사진이 하나도 없는 매칭 행에만 `gallery_images` + 출처 `features.city_photo` 로(TourAPI 사진이 오면 둘 다 뺀다) — **변수 `GYEONGJU_CITY_PHOTO_ENABLED` 기본 꺼짐**. ② TourAPI 음식점·문화시설·관광지를 법정동 목록으로도 받아 사각지대를 메움(새 행 중복 가드 80m·관광지 300m, 보류 4곳 `EXCLUDED_CONTENTIDS`, 이름 겹치는 이웃 관광지 쌍은 적재 로그). ③ `features.manual_hidden` 행을 밤 적재가 다시 켜지 않는다. ④ 웹: 경주시 사진이 **보인 뒤에만** '사진: 경주시'(4로케일, 관광객 화면 4곳), 짝 없는 경주시 사진은 띄우지 않음 · 320px 영어에서 말줄임 대신 접기 · 대기 보드에서 옆 카드 Wikimedia 출처와 첫 줄 높이 맞춤(`14b65b5` — 09-29 리뷰 2건, 각 3표 확인).
  첫 밤 예상(09-29 대조 + 10-02 리뷰 재현): 새 행 약 31곳(관광지 17 · 문화시설 7 · 음식점 7, 전부 사진) · 적재 쿼터 약 +100콜/밤.
- 검증: api ruff + pytest 2419(보류 반영 뒤 2420) · 스키마 파리티 · check-docs · web lint 0 errors(경고 153)·typecheck·test 71파일·build · e2e 108 passed(3100, 재시도 0) · `14b65b5` 의 새 e2e 2건은 고치기 전 컴포넌트에서 실패 · 독립 리뷰: 웹 0건, 적재 minor 2건(2표 확인 — 아래).
- 다음·미결: **PM 결정 10-02 "추천대로" — 아래 5곳을 `EXCLUDED_CONTENTIDS` 로 보류(`1492402`·`2781625`·`2756694`·`3036159`·`3036287`, 시험 1건 — 목록 없이는 실패), 첫 밤 새 행 약 26곳(관광지 14 · 문화시설 5 · 음식점 7). 월성이랑 숨기기는 반영 뒤 SQL(사람 작업 ⑦).** 당시 안 — ⓐ 한 곳에 카드 두 장: 대릉원 일원 1492402(천마총 204m · 경주역사유적지구 61m) · 금장대 수변공원 2781625 · 흥무로 벚꽃길 2756694 는 넣지 않기, 월성이랑 숨기기를 추천(반영 전이면 `EXCLUDED_CONTENTIDS` 한 줄씩). ⓑ 리뷰가 찾은 같은 자리 새 행 — 가드가 새 행끼리·음식점↔비음식점을 견주지 않는다: 플레이스 씨 3036159(Kakao 플레이스씨 한식당 6m, 같은 가게) · 경주쪽샘유적발굴관 3036287(쪽샘지구 3032585 와 같은 주소 0m) — 둘 다 보류 추천, 국립경주박물관 ↔ 신라천년서고(186m, 다른 건물)는 넣기.
  알아 둘 것: 가드는 숨긴(비활성) 행을 견주지 않는다 — 사람 작업 ③(Kakao 중복 숨기고 TourAPI 행이 대신 들어오게)은 이 동작에 기댄다. 거꾸로 **폐업으로 Kakao 행을 숨길 때는 같은 가게의 TourAPI contentid 를 `EXCLUDED_CONTENTIDS` 에도** 넣어야 다음 밤 새 카드로 돌아오지 않는다(운영 숨김 행 0개 — 지금은 해당 없음).
- 사람 작업: main 반영 뒤 실사진 DB 정리(①~⑦) · 경주시 확인 메일 · 웹 출처가 운영에 뜬 뒤 변수 켜기("사람 작업 대기"). 09-29 의 "오늘 밤 신라고분정보센터 사진 23장" 은 PM 이 09-29 16:00 에 적용했다(빠짐).

## 2026-09-30 — 진행 중: "아직 느리다" — 대기 보드·추천·코스 요청 경로 정밀 최적화 (조사 단계, 코드 변경 없음)

- 도구·브랜치: Claude Code(데스크톱) / `docs/switches-0930`(main `e8cfb33` 위, 문서만)
- 커밋: 4fd6a00 + 이 기록
- 한 것: 사용자 지시(09-30 01:4x) — "Render 에 부하를 더하지 말고, 제한된 자원 안에서 정밀하게 최적화". 운영 공개 GET 실측(데스크톱 → Render, 한 번씩만): `/health` p50 0.25초(한국↔오리건 왕복이 바닥) · `/infrastructures` 0.26~0.57초(유휴 뒤 첫 요청 3.3초 1회 — 시각 경계 재조립 의심, 미확인) · `/congestion/estimates` 0.27~1.5초 · `/area-demand/forecast` 0.26~1.19초.
  무거운 화면은 인증 POST(쓰기 포함)라 운영에서 재지 않는다. 구조 발견: `/waiting` 은 by-type 4유형(각 8곳)을 **순차 4요청**으로 부른다(waiting/page.tsx — 동시 요청 503 이력 때문) — 요청마다 한국↔오리건 왕복·사용자 조회·같은 출발점 보행 탐색·근거 조회·저장이 되풀이된다.
- 다음: 로컬 하니스(실 DB 읽기만 — httpx 층에서 GET·읽기 RPC(`latest_congestion_for_facilities`·`area_demand_points_near`)만 통과, 나머지 쓰기·외부 LLM/카카오 호출은 가짜 응답, 인증은 dependency_overrides) + py-spy(설치됨)로 by-type(4유형·새 사용자)·보드 4연속·`/recommendations`·`/courses/plan` 의 CPU 핫스팟·DB 왕복 수를 잰다 → 오리건↔서울 왕복(~130ms)×왕복 수 + CPU 로 Render 시간을 추정 → 후보: 보드 한 요청(4유형을 한 번의 후보·경로·근거 계산으로) · 요청당 DB 왕복 줄이기 · 핫스팟 제거. 설계는 레드팀 뒤, 결과가 같음을 시험으로 잠근 다음 구현.
- 사람 작업: 없음(shadow 게이트는 10-01 01:37 KST 이후)

## 2026-09-29c — API 재설계 P3 배치 B: 보행 경로 csr 커널 (스위치 꺼진 채 — memo, 09-30 `dd2afc9` 로 main 반영)

- 도구·브랜치: Claude Code(데스크톱) · 독립 리뷰 워크플로(동등성·운영 2렌즈 → 반박 검증, 4에이전트) / `perf/p3b-csr-0929`(`docs/handover-0929-sync` 위)
- 커밋: b6181be..(이 기록) (구현 1 · 리뷰 수리 1 · 이 기록)
- 한 것: `services/spot/walking_csr.py`(순수 — 표준 `array` CSR, numpy/scipy 없음. 원본 순서 노드 번호·같은 공간 칸과 칸 안 순서·같은 엄격한 비교·정수 미터·무방향 연결 요소로 다른 요소 목적지를 미리 뺌) + 커밋된 `app/data/gyeongju_walking_graph.csr.bin`(1.07MB, `build_walking_graph.py --emit-csr`, 머리에 원본·본문 sha256) + `WALKING_ROUTE_KERNEL=csr`(기본 memo 그대로).
  이진이 원본과 안 맞거나 깨졌으면 원본 JSON 에서 만들고, 그것도 안 되면 memo 경로. csr 에서는 dict 그래프를 올리지 않고 부팅 훅(`main._start_boot_presnap`, 이미 있던 것)이 시설 목적지를 미리 스냅한다. csr 을 못 읽으면 예열은 0(dict 그래프를 부팅에 올리지 않음).
- 검증: api ruff + pytest 2100 · legacy 와 repr 까지 같음 — 데스크톱 36,000쌍·스냅 불일치 0, 리뷰 퍼즈(합성 ~4,900 질의 묶음·실제 스냅 20,000·쌍 ~4,700) 불일치 0 · 변이 3종과 리뷰 수리 시험 5건은 고치기 전 코드에서 실패 ·
  Render 모양(WSL systemd scope CPUQuota 50%·MemoryMax 512M, py3.12, 2회): 그래프 적재 뒤 RSS +29.4~29.8MB → **+5.5MB**, 적재 96~124ms → 20~23ms, 목적지 300곳 웜 호출 41 → 25ms.
- 다음·미결: P3 의 나머지(소비자가 스냅샷 읽기 · 예측 표)는 대기. `/health` 에 커널 칸은 없다 — 켠 뒤 로그 `walking_graph_csr_loaded origin=bin`·`walking_graph_presnap kernel=csr` 로 본다(`origin=json`·`walking_graph_csr_load_failed`·`walking_graph_presnap_skipped` 가 보이면 되돌린다).
  시험 한 줄 변경: `test_walking_graph.py` 의 `("csr", "memo")` 는 배치 B 를 기다리던 자리라 `("csr", "csr")` 로.
- 사람 작업: main 반영 뒤 Render `WALKING_ROUTE_KERNEL=csr`("사람 작업 대기")

## 2026-09-29b — 데스크톱: 노트북 124커밋 동기화 · 전수 점검(5영역 리뷰 → 반박 검증) · 문서 어긋남 정리

- 도구·브랜치: Claude Code(데스크톱) · 리뷰 워크플로(5영역 리뷰 → 영역별 반박 검증, 9에이전트, 읽기 전용) / `docs/handover-0929-sync`(main `f0f440b` 위) → main(09-30 `dd2afc9`, 사용자 푸시)
- 커밋: afa4ec0 (수정 1건) + 이 기록
- 한 것: 3cf5bf9..f0f440b(124커밋) 동기화 → 게이트 재실행 → 운영 확인(Vercel 번들 = f0f440b · CI green · `/health` 참조 스냅샷 ready·`parking_history` rpc · 경보가 Supabase 단계로 실제 판정 · Keep-Warm 이 반영 뒤 `/warmup` 호출) → 5영역 리뷰. P2a(rpc 는 스레드·DB 호출 없이 불변)·P3a 는 결함 없음, 확인 2건·가능성 1건(09-28b 다음·미결).
  고친 것: 저장 실패로 같은 합성 id(`mock-rec-id`)가 여러 추천 카드에 오면 카드마다 다른 id(`lib/recommendationIds.ts`) — 사진 커서가 서로를 되돌리며 깜빡이던 것·카드 하나 지우면 합성 id 카드가 다 사라지던 것.
  문서: 배포 상태 · 사람 작업 대기(조건부 문구 · 경보 설명 · 주간 학습 6주 실패 · 폰 스모크) · 09-28b/d/e 의 없는 해시·미푸시·3차 커밋 · 계획 표(P0a·P0b·P2a·P3 상태, B2·B4 예외, 9쪽) · SYSTEM_MAP 경보 판정·warmup · AGENTS 워크플로 목록.
- 검증: 동기화 직후 기준선 api ruff + pytest 2077 · web lint 0 errors(경고 153)·typecheck·test 69파일·build · 스키마 파리티 · check-docs. 수정 뒤 web lint 0 errors(경고 153)·typecheck·test 70파일(새 `recommendationIds.test.ts`)·build · check-docs. 리뷰 원자료는 저장소 밖(세션 워크플로 기록).
- 다음·미결: `/waiting` 을 캐시로 먼저 그린 뒤 0.3~2초에 추정 피드가 오면 같은 대기 카드끼리의 사진 우선 묶음이 갈라져 순위 배지가 바뀔 수 있다(de722e2 부터, 데모에서 같은 기기로 다시 열 때 보인다). 카드 한 줄이 추정 등급으로 바뀌는 것이 원인이라 '추정이 올 때까지 사진 묶음 보류'는 반대 방향 재배열일 뿐이고, 낡은 추정을 캐시에서 쓰는 안은 60분 신선도 규칙과 부딪힌다 — PM 결정 뒤 고친다.
  P3 배치 B 는 09-30 18:00 KST 까지 증명될 때만 · 데스크톱의 잠긴 빈 워크트리 `.claude/worktrees/agent-a20b30c1e3d0047f1`(3cf5bf9, 변경 없음)는 지워도 된다.
- 사람 작업: 폰 스모크 · 주간 학습 실패 로그 한 줄 · P3a Render 로그 · shadow 전환(모두 "사람 작업 대기")

## 2026-09-29 — 대기 보드 웹 27건: 사진 없는 장소 표지 · 같은 대기일 때만 사진 우선 · 줄 단위 자르기 (main 반영 f0f440b)

- 도구·브랜치: Claude Code(노트북) / `release/0930` → main(CI green 15:44 KST). 노트북 세션의 기록이 없어 09-29 데스크톱이 커밋에서 복원했다.
- 커밋: 8ad6266..f0f440b (27건 — fix 12 · feat 4 · test 11)
- 한 것: 대기 보드 조회를 run 단위로(A→B→A 에 옛 조회·예약 재시도가 되살아나지 않음, 버려진 by-type 요청은 AbortSignal) · 대표 카드 이름·메뉴·소개를 줄 단위로만 자름(`wholeLines`) · 사진 없는 장소 표지(장소 id 로 고른 경주 문양 + 유형 그림, `PlacePhotoFallback`·`placeVisual`) · 예상 대기가 같을 때만 사진 있는 장소를 앞에(`orderByWaitThenPhoto` — 더 짧은 대기를 앞지르지 않음) ·
  Wikimedia 출처는 그 사진이 드러난 뒤에만 · /explore 추천 카드 대표 사진이 깨지면 갤러리 사진 · 한국어 대기 한 줄은 띄어쓰기에서만 접음 · 영어 개수 칩 단수 · 하단 ⓒ TourAPI 줄 단축(4로케일). 새 재시도 없음(B4).
- 검증: CI green(f0f440b — web·api·e2e) · 09-29 데스크톱 재실행 web lint 0 errors·typecheck·test 69파일·build
- 다음·미결: 위 2026-09-29b(점검에서 나온 `/waiting` 재배열 · 추천 카드 합성 id 수정)
- 사람 작업: 폰 스모크("사람 작업 대기")

## 2026-09-28e — API 재설계 P3 배치 A: 보행 목적지 스냅 기억 · 시설 조회 왕복·복사 줄이기 (09-29 `f0f440b` 로 main 반영)

- 도구·브랜치: Claude Code(검증된 P3 명세 → 커밋별 구현 · 10ea2d4 원문과 동등성 대조) / `perf/p3a-0929`(10ea2d4 = release/0928 위) → `release/0930` → main
- 커밋: 4ab6eb7..(이 기록) (6건 + 리뷰 수리 3건 — 경계 테스트 둘·이 공개 보강). 순서는 스냅 기억 → 사각형 먼저 복사 → prior 스레드 → 타임세일 한 번 → 영업 근거 한 번. 기존 테스트 계약을 바꾼 마지막 두 건은 끝에 두어 따로 뺄 수 있다(각각 `git revert` 가능).
- 한 것: 보행 목적지 스냅을 그래프 객체에 기억 + 예열(`/warmup`) 때 시설 전체 사전 스냅(스위치 `WALKING_ROUTE_KERNEL` 기본 `memo`, `legacy` = 되돌림) ·
  `fetch_all_facilities` 가 사각형으로 먼저 좁히고 남은 행만 깊은 복사 · 관광 prior 붙이기를 스레드로 · 타임세일(조각 둘 이상) 한 번 조회 · 영업 근거(조각 둘 이상) 한 번 조회.
  손님이 받는 답은 같다. 공개된 차이는 영업 근거 둘(같은 마이크로초 동률은 id 순, 실패하면 그 호출의 근거가 통째로 빈다 — PM 수락).
  한 번 조회를 타는 곳(id 150개 초과): 메인 추천·by-type·부팅 예열 **그리고 `/infrastructures` 실시간 지도 경로**(참조 스냅샷 준비 전·낡음·`REFERENCE_SNAPSHOT_SERVE=legacy` 때,
  활성 시설 전체 ~1,682곳) — 명세 §4.3·611eb13 메시지에는 지도가 빠져 있었다. 실패 범위 차이는 지도에도 같다(그 요청의 근거가 통째로 빈다).
- 검증: api ruff + pytest 2077 passed(리뷰 수리 뒤) · OpenAPI 스냅샷·score.py 10ea2d4 와 동일 · check-docs · 10ea2d4 원문 대조 불일치 0(경로 실제 시설 1,682곳 × 출발 50곳 = 84,100쌍 ·
  시설 사각형 50개(실제 1,682행) · 타임세일 45가지 · 영업 근거 35가지 · prior 실제 1,682행). 기존 테스트 변경: 타임세일 조각 테스트는 단언 그대로 캡 폴백 경로를 타게 픽스처만,
  영업 근거 조각 테스트 둘은 새 계약으로(조각 크기 → 'URL 에 id 없음', 한 조각 실패 → 통째로 빈다).
  **이 두 곳은 '기존 테스트 단언 불변' 규칙의 예외라 PM 확인 필요**(611eb13 `test_availability_service.py` 단언 교체 · 7ee6821 `test_merchant_boost.py` 픽스처만).
  리뷰 수리로 새 테스트만 더했다: 타임세일 정확히 1000행(PostgREST 캡) 응답 → 조각 폴백 · 시설 사각형 경계 위 포함/한 칸 바깥 제외(변이 `>=`→`>`·`<=`→`<` 잡힘).
- 다음·미결: 배치 B(csr 커널 + 커밋된 바이너리, 부팅 사전 스냅 — `main.py` 훅은 이미 있고 csr 전까지 꺼져 있다)는 09-30 18:00 KST 까지 증명될 때만. 서명 전 Render 모양(0.5 CPU/512MB) 컨테이너에서 by-type·추천 콜드/웜 재측정(명세 §8).
- 사람 작업: main 반영 뒤 `/api/v1/warmup` 한 번 → Render 로그 `walking_graph_presnap`·`warmup_run_done` 확인, `merchant_boost_timesale_fetch_failed`·`availability_evidence_unavailable`(추천·by-type·**지도 요청 포함**)이 늘지 않는지. 되돌림은 env `WALKING_ROUTE_KERNEL=legacy`(재시작) 또는 커밋별 `git revert`.

## 2026-09-28d — API 재설계 P2a: 권역 수요 전망을 메모리 주차 이력 행렬로 (스위치 꺼진 채 — rpc)

- 도구·브랜치: Claude Code(명세 → 레드팀 3렌즈 → 수정 → 단계별 구현 워크플로, 단계마다 시험·변이 검사) / `perf/parking-history` → `release/0928` → main(09-29 새벽, 27cbebd 위 — 367514c..27cbebd 에 apps/api 변경이 없어 앱 코드는 rebase 전과 바이트 동일)
- 커밋: e76bd9f..f1af44a (24건 = 처음 10건(첫 기록 be58b13 포함) + 리뷰 수리 11건 + 수리 기록 + 2차 리뷰 수리 1건 + 이 갱신 — 기록에 있던 17c12e1·b72b812 는 rebase 전 해시라 저장소에 없다). 계획·전환 절차는 [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md) "P2a 전환 절차"
- 한 것: `services/parking_history.py`(56일 로트×시간 행렬 · 전용 스레드 부팅 적재·5분 꼬리·수집 직후 다시 읽기·30분 대조 · `/health.parking_history`) + 전망 서비스의 행렬 커널(`%.15g` — 운영 RPC 와 비트 동일)·정확 좌표 메모·백테스트 계획 공유 +
  `AREA_DEMAND_SOURCE` 분기: `rpc`(기본 — 도입 전 경로 그대로, 스레드·DB 호출 없음) · `shadow`(답은 rpc, 요청 비교·자기 탐침으로 차이만 셈) · `matrix`(행렬로 답하고 못 하면 그 호출만 rpc, 폴백 뒤 격자 캐시 비움, `/waiting` 전용 차선). PM 결정(09-28): 꺼진 채 반영.
- 검증: api ruff + pytest 2027 passed(rebase 뒤 HEAD, 2차 수리 포함) · OpenAPI 스냅샷·score.py 367514c 와 동일 · RPC 경로 원본 해시 고정(3cf5bf9 와 같음 — 367514c 의 전망 서비스는 3cf5bf9 와 같다, 부르는 도우미 9개 포함) · check-docs. score.py·SPOT 가중치·마이그레이션·웹 무변경.
- 리뷰 수리(기록 뒤 커밋 11건): 부팅 파싱 메모리 9.4→3.4MB(열·칸 객체 공유) · 차선에서 기다린 행렬 호출은 새 세대로 · 실패한 꼬리 도중 kick 은 백오프 존중 ·
  shadow 게이트 표본은 비교를 끝낸 탐침만 + `failed == 0` · 탐침 하루 ≤288회 실제로 · 종료 때 final 요약 · 시험 보강(ulp/value 경계·KST 날짜 경계·최근 좌표 고리).
  2차 리뷰 수리: 종료 때 아직 도는 shadow 비교(탐침·요청 비교)를 최대 3초 기다려 final 요약에 넣는다(shadow 모드만, 못 끝나면 `parking_history_shadow_drain_timeout`).
- 다음·미결: go/no-go 측정(Render 모양 0.5 CPU/512MB, 운영 시설 좌표 읽기 1회 승인됨)은 아직 — `matrix` 전 필수. P2b(격자 캐시·RPC 경로 삭제, 수집 실시간 공급)는 `matrix` 24시간 무폴백 뒤. `_points_locks` 누수(기존)는 P2b 에서.
- 사람 작업: main 반영 뒤 Render `AREA_DEMAND_SOURCE=shadow`(위 "사람 작업 대기").

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
