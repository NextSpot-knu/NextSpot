"""내 문의 라우터 — 문의자가 **자기 문의와 그 답변**을 본다.

배경: /admin/support 의 '답변 전송' 은 오랫동안 아무것도 보내지 않았다. 답변을 담을 컬럼도
(20260907091000 에서 추가), 문의자에게 닿는 채널도 없었기 때문이다. 메일·웹푸시 인프라가
이 저장소에 없으므로 전달 채널은 **앱 내 표시**로 정했다 — 이 엔드포인트와
apps/web/app/mypage/inquiries 가 그 채널이다. 이 화면이 있어야 '답변했다' 가 사실이 된다.

- 인증: impact.py 와 동일한 사용자 인증 패턴(get_current_user, Supabase JWT). 익명 로그인
  세션(signInAnonymously)도 그대로 통과한다 — 앱은 대부분 그 세션으로 문의를 넣는다.
- DB: service_role(supabase_admin) 로 읽되 **user_id = 토큰 주체**로만 좁힌다. 여기서
  범위를 넓히면 곧바로 PII 유출이다(inquiries.content 에는 사람이 쓴 본문이 들어 있고,
  user_name 은 실명일 수 있다). RLS 를 우회하는 경로라 그 필터가 유일한 방어선이다.
- 남의 문의가 절대 섞이지 않도록 응답에서 user_id/user_name 을 아예 내보내지 않는다
  (본인 것이라 위험하진 않지만, 화면이 쓰지 않는 신원 필드를 굳이 실어 보내지 않는다).
  replied_by(답한 관리자 uid)도 내보내지 않는다 — 문의자가 알 필요가 없는 내부 신원이다.

⚠️ 세션 없이 접수된 문의(user_id IS NULL)는 여기에 나오지 않는다. 20260904091000 이
   익명 문의 경로를 그렇게 열어 뒀고(신원을 위조해 남의 uid 로 넣는 것을 막느라), NULL 은
   auth.uid() 와 절대 같아지지 않는다. **그 문의의 답변은 앱 안에서 볼 방법이 없다** —
   관리자 화면이 답변 전에 그 사실을 경고한다.
"""
import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException

from app.core.supabase import get_current_user, supabase_admin

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/inquiries", tags=["inquiries"])

# 한 사람이 낸 문의의 조회 상한. **의도된 상한**이라 페이지네이션하지 않는다 — 이 화면은
# 집계가 아니라 "내가 뭘 물었고 답이 왔나" 를 보는 목록이고, 한 사람이 100건을 넘기는 일은
# 지원 문의의 성질상 사실상 없다. PostgREST 응답 캡(1000)보다 작아 조용한 절단도 없다.
_MINE_LIMIT = 100

# 답변 컬럼이 아직 없는 DB 에서도 문의 목록 자체는 보여 줘야 한다(마이그레이션은 사람이
# 원격 SQL Editor 에서 적용하므로 백엔드가 먼저 배포되는 순서가 실제로 가능하다).
_BASE_COLUMNS = "id, type, title, content, status, created_at"
_REPLY_COLUMNS = "reply_body, replied_at"


def _is_missing_reply_columns(exc: Exception) -> bool:
    """답변 컬럼이 아직 없는 DB인가(admin.py 의 같은 이름 헬퍼와 같은 판정).

    SELECT 경로의 실측 오류는 42703 "column inquiries.reply_body does not exist" 다.
    """
    text = str(exc).lower()
    return any(column in text for column in ("reply_body", "replied_at")) and (
        "pgrst204" in text or "42703" in text or "column" in text or "schema cache" in text
    )


@router.get("/mine")
async def my_inquiries(current_user: dict = Depends(get_current_user)):
    """내가 낸 문의 목록(최신순) — 관리자 답변이 있으면 함께 준다.

    반환: { items: [...], replySupported: bool }

    replySupported 가 필요한 이유: 답변 컬럼이 없는 DB 에서 items 의 reply_body 는 전부
    없다. 그 상태를 화면이 "아직 답변이 없어요" 로 그리면 **기다리면 온다는 거짓말**이 된다
    (답변을 저장할 자리 자체가 없으므로 기다려도 오지 않는다). 두 상태를 구분해 준다.
    """
    user_id = current_user["id"]

    def _select(columns: str):
        return (
            supabase_admin.table("inquiries")
            .select(columns)
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(_MINE_LIMIT)
            .execute()
        )

    reply_supported = True
    try:
        res = await asyncio.to_thread(_select, f"{_BASE_COLUMNS}, {_REPLY_COLUMNS}")
    except Exception as exc:
        if _is_missing_reply_columns(exc):
            logger.warning("inquiries_mine_legacy_schema", user_id=user_id)
            reply_supported = False
            try:
                res = await asyncio.to_thread(_select, _BASE_COLUMNS)
            except Exception as retry_exc:
                logger.error("inquiries_mine_failed", user_id=user_id, error=str(retry_exc))
                raise HTTPException(status_code=500, detail="문의 내역을 불러오지 못했습니다.") from None
        else:
            # 빈 목록으로 폴백하지 않는다 — '문의한 적 없음' 과 '조회 실패' 는 다른 사실이고,
            # 여기서 뭉개면 사용자는 자기가 보낸 문의가 사라진 줄 안다.
            logger.error("inquiries_mine_failed", user_id=user_id, error=str(exc))
            raise HTTPException(status_code=500, detail="문의 내역을 불러오지 못했습니다.") from None

    items = [
        {
            "id": str(row.get("id")),
            "type": row.get("type"),
            "title": row.get("title"),
            "content": row.get("content"),
            "status": row.get("status") or "new",
            "created_at": row.get("created_at"),
            # 컬럼이 없는 DB 에서도 키 자체는 준다(프런트가 optional 분기를 하나만 갖도록).
            "reply_body": row.get("reply_body"),
            "replied_at": row.get("replied_at"),
        }
        for row in (res.data or [])
    ]
    return {"items": items, "replySupported": reply_supported}
