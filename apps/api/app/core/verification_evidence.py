"""인증 증빙 정리 — 심사가 끝나면 보관하지 않는다는 결정의 실행부.

왜 core 에 있나: 이 정책을 실행하는 곳이 **셋**이다.
  · 심사자의 승인·반려(routers/dev.py)
  · 신청자 본인의 철회·증빙 교체(routers/account.py)
  · 저장에 실패해 신청 행이 생기지 않은 업로드의 뒷정리(routers/account.py)
같은 약속을 세 곳이 각자 구현하면 한쪽만 고쳐지는 날이 온다. 실제로 이 함수는 한 번
조용히 깨져 있었다 — 상태 갱신이 document_path 를 먼저 NULL 로 만든 뒤에 그 칼럼을 다시
읽던 구조라 **Storage 파일이 한 번도 지워지지 않았다.** 그래서 경로를 인자로 받는다.

이 주석이 한동안 거짓이었다: '단일 출처' 라고 적어 두고도 dev.py 는 자기 사본
(_clear_evidence)을 그대로 쓰고 있었다. 지금은 두 라우터 모두 이 함수만 부른다 —
사본을 다시 만들지 마라. 여기서 로그 필드 하나를 늘리면 세 경로가 같이 좋아진다.
"""

import asyncio

import structlog

from app.core.supabase import supabase_admin

logger = structlog.get_logger()

BUSINESS_DOCUMENTS_BUCKET = "business-documents"


async def clear_verification_evidence(request_id: str | None, path: str | None) -> None:
    """증빙 파일을 지운다. 경로가 없으면 할 일이 없다(이미 지워졌거나 첨부가 없었다).

    request_id 가 None 인 경우가 있다 — 신청 저장이 실패해 **행이 아예 만들어지지 않은**
    업로드를 치울 때다. 그때도 path 앞머리가 업로더의 uid 라(<uid>/<파일명>) 로그만으로
    추적이 된다.

    실패해도 예외를 올리지 않는다. 이 호출부들은 모두 **결정이 이미 기록된 뒤**(또는 오류
    응답이 이미 정해진 뒤)라, 여기서 던지면 되돌릴 수 없는 결정에 500 을 붙이는 꼴이 된다.
    대신 경고를 남겨 수동 정리가 가능하게 한다(경로가 로그에 남는다).
    """
    if not path:
        return
    try:
        await asyncio.to_thread(
            supabase_admin.storage.from_(BUSINESS_DOCUMENTS_BUCKET).remove, [path]
        )
    except Exception as exc:
        logger.warning(
            "verification_document_delete_failed",
            request_id=request_id,
            path=path,
            error=str(exc),
        )
