// 추천 카드가 그릴 것을 한 번에 계산한다 — 서버 추천 응답(SheetCandidate) → 화면 모델. 순수 함수(React Native 를 import 하지 않는다).
import { spotPoints } from '../../lib/core/spotPoints';
import { estimateWalkingMinutes } from '../explore/port/walking';
//
// 웹 원본: apps/web/components/RecommendationCard.tsx 본문 앞쪽의 계산(기준 커밋 0d145a1)과 apps/web/app/main/page.tsx 가 카드에 props 로
// 흩어 넘기던 변환(spot · reason · dataSource …). 웹은 렌더 안에 흩어져 있던 것을 앱은 한 함수로 모아 node 테스트로 잠근다.
// 판정(혼잡 표시 · 비교 헤더 · 영업 상태 · 메뉴 · 순위 배지 · 휴무)은 웹 순수 모듈을 그대로 쓰고, 이 파일은 조립만 한다.
// 옮기지 않은 것: 구역 근거(zoneEvidence — 내부 검증 지역 전용) · 가정 시각 배지(M14 v1 제외) · 여행 조건 칩(홈 화면 소관).
import { cardMenu, menuItems, type CardMenu } from '@/lib/cardMenu';
import { cardRankLabel, cardRankText } from '@/lib/cardRank';
import { areaDemandDisclosure } from '@/lib/areaDemandPresentation';
import { congestionKey as gradeKey, DEFAULT_BUSY_THRESHOLD, type CongestionKey } from '@/lib/congestionScale';
import { relativeParts } from '@/lib/freshness';
import { hoursLines } from '@/lib/hoursLines';
import { telHref } from '@/lib/phoneLink';
import { getArrivalOpenDisplayStatus, getArrivalOpenStatus, isClosedToday } from '@/lib/restDate';
import { placeVisual } from '@/lib/placeVisual';

import { cardTimes, displayWalkMinutes, type CardTimes } from './cardTimes';
import {
  candidateAreaCrowdLevel,
  chooseCompareHeadline,
  faceTastePercent,
  resolveAnchorCrowd,
  resolveCandidateCrowd,
  showFaceCrowdChip,
} from './compareHeader';
import { congestionDisplay, formatEstimateTime, formatLastObserved, isBaselinePrediction } from './congestionEstimate';
// 사진 출처 판정은 대안 화면과 같은 port 판 하나를 쓴다(docs/MOBILE_WEB_PARITY.md §4.3 '출처 판정 모듈').
import { creditForDisplayedPhoto, creditedPhotoUrls, merchantPhotoUrl, type PhotoCredit } from '../explore/port/photoCredit';
import type { CompareAnchor, SheetCandidate } from './types';

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Grade = CongestionKey;
export type ChipTone = 'jade' | 'relaxed' | 'quiet' | 'gold' | 'terracotta' | 'neutral';

export interface LiveDetail {
  operatingHours?: { open?: string; closed?: string; [key: string]: unknown } | null;
  overview?: string | null;
  homepage?: string | null;
  imageUrl?: string | null;
  phone?: string | null;
}

export interface AvailabilityLocal {
  status: 'open' | 'closed';
  evidenceTier: 'single_report' | 'corroborated';
  corroboratingCount: number;
  reportedAt: string;
  expiresAt: string;
}

export interface CardContext {
  t: TFn;
  now: Date | null;
  busyAt?: number;
  /** 보이는 목록에서의 순위(1부터). 직접 고른 곳·목록 밖이면 null. */
  listRank: number | null;
  tastePeers?: readonly (number | null | undefined)[];
  anchor?: CompareAnchor | null;
  /** 방금 이 기기에서 남긴 혼잡 제보 — 서버 판정보다 먼저다. */
  localReport?: { level: number; timestamp: string } | null;
  localAvailability?: AvailabilityLocal | null;
  localHoursAnswer?: 'open' | 'closed' | null;
  liveDetail?: LiveDetail | null;
  /** 이 기기에서 숨긴 사진 URL. */
  hiddenPhotos?: readonly string[];
  /** 지금 시각 판정에 쓸 경주 지역 상수(앱 v1 은 경주만). */
  addressToken?: string;
  /** 현재 언어 — 소개 번역(features.overview_i18n)을 고른다. */
  locale?: string;
  /**
   * 비교 첫 줄(가치 상자·음식 문장·미리보기 문장)을 쓸지 — 웹 RecommendationCard 의 showCompare. 홈은 true(기본),
   * 저장 상세처럼 대신할 기준 명소가 없는 화면은 false(G3-12 · G3-R02).
   */
  showCompare?: boolean;
  /** 순위 배지를 목록 순위로 말할지 — 웹 showListRank. 홈 true(기본), 저장 상세 false('AI 추천'). */
  showListRank?: boolean;
}

export interface FaceChip {
  key: string;
  tone: ChipTone;
  text: string;
  dashed?: boolean;
}

export interface CrowdChip {
  grade: Grade;
  text: string;
  dashed: boolean;
}

export interface CardModel {
  id: string;
  title: string;
  type: string;
  rankText: { key: string; vars?: Record<string, number> };
  rankIsListed: boolean;
  times: CardTimes;
  hasSpot: boolean;
  spotScore: number;
  preferencePercent: number | null;
  showArrivalLine: boolean;
  compareKicker: string;
  /** 가치 문장 — 화살표 · 음식 문장이 있으면 그것, 없으면 null(혜택 조각으로 그린다). */
  valueSentence: string | null;
  benefitParts: string[];
  /** 미리보기 가치 문장(이름 뺀 것). */
  peekValueText: string;
  /** 미리보기에 가치 문장을 그리는가 — showCompare 일 때만(웹 peekValueShown). */
  peekValueShown: boolean;
  /** 화살표 비교 문장('A 혼잡 → B 여유'). 없으면 null. */
  compareHeaderText: string | null;
  /** 음식 문장('지금 곱창 먹으러 …'). showCompare 이고 음식점일 때만. */
  foodHeadline: string | null;
  /** 도보 분의 출처 — 실제 걷는 길(osm_pedestrian) · 직선거리 추정. 서버가 안 주면 null. */
  travelSource: 'osm_pedestrian' | 'estimated' | null;
  /** 이름 줄의 근거 칩 — 주변 수요를 질적으로 말할 수 있을 때만(웹 chipArrivalAction). */
  chipArrivalAction: 'choose_calmer' | 'wait_then_go' | null;
  /** 카카오 장소 페이지(검색 링크가 아닌 실제 장소) — 상세의 '상세 리뷰 보기'. */
  reviewUrl: string | null;
  /** 영업 증거 칩 색 — 열림 jade · 닫힘 terracotta. 증거가 없으면 null. */
  availabilityOpen: boolean | null;
  crowdChip: CrowdChip | null;
  crowdChipOnFace: boolean;
  faceChips: FaceChip[];
  displayedOpenStatus: string | undefined;
  likelyClosedUnknown: boolean;
  closedToday: boolean;
  needsHoursConfirmation: boolean;
  faceMenu: CardMenu | null;
  menuTokens: string[];
  reason: string;
  perkText: string | null;
  photoUrls: string[];
  /** 사장님이 올린 가게 사진의 주소(있을 때) — 신고·숨기기는 이 사진에만 붙는다. */
  merchantPhoto: string | null;
  photoIsTourApi: (url: string | undefined) => boolean;
  creditFor: (url: string | undefined) => PhotoCredit | null;
  tileVisual: ReturnType<typeof placeVisual>;
  kakaoPlaceUrl: string | null;
  canLiveRefresh: boolean;
  liveContentId: string | null;
  liveContentTypeId: number | null;
  openHourLines: string[];
  closedDayLines: string[];
  hoursExtra: { close?: string; weekday?: string };
  overview: string | null;
  address: string | null;
  phone: string | null;
  phoneHref: string | null;
  homepageUrl: string | null;
  homepageHost: string | null;
  homepageIsExternalChannel: boolean;
  freshnessStamp: string | null;
  availabilityLine: string | null;
  remaining: { seats: number; total: number } | null;
  licenseLine: string | null;
  area: AreaPanel | null;
  eventLine: string | null;
  displayCongestionLevel: number | null | undefined;
  displayCongestionSource: string | undefined;
  facilityIdForReport: string;
}

export interface AreaPanel {
  title: string;
  mode: string | null;
  action: string | null;
  rank: string | null;
  delayed: string | null;
  compositeHint: boolean;
  parking: { title: string; sub: string } | null;
  tourism: { title: string; sub: string; disclaimer: string } | null;
  sources: string | null;
  confidence: string | null;
}

const GRADE_TONE: Record<Grade, ChipTone> = { busy: 'terracotta', moderate: 'gold', relaxed: 'relaxed', quiet: 'quiet' };
export const crowdTone = (g: Grade): ChipTone => GRADE_TONE[g];

/** 0.75 고정 4단계(실측 칩 · 신선도 칩이 쓰는 웹 기존 규칙). */
const fixedKey = (c: number): Grade => (c >= 0.75 ? 'busy' : c >= 0.5 ? 'moderate' : c >= 0.25 ? 'relaxed' : 'quiet');

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
/** HH:MM(24시간) — 웹 formatTime(toLocaleTimeString ko-KR 24h)과 같은 모양을 로케일 없이. */
export function formatClock(d: Date | null): string {
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function relText(rel: ReturnType<typeof relativeParts>, t: TFn): string | null {
  if (!rel) return null;
  return rel.unit === 'now' ? t('freshness.justNow')
    : rel.unit === 'min' ? t('freshness.minAgo', { n: rel.value })
    : rel.unit === 'hour' ? t('freshness.hourAgo', { n: rel.value })
    : t('freshness.dayAgo', { n: rel.value });
}

export function buildCardModel(c: SheetCandidate, ctx: CardContext): CardModel {
  const { t, now } = ctx;
  const showCompare = ctx.showCompare ?? true;
  const showListRank = ctx.showListRank ?? true;
  const busyAt = ctx.busyAt ?? DEFAULT_BUSY_THRESHOLD;
  const f = c.facility;
  const b = c.breakdown;
  const features = (f.features ?? null) as Record<string, unknown> | null;
  const title = f.name;
  const facilityType = f.type;

  // 서버 breakdown → 카드 숫자(웹 page.tsx 의 spot). 대기는 학습 모델이 잰 값일 때만 보인다.
  const hasSpot = typeof c.spotScore === 'number';
  const spotScore = spotPoints(c.spotScore);
  const preferencePercent = typeof b?.preference === 'number' ? Math.round(b.preference * 100) : null;
  // 서버가 도보 분을 안 준 카드(직접 고른 곳)는 거리로 추정한다 — 웹 recToSpot 과 같은 규칙.
  const expectedTravel =
    typeof b?.travelTime === 'number' ? b.travelTime : typeof c.distanceM === 'number' ? estimateWalkingMinutes(c.distanceM) : undefined;
  const modelWait = c.scoringMode === 'model' && c.congestionSource !== 'none' ? b?.waitTime ?? undefined : undefined;
  const times = cardTimes(expectedTravel, modelWait, now);
  const walk = times.walkMin;
  const waitMins = times.waitMin;
  const arrivalTime = times.arrival;

  // 혼잡 표시 — 판정은 congestionDisplay 한 곳(방금 남긴 로컬 제보가 먼저).
  const localReport = ctx.localReport ?? null;
  const baseLevel = typeof c.congestionLevel === 'number' ? c.congestionLevel : f.congestionLevel;
  const displayLevel = localReport?.level ?? baseLevel;
  const displaySource = localReport ? 'measured' : c.congestionSource;
  const display = congestionDisplay(
    localReport
      ? { congestionLevel: displayLevel, congestionSource: 'measured' }
      : {
          congestionLevel: displayLevel,
          congestionSource: displaySource,
          congestionIsCurrent: c.congestionIsCurrent,
          congestionTimestamp: c.congestionTimestamp ?? null,
          congestionEstimate: c.congestionEstimate,
        },
    now ?? new Date(),
  );
  const estimate = display.estimate;
  const lastObserved = display.lastObserved;
  const shownLevel = display.mode === 'measured' || display.mode === 'predicted' ? display.level : null;
  const baselineLevel = !localReport && display.mode === 'predicted'
    && isBaselinePrediction({ congestionSource: displaySource, scoringMode: c.scoringMode, congestionPredictionBasis: c.congestionPredictionBasis })
    ? shownLevel : null;
  const observedLevel = baselineLevel === null ? shownLevel : null;
  const dataSource = localReport
    ? { source: 'user_report' as string | null, lastUpdated: localReport.timestamp as string | null | undefined, isStale: false }
    : {
        source: c.congestionSource === 'measured' ? c.congestionLogSource ?? 'measured' : c.congestionSource ?? null,
        lastUpdated: c.congestionTimestamp ?? null,
        isStale: c.congestionIsStale ?? false,
      };

  // 영업 상태 — 이 기기의 답 > 두 건 이상 확인 > 서버 판정 > 운영시간 파서.
  const liveHours = ctx.liveDetail?.operatingHours;
  const hours = (liveHours ?? f.operatingHours) as { open?: string; closed?: string; [k: string]: unknown } | null | undefined;
  const availabilityEvidence = ctx.localAvailability ?? f.availabilityEvidence ?? null;
  const localAnswered = ctx.localAvailability?.status ?? ctx.localHoursAnswer ?? undefined;
  const localObserved = localAnswered ? (localAnswered === 'open' ? 'open_expected' : 'closed_confirmed') : undefined;
  const corroborated = availabilityEvidence?.evidenceTier === 'corroborated'
    && availabilityEvidence.corroboratingCount >= 2
    && arrivalTime
    && new Date(availabilityEvidence.expiresAt).getTime() > arrivalTime.getTime()
    ? (availabilityEvidence.status === 'open' ? 'open_expected' : 'closed_confirmed')
    : undefined;
  const parsedOpen = arrivalTime ? getArrivalOpenStatus(hours as never, arrivalTime) : undefined;
  const serverOpen = c.openStatusAtArrival === 'needs_confirmation' && parsedOpen === 'open_expected' ? parsedOpen : c.openStatusAtArrival;
  const resolvedOpen = localObserved ?? corroborated ?? serverOpen ?? parsedOpen;
  const displayedOpenStatus = resolvedOpen && arrivalTime
    ? getArrivalOpenDisplayStatus(resolvedOpen, facilityType, arrivalTime)
    : resolvedOpen;
  const likelyClosedUnknown = displayedOpenStatus === 'likely_closed_unknown';
  const needsHoursConfirmation = resolvedOpen === 'needs_confirmation' && (facilityType === 'cafe' || facilityType === 'restaurant');
  const restRaw = str(features?.restDateRaw ?? features?.rest_date_raw);
  const closedToday = isClosedToday(restRaw) === true;

  // 카카오 장소 링크 — 영업시간을 모르는 음식점·카페면 카카오맵 검색으로(영업 확인용).
  const placeId = String(features?.kakaoPlaceId ?? features?.kakao_place_id ?? '').trim();
  const rawPlaceUrl = str(features?.kakaoPlaceUrl ?? features?.kakao_place_url) ?? (placeId ? `https://place.map.kakao.com/${placeId}` : null);
  const kakaoPlaceUrl = rawPlaceUrl?.replace(/^http:\/\/place\.map\.kakao\.com/i, 'https://place.map.kakao.com')
    ?? (needsHoursConfirmation ? `https://map.kakao.com/?q=${encodeURIComponent(`${title} ${f.address ?? ctx.addressToken ?? '경주'}`)}` : null);

  // 메뉴
  const menuTokens = menuItems(features, 5);
  const faceMenu = cardMenu(facilityType, title, features);

  // 비교 헤더 · 가치 문장
  const demand = areaDemandDisclosure(b?.areaDemandParkingEvidence ?? undefined, b?.areaDemandTourismEvidence ?? undefined);
  const anchorName = ctx.anchor?.name ?? b?.areaDemandTourismEvidence?.referenceName ?? null;
  const anchorDistance = ctx.anchor ? ctx.anchor.distanceM ?? null : b?.areaDemandTourismEvidence?.distanceM ?? null;
  const anchorCrowd = resolveAnchorCrowd({
    estimateLevel: ctx.anchor?.level,
    parkingLevel: b?.areaDemandParkingEvidence?.level,
    tourismRelativeIndex: b?.areaDemandTourismEvidence?.relativeIndex,
    busyAt,
  });
  const candidateCrowdGrade = resolveCandidateCrowd({
    congestionLevel: observedLevel,
    estimateLevel: estimate?.level,
    areaDemandLevel: candidateAreaCrowdLevel({
      areaDemandLevel: b?.areaDemandLevel ?? undefined,
      parking: b?.areaDemandParkingEvidence ?? undefined,
      tourism: b?.areaDemandTourismEvidence ?? undefined,
    }),
    busyAt,
  });
  const headline = chooseCompareHeadline({
    anchorName,
    anchorDistanceM: anchorDistance,
    candidateName: title,
    anchorGrade: anchorCrowd.grade,
    anchorBasis: anchorCrowd.basis,
    candidateGrade: candidateCrowdGrade,
  });
  const tastePct = faceTastePercent(preferencePercent, ctx.tastePeers);
  const compareHeaderText = headline.kind === 'compare' && anchorName && anchorCrowd.grade && candidateCrowdGrade
    ? t('compare.arrowLine', {
        anchor: anchorName,
        anchorCrowd: t(`congestion.${anchorCrowd.grade}`),
        candidate: title,
        walk,
        candidateCrowd: t(`congestion.${candidateCrowdGrade}`),
      })
    : null;
  const isOpenNow = displayedOpenStatus === 'open_expected' && !closedToday;
  // 요리 분류(cuisine)는 카카오가 준 한국어 태그라 영어·일어·중국어 문장 틀에 끼우면 한 문장에 두 언어가 섞인다 — ko 가 아니면
  // 쓰지 않고 compareHeaderText / 혜택 줄(compare.benefitWalk)로 내려간다. 메뉴 이름(kind 'menu')은 데이터 그대로라 유지.
  const cuisineInForeignLocale = faceMenu?.kind === 'cuisine' && !!ctx.locale && ctx.locale !== 'ko';
  const foodName = facilityType === 'restaurant' && !cuisineInForeignLocale ? faceMenu?.items[0] : null;
  const foodHeadline = showCompare && foodName
    ? isOpenNow
      ? waitMins !== null && waitMins > 0
        ? t('compare.foodWithWait', { food: foodName, total: times.totalMin })
        : t('compare.foodNow', { food: foodName, walk })
      : t(faceMenu?.kind === 'menu' ? 'compare.menuWalk' : 'compare.cuisineWalk', { food: foodName, walk })
    : null;
  const compareKicker = foodHeadline && isOpenNow
    ? t('compare.foodKicker')
    : t(headline.kind === 'benefit' && headline.candidateIsAnchor ? 'compare.nearbyKicker' : 'compare.headerKicker');
  const benefitParts = [
    t('compare.benefitWalk', { walk }),
    ...(displayedOpenStatus === 'open_expected' ? [t('compare.benefitOpen')] : []),
    ...(tastePct !== null ? [t('compare.benefitTaste', { pct: tastePct })] : []),
  ];
  const valueSentence = foodHeadline ?? compareHeaderText;
  const peekValueText = valueSentence ?? benefitParts.join(' · ');

  // 사유 — 서버 사유는 한국어 템플릿이라 구조화된 사실로 현재 로케일 문장을 조립한다(웹 page.tsx 와 같다).
  const reason = waitMins !== null
    ? t('recommend.fallbackWithWait', { name: title, walk, wait: waitMins })
    : t('recommend.fallbackTravelOnly', { name: title, walk });
  const insteadReason = waitMins === null && ctx.anchor
    ? t('recommend.reasonInstead', { anchor: ctx.anchor.name, name: title, walk })
    : null;
  const shownReason = headline.kind === 'compare' && insteadReason ? insteadReason : reason;

  // 혼잡 칩
  const areaCrowdGrade = observedLevel === null && !estimate && typeof b?.areaDemandLevel === 'number' ? candidateCrowdGrade : null;
  const reportRel = (() => {
    if (observedLevel === null || dataSource.source !== 'user_report' || dataSource.isStale) return null;
    const p = relativeParts(dataSource.lastUpdated);
    if (!p || p.unit === 'day' || (p.unit === 'hour' && p.value >= 2)) return null;
    return relText(p, t);
  })();
  const seat = f.seatStatusFresh;
  const seatLevel = seat?.level === 'low' || seat?.level === 'mid' || seat?.level === 'full' ? seat.level : null;
  const seatMin = typeof seat?.minutesAgo === 'number' ? seat.minutesAgo : null;
  const ownerSeat = seatLevel && seatMin !== null
    ? {
        grade: ({ low: 'relaxed', mid: 'moderate', full: 'busy' } as const)[seatLevel] as Grade,
        text: t('card.seatByOwner', {
          rel: seatMin < 1 ? t('freshness.justNow') : t('freshness.minAgo', { n: seatMin }),
          label: t({ low: 'card.seatLow', mid: 'card.seatMid', full: 'card.seatFull' }[seatLevel]),
        }),
        dashed: false,
      }
    : null;
  const crowdChip: CrowdChip | null = ownerSeat
    ?? (observedLevel !== null
      ? {
          grade: fixedKey(observedLevel),
          text: reportRel
            ? t('card.crowdByVisitor', { rel: reportRel, label: t(`congestion.${fixedKey(observedLevel)}`) })
            : `${t('card.congestion')}: ${t(`congestion.${fixedKey(observedLevel)}`)}`,
          dashed: false,
        }
      : estimate
        ? { grade: gradeKey(estimate.level, busyAt), text: t('card.estimateLevel', { label: t(`congestion.${gradeKey(estimate.level, busyAt)}`) }), dashed: true }
        : areaCrowdGrade
          ? { grade: areaCrowdGrade, text: `${t('recommend.areaDemandForRanking')}: ${t(`congestion.${areaCrowdGrade}`)}`, dashed: false }
          : baselineLevel !== null
            ? { grade: gradeKey(baselineLevel, busyAt), text: t('card.baselineLevel', { label: t(`congestion.${gradeKey(baselineLevel, busyAt)}`) }), dashed: true }
            : null);
  const measuredNow = !!localReport || display.mode === 'measured';
  const crowdChipOnFace = !!crowdChip && showFaceCrowdChip({
    measuredNow: measuredNow || !!ownerSeat,
    anchorGrade: anchorCrowd.grade,
    anchorBasis: anchorCrowd.basis,
    candidateGrade: candidateCrowdGrade,
    valueLineSaysCrowd: showCompare && foodHeadline === null && compareHeaderText !== null,
  });

  // 혜택 칩(얼굴)
  const timesaleRate = typeof f.timesaleRate === 'number' && f.timesaleRate > 0 ? Math.round(f.timesaleRate * 100) : null;
  const couponRate = typeof f.couponRate === 'number' && f.couponRate > 0 ? Math.round(f.couponRate * 100) : null;
  const faceChips: FaceChip[] = [];
  if (crowdChipOnFace && crowdChip) faceChips.push({ key: 'crowd', tone: crowdTone(crowdChip.grade), text: crowdChip.text, dashed: crowdChip.dashed });
  // 웹 RecommendationCard faceChips 와 같은 조건 — 혜택 문장이 이미 '도착 시 영업'을 말하면 칩으로 되풀이하지 않는다(G3-12).
  if (displayedOpenStatus === 'open_expected' && showCompare && compareHeaderText) faceChips.push({ key: 'open', tone: 'jade', text: t('compare.benefitOpen') });
  if (displayedOpenStatus === 'closing_soon' || likelyClosedUnknown) {
    faceChips.push({ key: 'closing', tone: 'terracotta', text: t(`card.arrivalStatus.${displayedOpenStatus}`) });
  } else if (displayedOpenStatus === 'open_expected' && !showCompare) {
    faceChips.push({ key: 'open', tone: 'jade', text: t('card.arrivalStatus.open_expected') });
  }
  if (closedToday) faceChips.push({ key: 'closed', tone: 'terracotta', text: t('card.closedToday') });
  if (waitMins !== null) faceChips.push({ key: 'wait', tone: 'gold', text: t('card.wait', { n: waitMins }) });
  if (timesaleRate !== null) faceChips.push({ key: 'sale', tone: 'gold', text: t('card.timesale', { rate: timesaleRate }) });
  const perkText = timesaleRate !== null
    ? t('card.timesale', { rate: timesaleRate })
    : couponRate !== null ? t('recommend.spotComparison.coupon', { n: couponRate }) : null;

  // 순위 배지
  // 목록이 없는 화면(저장 상세)은 웹처럼 'AI 추천' — 순위를 주면 그 순위.
  const rank = c.userPicked ? null : ctx.listRank;
  const rankText = showListRank
    ? cardRankText(cardRankLabel(rank))
    : rank ? { key: rank === 1 ? 'card.rankBadgeTop' : 'card.rankBadge', vars: { rank } } : { key: 'card.aiRec' };
  const rankIsListed = typeof rank === 'number' && rank >= 1;

  // 신선도 한 줄
  const freshnessStamp = (() => {
    if (seatMin !== null) return `✅ ${t('card.seatConfirmed', { n: seatMin })}`;
    if (observedLevel !== null && !dataSource.isStale) {
      const rel = relText(relativeParts(dataSource.lastUpdated), t);
      if (rel) return dataSource.source === 'user_report' ? `📣 ${t('card.freshReport', { rel })}` : `🕒 ${t('card.freshLive', { rel })}`;
    }
    if (estimate) return t('card.evidenceEstimated', { time: formatEstimateTime(estimate.observedAt) ?? '—' });
    if (lastObserved) {
      return typeof lastObserved.level === 'number'
        ? t('card.lastObservedLevel', { time: formatLastObserved(lastObserved.observedAt) ?? '—', label: t(`congestion.${fixedKey(lastObserved.level)}`) })
        : t('card.lastObserved', { time: formatLastObserved(lastObserved.observedAt) ?? '—' });
    }
    return null;
  })();

  // 주변 수요 근거 상자
  const area = buildAreaPanel(c, demand, t, (g) => t(`congestion.${fixedKey(g)}`));

  // 가게 정보
  const overviewI18n = (features?.overviewI18n ?? features?.overview_i18n) as Record<string, string> | null | undefined;
  const live = ctx.liveDetail;
  const translatedOverview = ctx.locale && ctx.locale !== 'ko' ? overviewI18n?.[ctx.locale] : undefined;
  const overview = translatedOverview || live?.overview || f.overview || null;
  const homepageSource = live?.homepage ?? f.homepage;
  const homepageUrl = homepageSource ? String(homepageSource).match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null : null;
  const homepageHost = (() => {
    if (!homepageUrl) return null;
    try { return new URL(homepageUrl).hostname; } catch { return homepageUrl; }
  })();
  const phone = live?.phone || f.phone || null;

  // 사진 — 사장님 사진 → 실시간 → 대표 → 갤러리. 숨긴 사진은 뺀다.
  const merchantUrl = merchantPhotoUrl(features);
  const hidden = new Set(ctx.hiddenPhotos ?? []);
  const rawPhotos = Array.from(new Set(
    [merchantUrl, live?.imageUrl, f.imageUrl, ...(f.galleryImages ?? [])]
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0),
  ));
  const photoUrls = creditedPhotoUrls(rawPhotos, features).filter((u) => !hidden.has(u));

  const liveContentId = f.contentid ?? null;
  const liveContentTypeId = typeof f.contenttypeid === 'number' ? f.contenttypeid : null;

  const availability = availabilityEvidence ? relativeParts(availabilityEvidence.reportedAt) : null;
  const availabilityFresh = availability ? (availability.unit === 'now' ? t('freshness.justNow') : t(`freshness.${availability.unit}Ago`, { n: availability.value })) : null;
  const availabilityLine = availabilityEvidence && availabilityFresh
    ? t(availabilityEvidence.evidenceTier === 'corroborated' ? 'card.availabilityCorroborated' : 'card.availabilitySingle', {
        count: availabilityEvidence.corroboratingCount,
        status: t(availabilityEvidence.status === 'open' ? 'card.availabilityStatusOpen' : 'card.availabilityStatusClosed'),
        time: availabilityFresh,
      })
    : null;

  return {
    id: f.id,
    title,
    type: facilityType,
    rankText,
    rankIsListed,
    times,
    hasSpot,
    spotScore,
    preferencePercent,
    showArrivalLine: !!now && !!arrivalTime,
    compareKicker,
    valueSentence,
    benefitParts,
    peekValueText,
    peekValueShown: showCompare && !!peekValueText,
    compareHeaderText,
    foodHeadline,
    travelSource: b?.travelSource === 'osm_pedestrian' || b?.travelSource === 'estimated' ? b.travelSource : null,
    chipArrivalAction: demand.showQualitativeLevel && (b?.arrivalAction === 'choose_calmer' || b?.arrivalAction === 'wait_then_go')
      ? b.arrivalAction : null,
    reviewUrl: rawPlaceUrl?.replace(/^http:\/\/place\.map\.kakao\.com/i, 'https://place.map.kakao.com') ?? null,
    availabilityOpen: availabilityLine && availabilityEvidence ? availabilityEvidence.status === 'open' : null,
    crowdChip,
    crowdChipOnFace,
    faceChips,
    displayedOpenStatus,
    likelyClosedUnknown,
    closedToday,
    needsHoursConfirmation,
    faceMenu,
    menuTokens,
    reason: shownReason,
    perkText,
    photoUrls,
    merchantPhoto: merchantUrl,
    photoIsTourApi: (url) => !!url && !creditForDisplayedPhoto(url, features) && /(^|\.)visitkorea\.or\.kr\//i.test(url.replace(/^https?:\/\//, '')),
    creditFor: (url) => creditForDisplayedPhoto(url, features),
    tileVisual: placeVisual(f.id ?? title, facilityType),
    kakaoPlaceUrl,
    canLiveRefresh: !!liveContentId && liveContentTypeId !== null,
    liveContentId,
    liveContentTypeId,
    openHourLines: typeof hours?.open === 'string' ? hoursLines(hours.open) : [],
    closedDayLines: typeof hours?.closed === 'string' ? hoursLines(hours.closed) : [],
    hoursExtra: { close: str(hours?.close), weekday: str(hours?.weekday) },
    overview,
    address: f.address || null,
    phone,
    phoneHref: telHref(phone),
    homepageUrl,
    homepageHost,
    homepageIsExternalChannel: homepageHost ? /(^|\.)instagram\.com$|(^|\.)blog\.naver\.com$/.test(homepageHost.toLowerCase()) : false,
    freshnessStamp,
    availabilityLine,
    remaining: f.currentCount != null && f.capacity != null && f.capacity > 0
      ? { seats: Math.max(0, f.capacity - f.currentCount), total: f.capacity } : null,
    licenseLine: f.placeDataSource === 'localdata'
      ? t('card.publicLicenseSource', { date: f.dataUpdatedAt ? f.dataUpdatedAt.slice(0, 10) : t('card.sourceDateUnknown') })
      : null,
    area,
    eventLine: (b?.eventBoost ?? 0) > 0
      ? `🎪 ${t('recommend.festivalAdjusted', { title: b?.eventTitle ?? '', pct: Math.round((b?.eventBoost ?? 0) * 100) })}`
      : null,
    displayCongestionLevel: displayLevel,
    displayCongestionSource: displaySource,
    facilityIdForReport: f.id,
  };
}

function buildAreaPanel(
  c: SheetCandidate,
  demand: ReturnType<typeof areaDemandDisclosure>,
  t: TFn,
  label: (level: number) => string,
): AreaPanel | null {
  const b = c.breakdown;
  if (typeof b?.areaDemandLevel !== 'number') return null;
  const parking = b.areaDemandParkingEvidence;
  const tourism = b.areaDemandTourismEvidence;
  const q = demand.showQualitativeLevel;
  const areaRel = b.areaDemandObservedAt ? relativeParts(b.areaDemandObservedAt) : null;
  const areaFresh = relText(areaRel, t);
  const action = b.arrivalAction;
  const title = tourism
    ? t('recommend.areaEvidenceCount', { n: demand.evidenceCount })
    : parking
      ? `${t(parking.mode === 'forecast' ? 'recommend.parkingEvidenceForecast' : 'recommend.parkingEvidenceLive')}: ${label(parking.level)}`
      : `${t('recommend.areaDemand')}: ${label(b.areaDemandLevel)}`;
  const sources = (b.areaDemandSources ?? []).filter((s) => s === 'festival' || s === 'weather').map((s) => t(`recommend.areaSource.${s}`));
  return {
    title,
    mode: q ? t(b.areaDemandMode === 'live' ? 'recommend.areaDemandLive' : b.areaDemandMode === 'forecast' ? 'recommend.areaDemandForecast' : 'recommend.areaDemandStats') : null,
    action: q && action ? t(`recommend.arrivalAction.${action}`, { n: b.recommendedDepartureDelayMinutes ?? 30 }) : null,
    rank: q && b.areaDemandDistinguishable && b.areaDemandRank && b.areaDemandComparableCount
      ? t(b.areaDemandRank === 1 ? 'recommend.areaDemandRankTop' : 'recommend.areaDemandRank', { rank: b.areaDemandRank, total: b.areaDemandComparableCount })
        + (typeof b.areaDemandDeltaVsMedian === 'number' && b.areaDemandDeltaVsMedian <= -0.08
          ? ` · ${t('recommend.areaDemandLower', { n: Math.round(Math.abs(b.areaDemandDeltaVsMedian) * 100) })}` : '')
      : null,
    delayed: q && action === 'wait_then_go' && typeof b.delayedAreaDemandLevel === 'number'
      ? t('recommend.delayedDemand', { n: b.recommendedDepartureDelayMinutes ?? 30, level: label(b.delayedAreaDemandLevel) })
      : null,
    compositeHint: !!tourism,
    parking: parking
      ? {
          title: `${t(parking.mode === 'live' ? 'recommend.parkingEvidenceLive' : 'recommend.parkingEvidenceForecast')}: ${label(parking.level)}`,
          sub: (typeof parking.radiusM === 'number' ? t('recommend.parkingEvidenceRadius', { n: parking.radiusM.toLocaleString() }) : t('recommend.parkingEvidenceArea')) + (areaFresh ? ` · ${areaFresh}` : ''),
        }
      : null,
    tourism: tourism
      ? {
          title: typeof tourism.relativeIndex === 'number'
            ? t('recommend.tourismEvidenceIndex', { n: Math.round(tourism.relativeIndex) })
            : t('recommend.tourismEvidenceTitle'),
          sub: t('recommend.tourismEvidenceBasis', {
            name: tourism.referenceName ?? t('recommend.tourismReferenceUnknown'),
            distance: typeof tourism.distanceM === 'number' ? Math.round(tourism.distanceM).toLocaleString() : '-',
            date: tourism.forecastDate ?? '-',
          }),
          disclaimer: t('recommend.tourismEvidenceDisclaimer'),
        }
      : null,
    sources: sources.length ? sources.join(' · ') : null,
    confidence: b.areaDemandConfidence && b.areaDemandConfidence !== 'none' ? t(`recommend.areaConfidence.${b.areaDemandConfidence}`) : null,
  };
}

/** 카드가 쓰는 '도보 N분' — 외부에서 같은 올림 규칙이 필요할 때. */
export { displayWalkMinutes };
