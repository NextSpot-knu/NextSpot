# RBAC 전환 디버깅 결과 · 검토 요청

**작성**: 2026-08-28 새벽 (자율 진행)
**대상 커밋**: `699a6e9` 이후 `7142ac7` 까지 — `yunseong` 브랜치에 푸시 완료
**검토가 필요한 이유**: 아래 §3 의 6건은 **고치지 않았다**. 판단이 필요한 항목이거나
데이터 의미를 바꾸는 변경이라 임의로 손대지 않았다.

---

## 0. 한 줄 요약

배포를 막고 있던 버그 1건과 배포되는 순간 터질 잠복 회귀 1건을 찾아 고쳤고, 무방비였던
`/dev` 콘솔에 테스트 45개를 붙였다. 프로덕션 권한 모델은 실측으로 검증했다.
**`main` 은 건드리지 않았다** — 배포 트리거라서 검토 후 직접 올리시는 게 맞다고 봤다.

---

## 1. 고친 것 (커밋 완료)

### 1-1. `/login` 빌드 실패 — **배포가 아예 안 나가는 상태였다** `c5f77b3`

`?next=` 지원을 넣으면서 `useSearchParams()` 를 Suspense 경계 없이 썼다.
`output:'export'` 빌드는 그 조합에서 프리렌더 단계에 실패한다.

```
⨯ useSearchParams() should be wrapped in a suspense boundary at page "/login"
Export encountered an error on /login/page: /login, exiting the build.
```

`next build` 가 통째로 죽으므로 Vercel 배포가 나가지 않는다. `course`·`explore/recommend`
가 이미 쓰던 관례(내부 컴포넌트 + Suspense 래퍼)를 그대로 따랐다.

> **왜 안 걸렸나**: CI 는 `npm run build` 를 돌린다 — 푸시했으면 잡혔다.
> 로컬에서 라우트를 고치고 빌드 없이 커밋한 게 원인이다. 프런트 라우트를 건드리면
> 커밋 전에 `npm run build --workspace=apps/web` 한 번이 필요하다.

### 1-2. 스케줄러 수집 401 — 배포되는 순간 조용히 멈출 뻔했다 `623f18a`

P2-2 에서 `/area-demand/snapshots/collect` 가드를 `require_admin` →
`require_role(ROLE_ADMIN)` 로 바꿨다. 그런데 **이 경로의 주 호출자는 사람이 아니다**:

| 호출자 | 주기 | 인증 수단 |
|---|---|---|
| Supabase pg_cron (`20260824130000` 마이그레이션) | 10분 | Vault 의 공유 토큰 |
| GitHub Actions 복구 워크플로 | 수동 | Actions Secret |

둘 다 Supabase 세션을 가질 수 없어 401 을 받는다. **응답을 보는 사람이 없어 알림도 안
뜨고**, 주변 수요 시계열이 멈춘 채 화면만 정상으로 보인다 — availability 청킹 때와 같은
실패 모양이다.

**실제 중단은 없었다.** `origin/main` 이 아직 구 가드(`require_admin`)였고 Render 는 main 에서
배포하므로, 프로덕션은 계속 구 코드로 돌고 있었다:

```
git show cfa7cce:apps/api/app/routers/area_demand.py  →  Depends(require_admin)
최근 스냅샷   2026-08-27T16:03Z, 16:13Z … 16:43Z  (10분 간격 정상 적재)
```

> **정정(2026-08-28)**: 처음에는 `/api/v1/dev/users/search` 가 404 인 것을 "미배포 근거"로
> 적었는데, 그 경로는 **애초에 존재하지 않는다**(실제 경로는 `/api/v1/dev/users`). 404 는
> 미배포가 아니라 오타의 결과였다 — 근거로 쓸 수 없다. 결론(중단 없음)은 위의 git 증거로
> 그대로 유효하다.

`require_machine_or_role(*roles)` 을 추가했다. 폐지한 공유 토큰과 다른 점:

| | 폐지된 구 방식 | 지금의 서비스 토큰 |
|---|---|---|
| 토큰 위치 | `NEXT_PUBLIC_*` — 정적 번들에 노출 | 서버 env / Vault / Actions Secret |
| 통하는 범위 | 관리자 API 전체 | 수집 트리거 **한 경로** |
| 비교 | 문자열 비교 | `hmac.compare_digest` |

`SERVICE_API_TOKEN` 을 새로 두되 없으면 `ADMIN_API_TOKEN` 으로 폴백한다. 헤더도
`X-Service-Token` 을 정식으로 하되 구 헤더를 계속 받는다 — **이미 적용된 pg_cron 함수를
재작성하지 않아도 살아 있게** 하기 위해서다.

### 1-3. 사업자 인증 심사 — 증빙을 상태 갱신보다 먼저 지웠다 `ca8c2ee`

승인·반려 둘 다 `_clear_evidence()` 가 먼저였다. 상태 갱신이 실패하면 요청은 `pending`
인 채 증빙만 사라진다 → **다시 심사할 수도, 신청자에게 돌려줄 수도 없다.**
순서를 뒤집었다. 테스트가 "삭제 시점의 status" 를 직접 관찰해 순서를 잠근다.

### 1-4. `/dev` 콘솔 테스트 45개 `2cb24f0` `ca8c2ee`

앱에서 **가장 강한 권한** 표면(역할 임명 + 소유권 부여)에 테스트가 하나도 없었다.
그 소유권이 곧 `evidence_tier='verified'` 데이터를 만들 권리다(CONGESTION_TRUST_SPEC).

잠근 계약: 비개발자 전원 403(admin 포함) · 무인증 401 · 마지막 developer 강등 409 ·
역할 변경/회수 시 캐시 즉시 무효화 · 회수는 `revoked_at`(삭제 아님) · 감사 로그 기록 ·
검색 결과에 email 칼럼 없음 · 반려 사유 필수 · 가게 미연결 승인 거부.

> `test_routers.FakeSupabase` 를 쓰지 않았다. 그 fake 는 체이닝을 흡수해 canned 데이터를
> 돌려줄 뿐 **필터링도 변경도 하지 않아**, 상태 전이가 핵심인 이 라우터에서는 통과해도
> 아무것도 증명하지 못한다. 필터·갱신·카운트를 실제로 하는 `_MiniSupabase` 를 따로 뒀다.

### 1-5. 프런트 권한 규칙 분리 + 테스트 `6dd9f1e`

`canEnter*` 가 `account.tsx`(React 컨텍스트) 안에 있어 테스트를 붙일 수 없었다.
순수 함수만 `lib/accountRoles.ts` 로 빼고 재수출한다 — 호출부 import 경로는 그대로다.
`normalizeRole('ADMIN') === 'tourist'` 같은 fail-closed 동작을 잠갔다.

### 1-6. 문서·env 정리 `c2db141`, ruff `7142ac7`

`SYSTEM_MAP §4` "3중 인증" → 역할 기반 모델. `DEMO_SCENARIO` 체크리스트 6번은 맞출 토큰이
없어졌으므로 "시연 계정 2개로 실제 로그인해 보기" 로 교체. `.env.example` 두 개에서
사라진 콘솔 비밀번호·프런트 미러 토큰 제거.

---

## 2. 검증 결과 (전부 실측)

### 2-1. 역할 매트릭스 — 실제 Supabase 의 `users.role` 로

| | tourist | merchant | admin | developer |
|---|---|---|---|---|
| 사장님 통계 조회 | 403 | **200** | 403 | 200 |
| 내 가게 좌석 방송 | 403 | **200** | 403 | 200 |
| **남의 가게** 좌석 방송 | 403 | **403** | 403 | 200 ⚠️ |
| 관제 대시보드 | 403 | 403 | **200** | 200 |
| 개발자 콘솔 | 403 | 403 | **403** | 200 |

무인증·구 `X-Merchant-Token`·구 `X-Admin-Authorization` → 전 경로 401.
(⚠️ 표시는 §3-2 참조)

### 2-2. RLS 권한 상승 시도 — 로그인한 관광객 토큰으로

| 공격 | 결과 |
|---|---|
| 자기 `role` 을 developer 로 PATCH | **400** `role 은 직접 변경할 수 없습니다` (가드 트리거) |
| `facility_owners` 에 소유권 위조 INSERT | **403** RLS 거부 |
| 자기 인증요청을 `approved` 로 INSERT | **403** RLS 거부 |
| 감사 로그 위조 INSERT | **403** RLS 거부 |
| 감사 로그 DELETE | 0행 영향 (5행 그대로) |
| `system_settings` 콘솔 스위치 끄기 | 0행 영향 (값 불변) |

일반 사용자 시야: `role_audit_log`·`facility_owners`·`business_verification_requests`
전부 0행, `users` 는 **자기 행만** 보인다.

### 2-3. 게이트

```
pytest            863 passed
ruff              All checks passed
web build         36 pages (/dev, /account/business, /login 포함)
web typecheck     통과
web lint          0 errors, 147 warnings (전부 기존 항목)
web test          i18n + 776키 × 3언어 파리티 + 단위 테스트 전부 통과
schema            RESET_AND_SETUP.sql ↔ migrations 일치
```

---

## 3. 안 고친 것 — 판단이 필요합니다

### 3-1. 집중률을 점유율처럼 섞고 있다 (중)

`app/services/area_demand_service.py`

```python
_PARKING_WEIGHT = 0.7      # 실제 주차 점유율 (0..1, 진짜 비율)
_TOURISM_WEIGHT = 0.3

def _tourism_level(candidate):
    value = float(candidate.get("tourapi_concentration_rate")) / 100.0
    return _clamp(value)
```

관광공사 집중률은 **상대지수**다 — 100 은 "그 지점의 기준기간 중 가장 붐빈 날" 이지
"정원의 100%" 가 아니다. 게다가 지점끼리도 비교 불가능하다(각자 자기 기준선 대비).
지금 코드는 이걸 절대 점유율로 취급해 진짜 점유율과 0.7/0.3 으로 섞는다.

- 자기 최성수기인 한적한 곳 → 100 → "만석" 취급
- 늘 붐비지만 오늘은 평범한 곳 → 40 → "40% 참" 취급

**손대지 않은 이유**: 사용자에게 보이는 혼잡도 숫자가 바뀐다. 보정하려면 기준선 대비
분포를 봐야 하고, 그건 데이터를 놓고 정할 문제다. 최소 조치라면 가중치를 낮추거나
근거 문구에서 "상대지수" 임을 명시하는 것.

### 3-2. developer 가 남의 가게에 verified 데이터를 쓸 수 있다 (중)

`owns_facility()` 는 developer 를 통과시킨다(운영 지원 목적, 의도된 설계).
그런데 `/merchant/seat-status` 는 통과한 요청을 `evidence_tier='verified'` 로
`congestion_logs` 에 넣고, 그건 모델 학습에 들어간다.

즉 **개발자가 테스트 삼아 누른 방송이 학습 데이터가 된다.** `reporter_user_id` 는 남아
추적은 되지만 자동으로 걸러지지는 않는다.

제안: 소유자가 아닌 사람의 방송은 `verified` 대신 `single_report` 로 낮추는 것.
읽기·관리 우회는 그대로 두고 **데이터 생산만** 구분하면 된다.

> 실제로 이번 검증 중에 제가 이걸 밟았습니다 — §3-6.

### 3-3. 인증 없는 쓰기 경로 4개 (하)

전 라우트 77개를 실제 의존성 트리로 훑은 결과, 가드 없는 쓰기 경로는 4개다.
전부 의도된 설계지만 유량 제한이 없다:

| 경로 | 성격 |
|---|---|
| `POST /events/track` | 익명 계측 (의도) |
| `POST /voice/turn` | LLM 호출 — **비용이 붙는다** |
| `POST /travel-context/parse` | 파싱 (무상태) |
| `POST /search/ingest-request` | 행이 무제한으로 쌓인다 |

시연 전까지는 위험이 낮지만, 공개 후에는 `/voice/turn` 유량 제한이 먼저 필요하다.

### 3-4. 프로필 캐시는 프로세스 내부에 있다 (하 · 지금은 무해)

`Dockerfile` 이 uvicorn 을 워커 1개로 띄우므로 현재는 정확하다. 나중에 `--workers N`
을 붙이면 임명/회수 시 캐시 무효화가 **자기 워커에만** 적용돼 다른 워커는 최대 30초간
구 권한을 인정한다. 스케일 아웃 시점에 Redis 등 공유 무효화가 필요하다는 메모.

### 3-5. `ADMIN_API_TOKEN` 은 이미 공개된 값으로 취급해야 한다 (중)

예전에 `NEXT_PUBLIC_ADMIN_API_TOKEN` 으로 프런트 번들에 미러됐다. 번들을 받은 사람은
누구나 읽을 수 있었다. 지금은 그 경로가 폐지됐지만, **값 자체는 이미 새어 나갔다고
봐야** 한다.

권장 순서 (수집 중단 없이):
1. `openssl rand -hex 32` 로 새 값 생성
2. Render 에 `SERVICE_API_TOKEN` 추가 (기존 `ADMIN_API_TOKEN` 은 그대로 둔다)
3. Supabase Vault `nextspot_area_demand_admin_token` 을 새 값으로 갱신
4. GitHub Actions Secret `SERVICE_API_TOKEN` 추가
5. 다음 수집이 정상인지 확인 후 `ADMIN_API_TOKEN` 을 아무 값으로나 교체

### 3-6. 쓰기 경로를 안전하게 시험할 곳이 없다 (중)

§2-1 매트릭스를 돌리면서 **프로덕션에 가짜 `verified` 행 3개를 썼습니다.**
좌석 방송 두 건(이풍녀 구로쌈밥, 경도미야꼬우동)과 그에 딸린 `congestion_logs` 3행.

바로 정리했고 확인했습니다 — `merchant_report` 로그 0건, 좌석 방송 잔여 0건,
`facilities.features.seat_status` 원상복구. 남은 오염은 없습니다.

원인은 스테이징이 없어서 권한 매트릭스를 실 DB 로 돌린 것입니다. 읽기 경로만 실 DB 로
확인하고 쓰기는 §1-4 처럼 fake 로 검증했어야 했습니다.
필요한 것: 별도 Supabase 프로젝트 또는 수집/방송 경로의 dry-run 플래그.

---

## 4. 다음에 하실 일

### 4-1. 결정 필요

- [ ] **`main` 으로 올릴지** — 이게 Render/Vercel 배포 트리거다. `yunseong` 은 푸시돼 있다.
      올리기 전에 §3-5 의 토큰 회전을 먼저 하시는 게 안전하다(순서상 3-5 → main).
- [ ] §3-1 집중률 처리 방향
- [ ] §3-2 developer 방송의 evidence_tier

### 4-2. 확인만 하면 되는 것

- [ ] 심사 계정 2개로 실제 로그인 (`openapi@naver.com` → `/merchant`,
      `openapi@gmail.com` → `/admin/dashboard`). 저는 비밀번호가 없어 이 부분만
      브라우저 검증을 못 했다 — API 레벨 매트릭스(§2-1)로는 전부 확인됐다.
- [ ] Supabase Site URL 이 아직 `localhost:3000` 이면 Vercel 도메인으로
      (대시보드에서만 확인 가능 — API 로는 안 나온다)

### 4-3. 카카오 (전부터 남아 있던 것)

- [ ] 개인 개발자 **비즈 앱 전환** — `account_email` 스코프가 GoTrue 에 하드코딩돼 있어
      이것 없이는 KOE205 를 못 푼다
- [ ] 앱 이름이 아직 **"Induspot"** 이다 — 동의 화면에 그대로 나온다. "NextSpot" 으로 변경

---

## 5. 커밋 목록

```
7142ac7  style(api): area_demand 의 미사용 require_role import 제거 (ruff)
6dd9f1e  test(web): 역할 판정 규칙을 accountRoles.ts 로 분리하고 테스트를 붙였다
ca8c2ee  fix(api): 사업자 인증 심사 — 증빙 삭제를 상태 갱신 뒤로
2cb24f0  test(api): 개발자 콘솔 37개 테스트 — 앱에서 가장 강한 권한 표면이 무방비였다
c2db141  docs: P3 — 공유 토큰·콘솔 비밀번호 폐지를 문서에 반영
623f18a  fix(api): 스케줄러 수집 경로에 기계 인증 복구 — RBAC 전환의 잠복 회귀 차단
c5f77b3  fix(web): /login 을 Suspense 로 감싸 정적 export 빌드 복구
```
