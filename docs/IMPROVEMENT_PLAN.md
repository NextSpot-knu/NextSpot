# NextSpot 개선 로드맵 & 작업 지시서

> 2026-07-07 전방위 감사(백엔드·프론트엔드·DB/RLS·인프라/CI·피벗 완성도, 5개 병렬 에이전트) 결과 종합.
> 각 워크스트림(WS)은 독립 에이전트/팀원에게 그대로 전달 가능한 지시서 형식이다.
> 심각도: **P0** = 보안 사고·공모전 요건 직결(즉시), **P1** = 핵심 정합성(이번 주), **P2** = 품질(순차).

---

## 0. 총평

- ✅ **피벗 자체는 성공적**: 코드 내 InduSpot/TTTV/구미/산업어휘 잔재 **0건**, 좌표 100% 경주 이관, 시드도 황리단길 16 POI. 잔재는 오히려 "문서가 코드보다 뒤처진(stale)" 형태로만 존재.
- 🔴 **가장 급한 것 5가지 (P0)**: ① RLS 권한 상승 취약점, ② TourAPI 연동 코드 전무(공모전 필수 요건), ③ 관리자 인증 하드코딩, ④ 카카오 REST 키 커밋 유출, ⑤ AGENTS.md 프롬프트 인젝션 잔재.
- ⚠️ **구조적 리스크**: SPOT 알고리즘이 백엔드/프론트에 **이중 구현**되어 이미 드리프트 발생(관리자 시뮬레이터가 스왑된 가중치를 시연 중). 테스트는 가중치를 검증하지 않아 회귀 미탐지.

---

## 1. 사람이 먼저 결정해야 할 것 (에이전트에게 맡기기 전)

| # | 결정 항목 | 선택지 | 권고 |
|---|---|---|---|
| D1 | **인센티브 항(w₃) 정의** | ✅ **확정(2026-07-07): (c) 결합** — `incentive = 0.5·min(1, coupon_rate/0.20) + 0.5·max(0, 원본혼잡 − 후보 도착시점 예측혼잡)`. 쿠폰은 0/1 이 아닌 제휴 등급(할인율) 연속값, 분산 항은 도착시점 예측 기준으로 w2 와 시간축 통일 | 구현: score.py · shared-types/spot.ts(SPOT_INCENTIVE) · 20260707150000 마이그레이션 |
| D2 | **스키마 소스 오브 트루스** | migrations 단일화(RESET은 자동 생성) vs RESET 단일화 | migrations 단일화 권고 (WS-B/WS-F 전제) |
| D3 | **관리자 인증 수준** | 데모 수준 유지(단, 쓰기 경로만 서버 뒤로) vs Supabase Auth 정식 도입 | 공모전 일정 고려 시 전자 → WS-A 범위 |
| D4 | **카카오 REST 키 로테이션** | 유출된 키 `8b9591c…` 폐기·재발급 | **즉시, 사람이 카카오 콘솔에서 수행** |
| D5 | shared-types 패키지 | 삭제 vs web↔api 공유 계약으로 승격 | SPOT 상수 공유용으로 **승격** 권고(WS-D 드리프트 해소와 연계) |

---

## 2. 워크스트림별 지시서

### WS-A. 보안 핫픽스 (P0) — DB + 백엔드 + 프론트 연쇄 수정

**목표**: 인증·권한 관련 5개 구멍을 막는다. 다른 WS보다 먼저 머지.

1. **[DB] users 권한 상승 차단** — `supabase/migrations/20250523120001_rls.sql:41-43`의 `update_users` 정책이 컬럼 제한 없음 → 로그인 사용자가 `role='admin'` 자가 승격 가능. 새 마이그레이션으로 role 변경 차단:
   `WITH CHECK (id = auth.uid() AND role = (SELECT role FROM public.users WHERE id = auth.uid()))` 또는 role 변경은 service_role 전용 트리거로.
2. **[DB] anon 노출 제거** — `20260602130000_relax_dashboard_rls.sql`의 `anon_select_recommendations`·`anon_select_feedback` 정책 DROP (타 사용자 행동 데이터 노출). `inquiries`의 `Allow select/update` 정책(`USING (true)`, TO 절 없음)을 `TO authenticated` + `user_id = auth.uid() OR get_auth_user_role() = 'admin'`으로 교체. 대시보드가 필요로 하는 집계는 FastAPI(service_role) 경유 또는 비식별 뷰로 제공.
3. **[BE] 관리자 토큰** — `apps/api/app/core/config.py:23` 기본값 `"nextspot-admin-local"` 제거(미설정 시 부팅 실패). `apps/api/app/core/supabase.py:105-112` `require_admin`: `hmac.compare_digest` 사용, `authorization` 헤더 폴백 제거.
4. **[BE] service_role 폴백** — `config.py:14`+`supabase.py:28`: `SUPABASE_SERVICE_ROLE_KEY` 미설정 시 anon으로 조용히 폴백 → 추천 이력 INSERT가 무음 실패. 필수화 또는 부팅 경고+`available` 플래그 반영.
5. **[FE] 카카오 REST 키 제거** — `apps/web/app/main/page.tsx:483`, `apps/web/app/explore/recommend/page.tsx:716`의 하드코딩 폴백 키 삭제, env 전용으로. (키 로테이션은 D4, 사람이 수행.)
6. **[FE] 관리자 쓰기 경로** — `components/admin/FacilityTable.tsx`·`app/admin/settings/page.tsx`가 anon 클라이언트로 직접 insert/update/delete → FastAPI 관리자 엔드포인트(service_role) 경유로 전환. `lib/admin-auth.ts` 비밀번호 `"admin"`은 최소 env화(D3 결정 반영).
7. **[BE] 예외 원문 노출 차단** — `infrastructures.py:122,185`, `recommendations.py:518`의 `detail=f"...{str(e)}"` → 일반 메시지 + 서버 로깅.

**검증**: anon 키로 `recommendations`/`user_feedback`/`inquiries` SELECT가 0행/거부인지, 일반 사용자 JWT로 `UPDATE users SET role='admin'`이 거부되는지, `ADMIN_API_TOKEN` 미설정 부팅이 실패하는지 확인. `git grep 8b9591c` 0건.

---

### WS-B. TourAPI 데이터 파이프라인 (P0 — 공모전 필수 요건)

**목표**: 한국관광공사 TourAPI 연동을 실코드로 구현. 현재 저장소에 `tourapi` 문자열 0건.

1. **`apps/api/app/services/tourapi/`** 신설 — `areaBasedList`(경주 POI 목록), `locationBasedList`(반경 조회), `detailCommon`/`detailIntro`(운영시간·카테고리), `detailInfo`(무장애), `eventBasedList`(행사) 클라이언트. httpx 비동기 + 일배치 캐시. 키는 `TOURAPI_KEY` env.
2. **`apps/api/scripts/ingest_tourapi.py`** — 경주 황리단길 POI 적재(관광지12·문화시설14·음식점39 contentTypeId), `scripts/seed.js` 패턴 참고. contentid 기준 upsert.
3. **[DB] `facilities`→`pois` 마이그레이션** — `contentid VARCHAR UNIQUE`, `contenttypeid INT`, `address TEXT`, `barrier_free BOOLEAN` 정규 컬럼 추가. 백엔드 `.from("facilities")`·프론트 참조 동시 수정. ⚠️ `recommendations` FK의 `NOT NULL + ON DELETE SET NULL` 모순(`20250523120000_init.sql:45-46`)도 이 마이그레이션에서 함께 해소(NOT NULL 제거 권장).
4. **[DB] 인덱스** — `congestion_logs(timestamp DESC)` 단독, `(facility_id, timestamp)` UNIQUE(+upsert), inquiries `(status, created_at DESC)`. TourAPI 대량 적재 대비 `(latitude, longitude)` btree 또는 PostGIS.
5. **`.env.example` 갱신** — `TOURAPI_KEY`, `TMAP_APP_KEY`(WS-C 선행), 경주 좌표 기준값.
6. **드리프트 해소** — ✅ 완료(2026-07-07, D2 확정: migrations 단일화): 고아 SQL `apps/api/sql/add_preference_note.sql` 을 `supabase/migrations/20260707140000_add_preference_note.sql` 로 승격 후 삭제. `RESET_AND_SETUP.sql` 은 이제 `scripts/build_reset.mjs` 가 migrations/ 에서 자동 생성(직접 수정 금지), CI `schema` job 이 일치를 검증.

**검증**: `python scripts/ingest_tourapi.py --dry-run`으로 실 API 응답 파싱 확인, 적재 후 `/api/v1/infrastructures` 응답에 contentid 포함, 기존 추천 플로우 회귀 없음.

---

### WS-C. SPOT 알고리즘 제안서 정렬 (P1) — D1 결정 후 착수

1. **가중치** — `apps/api/app/services/spot/score.py:9-12` `0.45/0.25/0.30` → **`0.40/0.40/0.20`**. 정규화식은 W 변수 기반이라 자동 정합(단, incentive `max(0, min(1, …))` 클램프 추가 — score.py:107-110 상한 붕괴 방지).
2. **인센티브 정의** — D1 결정 반영. (b)쿠폰이면 pois에 `has_coupon BOOLEAN` + 0/1 항, (c)결합이면 가중 분해 문서화.
3. **preference.py contentTypeId 전환** — 8차원 facility 벡터 → TourAPI `contentTypeId`(12/14/39) 기반 카테고리 벡터. `recommendations.py:485`의 미지 타입 제로벡터 학습도 스킵 처리.
4. **Tmap 도보 경로 어댑터** — `apps/api/app/services/tmap/` 신설, `travel.py`의 Kakao/Haversine 경로를 교체(Haversine은 폴백 유지). 실패 로깅 `print`→structlog(`travel.py:82-89`).
5. **테스트 강화** — `test_spot.py:77-84`는 가중치를 검증하지 않음(0.40으로 바꿔도 통과). 특정 입력→기대 점수 하드 검증 케이스 추가, 정규화 경계(min/max) 테스트, `fetch_latest_congestion` 2차 정렬(`recommendations.py:81-95`, `.order("id")` 추가) 후 결정성 테스트.
6. **N+1 완화** — `recommendations.py:150-177`의 후보별 개별 혼잡 조회 → IN 쿼리 일괄화 또는 세마포어.

**검증**: `pytest apps/api` 전체 통과(WS-E의 pytest 복구 선행), 가중치 회귀 테스트가 0.45로 되돌리면 실패하는지 확인.

---

### WS-D. 프론트 정합성 & 단일화 (P1)

1. **SPOT 이중 구현 해소** — `lib/recommender.ts:14-210`이 백엔드 산식을 클라에 재구현(드리프트 실존). 원칙: **점수 산정은 백엔드 단일화**, 거절/다음 추천도 백엔드 랭킹(`rankedFacilities`)에서 소비(`app/main/page.tsx:578-647`의 클라 재계산 제거). 오프라인 폴백이 꼭 필요하면 가중치·카테고리 벡터를 `packages/shared-types`(D5 승격)에서 단일 공급.
2. **시뮬레이터 가중치 스왑 수정** — `components/admin/SPOTSimulator.tsx:9` 기본값 `time:30, inc:25`가 실제 엔진(`0.25/0.30`)과 반대. WS-C 이후 새 가중치(0.40/0.20)로 공유 상수 사용.
3. **합성 혼잡도 제거** — `app/main/page.tsx:118-183`: 로그 없는 시설을 id 해시로 채색 → "데이터 없음" 상태로 표시(신뢰도 문제).
4. **온보딩 단일화** — `app/setup/page.tsx`(localStorage만, 백엔드 미연동)와 `explore/recommend` 모달(Supabase 저장)의 이원화 해소. TourAPI contentTypeId 카테고리 기반으로 통일, `users.preferred_categories`에 저장.
5. **음성비서 통합** — `app/explore/recommend/page.tsx:165-1092`의 ~900줄 인라인 재구현을 `lib/useVoiceAssistant.ts`+`VoiceAssistantOrb`로 교체(의도분류 이원화 해소).
6. **소소한 정리** — parking 죽은 분기 3곳(`RecommendationCard.tsx:319`, `explore/recommend:1256`, `CongestionMap.tsx:250`), `layout.tsx:20` `lang="en"`→`"ko"`, 비기능 검색 input(`main/page.tsx:960-968`) 구현 또는 제거, 빈 차트 폴백(`admin/dashboard:281,434`, `admin/reports:18-22`) 스켈레톤/빈 상태 처리, `alert/confirm/prompt`→모달.

**검증**: 첫 추천과 거절 후 추천의 점수 출처가 동일한지, 시뮬레이터 수치가 백엔드 응답과 일치하는지, 온보딩 후 `users.preferred_categories`가 실제로 갱신되는지.

---

### WS-E. DevEx / CI (P1)

1. **pytest 복구** — `apps/api/requirements.txt`에 `pytest`·`pytest-asyncio` 부재(pyproject에만 있음) → 표준 설치 후 테스트 실행 불가. requirements(-dev)에 추가.
2. **CI 신설** — `.github/workflows/ci.yml`: job `web`(Node 20: `npm ci` → lint → `tsc --noEmit` → build), job `api`(Python 3.11: install → `ruff check`(신규 도입) → pytest). 트리거 `pull_request` + `push: main`.
3. **의존성 고정** — `requirements.txt` `>=` → `==` 핀(또는 pip-tools로 pyproject에서 생성해 이원화 해소), `package.json`에 `"engines": {"node": ">=20"}`, `lucide-react@^1.16.0` 실존 버전 검증.
4. **프론트 테스트 러너** — `lib/voiceIntent.test.ts`가 러너 없이 방치(실행 불가) → vitest 도입, CI 연결.
5. **정리** — 루트 고아 `eslint.config.mjs`·`tsconfig.json` 삭제(apps/web와 바이트 동일 시드 잔재), `docker-compose`→`docker compose`(루트 package.json:13,16), `run_local.ps1` 매회 install 조건부화, shared-types `dist/` gitignore(D5에 따라).

**검증**: CI가 main에서 green, 로컬 `pip install -r requirements.txt && pytest apps/api` 성공.

---

### WS-F. 문서 & 잔재 정리 (P1 인젝션 / P2 나머지)

1. **🔴 프롬프트 인젝션 제거 (P1)** — 루트 `AGENTS.md:14-18`의 `<!-- BEGIN:nextjs-agent-rules -->` 블록("This is NOT the Next.js you know… `node_modules/next/dist/docs/`" — 해당 경로 실존하지 않는 허위 지시) 삭제. `apps/web/AGENTS.md`는 **파일 전체**가 동일 인젝션 → 실제 web 가이드로 교체 또는 삭제(`apps/web/CLAUDE.md`가 이를 로드 중). 잔재 검증 스위프에 `nextjs-agent-rules`·`node_modules/next/dist/docs` 패턴 추가.
2. **NEXTSPOT_PIVOT.md 현행화** — §5 체크박스: 브랜딩 교체·layout.tsx 메타데이터는 **실제 완료** → [x]. §6 제거 대상 7개 전부 이미 삭제됨 → "완료" 표기. §4 매핑표의 users(worker→tourist)·좌표·시드 항목 완료 반영.
3. **architecture_overview.md** — "근로자 앱", `app/worker/` 등 실코드와 불일치 서술을 explore/tourist로 갱신하거나 "InduSpot 원문 아카이브" 섹션으로 격리.
4. **DB 셋업 문서 일원화** — LOCAL_RUN vs DEPLOY_AND_ENV의 초기화 경로 충돌: "신규 셋업=RESET_AND_SETUP.sql / 기존 유지=migrations"를 한 곳에 명시(D2 결정 반영).
5. **기타** — `GYEONGJU_MIGRATION_PLAN.md:13,49`의 구 Supabase 프로젝트 ref 마스킹, `pyproject.toml:5` authors 플레이스홀더 교체.

---

## 3. 실행 순서 & 의존 관계

```
D1~D5 결정 (사람)
  │
  ├─ WS-A 보안 핫픽스 ──────────────┐  (최우선, 독립)
  ├─ WS-F-1 인젝션 제거 ────────────┤  (5분, 즉시)
  ├─ WS-E CI/pytest ───────────────┤  (독립, WS-C 테스트 검증의 전제)
  │                                 ▼
  ├─ WS-B TourAPI + pois 스키마 ──▶ WS-C 알고리즘 정렬 ──▶ WS-D 프론트 단일화
  │   (pois 필드가 C·D의 전제)        (가중치·벡터·Tmap)      (공유 상수·온보딩)
  │
  └─ WS-F-2~5 문서 현행화 (아무 때나, 머지 마지막 권장)
```

- **오늘**: D4 키 로테이션(사람) + WS-A + WS-F-1
- **이번 주**: WS-E, WS-B
- **다음**: WS-C → WS-D → WS-F 나머지

---

## 4. 발견 사항 원본 (요약 색인)

| 심각도 | 건수 | 대표 항목 |
|---|---|---|
| P0 | 5 | RLS 권한 상승 / TourAPI 전무 / admin 하드코딩 / 카카오 키 유출 / 인젝션 |
| P1 | ~20 | anon 데이터 노출, SPOT 이중 구현·가중치 미반영, FK 모순, RESET↔migrations 드리프트, pytest 단절, CI 부재, 합성 혼잡도, 온보딩 이원화 |
| P2 | ~30 | 인덱스류, 죽은 분기, lang, 모달, shared-types, docker compose v2, 문서 stale |

상세 근거(file:line 포함)는 감사 세션 기록 참조. 각 WS 지시서의 파일 경로·라인은 2026-07-07 HEAD(`88179c0`) 기준.
