"""심사용 계정 시드 — 주최 측이 지정한 사업자·관리자 계정을 미리 만들어 둔다.

계획: docs/MERCHANT_CONSOLE_RBAC_PLAN.md §7 (로컬 전용 문서)

## 왜 미리 만드나

OAuth 계정은 **첫 로그인 시점에야 사용자 행이 생긴다.** 그러면 어느 계정에 merchant/admin 을
부여할지 미리 특정할 수 없고, 심사위원이 로그인한 뒤에야 사람이 임명해야 한다(대기 발생).
자체 이메일 계정은 역할·소유 가게까지 미리 박아 둘 수 있어, 심사위원은 로그인만 하면 바로
해당 콘솔이 열린다. 그래서 심사 계정은 소셜이 아니라 자체 계정이다.

## 멱등

제출 전 여러 번 돌린다. 계정이 이미 있으면 비밀번호·역할·소유 가게를 '맞추기만' 한다.

## 비밀번호

저장소에 두지 않는다. 환경변수로 넘긴다:

    JUDGE_ACCOUNT_PASSWORD='...' python scripts/seed_judge_accounts.py

미설정이면 아무것도 만들지 않고 종료한다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.supabase import supabase_admin  # noqa: E402

# 주최 측 지정 계정.
MERCHANT_EMAIL = "openapi@naver.com"
ADMIN_EMAIL = "openapi@gmail.com"

# 사업자 계정이 관리할 가게 — 황리단길 실존 명소(음식점 1 + 카페 1).
MERCHANT_FACILITY_IDS = [
    "2cff2c71-5101-4b68-aa8e-dd18f7539400",  # 이풍녀 구로쌈밥
    "68efde55-9be9-4ad6-93bb-972738e8c7c0",  # 맥심가옥
]


def _find_user_by_email(email: str):
    """Auth Admin 목록을 훑어 이메일로 사용자를 찾는다(단건 조회 API 가 없다)."""
    page = 1
    while True:
        users = supabase_admin.auth.admin.list_users(page=page, per_page=200)
        if not users:
            return None
        for u in users:
            if (getattr(u, "email", "") or "").lower() == email.lower():
                return u
        if len(users) < 200:
            return None
        page += 1


def _ensure_account(email: str, password: str):
    """계정을 만들거나(없으면) 비밀번호를 맞춘다(있으면). 반환: user_id."""
    existing = _find_user_by_email(email)
    if existing is not None:
        supabase_admin.auth.admin.update_user_by_id(
            existing.id, {"password": password, "email_confirm": True}
        )
        print(f"  [=] {email} 이미 존재 — 비밀번호·확인 상태 갱신 ({existing.id[:8]}…)")
        return existing.id

    created = supabase_admin.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    uid = created.user.id
    print(f"  [+] {email} 생성 ({uid[:8]}…)")
    return uid


def _ensure_role(user_id: str, role: str) -> None:
    # handle_new_user 트리거가 public.users 행을 만들지만, 경합을 피해 upsert 로 보장한다.
    res = supabase_admin.table("users").select("role").eq("id", user_id).limit(1).execute()
    if not res.data:
        supabase_admin.table("users").insert({"id": user_id, "role": role}).execute()
        before = None
    else:
        before = res.data[0].get("role")
        if before == role:
            print(f"      role={role} (변경 없음)")
            return
        supabase_admin.table("users").update({"role": role}).eq("id", user_id).execute()
    supabase_admin.table("role_audit_log").insert({
        "actor_id": None,
        "target_id": user_id,
        "action": "role_change",
        "from_value": before,
        "to_value": role,
        "reason": "심사 계정 시드(seed_judge_accounts.py)",
    }).execute()
    print(f"      role: {before} → {role}")


def _ensure_ownership(user_id: str, facility_ids: list[str]) -> None:
    existing = supabase_admin.table("facility_owners").select("facility_id") \
        .eq("user_id", user_id).is_("revoked_at", "null").execute()
    have = {str(r["facility_id"]) for r in (existing.data or [])}
    for fid in facility_ids:
        if fid in have:
            print(f"      소유 유지: {fid[:8]}…")
            continue
        fac = supabase_admin.table("facilities").select("name").eq("id", fid).limit(1).execute()
        if not fac.data:
            print(f"      ⚠️ 시설 없음, 건너뜀: {fid}")
            continue
        supabase_admin.table("facility_owners").insert({
            "facility_id": fid,
            "user_id": user_id,
            "granted_by": None,
            "note": "심사 계정 시드",
        }).execute()
        supabase_admin.table("role_audit_log").insert({
            "actor_id": None,
            "target_id": user_id,
            "action": "owner_grant",
            "to_value": fid,
            "reason": "심사 계정 시드(seed_judge_accounts.py)",
        }).execute()
        print(f"      소유 부여: {fac.data[0]['name']} ({fid[:8]}…)")


def main() -> int:
    password = os.environ.get("JUDGE_ACCOUNT_PASSWORD", "").strip()
    if not password:
        print("JUDGE_ACCOUNT_PASSWORD 가 설정되지 않았습니다. 비밀번호는 저장소에 두지 않습니다.")
        print("사용법:  JUDGE_ACCOUNT_PASSWORD='...' python scripts/seed_judge_accounts.py")
        return 1

    print("심사용 사업자 계정")
    merchant_id = _ensure_account(MERCHANT_EMAIL, password)
    _ensure_role(merchant_id, "merchant")
    _ensure_ownership(merchant_id, MERCHANT_FACILITY_IDS)

    print("심사용 관리자 계정")
    admin_id = _ensure_account(ADMIN_EMAIL, password)
    _ensure_role(admin_id, "admin")

    print("\n완료. 심사위원은 이메일/비밀번호로 로그인하면 바로 해당 콘솔이 열립니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
