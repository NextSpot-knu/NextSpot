"""사업자등록증 증빙 버킷 마이그레이션의 계약.

이 버킷이 없던 동안 `document_path` 칼럼과 삭제 코드(dev.py _clear_evidence)는 있었지만
**신청자가 서류를 낼 방법이 없었다.** 그래서 심사자는 신청자가 본문에 적어 보낸 facility_id 를
대조할 근거 없이 승인해야 했다.
"""
from pathlib import Path


def _sql() -> str:
    root = Path(__file__).resolve().parents[4]
    return (root / "supabase/migrations/20260904200000_business_documents_bucket.sql").read_text(
        encoding="utf-8"
    )


def test_bucket_is_private_and_limited():
    sql = _sql()
    assert "'business-documents'" in sql
    # 공개 버킷이면 경로만 알면 누구나 남의 사업자등록증을 본다.
    assert "false" in sql and "public = false" in sql
    assert "file_size_limit" in sql
    # 실행 가능한 파일이 올라오면 안 된다 — 이미지와 PDF 만.
    assert "image/jpeg" in sql and "application/pdf" in sql
    assert "image/svg" not in sql, "SVG 는 스크립트를 품을 수 있다"


def test_upload_is_scoped_to_the_uploaders_own_folder():
    """이게 없으면 로그인한 누구나 남의 uid 폴더에 파일을 올려, 그 사람의 신청서에 붙은
    증빙인 것처럼 보이게 만들 수 있다."""
    sql = _sql()
    assert "business_documents_insert_own" in sql
    assert "storage.foldername(name))[1] = auth.uid()::text" in sql
    assert "FOR INSERT TO authenticated" in sql


def test_the_applicant_cannot_delete_evidence_mid_review():
    """지우는 것은 서버만 한다 — 신청자가 심사 도중 근거를 없애면 안 된다."""
    sql = _sql()
    assert "FOR DELETE" not in sql


def test_migration_is_idempotent():
    """사람이 SQL 에디터에 붙여넣어 적용한다 — 두 번 붙여넣어도 안전해야 한다."""
    sql = _sql()
    assert "ON CONFLICT (id) DO UPDATE" in sql
    assert sql.count("DROP POLICY IF EXISTS") >= 2
