// 추천 카드 기능의 공개 입구 — 화면은 '~/features/recommendation-card' 만 import 한다.
// 홈(/main)이 RecommendationCard 를 지도 위 아래 스택에, ActiveJourneyCard(위) · VisitCheckCard(아래)를 겹쳐 띄운다.
// 홈·저장 상세의 카드(웹 RecommendationCard 모델, G3-01). 옛 RecommendationSheet(3단 바텀시트)는 H3a 에서 지웠다.
export { RecommendationCard, CardSkeleton, type CardCondition, type RecommendationCardProps } from './RecommendationCard';
export { ActiveJourneyCard, type ActiveJourneyCardProps } from './ActiveJourneyCard';
export { VisitCheckCard, type VisitCheckCardProps } from './VisitCheckCard';
export { CongestionReportButton } from './CongestionReportButton';
export { candidateFromPlace } from './types';
export type { CardFacility, CompareAnchor, SheetCandidate } from './types';
export { markTasteFeedback, type NavigationMode, type NotifyFn } from './actions';
export { recordActiveTrip, getActiveTrip, getDueVisit, getPendingVisit, getVisitHistory, tripEvents, DUE_AFTER_MS } from './tripLoop';
