# 심사위원 예상 질문 10문 + 모범 답변 (2026 관광데이터 활용 공모전)

> PT 심사 질의응답 대비 문서. 각 답변은 코드/문서 근거를 명시한다. 정본 전략은
> [`CONTEST_STRATEGY.md`](./CONTEST_STRATEGY.md), 최신 상태는 [`HANDOVER.md`](./HANDOVER.md) 참고.

---

## Q1. 카카오/네이버 지도와 뭐가 다른가?

카카오·네이버 지도는 "지금 여기가 붐빈다"는 현재 시점 혼잡 정보를 보여줄 뿐이지만, NextSpot의 SPOT 알고리즘은
사용자가 실제로 "도착하는 시점"의 혼잡도를 로컬 sklearn 모델(`predict_congestion`)로 예측해 대안을 추천한다.
단순 정보 제공이 아니라 선호도(w1=0.40)·시간비용(w2=0.40)·인센티브(w3=0.20) 3항을 결합한 개인화 점수로
능동적으로 "어디로 가면 좋을지"를 골라주며, 도착시점 예측혼잡에는 인근 축제 보정(`get_event_congestion_boost`)까지
반영한다. 나아가 추천 수락 시 쿠폰이 자동 발급되는 폐루프와 지자체용 B2G 관제 대시보드까지 갖춘 "분산 실행"
플랫폼이라는 점이 지도 서비스와의 근본적 차이다.
[뒷받침 근거: apps/api/app/services/spot/score.py W1/W2/W3·event_boost]

## Q2. 예측 정확도는 어떻게 되나?

혼잡 예측 모델은 `train.py --evaluate` 실행 시 시계열 홀드아웃(학습 구간과 분리된 최근 구간)으로 예측치와
실측 혼잡도의 MAE를 계산하고, 이를 단순 기준선(시간대 평균 등 naive 예측) 대비 비교하는 절차로 검증하도록
설계되어 있다. 즉 "정확도를 주장"하는 것이 아니라 그 자리에서 재현 가능한 정량 검증 스크립트를 갖췄다는 점이
핵심이며, 최신 MAE 수치는 심사 시연 시 해당 명령을 직접 실행해 제시할 수 있다. 여기에 더해 예측 서비스는
CI 게이트(`pytest apps/api` 116 passed)로 회귀 안정성도 별도로 보장받는다.
[뒷받침 근거: train.py --evaluate(홀드아웃 MAE vs 기준선), docs/HANDOVER.md §4 CI 게이트]

## Q3. 수익 모델은?

소상공인 대상 B2B는 쿠폰 제휴다 — 할인율(`coupon_rate`)이 높을수록 인센티브 항 값이 커져 SPOT 추천 노출이
늘어나는 구조가 이미 `COUPON_RATE_CAP=0.20`(20% 할인이면 만점) 계산으로 코드에 구현되어 있고, 추천 수락 시
서버가 쿠폰을 자동 발급하고 실사용까지 이어지는 폐루프(`coupons/issue`→`coupons/mine`→`coupons/{id}/use`)가
실거래 전환 가능성을 증빙한다. 지자체 대상 B2G는 혼잡 관리 SaaS 라이선스로, 관리자 대시보드
(`GET /api/v1/admin/dashboard/today`)·수동 혼잡 Override·이상 알림이 이미 동작한다. `CONTEST_STRATEGY.md` D6은
이를 "B2G 라이선스 + 소상공인 제휴 티어 + 데이터 리포트 판매" 3단 구조로 정리했다.
[뒷받침 근거: score.py coupon_term/COUPON_RATE_CAP, docs/CONTEST_STRATEGY.md D6/C4]

## Q4. [기술] 신규 유저·신규 시설의 콜드스타트 문제는 어떻게 푸나?

신규 유저는 선호 벡터 축적 이력이 없어도 온보딩에서 고른 `preferred_categories`로 첫 추천부터 카테고리
유사도 계산(`calculate_preference_similarity`)이 즉시 가능하다. 신규 시설(TourAPI 신규 적재분)도 혼잡 이력이
없지만 `predict_congestion`이 시설 개별 이력이 아니라 "시설 타입 × 시간대" 단위로 일반화 학습된 모델이라
개별 이력 없이도 예측할 수 있고, 축제 보정처럼 외부 신호로 추가 보완한다. 다만 개인화가 실제로 수렴하는
과정을 보여주는 "취향 벡터 가시화(B4)"는 아직 데모 UI에 완전히 노출되지 않아 보강이 필요하다는 점은 정직하게
밝힌다.
[뒷받침 근거: score.py calculate_preference_similarity, docs/CONTEST_STRATEGY.md B4]

## Q5. [기술] 데이터가 실시간이 아닌데 신선도는 어떻게 보장하나?

TourAPI는 실시간 스트리밍이 아니라 배치 적재이며, 현재 `facilities` 85행(TourAPI 실적재 69 + 시드 16)은
`ingest_tourapi.py` 실행으로 채워졌다. 이 적재는 GitHub Actions cron(`.github/workflows/ingest.yml`, 매일
KST 04:00)으로 이미 자동화되어 있고(D1), `GET /api/v1/freshness`가 마지막 동기화 시각을 공개해 관리자
화면 신선도 배지로 "언제 데이터인지"를 사용자에게 그대로 증빙한다(D5 — 마커 부재 시 updated_at 추정으로
폴백하는 정직한 표기). 다만 혼잡도는 정적 스냅샷이 아니라 요청마다 sklearn 모델이 도착 예정 시각을 다시
추론하므로, "장소 정보는 일 단위, 혼잡 예측은 요청 단위"로 신선도 계층이 분리되어 있다는 점이 핵심이다.
[뒷받침 근거: .github/workflows/ingest.yml, apps/api/app/routers/freshness.py, docs/HANDOVER.md -1절 실적재 결과]

## Q6. [기술] TourAPI 의존 리스크(쿼터·장애·스펙 변경)는 어떻게 관리하나?

실측으로 확인된 함정도 이미 해결한 이력이 있다 — KorService2의 `searchFestival2`가 구 `areaCode`를 조용히
무시해 0건을 반환하는 문제를 법정동 코드(`lDongRegnCd`/`lDongSignguCd`)로 전환해 해결했다. 키 미설정이나
API 장애 시에는 `source="unavailable"`과 함께 빈 목록을 반환해 프런트가 축제 칩을 자동 숨기는 무해 폴백이
이미 구현되어 있고, 실시간 프록시 호출이 아니라 사전 배치 적재+캐시 구조라 서비스 중 실호출 자체가 적어
쿼터 리스크를 구조적으로 낮춘다. 다만 단일 공공 API 의존은 구조적으로 남아 있어, 교통·유동인구 등 타
공공데이터 결합(A7)으로 다변화하는 것이 다음 단계다.
[뒷받침 근거: docs/HANDOVER.md -1절 KorService2 함정, FestivalBanner source=unavailable 폴백, docs/CONTEST_STRATEGY.md A7]

## Q7. [사업성] 경주에 한정된 것 아닌가? 타 지역 확장은 어떻게 하나?

지역 설정을 `apps/web/lib/region.ts`로 코드화(D2)해 좌표·반경 같은 하드코딩을 제거했고, main·recommend·
FacilityTable이 이미 이 설정을 소비하도록 마이그레이션을 마쳐 "설정값 교체만으로 확장 가능"한 구조를 코드로
증빙한다. TourAPI·SPOT 산식 자체는 지역 비의존적으로 설계돼 있어, 타 지역 확장의 핵심 작업은 신규 지역 POI
재적재(`ingest_tourapi.py` 파라미터 변경)와 혼잡 모델 재학습(`train.py`) 두 단계로 축소된다. 다만
`CongestionMap` 등 일부 컴포넌트는 아직 후속 마이그레이션 대상으로 남아 있어, 완전한 이식에는 잔여 작업이
있다는 점도 밝힌다.
[뒷받침 근거: docs/CONTEST_STRATEGY.md D2, apps/web/lib/region.ts]

## Q8. [사업성] 지자체·소상공인이 실제로 비용을 지불할 유인이 있나?

소상공인 입장에서는 할인율을 올릴수록 SPOT 인센티브 항(w3) 점수가 높아져 추천 노출이 늘어나는 구조가 산식에
내재돼 있어 "제휴 등급 = 노출량"을 정량적으로 제시할 수 있고, 일반 쿠폰 플랫폼과 달리 혼잡 회피 목적의
실수요 방문객을 매칭한다는 차별점이 있다. 지자체 입장에서는 관제 대시보드·수동 혼잡 Override·이상 알림이
이미 동작하는 B2G 도구이며, 경주 APEC 이후 관광 수요 급증이라는 시의성 있는 행정 수요와 맞물린다. 다만
현재는 기능 증빙 단계이고 실제 유료 계약 사례는 없어, 파일럿 지자체 1곳 무료 시범 운영 후 유료 전환을
제안하는 것이 현실적 다음 단계다.
[뒷받침 근거: score.py coupon_term, GET /api/v1/admin/dashboard/today, docs/CONTEST_STRATEGY.md C2/D6]

## Q9. [사회적 가치] 오버투어리즘이 실제로 완화된다는 근거가 있나? 소상공인과는 어떻게 상생하나?

인센티브 항의 절반을 구성하는 재배치기여(`relief_term = 원본혼잡 − 후보 도착시점 예측혼잡`)는 "실제로 덜
붐비는 곳으로 옮겨야" 점수가 오르도록 설계되어, 단순 취향 매칭이 아니라 시스템 관점의 수요 분산이 산식에
명시적으로 내장돼 있다. 소상공인 상생은 쿠폰 제휴(`coupon_rate`)가 인센티브 항의 나머지 절반
(`INCENTIVE_COUPON_SHARE=0.5`)을 차지해, 추천되는 대안이 곧 제휴 소상공인이 되도록 구조화했다. 다만
실사용자 행동 변화(수락률·실제 분산 효과)를 대규모로 실측한 지표는 아직 없어, 관리자 대시보드의 수락률·DAU
지표에 실데이터 비중을 넓히는 작업(E3)을 심사 전 보강 중이다.
[뒷받침 근거: score.py relief_term/INCENTIVE_COUPON_SHARE, docs/CONTEST_STRATEGY.md E3]

## Q10. [개인정보] 로그인 없는 익명 인증으로 개인화가 가능한가? 개인정보는 안전한가?

Supabase 익명 세션으로 기기별 무마찰 자동 로그인을 제공하고, 신규 유저 생성 트리거
(`20260710160000_handle_new_user.sql`)가 이메일·전화번호 같은 식별정보 없이 `public.users` 행만 생성해
추천·코스·쿠폰·제보 같은 개인화 기능이 로그인 UI 없이도 동작한다. 개인화에 쓰이는 것은
`preferred_categories`와 취향 벡터뿐이며, 위치는 매 요청 시 좌표만 사용될 뿐 서버가 이동 이력을 누적해
개인 프로필로 축적하지 않는다. 다만 익명 세션이 기기 로컬 저장 기반이라 기기 변경 시 이력이 끊기는
트레이드오프가 있는데, 이는 "저비용 무마찰 온보딩"과 "영구 개인화" 사이의 의도된 설계 선택이라고 설명한다.
[뒷받침 근거: docs/HANDOVER.md 0절 관광객 인증 완성, supabase/migrations/20260710160000_handle_new_user.sql]
