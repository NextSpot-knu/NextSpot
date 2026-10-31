"""app/core/network_key — 원본 IP 대신 대역(IPv4 /24 · IPv6 /64)의 비밀 HMAC 만 남긴다."""
import re

from app.core import network_key
from app.core.network_key import network_key_hash, network_prefix


def test_prefix_groups_by_slash24_and_slash64():
    assert network_prefix("203.0.113.7") == "203.0.113.0/24"
    assert network_prefix("::ffff:203.0.113.200") == "203.0.113.0/24"
    assert network_prefix("2001:db8:1:2:aaaa::1") == "2001:db8:1:2::/64"
    for bad in (None, "", "unknown", "testclient", "999.1.1.1"):
        assert network_prefix(bad) is None


def test_hash_is_stable_per_network_and_never_contains_the_ip():
    a = network_key_hash("203.0.113.7")
    assert a is not None and re.fullmatch(r"[0-9a-f]{32}", a)
    assert a == network_key_hash("203.0.113.250")  # 같은 /24
    assert a != network_key_hash("203.0.114.7")
    assert network_key_hash("2001:db8:1:2::1") == network_key_hash("2001:db8:1:2:ffff::9")
    assert "." not in a and ":" not in a
    assert network_key_hash("testclient") is None


def test_salt_changes_the_key(monkeypatch):
    before = network_key_hash("198.51.100.1")
    monkeypatch.setattr(network_key.settings, "NETWORK_HASH_SALT", "rotated-salt", raising=False)
    assert network_key_hash("198.51.100.1") != before
