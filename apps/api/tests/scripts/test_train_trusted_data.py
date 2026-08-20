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


def test_baseline_uses_training_rows_only():
    from datetime import datetime, timezone

    train_rows = [(datetime(2026, 8, 1, 1, tzinfo=timezone.utc), "cafe", 0.2)]
    holdout = [(datetime(2026, 8, 8, 1, tzinfo=timezone.utc), "cafe", 0.9)]
    assert train._baseline_predictions(train_rows, holdout) == [0.2]
