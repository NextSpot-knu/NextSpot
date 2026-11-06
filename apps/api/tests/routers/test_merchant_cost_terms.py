# 타임세일 발행 확인 단계의 '비용 안내' 숫자가 서버 정본과 같은지 잠근다(평가 M4).
#
# 사장님은 발행 직전에 두 사실을 본다 — 세일 중 발급된 쿠폰은 세일이 끝나도 발급 후 N일 동안 쓸 수 있고,
# 할인율이 상한(20%)을 넘어도 추천에 더해지는 효과는 같다. 화면은 이 숫자를 웹 상수에서 읽는데
# (apps/web/lib/merchant/api.ts), 정본은 여기 서버다:
#   · 쿠폰 수명  — app/services/coupon_service.py COUPON_TTL_DAYS
#   · 할인율 상한 — app/services/spot/score.py COUPON_RATE_CAP (shared-types 와의 일치는 test_spot.py 가 잠근다 —
#     웹은 그 shared-types 값을 그대로 읽으므로 숫자를 다시 적지 않았는지만 본다)
# 한쪽만 바꾸면 사장님에게 틀린 비용을 말하게 된다 — 여기서 CI 가 멈춘다. (Docker 등 모노레포 밖 실행 시엔 skip)
import re
from pathlib import Path

import pytest

from app.services.coupon_service import COUPON_TTL_DAYS
from app.services.spot.score import COUPON_RATE_CAP


def _web_merchant_api() -> str:
    repo_root = Path(__file__).resolve().parents[4]
    api_ts = repo_root / "apps" / "web" / "lib" / "merchant" / "api.ts"
    if not api_ts.exists():
        pytest.skip("apps/web/lib/merchant/api.ts 부재(모노레포 밖 실행) — 비용 안내 대조 생략")
    return api_ts.read_text(encoding="utf-8")


def test_web_coupon_valid_days_matches_coupon_ttl():
    match = re.search(r"export const COUPON_VALID_DAYS = (\d+);", _web_merchant_api())
    assert match, "웹 비용 안내의 쿠폰 유효 기간 상수(COUPON_VALID_DAYS)를 찾지 못했다"
    assert int(match.group(1)) == COUPON_TTL_DAYS


def test_web_rate_cap_is_read_from_shared_types_not_retyped():
    text = _web_merchant_api()
    assert re.search(r"export const COUPON_RATE_CAP\b[^=]*= SPOT_INCENTIVE\.couponRateCap;", text), (
        "웹 비용 안내가 할인율 상한을 shared-types 에서 읽지 않고 숫자로 다시 적었다"
    )
    # 화면 문장이 말하는 상한(20%)이 서버 산식의 상한과 같다는 것도 함께 본다 — 문장은 이 값에서 만들어진다.
    assert COUPON_RATE_CAP == pytest.approx(0.20)
