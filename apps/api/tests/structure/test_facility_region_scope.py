"""구조 검사 — 시설(facilities) 읽기는 모두 지역을 거른다(SEOUL_TESTBED_PLAN S3 · isolation_design §7).

서울 시설은 개발자 전용이다. 브라우저(anon·authenticated)는 DB 의 RESTRICTIVE 정책이 막지만, API 와 배치는
service_role 로 읽어 RLS 를 우회한다. 그래서 service_role 읽기 하나가 지역 필터를 빠뜨리면 서울 행이 경주
화면·통계·학습에 섞인다. 이 테스트는 `apps/api/app` 과 `apps/api/scripts` 를 AST 로 훑어 그런 자리를 찾는다.

## 무엇을 '시설 읽기'로 보나
  · ``<x>.table("facilities")`` 로 시작해 ``.select(`` · ``.update(`` · ``.delete(`` 를 부르는 사슬
    (insert·upsert 는 쓰기 — region 기본값이 'gyeongju' 이고 좌표 CHECK 가 서울 좌표를 막는다)
  · ``fetch_all_rows(…, "facilities", …)`` · ``_keyset_rows(…, "facilities", …)``
  · 문자열 안의 임베드 ``facilities!…`` · ``facilities(…)`` (독스트링 제외)

## 무엇이면 통과하나
읽기를 감싼 함수(안쪽 함수에서 바깥 함수까지 어느 한 겹)에 다음 중 하나가 있으면 지역을 건 것으로 본다.
  · ``apply_region(`` · ``run_region_scoped(`` · ``arun_region_scoped(``
  · ``.eq("region", …)`` · ``.neq("region", …)`` · ``.eq("<임베드>.region", …)`` · ``.eq(<이름에 REGION 이 든 상수>, …)``
  · 키워드 인자 ``region=`` 를 넘기는 호출
아니면 아래 `ALLOWLIST` 에 (경로, 함수) 와 한 줄 이유가 있어야 한다.

``fetch_active_facilities(…)`` · ``fetch_all_facilities(…)`` 호출은 ``region=`` 을 **명시**해야 한다
(기본값은 경주라 닫힌 쪽이지만, 호출마다 지역을 의식하게 한다). 예외는 `CALL_ALLOWLIST`.

허용 목록이 낡지 않게, 더는 걸리지 않는 항목도 실패로 본다(`test_allowlist_has_no_stale_entries`).
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[2]
SCAN_DIRS = ("app", "scripts")

# (경로, 함수 이름) → 이유. 함수 이름은 가장 안쪽 def 이름(모듈 최상위면 "<module>").
ALLOWLIST: dict[tuple[str, str], str] = {
    # ── 경주 일배치(손대지 않는 파일) ───────────────────────────────────────────
    ("scripts/ingest_tourapi.py", "_load_guard_facilities"):
        "경주 일배치(손대지 않음) — 중복 가드는 거리 한정(DUPLICATE_GUARD_MAX_M) 이라 서울 행이 경주 새 행과 겹칠 수 없다",
    ("scripts/ingest_tourapi.py", "upsert_facilities"):
        "경주 일배치(손대지 않음) — 경주 목록의 contentid 로만 병합·쓰기(서울 contentid 는 경주 목록에 없다). "
        "서울 적재도 이 함수를 재사용하며, 서울 행의 features 병합에 필요하다",
    ("scripts/ingest_tourapi.py", "sync_showflags"):
        "경주 일배치(손대지 않음) — 경주 showflag 목록에 없는 contentid 는 건너뛴다(showflag None → continue)",
    # ── 자식 표가 DB 트리거로 경주 시설만 가리키는 임베드 ─────────────────────────
    # reject_non_public_region_facility(20261101090000)가 6개 자식 표의 facility_id 를 경주 시설로 묶는다.
    ("app/services/spot/industry_baseline.py", "_load_baseline"):
        "업종 기준선은 congestion_logs 기반 — 로그는 트리거(reject_non_public_region_facility)로 경주 시설만 받는다",
    ("app/routers/admin.py", "_fetch_day_logs"):
        "congestion_logs → facilities 임베드 — 로그는 트리거로 경주 시설만 받는다(관제 오늘·브리핑)",
    ("app/routers/dev.py", "list_facility_owners"):
        "facility_owners → facilities 임베드 — 소유권은 트리거로 경주 시설에만 붙는다",
    ("app/routers/dev.py", "_fetch"):
        "business_verification_requests → facilities 임베드 — 신청의 가게는 트리거로 경주 시설만 가리킨다",
    # ── 본인 소유 행(문서화된 잔여) ───────────────────────────────────────────────
    ("app/routers/lab.py", "list_pending"):
        "본인(user_id) 거절 행의 추천 시설 임베드 — 서울 추천은 개발자 본인 것뿐(내부 사용자 본인 소유 행 잔여)",
}

# fetch_active_facilities / fetch_all_facilities 를 region= 없이 불러도 되는 자리.
CALL_ALLOWLIST: dict[tuple[str, str], str] = {
    ("app/main.py", "lifespan"):
        "부팅 프리필 — 기본값(경주) 캐시 키 ('all',) 를 채운다. 서울 풀은 요청 때 따로 채운다",
}

_SCOPED_FUNCS = ("fetch_active_facilities", "fetch_all_facilities")
_ROW_HELPERS = ("fetch_all_rows", "_keyset_rows")
_TABLE_READ_METHODS = frozenset({"select", "update", "delete"})
_EMBED = re.compile(r"\bfacilities\s*(?:!|\()")

_MARKER_TEXT = re.compile(
    r"apply_region\(|\barun_region_scoped\(|\brun_region_scoped\("
    r"|\.n?eq\(\s*[\"'](?:[A-Za-z_][\w]*\.)?region[\"']"
    r"|\.eq\(\s*[A-Za-z_][\w.]*REGION[\w]*\s*,"
)


@dataclass(frozen=True)
class Site:
    path: str
    function: str
    line: int
    kind: str  # 'table' | 'rows' | 'embed' | 'call'

    def __str__(self) -> str:  # 실패 메시지에 한 줄로
        return f"{self.path}:{self.line} ({self.function}) [{self.kind}]"


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _is_facilities_literal(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value == "facilities"


def _table_call_on_facilities(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "table"
        and len(node.args) >= 1
        and _is_facilities_literal(node.args[0])
    )


def _callee_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


class _Scanner(ast.NodeVisitor):
    """한 파일을 훑어 시설 읽기 자리와 region= 없는 풀 호출을 모은다."""

    def __init__(self, source: str, rel: str) -> None:
        self.source = source
        self.rel = rel
        self.stack: list[ast.AST] = []
        self.sites: list[tuple[Site, tuple[ast.AST, ...]]] = []
        self.unscoped_calls: list[Site] = []
        self._docstrings: set[int] = set()
        self._parents: dict[int, ast.AST] = {}
        # 모듈 최상위에서 임베드 문자열을 담은 이름 → 그 이름을 쓰는 함수가 자리가 된다.
        self._embed_names: set[str] = set()
        self._embed_constants: set[int] = set()

    def scan(self, tree: ast.Module) -> None:
        for statement in tree.body:
            if not isinstance(statement, (ast.Assign, ast.AnnAssign)) or statement.value is None:
                continue
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            embeds = [
                n for n in ast.walk(statement.value)
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and _EMBED.search(n.value)
            ]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            if embeds and names:
                self._embed_names.update(names)
                self._embed_constants.update(id(n) for n in embeds)
        for parent in ast.walk(tree):
            for child in ast.iter_child_nodes(parent):
                self._parents[id(child)] = parent
            body = getattr(parent, "body", None)
            first = body[0] if isinstance(body, list) and body else None
            if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                self._docstrings.add(id(first.value))
        self.visit(tree)

    # ── 함수 경계 ─────────────────────────────────────────────────────────────
    def _visit_def(self, node: ast.AST) -> None:
        self.stack.append(node)
        self.generic_visit(node)
        self.stack.pop()

    visit_FunctionDef = _visit_def
    visit_AsyncFunctionDef = _visit_def

    def _function_name(self) -> str:
        return getattr(self.stack[-1], "name", "<module>") if self.stack else "<module>"

    def _record(self, node: ast.AST, kind: str) -> None:
        site = Site(self.rel, self._function_name(), getattr(node, "lineno", 0), kind)
        self.sites.append((site, tuple(self.stack)))

    def _chain_above(self, node: ast.AST) -> set[str]:
        """``node`` 위로 이어진 메서드 사슬의 이름들(``x.table("facilities").select(…).eq(…)`` → select·eq)."""
        names: set[str] = set()
        current = node
        while True:
            parent = self._parents.get(id(current))
            if isinstance(parent, ast.Attribute) and parent.value is current:
                names.add(parent.attr)
            elif not (isinstance(parent, ast.Call) and parent.func is current):
                return names
            current = parent

    # ── 자리 찾기 ─────────────────────────────────────────────────────────────
    def visit_Call(self, node: ast.Call) -> None:
        name = _callee_name(node)
        # 1) table("facilities") 에서 select·update·delete 로 이어지는 사슬
        if _table_call_on_facilities(node) and _TABLE_READ_METHODS & self._chain_above(node):
            self._record(node, "table")
        # 2) fetch_all_rows / _keyset_rows(…"facilities"…) — 직접 부르거나 함수로 넘기거나
        #    (asyncio.to_thread(fetch_all_rows, client, "facilities", …) · run_admin_io(fetch_all_rows, …))
        helper_passed = any(isinstance(arg, ast.Name) and arg.id in _ROW_HELPERS for arg in node.args)
        if (name in _ROW_HELPERS or helper_passed) and any(_is_facilities_literal(arg) for arg in node.args):
            self._record(node, "rows")
        # 3) fetch_active_facilities / fetch_all_facilities 는 region= 명시
        if name in _SCOPED_FUNCS and not any(kw.arg == "region" for kw in node.keywords):
            self.unscoped_calls.append(Site(self.rel, self._function_name(), node.lineno, "call"))
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if (isinstance(node.value, str) and id(node) not in self._docstrings
                and id(node) not in self._embed_constants and _EMBED.search(node.value)):
            self._record(node, "embed")

    def visit_Name(self, node: ast.Name) -> None:
        # 모듈 상수에 담긴 임베드는 그 상수를 **쓰는** 함수가 지역을 걸어야 한다.
        if node.id in self._embed_names and isinstance(node.ctx, ast.Load) and self.stack:
            self._record(node, "embed")


def _has_region_marker(func: ast.AST, source: str) -> bool:
    text = ast.get_source_segment(source, func) or ""
    if _MARKER_TEXT.search(text):
        return True
    return any(
        isinstance(n, ast.Call) and any(kw.arg == "region" for kw in n.keywords)
        for n in ast.walk(func)
    )


def scan_source(source: str, rel: str) -> tuple[list[Site], list[Site]]:
    """(지역을 걸지 않은 시설 읽기, region= 없는 fetch_*_facilities 호출)."""
    tree = ast.parse(source)
    scanner = _Scanner(source, rel)
    scanner.scan(tree)
    unscoped: list[Site] = []
    for site, stack in scanner.sites:
        if any(_has_region_marker(func, source) for func in stack):
            continue
        unscoped.append(site)
    return unscoped, scanner.unscoped_calls


def scan_tree(root: Path = API_ROOT) -> tuple[list[Site], list[Site]]:
    reads: list[Site] = []
    calls: list[Site] = []
    for directory in SCAN_DIRS:
        for path in sorted((root / directory).rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            found_reads, found_calls = scan_source(path.read_text(encoding="utf-8"), _rel(path, root))
            reads.extend(found_reads)
            calls.extend(found_calls)
    return reads, calls


def _key(site: Site) -> tuple[str, str]:
    return (site.path, site.function)


# ── 테스트 ────────────────────────────────────────────────────────────────────

def test_every_facilities_read_filters_region_or_is_allowlisted():
    reads, _ = scan_tree()
    offenders = [site for site in reads if _key(site) not in ALLOWLIST]
    assert not offenders, (
        "지역 필터 없는 facilities 읽기 — apply_region/run_region_scoped 를 쓰거나 ALLOWLIST 에 이유와 함께 넣으세요:\n"
        + "\n".join(str(site) for site in offenders)
    )


def test_fetch_facilities_calls_pass_region_explicitly():
    _, calls = scan_tree()
    offenders = [site for site in calls if _key(site) not in CALL_ALLOWLIST]
    assert not offenders, (
        "fetch_active_facilities/fetch_all_facilities 는 region= 을 명시하세요:\n"
        + "\n".join(str(site) for site in offenders)
    )


def test_allowlist_has_no_stale_entries():
    reads, calls = scan_tree()
    read_keys = {_key(site) for site in reads}
    call_keys = {_key(site) for site in calls}
    stale = [key for key in ALLOWLIST if key not in read_keys]
    stale += [key for key in CALL_ALLOWLIST if key not in call_keys]
    assert not stale, f"더는 걸리지 않는 허용 항목 — 지우세요: {stale}"


def test_allowlist_reasons_are_one_line_and_present():
    for key, reason in {**ALLOWLIST, **CALL_ALLOWLIST}.items():
        assert reason.strip(), key
        assert "\n" not in reason, key


def test_engine_read_sites_are_never_allowlisted():
    """추천·코스 엔진의 시설 읽기는 허용 목록으로 빠질 수 없다(지역 필터로만 통과)."""
    engine = {"app/routers/recommendations.py", "app/routers/courses.py"}
    assert not [key for key in {**ALLOWLIST, **CALL_ALLOWLIST} if key[0] in engine]


# ── 스캐너 자체(합성 음성 사례) ────────────────────────────────────────────────

_NEGATIVE = '''
import asyncio
from app.core.supabase import supabase_admin, fetch_all_rows

async def leaky_by_id(fid):
    return await asyncio.to_thread(
        supabase_admin.table("facilities").select("id, name").eq("id", fid).execute
    )

def leaky_sync():
    return supabase_admin.table("facilities").select("*").execute().data

def leaky_rows():
    return fetch_all_rows(supabase_admin, "facilities", "id")

async def leaky_rows_passed():
    return await asyncio.to_thread(fetch_all_rows, supabase_admin, "facilities", "id")

def leaky_embed():
    return supabase_admin.table("recommendations").select("*, facility:facilities(name)").execute()

def leaky_update(fid):
    supabase_admin.table("facilities").update({"is_active": False}).eq("id", fid).execute()

async def leaky_pool():
    return await fetch_all_facilities()

_LEAKY_SELECT = (
    "*, rec:recommendations!recommendation_id("
    "id, f:facilities!recommended_facility_id(id, name))"
)

def leaky_constant_user():
    return supabase_admin.table("user_feedback").select(_LEAKY_SELECT).execute()
'''

_POSITIVE = '''
import asyncio
from app.core.region import PUBLIC_REGION, apply_region, arun_region_scoped, run_region_scoped
from app.core.supabase import supabase_admin

async def scoped_by_id(fid):
    def _read(with_region):
        q = supabase_admin.table("facilities").select("id").eq("id", fid)
        if with_region:
            q = apply_region(q, PUBLIC_REGION)
        return q.execute().data
    return await arun_region_scoped(_read, region=PUBLIC_REGION)

def scoped_lambda():
    return run_region_scoped(
        lambda wr: supabase_admin.table("facilities").select("*").execute().data, region=PUBLIC_REGION
    )

def scoped_eq():
    return supabase_admin.table("facilities").select("*").eq("region", "gyeongju").execute()

def scoped_embed(region):
    return (supabase_admin.table("user_coupons").select("*, facility:facilities!inner(name)")
            .eq("facility.region", region).execute())

def docstring_only():
    """facilities(name) 임베드라는 말은 독스트링이라 세지 않는다."""
    return None

async def scoped_pool():
    return await fetch_all_facilities(region=PUBLIC_REGION)

def insert_is_a_write():
    supabase_admin.table("facilities").insert({"name": "x"}).execute()

_WITH_FACILITY = "*, f:facilities!fid!inner(*)"
_F_REGION = "f.region"

def scoped_constant_user(region):
    return supabase_admin.table("recs").select(_WITH_FACILITY).eq(_F_REGION, region).execute()
'''


def test_negative_fixture_is_flagged():
    reads, calls = scan_source(_NEGATIVE, "synthetic/negative.py")
    flagged = {(site.function, site.kind) for site in reads}
    assert ("leaky_by_id", "table") in flagged
    assert ("leaky_sync", "table") in flagged
    assert ("leaky_rows", "rows") in flagged
    assert ("leaky_rows_passed", "rows") in flagged
    assert ("leaky_embed", "embed") in flagged
    assert ("leaky_update", "table") in flagged
    assert ("leaky_constant_user", "embed") in flagged
    assert [site.function for site in calls] == ["leaky_pool"]


def test_positive_fixture_passes():
    reads, calls = scan_source(_POSITIVE, "synthetic/positive.py")
    assert reads == []
    assert calls == []


def test_scanner_sees_real_sites():
    """스캐너가 실제 코드에서 무언가를 찾고 있다(빈 스캔으로 초록이 되지 않게)."""
    tree_reads = 0
    for directory in SCAN_DIRS:
        for path in (API_ROOT / directory).rglob("*.py"):
            if "__pycache__" in path.parts:
                continue
            source = path.read_text(encoding="utf-8")
            scanner = _Scanner(source, _rel(path, API_ROOT))
            scanner.scan(ast.parse(source))
            tree_reads += len(scanner.sites)
    assert tree_reads >= 40


if __name__ == "__main__":  # pragma: no cover — 손으로 목록을 볼 때
    found_reads, found_calls = scan_tree()
    for found in found_reads:
        print("READ", found, "(allowlisted)" if _key(found) in ALLOWLIST else "")
    for found in found_calls:
        print("CALL", found, "(allowlisted)" if _key(found) in CALL_ALLOWLIST else "")

