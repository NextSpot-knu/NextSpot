# Solar 자율권 #5 거절 이해 + 편의점 편의 레이어 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 거절 실험실 자유텍스트에서 Solar가 선호 보정을 제안하고 **사용자 1탭 확인 후에만** 8차원 벡터를 서버 고정 5%로 보정(#5), 그리고 공중화장실 패턴을 복제한 **편의점 편의 레이어**를 추가한다.

**Architecture:** classify(`POST /lab/{id}/reason/classify`)의 기존 chat_json 1회에 제안 스키마를 동승시키고(additive), 확인은 신규 `POST /lab/{id}/adjustment/confirm`이 전용 슬롯 `adjustment_applied_at`을 원자 선점한 뒤에만 벡터를 움직인다(무상태 제안 — 클라이언트 재전송 + 서버 화이트리스트 재검증). 편의점은 `restroom_service` 패턴 복제 — Kakao 카테고리 검색(CS2) 실시간 프록시, DB 저장 없음. 스펙 정본: `docs/SOLAR_AUTONOMY_35_PLAN.md`.

**Tech Stack:** FastAPI + supabase-py(service_role) + Upstage Solar(llm_client), Next.js 정적 export + sonner + 자체 i18n, pytest / tsx 단위테스트 / Playwright.

**#3(사유 사실 선택권)은 이 플랜 범위 밖이다** — `feature/time-weather-ux`가 `recommendations.py`를 선점 수정 중이라(스펙 §2) 머지·rebase 후 별도 플랜으로 작성한다. #5·편의점은 timeweather와 파일 겹침 0이라 즉시 착수 가능하고, 이 플랜만으로 사이클 종결이 가능하다(스펙 §7).

## Global Constraints

- **SPOT 신중 구역 변경 0줄**: `apps/api/app/services/spot/score.py` · `packages/shared-types/spot.ts`를 건드리지 않는다.
- **LLM 3원칙**: 실패는 전부 200 + 무해 폴백 / LLM 출력은 화이트리스트 enum까지만(8차원 벡터 직접 출력 금지) / 자유텍스트·LLM 응답 원문 서버 로그 금지(코드·길이만).
- **i18n 4로케일(ko/en/ja/zh) 동시 반영** — 신규 노출 문자열은 enum→i18n 키 조립. i18n 작업을 병렬 에이전트에 분할 배정 금지.
- **스키마 변경** = `supabase/migrations/` 신규 파일 + `node scripts/build_reset.mjs` 재생성. `RESET_AND_SETUP.sql` 직접 수정 금지.
- **검증 게이트**(커밋 전, CI와 동일): web `npm run lint && npm run typecheck && npm run test && npm run build`(apps/web) / api `py -3.11 -m pytest -q` + `py -3.11 -m ruff check .`(apps/api, `PYTHONUTF8=1`) / 스키마 파리티 `node scripts/build_reset.mjs && git diff --exit-code supabase/RESET_AND_SETUP.sql`(루트).
- **서버 고정 5% lerp**: 보정 강도·방향·속성은 전부 서버 통제. 클라이언트 값은 화이트리스트 재검증만 통과시킨다.
- **토스트**: 전역 sonner Toaster 1개만(`app/layout.tsx`) — 페이지 로컬 showToast 금지.
- **커밋 푸터**(모든 커밋):
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
  ```
- 구현 완료 후 **Codex 적대 감사**(별도 세션, 팀 관례) 후 머지 판단.

## 실행 전 준비 (superpowers:using-git-worktrees)

베이스 = `feature/jinseok` HEAD(스펙 커밋 `1497f48` 포함 상태). 원본 트리의 미커밋 작업과 격리한다.

```powershell
cd C:\Users\hennr\Desktop\NextSpot\NextSpot
git worktree add ..\NextSpot-feature-solar35 -b feature/solar-autonomy-35 feature/jinseok
cd ..\NextSpot-feature-solar35
npm install          # 모노레포 루트 node_modules (Playwright가 ../../node_modules 경로를 참조)
```

pytest 실행 위치는 항상 `apps/api`, 인터프리터는 `py -3.11` + `$env:PYTHONUTF8=1`.

---

## Milestone A — #5 거절 이해 (서버)

### Task 1: 마이그레이션 — `user_feedback.adjustment_applied_at` 전용 슬롯

**Files:**
- Create: `supabase/migrations/20260731090000_lab_adjustment_slot.sql`
- Regenerate: `supabase/RESET_AND_SETUP.sql` (스크립트 자동 생성 — 직접 수정 금지)

**Interfaces:**
- Produces: `user_feedback.adjustment_applied_at timestamptz NULL` 컬럼. Task 2의 `claim_adjustment`가 이 컬럼을 조건부 UPDATE로 선점한다.

- [ ] **Step 1: 마이그레이션 파일 작성**

```sql
-- 거절 이해(#5) — '확인 후 선호 보정'의 전용 학습 슬롯.
-- 배경: classify 는 분류 성공 즉시 learning_applied_at 슬롯을 선점한다(-5% 사유 학습).
--   나중에 오는 '확인 후 속성 보정'이 같은 슬롯을 쓰면 둘이 상호 배제되므로 전용 슬롯을 신설한다
--   (docs/SOLAR_AUTONOMY_35_PLAN.md §3-1 — 두 슬롯은 독립, 각각 행당 at-most-once).
-- 재실행 안전: ADD COLUMN IF NOT EXISTS. 새 테이블/함수 없음 → scripts/build_reset.mjs 의
--   PRELUDE DROP 목록 수정 불필요(user_feedback 은 이미 DROP 대상).
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS adjustment_applied_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.user_feedback.adjustment_applied_at IS
    '거절 이해(#5) 확인 후 속성 보정 적용 시각. NOT NULL 이면 재적용 금지(멱등 가드). learning_applied_at 과 독립.';
```

- [ ] **Step 2: RESET_AND_SETUP.sql 재생성 및 반영 확인**

Run(루트): `node scripts/build_reset.mjs`
Expected: 스크립트 정상 종료, `git status`에 `supabase/RESET_AND_SETUP.sql` 변경 표시.

Run: `git diff supabase/RESET_AND_SETUP.sql | Select-String "adjustment_applied_at" | Select-Object -First 2`
Expected: `adjustment_applied_at` 추가 라인이 보인다.

- [ ] **Step 3: Commit**

```powershell
git add supabase/migrations/20260731090000_lab_adjustment_slot.sql supabase/RESET_AND_SETUP.sql
git commit -m @'
feat(db): 거절 이해(#5) 확인 후 보정 전용 슬롯 adjustment_applied_at

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 2: feedback_service — 보정 화이트리스트·순수 lerp·슬롯 선점

**Files:**
- Modify: `apps/api/app/services/feedback_service.py` (상수는 `REASON_NOTE_MAX_LEN` 블록 아래, 함수는 파일 끝 `apply_reason` 뒤)
- Test: `apps/api/tests/services/test_feedback_service.py` (파일 끝에 추가)

**Interfaces:**
- Consumes: 기존 `_utcnow()`, `_TABLE`, 모듈 관례(클라이언트 주입, 라우터 미임포트).
- Produces:
  - `fs.ADJUSTMENT_ATTR_DIM: dict[str, int]` — `{"tasty": 4, "instagrammable": 5, "barrier_free": 6, "quiet": 7}` (Task 4·5의 화이트리스트 정본)
  - `fs.ADJUSTMENT_DIRECTIONS: frozenset[str]` — `{"+", "-"}`
  - `fs.ADJUSTMENT_LERP = 0.05`
  - `fs.apply_attribute_adjustment(vector: list[float], dim: int, direction: str) -> list[float]` (순수 함수, Task 3이 사용)
  - `async fs.claim_adjustment(client, *, feedback_row: dict) -> bool` (Task 5가 사용 — True=이 요청이 승자)

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/services/test_feedback_service.py` 끝에 추가

```python
# =========================================================================
# 거절 이해(#5) — 확인 후 보정: 화이트리스트 패리티 / 순수 lerp / 전용 슬롯 선점
# =========================================================================


def test_adjustment_attr_dim_matches_preference_nlp():
    # 보정 화이트리스트는 preference_nlp_service.ATTR_DIM(dim4~7)과 1:1 이어야 한다.
    # (직접 임포트 대신 패리티 테스트 — REASON_CODES/Literal 패리티와 동일 관례.)
    from app.services.preference_nlp_service import ATTR_DIM

    assert fs.ADJUSTMENT_ATTR_DIM == ATTR_DIM
    assert fs.ADJUSTMENT_DIRECTIONS == frozenset({"+", "-"})


def test_apply_attribute_adjustment_is_bounded_5_percent():
    # '+' 는 해당 속성 원핫 방향으로 5% lerp, '-' 는 반대 — 서버 고정 클램프(입력값 무시).
    vec = [0.5, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0]
    plus = fs.apply_attribute_adjustment(vec, 7, "+")
    minus = fs.apply_attribute_adjustment(vec, 7, "-")
    assert plus[7] == pytest.approx(0.05)     # 0 + 0.05*(1-0)
    assert minus[7] == pytest.approx(-0.05)   # 0 - 0.05*(1-0)
    assert plus[0] == pytest.approx(0.475)    # 0.5 + 0.05*(0-0.5)
    assert vec == [0.5, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0]  # 순수 함수 — 입력 불변


def _adjustment_row(**overrides) -> dict:
    row = {
        "id": "fb-adj-1",
        "user_id": USER,
        "recommendation_id": REC,
        "action": fs.ACTION_REJECTED,
        "reason_status": fs.STATUS_ANSWERED,
        "learning_applied_at": None,
        "adjustment_applied_at": None,
        fs.CREATED_COLUMN: NOW.isoformat(),
    }
    row.update(overrides)
    return row


def test_claim_adjustment_wins_exactly_once():
    client = FakeSupabase()
    client.rows("user_feedback").append(_adjustment_row())

    first = asyncio.run(fs.claim_adjustment(client, feedback_row={"id": "fb-adj-1"}))
    second = asyncio.run(fs.claim_adjustment(client, feedback_row={"id": "fb-adj-1"}))

    assert first is True
    assert second is False  # 이미 선점 — 호출자는 applied:false 멱등 응답
    assert client.rows("user_feedback")[0]["adjustment_applied_at"] is not None


def test_claim_adjustment_independent_of_learning_slot():
    # 사유 학습 슬롯(learning_applied_at)이 이미 차 있어도(-5% 학습 완료) 보정 슬롯은 별도로 선점된다.
    client = FakeSupabase()
    client.rows("user_feedback").append(_adjustment_row(learning_applied_at=NOW.isoformat()))

    assert asyncio.run(fs.claim_adjustment(client, feedback_row={"id": "fb-adj-1"})) is True
    row = client.rows("user_feedback")[0]
    assert row["adjustment_applied_at"] is not None
    assert row["learning_applied_at"] == NOW.isoformat()  # 학습 슬롯은 건드리지 않는다
```

- [ ] **Step 2: 실패 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/services/test_feedback_service.py -q -k adjustment`
Expected: FAIL — `AttributeError: module 'app.services.feedback_service' has no attribute 'ADJUSTMENT_ATTR_DIM'`

- [ ] **Step 3: 구현** — `feedback_service.py`의 `REASON_NOTE_MAX_LEN = 200` 아래에 상수 추가

```python
# --- 거절 이해(#5) — 확인 후 속성 보정 ----------------------------------------------

#: 보정 가능 속성 → 8차원 선호 벡터 차원. preference_nlp_service.ATTR_DIM(dim4~7)과
#: 동일해야 한다 — 직접 임포트하지 않고 패리티 테스트로 강제한다(이 모듈은 순수 서비스 유지).
ADJUSTMENT_ATTR_DIM: dict[str, int] = {
    "tasty": 4,            # 맛집/평점
    "instagrammable": 5,   # 감성/인스타
    "barrier_free": 6,     # 무장애/접근성
    "quiet": 7,            # 한적/조용
}

#: 보정 방향 화이트리스트. '+' = 그 속성을 더 원함, '-' = 덜 원함.
ADJUSTMENT_DIRECTIONS: frozenset[str] = frozenset({"+", "-"})

#: 서버 고정 보정 강도(5% lerp) — 거절 학습 계열 클램프 관례. 클라이언트가 어떤 값을 보내도 이 상수만 쓴다.
ADJUSTMENT_LERP = 0.05
```

같은 파일 끝(`apply_reason` 뒤)에 함수 2개 추가:

```python
def apply_attribute_adjustment(vector: list[float], dim: int, direction: str) -> list[float]:
    """8차원 선호 벡터의 속성 차원(dim)을 원핫 목표로 ±5% lerp 한 새 벡터를 돌려준다(순수 함수).

    adjust_user_vector_on_feedback 의 수락/거절 lerp 와 동일한 형태 — '+' 는 해당 속성 원핫
    벡터 방향으로 ADJUSTMENT_LERP 만큼 이동(선호 강화), '-' 는 반대(선호 약화).
    L2 정규화는 저장 시점(PreferenceVectorStore.upsert_user_vector)이 담당한다.
    """
    target = [0.0] * len(vector)
    target[dim] = 1.0
    sign = 1.0 if direction == "+" else -1.0
    return [v + sign * ADJUSTMENT_LERP * (t - v) for v, t in zip(vector, target)]


async def claim_adjustment(client, *, feedback_row: dict) -> bool:
    """확인된 보정의 전용 슬롯(adjustment_applied_at)을 원자적으로 1회 선점한다.

    apply_reason 의 learning_applied_at 슬롯과 **독립** — 사유 학습(-5%)과 확인 후 속성 보정은
    각각 행당 최대 1회씩 공존한다(docs/SOLAR_AUTONOMY_35_PLAN.md §3-1). PostgREST `is.null`
    조건부 UPDATE 로 같은 NULL 슬롯을 본 요청 중 한 요청만 승자가 된다.
    True = 이 요청이 승자(호출자만 벡터를 움직인다). False = 이미 적용됨(멱등 응답용).
    선점 후 벡터 호출이 실패하면 그 보정은 유실된다 — '재시도 이중 적용'보다 나은 트레이드오프
    (apply_reason 과 동일한 선택, 모듈 docstring 참조).
    """
    now = _utcnow()
    query = (
        client.table(_TABLE)
        .update({"adjustment_applied_at": now.isoformat()})
        .eq("id", feedback_row["id"])
        .is_("adjustment_applied_at", "null")
    )
    res = await asyncio.to_thread(query.execute)
    claimed = bool(getattr(res, "data", None))
    logger.info("feedback_adjustment_claimed", feedback_id=feedback_row.get("id"), claimed=claimed)
    return claimed
```

- [ ] **Step 4: 통과 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/services/test_feedback_service.py -q`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: Commit**

```powershell
git add apps/api/app/services/feedback_service.py apps/api/tests/services/test_feedback_service.py
git commit -m @'
feat(api): 거절 이해(#5) 보정 화이트리스트·5% lerp·전용 슬롯 선점 서비스

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 3: PreferenceVectorStore — `adjust_user_vector_attribute` 신규 메서드

**Files:**
- Modify: `apps/api/app/services/preference_vector_service.py` (`adjust_user_vector_on_feedback` 뒤에 메서드 추가 — **기존 메서드 시그니처 무변경**)
- Test: Create `apps/api/tests/services/test_preference_vector_service.py`

**Interfaces:**
- Consumes: `fs.apply_attribute_adjustment(vector, dim, direction)` (Task 2), 기존 `get_user_vector`/`upsert_user_vector`/`_normalize_vector`.
- Produces: `async preference_vector_service.adjust_user_vector_attribute(user_id: str, dim: int, direction: str)` — Task 5의 confirm 엔드포인트가 **위치 인자**로 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성** — 새 파일 `tests/services/test_preference_vector_service.py`

```python
"""PreferenceVectorStore.adjust_user_vector_attribute(#5 확인 후 보정).

실 Supabase 는 쓰지 않는다 — client=None 으로 강제해 메모리 폴백 경로(결정적)로 검증한다.
lerp 산식 자체는 feedback_service.apply_attribute_adjustment(순수 함수) 테스트가 소유하고,
여기서는 저장소 왕복(조회→lerp→정규화 저장)만 본다.
"""
import asyncio
import math

from app.services.preference_vector_service import PreferenceVectorStore

USER = "11111111-1111-1111-1111-111111111111"


def _memory_store() -> PreferenceVectorStore:
    store = PreferenceVectorStore()
    store.client = None  # Supabase 미가용 — 메모리 폴백 경로
    return store


def test_plus_direction_raises_attribute_dim_and_renormalizes():
    store = _memory_store()
    store._memory[USER] = [0.5, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0]  # L2 노름 1

    asyncio.run(store.adjust_user_vector_attribute(USER, 7, "+"))

    updated = store._memory[USER]
    assert len(updated) == 8
    assert updated[7] > 0.0  # 한적함 차원이 올라간다
    assert math.isclose(math.sqrt(sum(x * x for x in updated)), 1.0, rel_tol=1e-9)  # 저장 시 L2 정규화


def test_minus_direction_lowers_attribute_share():
    store = _memory_store()
    store._memory[USER] = [0.4, 0.4, 0.4, 0.4, 0.0, 0.0, 0.0, 0.6]  # L2 노름 1

    asyncio.run(store.adjust_user_vector_attribute(USER, 7, "-"))

    assert store._memory[USER][7] < 0.6


def test_cold_start_uses_uniform_fallback_not_one_hot():
    # 벡터가 없는 사용자: 제로 벡터 → l2_normalize 의 균등 단위벡터 폴백 위에서 5%만 이동.
    # 원핫으로 튀면 한 번의 보정이 취향 전체를 덮어쓰게 된다 — 그런 일이 없어야 한다.
    store = _memory_store()

    asyncio.run(store.adjust_user_vector_attribute(USER, 4, "+"))

    updated = store._memory[USER]
    assert min(updated) > 0.0
    assert updated[4] == max(updated)
```

- [ ] **Step 2: 실패 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/services/test_preference_vector_service.py -q`
Expected: FAIL — `AttributeError: 'PreferenceVectorStore' object has no attribute 'adjust_user_vector_attribute'`

- [ ] **Step 3: 구현** — `preference_vector_service.py`

파일 상단 import 에 추가:

```python
from app.services.feedback_service import apply_attribute_adjustment
```

`adjust_user_vector_on_feedback` 메서드 아래(클래스 안, 싱글톤 인스턴스 생성 위)에 추가:

```python
    async def adjust_user_vector_attribute(self, user_id: str, dim: int, direction: str):
        """거절 이해(#5) 확인 후 보정 — 속성 차원(dim) 원핫 목표로 서버 고정 5% lerp.

        순수 계산은 feedback_service.apply_attribute_adjustment 가 소유한다(여기는 저장소 왕복만).
        기존 메서드(adjust_user_vector_on_feedback 등) 시그니처는 변경하지 않는다(호환 관례).
        """
        current_vector = await self.get_user_vector(user_id)
        if not current_vector:
            current_vector = [0.0] * 8  # _normalize_vector 가 균등 단위벡터로 폴백(콜드스타트)
        current_vector = self._normalize_vector(current_vector)
        await self.upsert_user_vector(user_id, apply_attribute_adjustment(current_vector, dim, direction))
```

- [ ] **Step 4: 통과 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/services/test_preference_vector_service.py tests/services/test_feedback_service.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add apps/api/app/services/preference_vector_service.py apps/api/tests/services/test_preference_vector_service.py
git commit -m @'
feat(api): PreferenceVectorStore 속성 차원 보정 메서드(확인 후 5% lerp)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 4: classify 확장 — 선호 보정 제안(suggestion) 동승

**Files:**
- Modify: `apps/api/app/routers/lab.py` (`_CLASSIFY_SYSTEM`, `_classify_free_text`, `classify_reason`)
- Test: `apps/api/tests/routers/test_lab.py` (§6 뒤에 추가)

**Interfaces:**
- Consumes: `fs.ADJUSTMENT_ATTR_DIM`, `fs.ADJUSTMENT_DIRECTIONS` (Task 2).
- Produces: classify 성공 응답에 additive 필드 — `"suggestion": {"attribute": str, "direction": str} | None`, `"requires_confirmation": True`. **실패 응답(resolved=false)은 현행 그대로**(기존 exact-dict 테스트가 이를 강제한다).
- 제안은 **무상태** — DB 미기록. 확인 시 클라이언트가 재전송하고 Task 5가 재검증한다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test_lab.py` §6 끝에 추가

```python
# =========================================================================
# 6-b. 거절 이해(#5) — classify 의 선호 보정 제안(additive, 무상태)
# =========================================================================


def test_classify_returns_whitelisted_suggestion(auth_client):
    # 유효 제안은 그대로 통과 + requires_confirmation(자동 반영 아님 — PM 확정: 확인 후 반영).
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    chat = AsyncMock(return_value={
        "category": "too_crowded", "note": "붐빔",
        "suggestion": {"attribute": "quiet", "direction": "+"},
    })
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=AsyncMock()), \
         patch(_LLM_ENABLED, return_value=True), \
         patch(_LLM_CHAT_JSON, new=chat):
        res = _classify(auth_client, db, "사람이 너무 많아서 시끄러웠어요")

    assert res.status_code == 200
    body = res.json()
    assert body["resolved"] is True
    assert body["suggestion"] == {"attribute": "quiet", "direction": "+"}
    assert body["requires_confirmation"] is True
    # 제안은 무상태 — DB 행에 기록되지 않는다(확인 시 재전송·서버 재검증).
    assert "suggestion" not in db._tables["user_feedback"][0]


@pytest.mark.parametrize(
    "raw",
    [
        {"attribute": "cheap", "direction": "+"},   # 화이트리스트 밖 속성
        {"attribute": "quiet", "direction": "up"},  # 화이트리스트 밖 방향
        {"attribute": "quiet"},                     # 방향 누락
        "quiet+",                                   # dict 가 아님
        {"vector": [0.1] * 8},                      # 8차원 벡터 직접 출력 시도(금지 구역 ⑥)
    ],
)
def test_classify_discards_invalid_suggestion_entirely(auth_client, raw):
    # 화이트리스트 밖 제안은 전량 폐기(suggestion=None) — 분류 자체는 유효하므로 resolved 는 유지.
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    chat = AsyncMock(return_value={"category": "too_crowded", "note": "붐빔", "suggestion": raw})
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=AsyncMock()), \
         patch(_LLM_ENABLED, return_value=True), \
         patch(_LLM_CHAT_JSON, new=chat):
        res = _classify(auth_client, db, "사람이 많아요")

    assert res.status_code == 200
    body = res.json()
    assert body["resolved"] is True
    assert body["suggestion"] is None


def test_classify_without_suggestion_keeps_contract(auth_client):
    # suggestion 키가 아예 없어도(구형 응답) 기존 계약 그대로 + suggestion=None (additive 보장).
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    chat = AsyncMock(return_value={"category": "not_my_taste", "note": "취향 아님"})
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=AsyncMock()), \
         patch(_LLM_ENABLED, return_value=True), \
         patch(_LLM_CHAT_JSON, new=chat):
        res = _classify(auth_client, db, "분위기가 제 취향이 아니에요")

    assert res.status_code == 200
    body = res.json()
    assert body["resolved"] is True
    assert body["reason_code"] == "not_my_taste"
    assert body["suggestion"] is None
    assert body["requires_confirmation"] is True
```

- [ ] **Step 2: 실패 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_lab.py -q -k suggestion`
Expected: FAIL — `KeyError: 'suggestion'`

- [ ] **Step 3: 구현** — `lab.py`

(1) `_REASON_DESCRIPTIONS` 정의 바로 아래에 추가:

```python
# 거절 이해(#5): 분류에 더해 선호 보정 '제안'까지 같은 chat_json 1회로 받는다(추가 호출 0).
# 제안 화이트리스트의 정본은 fs.ADJUSTMENT_ATTR_DIM — 밖의 값은 _parse_suggestion 이 전량 폐기한다.
_SUGGESTION_DESCRIPTIONS: dict[str, str] = {
    "tasty": "맛·평점을 얼마나 중시하는지",
    "instagrammable": "감성·사진 명소를 얼마나 중시하는지",
    "barrier_free": "접근성(무장애)을 얼마나 중시하는지",
    "quiet": "한적함을 얼마나 중시하는지",
}
```

(2) `_CLASSIFY_SYSTEM` 전체를 다음으로 교체(기존 카테고리 나열은 유지, 출력 스키마에 suggestion 추가):

```python
_CLASSIFY_SYSTEM = (
    "너는 여행지 추천을 거절한 사용자의 짧은 이유 문장을 정해진 카테고리 하나로 분류하는 분류기다.\n"
    "아래 카테고리 중 사용자의 문장에 가장 잘 맞는 코드 하나를 고른다. "
    "어디에도 확실히 맞지 않으면 category 를 null 로 둔다(억지로 고르지 말 것).\n\n"
    "카테고리:\n"
    + "\n".join(f"- {code}: {desc}" for code, desc in _REASON_DESCRIPTIONS.items())
    + "\n\n"
    "추가로, 이유가 아래 취향 속성 중 하나의 선호 변화로 읽히면 suggestion 을 채운다"
    "(확실하지 않으면 null — 억지로 제안하지 말 것):\n"
    + "\n".join(f"- {code}: {desc}" for code, desc in _SUGGESTION_DESCRIPTIONS.items())
    + "\n\n"
    "반드시 JSON 객체 하나만 출력한다: "
    '{"category": <위 코드 중 하나 또는 null>, '
    '"note": <사용자 이유를 20자 이내로 요약한 한국어 문자열>, '
    '"suggestion": {"attribute": <위 속성 코드 중 하나>, "direction": "+" 또는 "-"} 또는 null} '
    '— direction 은 "+"=그 속성을 더 원함, "-"=덜 원함.'
)
```

(3) `_classify_free_text` 를 다음으로 교체(제안 파서 포함, 반환 3-튜플, max_tokens 120→160):

```python
def _parse_suggestion(parsed: dict) -> dict | None:
    """LLM 의 선호 보정 제안을 화이트리스트로 검증한다 — 밖이면 전량 폐기(None, 무해 폴백).

    화이트리스트 = fs.ADJUSTMENT_ATTR_DIM 4속성 × fs.ADJUSTMENT_DIRECTIONS 2방향.
    벡터·수치 등 다른 형태는 절대 통과시키지 않는다(LLM 출력은 enum 까지만 — 금지 구역 ⑥).
    """
    raw = parsed.get("suggestion")
    if not isinstance(raw, dict):
        return None
    attribute = raw.get("attribute")
    direction = raw.get("direction")
    if attribute not in fs.ADJUSTMENT_ATTR_DIM or direction not in fs.ADJUSTMENT_DIRECTIONS:
        return None
    return {"attribute": attribute, "direction": direction}


async def _classify_free_text(text: str) -> tuple[str | None, str | None, dict | None]:
    """자유 텍스트를 기존 reason_code 하나로 분류하고 선호 보정 제안을 함께 받는다(LLM 1회).

    (reason_code, note, suggestion) 반환. 분류 실패는 전부 (None, None, None) — 호출자는 무해 폴백:
      - LLM None(비활성/타임아웃/오류) 또는 비-dict 출력
      - category 가 문자열이 아니거나 **화이트리스트(fs.REASON_CODES) 밖**(환각 방어)
      - category 가 null(모델이 확신하지 못함)
    suggestion 은 분류가 유효할 때만 의미가 있고, 그 자체도 화이트리스트 검증을 통과해야 한다
    (_parse_suggestion — 탈락 시 분류만 채택하고 제안은 None).
    note 는 20자 요약(있으면) — 200자 상한으로 방어적 절단, 없거나 공백이면 None.
    """
    parsed = await llm_client.chat_json(_CLASSIFY_SYSTEM, text, max_tokens=160)
    if not isinstance(parsed, dict):
        return None, None, None
    category = parsed.get("category")
    if not isinstance(category, str) or category not in fs.REASON_CODES:
        return None, None, None
    note = parsed.get("note")
    if isinstance(note, str) and note.strip():
        note = note.strip()[: fs.REASON_NOTE_MAX_LEN]
    else:
        note = None
    return category, note, _parse_suggestion(parsed)
```

(4) `classify_reason` 안에서 호출·응답을 갱신:

- `reason_code, note = await _classify_free_text(text)` → `reason_code, note, suggestion = await _classify_free_text(text)`
- 성공 로그에 필드 추가(자유 텍스트가 아닌 enum 이라 기록 가능):

```python
        suggested_attribute=suggestion["attribute"] if suggestion else None,
```

- 성공 반환 dict(마지막 `return { "resolved": True, ... }`)에 두 필드 추가:

```python
        "suggestion": suggestion,
        "requires_confirmation": True,
```

**주의:** 실패 경로(`resolved: False` 3곳)의 반환 dict 는 절대 바꾸지 않는다 — 기존 테스트가 exact-dict 로 고정한다.

- [ ] **Step 4: 통과 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_lab.py -q`
Expected: PASS (기존 §1~§6 전부 + 신규 6-b)

- [ ] **Step 5: Commit**

```powershell
git add apps/api/app/routers/lab.py apps/api/tests/routers/test_lab.py
git commit -m @'
feat(api): classify 에 선호 보정 제안 동승(추가 LLM 호출 0, 무상태 additive)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 5: 확인 엔드포인트 — `POST /api/v1/lab/{feedback_id}/adjustment/confirm`

**Files:**
- Modify: `apps/api/app/routers/lab.py` (import 1줄 + Request 모델 + 엔드포인트, `classify_reason` 아래)
- Test: `apps/api/tests/routers/test_lab.py` (`_pending_row` 헬퍼 수정 + §7 추가)

**Interfaces:**
- Consumes: `fs.claim_adjustment` (Task 2), `preference_vector_service.adjust_user_vector_attribute(user_id, dim, direction)` (Task 3 — 위치 인자), 기존 `_fetch_own_feedback`/`fs.is_expired`.
- Produces: `POST /api/v1/lab/{feedback_id}/adjustment/confirm` body `{"attribute": ..., "direction": ...}` → 200 `{"applied": true, "attribute", "direction"}` | 200 `{"applied": false}`(이미 적용) | 404/403/409/422. Task 7(프런트 `confirmLabAdjustment`)이 소비한다.

- [ ] **Step 1: 테스트 헬퍼 갱신** — `test_lab.py` `_pending_row` 의 `"learning_version": 0,` 줄 아래에 1줄 추가

```python
        "adjustment_applied_at": None,
```

- [ ] **Step 2: 실패하는 테스트 작성** — `test_lab.py` 파일 끝에 추가

```python
# =========================================================================
# 7. 확인 후 보정(adjustment/confirm) — 전용 슬롯 정확히 1회 + 서버 재검증
# =========================================================================


def _confirm(client, db, attribute="quiet", direction="+"):
    with patch("app.routers.lab.supabase_admin", new=db):
        return client.post(
            f"/api/v1/lab/{FEEDBACK_ID}/adjustment/confirm",
            json={"attribute": attribute, "direction": direction},
        )


def test_confirm_applies_exactly_once(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    adjust_attr = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_attribute", new=adjust_attr):
        first = _confirm(auth_client, db)
        second = _confirm(auth_client, db)  # 중복 탭/재시도 — 멱등 응답

    assert first.status_code == 200
    assert first.json() == {"applied": True, "attribute": "quiet", "direction": "+"}
    assert second.status_code == 200
    assert second.json() == {"applied": False}

    # 핵심 계약: 벡터 보정은 정확히 1회 — quiet=dim7, 방향 '+', 강도는 서버 고정.
    assert adjust_attr.await_count == 1
    assert adjust_attr.await_args.args == (USER, 7, "+")
    assert db._tables["user_feedback"][0]["adjustment_applied_at"] is not None


def test_confirm_independent_of_learning_slot(auth_client):
    # classify 가 이미 -5% 사유 학습(learning_applied_at 선점)한 행에도 보정은 전용 슬롯으로 1회 적용된다.
    db = _lab_db([_pending_row(
        1, id=FEEDBACK_ID,
        reason_status=fs.STATUS_ANSWERED,
        learning_applied_at=NOW.isoformat(),
    )])
    adjust_attr = AsyncMock()
    adjust_feedback = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_attribute", new=adjust_attr), \
         patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust_feedback):
        res = _confirm(auth_client, db)

    assert res.status_code == 200
    assert res.json()["applied"] is True
    assert adjust_attr.await_count == 1
    adjust_feedback.assert_not_awaited()  # 사유 학습 경로는 건드리지 않는다(이중 학습 금지)
    row = db._tables["user_feedback"][0]
    assert row["learning_applied_at"] == NOW.isoformat()  # 기존 학습 슬롯 불변
    assert row["adjustment_applied_at"] is not None


def test_confirm_on_other_users_feedback_403(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID, user_id=OTHER_USER)])
    adjust_attr = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_attribute", new=adjust_attr):
        res = _confirm(auth_client, db)
    assert res.status_code == 403
    adjust_attr.assert_not_awaited()
    assert db._tables["user_feedback"][0]["adjustment_applied_at"] is None


def test_confirm_expired_409(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID, age_days=31)])
    adjust_attr = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_attribute", new=adjust_attr):
        res = _confirm(auth_client, db)
    assert res.status_code == 409
    adjust_attr.assert_not_awaited()


@pytest.mark.parametrize(
    "attribute, direction",
    [("cheap", "+"), ("quiet", "up"), ("vector", "+"), ("", "-")],
)
def test_confirm_invalid_payload_422(auth_client, attribute, direction):
    # 클라이언트 위변조 방어 — 제안은 무상태(재전송)이므로 여기 Literal 화이트리스트가 최종 방어선.
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    adjust_attr = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_attribute", new=adjust_attr):
        res = _confirm(auth_client, db, attribute=attribute, direction=direction)
    assert res.status_code == 422
    adjust_attr.assert_not_awaited()
    assert db._tables["user_feedback"][0]["adjustment_applied_at"] is None


def test_confirm_requires_auth():
    with TestClient(app) as c:
        res = c.post(
            f"/api/v1/lab/{FEEDBACK_ID}/adjustment/confirm",
            json={"attribute": "quiet", "direction": "+"},
        )
        assert res.status_code == 401


def test_confirm_literal_matches_service_whitelist():
    # 라우터 Literal = 서비스 화이트리스트(정본) — 어긋나면 즉시 실패(계약 패리티 관례).
    from typing import get_args

    from app.routers.lab import AdjustmentConfirmRequest

    assert set(get_args(AdjustmentConfirmRequest.model_fields["attribute"].annotation)) == set(fs.ADJUSTMENT_ATTR_DIM)
    assert set(get_args(AdjustmentConfirmRequest.model_fields["direction"].annotation)) == set(fs.ADJUSTMENT_DIRECTIONS)
```

- [ ] **Step 3: 실패 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_lab.py -q -k confirm`
Expected: FAIL — 404 (엔드포인트 미존재) 및 ImportError(AdjustmentConfirmRequest)

- [ ] **Step 4: 구현** — `lab.py`

(1) import 블록의 `from app.services import llm_client` 아래에 추가:

```python
from app.services.preference_vector_service import preference_vector_service
```

(2) `ClassifyReasonRequest` 아래에 모델 추가:

```python
class AdjustmentConfirmRequest(BaseModel):
    # 화이트리스트 서버 재검증 — 제안은 무상태(클라이언트 재전송)이므로 이 Literal 이 최종 방어선이다.
    # fs.ADJUSTMENT_ATTR_DIM / fs.ADJUSTMENT_DIRECTIONS 와의 패리티는 테스트가 강제한다.
    attribute: Literal["tasty", "instagrammable", "barrier_free", "quiet"]
    direction: Literal["+", "-"]
```

(3) `classify_reason` 엔드포인트 아래에 추가:

```python
@router.post("/{feedback_id}/adjustment/confirm")
async def confirm_adjustment(
    feedback_id: str,
    req: AdjustmentConfirmRequest,
    current_user: dict = Depends(get_current_user),
):
    """거절 이해(#5) 제안을 사용자가 1탭으로 확인 — 전용 슬롯 1회 선점 후 속성 차원 5% 보정.

    제안은 무상태다: classify 는 제안을 DB 에 기록하지 않고, 확인 시 클라이언트가 재전송한
    attribute/direction 을 여기서 다시 화이트리스트(Literal)로 검증한다 — 위조해도 서버 고정
    5% lerp 1회가 상한이다. 슬롯(adjustment_applied_at)은 learning_applied_at 과 **독립** —
    사유 학습(-5%)과 확인 후 보정이 각각 행당 최대 1회 공존한다.
    이미 적용된 행은 200 + applied:false(멱등 — 중복 탭/재시도가 오류로 보이지 않게).
    """
    user_id = current_user["id"]
    row = await _fetch_own_feedback(feedback_id, user_id)

    # answer_reason/classify 와 동일 — 30일 지난 피드백은 보정 대상에서 제외.
    if fs.is_expired(row, fs._utcnow()):
        raise HTTPException(status_code=409, detail="응답 기간(30일)이 지난 피드백입니다.")

    claimed = await fs.claim_adjustment(supabase_admin, feedback_row=row)
    if not claimed:
        logger.info("lab_adjustment_replayed", feedback_id=feedback_id, user_id=user_id)
        return {"applied": False}

    # 슬롯 선점 성공 시에만 벡터를 움직인다(행당 생애 1회). 차원·방향·강도 전부 서버 통제.
    await preference_vector_service.adjust_user_vector_attribute(
        user_id, fs.ADJUSTMENT_ATTR_DIM[req.attribute], req.direction
    )
    logger.info(
        "lab_adjustment_confirmed",
        feedback_id=feedback_id,
        user_id=user_id,
        attribute=req.attribute,
        direction=req.direction,
    )
    return {"applied": True, "attribute": req.attribute, "direction": req.direction}
```

- [ ] **Step 5: 통과 확인 + 린트**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_lab.py -q; py -3.11 -m ruff check .`
Expected: PASS / 린트 0 오류

- [ ] **Step 6: Commit**

```powershell
git add apps/api/app/routers/lab.py apps/api/tests/routers/test_lab.py
git commit -m @'
feat(api): 거절 이해(#5) 확인 엔드포인트 — 전용 슬롯 1회 선점 후 속성 보정

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 6: 계측 — 제안 노출/확인/거부 퍼널 이벤트 (서버 + 클라 미러)

**Files:**
- Modify: `apps/api/app/routers/tracking.py` (`_EVENT_PROPS` + `_validate_product_event`)
- Modify: `apps/web/lib/analytics.ts` (`EVENT_PROPS` 미러)
- Test: `apps/api/tests/routers/test_tracking_privacy.py` (끝에 추가)

**Interfaces:**
- Produces: 이벤트 3종 `lab_adjustment_suggested|confirmed|declined`, props `{attribute, direction}` (enum 전용). Task 10의 `track()` 호출이 소비한다.
- 주의: 서버 `_EVENT_PROPS`와 클라 `EVENT_PROPS`는 **항상 함께** 수정한다(한쪽만 추가하면 이벤트가 조용히 드롭/422 된다).

- [ ] **Step 1: 실패하는 테스트 작성** — `test_tracking_privacy.py` 끝에 추가

```python
def test_lab_adjustment_funnel_accepts_enums_only(monkeypatch):
    # 거절 이해(#5) 퍼널 3종 — attribute/direction 은 enum 만 통과, 자유 텍스트는 422.
    client, recorder = _client(monkeypatch)
    ok = client.post("/api/v1/events/track", json={
        "event": "lab_adjustment_confirmed", "props": {"attribute": "quiet", "direction": "+"},
    })
    assert ok.status_code == 204
    assert recorder.rows[0]["event"] == "lab_adjustment_confirmed"

    bad_attr = client.post("/api/v1/events/track", json={
        "event": "lab_adjustment_suggested", "props": {"attribute": "사용자 원문", "direction": "+"},
    })
    assert bad_attr.status_code == 422

    bad_dir = client.post("/api/v1/events/track", json={
        "event": "lab_adjustment_declined", "props": {"attribute": "quiet", "direction": "up"},
    })
    assert bad_dir.status_code == 422
    assert len(recorder.rows) == 1
```

- [ ] **Step 2: 실패 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_tracking_privacy.py -q`
Expected: FAIL — 204 대신 422 (이벤트 미등록)

- [ ] **Step 3: 서버 구현** — `tracking.py`

(1) `_EVENT_PROPS` dict 의 `"visit_confirmed": ...` 줄 아래에 추가:

```python
    "lab_adjustment_suggested": {"attribute", "direction"},
    "lab_adjustment_confirmed": {"attribute", "direction"},
    "lab_adjustment_declined": {"attribute", "direction"},
```

(2) `_ATTRIBUTES = {"indoor", "accessible"}` 줄 아래에 추가:

```python
_LAB_ADJUSTMENT_ATTRIBUTES = {"tasty", "instagrammable", "barrier_free", "quiet"}
_LAB_ADJUSTMENT_DIRECTIONS = {"+", "-"}
```

(3) `_validate_product_event` 의 `if "llm_status" in props ...` 블록 아래에 추가:

```python
    if "attribute" in props and props["attribute"] not in _LAB_ADJUSTMENT_ATTRIBUTES:
        raise HTTPException(status_code=422, detail="attribute 값이 올바르지 않습니다.")
    if "direction" in props and props["direction"] not in _LAB_ADJUSTMENT_DIRECTIONS:
        raise HTTPException(status_code=422, detail="direction 값이 올바르지 않습니다.")
```

- [ ] **Step 4: 클라 미러** — `analytics.ts` `EVENT_PROPS` 의 `voice_tool_executed: ...` 줄 아래에 추가:

```ts
  lab_adjustment_suggested: new Set(["attribute", "direction"]),
  lab_adjustment_confirmed: new Set(["attribute", "direction"]),
  lab_adjustment_declined: new Set(["attribute", "direction"]),
```

- [ ] **Step 5: 통과 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_tracking_privacy.py -q; py -3.11 -m ruff check .`
Expected: PASS

- [ ] **Step 6: Commit**

```powershell
git add apps/api/app/routers/tracking.py apps/api/tests/routers/test_tracking_privacy.py apps/web/lib/analytics.ts
git commit -m @'
feat(track): 거절 이해(#5) 제안 노출/확인/거부 퍼널 이벤트(enum 전용)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

## Milestone B — #5 거절 이해 (프런트)

### Task 7: `lib/labSuggestion.ts` — 제안 → i18n 키 조립(순수 모듈) + tsx 단위테스트

**Files:**
- Create: `apps/web/lib/labSuggestion.ts`
- Create: `apps/web/lib/labSuggestion.test.ts`
- Modify: `apps/web/package.json` (`test` 스크립트 체인)

**Interfaces:**
- Produces: `LabSuggestion` 타입(단일 정의점 — Task 8의 api-client 가 임포트), `labSuggestionKey(suggestion) -> string | null` (Task 10이 사용). api-client 를 임포트하지 않는 **순수 모듈**이라 tsx 로 브라우저 전역 없이 실행된다.

- [ ] **Step 1: 실패하는 테스트 작성** — `lib/labSuggestion.test.ts`

```ts
// labSuggestionKey 단위 테스트 (프레임워크 불필요 — voiceIntent.test.ts 관례).
// 실행: npx tsx lib/labSuggestion.test.ts
import { labSuggestionKey, type LabSuggestion } from "./labSuggestion.ts";

let failed = 0;

function check(name: string, actual: string | null, expected: string | null) {
  if (actual !== expected) {
    failed += 1;
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
  }
}

check("quiet +", labSuggestionKey({ attribute: "quiet", direction: "+" }), "lab.suggestion.quiet.up");
check("tasty -", labSuggestionKey({ attribute: "tasty", direction: "-" }), "lab.suggestion.tasty.down");
check("barrier_free +", labSuggestionKey({ attribute: "barrier_free", direction: "+" }), "lab.suggestion.barrier_free.up");
check("instagrammable -", labSuggestionKey({ attribute: "instagrammable", direction: "-" }), "lab.suggestion.instagrammable.down");
check("null 제안", labSuggestionKey(null), null);
check("undefined 제안", labSuggestionKey(undefined), null);
// 서버가 화이트리스트를 지키지만, 화면 직전 마지막 방어선도 화이트리스트 밖을 렌더하지 않는다.
check("화이트리스트 밖 속성", labSuggestionKey({ attribute: "cheap", direction: "+" } as unknown as LabSuggestion), null);
check("화이트리스트 밖 방향", labSuggestionKey({ attribute: "quiet", direction: "up" } as unknown as LabSuggestion), null);

if (failed > 0) {
  process.exit(1);
}
console.log("labSuggestion.test.ts: all passed");
```

- [ ] **Step 2: 실패 확인**

Run(apps/web): `npx tsx lib/labSuggestion.test.ts`
Expected: FAIL — `Cannot find module './labSuggestion.ts'`

- [ ] **Step 3: 구현** — `lib/labSuggestion.ts`

```ts
// 거절 이해(#5) 제안 문구 조립 — LLM 원문을 노출하지 않고 enum → i18n 키로만 표시한다.
// (4로케일 자동 해결 + 화이트리스트 밖 값이 UI 에 닿지 않는 마지막 방어선.
//  api-client 를 임포트하지 않는 순수 모듈 — tsx 단위 테스트가 브라우저 전역 없이 돈다.)

/** classify 가 제안하는 선호 보정. 반영은 반드시 사용자 1탭 확인(confirmLabAdjustment) 후에만. */
export interface LabSuggestion {
  attribute: "tasty" | "instagrammable" | "barrier_free" | "quiet";
  direction: "+" | "-";
}

const ATTRIBUTES: ReadonlySet<string> = new Set(["tasty", "instagrammable", "barrier_free", "quiet"]);

/** 제안 → i18n 메시지 키. 화이트리스트 밖 값은 null(제안 블록을 렌더하지 않는다). */
export function labSuggestionKey(suggestion: LabSuggestion | null | undefined): string | null {
  if (!suggestion || !ATTRIBUTES.has(suggestion.attribute)) return null;
  if (suggestion.direction !== "+" && suggestion.direction !== "-") return null;
  return `lab.suggestion.${suggestion.attribute}.${suggestion.direction === "+" ? "up" : "down"}`;
}
```

- [ ] **Step 4: 통과 확인 + 테스트 체인 등록**

Run(apps/web): `npx tsx lib/labSuggestion.test.ts`
Expected: `labSuggestion.test.ts: all passed`

`package.json` 의 `test` 스크립트를 다음으로 교체:

```json
    "test": "tsx lib/voiceIntent.test.ts && tsx lib/i18n/parity.test.ts && tsx lib/travelContext.test.ts && tsx lib/voiceCommands.test.ts && tsx lib/labSuggestion.test.ts",
```

Run(apps/web): `npm run test`
Expected: PASS (전 체인)

- [ ] **Step 5: Commit**

```powershell
git add apps/web/lib/labSuggestion.ts apps/web/lib/labSuggestion.test.ts apps/web/package.json
git commit -m @'
feat(web): 제안 enum -> i18n 키 조립 유틸(labSuggestion) + tsx 단위테스트

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 8: api-client — pending 계약 수리 + classify 확장 + `confirmLabAdjustment`

**Files:**
- Modify: `apps/web/lib/api-client.ts` (거절 실험실 섹션)

**Interfaces:**
- Consumes: `LabSuggestion` (Task 7), 서버 계약(Task 4·5).
- Produces: `fetchLabPending(): Promise<LabPendingItem[]>` (wire `id/created_at` → 화면 `feedbackId/recommendedAt` 정규화), `classifyLabReason(...): Promise<{ resolved: boolean; suggestion: LabSuggestion | null }>`, `confirmLabAdjustment(feedbackId, suggestion): Promise<{ applied: boolean }>`. Task 10이 소비한다.
- **결함 수리 포함:** 서버 `_serialize_pending` 은 `id/created_at` 을 주는데 기존 `LabPendingItem` 은 `feedbackId/recommendedAt` 을 기대해, 실험실 카드 액션이 `/api/v1/lab/undefined/*` 로 나가는 계약 어긋남이 있었다(2026-07-31 플랜 정찰에서 발견). 정규화 어댑터로 수리하고 Task 11의 e2e 가 **실서버 셰이프 목**으로 재발을 봉쇄한다.

- [ ] **Step 1: import 추가** — 파일 상단 import 블록에

```ts
import type { LabSuggestion } from "@/lib/labSuggestion";
```

그리고 거절 실험실 섹션(`// --- 거절 실험실 (Rejection Lab) ---` 주석 아래)에 재노출 1줄:

```ts
export type { LabSuggestion } from "@/lib/labSuggestion";
```

- [ ] **Step 2: `fetchLabPending` 정규화** — 기존 함수를 다음으로 교체 (`LabPendingItem` 인터페이스는 그대로 둔다):

```ts
/** GET /api/v1/lab/pending 원시 항목 — 서버 키는 id/created_at (routers/lab.py _serialize_pending, keysToCamel 적용 후). */
interface LabPendingWire {
  id: string;
  recommendationId: string;
  facilityId: string;
  facilityName: string;
  facilityType: string;
  createdAt: string;
  spotScore?: number;
}

/** 본인의 이유 미응답 거절 목록 — 숨김 제외, 30일 이내, 최신순 최대 10건. */
export async function fetchLabPending(): Promise<LabPendingItem[]> {
  // 서버는 id/created_at 을 주는데 화면 계약은 feedbackId/recommendedAt 이다 — 여기서 정규화한다.
  // (정규화 없이는 카드 액션이 /api/v1/lab/undefined/* 로 나가 404 가 난다 — 2026-07-31 수리.)
  const data: LabPendingWire[] = await apiClient.get("/api/v1/lab/pending");
  return (Array.isArray(data) ? data : []).map((item) => ({
    feedbackId: item.id,
    recommendationId: item.recommendationId,
    facilityId: item.facilityId,
    facilityName: item.facilityName,
    facilityType: item.facilityType,
    recommendedAt: item.createdAt,
    spotScore: item.spotScore,
  }));
}
```

- [ ] **Step 3: `classifyLabReason` 확장 + `confirmLabAdjustment` 신설** — 기존 `classifyLabReason` 을 다음으로 교체하고 그 아래에 confirm 을 추가:

```ts
/**
 * 자유 텍스트 거절 이유를 백엔드가 LLM 으로 기존 카테고리에 매핑한다.
 * resolved=true 면 선택지 제출과 동일하게 처리(학습 정확히 1회). 이때 suggestion(선호 보정 제안)이
 * 함께 오면 화면은 목록 제거를 보류하고 1탭 확인을 받는다 — 반영은 confirmLabAdjustment 후에만.
 * resolved=false 면(LLM 비활성/실패/확신 없음) 프런트가 "선택지에서 골라주세요"로 폴백한다(무해).
 */
export async function classifyLabReason(
  feedbackId: string,
  text: string
): Promise<{ resolved: boolean; suggestion: LabSuggestion | null }> {
  const data: {
    resolved?: boolean;
    llmStatus?: "llm" | "llm_failed" | "disabled";
    suggestion?: LabSuggestion | null;
    requiresConfirmation?: boolean;
  } = await apiClient.post(`/api/v1/lab/${feedbackId}/reason/classify`, { text });
  if (data.llmStatus) {
    dispatchLlmDebug({ feature: "lab", status: data.llmStatus });
  }
  return { resolved: data.resolved === true, suggestion: data.suggestion ?? null };
}

/**
 * 제안된 선호 보정을 확인·반영한다(무상태 제안 재전송). 서버가 화이트리스트를 재검증하고
 * 전용 슬롯(adjustment_applied_at)으로 행당 1회만 적용한다 — applied:false = 이미 적용됨(멱등).
 */
export async function confirmLabAdjustment(
  feedbackId: string,
  suggestion: LabSuggestion
): Promise<{ applied: boolean }> {
  const data: { applied?: boolean } = await apiClient.post(
    `/api/v1/lab/${feedbackId}/adjustment/confirm`,
    { attribute: suggestion.attribute, direction: suggestion.direction }
  );
  return { applied: data.applied === true };
}
```

- [ ] **Step 4: 검증**

Run(apps/web): `npm run typecheck && npm run lint`
Expected: 0 오류 (기존 lab 페이지의 `{ resolved }` 구조분해는 additive 확장이라 그대로 컴파일된다)

- [ ] **Step 5: Commit**

```powershell
git add apps/web/lib/api-client.ts
git commit -m @'
feat(web): lab pending 계약 정규화(잠재 404 수리) + classify 제안 + confirm API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 9: i18n — `lab.suggestion.*` 4로케일 동시 추가

**Files:**
- Modify: `apps/web/lib/i18n/messages/{ko,en,ja,zh}.json` (한 줄 압축 JSON — 스크립트로 일괄 삽입)

**Interfaces:**
- Produces: `lab.suggestion.{title,apply,decline,applied}` + `lab.suggestion.{tasty,instagrammable,barrier_free,quiet}.{up,down}` — Task 7의 `labSuggestionKey` 반환 키와 정확히 일치해야 한다.

- [ ] **Step 1: 1회용 삽입 스크립트 작성** — `apps/web/scripts_i18n_lab_suggestion.py` (작업 후 삭제)

```python
"""lab.suggestion i18n 키 4로케일 일괄 추가(1회용 — 실행 후 삭제). apps/web 에서 실행.

메시지 파일은 한 줄 압축 JSON — json 재직렬화(separators 무공백, ensure_ascii=False)로
기존 포맷을 보존하며 키를 삽입한다(수동 편집보다 안전).
"""
import io
import json

KEYS = {
    "ko": {
        "title": "다음 추천을 위한 제안",
        "apply": "적용",
        "decline": "괜찮아요",
        "applied": "취향에 반영했어요 ✨",
        "tasty": {"up": "맛집·평점 선호를 더 높일까요?", "down": "맛집·평점 비중을 낮출까요?"},
        "instagrammable": {"up": "감성·사진 명소 선호를 더 높일까요?", "down": "감성·사진 명소 비중을 낮출까요?"},
        "barrier_free": {"up": "접근성(무장애) 선호를 더 높일까요?", "down": "접근성(무장애) 비중을 낮출까요?"},
        "quiet": {"up": "한적한 곳 선호를 더 높일까요?", "down": "한적한 곳 비중을 낮출까요?"},
    },
    "en": {
        "title": "A suggestion for your next picks",
        "apply": "Apply",
        "decline": "No thanks",
        "applied": "Applied to your taste profile ✨",
        "tasty": {"up": "Weight food quality & ratings higher?", "down": "Weight food quality & ratings lower?"},
        "instagrammable": {"up": "Weight photogenic spots higher?", "down": "Weight photogenic spots lower?"},
        "barrier_free": {"up": "Weight accessibility higher?", "down": "Weight accessibility lower?"},
        "quiet": {"up": "Weight quiet places higher?", "down": "Weight quiet places lower?"},
    },
    "ja": {
        "title": "次のおすすめへの提案",
        "apply": "適用",
        "decline": "大丈夫です",
        "applied": "好みに反映しました ✨",
        "tasty": {"up": "グルメ・評価の比重を上げますか？", "down": "グルメ・評価の比重を下げますか？"},
        "instagrammable": {"up": "映えスポットの比重を上げますか？", "down": "映えスポットの比重を下げますか？"},
        "barrier_free": {"up": "アクセシビリティの比重を上げますか？", "down": "アクセシビリティの比重を下げますか？"},
        "quiet": {"up": "静かな場所の比重を上げますか？", "down": "静かな場所の比重を下げますか？"},
    },
    "zh": {
        "title": "为下次推荐提个建议",
        "apply": "应用",
        "decline": "不用了",
        "applied": "已反映到你的偏好 ✨",
        "tasty": {"up": "提高美食·评分的权重？", "down": "降低美食·评分的权重？"},
        "instagrammable": {"up": "提高出片景点的权重？", "down": "降低出片景点的权重？"},
        "barrier_free": {"up": "提高无障碍的权重？", "down": "降低无障碍的权重？"},
        "quiet": {"up": "提高清静场所的权重？", "down": "降低清静场所的权重？"},
    },
}

for locale, block in KEYS.items():
    path = f"lib/i18n/messages/{locale}.json"
    data = json.load(io.open(path, encoding="utf-8"))
    data["lab"]["suggestion"] = block
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
print("ok: lab.suggestion x4 locales")
```

- [ ] **Step 2: 실행 + 파리티 검증 + 스크립트 삭제**

Run(apps/web): `py -3.11 -X utf8 scripts_i18n_lab_suggestion.py`
Expected: `ok: lab.suggestion x4 locales`

Run(apps/web): `npm run test`
Expected: PASS — `lib/i18n/parity.test.ts` 0 missing (4로케일 구조 동일)

Run(apps/web): `Remove-Item scripts_i18n_lab_suggestion.py`

- [ ] **Step 3: Commit**

```powershell
git add apps/web/lib/i18n/messages/ko.json apps/web/lib/i18n/messages/en.json apps/web/lib/i18n/messages/ja.json apps/web/lib/i18n/messages/zh.json
git commit -m @'
feat(i18n): lab.suggestion 제안 문구 4로케일(속성 4 x 방향 2 + 버튼/토스트)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 10: 실험실 페이지 — 인라인 제안 블록(1탭 확인)

**Files:**
- Modify: `apps/web/app/mypage/lab/page.tsx`

**Interfaces:**
- Consumes: `confirmLabAdjustment`/`classifyLabReason`(Task 8), `labSuggestionKey`/`LabSuggestion`(Task 7), `track`(Task 6), i18n 키(Task 9).
- Produces: classify 성공 + 제안 존재 시 카드 안 인라인 확인 UI — [적용] → confirm → 낙관적 제거 + 전역 sonner 토스트 / [괜찮아요] → 보정 없이 제거. 제안 없으면 현행과 동일.

- [ ] **Step 1: import 갱신**

`from '@/lib/api-client'` import 목록에 `confirmLabAdjustment,` 를 추가하고, 그 아래에 두 줄 추가:

```tsx
import { labSuggestionKey, type LabSuggestion } from '@/lib/labSuggestion';
import { track } from '@/lib/analytics';
```

- [ ] **Step 2: 상태 추가** — `const [busyId, setBusyId] = ...` 아래

```tsx
  // classify 가 제안한 선호 보정(#5) — 있는 동안 그 카드는 목록 제거를 보류하고 1탭 확인을 받는다.
  const [suggestionFor, setSuggestionFor] = useState<{ feedbackId: string; suggestion: LabSuggestion } | null>(null);
```

- [ ] **Step 3: `mutate` 정리 라인 추가** — `setNoteFor((prev) => ...)` 줄 아래

```tsx
      setSuggestionFor((prev) => (prev?.feedbackId === feedbackId ? null : prev));
```

- [ ] **Step 4: `handleClassify` 교체** — 함수 전체를 다음으로

```tsx
  // 자유 텍스트 제출 — 백엔드가 LLM 으로 기존 카테고리에 매핑한다.
  // resolved=true 면 선택지 제출과 동일한 후처리(목록 제거). 단, 선호 보정 제안(suggestion)이
  // 함께 오면 제거를 보류하고 카드 안에서 1탭 확인을 받는다(자동 반영 아님 — PM 확정).
  // resolved=false/오류면 카드·선택지를 그대로 두고 "골라주세요" 안내만 띄운다(무해 폴백).
  const handleClassify = useCallback(
    async (item: LabPendingItem) => {
      const text = freeText.trim();
      if (!text || busyId) return;
      setBusyId(item.feedbackId);
      try {
        const { resolved, suggestion } = await classifyLabReason(item.feedbackId, text);
        if (resolved) {
          setFreeTextFor((prev) => (prev === item.feedbackId ? null : prev));
          if (suggestion && labSuggestionKey(suggestion)) {
            setSuggestionFor({ feedbackId: item.feedbackId, suggestion });
            track('lab_adjustment_suggested', { attribute: suggestion.attribute, direction: suggestion.direction });
          } else {
            setItems((prev) => prev.filter((it) => it.feedbackId !== item.feedbackId));
            toast.success(t('lab.answered'));
          }
        } else {
          toast.error(t('lab.classifyFallback'));
        }
      } catch (err) {
        console.warn('lab classify failed', err);
        toast.error(t('lab.classifyFallback'));
      } finally {
        setBusyId(null);
      }
    },
    [freeText, busyId, t],
  );
```

- [ ] **Step 5: 확인/거부 핸들러 추가** — `handleClassify` 바로 아래

```tsx
  // [적용] — 확인 후에만 서버가 보정한다(무상태 제안 재전송 + 서버 화이트리스트 재검증).
  // 성공 시 기존 낙관적 제거 패턴(mutate)으로 카드를 내리고 전역 sonner 토스트를 띄운다.
  const handleSuggestionApply = useCallback(
    (item: LabPendingItem, suggestion: LabSuggestion) => {
      track('lab_adjustment_confirmed', { attribute: suggestion.attribute, direction: suggestion.direction });
      void mutate(
        item.feedbackId,
        async () => {
          await confirmLabAdjustment(item.feedbackId, suggestion);
        },
        'lab.suggestion.applied',
      );
    },
    [mutate],
  );

  // [괜찮아요] — 보정 없이 카드만 내린다(classify 분 사유 학습은 이미 반영됨 — 그대로 유지).
  const handleSuggestionDecline = useCallback(
    (item: LabPendingItem, suggestion: LabSuggestion) => {
      track('lab_adjustment_declined', { attribute: suggestion.attribute, direction: suggestion.direction });
      setSuggestionFor(null);
      setItems((prev) => prev.filter((it) => it.feedbackId !== item.feedbackId));
      toast.success(t('lab.answered'));
    },
    [t],
  );
```

- [ ] **Step 6: 카드 렌더 갱신** — `items.map((item) => {` 본문에서

(1) `const busy = busyId === item.feedbackId;` 줄 아래에 추가:

```tsx
              const activeSuggestion =
                suggestionFor && suggestionFor.feedbackId === item.feedbackId ? suggestionFor.suggestion : null;
              const suggestionKey = labSuggestionKey(activeSuggestion);
```

(2) 이유 칩 블록(`{/* 이유 칩 9종 ... */}` 주석의 `<div className="flex flex-wrap gap-2 mt-4">` 전체)을 `{!activeSuggestion && ( ... )}` 로 감싼다 — 제안 확인 중에는 이미 answered 된 행이라 칩 재제출 표면을 닫는다.

(3) 하단 footer 블록(`{/* 직접 설명하기(자유 텍스트 토글) + 건너뛰기 ... */}` 의 `<div className="flex justify-between items-center mt-4 pt-3 border-t border-line">` 전체)도 동일하게 `{!activeSuggestion && ( ... )}` 로 감싼다.

(4) 자유 텍스트 블록(`{freeOpen && (...)}`) 바로 아래에 제안 블록 추가:

```tsx
                  {/* 거절 이해(#5) 인라인 제안 — enum→t() 조립 문구(LLM 원문 미노출), 1탭 확인 후에만 반영. */}
                  {activeSuggestion && suggestionKey && (
                    <div className="mt-4 rounded-2xl border border-gold/40 bg-gold/10 p-4 animate-fade-in">
                      <p className="text-xs font-semibold text-muk-soft mb-1">{t('lab.suggestion.title')}</p>
                      <p className="text-sm font-bold text-muk mb-3">{t(suggestionKey)}</p>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleSuggestionDecline(item, activeSuggestion)}
                          className="px-4 py-2 rounded-xl border border-line bg-white text-muk-soft text-sm font-semibold hover:bg-hanji-deep disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          {t('lab.suggestion.decline')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleSuggestionApply(item, activeSuggestion)}
                          className="px-4 py-2 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-bold disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          {t('lab.suggestion.apply')}
                        </button>
                      </div>
                    </div>
                  )}
```

- [ ] **Step 7: 검증**

Run(apps/web): `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: 전부 PASS

- [ ] **Step 8: Commit**

```powershell
git add apps/web/app/mypage/lab/page.tsx
git commit -m @'
feat(web): 실험실 인라인 제안 블록 - 1탭 확인 후에만 취향 보정 반영

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 11: Playwright e2e — 자유텍스트 → 제안 → 적용/거부

**Files:**
- Create: `apps/web/e2e/lab-suggestion.spec.ts`

**Interfaces:**
- Consumes: Task 10의 화면, Task 8의 정규화(**목은 실서버 셰이프** `id/created_at` 를 쓴다 — 계약 수리 재발 봉쇄).

- [ ] **Step 1: spec 작성**

```ts
import { expect, test } from '@playwright/test';

// GET /api/v1/lab/pending 의 **실서버 셰이프**(routers/lab.py _serialize_pending — id/created_at).
// api-client 의 정규화 어댑터(feedbackId/recommendedAt)가 이 셰이프를 소비하는 것까지 함께 검증한다.
const pendingItem = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  recommendation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  action: 'rejected',
  reason_status: 'pending',
  created_at: '2026-07-30T09:00:00+00:00',
  facility_id: 'fac-1',
  facility_name: '황리단길 카페',
  facility_type: 'cafe',
};

const classifyBody = {
  resolved: true,
  id: pendingItem.id,
  reason_status: 'answered',
  reason_code: 'too_crowded',
  learning_scope: 'long_term',
  updated_vector: true,
  llm_status: 'llm',
  suggestion: { attribute: 'quiet', direction: '+' },
  requires_confirmation: true,
};

function mockLab(page: import('@playwright/test').Page, confirmCalls: Array<Record<string, unknown>>) {
  return page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/lab/pending')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([pendingItem]) });
    }
    if (url.includes('/reason/classify')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(classifyBody) });
    }
    if (url.includes('/adjustment/confirm')) {
      confirmCalls.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ applied: true, attribute: 'quiet', direction: '+' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

async function openSuggestion(page: import('@playwright/test').Page) {
  await page.goto('/mypage/lab');
  await expect(page.getByText('황리단길 카페')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '직접 설명하기' }).click();
  await page.getByPlaceholder('왜 아쉬웠는지 편하게 적어주세요 (최대 200자)').fill('사람이 너무 많고 시끄러웠어요');
  await page.getByRole('button', { name: '보내기' }).click();
  // 제안 블록 — 문구는 enum→i18n 조립(LLM 원문 미노출), 자동 반영이 아니라 확인을 기다린다.
  await expect(page.getByText('한적한 곳 선호를 더 높일까요?')).toBeVisible();
}

test('실험실 자유 텍스트 → 제안 → 적용 → 토스트·카드 제거', async ({ page }) => {
  const confirmCalls: Array<Record<string, unknown>> = [];
  await mockLab(page, confirmCalls);
  await openSuggestion(page);

  await page.getByRole('button', { name: '적용' }).click();
  await expect(page.getByText('취향에 반영했어요 ✨')).toBeVisible();
  await expect(page.getByText('황리단길 카페')).toHaveCount(0);
  // 무상태 제안 재전송 페이로드 — 서버가 이 값을 화이트리스트로 재검증한다.
  expect(confirmCalls).toEqual([{ attribute: 'quiet', direction: '+' }]);
});

test('실험실 제안 거부(괜찮아요) — 보정 호출 없이 카드만 내려간다', async ({ page }) => {
  const confirmCalls: Array<Record<string, unknown>> = [];
  await mockLab(page, confirmCalls);
  await openSuggestion(page);

  await page.getByRole('button', { name: '괜찮아요' }).click();
  await expect(page.getByText('황리단길 카페')).toHaveCount(0);
  expect(confirmCalls).toEqual([]); // confirm 은 호출되지 않는다 — classify 분 학습만 유지
});
```

- [ ] **Step 2: 실행 확인**

Run(apps/web): `npx playwright test e2e/lab-suggestion.spec.ts`
Expected: 2 passed

Run(apps/web): `npx playwright test`
Expected: 기존 spec(journey-loop/mobile-locales/voice-controls) 포함 전부 passed (무회귀)

- [ ] **Step 3: Commit**

```powershell
git add apps/web/e2e/lab-suggestion.spec.ts
git commit -m @'
test(e2e): 실험실 제안 적용/거부 플로우 - 실서버 셰이프 목으로 계약 고정

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

## Milestone C — 편의점 편의 레이어

### Task 12: `convenience_service` — Kakao CS2 카테고리 검색

**Files:**
- Create: `apps/api/app/services/convenience_service.py`
- Test: Create `apps/api/tests/services/test_convenience_service.py`

**Interfaces:**
- Consumes: `restroom_service._distance_m`(Haversine 단일 정본), `settings.KAKAO_REST_API_KEY`(화장실과 동일 키·쿼터 풀).
- Produces: `async find_nearby_convenience_stores(lat, lng, radius_m=3000) -> list[dict]` — 항목 `{id, name, address, latitude, longitude, distance_m, place_url}` 거리순 최대 15곳. Task 13 라우터가 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/services/test_convenience_service.py`

```python
"""편의점 검색 서비스 — 화장실 테스트 패턴 복제(canned httpx 대역, 실네트워크 없음).

화장실과 다른 점: 키워드 검색이 아니라 카테고리 검색(CS2)이라 노이즈 필터가 없고,
대신 목록 상한(15곳)이 있다(편의점은 밀도가 높아 바텀시트가 길어지는 것 방지).
"""
import pytest

from app.services import convenience_service
from app.services.convenience_service import find_nearby_convenience_stores

_LAT, _LNG = 35.8380, 129.2115


def _doc(doc_id: str, name: str, lat: float, lng: float) -> dict:
    return {"id": doc_id, "place_name": name, "category_group_code": "CS2",
            "y": str(lat), "x": str(lng), "road_address_name": "경주시", "place_url": ""}


class _FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeClient:
    """페이지 순서대로 canned 응답을 돌려주는 httpx.AsyncClient 대역."""

    def __init__(self, pages: list[dict]):
        self._pages = pages
        self.requests: list[dict] = []

    def __call__(self, *args, **kwargs):  # httpx.AsyncClient(timeout=...) 흉내
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, params=None, headers=None):
        self.requests.append(dict(params))
        return _FakeResponse(self._pages[min(len(self.requests) - 1, len(self._pages) - 1)])


def _patch(monkeypatch, fake):
    monkeypatch.setattr(convenience_service.settings, "KAKAO_REST_API_KEY", "test-key")
    monkeypatch.setattr(convenience_service.httpx, "AsyncClient", fake)


@pytest.mark.asyncio
async def test_uses_cs2_category_search_without_keyword(monkeypatch):
    # 카테고리 검색(CS2)이라 키워드(query) 파라미터가 없어야 한다 — 노이즈 필터 자체가 불필요.
    fake = _FakeClient([{"documents": [_doc("1", "GS25 황리단길점", _LAT + 0.001, _LNG)],
                         "meta": {"is_end": True}}])
    _patch(monkeypatch, fake)
    results = await find_nearby_convenience_stores(_LAT, _LNG)
    assert fake.requests[0]["category_group_code"] == "CS2"
    assert "query" not in fake.requests[0]
    assert [r["name"] for r in results] == ["GS25 황리단길점"]


@pytest.mark.asyncio
async def test_paginates_dedupes_and_sorts_by_distance(monkeypatch):
    page1 = {"documents": [_doc("1", "CU 먼점", _LAT + 0.004, _LNG)], "meta": {"is_end": False}}
    page2 = {"documents": [
        _doc("1", "CU 먼점", _LAT + 0.004, _LNG),          # 중복 id — 1건으로 합쳐야 한다
        _doc("2", "GS25 가까운점", _LAT + 0.001, _LNG),
    ], "meta": {"is_end": True}}
    fake = _FakeClient([page1, page2])
    _patch(monkeypatch, fake)
    results = await find_nearby_convenience_stores(_LAT, _LNG)
    assert [int(p["page"]) for p in fake.requests] == [1, 2]
    assert [r["name"] for r in results] == ["GS25 가까운점", "CU 먼점"]  # 거리순


@pytest.mark.asyncio
async def test_radius_refilter_and_result_cap(monkeypatch):
    # Kakao radius 는 근사치 — Haversine 재검증으로 반경 밖 제외 + 목록 상한 15곳.
    docs = [_doc(str(i), f"편의점{i}", _LAT + 0.0005 * (i + 1), _LNG) for i in range(20)]
    docs.append(_doc("far", "먼 편의점", _LAT + 0.05, _LNG))  # 약 5.5km — 제외
    fake = _FakeClient([{"documents": docs, "meta": {"is_end": True}}])
    _patch(monkeypatch, fake)
    results = await find_nearby_convenience_stores(_LAT, _LNG, radius_m=3000)
    assert len(results) == 15
    assert all(r["distance_m"] <= 3000 for r in results)
    assert "먼 편의점" not in [r["name"] for r in results]


@pytest.mark.asyncio
async def test_missing_key_returns_empty(monkeypatch):
    monkeypatch.setattr(convenience_service.settings, "KAKAO_REST_API_KEY", "")
    assert await find_nearby_convenience_stores(_LAT, _LNG) == []
```

- [ ] **Step 2: 실패 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/services/test_convenience_service.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.convenience_service'`

- [ ] **Step 3: 구현** — `app/services/convenience_service.py`

```python
"""인근 편의점 좌표 검색 — 공중화장실(restroom_service)과 동일한 실시간 Kakao 프록시 패턴.

Kakao Local **카테고리 검색**(category_group_code=CS2)을 쓰므로 화장실과 달리 키워드 노이즈
필터가 필요 없다. 결과는 DB 에 저장하지 않는다(Kakao 약관 준수 — 실시간 프록시).
SPOT 추천 후보·점수와 완전 분리된 편의 레이어다(추천 품질 왜곡 0 — 스펙 §4).
키/네트워크 장애는 빈 목록으로 무해 폴백한다. REST 키·쿼터는 화장실과 공유(바텀시트 열 때만 호출).
"""

import httpx
import structlog

from app.core.config import settings
from app.services.restroom_service import _distance_m

logger = structlog.get_logger()
_URL = "https://dapi.kakao.com/v2/local/search/category.json"

_CATEGORY_GROUP = "CS2"  # Kakao 카테고리 그룹 코드: 편의점
_MAX_PAGES = 3           # 페이지당 15건 — 밀집 지역 대비 최대 45건 수집 후 반경·중복 필터
_MAX_RESULTS = 15        # 바텀시트 목록 상한 — 편의점은 밀도가 높아 상한을 둔다(화장실과 다른 점)


async def find_nearby_convenience_stores(lat: float, lng: float, radius_m: int = 3000) -> list[dict]:
    if not settings.KAKAO_REST_API_KEY:
        return []
    documents: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            for page in range(1, _MAX_PAGES + 1):
                params = {
                    "category_group_code": _CATEGORY_GROUP, "x": lng, "y": lat, "radius": radius_m,
                    "size": 15, "page": page, "sort": "distance",
                }
                response = await client.get(
                    _URL, params=params, headers={"Authorization": f"KakaoAK {settings.KAKAO_REST_API_KEY}"}
                )
                response.raise_for_status()
                data = response.json()
                documents.extend(data.get("documents", []))
                if data.get("meta", {}).get("is_end", True):
                    break
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("convenience_search_failed", error=str(exc), collected=len(documents))
        if not documents:
            return []
    results = []
    seen_ids: set[str] = set()
    for item in documents:
        item_id = str(item.get("id") or "")
        if item_id and item_id in seen_ids:
            continue
        if item_id:
            seen_ids.add(item_id)
        try:
            item_lat, item_lng = float(item["y"]), float(item["x"])
        except (KeyError, TypeError, ValueError):
            continue
        # Kakao radius 는 근사치 — Haversine 재검증(화장실과 동일 관례, _distance_m 단일 정본).
        distance = _distance_m(lat, lng, item_lat, item_lng)
        if distance > radius_m:
            continue
        results.append({
            "id": item_id or f"{item_lat},{item_lng}",
            "name": str(item.get("place_name") or "편의점"),
            "address": str(item.get("road_address_name") or item.get("address_name") or ""),
            "latitude": item_lat,
            "longitude": item_lng,
            "distance_m": distance,
            "place_url": str(item.get("place_url") or ""),
        })
    return sorted(results, key=lambda row: row["distance_m"])[:_MAX_RESULTS]
```

- [ ] **Step 4: 통과 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/services/test_convenience_service.py tests/services/test_restroom_service.py -q`
Expected: PASS (화장실 기존 테스트 무회귀 포함)

- [ ] **Step 5: Commit**

```powershell
git add apps/api/app/services/convenience_service.py apps/api/tests/services/test_convenience_service.py
git commit -m @'
feat(api): 편의점 검색 서비스 - Kakao CS2 카테고리 실시간 프록시(DB 저장 없음)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 13: 편의점 라우터 + main.py 등록

**Files:**
- Create: `apps/api/app/routers/convenience.py`
- Modify: `apps/api/app/main.py` (import 1줄 + include_router 1줄)
- Test: Create `apps/api/tests/routers/test_convenience.py`

**Interfaces:**
- Consumes: `find_nearby_convenience_stores` (Task 12).
- Produces: `GET /api/v1/convenience-stores?lat&lng&radius_m` → `{"source": "kakao"|"unavailable", "stores": [...]}` — 화장실 엔드포인트와 동일 셰이프. Task 15의 `ConvenienceChip` 이 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/routers/test_convenience.py`

```python
"""편의점 라우터 — 화장실과 동일 셰이프의 공개 편의 레이어(무인증)."""
from fastapi.testclient import TestClient

from app.main import app
from app.routers import convenience


def test_convenience_endpoint_shape(monkeypatch):
    async def fake(lat, lng, radius_m):
        return [{"id": "1", "name": "GS25 황리단길점", "address": "경주시", "latitude": 35.83,
                 "longitude": 129.21, "distance_m": 120, "place_url": ""}]

    monkeypatch.setattr(convenience, "find_nearby_convenience_stores", fake)
    with TestClient(app) as c:
        res = c.get("/api/v1/convenience-stores", params={"lat": 35.83, "lng": 129.21})
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "kakao"
    assert body["stores"][0]["name"] == "GS25 황리단길점"


def test_convenience_endpoint_unavailable_fallback(monkeypatch):
    async def fake(lat, lng, radius_m):
        return []

    monkeypatch.setattr(convenience, "find_nearby_convenience_stores", fake)
    with TestClient(app) as c:
        res = c.get("/api/v1/convenience-stores")
    assert res.json() == {"source": "unavailable", "stores": []}


def test_convenience_rejects_out_of_range_params():
    with TestClient(app) as c:
        assert c.get("/api/v1/convenience-stores", params={"lat": 999}).status_code == 422
        assert c.get("/api/v1/convenience-stores", params={"radius_m": 99999}).status_code == 422
```

- [ ] **Step 2: 실패 확인**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_convenience.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.routers.convenience'`

- [ ] **Step 3: 구현**

`app/routers/convenience.py`:

```python
"""현재 위치 기준 인근 편의점 공개 조회 — 화장실(restrooms)과 동일 셰이프의 편의 레이어."""

from fastapi import APIRouter, Query

from app.services.convenience_service import find_nearby_convenience_stores

router = APIRouter(prefix="/api/v1", tags=["convenience"])


@router.get("/convenience-stores")
async def convenience_stores(
    lat: float = Query(35.8361, ge=-90, le=90),
    lng: float = Query(129.2105, ge=-180, le=180),
    radius_m: int = Query(3000, ge=100, le=5000),
):
    items = await find_nearby_convenience_stores(lat, lng, radius_m)
    return {"source": "kakao" if items else "unavailable", "stores": items}
```

`app/main.py` 수정 2곳:

- import 줄(`from app.routers import recommendations, ...`)에 `convenience` 추가(알파벳 무관 — 기존 나열 끝에 붙여도 된다).
- `app.include_router(restrooms.router)` 줄 아래에 추가:

```python
app.include_router(convenience.router)  # 인근 편의점(Kakao CS2 카테고리) — 추천 POI와 분리된 편의 레이어
```

- [ ] **Step 4: 통과 확인 + 린트**

Run(apps/api): `$env:PYTHONUTF8=1; py -3.11 -m pytest tests/routers/test_convenience.py -q; py -3.11 -m ruff check .`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add apps/api/app/routers/convenience.py apps/api/app/main.py apps/api/tests/routers/test_convenience.py
git commit -m @'
feat(api): GET /api/v1/convenience-stores - 화장실 동형 편의 레이어 엔드포인트

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 14: i18n — `convenience.*` 4로케일 동시 추가

**Files:**
- Modify: `apps/web/lib/i18n/messages/{ko,en,ja,zh}.json`

**Interfaces:**
- Produces: `convenience.{chip,chipAria,title,subtitle}` — Task 15의 `ConvenienceChip` 이 소비. `restroom.*` 네임스페이스와 동일 구조.

- [ ] **Step 1: 1회용 삽입 스크립트 작성** — `apps/web/scripts_i18n_convenience.py` (작업 후 삭제)

```python
"""convenience i18n 키 4로케일 일괄 추가(1회용 — 실행 후 삭제). apps/web 에서 실행."""
import io
import json

KEYS = {
    "ko": {"chip": "편의점", "chipAria": "인근 편의점 {n}곳 보기",
           "title": "인근 편의점", "subtitle": "현재 위치에서 가까운 순 · 카카오 장소 정보"},
    "en": {"chip": "Stores", "chipAria": "View {n} nearby convenience stores",
           "title": "Nearby convenience stores", "subtitle": "Nearest first · Kakao place data"},
    "ja": {"chip": "コンビニ", "chipAria": "近くのコンビニ{n}件を見る",
           "title": "近くのコンビニ", "subtitle": "現在地から近い順・Kakao場所情報"},
    "zh": {"chip": "便利店", "chipAria": "查看附近{n}家便利店",
           "title": "附近便利店", "subtitle": "按当前位置距离排序 · Kakao地点信息"},
}

for locale, block in KEYS.items():
    path = f"lib/i18n/messages/{locale}.json"
    data = json.load(io.open(path, encoding="utf-8"))
    data["convenience"] = block
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
print("ok: convenience x4 locales")
```

- [ ] **Step 2: 실행 + 파리티 검증 + 스크립트 삭제**

Run(apps/web): `py -3.11 -X utf8 scripts_i18n_convenience.py`
Expected: `ok: convenience x4 locales`

Run(apps/web): `npm run test`
Expected: PASS — parity 0 missing

Run(apps/web): `Remove-Item scripts_i18n_convenience.py`

- [ ] **Step 3: Commit**

```powershell
git add apps/web/lib/i18n/messages/ko.json apps/web/lib/i18n/messages/en.json apps/web/lib/i18n/messages/ja.json apps/web/lib/i18n/messages/zh.json
git commit -m @'
feat(i18n): convenience 편의점 레이어 문구 4로케일

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 15: `ConvenienceChip` 컴포넌트 + 메인 배치

**Files:**
- Create: `apps/web/components/ConvenienceChip.tsx`
- Modify: `apps/web/app/main/page.tsx` (dynamic import 1줄 + 배치 2곳)

**Interfaces:**
- Consumes: `GET /api/v1/convenience-stores` (Task 13, camelCase 변환 후 `{source, stores: [{id,name,address,latitude,longitude,distanceM,placeUrl}]}`), i18n `convenience.*` (Task 14).
- Produces: `<ConvenienceChip location={{lat,lng} | null} />` — 결과 0건/장애 시 칩 자체를 숨긴다(RestroomChip 관례).

- [ ] **Step 1: 컴포넌트 작성** — `components/ConvenienceChip.tsx`

```tsx
'use client';

import { useEffect, useState } from 'react';
import { MapPin, Store, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface ConvenienceStore {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  distanceM: number;
  placeUrl: string;
}

// 인근 편의점 편의 레이어 — RestroomChip 패턴 복제(실시간 Kakao 프록시, 실패·0건이면 칩 자체를 숨긴다).
// SPOT 추천 후보·점수와 완전 분리 — 추천 품질에 영향 0 (docs/SOLAR_AUTONOMY_35_PLAN.md §4).
export default function ConvenienceChip({ location }: { location: { lat: number; lng: number } | null }) {
  const t = useT();
  const [items, setItems] = useState<ConvenienceStore[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!location) return;
    let active = true;
    apiClient.get('/api/v1/convenience-stores', { params: {
      lat: String(location.lat), lng: String(location.lng), radiusM: '3000',
    } }).then((value: { stores?: ConvenienceStore[] }) => {
      if (active) setItems(value.stores || []);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [location]);

  if (!items.length) return null;
  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-white/80 px-3.5 py-2 text-[13px] font-medium text-muk-soft fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] hover:bg-white hover:text-muk sm:px-4 sm:text-sm"
      aria-label={t('convenience.chipAria', { n: items.length })}
    >
      <Store size={15} aria-hidden="true" /> {t('convenience.chip')} {items.length}
    </button>
    {open && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/30" onClick={() => setOpen(false)}>
        <section className="max-h-[70vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-hanji p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="mb-4 flex items-start justify-between">
            <div><h2 className="text-lg font-bold text-muk">{t('convenience.title')}</h2><p className="text-xs text-muk-soft">{t('convenience.subtitle')}</p></div>
            <button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')} className="rounded-full p-2 hover:bg-hanji-deep"><X size={18} /></button>
          </div>
          <div className="space-y-2">
            {items.map((item) => <a
              key={item.id}
              href={item.placeUrl || `https://map.kakao.com/link/map/${encodeURIComponent(item.name)},${item.latitude},${item.longitude}`}
              target="_blank" rel="noreferrer"
              className="flex items-center justify-between rounded-2xl border border-line bg-white/70 p-3"
            >
              <div className="min-w-0"><p className="truncate text-sm font-bold text-muk">{item.name}</p><p className="truncate text-xs text-muk-soft">{item.address}</p></div>
              <span className="ml-3 flex shrink-0 items-center gap-1 text-xs font-bold text-gold"><MapPin size={13} />{item.distanceM < 1000 ? `${item.distanceM}m` : `${(item.distanceM / 1000).toFixed(1)}km`}</span>
            </a>)}
          </div>
        </section>
      </div>, document.body)}
  </>;
}
```

- [ ] **Step 2: 메인 배치** — `app/main/page.tsx` 수정 3곳

(1) `const RestroomChip = dynamic(...)` 줄 아래에:

```tsx
const ConvenienceChip = dynamic(() => import('@/components/ConvenienceChip'), { ssr: false });
```

(2) 칩 스트립의 `<RestroomChip location={userLocation} />` (약 L2003) 아래에:

```tsx
          {/* 인근 편의점 — 화장실과 동일한 편의 레이어(실패 시 스스로 숨는다). */}
          <ConvenienceChip location={userLocation} />
```

(3) 모바일 도구 시트(약 L2096)의 `<div className="mt-4 flex flex-wrap gap-2"><FestivalBanner ... /><RestroomChip ... /></div>` 를 다음으로 교체:

```tsx
            <div className="mt-4 flex flex-wrap gap-2"><FestivalBanner onFocus={focusFestivalOnMap} /><RestroomChip location={userLocation} /><ConvenienceChip location={userLocation} /></div>
```

- [ ] **Step 3: 검증**

Run(apps/web): `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: 전부 PASS

- [ ] **Step 4: Commit**

```powershell
git add apps/web/components/ConvenienceChip.tsx apps/web/app/main/page.tsx
git commit -m @'
feat(web): 편의점 칩 + 바텀시트 - 화장실 패턴 복제 편의 레이어

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

### Task 16: Playwright e2e — 편의점 시트

**Files:**
- Create: `apps/web/e2e/convenience.spec.ts`

- [ ] **Step 1: spec 작성**

```ts
import { expect, test } from '@playwright/test';

// /main 은 시설이 있어야 정상 화면이 뜬다(빈 상태 오버레이 방지 — voice-controls.spec 관례).
const facilities = [
  { id: 'restaurant-1', name: '실내 식당', type: 'restaurant', latitude: 35.8563, longitude: 129.2247,
    capacity: 30, features: {}, congestion: null },
];

const stores = [
  { id: '1', name: 'GS25 황리단길점', address: '경주시 포석로', latitude: 35.8385, longitude: 129.2118,
    distance_m: 120, place_url: '' },
  { id: '2', name: 'CU 대릉원점', address: '경주시 첨성로', latitude: 35.8371, longitude: 129.2109,
    distance_m: 480, place_url: '' },
];

test('메인 편의 레이어 — 편의점 칩 → 바텀시트 거리순 목록', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('nextspot_onboarding_done', '1'); });
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/convenience-stores')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ source: 'kakao', stores }) });
    }
    if (url.endsWith('/api/v1/infrastructures')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facilities) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/main');
  const chip = page.getByRole('button', { name: '인근 편의점 2곳 보기' }).first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();

  await expect(page.getByRole('heading', { name: '인근 편의점' })).toBeVisible();
  await expect(page.getByText('GS25 황리단길점')).toBeVisible();
  await expect(page.getByText('120m')).toBeVisible();
  await expect(page.getByText('CU 대릉원점')).toBeVisible();
});
```

- [ ] **Step 2: 실행 확인**

Run(apps/web): `npx playwright test e2e/convenience.spec.ts`
Expected: 1 passed

Run(apps/web): `npx playwright test`
Expected: 전체 spec passed (무회귀)

- [ ] **Step 3: Commit**

```powershell
git add apps/web/e2e/convenience.spec.ts
git commit -m @'
test(e2e): 편의점 칩 - 바텀시트 목록 390x844

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
```

---

## Milestone D — 마무리

### Task 17: 전체 게이트 + 문서 정합 + 푸시

**Files:**
- Modify: `docs/JUDGE_QA.md` (Q4·Q10 답변 보강)
- Modify: `docs/SOLAR_AUTONOMY_PLAN.md` (5안 표 상태 갱신)
- Modify: `docs/HANDOVER.md` (세션 기록 — 최신이 맨 위)

- [ ] **Step 1: 전체 게이트 실행** (커밋 전 필수 — CI와 동일)

```powershell
cd apps\web;  npm run lint;  npm run typecheck;  npm run test;  npm run build
cd ..\api;    $env:PYTHONUTF8=1;  py -3.11 -m pytest -q;  py -3.11 -m ruff check .
cd ..\..;     node scripts/build_reset.mjs;  git diff --exit-code supabase/RESET_AND_SETUP.sql
cd apps\web;  npx playwright test
```

Expected: 전부 PASS / diff 없음. 실패 시 해당 태스크로 돌아가 수리 후 재실행.

- [ ] **Step 2: 문서 정합**

- `docs/JUDGE_QA.md` — Q4(취향 가시화)·Q10(개인화 데이터) 답변에 다음 취지의 문장을 추가한다(기존 답변 삭제 금지, 보강만):
  - Q4: "거절 실험실의 자유 서술에서 AI 가 선호 보정을 제안하지만, **사용자가 [적용]을 눌러 확인한 경우에만** 서버 고정 5% 한도로 반영됩니다 — 자동 반영이 아닙니다."
  - Q10: "개인화에 쓰이는 데이터는 여전히 preferred_categories 와 8차원 선호 벡터뿐입니다. 제안은 무상태(DB 미기록)이고, 확인 시각(adjustment_applied_at)만 멱등 가드로 남습니다."
- `docs/SOLAR_AUTONOMY_PLAN.md` — 5안 표에서 **#5 상태를 '구현 완료(확인 후 보정)'**로, **#3 상태를 '착수 대기(timeweather 머지 후)'**로 갱신.
- `docs/HANDOVER.md` — 맨 위에 이번 세션 항목 추가: 브랜치 `feature/solar-autonomy-35`, 구현 범위(#5 + 편의점), 기능 단위 커밋 해시 목록, 발견·수리한 lab pending 계약 결함, 다음 단계(Codex 적대 감사 → 머지 → #3 착수).

- [ ] **Step 3: Commit + Push**

```powershell
git add docs/JUDGE_QA.md docs/SOLAR_AUTONOMY_PLAN.md docs/HANDOVER.md
git commit -m @'
docs: 거절 이해(#5)+편의점 사이클 반영 - JUDGE_QA Q4/Q10, 상태표, HANDOVER

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QbspJPyV5MiiowxpMkASCx
'@
git push -u origin feature/solar-autonomy-35
```

- [ ] **Step 4: Codex 적대 감사 의뢰** — 팀 관례에 따라 별도 세션에서 이 브랜치를 감사한 뒤 `feature/jinseok` 머지를 판단한다(이 플랜의 범위 밖 — HANDOVER 에 기록만 남긴다).

---

## 리스크·범위 노트 (스펙 §7·§9 요약)

- **이중 학습 차단**: `learning_applied_at`(사유 -5%)과 `adjustment_applied_at`(확인 보정 5%)은 독립 슬롯 — Task 5의 `test_confirm_independent_of_learning_slot`이 고정한다.
- **suggestion 위변조**: 무상태 설계 — confirm 의 Literal 재검증이 전부이고, 위조해도 서버 고정 5% lerp 1회가 상한.
- **REASON_CODES 어휘 확장 없음** — 기존 9코드 유지(4곳 패리티 리스크 회피).
- **범위 밖**: #3 사유 사실 선택권(timeweather 머지 후 별도 플랜), explore/recommend 👎 직후 인라인 제안, TasteRadar i18n, 카테고리 차원(dim0~3) 보정.
