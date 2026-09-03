// web↔api 공유 계약 — SPOT 상수(spot.ts)의 단일 공급점.
// D5 결정(2026-07-07): 프론트는 이 패키지에서 SPOT 가중치를 import 하고,
// 백엔드 score.py 와의 정합성은 CI 패리티 테스트(apps/api/tests/services/test_spot.py)가 강제한다.
//
// 과거 여기 있던 Facility/CongestionLog/SPOTRecommendation 타입은 소비처가 없어 제거했다(2026-09-04).
// 프론트의 실제 응답 타입은 apps/web/lib/api-client.ts 가 정의한다.

export * from './spot';
