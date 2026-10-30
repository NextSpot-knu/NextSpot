"""레이트리밋·쿨다운 키용 클라이언트 IP — 라우터 공용 단일 정의점.

예전에는 search · tracking · recommendations(음성) · infrastructures(실시간 상세) 네 라우터가 같은 함수를
각자 복제해 들고 있었다. 혼잡·영업 제보(reports)가 다섯 번째 사용처가 되면서 여기로 모았다 — XFF 해석
방향을 바꿀 때(HANDOVER 보안 진단 '중 — X-Forwarded-For 해석 방향 미검증') 고칠 곳이 한 곳이어야 한다.

⚠️ XFF 의 '첫 값'은 클라이언트가 위조 가능하다(프록시는 뒤에 append) — 요청마다 다른 가짜 첫 값으로
제한을 무한 우회할 수 있다. 신뢰 프록시(Render 엣지)가 마지막에 덧붙인 값이 실제 피어이므로 **마지막
항목**을 쓴다. 프록시 없는 로컬은 소켓 피어. Render 가 hop 을 하나 더 덧붙이는지는 아직 관측하지 못했다
— 덧붙인다면 모든 요청이 한 키가 되므로, 이 값으로 거는 제한은 '전원이 함께 막힐 수 있다' 를 전제로
상한을 잡는다.
"""
from fastapi import Request


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"
