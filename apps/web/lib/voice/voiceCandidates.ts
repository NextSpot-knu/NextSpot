// 음성 비서의 음식 요청을 🍽 음식 칩과 같은 결과로 만든다(계획 B2 · I09 웹 부분).
//
// 왜 필요한가: 기능설명서 예시 그대로 "양식 먹고 싶어" 라고 하면 음성 비서는 "근처에 확인된 양식 후보가 없어요" 라고
// 답했다. 같은 자리에서 🍕 피자·양식 칩은 10곳을 보여 줬다. 원인은 셋이 겹쳐 있었다:
//   1) 음성 후보는 가까운 30곳만 보냈다(양식집이 그 밖에 있었다).
//   2) 후보의 음식 종류를 cuisine_tags 로만 읽었는데 apiClient 를 거친 시설은 cuisineTags(camelCase)다 — 늘 null.
//   3) 서버의 분류 게이트는 정밀분류(category)가 정확히 같을 때만 통과시켰다.
// 이 모듈은 웹 쪽 두 가지를 고친다: 알아들은 음식 말은 **칩과 똑같은 풀**(cuisineChipPool)로 바로 좁히고, 서버로
// 보내는 후보에는 camelCase 를 읽은 음식 종류를 싣는다(voiceCandidatePayload). 서버 게이트(3)는 API 배포가 필요해
// 심사 뒤로 미뤘다(계획 4.21).
//
// 순수 함수만 둔다 — React · window 를 쓰지 않는다(voiceCandidates.test.ts).

import {
  cuisineIntentTags,
  cuisineMatch,
  facilityCuisineTokens,
  haversineMeters,
  isBarFacility,
  type ScorableFacility,
} from '../recommender';
import { isClosedToday } from '../restDate';

export interface CuisineChip {
  /** i18n 라벨 키 cuisine.{id} */
  id: string;
  /** lib/recommender CUISINE_INTENT_MAP 의 의도 키워드 — 칩과 음성이 같은 매칭(cuisineMatch)을 쓴다. */
  kw: string;
  emoji: string;
  /** 한국어가 아닌 화면에서 이 칩으로 알아들을 말(소문자). 한국어는 kw 의 음식 태그로 맞춘다. */
  aliases: string[];
}

/** /main 의 음식 칩 — 화면 칩과 음성이 같은 목록을 쓴다. */
export const CUISINE_CHIPS: readonly CuisineChip[] = [
  { id: 'korean', kw: '한식', emoji: '🍚', aliases: ['korean food', 'korean', '韓国料理', '韩餐', '韩国菜', '韩国料理'] },
  { id: 'meat', kw: '고기', emoji: '🥩', aliases: ['bbq', 'barbecue', 'meat', 'grill', 'beef', 'pork', '焼肉', '焼き肉', '烤肉', '肉'] },
  { id: 'gukbap', kw: '국밥', emoji: '🍲', aliases: ['gukbap', 'rice soup', 'soup', 'クッパ', 'スープ', '汤饭', '汤'] },
  { id: 'chicken', kw: '치킨', emoji: '🍗', aliases: ['fried chicken', 'chicken', 'チキン', '唐揚げ', '炸鸡'] },
  { id: 'western', kw: '피자', emoji: '🍕', aliases: ['pizza', 'pasta', 'burger', 'steak', 'western', 'ピザ', 'パスタ', '洋食', 'ハンバーガー', 'ステーキ', '披萨', '意面', '西餐', '汉堡', '牛排'] },
  { id: 'chinese', kw: '중식', emoji: '🥟', aliases: ['chinese', '中華', '中華料理', '中餐', '中国菜'] },
  { id: 'japanese', kw: '일식', emoji: '🍣', aliases: ['japanese', 'sushi', 'ramen', '寿司', 'ラーメン', '日本料理', '和食', '日料', '日本菜'] },
  { id: 'bunsik', kw: '분식', emoji: '🍢', aliases: ['street food', 'tteokbokki', 'snack', 'トッポッキ', '軽食', '小吃', '炒年糕'] },
];

/** '양식 말고' 처럼 빼 달라는 말은 칩 지름길을 타지 않는다(서버에 그대로 맡긴다). */
const NEGATION = /(말고|빼고|싫|않|없이)|\b(no|not|without|except|don't|dont)\b|(以外|じゃない|いらない)|(不要|不想|除了|别)/i;

/**
 * 말 한 마디가 가리키는 음식 칩. 알아듣지 못했거나 부정이면 null.
 * 한국어는 lib/recommender 의 음식 태그가 칩 키워드의 태그와 겹치는지로 본다('양식' → 🍕, '갈비' → 🥩).
 * 다른 언어는 칩의 aliases 로 본다. 여러 칩이 맞으면 태그가 가장 많이 겹치는 칩, 같으면 목록 앞.
 */
export function cuisineChipForUtterance(utterance: string | null | undefined): CuisineChip | null {
  const text = String(utterance ?? '').trim().toLowerCase();
  if (!text || NEGATION.test(text)) return null;
  const said = cuisineIntentTags(text);
  let best: { chip: CuisineChip; score: number } | null = null;
  for (const chip of CUISINE_CHIPS) {
    let score = 0;
    if (said.size > 0) {
      for (const tag of cuisineIntentTags(chip.kw)) if (said.has(tag)) score += 1;
    }
    if (score === 0 && chip.aliases.some((alias) => text.includes(alias))) score = 1;
    if (score > 0 && (!best || score > best.score)) best = { chip, score };
  }
  return best?.chip ?? null;
}

/** 칩·음성 풀이 읽는 시설의 최소 모양. */
export interface PoolFacility extends ScorableFacility {
  id: string;
  latitude: number;
  longitude: number;
}

/**
 * 음식 칩 하나의 후보 — 칩을 누를 때와 음성으로 말할 때 **같은 함수**를 쓴다(그래서 둘의 결과가 같다).
 * 0.8 = 태그 정확 일치(0.95)·공식 메뉴(0.9)·상호명(0.85)만 칩 소속으로 본다(같은 한식 대분류의 약한 매칭 0.45 는 아니다).
 * 관심 없음·저장한 곳, 오늘 휴무가 확정된 곳은 뺀다(휴무 판정 불가는 남긴다).
 */
export function cuisineChipPool<T extends PoolFacility>(
  facilities: readonly T[],
  chip: Pick<CuisineChip, 'kw'>,
  excludedIds: ReadonlySet<string>,
  now: Date = new Date(),
): T[] {
  return facilities.filter((f) =>
    f.type === 'restaurant'
    && (cuisineMatch(f, chip.kw) ?? 0) >= 0.8
    && !excludedIds.has(f.id)
    && isClosedToday((f.features?.rest_date_raw ?? f.features?.restDateRaw) as string | null | undefined, now) !== true,
  );
}

export interface VoicePayloadCandidate {
  id: string;
  name: string;
  cuisine: string[] | null;
  category: string | null;
  menu: string | null;
  congestion: number | null;
  distanceM: number;
}

/** 서버(/voice/turn)가 받는 후보 상한. */
export const VOICE_CANDIDATE_LIMIT = 30;

/**
 * /voice/turn 으로 보낼 후보 — 지금 칩 유형에서 술집·관심 없음·저장을 뺀 가까운 순 30곳.
 * priority(음식 칩 풀)가 있으면 그 곳들을 먼저 싣는다 — 가까운 30곳 밖에 있어도 빠지지 않게.
 * cuisine 은 camelCase 태그까지 읽은 값(facilityCuisineTokens), 혼잡은 근거가 없으면 null(0 을 지어내지 않는다).
 */
export function voiceCandidatePayload<T extends PoolFacility>(
  facilities: readonly T[],
  options: {
    type: string;
    origin: { lat: number; lng: number };
    excludedIds: ReadonlySet<string>;
    priority?: readonly T[];
  },
): VoicePayloadCandidate[] {
  const toPayload = (x: T): VoicePayloadCandidate => {
    const features = x.features ?? {};
    const tokens = facilityCuisineTokens(x);
    const menu = [features.first_menu ?? features.firstMenu, features.treat_menu ?? features.treatMenu]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .join(' / ');
    return {
      id: x.id,
      name: String(x.name ?? ''),
      cuisine: tokens.length ? tokens : null,
      category: typeof features.category === 'string' ? features.category : null,
      menu: menu || null,
      congestion: typeof x.congestionLevel === 'number' ? x.congestionLevel : null,
      distanceM: haversineMeters(options.origin.lat, options.origin.lng, x.latitude, x.longitude),
    };
  };
  const eligible = (x: T) => x.type === options.type
    && !(options.type === 'restaurant' && isBarFacility(x))
    && !options.excludedIds.has(x.id);
  const byDistance = (a: VoicePayloadCandidate, b: VoicePayloadCandidate) => a.distanceM - b.distanceM;
  const first = (options.priority ?? []).filter(eligible).map(toPayload).sort(byDistance);
  const seen = new Set(first.map((c) => c.id));
  const rest = facilities.filter((x) => eligible(x) && !seen.has(x.id)).map(toPayload).sort(byDistance);
  return [...first, ...rest].slice(0, VOICE_CANDIDATE_LIMIT);
}
