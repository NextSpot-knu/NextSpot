export {
  AI_CONSENT_KEY,
  AI_CONSENT_VERSION,
  canSendToAi,
  clearAiConsent,
  getAiConsent,
  getAiConsentStatus,
  promptAiConsent,
  setAiConsent,
  subscribeAiConsent,
  type AiConsentDecision,
  type AiConsentRecord,
  type AiConsentStatus,
} from './aiConsent';
export { AiConsentNotice, AI_SETTINGS_ROUTE } from './AiConsentNotice';
export { useAiConsent, type AiConsentState } from './useAiConsent';
