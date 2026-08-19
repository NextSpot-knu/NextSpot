from pathlib import Path

import pytest

from scripts.ingest_localdata import decode_csv, parser, read_csv


def test_csv_decodes_utf8_bom_and_cp949(tmp_path: Path):
    content = "관리번호,사업장명\n1,한옥카페\n"
    for encoding in ("utf-8-sig", "cp949"):
        path = tmp_path / f"sample-{encoding}.csv"
        path.write_bytes(content.encode(encoding))
        assert read_csv(path)[0]["사업장명"] == "한옥카페"


def test_invalid_csv_encoding_fails_closed():
    with pytest.raises(ValueError):
        decode_csv(b"\xff\xfe\x00\x81")


def test_cli_defaults_to_dry_run_and_seven_day_delta():
    args = parser().parse_args(["delta"])
    assert args.apply is False
    assert args.start_date is None
