// 첫 실행(소개 → 위치정보 동의 → 첫 설정) 묶음의 바깥 입구.
// app/_layout.tsx 는 `import { FirstRunGate } from '~/features/onboarding'` 로 Stack 바로 뒤에 붙인다(FirstRunGate.tsx 주석).
export { FirstRunGate, useFirstRunGate, type FirstRunGateState } from './FirstRunGate';
export {
  getFirstRunStep,
  markIntroSeen,
  markSetupSeen,
  nextFirstRunRoute,
  notifyFirstRunChanged,
  subscribeFirstRun,
  type FirstRunStep,
} from './firstRun';
export { GuideProvider } from './GuideProvider';
export { openGuide, openGuideData } from './guideEntry';
export { LocationConsentView } from './LocationConsentView';
