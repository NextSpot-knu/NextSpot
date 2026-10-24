"""사장님 가게 사진(20261024090000)의 계약.

사진 자리는 features.merchant_photo 다 — image_url 은 밤 적재가 '사진 없음 확정'이면 지운다. 웹(lib/photoCredit.ts
merchantPhotoUrl)은 같은 버킷 이름과 path 키를 읽는다. 올리기·기록은 그 가게의 현재 사장님만, 내리기는 관리자도.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = "supabase/migrations/20261024090000_merchant_photos.sql"


def _body() -> str:
    text = (ROOT / MIGRATION).read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    return " ".join("\n".join(lines).lower().split())


def test_sorts_after_usage_events_and_reset_drops_the_functions():
    names = sorted(p.name for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert names.index(Path(MIGRATION).name) > names.index("20261023090000_usage_events.sql")
    prelude = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    for fn in ("set_merchant_photo(UUID, TEXT)", "clear_merchant_photo(UUID)", "owns_facility_folder(TEXT)"):
        assert f"DROP FUNCTION IF EXISTS public.{fn} CASCADE;" in prelude


def test_bucket_and_path_key_match_the_web():
    sql = _body()
    web = (ROOT / "apps/web/lib/photoCredit.ts").read_text(encoding="utf-8")
    assert "export const MERCHANT_PHOTO_BUCKET = 'facility-photos';" in web
    assert "'facility-photos', 'facility-photos', true" in sql
    # 사진 자리는 features — image_url 을 건드리지 않는다.
    assert "jsonb_build_object('merchant_photo', v_photo)" in sql
    assert "jsonb_build_object('path', p_path, 'updated_at', now())" in sql
    assert "image_url" not in sql


def test_only_current_owner_records_and_admin_may_clear():
    sql = _body()
    owner = "facility_id = p_facility_id and user_id = auth.uid() and revoked_at is null"
    assert sql.count(owner) == 2  # set · clear 둘 다 주인 확인
    assert "or public.is_admin_or_dev()" in sql
    assert "raise exception 'not_facility_owner'" in sql
    assert "split_part(p_path, '/', 1) <> p_facility_id::text" in sql
    for fn in ("set_merchant_photo(uuid, text)", "clear_merchant_photo(uuid)", "owns_facility_folder(text)"):
        assert f"revoke all on function public.{fn} from public, anon" in sql
        assert f"grant execute on function public.{fn} to authenticated" in sql


def test_storage_writes_are_owner_folder_only():
    sql = _body()
    assert "for insert to authenticated with check (bucket_id = 'facility-photos' and public.owns_facility_folder(name))" in sql
    assert "o.facility_id::text = (storage.foldername(p_name))[1]" in sql
