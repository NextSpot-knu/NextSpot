// 음성 비서가 카드마다 읽는 '가야 할 이유' 한두 문장(계획 B2 · I46, 4개 언어 — I21).
//
// 왜 필요한가: 음성 안내는 "이풍녀 구로쌈밥. 이풍녀 구로쌈밥 추천: 도보 6분 수준입니다. 여기로 안내할까요?" 처럼
// 이름을 두 번 읽고 딱딱한 서버 문장을 읽었다. '다음' 으로 넘어간 카드는 이름만 읽었다. 기능설명서는 비서가
// '장소와 이유' 를 읽는다고 적고 있다. 이제 모든 카드가 같은 재료(카드가 이미 보여 주는 값)로 짧은 이유를 말한다:
//   · 이름은 한 번, '수준입니다' 없이 "걸어서 N분"
//   · 취향 일치율은 카드의 가치 문장과 같은 문턱(50% 이상)일 때만
//   · '대신' 은 카드 첫 줄이 화살표일 때만(chooseCompareHeadline — 지구 기록·덜 붐비지 않는 곳을 '대신' 으로 부르지 않는다)
//   · "지금 여유로운 편이에요" 는 그 장소의 등급이 한산·여유일 때만

import { tasteBenefitPercent } from '../compareHeader';
import type { CongestionKey } from '../congestionScale';

export type VoiceTranslator = (key: string, vars?: Record<string, string | number>) => string;

export interface VoiceReasonInput {
  name: string;
  /** 카드의 '도보 N분' 과 같은 값(displayWalkingMinutes). */
  walkMin: number;
  /** 카드의 취향 일치율(정수 %). 문턱 아래·정수가 아니면 말하지 않는다. */
  preferencePercent?: number | null;
  /** 카드 첫 줄이 화살표 비교일 때의 기준 명소 이름. 아니면 null — '대신' 을 말하지 않는다. */
  insteadOf?: string | null;
  /** 그 장소 자신의 혼잡 등급(실측·추정). 한산·여유일 때만 덧붙인다. */
  crowdGrade?: CongestionKey | null;
}

export function buildVoiceReason(t: VoiceTranslator, input: VoiceReasonInput): string {
  const walk = Math.max(1, Math.round(input.walkMin));
  const pct = tasteBenefitPercent(input.preferencePercent ?? null);
  const anchor = input.insteadOf?.trim() || null;
  const base = anchor
    ? t(pct !== null ? 'voice.reasonInsteadTaste' : 'voice.reasonInstead', { anchor, name: input.name, walk, pct: pct ?? '' })
    : t(pct !== null ? 'voice.reasonWalkTaste' : 'voice.reasonWalk', { name: input.name, walk, pct: pct ?? '' });
  const calm = input.crowdGrade === 'quiet' || input.crowdGrade === 'relaxed';
  return calm ? `${base} ${t('voice.reasonCalm')}` : base;
}

/**
 * 카드 하나를 읽는 문장 = 이유 + '여기로 안내할까요?'. 이유가 이미 이름을 말하면 이름을 다시 붙이지 않는다
 * (서버가 준 문장도 같은 규칙 — 이름을 두 번 읽지 않는다).
 */
export function buildCardSentence(t: VoiceTranslator, name: string, reason: string): string {
  const body = reason.trim();
  if (!body) return t('voice.cardNoReason', { name });
  return body.includes(name) ? `${body} ${t('voice.askGuide')}` : t('voice.card', { name, reason: body });
}
