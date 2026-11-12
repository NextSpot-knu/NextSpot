// 홈 '🔮 혼잡 예측' 띠의 운영 자료원 — 웹 app/main/page.tsx selectForecastHours 의 deps(모델 학습 여부 → /predict/batch →
// 경주 중심 권역 한 시각). 모두 읽기다(/predict/batch 는 POST 지만 쓰지 않는다 — 웹도 같은 조작에서 부른다).
import { REGION } from '@/lib/region';
import { levelFromForecast } from '~/features/waiting/areaCurve';
import { getAreaDemandForecast, isPredictModelTrained, predictBatch } from '~/lib/core/apiClient';

import { sessionAreaDemandAt } from './forecastPoints';
import { predictionsFromBatch, type ForecastDeps } from './forecastStripModel';

export const forecastDeps: ForecastDeps = {
  modelTrained: () => isPredictModelTrained(),
  batch: async (h) => predictionsFromBatch(await predictBatch(h)),
  areaCurve: (h) =>
    sessionAreaDemandAt(h, Date.now(), async (at) => levelFromForecast(await getAreaDemandForecast(REGION.center, at))),
};
