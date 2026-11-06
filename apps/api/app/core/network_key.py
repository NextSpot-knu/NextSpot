"""게스트 답의 네트워크 키 — 원본 IP 대신 '대역의 비밀 해시' 만 DB 에 남긴다(PRODUCT_EVALUATION_PLAN §6 D3).

무엇: IPv4 는 /24, IPv6 는 /64 대역(IPv4-mapped IPv6 는 IPv4 로 본다)을 서버 비밀값으로 HMAC-SHA256 한 앞 32자(hex).
왜 대역인가: 같은 집·같은 휴대폰 회선은 주소 끝자리가 자주 바뀐다(IPv6 는 기기마다 /64 안에서 임시 주소를 돌린다).
  '한 사람이 게스트 여러 개' 를 묶으려면 주소 하나가 아니라 대역을 봐야 한다. 반대로 대역은 같은 건물·같은 통신사
  출구를 쓰는 남들도 묶으므로 차단 근거로는 쓰지 않는다 — 그림자 측정(겹침 비율)과 실시간 모드의 '서로 다른 네트워크 둘'
  조건에만 쓴다.
왜 비밀 HMAC 인가: IPv4 /24 는 1,677만 개뿐이라 그냥 해시하면 전부 계산해 되돌릴 수 있다. 서버만 아는 키로 HMAC 하면
  DB 만 가진 사람은 되돌릴 수 없다. 키는 NETWORK_HASH_SALT(운영 권장 — 없으면 JWT_SECRET 에서 용도를 분리해 파생하는
  비상용 폴백. JWT_SECRET 을 회전하면 키가 말없이 바뀐다)다.
  키를 바꾸면 이전 해시와 이어지지 않는다 — 보관이 30일(20261031130000 의 pg_cron)이라 그 뒤로는 문제없다.
원본 IP 는 이 함수 안에서만 쓰고 저장·로그하지 않는다.
"""
import hashlib
import hmac
import ipaddress

from app.core.config import settings

_KEY_CONTEXT = b"nextspot-network-key-v1"


def _hmac_key() -> bytes:
    salt = (getattr(settings, "NETWORK_HASH_SALT", "") or "").strip()
    secret = salt or settings.JWT_SECRET
    # JWT 서명 키를 그대로 HMAC 키로 쓰지 않는다 — 용도를 섞지 않게 한 번 파생한다.
    return hmac.new(secret.encode("utf-8"), _KEY_CONTEXT, hashlib.sha256).digest()


def network_prefix(ip: str | None) -> str | None:
    """IPv4 /24 · IPv6 /64 대역 문자열. 해석할 수 없으면(예: 'unknown', 'testclient') None."""
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(ip.strip())
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    prefix = 24 if addr.version == 4 else 64
    return str(ipaddress.ip_network(f"{addr}/{prefix}", strict=False))


def network_key_hash(ip: str | None) -> str | None:
    """대역의 HMAC 앞 32자(소문자 hex). 대역을 알 수 없으면 None — 그때는 네트워크 조건을 못 채운다."""
    prefix = network_prefix(ip)
    if prefix is None:
        return None
    return hmac.new(_hmac_key(), prefix.encode("ascii"), hashlib.sha256).hexdigest()[:32]
