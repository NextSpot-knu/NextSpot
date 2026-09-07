from types import SimpleNamespace

from scripts import train


class EmptyOutcomeClient:
    def table(self, _name):
        return self

    def select(self, _fields):
        return self

    def in_(self, _field, _values):
        return self

    def execute(self):
        return SimpleNamespace(data=[])


def test_collect_rows_excludes_synthetic_and_single_reports_and_medians_corroborated(monkeypatch):
    facilities = [{"id": "f1", "type": "cafe", "is_active": True}]
    logs = [
        {"facility_id": "f1", "timestamp": "2026-08-01T01:01:00Z", "congestion_level": 0.4, "source": "event", "evidence_tier": "verified"},
        {"facility_id": "f1", "timestamp": "2026-08-01T01:02:00Z", "congestion_level": 0.0, "source": "seed", "evidence_tier": "synthetic"},
        {"facility_id": "f1", "timestamp": "2026-08-01T01:03:00Z", "congestion_level": 0.9, "source": "user_report", "evidence_tier": "single_report"},
        {"facility_id": "f1", "timestamp": "2026-08-01T01:05:00Z", "congestion_level": 0.2, "source": "user_report", "evidence_tier": "corroborated"},
        {"facility_id": "f1", "timestamp": "2026-08-01T01:20:00Z", "congestion_level": 0.8, "source": "user_report", "evidence_tier": "corroborated"},
    ]

    def fetch(_client, table, _columns):
        return {"facilities": facilities, "congestion_logs": logs, "recommendation_outcomes": []}[table]

    monkeypatch.setattr(train, "fetch_all_rows", fetch)
    rows, sources, active_types = train.collect_rows(EmptyOutcomeClient())
    assert active_types == ["cafe"]
    assert [(row[0].minute, row[2]) for row in rows] == [(0, 0.5), (1, 0.4)]
    assert sources["verified"] == 1
    assert sources["corroborated"] == 1
    assert sources["synthetic"] == sources["single_report"] == 0


# =========================================================================
# 확증 관측의 합침 단위 — '한 가게의 한 사건'
# 위 픽스처는 시설이 하나뿐이라 업종 단위 합침을 **밟지도 못했다**. 시설을 둘로 늘리면
# 옛 키((facility_type, bucket))에서는 서로 다른 가게의 관측이 한 줄로 뭉개진다.
# =========================================================================


def test_collect_rows_keeps_corroborated_observations_of_different_facilities_apart(monkeypatch):
    """같은 업종·같은 30분 버킷이라도 시설이 다르면 합치지 않는다.

    옛 키((facility_type, bucket))로 되돌리면 세 행이 **한 줄**로 뭉개져 f2 의 0.8 이 통째로
    사라진다(중앙값 0.2 만 남는다) — 만석에 가까웠던 가게의 관측이 학습 정답에서 지워진다.
    승격 게이트의 분모(real_data_count)도 2가 아니라 1이 된다.
    """
    facilities = [
        {"id": "f1", "type": "cafe", "is_active": True},
        {"id": "f2", "type": "cafe", "is_active": True},
    ]
    logs = [
        # f1 — 같은 버킷 안 두 행(같은 시설의 한 사건이므로 이쪽은 합쳐지는 게 맞다).
        {"facility_id": "f1", "timestamp": "2026-08-01T01:05:00Z", "congestion_level": 0.2, "source": "user_report", "evidence_tier": "corroborated"},
        {"facility_id": "f1", "timestamp": "2026-08-01T01:20:00Z", "congestion_level": 0.2, "source": "user_report", "evidence_tier": "corroborated"},
        # f2 — 같은 업종·같은 버킷이지만 다른 가게다.
        {"facility_id": "f2", "timestamp": "2026-08-01T01:10:00Z", "congestion_level": 0.8, "source": "user_report", "evidence_tier": "corroborated"},
    ]

    def fetch(_client, table, _columns):
        return {"facilities": facilities, "congestion_logs": logs, "recommendation_outcomes": []}[table]

    monkeypatch.setattr(train, "fetch_all_rows", fetch)
    rows, sources, _active_types = train.collect_rows(EmptyOutcomeClient())

    # 시설별로 한 줄씩 — 두 가게의 실제 관측값이 그대로 남는다(0.5 는 어디에도 없다).
    assert sorted(row[2] for row in rows) == [0.2, 0.8]
    assert sources["corroborated"] == 2
    assert all(row[1] == "cafe" for row in rows)


def test_collect_rows_logs_the_bucket_unit_and_both_counts(capsys, monkeypatch):
    """단위가 바뀌어 표본 수가 달라진다 — 학습 로그가 '이전/이후' 를 함께 남겨야 한다.

    이 숫자가 그대로 승격 게이트(MIN_REAL_DATA_COUNT 등)의 분모라, 로그에 남기지 않으면
    문턱이 상대적으로 낮아진 것을 표본 증가로 오독한다.
    """
    facilities = [
        {"id": "f1", "type": "cafe", "is_active": True},
        {"id": "f2", "type": "cafe", "is_active": True},
    ]
    logs = [
        {"facility_id": "f1", "timestamp": "2026-08-01T01:05:00Z", "congestion_level": 0.2, "source": "user_report", "evidence_tier": "corroborated"},
        {"facility_id": "f2", "timestamp": "2026-08-01T01:10:00Z", "congestion_level": 0.8, "source": "user_report", "evidence_tier": "corroborated"},
        {"facility_id": "f1", "timestamp": "2026-08-01T02:00:00Z", "congestion_level": 0.4, "source": "event", "evidence_tier": "verified"},
    ]

    def fetch(_client, table, _columns):
        return {"facilities": facilities, "congestion_logs": logs, "recommendation_outcomes": []}[table]

    monkeypatch.setattr(train, "fetch_all_rows", fetch)
    train.collect_rows(EmptyOutcomeClient())

    printed = capsys.readouterr().out
    assert "bucket unit=(facility_id, facility_type, 30min)" in printed
    assert "buckets_before(facility_type only)=1" in printed
    assert "buckets_after=2" in printed
    # verified 1건 + 확증 버킷 → 게이트 분모가 2 에서 3 으로 늘었다는 사실이 함께 남는다.
    assert "real_data_count_before=2" in printed
    assert "real_data_count_after=3" in printed


def test_baseline_uses_training_rows_only():
    from datetime import datetime, timezone

    train_rows = [(datetime(2026, 8, 1, 1, tzinfo=timezone.utc), "cafe", 0.2)]
    holdout = [(datetime(2026, 8, 8, 1, tzinfo=timezone.utc), "cafe", 0.9)]
    assert train._baseline_predictions(train_rows, holdout) == [0.2]
