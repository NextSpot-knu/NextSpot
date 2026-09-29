# API 아키텍처 재설계 — 참조 스냅샷 · 사전 계산 · 패치 층 제거

> 2026-09-27 감사(하위 에이전트 6개 영역 감사 → 설계 → 레드팀 2렌즈)의 결론과 진행 상태. 목표 우선순위는 **안정성 → 속도 → 메모리**.
> 원칙 하나: **공유 참조 데이터는 요청마다가 아니라 데이터 버전마다 한 번 읽는다.** 요청에 필요한 것은 이미 메모리에
> 불변 스냅샷이나 미리 직렬화된 바이트로 있다. DB는 사용자별 읽기·쓰기와 스스로 집계할 수 있는 것(RPC 한 번, jsonb 하나)만 답한다.

## 왜 (실측, 2026-09-27)

| 무엇 | 실측 |
|---|---|
| 지도 `GET /infrastructures` | 운영 TTFB 2.7~4.2초, 1.37MB JSON(gzip 318KB), 1,682곳. 웹 타임아웃 4초라 **대부분 Supabase 직접 읽기 폴백**으로 돌았다(그 경로는 1,000행 캡) |
| 같은 요청의 서버 경로 | 시설 `select *` 2페이지 + 출처 표 + 최신 혼잡 RPC(1,682 id) + 영업 근거 12조각 — 오리건↔서울 왕복 4단계 이상, 스레드 홉 ~16회, 요청당 +17~25MB 일시 힙. 앱 CPU는 ~40ms뿐, 나머지는 I/O |
| 중복 상태 | 모듈 전역 캐시 ~40개, 시설 행 캐시 최소 4벌(`facility_cache` · 추정기 · 추정 리포트 · 주차), 추천은 요청마다 1,682행 deepcopy(27ms · 5~6MB) |
| 보행 그래프 | 28,832노드 dict 그래프 16MB, 적재 2.6~3.7초, 순수 파이썬 Dijkstra |
| 권역 수요 | `/area-demand/forecast` 3.0~3.35초/회, 격자 캐시 44~86MB(56일 창이 차면 ~109MB) |
| 결과 | 512MB 인스턴스 OOM 재시작 8회(09-21~25), 콜드 코스 23~43초 |
| 패치 층 | 관리자 GET ASGI 게이트 · gc+`malloc_trim` · RSS 400MB 사전 차단(503) · 합류 · HEAVY/ADMIN_IO 풀 · 예열 — 전부 위 원인의 증상 처리 |

## 목표 구조

```
Supabase(서울) ── 유일한 영속 정본
   ▲ 버전 탐침 + keyset 적재(적재 스레드 1개)      ▲ 사용자 행만          ▲ 관리자 패널당 RPC 1회(P5)
FastAPI 워커 1개(Render 512MB/0.5CPU)
 ├ 참조 평면  app/services/reference_snapshot.py — 공유 상태의 유일한 주인
 │   FacilityBase(활성 시설, by_id) · LiveOverlay(최신 혼잡·영업 근거)
 │   ([P2a] ParkingHistory 행렬은 같은 원칙으로 따로 — parking_history.py, 전용 스레드·실패 영역 분리)
 │   · [P3] 보행 그래프 CSR · 예측 표 — 실패 시 마지막 정상본, 원자적 교체, 쓰기마다 mark_dirty
 │   산출물: /infrastructures 바이트 + ETag(본문 해시), 시각 경계(is_current 30분·is_stale 24h·영업 만료)마다 재조립
 └ 요청 평면  snap = 스냅샷 한 번 → 지도는 바이트/304, 추천·코스는 메모리 위 순수 CPU(score.py 불변)
```

## 단계와 상태

| 단계 | 내용 | 상태 |
|---|---|---|
| **P0a** | 1,682 스레드 팬아웃 폴백 제거(RPC 실패 → 조각 재시도 1회) · 시설 페이지네이션 id 정렬 · 출처 표 전량 · httpx URL 로그 끄기(쿼리스트링 키 노출) · 브리핑 캐시 만료 | **main 반영(09-28 `4d56afa`)** — `perf/reference-snapshot` |
| **P1** | 참조 스냅샷 + `/infrastructures` 사전 직렬화 바이트 · ETag/304 · `Cache-Control: private, no-cache` · `/health.reference_snapshot` · 롤백 env `REFERENCE_SNAPSHOT_SERVE`(`snapshot` 외 값이면 옛 경로) | 같은 브랜치 완료. 실 DB 읽기 대조: 3개 필터 모두 JSON 동일, 3~13ms(옛 경로 1.2~1.5초, 데스크톱) |
| P0b | 웹만(API 계약 불변): 관제 장소 표 (name,id) 전량 페이지·활성/비활성·이름 검색 · 지도 비상 경로 활성만·id 페이지·최신 혼잡 RPC·갤러리 사진 · `/waiting` 곡선을 서버 창 안으로 당긴 정시 6점(분 30 이후에도 6점 — 가장자리 정시를 창 안으로 당기면 분 해상도 전망이 같은 정시로 읽힌다)·선행 1회 후 동시 3·noRetry·기준 시각별 곡선 · 숨은 탭 관제 폴링 멈춤('알림 받기' 켜짐이면 유지)·안전 화면 첫 진입 중복 조회 제거 · 탭 복귀 `/account/me` 5분 생략(실패 뒤·심사 대기 제외) · 추천 타임아웃 뒤 같은 POST 재전송 대신 by-type 대안(45초). **데모 프리페치 삭제와 상태 코드 재시도는 하지 않는다**(레드팀 B4 · crit7) | **main 반영(09-29 새벽 야간 배치 `10ea2d4`)** — `web/batch-0928` 880b2e1..96e31ae 6건 + 리뷰 수정 |
| P0c | 일배치가 상세 실패 행을 NULL로 덮는 문제 · area-demand-alert 가 API 메모리 상태에 묶인 거짓 경보 | **main 반영 367514c(09-28)** — `fix/ingest-keyset-upsert` — 키 집합별 bulk 쓰기 · capacity 는 PM 결정(09-28)으로 심사 전까지 매일 밤 기본값 초기화 유지(공유 관리자 계정의 실수 수정이 데모에 남지 않게 — 심사 후 관리자 수정분 `features.capacity_source='admin'` 표시·건너뛰기) · None 미전송 · 경보는 Supabase 스냅샷 표 직접 · 독립 리뷰 수정 6건(확인된 사진 부재만 지움 · Kakao 좌표 유지 · INSERT 행별 재시도 · 경보 견고화) + 2차 4건(항목 0개 응답은 확인 아님 · 옛 Wikimedia 출처 제거 · 경보 시크릿 글자 검사 · capacity 초기화 복원) + 3차 3건(Wikimedia 사진·출처 함께 걷기 · 저장된 TourAPI 갤러리 보존 · Wikimedia 조회 이상이 밤 적재를 멈추지 않게). 실측: 운영 1차 upsert 는 매일 42P10(부분 인덱스) → 폴백이 실제 경로 |
| **P2a** | 주차 이력 = 로트×시간 행렬(~0.8MB, `services/parking_history.py` — 전용 스레드가 DB에서 56일 적재 · 5분 꼬리 · 수집 직후 다시 읽기 · 30분 대조) → 권역 수요 전망을 **요청한 정확한 좌표**로 메모리에서(운영 RPC 와 비트 동일한 `%.15g` 커널), 격자 캐시 −40~105MB, 전망 3초 → ms. 스위치 `AREA_DEMAND_SOURCE`(기본 `rpc` = 도입 전 그대로) | **main 반영(09-29 새벽 야간 배치 `10ea2d4`) — 꺼진 채(rpc)**(PM 09-28). 운영 `/health.parking_history.mode=rpc`. 전환은 아래 "P2a 전환 절차" |
| P2b | 격자 캐시·RPC 경로·예열 호출부 삭제, 수집이 행렬에 실시간 값 직접 공급 — `matrix` 24시간 무폴백(부팅 제외) 뒤에만 | 대기 |
| P3 | 모든 소비자가 스냅샷을 읽음 → 시설 캐시 4벌·deepcopy 삭제, 보행 그래프 CSR(빌드 시 굽기), 예측 표(요청 경로에서 sklearn 제거 −55MB) | **배치 A main 반영(09-29 `f0f440b`)** — 보행 목적지 스냅 기억(`WALKING_ROUTE_KERNEL=memo`, `legacy` 되돌림) · 사각형 먼저 복사 · prior 스레드 · 타임세일·영업 근거 한 번 조회(HANDOVER 2026-09-28e). **배치 B csr 커널**(`perf/p3b-csr-0929`, main 미반영 — 스위치 `WALKING_ROUTE_KERNEL=csr`, 기본 memo): 커밋된 압축 그래프로 legacy 와 같은 경로, 그래프 RSS +29.6→+5.5MB(HANDOVER 2026-09-29c). 소비자 이전·예측 표는 대기 |
| P4 | 프로필 캐시 전역 락 → 사용자별 single-flight · 쓰기 멱등(클라이언트 uuid + on_conflict)으로 재시도 안전화. **JWKS는 적재 스레드에 올리지 않는다**(B6) | 대기 |
| P5 | 관리자·상인·dev 집계를 Postgres RPC로(마이그레이션 = SQL Editor 사람 작업, 코드는 RPC 없으면 옛 경로) | 대기 |
| P6 | 패치 층 삭제(게이트·trim·RSS 차단·합류·풀·예열) — **운영 소크로 불필요가 확인된 뒤에만** | 대기 |
| P7 | 웹 데이터 층(IndexedDB 스냅샷 · 작은 실시간 층). **Supabase 직접 폴백은 남긴다**(API 장애 시 첫 방문자 빈 지도 방지, B5), 배포는 API 먼저 → 확인 → 웹 | 대기 |
| P8 | 리전 이동 — **보류**: 무료 750시간/월에서 병행 운영일이 한도를 넘기면 전 무료 서비스 정지(crit7 B1) | 보류 |

## 레드팀이 고정한 제약 (다음 단계도 지킨다)

- **B1** 시각 의존 값(현재·오래됨·만료·추정 나이)은 요청 시점에 유효해야 한다 — 바이트에 `valid_until`, 지나면 재조립 후 응답.
- **B2** 부팅 때 정상본이 없으면 옛 경로로 답한다(새 503 금지). 첫 성공 전 백오프 ≤15초, 요청이 즉시 시도를 당길 수 있다.
  P2a 적재기는 뒤 두 가지를 따르지 않는다 — 준비 전 백오프 5→15→45→60초, 요청 경로는 적재를 깨우지 않는다(요청마다 DB 를 두드리지 않게).
  준비 전에는 그 호출이 RPC 경로로 답하므로 '새 503 금지'는 지킨다(`parking_history.py` 머리 주석).
- **B3** (P2) 배포 겹침 동안 옛 인스턴스가 받은 버킷을 새 인스턴스가 놓친다 — 꼬리 동기화는 "내 마지막 버킷 이후"가 아니라 DB 기준으로 빈칸을 메운다.
- **B4** 웹이 429/503에 재시도하지 않는 규칙은 유지(재시도 폭주로 Cloudflare IP 차단 실측). 이미 있는 예외(새로 더하지 않는다): `getRecommendations` 의 503·429 2초 뒤 1회(dd8279f — 이 경로의 읽히는 503 은 JWKS 일시 실패뿐) · `/explore/recommend` 첫 실패 1회(시간 초과는 제외, 96e31ae) · `/waiting` 부트스트랩 유예·503 1회.
- **B5** Vercel·Render 는 같은 main 푸시로 배포되지만 Render 가 늦다 — 새 엔드포인트에 의존하는 웹 변경은 API 배포 확인 뒤 별도 푸시.
- **B6** 인증 키(JWKS) 갱신은 참조 적재와 다른 실패 영역에 둔다.
- 스냅샷 교체 전 건전성 검사: 활성 수가 20% 넘게 줄면 두 번 연속 같을 때만 교체(P1 구현).

## P2a 전환 절차 (PM — Render 콘솔)

`AREA_DEMAND_SOURCE` 는 Render env 다. 바꾸면 서비스가 **재시작**한다(1~2분, 즉시가 아니다). 데이터·스키마는 건드리지 않는다.

1. **main 반영(기본 `rpc`)** — 배포만으로는 손님 쪽이 아무것도 바뀌지 않는다(적재 스레드·추가 DB 호출 없음). `/health.parking_history` = `{"mode":"rpc"}`.
2. **`shadow` 로 설정.** 답은 여전히 오늘 경로 그대로이고, 메모리 행렬로도 계산해 차이만 센다. 1분쯤 뒤 `/health.parking_history`:
   `ready: true` · `rows` ≈ 5,100(56일 창이 차면 ~8,064) · `lots: 4` · `failures: 0` · 그 뒤로 `last_sync_age_s` < 300.
   비용: 스레드 1개·+2~6MB, 꼬리 읽기 5분마다·대조 30분마다·재시작마다 6쪽 적재(56일 창이 차면 9쪽), 자기 탐침 RPC 하루 ≤288회.
3. **24시간 이상, 재시작 1회 포함**으로 둔다. 숫자는 재시작마다 0부터라 재시작 전 누적을 합산한다 — 재시작 전 값은 종료 때 남는
   마지막 `area_demand_shadow_summary`(`final: true`)의 `total` 이다(재시작 순간에 `/health` 를 볼 필요 없다). 종료 때 아직 도는
   비교(자기 탐침·요청 비교)는 최대 3초 기다려 그 `total` 에 넣는다 — 그 안에 못 끝나면 바로 앞에 `parking_history_shadow_drain_timeout`
   (`pending` = 빠진 비교 수) 한 줄이 남는다 — 그 비교들의 결과는 어디에도 남지 않는다. 게이트
   (`/health.parking_history.shadow` 와 10분마다 한 줄인 로그 `area_demand_shadow_summary`):
   - `rows == 0` · `value == 0` · `forecast_mismatch == 0` · `probe_failed` ≤ `probes` 의 5% · 요약 로그 `total` 의 `failed == 0`
     (shadow 쪽 비교가 던진 수 — `/health` 에는 없다)
   - `edge` ≤ `compared` 의 2% — 넘으면 꼬리 동기화가 밀리는 것이니 올리지 말고 조사
   - 표본: `compared` ≥ 200 · `forecast_compared` ≥ 100 · 요약 로그 `probes_by_class` 의 center·edge_in·edge_out·one_lot 각 ≥ 8, far ≥ 5 · `distinct_facility_coords` ≥ 20
     (`probes_by_class`·`distinct_facility_coords` 는 비교를 끝낸 탐침만 센다 — 던지거나 건너뛴 탐침은 표본이 아니다)
   - `ulp`·`repr_only` 는 허용(기록만). `served_grid_quality_differs` > 0 은 예상값이다 — 오늘 경로가 같은 100m 격자의 다른 장소 품질을 주는 횟수(행렬 결함 아님)
4. **go/no-go 측정**(Render 모양 컨테이너 0.5 CPU·512MB, 저장소 밖 스크립트 — 운영 시설 좌표 읽기 1회 승인됨): 콜드 코스(36곳)·유형별(24곳)에서
   행렬 CPU ≤ 오늘 경로 CPU 이고 벽시계도 ≤ · 코스와 동시에 `/waiting` 전망 p95 ≤ 2초(웹 타임아웃 8초) · 이벤트 루프 멈춤 ≤ 20ms ·
   RSS 행렬+메모 ≤ +13MB, 폴백으로 격자 캐시가 찬 뒤 비우면 +5MB 안 · 부팅 적재 일시 ≤ +6MB, 참조 스냅샷 준비 시각 불변. 하나라도 실패하면 `shadow` 유지 + 보고.
5. **둘 다 통과 → `matrix`.** 확인: `fallback_served` 가 부팅 직후 몇 건 뒤로 멈춘다 · 로그 `area_demand_source_fallback` 사유가 부팅 30~60초의
   `not_ready` 뿐 · Render 메모리 그래프 24시간 · `/area-demand/forecast` 응답 시간.

- **되돌림**: 언제든 `AREA_DEMAND_SOURCE=rpc` — 재시작 한 번(1~2분).
- **로그에서 볼 것**: `parking_history_loaded`(부팅 적재 rows·pages·elapsed_ms) · `parking_history_synced` · `parking_history_sync_failed`(백오프로 묶임) ·
  `parking_history_reconcile_mismatch` · `parking_history_loop_error` · `area_demand_shadow_diff`(10분에 ≤5줄 — kind 가 rows·value·forecast 면 결함 후보) ·
  `area_demand_shadow_failed` · `area_demand_shadow_probe_failed`. `/health` 에는 정수·모드·예외 종류 이름만 싣는다(오류 원문·좌표 없음).
- **`matrix` 에서 손님이 느낄 것**: `/waiting` 전망이 빨라진다(콜드 ~3초 → 0.5초 미만 예상) · 같은 100m 격자 안 두 장소가 각자 자기 값을 받는다(근소하게 비기던
  후보의 순위가 바뀔 수 있다, SPOT 식·가중치는 그대로) · 새 10분 수집이 몇 초 안에 반영된다 · 재시작 직후 30~60초와 동기화 15분 초과 동안은 그 호출만 오늘 경로로
  답한다(값이 잠깐 오늘 경로 값으로 바뀌었다 돌아올 수 있다) · Supabase 장애 때 15분 동안은 메모리로 계속 답한다.

## 부수 발견 (이번 범위 밖)

- ~~경계 필터가 한 번도 적용된 적이 없다~~ — **정정(2026-09-28, P0b 실측):** 웹의 `minLat…` 은 `apiClient` 의 `keysToSnake` 가 `min_lat…` 으로 바꿔 보내므로 경계 필터는 적용된다. 운영 `GET /infrastructures` 는 경계를 주면 674곳(0.34초), 없으면 1,682곳(0.77초)이다.
- httpx INFO 로그가 쿼리스트링의 공공 API 키를 전체 URL째 남겼다(P0a에서 차단) — 기존 Render 로그 이력에는 남아 있을 수 있다(HANDOVER 사람 작업).
