"""미리 직렬화한 응답 바이트 + ETag 재검증(304) — 참조 스냅샷이 만든 지도 바이트를 내보내는 자리.

Cache-Control 은 ``private, no-cache`` 다(max-age 를 주지 않는다). 이유:
  · 프로세스 안의 쓰기(혼잡 제보·관리자 혼잡 설정·좌석 방송·시설 CRUD)는 서버 스냅샷을 곧바로 무효화하지만
    (reference_snapshot.mark_dirty), **브라우저 캐시는 무효화할 방법이 없다.** max-age=60 이면 방금 제보한
    사람이 지도를 다시 열어도 최대 60초 동안 요청 자체가 나가지 않는다 — 시연 흐름(관리자 혼잡 설정 → 지도)
    에서 바로 보인다.
  · no-cache 는 '저장은 하되 쓸 때마다 서버에 물어본다' 다. 바뀐 게 없으면 서버는 본문 없는 304 로 답하고
    (1 왕복), 브라우저는 저장본을 그대로 쓴다. 웹(api-client.ts)의 fetch 는 기본 캐시 모드라 코드 변경 없이
    If-None-Match 를 붙인다.
  · private — 응답이 사용자별로 다르지는 않지만, 공유 캐시(CDN)가 끼어들어 무효화 경로가 하나 더 생기는 것을
    원하지 않는다.
"""

from fastapi import Request, Response

CACHE_CONTROL = "private, no-cache"


def _opaque(tag: str) -> str:
    """약한 비교(RFC 9110 §8.8.3.2): W/ 접두를 떼고 따옴표 친 본체만 비교한다.

    Render 앞단(Cloudflare)은 응답을 압축하면서 강한 ETag 를 W/ 로 낮춘다 — 브라우저는 그 W/ 값을
    If-None-Match 로 돌려보내므로, 강한 비교를 하면 영영 304 가 나지 않는다.
    """
    tag = tag.strip()
    if tag[:2] in ("W/", "w/"):
        tag = tag[2:]
    return tag


def if_none_match_hits(header: str | None, etag: str) -> bool:
    """If-None-Match 헤더가 이 ETag(또는 *)를 담고 있는가."""
    if not header:
        return False
    target = _opaque(etag)
    for candidate in header.split(","):
        candidate = candidate.strip()
        if candidate == "*" or (candidate and _opaque(candidate) == target):
            return True
    return False


def etag_response(
    request: Request,
    *,
    body: bytes,
    etag: str,
    headers: dict[str, str] | None = None,
) -> Response:
    """If-None-Match 가 맞으면 본문 없는 304, 아니면 200 + 바이트. 두 경우 모두 ETag·Cache-Control 을 싣는다."""
    out = {"ETag": etag, "Cache-Control": CACHE_CONTROL, **(headers or {})}
    if if_none_match_hits(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=out)
    return Response(content=body, media_type="application/json", headers=out)
