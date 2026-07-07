// SPOT 알고리즘 공유 상수 — 프론트(시뮬레이터·표시용)와 백엔드(런타임)의 단일 정의점.
//
// ⚠️ 런타임 소스 오브 트루스는 백엔드 apps/api/app/services/spot/score.py 다(Python은 TS를
// import 할 수 없음). 이 파일과 score.py 의 정합성은 apps/api/tests/services/test_spot.py 의
// 패리티 테스트가 CI 에서 강제한다 — 한쪽만 바꾸면 CI 가 실패한다.
//
// 가중치 출처: 2026 관광데이터 활용 공모전 제안서 (w1 0.40 / w2 0.40 / w3 0.20).
// 인센티브 항은 D1 재결정(2026-07-07): '쿠폰 강도 + 수요 재배치 기여' 결합
//   incentive = couponShare·min(1, coupon_rate/couponRateCap) + (1−couponShare)·max(0, 원본혼잡 − 후보 도착시점 예측혼잡)

export const SPOT_WEIGHTS = {
  /** w1 — 취향 일치율(선호 벡터 코사인 유사도) */
  preference: 0.4,
  /** w2 — 시간 비용(도착시점 예측 대기시간 + 이동시간, 60분 상한 정규화) */
  time: 0.4,
  /** w3 — 인센티브(쿠폰 강도 + 수요 재배치 기여 결합) */
  incentive: 0.2,
} as const;

/** 인센티브 항 내부 구성 — 백엔드 score.py 의 INCENTIVE_COUPON_SHARE / COUPON_RATE_CAP 와 정합 */
export const SPOT_INCENTIVE = {
  /** 쿠폰강도 vs 재배치기여 비중 */
  couponShare: 0.5,
  /** 할인율 정규화 캡 — coupon_rate 0.20(=20% 할인) 이상은 만점 */
  couponRateCap: 0.2,
} as const;

/** SPOT_Score = w1·preference − w2·time_cost + w3·incentive → Min-Max 정규화 [0,1] */
export const SPOT_FORMULA = "w1*preference - w2*time_cost + w3*incentive" as const;

/** 관광 카테고리(내부 타입) ↔ TourAPI contentTypeId 매핑 */
export const CATEGORY_CONTENT_TYPE = {
  attraction: 12, // 관광지
  culture: 14,    // 문화시설
  restaurant: 39, // 음식점 (cat3 A05020900 = 카페/전통찻집 → cafe 로 분리)
  cafe: 39,
} as const;
