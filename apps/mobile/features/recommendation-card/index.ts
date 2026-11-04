// 추천 카드 기능의 공개 입구 — 화면은 '~/features/recommendation-card' 만 import 한다.
// 홈(/main)이 RecommendationSheet 를 지도 위에, ActiveJourneyCard · VisitCheckCard 를 그 위·아래에 띄운다(홈 에이전트가 붙인다).
export { RecommendationSheet, type RecommendationSheetProps } from './RecommendationSheet';
export { ActiveJourneyCard, type ActiveJourneyCardProps } from './ActiveJourneyCard';
export { VisitCheckCard, type VisitCheckCardProps } from './VisitCheckCard';
export { CongestionReportButton } from './CongestionReportButton';
export { candidateFromPlace } from './types';
export type { CardFacility, CompareAnchor, SheetCandidate } from './types';
export { markTasteFeedback, type NavigationMode } from './actions';
export { recordActiveTrip, getActiveTrip, getDueVisit, getPendingVisit, getVisitHistory, tripEvents, DUE_AFTER_MS } from './tripLoop';
