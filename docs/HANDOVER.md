# 세션 인계 문서 (2026-07-09 기준)

> 다음 작업 세션(사람 또는 AI 에이전트)을 위한 현재 상태 스냅샷 + 즉시 실행 가능한 다음 단계.
> 전략 정본: [`CONTEST_STRATEGY.md`](./CONTEST_STRATEGY.md) · 로드맵: [`IMPROVEMENT_PLAN.md`](./IMPROVEMENT_PLAN.md)

## 1. 현재 상태

**완료된 것 (2026-07-09 세션) — "심사위원 지적 대응 3종":**
- 개입 폐루프: `PATCH /admin/facilities/{id}` 에 coupon_rate 확장 + 대시보드 쿠폰 정책 패널
  (`CouponPolicyPanel` — POI별 슬라이더, 저장 즉시 사용자 추천 w3 반영)
- 분산 효과 정량화: 추천 생성 시 score_breakdown 에 original_wait_time 스냅샷 저장 +
  `GET /admin/impact`(Σ max(0, 원본대기−대안대기), 레거시 행은 relief×15분 근사) + 대시보드
  `ImpactWidget`("오늘 절감 대기시간 N분 · 재배치 M건")
- 예측 백테스트: `train.py --evaluate`(시간순 홀드아웃 20% MAE vs 평균예측 기준선, metrics 를
  model.pkl 내장) + `GET /predict/model-info` + 대시보드 `ModelAccuracyBadge` + `docs/MODEL_CARD.md`
- 검증: pytest 50 · ruff clean · web lint 0 errors · typecheck · vitest 29 · build 전부 통과

**완료된 것 (2026-07-07 하루 작업):**
- 보안 핫픽스(WS-A): RLS 권한상승 차단·anon 노출 제거·admin API 단일 관문·카카오 키 제거 — 마이그레이션 `20260707120000`
- TourAPI 파이프라인(WS-B): `services/tourapi/` 클라이언트 + `ingest_tourapi.py` + 스키마 확장 — **키만 넣으면 실적재 가능**
- SPOT 정렬(WS-C): 가중치 0.40/0.40/0.20, w3 = 0.5·쿠폰강도(coupon_rate/20%캡) + 0.5·재배치기여(원본혼잡−도착시점 예측혼잡)
- CI 3중(web·api·schema) + pytest 43개 + 패리티 테스트(shared-types↔score.py)
- D2: migrations = 정본, RESET 은 `node scripts/build_reset.mjs` 자동 생성(직접 수정 금지)
- Phase 1 심사 대응: Predictive Crowd Map(시간 슬라이더+`/predict/batch`), 마이페이지 취향 레이더, 라우터 통합테스트, 다지역화(`apps/web/lib/region.ts`), README 개편, PWA

**사람이 해야 하는 것 (미완):**
- [ ] **TOURAPI_KEY 발급** (공공데이터포털 → KorService2) → `apps/api/.env` 에 `TOURAPI_KEY=` 입력
- [ ] **마이그레이션 DB 적용**: `supabase db push` (또는 SQL Editor 에서 `20260707120000/130000/140000/150000` 순차 실행) — **적용 전까지 RLS 보안 수정·coupon_rate 미반영**
- [ ] **카카오 REST 키 로테이션** (구 키가 git 이력에 있음 — 카카오 콘솔에서 폐기·재발급)
- [ ] 팀원 공지: pull 후 `.env` 에 `ADMIN_API_TOKEN` 없으면 백엔드 부팅 실패(`.env.example` 참고)

## 2. 다음 작업 큐 (우선순위 순)

### 즉시 (키 불필요)
1. **모델 실평가 1회 실행**: `python apps/api/scripts/train.py --evaluate` (Supabase 로그 필요) —
   실행해야 대시보드 정확도 배지가 '평가 전'에서 실측 MAE 로 바뀐다.
2. Phase 3 데모 완성기 항목(아래) 착수.

### TOURAPI_KEY 수령 즉시 (Phase 2)
- `python apps/api/scripts/ingest_tourapi.py --dry-run` 으로 파싱 확인 → 실적재
- GitHub Actions cron 일배치 동기화(`.github/workflows/` 에 신규 워크플로, TOURAPI_KEY 는 repo secret)
- POI 상세 카드(운영시간·firstimage) → 배리어프리 모드 → 검색바 실구현(searchKeyword) → 행사 혼잡 보정(searchFestival)

### 데모 완성기 (Phase 3) — CONTEST_STRATEGY.md §4 참조
- 진짜 히트맵 레이어 · 온보딩 단일화 · CO₂/ESG 지표 · 카카오맵 비교 자료 · CongestionMap 의 region.ts 이관

## 3. 작업 규칙 (드리프트 방지)

- SPOT 상수 변경 시 **score.py 와 packages/shared-types/spot.ts 둘 다** 수정 (패리티 테스트가 CI 에서 강제)
- 스키마 변경은 migrations/ 에 추가 후 `node scripts/build_reset.mjs` 재실행 (RESET 직접 수정 금지 — CI schema job 이 검증)
- 검증 세트: `pytest apps/api -q`(43+) · `ruff check apps/api` · `npm run lint/typecheck/test/build --workspace=apps/web`
- Windows 로컬 pytest 는 Python 3.11 + `PYTHONUTF8=1` 필요 (시스템 3.14 는 httpx 비호환)
- 데모 안정 우선: PT 2주 전 코드 freeze, 음성비서/온보딩 대규모 리팩터링은 보류 (사용자 결정)

## 4. 결정 이력

| 결정 | 내용 |
|---|---|
| D1 | w3 = 쿠폰강도(0.5) + 재배치기여(0.5) 결합, coupon_rate 연속값 (쿠폰 0/1 은 사용자가 반려) |
| D2 | migrations 단일화, RESET 자동 생성 |
| D3 | 관리자 인증은 데모 수준 유지, 쓰기만 서버 뒤로 |
| D5 | shared-types 승격 (SPOT 상수 공유) |
| WS-D | 보수적(버그성만) — 음성비서 통합·온보딩 단일화는 연기 |
