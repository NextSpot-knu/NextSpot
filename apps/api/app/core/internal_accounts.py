"""내부 계정(관리자·개발자) 판별 — 실적·효과 지표에서 시연·점검 트래픽을 빼는 공용 정의.

관제 지표(routers/admin.py)와 사장님 성적표(routers/merchant.py)가 같은 사람을 같은 기준으로 빼야, 한 화면의
수락 수와 다른 화면의 수락 수가 다른 모집단을 세지 않는다. 판정 칸은 서버 권한 판정(authz)과 같은 users.role 이다.

조회 방식은 라우터마다 다르다(관리자 지표는 상한·경고가 있는 조회, 사장님 성적표는 1,000행씩 넘겨 읽기) —
여기에는 '무엇을 내부로 보는가' 만 둔다.
"""
from app.core.authz import ROLE_ADMIN, ROLE_DEVELOPER

INTERNAL_ROLES = frozenset({ROLE_ADMIN, ROLE_DEVELOPER})


def filter_internal_roles(query):
    """users 조회에 내부 역할 필터를 건다(정렬은 페이지 넘김을 안정시키려고 id 순)."""
    return query.in_("role", sorted(INTERNAL_ROLES)).order("id")


def internal_ids_from_rows(rows) -> frozenset[str]:
    """users 행에서 내부 계정 id 만 고른다.

    역할은 여기서 한 번 더 확인한다 — 필터가 빠진 응답(테스트 가짜·구 응답)이 와도 모든 사용자를 내부로
    오인해 실적을 통째로 지우지 않게.
    """
    return frozenset(str(row["id"]) for row in rows if row.get("id") and row.get("role") in INTERNAL_ROLES)


def is_internal_user(user_id, internal_ids) -> bool:
    return user_id is not None and str(user_id) in internal_ids
