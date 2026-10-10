'use client';

import { useState, useEffect, useId, useRef, useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { motion, PanInfo, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { Bookmark, Check, Sparkles, Star, Phone, MapPin, Clock, ChevronUp, ChevronDown, Globe, Utensils, RefreshCw, X } from 'lucide-react';
import { apiClient, reportFacilityAvailability, type AvailabilityReportResult, type CongestionEstimate } from '@/lib/api-client';
import { CongestionReportButton } from '@/components/CongestionReportButton';
import { GoldenHourBadge } from '@/components/GoldenHourBadge';
import { BenefitChip, crowdTone } from '@/components/main/BenefitChip';
import { relativeParts } from '@/lib/freshness';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { getArrivalOpenDisplayStatus, getArrivalOpenStatus, isClosedToday } from '@/lib/restDate';
import { cardTimes } from '@/lib/cardTimes';
import { telHref } from '@/lib/phoneLink';
import { hoursLines } from '@/lib/hoursLines';
import { isPredictModelTrained } from '@/lib/predictModel';
import { haptic, interactionSpring, sheetSpring, tapMotion } from '@/lib/motion';
import { areaDemandDisclosure } from '@/lib/areaDemandPresentation';
import { useCountUp } from '@/lib/useCountUp';
import { congestionDisplay, formatEstimateTime, formatLastObserved } from '@/lib/congestionEstimate';
import { congestionKey as gradeKey } from '@/lib/congestionScale';
import {
  candidateAreaCrowdLevel,
  chooseCompareHeadline,
  resolveAnchorCrowd,
  resolveCandidateCrowd,
  showFaceCrowdChip,
  faceTastePercent,
} from '@/lib/compareHeader';
import { cardRankLabel, cardRankText } from '@/lib/cardRank';
import { LIVE_FLASH_MS, LIVE_REFRESH_COOLDOWN_MS, refreshedFields, type LiveField } from '@/lib/liveDetailDiff';
import { useBusyThreshold } from '@/components/shell/PublicSettingsProvider';
import { creditedPhotoUrls, creditForDisplayedPhoto } from '@/lib/photoCredit';
import { PhotoCreditLink } from '@/components/PhotoCreditLink';
import { PlacePhotoFallback } from '@/components/PlacePhotoFallback';
import { placeVisual } from '@/lib/placeVisual';
import { isPhoneViewportNow, usePhoneViewport } from '@/lib/usePhoneViewport';

// 이만큼(세로 px) 이상 움직여야 '밀기' 로 보고 뒤따르는 click 을 무시한다. 이보다 작게 흔들린 터치는
// 탭이다 — 브라우저가 click 을 보내면 그대로 받는다(handleDrag 주석 참조).
const SWIPE_GUARD_PX = 12;

// facility prop 이 이 컴포넌트에서 실제로 읽는 필드만 구조적으로 명시한 타입.
// 콜러 둘의 합집합: main(page)은 Facility(congestionLevel/currentCount: number|null,
// features: 인덱스시그니처 unknown)를, saved(page)는 {congestionLevel, capacity, currentCount}
// 요약 리터럴만 전달한다. features 값은 unknown 인덱스라 읽는 곳에서 string 으로 좁힌다.
interface RecommendationCardFacility {
  id?: string;
  name?: string;
  type?: string;
  congestionLevel?: number | null;
  currentCount?: number | null;
  capacity?: number | null;
  features?: Record<string, unknown> | null;
  // 인제스트는 {open, closed} 저장(수동 시드는 weekday 등 다른 키도 존재) — api-client Facility 와 동일 형태.
  operatingHours?: { open?: string; closed?: string; [key: string]: any } | null;
  // TourAPI 상세 필드(A2, 전부 Optional) — 실데이터가 있을 때만 내려온다.
  imageUrl?: string | null;
  // detailImage2 갤러리(최대 5장) — 대표 사진 로드 실패 시 순차 폴백(waiting WaitingCardImage 패턴).
  galleryImages?: string[] | null;
  address?: string | null;
  phone?: string | null;
  homepage?: string | null;
  overview?: string | null;
  // TourAPI 원문 식별자 — '실시간 정보 새로고침'(GET /infrastructures/live-detail/{contentid})용.
  // 둘 다 있는 TourAPI 적재분에만 버튼을 노출한다(수동 시드·저장 목록 리터럴은 없어 미노출).
  contentid?: string | null;
  contenttypeid?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  // 머천트 랭킹 연동 2단계(facility 최상위 필드, features 아님) — keysToCamel 적용 후 형태.
  // 활성 타임세일 할인율(0~0.5), 타임세일이 기본 쿠폰율보다 클 때만 존재.
  timesaleRate?: number | null;
  // 30분 내 사장 좌석 확인(신선도) — 과거 패턴 추정보다 우선하는 실측 신호.
  seatStatusFresh?: { level?: 'low' | 'mid' | 'full'; minutesAgo?: number } | null;
  placeDataSource?: string | null;
  dataUpdatedAt?: string | null;
  availabilityEvidence?: {
    status: 'open' | 'closed';
    evidenceTier: 'single_report' | 'corroborated';
    corroboratingCount: number;
    reportedAt: string;
    expiresAt: string;
  } | null;
}

/** 카드 머리에 둘 '지금 걸린 조건' 칩(계획 B2 9번) — ✕ 로 바로 푼다. */
export interface CardCondition {
  key: 'walk' | 'indoor' | 'barrierFree';
  /** 칩 글자(예: '🚶 도보 10분 이내'). */
  label: string;
  /** 해제 버튼의 접근 이름에 넣을 조건 이름(이모지 없이). */
  name: string;
}

interface RecommendationCardProps {
  title: string;
  matchPercentage?: number;
  reason?: string; // 백엔드 템플릿 생성 추천 사유
  spotComparisonReason?: string; // 실제 SPOT 산식 입력과 1위 대비 차이에서만 만든 설명
  onAccept: () => void;
  onDrive?: () => void;
  onReject: () => void;
  onPutOff?: () => void;
  spotScore?: number;
  preferencePercent?: number;
  /** 함께 보이는 후보들의 취향 일치율 — 모두 같은 숫자면 앞면 · 미리보기에서 말하지 않는다(faceTastePercent). */
  tastePeers?: readonly (number | null | undefined)[];
  expectedWait?: number;
  expectedTravel?: number;
  travelSource?: 'osm_pedestrian' | 'estimated';
  /** 순위 입력(도보 + 혼잡 대기). 화면의 시간 숫자는 보이는 칩의 합으로만 그린다(lib/cardTimes.ts) — 쓰지 않는다. */
  timeToService?: number;
  facilityType?: string;
  facility?: RecommendationCardFacility;
  /**
   * 보이는 추천 목록에서 몇 번째인지(1부터). showListRank 일 때 머리 배지가 이 값으로 말한다(lib/cardRank.ts):
   * 1 베스트 추천 · 2~3 N번째 추천 · 4+ 다음 후보 · 목록 밖(null) 선택한 장소.
   */
  rank?: number | null;
  /** /main: 목록 순위로 배지를 그린다. 저장 목록처럼 목록이 없는 화면은 종전처럼 'AI 추천'. */
  showListRank?: boolean;
  mockHour?: number | null;
  // A4: 행사 혼잡 보정 배지(explore/recommend 와 동일) — 백엔드 breakdown.eventBoost/eventTitle 그대로 전달.
  eventBoost?: number;
  eventTitle?: string;
  areaDemandLevel?: number;
  areaDemandMode?: 'live' | 'forecast' | 'statistical' | 'contextual';
  areaDemandSources?: ('parking' | 'parking_history' | 'tourism' | 'festival' | 'weather')[];
  areaDemandObservedAt?: string;
  areaDemandRadiusM?: number;
  areaDemandParkingEvidence?: {
    level: number;
    mode: 'live' | 'forecast';
    observedAt?: string | null;
    radiusM?: number | null;
  };
  areaDemandTourismEvidence?: {
    referenceName?: string | null;
    distanceM?: number | null;
    forecastDate?: string | null;
    relativeIndex?: number | null;
  };
  areaDemandConfidence?: 'high' | 'medium' | 'low' | 'none';
  areaDemandRank?: number;
  areaDemandComparableCount?: number;
  areaDemandDeltaVsMedian?: number;
  areaDemandDistinguishable?: boolean;
  delayedAreaDemandLevel?: number;
  arrivalAction?: 'go_now' | 'wait_then_go' | 'choose_calmer' | 'no_clear_advantage';
  recommendedDepartureDelayMinutes?: number;
  // 신선도 정직화(계약 5): 혼잡 데이터 출처·나이. user_report→'방문객 제보 · n분 전',
  // 기타 최신→'n분 전 기준', 30분이 지난 관측→'마지막 관측 HH:MM'. 미제공(저장 목록 등)이면 미표시.
  dataSource?: { source: string | null; lastUpdated?: string | null; isStale?: boolean };
  openStatusAtArrival?: 'open_expected' | 'closing_soon' | 'closed_confirmed' | 'needs_confirmation';
  congestionSource?: 'measured' | 'predicted' | 'none';
  // 위 혼잡 값이 '지금' 인지에 대한 **서버 판정**(백엔드 congestion_evidence.evidence_is_current).
  // false 면 이 카드는 추정을 '지금' 으로 칠하고 그 관측을 '마지막 관측 HH:MM' 으로 함께 보여 준다.
  // 카드가 스스로 판정하지 않는 이유는 lib/congestionEstimate.ts 머리말 참조.
  congestionIsCurrent?: boolean | null;
  congestionTimestamp?: string | null;
  scoringMode?: 'model' | 'measured_rules' | 'area_stats_rules' | 'degraded_rules';
  // 추정 모드(주차 실측 + 관광 통계). '지금' 자격이 있는 실측·예측이 없을 때만 '추정' 배지로 그린다
  // (lib/congestionEstimate.ts). facility.congestionLevel 에 넣지 않고 따로 받는 이유가 그 파일 머리말이다.
  congestionEstimate?: CongestionEstimate | null;
  // ── P2 비교 헤더("A 혼잡 → B 한산") ────────────────────────────────────────
  /**
   * 카드 첫 줄(비교 헤더·혜택 문장)을 띄울지. **기준 명소(A)가 있는 화면에서만 켠다.**
   * /main 은 지도에서 고른 명소가 A 라서 "A 대신 B" 가 성립하지만, 저장 목록(/saved)은
   * 사용자가 직접 고른 한 곳을 열어 보는 화면이라 대신할 A 가 없고 주변 수요도 요청하지 않는다.
   */
  showCompare?: boolean;
  /**
   * 💡 사유 문장의 '대신' 판 — "{A} 대신 {B} 어떠세요? 걸어서 N분이에요." 카드 첫 줄이 화살표 비교일 때만
   * reason 대신 쓴다(chooseCompareHeadline 이 고른다). 그래서 지구 기록이나 덜 붐비지 않는 곳을 '대신' 으로
   * 부르지 않고, 첫 줄과 사유가 서로 다른 말을 하지 않는다.
   */
  insteadReason?: string | null;
  // 기준 명소 이름. 미지정이면 areaDemandTourismEvidence.referenceName(= 카드가 이미
  // "…기준 · 후보와 184m" 로 쓰고 있는 그 값)을 쓴다. 테마 칩이 켜지면 그 테마의 대표
  // 랜드마크로 덮어쓴다.
  compareAnchorName?: string | null;
  /**
   * 기준 명소와 이 장소 사이 거리(m). 100m 안쪽이면 같은 자리라 화살표 비교를 하지 않는다.
   * compareAnchorName 을 넘기지 않으면 관광 근거의 distanceM 을 쓴다. 모르면 null.
   */
  compareAnchorDistanceM?: number | null;
  /** 기준 명소 자체의 혼잡 추정(0~1). 있으면 등급 문구의 1순위 근거가 된다. */
  compareAnchorLevel?: number | null;
  /** '가정 시각' 프리셋 라벨(예: '토 14:00'). 지금(실시간)이면 넘기지 않는다. */
  assumedTimeLabel?: string | null;
  /** 상자 안 '🕒 …' 알약의 글 전체(예: '+2시간 후 기준'). 없으면 assume.basisBadge(라벨 + '기준'). */
  assumedTimeBadge?: string | null;
  /**
   * 가정 시각(+N시간 · 요일 프리셋)에서 이 장소의 예측 혼잡도(0~1) — 지도 순위 핀이 같은 시각에 칠한 값과 같다.
   * 시각이 '지금' 이 아니면 부모는 지금 값(실측 '지금' · 추정 피드)을 넘기지 않고, 카드는 이 값으로 등급을 말한다
   * (핀은 '여유' 인데 카드는 지금의 '한산' 을 말하던 모순 — 리뷰 10-07). 없으면 등급을 지어내지 않는다.
   */
  forecastLevel?: number | null;
  /** 테마 칩 맥락 배지 문구(예: '신라 핵심 산책 기준 대안'). */
  contextBadge?: string | null;
  /**
   * 휴대폰(<768px)에서 카드를 **짧은 미리보기**로 연다 — 이름 · 도보 N분 · 혼잡 배지 · 도보 길안내.
   * 지도 위에 떠 있는 /main 카드만 켠다. 태블릿·데스크톱에서는 아무 영향이 없다.
   */
  mobilePeek?: boolean;
  /** 지금 걸린 여행 조건 칩(도보 N분 이내 · 실내 · 무장애) — 카드 머리에 ✕ 와 함께. */
  conditions?: CardCondition[];
  onRemoveCondition?: (key: CardCondition['key']) => void;
  /** 휴대폰: 카드 오른쪽 위에 둘 음성 비서 알약(미리보기·펼침 모두). 데스크톱은 부모가 카드 위 칸에 둔다. */
  voiceSlot?: ReactNode;
  /** 값이 바뀔 때마다 휴대폰 카드를 미리보기로 접는다(음성 비서를 켰을 때 — 자막이 지도를 가리지 않게). */
  peekRequest?: number;
  /** 데스크톱(md+)에서 카드가 오른쪽 열의 높이를 채운다(/main 패널). 푸터는 열 바닥에 붙고 안쪽만 스크롤한다. */
  desktopFill?: boolean;
  /** 휴대폰 미리보기(true) ↔ 펼친 카드(false)가 바뀔 때 — /main 은 펼친 동안 혼잡 예측 줄을 감춘다(계획 B3). */
  onPeekChange?: (peek: boolean) => void;
}

export function RecommendationCard({
  title,
  matchPercentage,
  reason,
  spotComparisonReason,
  onAccept,
  onDrive,
  onReject,
  onPutOff,
  spotScore,
  preferencePercent,
  tastePeers,
  expectedWait,
  expectedTravel,
  travelSource,
  facilityType,
  facility,
  rank,
  showListRank = false,
  mockHour,
  eventBoost,
  eventTitle,
  areaDemandLevel,
  areaDemandMode,
  areaDemandSources,
  areaDemandObservedAt,
  areaDemandParkingEvidence,
  areaDemandTourismEvidence,
  areaDemandConfidence,
  areaDemandRank,
  areaDemandComparableCount,
  areaDemandDeltaVsMedian,
  areaDemandDistinguishable,
  delayedAreaDemandLevel,
  arrivalAction,
  recommendedDepartureDelayMinutes,
  dataSource,
  openStatusAtArrival,
  congestionSource,
  congestionIsCurrent,
  congestionTimestamp,
  congestionEstimate,
  showCompare = false,
  insteadReason,
  compareAnchorName,
  compareAnchorDistanceM,
  compareAnchorLevel,
  assumedTimeLabel,
  assumedTimeBadge,
  forecastLevel,
  contextBadge,
  mobilePeek = false,
  conditions = [],
  onRemoveCondition,
  voiceSlot,
  peekRequest,
  desktopFill = false,
  onPeekChange,
}: RecommendationCardProps) {
  const { t, locale } = useI18n();
  // 운영자 '혼잡' 경계. 지금은 **새 추정 배지만** 이 값을 따른다 — 지도 점선 핀·코스 칩이 이미
  // congestionKey(level, busyAt) 로 칠하므로, 같은 추정이 지도에서는 '혼잡' 인데 카드에서는 '보통' 이면
  // 한 화면이 두 말을 한다. 기존 실측 배지(아래 congestionKey 0.75 고정)는 이 변경 범위 밖이다.
  const busyAt = useBusyThreshold();
  // 상세 패널의 id — 펼치기 버튼의 aria-controls 가 가리킨다. 한 화면에 카드가 둘 이상
  // 뜨는 경로(저장 목록)가 있어 고정 문자열을 쓸 수 없고, useId 는 SSR/CSR 이 같은 값을 낸다.
  const baseId = useId();
  const detailsPanelId = `rec-card-details-${baseId}`;
  const spotInfoId = `rec-card-spot-${baseId}`;
  const whyPanelId = `rec-card-why-${baseId}`;
  const [isExpanded, setIsExpanded] = useState(false);
  // '추천 근거 자세히'(계획 B2) — 상세를 열어도 닫힌 채로 시작한다. 순위 근거·근거 원자료는 여기 안에만.
  const [whyOpen, setWhyOpen] = useState(false);
  // 휴대폰 미리보기(mobilePeek) — 기존 '최소화' 상태를 그대로 쓰되, 휴대폰에서는 그 모습을 짧은
  // 미리보기 줄로 그리고 **새 추천은 이 상태로 연다.** 카드가 톱바(검색·✨·칩·필터·편의)를 덮지 않게
  // 하기 위해서다(PM 2026-09-26). 첫 렌더부터 미리보기여야 전체 카드가 잠깐 떴다 접히는 깜빡임이 없다.
  const isPhone = usePhoneViewport();
  const peekMode = mobilePeek && isPhone;
  const [isMinimized, setIsMinimized] = useState(() => mobilePeek && isPhoneViewportNow());
  // 부모에 미리보기 여부를 알린다 — 휴대폰이 아니면(미리보기가 없으면) 언제나 false.
  const peekShown = peekMode && isMinimized;
  useEffect(() => { onPeekChange?.(peekShown); }, [peekShown, onPeekChange]);
  // 미리보기에서 위로 끌어 올린 손가락이 '도보 길안내' 위에서 떨어져도 길안내가 시작되지 않게,
  // 방금 끝난 **밀기** 뒤의 click 한 번은 무시한다(마우스 드래그는 click 을 그대로 발생시킨다).
  // 밀기로 보는 기준은 SWIPE_GUARD_PX 이상 움직였을 때다 — 아래 handleDrag 주석 참조.
  const justDraggedRef = useRef(false);
  const hoursPromptRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [confirmedAction, setConfirmedAction] = useState<'saved' | 'accepted' | null>(null);
  // SPOT 점수 설명 — 배지 전체가 버튼이고, 카드 흐름 안에 상자로 열린다(절대 위치 말풍선이 아니다 — I51).
  const [spotOpen, setSpotOpen] = useState(false);
  const [localReport, setLocalReport] = useState<{ level: number; timestamp: string } | null>(null);
  const [hoursPromptOpen, setHoursPromptOpen] = useState(false);
  const [hoursSubmitting, setHoursSubmitting] = useState(false);
  const [hoursSubmitError, setHoursSubmitError] = useState(false);
  const [localAvailability, setLocalAvailability] = useState<AvailabilityReportResult | null>(null);
  // '실시간 정보 새로고침'(TourAPI live-detail) 결과 — 캐시된 표시값 위에 덧씌운다(비면 캐시값 유지).
  const [liveDetail, setLiveDetail] = useState<{
    operatingHours?: RecommendationCardFacility['operatingHours'];
    overview?: string | null;
    homepage?: string | null;
    imageUrl?: string | null;
    phone?: string | null;
  } | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  // 성공 시각('방금 갱신 · 12:15') · 반짝일 줄 · 잠금(연달아 누르지 않게).
  const [liveRefreshedAt, setLiveRefreshedAt] = useState<Date | null>(null);
  const [flashFields, setFlashFields] = useState<LiveField[]>([]);
  const [liveCooldown, setLiveCooldown] = useState(false);
  const liveTimersRef = useRef<number[]>([]);
  // 스크롤 영역의 위·아래 가장자리 흐림(데스크톱 패널) — 더 있는 내용이 있음을 보여 준다.
  const [scrollEdges, setScrollEdges] = useState({ up: false, down: false });

  // '최적 방문 시각' — 펼쳤을 때 백엔드(/predict/day)에서 받아오는 오늘 24시간 예측 혼잡 곡선.
  // 백엔드 미기동/실패 시 null 로 남아 조용히 숨긴다(카드 나머지는 그대로).
  const [dayPred, setDayPred] = useState<{
    hours: { hour: number; congestion: number }[];
    bestHour: number;
    bestCongestion: number;
  } | null>(null);

  // 살아 있는 수치 연출 — SPOT 점수·취향 일치율이 0에서 실제 값으로 짧게 굴러 올라간다.
  // 정직성: 목표는 이미 props 로 받은 실제 값 그대로이고(반올림 규칙도 기존과 동일),
  // 값이 없으면 NaN 을 넘겨 훅이 아무것도 하지 않는다. 감속 모션 선호 시 즉시 최종값.
  // rollOnChange:false — 서버가 같은 장소를 확인해 숫자만 고칠 때 다시 굴리지 않는다(계획 B2 · I34).
  const animatedSpotScore = useCountUp(
    spotScore !== undefined ? Math.round(spotScore || 0) : Number.NaN,
    { rollOnChange: false },
  );
  const animatedPreference = useCountUp(
    typeof preferencePercent === 'number' && Number.isInteger(preferencePercent)
      ? preferencePercent
      : Number.NaN,
    { rollOnChange: false },
  );

  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  useEffect(() => {
    setIsExpanded(false);
    setWhyOpen(false);
    setSpotOpen(false);
    setConfirmedAction(null);
    setLocalReport(null);
    setHoursPromptOpen(false);
    setHoursSubmitError(false);
    setLocalAvailability(null);
    // 다른 장소로 바뀌면 이전 장소의 '최적 방문 시각' 데이터가 남아 깜빡이지 않게 초기화
    setDayPred(null);
    // 이전 장소의 실시간 조회 결과가 새 장소에 덧씌워지지 않게 초기화
    setLiveDetail(null);
    setLiveLoading(false);
    setLiveRefreshedAt(null);
    setFlashFields([]);
    setLiveCooldown(false);
    liveTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    liveTimersRef.current = [];
    scrollRef.current?.scrollTo({ top: 0 });
  }, [title]);
  useEffect(() => () => { liveTimersRef.current.forEach((timer) => window.clearTimeout(timer)); }, []);
  // 휴대폰에서 영업 확인 질문이 뜨면 카드 안 스크롤 맨 아래(액션 버튼 바로 위)에 있어 보이지 않을 수
  // 있다 — 질문을 화면 안으로 끌어온다. 태블릿·데스크톱은 종전 그대로(스크롤하지 않는다).
  useEffect(() => {
    if (!peekMode || isMinimized || !hoursPromptOpen) return;
    hoursPromptRef.current?.scrollIntoView({ block: 'nearest' });
  }, [peekMode, isMinimized, hoursPromptOpen]);
  // 새 추천(title 변경)은 휴대폰이면 미리보기로, 그 밖에는 종전처럼 펼친 카드로 연다.
  // 폭이 md 경계를 넘나들면(가로 회전 등) 그 폭의 기본 모습으로 돌아간다.
  // (effect 가 아니라 렌더 중 조정 — 한 프레임이라도 이전 모습이 그려지지 않게.)
  const minimizeResetKey = `${title}|${peekMode ? 'peek' : 'full'}`;
  const [lastMinimizeResetKey, setLastMinimizeResetKey] = useState(minimizeResetKey);
  if (lastMinimizeResetKey !== minimizeResetKey) {
    setLastMinimizeResetKey(minimizeResetKey);
    setIsMinimized(peekMode);
  }
  // 부모가 '미리보기로 접어 달라' 고 할 때(음성 비서 시작) — 휴대폰에서만.
  const [lastPeekRequest, setLastPeekRequest] = useState(peekRequest);
  if (lastPeekRequest !== peekRequest) {
    setLastPeekRequest(peekRequest);
    if (peekMode) {
      setIsExpanded(false);
      setIsMinimized(true);
    }
  }

  const displayCongestionLevel = localReport?.level ?? facility?.congestionLevel;
  const displayCongestionSource = localReport ? 'measured' : congestionSource;
  // 무엇을 '지금' 으로 칠할지 — 판정은 lib/congestionEstimate.ts 한 곳에서만 한다.
  //
  // 사용자가 방금 남긴 로컬 제보는 무조건 이긴다(본인이 눈으로 본 값이고, 서버 판정이 붙기 전이다).
  // 그 밖에는 서버가 내려준 congestionIsCurrent 를 그대로 따른다: true/미제공이면 종전처럼 실측·
  // 예측이 추정을 덮고, false(30분이 지난·단건 관측)면 신선한 추정이 '지금' 자리를 가져가고 그
  // 관측은 아래 '마지막 관측 HH:MM' 으로 남는다 — 24시간 안쪽일 때만(lib/congestionEstimate.ts).
  // 관측 시각은 혼잡 관측 시각만 쓴다. 시설 기록의 갱신 시각(dataUpdatedAt 등)은 혼잡을 본 때가 아니다.
  const display = congestionDisplay(
    localReport
      ? { congestionLevel: displayCongestionLevel, congestionSource: 'measured' }
      : {
          congestionLevel: displayCongestionLevel,
          congestionSource: displayCongestionSource,
          congestionIsCurrent,
          congestionTimestamp: congestionTimestamp ?? null,
          congestionEstimate,
        },
  );
  const estimate = display.estimate;
  const lastObserved = display.lastObserved;
  // 실제로 '지금' 칸에 칠할 실측·예측 숫자. 추정이 자리를 가져간 경우 여기는 null 이다
  // (그래도 그 관측은 lastObserved 로 남아 화면에서 사라지지 않는다).
  const shownCongestionLevel =
    display.mode === 'measured' || display.mode === 'predicted' ? display.level : null;
  const displayDataSource = localReport
    ? { source: 'user_report', lastUpdated: localReport.timestamp, isStale: false }
    : dataSource;

  useEffect(() => {
    if (mockHour !== undefined && mockHour !== null) {
      const d = new Date();
      d.setHours(Math.floor(mockHour), (mockHour % 1) * 60, 0, 0);
      setCurrentTime(d);
      return;
    }
    setCurrentTime(new Date());
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(interval);
  }, [mockHour]);

  const [placeInfo, setPlaceInfo] = useState<{
    address?: string;
    phone?: string;
    rating?: number;
    reviewCount?: number;
    url?: string;
  } | null>(null);

  // Load place details from Kakao Places API
  useEffect(() => {
    if (!title || typeof window === 'undefined' || !window.kakao || !window.kakao.maps) return;
    let active = true;
    setPlaceInfo(null);

    // 실제 시설 데이터에 있는 값만 노출한다. 별점/리뷰/전화/주소/영업시간을 절대 지어내지 않는다.
    // 카카오 keywordSearch 는 별점·리뷰수를 제공하지 않으므로 rating/reviewCount 는 설정하지 않는다.

    // Check if services library is loaded
    if (!window.kakao.maps.services) {
      console.warn("Kakao Places services library not loaded");
      setPlaceInfo({
        address: facility?.address || undefined,
        phone: facility?.phone || undefined,
        url: (facility?.features?.kakaoPlaceUrl || facility?.features?.kakao_place_url) as string | undefined,
      });
      return;
    }

    try {
      const ps = new window.kakao.maps.services.Places();
      const expectedPlaceId = String(
        facility?.features?.kakaoPlaceId || facility?.features?.kakao_place_id || ''
      );
      const options = typeof facility?.latitude === 'number' && typeof facility?.longitude === 'number'
        ? {
            location: new window.kakao.maps.LatLng(facility.latitude, facility.longitude),
            radius: 1000,
            sort: window.kakao.maps.services.SortBy.DISTANCE,
          }
        : undefined;
      ps.keywordSearch(title, (data: any, status: any) => {
        if (!active) return;
        const normalizedTitle = title.replace(/\s+/g, '').toLowerCase();
        const candidates = status === window.kakao.maps.services.Status.OK && Array.isArray(data)
          ? data.filter((p: any) => {
              const address = p.road_address_name || p.address_name || '';
              const normalizedName = String(p.place_name || '').replace(/\s+/g, '').toLowerCase();
              const sameIdentity = expectedPlaceId
                ? String(p.id || '') === expectedPlaceId
                : normalizedName === normalizedTitle;
              const closeEnough = p.distance !== undefined && Number(p.distance) <= 150;
              return address.includes('경주') && sameIdentity && closeEnough;
            })
          : [];
        const place = candidates[0] || null;
        if (place) {
          setPlaceInfo({
            address: place.road_address_name || place.address_name || facility?.address || undefined,
            phone: place.phone || facility?.phone || undefined,
            url: place.place_url
          });
        } else {
          // 이름·ID·500m 조건 중 하나라도 어긋나면 다른 지점 정보를 붙이지 않는다.
          setPlaceInfo({
            address: facility?.address || undefined,
            phone: facility?.phone || undefined,
            url: (facility?.features?.kakaoPlaceUrl || facility?.features?.kakao_place_url) as string | undefined,
          });
        }
      }, options);
    } catch (e) {
      console.error("Kakao Places API search error:", e);
    }
    return () => { active = false; };
  }, [title, facility]);

  // 펼쳐졌을 때만 '최적 방문 시각'(오늘 24시간 예측)을 지연 로드한다 — 접힌 카드까지 백엔드를 때리지 않게.
  // 예측 모델이 학습돼 있을 때만 부른다(세션당 한 번 묻는다, lib/predictModel.ts) — 미학습이면 /predict/day 는
  // 언제나 503 이라, 펼칠 때마다 실패 요청만 쌓였다.
  const dayFacilityType = facilityType || facility?.type;
  useEffect(() => {
    if (!isExpanded || !dayFacilityType) return;
    let active = true;
    isPredictModelTrained()
      .then((trained) => {
        if (!trained || !active) return null;
        return apiClient.get(`/predict/day?facilityType=${encodeURIComponent(dayFacilityType)}`);
      })
      .then((res) => {
        // 24개 시간 값이 온전할 때만 반영(방어적) — 아니면 조용히 숨김 유지
        if (active && res?.hours?.length === 24) setDayPred(res);
      })
      .catch(() => {
        // 백엔드 미기동/네트워크 실패 — 막대를 그리지 않고 조용히 숨긴다(카드 나머지는 영향 없음)
        if (active) setDayPred(null);
      });
    return () => {
      active = false;
    };
  }, [isExpanded, dayFacilityType]);

  // 스크롤 영역 가장자리 흐림 — 위·아래로 더 볼 내용이 있는지.
  const updateScrollEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const up = el.scrollTop > 2;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setScrollEdges((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    updateScrollEdges();
    const observer = new ResizeObserver(updateScrollEdges);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [updateScrollEdges, isMinimized, isExpanded, whyOpen, spotOpen]);

  // Framer Motion Drag Handler
  const handleDragEnd = (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const offset = info.offset.y;
    const velocity = info.velocity.y;

    if (isExpanded) {
      if (offset > 50 || velocity > 200) {
        setIsExpanded(false);
      }
    } else if (isMinimized) {
      if (offset < -50 || velocity < -200) {
        setIsMinimized(false);
      }
    } else {
      if (offset > 50 || velocity > 200) {
        setIsMinimized(true);
      } else if (offset < -50 || velocity < -200) {
        setIsExpanded(true);
      }
    }
  };

  // 손으로 '상세 정보 펼치기' 를 누르면 펼친 상세로 스크롤한다 — 예전에는 버튼 글자만 '접기' 로 바뀌고 새 내용은
  // 보이는 영역 밖에 생겨 아무 일도 없어 보였다(I31).
  const toggleExpand = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    if (next) {
      window.setTimeout(() => {
        const scroller = scrollRef.current;
        const details = detailsRef.current;
        if (!scroller || !details) return;
        const top = details.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
        scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }, 80);
    }
  };

  // 실시간 정보 새로고침이 상세를 열면, 새로 받은 줄(운영시간 · 소개 · 전화 · 홈페이지) 중 첫 줄을 보이는 영역으로
  // 끌어온다 — 키 낮은 노트북(1366×650)에서는 반짝이는 줄이 스크롤 아래에 있어 사진만 반짝이는 것처럼 보였다(리뷰 10-07).
  // 펼침 애니메이션이 끝나야 스크롤 높이가 다 생기므로 한 번 더 맞춘다. 이름 막대(sticky)에 가리지 않게 그 높이만큼 띄운다.
  const revealRefreshedRow = () => {
    const align = () => {
      const scroller = scrollRef.current;
      const row = detailsRef.current?.querySelector<HTMLElement>('[data-refreshed="true"]');
      if (!scroller || !row) return;
      const bar = detailsRef.current?.querySelector<HTMLElement>('[data-testid="details-name-bar"]');
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - (bar?.offsetHeight ?? 0) - 8;
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    };
    liveTimersRef.current.push(window.setTimeout(align, 120), window.setTimeout(align, 450));
  };

  // 카드 안에서 새로 연 상자(SPOT 설명 · 추천 근거)를 보이는 영역으로 — 아래에 열려 보이지 않으면 눌러도 아무 일 없어 보인다.
  const revealInScroller = (id: string, block: 'nearest' | 'start') => {
    window.setTimeout(() => {
      const scroller = scrollRef.current;
      const target = document.getElementById(id);
      if (!scroller || !target) return;
      const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const bottom = top + target.getBoundingClientRect().height;
      if (block === 'start' || bottom > scroller.clientHeight) {
        const offset = block === 'start' ? top - 8 : bottom - scroller.clientHeight + 8;
        scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + offset), behavior: 'smooth' });
      }
    }, 60);
  };

  // framer-motion 은 3px 만 움직여도 드래그를 시작하지만, 브라우저는 그보다 훨씬 많이 흔들린 터치도
  // 탭(click)으로 인정한다. 드래그 시작만으로 click 을 막으면 손가락이 조금 흔들린 탭 — 휴대폰에서
  // 흔한 탭 — 에 '도보 길안내'·미리보기 줄이 아무 반응을 하지 않는다. 그래서 정말 **민** 경우
  // (세로로 SWIPE_GUARD_PX 이상)만 막는다. onDrag 는 손가락을 떼기 전에 불리므로 뒤따르는
  // click 보다 먼저 표시가 선다. 해제는 종전처럼 드래그가 끝난 뒤(handleDragEndWithClickGuard)다.
  const handleDrag = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (Math.abs(info.offset.y) >= SWIPE_GUARD_PX) justDraggedRef.current = true;
  };
  const handleDragEndWithClickGuard = (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    handleDragEnd(event, info);
    window.setTimeout(() => { justDraggedRef.current = false; }, 0);
  };
  // 미리보기 → 전체 카드. 드래그 직후의 click 은 무시한다(위 justDraggedRef 참조).
  const openFromPeek = () => {
    if (justDraggedRef.current) return;
    setIsMinimized(false);
  };

  const hasSpotMetrics = spotScore !== undefined;

  // 큰 숫자 · 칩 · 출발→도착 타임라인이 같은 분을 쓴다(lib/cardTimes.ts) — 큰 숫자는 언제나 보이는 칩의 합이고,
  // 도착 시각은 출발 + 도보 칩 분이다. timeToService 는 순위 입력일 뿐 화면에는 쓰지 않는다.
  const times = cardTimes(expectedTravel, expectedWait, currentTime);
  const displayedTravelMins = times.walkMin;
  const waitMins = times.waitMin;
  const arrivalTime = times.arrival;
  const availabilityEvidence = localAvailability ?? facility?.availabilityEvidence;
  const localObservedStatus = localAvailability
    ? (localAvailability.status === 'open' ? 'open_expected' : 'closed_confirmed')
    : undefined;
  const corroboratedStatus = availabilityEvidence?.evidenceTier === 'corroborated'
    && availabilityEvidence.corroboratingCount >= 2
    && arrivalTime
    && new Date(availabilityEvidence.expiresAt).getTime() > arrivalTime.getTime()
    ? (availabilityEvidence.status === 'open' ? 'open_expected' : 'closed_confirmed')
    : undefined;
  const parsedOpenStatus = arrivalTime ? getArrivalOpenStatus(facility?.operatingHours, arrivalTime) : undefined;
  // 서버가 '미확인' 이라고 한 곳도 웹 파서가 운영시간 문구('상시 개방' · '~24:00')를 읽어 냈으면 그 판정을 쓴다 —
  // 서버 쪽 같은 파서 보강은 순위를 바꾸므로 심사 뒤로 미뤘다(계획 4.21). 화면의 영업 표시만 바로잡는다.
  const serverOpenStatus = openStatusAtArrival === 'needs_confirmation' && parsedOpenStatus === 'open_expected'
    ? parsedOpenStatus
    : openStatusAtArrival;
  const resolvedOpenStatus = localObservedStatus ?? corroboratedStatus ?? serverOpenStatus ?? parsedOpenStatus;
  const displayedOpenStatus = resolvedOpenStatus && arrivalTime
    ? getArrivalOpenDisplayStatus(resolvedOpenStatus, facilityType, arrivalTime)
    : resolvedOpenStatus;
  const likelyClosedUnknown = displayedOpenStatus === 'likely_closed_unknown';
  const availabilityFreshnessParts = relativeParts(availabilityEvidence?.reportedAt);
  const availabilityFreshness = !availabilityFreshnessParts
    ? null
    : availabilityFreshnessParts.unit === 'now'
      ? t('freshness.justNow')
      : t(`freshness.${availabilityFreshnessParts.unit}Ago`, {
          n: availabilityFreshnessParts.value,
        });
  const needsHoursConfirmation = resolvedOpenStatus === 'needs_confirmation'
    && (facilityType === 'cafe' || facilityType === 'restaurant');
  const storedKakaoPlaceId = String(
    facility?.features?.kakaoPlaceId || facility?.features?.kakao_place_id || '',
  ).trim();
  const rawKakaoPlaceUrl = placeInfo?.url
    || (facility?.features?.kakaoPlaceUrl || facility?.features?.kakao_place_url) as string | undefined
    || (storedKakaoPlaceId ? `https://place.map.kakao.com/${storedKakaoPlaceId}` : null);
  const kakaoPlaceUrl = rawKakaoPlaceUrl?.replace(
    /^http:\/\/place\.map\.kakao\.com/i,
    'https://place.map.kakao.com',
  ) ?? (needsHoursConfirmation
    ? `https://map.kakao.com/?q=${encodeURIComponent(`${title} ${facility?.address ?? '경주'}`)}`
    : null);

  const submitHoursStatus = async (status: 'open' | 'closed') => {
    if (!facility?.id || hoursSubmitting) return;
    setHoursSubmitting(true);
    setHoursSubmitError(false);
    try {
      const result = await reportFacilityAvailability(facility.id, status);
      setLocalAvailability(result);
      setHoursPromptOpen(false);
      haptic('success');
      if (status === 'closed') onReject();
      else {
        setConfirmedAction('accepted');
        onAccept();
      }
    } catch {
      haptic('selection');
      setHoursSubmitError(true);
    } finally {
      setHoursSubmitting(false);
    }
  };
  const serviceTime = times.service;

  const formatTime = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // 0-23시 → 로케일별 '오전/오후 N시'(0시=오전 12시, 12시=오후 12시). 예: 16 → '오후 4시'
  const formatKoreanHour = (h: number) => {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h < 12 ? t('card.hourAm', { h: h12 }) : t('card.hourPm', { h: h12 });
  };

  // 카드 상단 혼잡 pill 과 동일한 4단계 임계값(혼잡/보통/여유/한산)
  const congestionKey = (c: number) =>
    c >= 0.75 ? 'busy' : c >= 0.5 ? 'moderate' : c >= 0.25 ? 'relaxed' : 'quiet';
  const congestionLabel = (c: number) => t(`congestion.${congestionKey(c)}`);

  // 소개(overview) 다국어 — 배치 번역(apps/api/scripts/translate_overviews.py)이
  // features.overview_i18n = {en, ja, zh} 에 저장(스키마 변경 없음). apiClient(keysToCamel)는 features
  // 내부 키까지 재귀적으로 camelCase 변환하므로 보통 overviewI18n 이지만, supabase 직접 폴백 경로는
  // 원본 snake_case 를 그대로 들고 올 수 있어 둘 다 지원한다(firstMenu/restDateRaw 와 동일 관례).
  // 현재 로케일이 ko 면 항상 원문(overview)만 쓴다 — 번역이 없어도 지금처럼 한국어 원문(기존 동작 불변).
  const overviewI18n = (facility?.features?.overviewI18n ?? facility?.features?.overview_i18n) as
    | Record<string, string>
    | null
    | undefined;
  const translatedOverview = locale !== 'ko' ? overviewI18n?.[locale] : undefined;
  // 실시간 조회 결과가 있으면 캐시값 위에 덧씌운다(값이 비면 캐시값 그대로 — 추가만).
  const displayOverview = translatedOverview || liveDetail?.overview || facility?.overview;

  // '실시간 정보 새로고침'(TourAPI live-detail) — contentid/contenttypeid 가 있는 TourAPI 적재분만 노출.
  // 계획 B2 3번: 카드 얼굴(사진 바로 아래)의 36px 버튼. 성공하면 '방금 갱신 · HH:MM' 과 짧은 알림, 상세를 열고
  // 새로 받아 온 줄(운영시간·소개·전화·홈페이지·사진)을 1.5초 반짝인다. 버튼은 10초 잠근다. 실패는 조용히 다시 켠다.
  const liveContentId = facility?.contentid;
  const liveContentTypeId = facility?.contenttypeid;
  const canLiveRefresh = !!liveContentId && typeof liveContentTypeId === 'number';
  const handleLiveRefresh = async () => {
    if (!liveContentId || typeof liveContentTypeId !== 'number' || liveLoading || liveCooldown) return;
    setLiveLoading(true);
    try {
      const res = await apiClient.get(
        `/api/v1/infrastructures/live-detail/${encodeURIComponent(liveContentId)}?contentTypeId=${liveContentTypeId}`,
      );
      // 성공(필드 포함)일 때만 덧씌운다. source='unavailable'·실패는 캐시값 유지(에러 UI 없음).
      if (res?.source === 'tourapi-live') {
        const next = {
          operatingHours: res.operatingHours ?? null,
          overview: res.overview ?? null,
          homepage: res.homepage ?? null,
          imageUrl: res.imageUrl ?? null,
          phone: res.phone ?? null,
        };
        setLiveDetail(next);
        setLiveRefreshedAt(new Date());
        setFlashFields(refreshedFields(next));
        setLiveCooldown(true);
        setIsExpanded(true);
        revealRefreshedRow();
        toast.success(t('card.liveRefreshedToast'));
        liveTimersRef.current.push(
          window.setTimeout(() => setFlashFields([]), LIVE_FLASH_MS),
          window.setTimeout(() => setLiveCooldown(false), LIVE_REFRESH_COOLDOWN_MS),
        );
      }
    } catch {
      // 무해 폴백 — 캐시된 행을 그대로 둔다(에러 토스트 없음). 버튼은 아래 finally 에서 다시 켜진다.
    } finally {
      setLiveLoading(false);
    }
  };
  const flashAttr = (field: LiveField) => (flashFields.includes(field) ? 'true' : undefined);
  const flashClass = (field: LiveField) => (flashFields.includes(field) ? 'live-flash' : '');

  // TourAPI 상세(A2) — 시설 정규 컬럼(facility.address/phone) 우선, 카카오 Places 검색값은 폴백으로 강등.
  // 둘 다 없으면 렌더하지 않는다('지어내지 않기'). phone/homepage/운영시간은 실시간 조회값이 있으면 우선.
  const displayAddress = facility?.address || placeInfo?.address;
  const displayPhone = liveDetail?.phone || facility?.phone || placeInfo?.phone;
  // 전화 걸기 링크 — 첫 번호만('054-…, 010-…' · '054-772-3843~4'), 숫자가 없으면 글자로만(lib/phoneLink.ts).
  const phoneHref = telHref(displayPhone);
  // TourAPI homepage 원문은 순수 URL 또는 <a href="..."> HTML 조각일 수 있어 첫 http(s) URL 만 방어적으로 추출.
  // 추출 실패 시 링크를 만들지 않는다(깨진 링크 미노출).
  const homepageSource = liveDetail?.homepage ?? facility?.homepage;
  const homepageUrl = homepageSource
    ? String(homepageSource).match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null
    : null;
  // 운영시간/휴무일도 실시간 조회값 우선(형태 동일 — {open, closed}).
  const displayOperatingHours = liveDetail?.operatingHours ?? facility?.operatingHours;
  // 운영시간·휴무일 원문 → 철·문·요일마다 한 줄(lib/hoursLines.ts — '<br>' 이 글자로 보이지 않게).
  const openHourLines = typeof displayOperatingHours?.open === 'string' ? hoursLines(displayOperatingHours.open) : [];
  const closedDayLines = typeof displayOperatingHours?.closed === 'string' ? hoursLines(displayOperatingHours.closed) : [];
  const homepageHost = (() => {
    if (!homepageUrl) return null;
    try { return new URL(homepageUrl).hostname; } catch { return homepageUrl; }
  })();
  const homepageIsExternalChannel = homepageHost
    ? /(^|\.)instagram\.com$|(^|\.)blog\.naver\.com$/.test(homepageHost.toLowerCase())
    : false;

  // 대표 메뉴(TourAPI detailIntro2 first_menu) — apiClient(/infrastructures, by-type)는 features
  // 내부 키까지 재귀적으로 camelCase 변환하므로 firstMenu 로 오지만, supabase 직접 폴백 경로는
  // 원본 컬럼(snake_case)을 그대로 들고 오므로 둘 다 지원한다(main/page.tsx barrierFree 폴백과 동일 관례).
  // 공식 대표메뉴와 취급메뉴를 합쳐 중복 없이 최대 5개만 노출한다.
  const firstMenuRaw = (facility?.features?.firstMenu ?? facility?.features?.first_menu) as string | undefined;
  const treatMenuRaw = (facility?.features?.treatMenu ?? facility?.features?.treat_menu) as string | undefined;
  const firstMenuTokens = Array.from(new Set(
    [firstMenuRaw, treatMenuRaw]
      .filter((value): value is string => typeof value === 'string')
      .flatMap((value) => value.split(/[,/\n·]+/).map((item) => item.trim()).filter(Boolean))
  )).slice(0, 5);

  // 오늘 휴무 — rest_date_raw 보수 파서(restDate.ts). true 확정일 때만 배지 노출(과판정 금지 원칙).
  const restDateRaw = (facility?.features?.restDateRaw ?? facility?.features?.rest_date_raw) as string | undefined;
  const closedToday = isClosedToday(restDateRaw) === true;

  // 카드 사진 — 대표(firstimage) → detailImage2 갤러리 순 폴백(waiting WaitingCardImage 패턴 미러).
  // 원본 서버에서 만료·차단된 URL 이 섞여 있어 onError 시 다음 후보로 넘어가고, 전부 실패하면 장소 표지가 남는다.
  // 갤러리의 Wikimedia 대체 사진(CC BY/BY-SA)·경주시 사진은 출처가 있을 때만 후보가 되고, 뜨면 사진 아래에 출처를 붙인다.
  const cardImageUrls = creditedPhotoUrls(
    Array.from(
      new Set(
        [liveDetail?.imageUrl, facility?.imageUrl, ...(facility?.galleryImages ?? [])].filter(
          (url): url is string => typeof url === 'string' && url.trim().length > 0
        )
      )
    ),
    facility?.features,
  );
  const [cardImageIndex, setCardImageIndex] = useState(0);
  // 시설 전환뿐 아니라 같은 시설의 URL 목록이 갱신(비동기 보강)돼도 소진된 인덱스가 새 이미지를
  // 가리지 않도록, id+URL 집합을 함께 리셋 기준으로 삼는다(Codex 리뷰 P2, 2026-07-17).
  const cardImageKey = `${facility?.id ?? ''}|${cardImageUrls.join('|')}`;
  useEffect(() => { setCardImageIndex(0); }, [cardImageKey]);
  const cardImageUrl = cardImageUrls[cardImageIndex];
  const cardImageCredit = creditForDisplayedPhoto(cardImageUrl, facility?.features);
  // 다 받은 사진 URL — 출처 줄은 그 사진이 **보일 때만** 드러난다(받는 중에는 자리만 잡고 숨긴다: 사진이 뜰 때
  // 아래 글이 밀리지 않게). URL 로 비교하므로 다음 후보로 넘어가면 새 사진을 받을 때까지 다시 숨는다.
  const [loadedCardImageUrl, setLoadedCardImageUrl] = useState<string | null>(null);
  const cardImageLoaded = cardImageUrl !== undefined && loadedCardImageUrl === cardImageUrl;
  // 사진 위 'ⓒ한국관광공사' 표 — 지금 보이는 사진이 공사(TourAPI) 사진일 때만. Wikimedia·경주시 사진에는 붙이지
  // 않는다(그 사진의 출처는 사진 아래 줄이 말한다 — 두 번째 저작권 표시로 읽히지 않게).
  const cardPhotoIsTourApi = !!cardImageUrl && !cardImageCredit && /(^|\.)visitkorea\.or\.kr\//i.test(cardImageUrl.replace(/^https?:\/\//, ''));
  const tileVisual = placeVisual(facility?.id ?? title, facilityType ?? facility?.type);

  // 머천트 랭킹 연동 2단계 — features 내부가 아니라 facility 최상위 필드지만, 백엔드 응답이 어떤
  // 경로(apiClient keysToCamel 미적용 폴백 등)로 오든 방어적으로 camel/snake 이중 표기를 읽는다.
  const facilityRaw = facility as unknown as Record<string, unknown> | undefined;
  const timesaleRateRaw = (facilityRaw?.timesaleRate ?? facilityRaw?.timesale_rate) as number | undefined;
  // 타임세일이 기본 쿠폰율보다 클 때만 존재한다는 계약이지만, 방어적으로 0보다 큰 수치만 표시.
  const timesaleRatePct =
    typeof timesaleRateRaw === 'number' && timesaleRateRaw > 0 ? Math.round(timesaleRateRaw * 100) : null;
  const couponRateRaw = (facilityRaw?.couponRate ?? facilityRaw?.coupon_rate) as number | undefined;
  const couponRatePct =
    typeof couponRateRaw === 'number' && couponRateRaw > 0 ? Math.round(couponRateRaw * 100) : null;

  const seatStatusFreshRaw = (facilityRaw?.seatStatusFresh ?? facilityRaw?.seat_status_fresh) as
    | { level?: string; minutesAgo?: number; minutes_ago?: number }
    | null
    | undefined;
  const seatStatusFreshMinutesRaw = seatStatusFreshRaw
    ? seatStatusFreshRaw.minutesAgo ?? seatStatusFreshRaw.minutes_ago
    : undefined;
  // number 로 좁혀 아래 렌더에서 t() 의 vars(Record<string, string|number>) 타입과 안전하게 맞춘다.
  const seatStatusFreshMinutes = typeof seatStatusFreshMinutesRaw === 'number' ? seatStatusFreshMinutesRaw : null;
  const areaFreshnessParts = relativeParts(areaDemandObservedAt);
  const areaFreshness = !areaFreshnessParts ? null
    : areaFreshnessParts.unit === 'now' ? t('freshness.justNow')
    : areaFreshnessParts.unit === 'min' ? t('freshness.minAgo', { n: areaFreshnessParts.value })
    : areaFreshnessParts.unit === 'hour' ? t('freshness.hourAgo', { n: areaFreshnessParts.value })
    : t('freshness.dayAgo', { n: areaFreshnessParts.value });
  const demandDisclosure = areaDemandDisclosure(areaDemandParkingEvidence, areaDemandTourismEvidence);
  const evidenceCount = demandDisclosure.evidenceCount;
  // 제목 위 칩('주변이 덜 붐비는 곳'·'조금 뒤 가면 덜 붐빔')은 서버 arrival_action 을 말한다. 그 판정은 주변 수요
  // 종합값으로 한 것이라, 관광 상대지수가 섞였거나 주차 근거가 없으면 붐빔 비교로 말하지 않는다 — 아래 근거
  // 패널의 행동 문장(showQualitativeLevel 일 때만)과 같은 규칙이다. 취향으로 고른 카드는 칩이 없다(I05 d).
  const chipArrivalAction = demandDisclosure.showQualitativeLevel ? arrivalAction : undefined;

  // ── 카드 첫 줄(가치 문장) ───────────────────────────────────────────────────────
  // 화살표 "대릉원 혼잡 → 우직 여유 · 도보 3분" 은 정말 덜 붐비는 다른 곳일 때만,
  // 아니면 혜택 문장 "우직 · 도보 3분 · 도착 시 영업 · 취향 80% 일치"(chooseCompareHeadline).
  // 재료는 전부 이미 카드에 있는 값이다(새 호출 없음). 근거가 하나도 없어도 문장은 만들어진다 —
  // 이 줄이 사라지면 접힌 카드가 매번 다른 높이로 뜨고, 서비스의 약속도 함께 사라진다.
  const compareAnchorLabelName = compareAnchorName
    ?? areaDemandTourismEvidence?.referenceName
    ?? null;
  const compareAnchorDistance = compareAnchorName != null
    ? compareAnchorDistanceM ?? null
    : areaDemandTourismEvidence?.distanceM ?? null;
  const anchorCrowd = resolveAnchorCrowd({
    estimateLevel: compareAnchorLevel,
    parkingLevel: areaDemandParkingEvidence?.level,
    tourismRelativeIndex: areaDemandTourismEvidence?.relativeIndex,
    busyAt,
  });
  // 후보 쪽 등급: 카드가 '지금'으로 칠한 실측 → 점선 추정 → 주변 공영주차 수요.
  // 관광 상대지수가 섞인 종합값은 단일 혼잡률로 말하지 않는다(areaDemandPresentation 계약) — 주차만이면
  // 종합값(주차 + 근처 축제·날씨 보정), 관광 근거가 섞이면 **주차 실측·이력 값만으로** 말한다(기준 명소 쪽
  // resolveAnchorCrowd 와 같은 규칙). 주차 근거가 없으면(관광 상대지수뿐) null → 비교하지 않는다.
  // 가정 시각이면 지도 핀과 같은 예측 값이 먼저다(부모가 그때는 지금 값을 넘기지 않는다).
  const forecastCrowdLevel = typeof forecastLevel === 'number' && Number.isFinite(forecastLevel) ? forecastLevel : null;
  const candidateCrowdGrade = resolveCandidateCrowd({
    congestionLevel: forecastCrowdLevel ?? shownCongestionLevel,
    estimateLevel: estimate?.level,
    areaDemandLevel: candidateAreaCrowdLevel({
      areaDemandLevel,
      parking: areaDemandParkingEvidence,
      tourism: areaDemandTourismEvidence,
    }),
    busyAt,
  });
  const compareHeadline = chooseCompareHeadline({
    anchorName: compareAnchorLabelName,
    anchorDistanceM: compareAnchorDistance,
    candidateName: title,
    anchorGrade: anchorCrowd.grade,
    // 관광 상대지수로 정한 등급이면 화살표를 쓰지 않는다 — '지금' 도, 다른 곳과 견줄 값도 아니다.
    anchorBasis: anchorCrowd.basis,
    candidateGrade: candidateCrowdGrade,
  });
  // 혜택 문장의 '취향 N% 일치' — 그 숫자가 장소를 가를 때만(60% 이상 · 후보마다 다를 때, 리뷰 10-07). 아니면 그 조각을 뺀다
  // (가장 큰 줄이 추천한 곳을 깎지 않고, 모든 카드에 같은 숫자를 붙이지 않게). 숫자는 SPOT 점수 상자에 남는다.
  const tastePct = faceTastePercent(preferencePercent, tastePeers);
  // 화살표 문장 — chooseCompareHeadline 이 'compare' 면 기준 명소와 두 등급이 모두 있다. '지금' 이라는 말은 없다
  // (가정 시각이면 상자 안의 '🕒 … 기준' 알약이 시각을 말한다).
  const compareHeaderText = compareHeadline.kind === 'compare' && compareAnchorLabelName && anchorCrowd.grade && candidateCrowdGrade
    ? t('compare.arrowLine', {
        anchor: compareAnchorLabelName,
        anchorCrowd: t(`congestion.${anchorCrowd.grade}`),
        candidate: title,
        walk: displayedTravelMins,
        candidateCrowd: t(`congestion.${candidateCrowdGrade}`),
      })
    : null;
  const compareKicker = t(compareHeadline.kind === 'benefit' && compareHeadline.candidateIsAnchor
    // 가정 시각(+N시간 · 요일)에는 '가까운' 이라고 하지 않는다 — 다시 매긴 카드가 걸어서 16분이어도 '가까운 추천' 이라
    // 했다(리뷰 10-07). 그 시각을 위한 추천이라는 말만 하고, 어느 시각인지는 아래 '🕒 … 기준' 알약이 말한다.
    ? (assumedTimeLabel ? 'compare.atTimeKicker' : 'compare.nearbyKicker')
    : 'compare.headerKicker');
  // 💡 사유도 첫 줄과 같은 판정을 따른다 — 화살표가 참일 때만 "{A} 대신 {B} 어떠세요?".
  const shownReason = compareHeadline.kind === 'compare' && insteadReason ? insteadReason : reason;

  // ── 혼잡 칩(얼굴 · 미리보기) ───────────────────────────────────────────────────
  // 칩의 글자와 색 — 실측(꽉 찬 등급색) · 점선 추정 · 주변 붐빔 등급. 얼굴에 둘지는 showFaceCrowdChip:
  // '지금' 잰 값이거나 기준 명소보다 정말 덜 붐빌 때만(같은 지역 추정 등급은 근거 안에만 — 계획 B2 5번).
  const areaCrowdGrade = shownCongestionLevel === null && !estimate && typeof areaDemandLevel === 'number'
    ? candidateCrowdGrade
    : null;
  const crowdChipData: { grade: 'busy' | 'moderate' | 'relaxed' | 'quiet'; text: string; dashed: boolean } | null =
    forecastCrowdLevel !== null
      // 가정 시각의 예측 — 지도의 점선 고리 핀처럼 점선(추정)으로.
      ? { grade: gradeKey(forecastCrowdLevel, busyAt), text: t('card.estimateLevel', { label: t(`congestion.${gradeKey(forecastCrowdLevel, busyAt)}`) }), dashed: true }
      : shownCongestionLevel !== null
        ? { grade: congestionKey(shownCongestionLevel), text: `${t('card.congestion')}: ${congestionLabel(shownCongestionLevel)}`, dashed: false }
        : estimate
          ? { grade: gradeKey(estimate.level, busyAt), text: t('card.estimateLevel', { label: t(`congestion.${gradeKey(estimate.level, busyAt)}`) }), dashed: true }
          : areaCrowdGrade
            ? { grade: areaCrowdGrade, text: `${t('recommend.areaDemandForRanking')}: ${t(`congestion.${areaCrowdGrade}`)}`, dashed: false }
            : null;
  const measuredNow = !!localReport || display.mode === 'measured';
  const crowdChipRule = {
    measuredNow,
    anchorGrade: anchorCrowd.grade,
    anchorBasis: anchorCrowd.basis,
    candidateGrade: candidateCrowdGrade,
  };
  const crowdChipOnFace = !!crowdChipData && showFaceCrowdChip({
    ...crowdChipRule,
    valueLineSaysCrowd: showCompare && compareHeaderText !== null,
  });
  // 휴대폰 미리보기도 가치 문장을 먼저 말한다(계획 B3) — 그래서 칩 규칙도 얼굴과 같다(화살표가 붐빔을 말하면 칩은 뺀다).
  const crowdChipOnPeek = crowdChipOnFace;
  // 미리보기의 가치 문장 — 화살표면 그대로, 혜택형이면 이름(아래 줄에 있다)을 뺀 혜택만.
  const peekValueText = compareHeaderText ?? [
    t('compare.benefitWalk', { walk: displayedTravelMins }),
    ...(displayedOpenStatus === 'open_expected' ? [t('compare.benefitOpen')] : []),
    ...(tastePct !== null ? [t('compare.benefitTaste', { pct: tastePct })] : []),
  ].join(' · ');
  const peekValueShown = showCompare && !!peekValueText;
  // 출발 → 도착은 지금 시각으로 센다 — 가정 시각(+N시간 · 요일)의 카드에서는 '🕒 … 기준' 과 다른 시각을 말하게 되므로
  // 그리지 않는다(리뷰 10-07: '04:44 출발' 옆에 '+2시간 후 기준').
  const showArrivalLine = !assumedTimeLabel && !!currentTime && !!arrivalTime;
  const crowdChip = (compact: boolean) => crowdChipData ? (
    compact ? (
      <span className={`rounded-md border px-2 py-0.5 text-[11px] font-bold ${crowdChipData.dashed ? 'border-dashed bg-white/70' : ''} ${
        {
          busy: 'bg-terracotta/10 border-terracotta/30 text-terracotta',
          moderate: 'bg-gold/10 border-gold/30 text-gold-deep',
          relaxed: 'benefit-relaxed',
          quiet: 'benefit-quiet',
        }[crowdChipData.grade]
      }`}>{crowdChipData.text}</span>
    ) : (
      <BenefitChip tone={crowdTone(crowdChipData.grade)} dashed={crowdChipData.dashed}>{crowdChipData.text}</BenefitChip>
    )
  ) : null;

  // ── 머리 배지 — 보이는 목록에서의 자리(lib/cardRank.ts) ────────────────────────────
  const rankText = showListRank
    ? cardRankText(cardRankLabel(rank))
    : rank ? { key: rank === 1 ? 'card.rankBadgeTop' : 'card.rankBadge', vars: { rank } } : { key: 'card.aiRec' };
  const rankIsListed = showListRank ? typeof rank === 'number' && rank >= 1 : !!rank;
  // 1위의 '추천 이유'(취향 N% · 도보 N분)는 가치 문장과 같은 말이라 얼굴에 두지 않는다 — '추천 근거 자세히' 안에.
  const spotReasonOnFace = !!spotComparisonReason && typeof rank === 'number' && rank >= 2;

  // ── 하나의 신선도 표(I10 one-stamp) — '추천 근거 자세히' 안에 한 개만 ─────────────────────────────
  const freshnessStamp = (() => {
    if (seatStatusFreshMinutes !== null) return `✅ ${t('card.seatConfirmed', { n: seatStatusFreshMinutes })}`;
    if (shownCongestionLevel !== null && displayDataSource && !displayDataSource.isStale) {
      const parts = relativeParts(displayDataSource.lastUpdated);
      if (parts) {
        const rel =
          parts.unit === 'now' ? t('freshness.justNow')
          : parts.unit === 'min' ? t('freshness.minAgo', { n: parts.value })
          : parts.unit === 'hour' ? t('freshness.hourAgo', { n: parts.value })
          : t('freshness.dayAgo', { n: parts.value });
        return displayDataSource.source === 'user_report' ? `📣 ${t('card.freshReport', { rel })}` : `🕒 ${t('card.freshLive', { rel })}`;
      }
    }
    if (estimate) return t('card.evidenceEstimated', { time: formatEstimateTime(estimate.observedAt) ?? '—' });
    if (lastObserved) {
      return typeof lastObserved.level === 'number'
        ? t('card.lastObservedLevel', { time: formatLastObserved(lastObserved.observedAt) ?? '—', label: congestionLabel(lastObserved.level) })
        : t('card.lastObserved', { time: formatLastObserved(lastObserved.observedAt) ?? '—' });
    }
    return null;
  })();

  // '도보 길안내' — 전체 카드와 휴대폰 미리보기가 **같은 함수**를 부른다. 이름은 언제나 '도보 길안내' 이고,
  // 영업시간을 모르는 음식점·카페면 누를 때 카카오맵 영업시간을 먼저 열고 '영업 중인지' 를 묻는다.
  // 미리보기에서 그 질문을 띄우면 질문은 전체 카드에만 있으므로 카드를 펼치고 질문을 화면 안으로 끌어온다.
  const handleAcceptClick = () => {
    haptic('success');
    if (needsHoursConfirmation && kakaoPlaceUrl) {
      setHoursPromptOpen(true);
      setHoursSubmitError(false);
      if (peekMode && isMinimized) setIsMinimized(false);
      window.open(kakaoPlaceUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    setConfirmedAction('accepted');
    onAccept();
  };
  const handlePeekAcceptClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (justDraggedRef.current) return;
    handleAcceptClick();
  };

  // 조건 칩(도보 N분 이내 · 실내 · 무장애) — 카드 머리, ✕ 로 바로 푼다.
  const conditionChips = conditions.length > 0 ? (
    <div className="flex flex-wrap items-center gap-1" data-testid="card-conditions">
      {conditions.map((condition) => (
        <button
          key={condition.key}
          type="button"
          onClick={(event) => { event.stopPropagation(); onRemoveCondition?.(condition.key); }}
          aria-label={t('condition.removeAria', { label: condition.name })}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-jade/40 bg-white/85 px-2.5 text-[12px] font-bold text-jade hover:bg-jade/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/60"
        >
          <span>{condition.label}</span>
          <X size={12} aria-hidden />
        </button>
      ))}
    </div>
  ) : null;

  // 얼굴의 혜택 칩(계획 B2 5번) — 가치 문장이 이미 한 말은 되풀이하지 않는다.
  const faceChips: ReactNode[] = [];
  if (crowdChipOnFace) faceChips.push(<span key="crowd">{crowdChip(false)}</span>);
  if (displayedOpenStatus === 'open_expected' && showCompare && compareHeaderText) {
    faceChips.push(<BenefitChip key="open" tone="jade">{t('compare.benefitOpen')}</BenefitChip>);
  }
  if (displayedOpenStatus === 'closing_soon' || likelyClosedUnknown) {
    faceChips.push(<BenefitChip key="closing" tone="terracotta">{t(`card.arrivalStatus.${displayedOpenStatus}`)}</BenefitChip>);
  } else if (displayedOpenStatus === 'open_expected' && !showCompare) {
    faceChips.push(<BenefitChip key="open" tone="jade">{t('card.arrivalStatus.open_expected')}</BenefitChip>);
  }
  if (closedToday) faceChips.push(<BenefitChip key="closed" tone="terracotta">{t('card.closedToday')}</BenefitChip>);
  if (waitMins !== null) faceChips.push(<BenefitChip key="wait" tone="gold">{t('card.wait', { n: waitMins })}</BenefitChip>);
  if (timesaleRatePct !== null) faceChips.push(<BenefitChip key="sale" tone="gold">{t('card.timesale', { rate: timesaleRatePct })}</BenefitChip>);

  const perkText = timesaleRatePct !== null
    ? t('card.timesale', { rate: timesaleRatePct })
    : couponRatePct !== null ? t('recommend.spotComparison.coupon', { n: couponRatePct }) : null;

  return (
    <motion.div
      data-testid="recommendation-card"
      className={`w-full ${desktopFill ? 'md:h-full md:max-h-full' : ''} max-h-[calc(100dvh-var(--tourist-nav-clearance)-10rem)] bg-white/95 backdrop-blur-2xl border border-line rounded-3xl ${isMinimized ? 'p-3' : 'px-4 pb-3 pt-2 md:px-5'} toss-surface flex flex-col ${isMinimized ? 'gap-1' : 'gap-2'} select-none relative overflow-hidden`}
      initial={{ opacity: 0, y: 18, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.2}
      onDrag={handleDrag}
      onDragEnd={handleDragEndWithClickGuard}
      layout
      transition={sheetSpring}
    >
      {/* 상단 장식 라인 — 콜드 블루 글로우를 신라금 웜 그라디언트로 */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-gold/50 to-transparent" />

      {/* 손잡이 — 모든 폭에서 남긴다(끌어 올리기·내리기, 계획 B2 · I31). 키보드·스크린리더의 펼치기 경로는
          아래 '상세 정보 펼치기' 버튼이다. */}
      {peekMode ? (
        // 휴대폰 미리보기: 손잡이가 곧 '펼치기/미리보기로 접기' 버튼이다(키보드·스크린리더도 쓸 수 있게
        // 이름을 붙이고, 손가락이 닿기 쉽게 전폭 24px 높이로 잡는다). 위로 밀기·아래로 밀기는 카드 전체의 drag.
        <div className="relative -mt-1 flex items-start gap-2">
          <button
            type="button"
            aria-label={t(isMinimized ? 'card.peek.expand' : 'card.peek.collapse')}
            aria-expanded={!isMinimized}
            onClick={() => {
              if (justDraggedRef.current) return;
              if (isMinimized) {
                setIsMinimized(false);
              } else {
                setIsExpanded(false);
                setIsMinimized(true);
              }
            }}
            className={`flex min-h-6 min-w-0 flex-1 shrink cursor-pointer flex-col justify-center gap-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${voiceSlot ? 'items-start pl-1' : 'items-center'}`}
          >
            <span aria-hidden="true" className={`h-1.5 w-16 rounded-full bg-muk/20 ${voiceSlot ? 'self-center' : ''}`} />
            {/* 손잡이가 무엇을 하는지 글자로도 말한다 — 회색 막대만으로는 펼쳐진다는 걸 모른다(10-06 리뷰). 펼친 뒤에도
                '추천 간단히 보기' 를 보여 준다(리뷰 10-07: 펼친 카드가 카테고리 칩·필터·편의를 덮는데 돌아가는 길이 막대뿐이었다). */}
            <span aria-hidden="true" className="text-[11px] font-bold leading-4 text-gold-deep">
              {t(isMinimized ? 'card.peek.expand' : 'card.peek.collapse')}
            </span>
          </button>
          {voiceSlot && isMinimized && <div className="shrink-0 pt-1">{voiceSlot}</div>}
        </div>
      ) : (
      <div
        aria-hidden="true"
        className="w-16 h-1.5 shrink-0 bg-muk/15 hover:bg-muk/25 rounded-full mx-auto cursor-grab flex items-center justify-center transition-colors"
        onClick={() => {
          if (isMinimized) setIsMinimized(false);
          else toggleExpand();
        }}
      />
      )}

      {isMinimized && peekMode ? (
        // 휴대폰 미리보기 — 관광객이 지금 알아야 할 것만: 가치 문장(2줄, 키 낮은 화면 1줄) · 이름 + SPOT 점수 · 도보 N분 ·
        // 붐비나(얼굴과 같은 규칙 — 화살표가 이미 말하면 빼고) · 바로 출발(도보 길안내, 전체 카드와 같은 동작). 혜택형
        // 문장은 이름이 아래 줄에 있으므로 이름을 뺀다(계획 B3). 줄을 누르면 전체 카드.
        <div className="flex flex-col gap-1.5 px-1 pb-0.5" data-testid="rec-card-peek">
          {peekValueShown && (
            <p
              data-testid="peek-value"
              onClick={openFromPeek}
              className="line-clamp-2 cursor-pointer break-keep text-[14px] font-extrabold leading-snug text-muk short:line-clamp-1"
            >
              {/* 가정 시각으로 다시 매긴 카드는 미리보기에서도 어느 시각 기준인지 먼저 말한다(리뷰 10-07 — 휴대폰 미리보기에는
                  '+2시간 후' 단서가 없었다). 펼친 카드의 '🕒 … 기준' 알약과 같은 라벨. */}
              {assumedTimeLabel && (
                <span data-testid="peek-time" className="mr-1.5 inline-flex rounded-full border border-gold/40 bg-gold/15 px-1.5 py-px align-[1px] text-[11px] font-bold text-gold-deep">
                  🕒 {assumedTimeLabel}
                </span>
              )}
              {peekValueText}
            </p>
          )}
          <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 cursor-pointer" onClick={openFromPeek}>
            <div className="flex items-center gap-1.5">
              <h3 className="min-w-0 truncate font-serif text-base font-bold leading-tight tracking-tight text-muk">{title}</h3>
              {hasSpotMetrics && (
                <span className="shrink-0 whitespace-nowrap rounded-md border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[11px] font-extrabold text-gold-deep" data-testid="peek-spot">
                  {t('card.peek.spot', { n: Math.round(spotScore || 0) })}
                </span>
              )}
              <ChevronUp size={14} className="shrink-0 text-gold-deep" aria-hidden />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
              {/* 가치 문장이 이미 '도보 N분' 을 말하면 되풀이하지 않는다(계획 B2 — 사실 하나는 한 번). 화살표 문장이면
                  그 자리에 문장에 없는 '도착 시 영업' 을 둔다. */}
              {!peekValueShown ? (
                <span className="whitespace-nowrap rounded-md border border-jade/30 bg-jade/10 px-2 py-0.5 text-[11px] font-bold text-jade">
                  {t('card.peek.walk', { n: displayedTravelMins })}
                </span>
              ) : compareHeaderText && displayedOpenStatus === 'open_expected' ? (
                <span className="whitespace-nowrap rounded-md border border-jade/30 bg-jade/10 px-2 py-0.5 text-[11px] font-bold text-jade">
                  {t('compare.benefitOpen')}
                </span>
              ) : null}
              {facility && crowdChipOnPeek && crowdChip(true)}
              {closedToday && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-bold border bg-terracotta/10 border-terracotta/30 text-terracotta">
                  {t('card.closedToday')}
                </span>
              )}
            </div>
          </div>
          <motion.button
            type="button"
            onClick={handlePeekAcceptClick}
            whileTap={tapMotion}
            transition={interactionSpring}
            aria-label={t('card.acceptAria')}
            className="min-h-11 max-w-[46%] shrink-0 break-keep rounded-2xl cta-primary px-4 py-3 text-xs font-bold leading-tight shadow-[0_4px_14px_rgba(168,70,47,0.28)] transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <span className="inline-flex items-center justify-center gap-1.5">
              {confirmedAction === 'accepted' && <Check size={14} aria-hidden />}
              {t('card.accept')}
            </span>
          </motion.button>
          </div>
        </div>
      ) : isMinimized ? (
        <div
          className="flex items-center justify-between px-2 pb-1 cursor-pointer"
          onClick={() => setIsMinimized(false)}
        >
           <span className="text-sm font-bold text-muk truncate max-w-[200px]">{title}</span>
           <span className="text-[10px] text-terracotta font-bold bg-gold/10 px-2 py-0.5 rounded-full border border-gold/25 whitespace-nowrap">
             {t('card.open')} <ChevronUp size={12} className="inline mb-0.5" />
           </span>
        </div>
      ) : (
        <>
          {/* 버튼 위 내용만 이 래퍼 안에서 스크롤한다 — 버튼 두 줄은 래퍼 밖(바닥 고정)이라 카드가 아무리 길어도 보인다.
              데스크톱 패널은 얇은 금빛 스크롤바와 위·아래 가장자리 흐림으로 더 있는 내용을 알린다(I31). */}
          <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={updateScrollEdges}
            className="rec-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain"
          >
          <div className="flex flex-col gap-2 pb-1">

      {/* 1. 가치 문장 상자 — 카드에서 가장 큰 글씨. 이 추천이 관광객에게 무엇을 주는지가 첫 문장이다.
          근거 값이 비어도 사라지지 않는다 — 단, 대신할 기준 명소 자체가 없는 화면(showCompare=false,
          예: 저장 목록)에서는 띄우지 않는다. 지금 걸린 조건 칩(9번)도 이 상자 머리에 둔다. */}
      {showCompare ? (
      <div className="rounded-2xl border border-terracotta/25 bg-gradient-to-r from-terracotta/10 via-gold/10 to-jade/10 px-3 py-2" data-testid="value-box">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 pt-0.5 text-[12px] font-bold text-terracotta">
            {compareKicker}
          </p>
          {voiceSlot && <div className="shrink-0">{voiceSlot}</div>}
        </div>
        {compareHeaderText ? (
          <p className="mt-0.5 break-keep text-[16px] md:text-[17px] xl:text-[18px] font-extrabold leading-snug text-muk">
            {compareHeaderText}
          </p>
        ) : (
          <p className="mt-0.5 break-keep text-[16px] md:text-[17px] xl:text-[18px] font-extrabold leading-snug text-muk">
            {title}
            {' · '}
            <span className="inline-block rounded-full bg-jade/15 px-2 text-jade">
              {t('compare.benefitWalk', { walk: displayedTravelMins })}
            </span>
            {displayedOpenStatus === 'open_expected' && <>{' · '}{t('compare.benefitOpen')}</>}
            {tastePct !== null && <>{' · '}{t('compare.benefitTaste', { pct: tastePct })}</>}
          </p>
        )}
        {(assumedTimeLabel || contextBadge || conditionChips) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {assumedTimeLabel && (
              <span className="rounded-full border border-gold/40 bg-gold/15 px-2 py-0.5 text-[11px] font-bold text-gold-deep">
                🕒 {assumedTimeBadge ?? t('assume.basisBadge', { label: assumedTimeLabel })}
              </span>
            )}
            {contextBadge && (
              <span className="rounded-full border border-jade/40 bg-jade/10 px-2 py-0.5 text-[11px] font-bold text-jade">
                ✨ {contextBadge}
              </span>
            )}
            {conditionChips}
          </div>
        )}
      </div>
      ) : (conditionChips || voiceSlot) ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{conditionChips}</div>
          {voiceSlot && <div className="shrink-0">{voiceSlot}</div>}
        </div>
      ) : null}

      {/* 2. 사진 띠 — 접힌 카드에서 바로 보인다(I38). TourAPI 사진이면 'ⓒ한국관광공사' 표를 사진 위에, Wikimedia·경주시
          사진이면 그 사진의 출처 줄을 사진 아래에. 사진이 없거나 전부 깨지면 장소 표지(경주 문양 판)가 남는다. */}
      {/* 저장 목록(/saved · showCompare 없음)은 사진이 있을 때만 — 사진 없는 저장 장소에 112px 표지를 새로 끼우지 않는다. */}
      {(showCompare || cardImageUrls.length > 0) && (
      <div>
        <div
          className={`rec-photo relative overflow-hidden rounded-2xl border border-line ${flashClass('photo')}`}
          data-testid="card-photo"
          data-refreshed={flashAttr('photo')}
        >
          <PlacePhotoFallback className="absolute inset-0" visual={tileVisual} />
          {cardImageUrl && (
            // TourAPI 이미지 원본은 도메인이 다양해 next/image 최적화 대상이 아님(정적 export) — img 사용
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={cardImageUrl} /* URL 마다 새 엘리먼트 — 직전 시설 이미지의 늦은 onError 가 새 카드의 인덱스를 밀어올리지 않게 */
              /* 캐시에서 곧장 뜬 사진은 onLoad 를 놓칠 수 있다 — 붙는 순간 한 번 확인한다. */
              ref={(img) => { if (img?.complete && img.naturalWidth > 0) setLoadedCardImageUrl(cardImageUrl); }}
              src={cardImageUrl}
              alt={title}
              onLoad={() => setLoadedCardImageUrl(cardImageUrl)}
              onError={() => setCardImageIndex((current) => current + 1)}
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${cardImageLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
          )}
          {cardPhotoIsTourApi && cardImageLoaded && (
            <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white">
              {t('card.photoCredit')}
            </span>
          )}
        </div>
        {/* 누르는 자리 24px 중 글자 줄만 사진 4px 아래에 보이게 — 위 -1px·아래 -5px. */}
        {cardImageCredit && (
          <PhotoCreditLink credit={cardImageCredit} className={`-mt-px -mb-[5px] ${cardImageLoaded ? '' : 'invisible'}`} />
        )}
      </div>
      )}

      {/* 3. 실시간 정보 새로고침 — 기능설명서 F3 ② 를 누를 수 있는 진짜 버튼으로, 사진 바로 아래(P6). */}
      {canLiveRefresh && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="live-refresh-row">
          <button
            type="button"
            onClick={handleLiveRefresh}
            disabled={liveLoading || liveCooldown}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-gold/60 bg-white px-3.5 text-[13px] font-bold text-gold-deep transition-colors hover:bg-gold/10 disabled:cursor-default disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <RefreshCw size={15} className={liveLoading ? 'animate-spin' : ''} aria-hidden />
            {t('card.liveRefresh')}
          </button>
          <span className="text-[12px] font-semibold text-muk-soft">{t('card.liveCredit')}</span>
          {liveRefreshedAt && (
            <span data-testid="live-refreshed" className="rounded-full bg-jade/15 px-2.5 py-0.5 text-[12px] font-bold text-jade">
              ✓ {t('card.liveRefreshed', { time: formatTime(liveRefreshedAt) })}
            </span>
          )}
        </div>
      )}

      {/* 4. 이름 + SPOT 점수 배지. 배지 전체가 버튼이고, 설명은 카드 흐름 안 상자로 열린다(I51 — 절대 위치 말풍선은
          카드를 옆으로 밀고 이름을 잘랐다). */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 cursor-pointer" onClick={toggleExpand}>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span
              data-testid="card-rank"
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-black ${
                rankIsListed ? 'cta-primary shadow-sm' : 'bg-gold/15 text-gold-deep'
              }`}
            >
              <Sparkles size={12} aria-hidden />
              {t(rankText.key, rankText.vars)}
            </span>
            {/* 후보 수('대안 N개 중')는 그리지 않는다 — 관광객에게는 후보 선정 규칙이 아니라 이 장소가 왜 좋은지가
                필요하다(PM 2026-09-26). 붐빔·시간 근거로 고른 경우에만 그 혜택을 칩으로 말한다. */}
            {(chipArrivalAction === 'choose_calmer' || chipArrivalAction === 'wait_then_go') && (
              <span className={`whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-bold ${
                chipArrivalAction === 'choose_calmer'
                  ? 'bg-jade/10 border-jade/30 text-jade'
                  : 'bg-sky-500/10 border-sky-500/25 text-sky-700'
              }`}>
                {t(chipArrivalAction === 'choose_calmer'
                  ? 'recommend.alternativeBasis.crowd'
                  : 'recommend.alternativeBasis.timing')}
              </span>
            )}
          </div>
          <h3 className="font-serif text-[20px] xl:text-[22px] font-bold leading-tight tracking-tight text-muk">{title}</h3>
        </div>

        {hasSpotMetrics ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              const next = !spotOpen;
              setSpotOpen(next);
              if (next) revealInScroller(spotInfoId, 'nearest');
            }}
            aria-expanded={spotOpen}
            aria-controls={spotInfoId}
            aria-label={t('card.spotTooltipAria')}
            data-testid="spot-badge"
            className={`flex min-h-[60px] min-w-[60px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border px-2 py-1.5 shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
              spotOpen ? 'border-gold bg-gold/20' : 'border-gold/40 bg-gradient-to-b from-gold/20 to-gold/5 hover:border-gold'
            }`}
          >
            <span className="whitespace-nowrap text-[12px] font-bold leading-none text-gold-deep">
              {t('card.spotScoreLabel')} <span aria-hidden>ⓘ</span>
            </span>
            {/* 표시만 카운트업(animatedSpotScore) — 목표값·반올림은 기존 Math.round(spotScore) 그대로 */}
            <span className="text-[22px] font-black leading-none text-muk">
              {animatedSpotScore}<span className="ml-0.5 text-[11px] font-normal text-muk-soft">{t('card.pointSuffix')}</span>
            </span>
          </button>
        ) : (
          matchPercentage !== undefined && (
            <div className="flex flex-col items-center justify-center min-w-[60px] h-[60px] rounded-2xl border border-gold/30 bg-gold/10 shadow-sm">
              <span className="text-muk font-black text-lg">{matchPercentage}%</span>
              <span className="text-[10px] text-gold-deep font-semibold mt-0.5">{t('card.match')}</span>
            </div>
          )
        )}
      </div>

      {/* SPOT 점수 설명(I51) — 카드 흐름 안에서 열린다(가로로 밀리지 않는다). 40/40/20 을 관광객 말로, 그리고 이곳의 값. */}
      {hasSpotMetrics && spotOpen && (
        <div id={spotInfoId} data-testid="spot-info" className="rounded-2xl border border-gold/35 bg-gold/10 px-3.5 py-3 text-left">
          <p className="text-[13px] font-extrabold text-gold-deep">{t('card.spotTooltipTitle')}</p>
          <p className="mt-1 break-keep text-[12px] leading-relaxed text-muk">{t('card.spotInfoIntro')}</p>
          <p className="mt-2 text-[11px] font-bold text-muk-soft">{t('card.spotInfoPlace')}</p>
          <ul className="mt-1 space-y-0.5 text-[12px] font-semibold text-muk">
            {typeof preferencePercent === 'number' && (
              <li>· {t('card.spotInfoTaste', { pct: Math.round(preferencePercent) })}</li>
            )}
            <li>
              · {waitMins !== null
                ? t('card.spotInfoTimeWait', { walk: displayedTravelMins, wait: waitMins })
                : t('card.spotInfoTime', { walk: displayedTravelMins })}
            </li>
            {perkText && <li>· {t('card.spotInfoPerk', { perk: perkText })}</li>}
          </ul>
        </div>
      )}

      {/* 5·6. 혜택 칩(가치 문장이 이미 한 말은 되풀이하지 않는다) 다음에 출발 → 도착(lib/cardTimes — 도착 = 출발 +
          도보 칩 분). 한 줄에 들어가면 같은 줄에 선다 — 키 낮은 노트북에서도 '상세 정보 펼치기' 가 첫 화면에 남게. */}
      {(faceChips.length > 0 || showArrivalLine) && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5" data-testid="benefit-chips">
          {faceChips}
          {showArrivalLine && currentTime && arrivalTime && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold text-muk" data-testid="arrival-line">
              <Clock size={14} className="shrink-0 text-jade" aria-hidden />
              {t('card.arrivalLine', { depart: formatTime(currentTime), arrive: formatTime(arrivalTime) })}
            </span>
          )}
        </div>
      )}
      {likelyClosedUnknown && arrivalTime && (
        <p className="text-[12px] font-medium leading-relaxed text-terracotta">
          {t('card.likelyClosedReason', { time: formatTime(arrivalTime) })}
        </p>
      )}

      {/* 7. 관광객 말의 '추천 이유'(베스트 추천 대비 차이) — 2·3번째 추천만. 1위의 이유는 가치 문장과 같은 말이라
          '추천 근거 자세히' 안에 둔다. 이 문장의 순위가 카드의 순위와 같을 때만 부모가 넘긴다(I05 j). */}
      {spotReasonOnFace && (
        <div className="rounded-xl border border-jade/20 bg-jade/5 px-3 py-2">
          <p className="text-[11px] font-extrabold text-jade">{t('recommend.spotComparison.current')}</p>
          <p className="mt-0.5 text-[12px] font-semibold leading-snug text-muk">{spotComparisonReason}</p>
        </div>
      )}

      {/* 8. 상세 펼치기/접기 — 첫 화면 안에 있는 전폭 버튼. **키보드·스크린리더가 상세에 닿는 유일한 경로**이고
          (헤더 div 를 버튼으로 바꾸면 SPOT 배지 버튼과 '버튼 안의 버튼'이 된다), 마우스·터치는 이름 줄·손잡이로도 연다. */}
      <button
        type="button"
        onClick={toggleExpand}
        aria-expanded={isExpanded}
        aria-controls={detailsPanelId}
        // 보이는 문구와 접근명을 같은 키로 묶는다 — 아이콘만 바뀌고 이름이 그대로면
        // 음성 제어 사용자가 "접기" 라고 말해도 눌리지 않는다(WCAG 2.5.3).
        aria-label={t(isExpanded ? 'card.detailsCollapse' : 'card.detailsExpand')}
        data-testid="details-toggle"
        className="flex min-h-10 w-full shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-gold/40 bg-gold/5 px-3 py-2 text-[13px] font-bold text-gold-deep transition-colors hover:border-gold/60 hover:bg-gold/10 active:bg-gold/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
      >
        {isExpanded
          ? <ChevronUp size={15} className="text-gold-deep" aria-hidden />
          : <ChevronDown size={15} className="text-gold-deep" aria-hidden />}
        {t(isExpanded ? 'card.detailsCollapse' : 'card.detailsExpand')}
      </button>

      {/* 펼친 상세 — 이 래퍼가 aria-controls 의 대상이다. AnimatePresence 는 접히면 패널을 언마운트하므로
          id 를 안쪽 motion.div 에 걸면 접힌 동안 가리키는 대상이 사라진다 — 그래서 래퍼는 항상 DOM 에 둔다.
          `empty:hidden`: 접힌 상태에서 래퍼는 자식이 없다 → display:none 이라 부모 flex 의 gap 이 빈 줄로 남지 않는다. */}
      <div id={detailsPanelId} ref={detailsRef} className="empty:hidden">
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            {/* 이름 막대 — 상세를 내려 읽는 동안 위에 붙어 지금 어느 곳의 정보인지 말한다. */}
            <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 border-b border-line bg-white/95 px-1 py-1.5 backdrop-blur" data-testid="details-name-bar">
              <MapPin size={13} className="shrink-0 text-gold-deep" aria-hidden />
              <span className="min-w-0 truncate text-[13px] font-extrabold text-muk">{title}</span>
            </div>
            <div className="space-y-3 pt-3 text-xs text-muk-soft">

          {/* 운영시간 — 실제 영업시간이 있을 때만. 인제스트는 {open: 영업시간, closed: 휴무일} 저장. */}
          {openHourLines.length > 0 && (
            <div className={`flex items-start gap-2 ${flashClass('hours')}`} data-refreshed={flashAttr('hours')} data-testid="detail-hours">
              <Clock size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.hours')}</span>
                {/* 철·문·요일마다 한 줄(원문의 '<br>' 은 줄바꿈으로). 옛 시드의 close/weekday 는 마지막 줄 뒤에. */}
                {openHourLines.map((line, index) => (
                  <span key={`${index}-${line}`} className="block text-muk">
                    {line}
                    {index === openHourLines.length - 1 && displayOperatingHours?.close && ` ~ ${displayOperatingHours.close}`}
                    {index === openHourLines.length - 1 && displayOperatingHours?.weekday && ` (${displayOperatingHours.weekday})`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 휴무일 — closed 가 있을 때만 별도 라인(운영시간과 키 의미가 다름: closed=휴무일 텍스트) */}
          {closedDayLines.length > 0 && (
            <div className={`flex items-start gap-2 ${flashClass('hours')}`} data-refreshed={flashAttr('hours')}>
              <Clock size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.closedDays')}</span>
                {closedDayLines.map((line, index) => (
                  <span key={`${index}-${line}`} className="block text-muk">{line}</span>
                ))}
              </div>
            </div>
          )}

          {/* 소개(TourAPI overview, 비-ko 로케일이면 배치 번역 우선) — 장소 판단에 충분하도록 6줄까지 표시. */}
          {displayOverview && (
            <div className={flashClass('overview')} data-refreshed={flashAttr('overview')}>
              <span className="text-muk-soft block text-[10px] font-bold mb-0.5">{t('card.about')}</span>
              <p className="text-muk leading-relaxed line-clamp-6">{displayOverview}</p>
            </div>
          )}

          {/* Address — 실제 주소가 있을 때만(TourAPI 컬럼 우선, 카카오 Places 검색값 폴백) */}
          {displayAddress && (
            <div className="flex items-start gap-2">
              <MapPin size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.address')}</span>
                <span className="text-muk leading-relaxed">{displayAddress}</span>
              </div>
            </div>
          )}

          {/* Phone — 실제 전화번호가 있을 때만(TourAPI 컬럼 우선, 카카오 Places 검색값 폴백). 누르면 바로 건다. */}
          {displayPhone && (
            <div className={`flex items-start gap-2 ${flashClass('phone')}`} data-refreshed={flashAttr('phone')}>
              <Phone size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.phone')}</span>
                {phoneHref ? (
                  <a href={phoneHref} className="text-gold-deep hover:text-gold underline font-bold tracking-tight">
                    {displayPhone}
                  </a>
                ) : (
                  <span className="text-muk">{displayPhone}</span>
                )}
              </div>
            </div>
          )}

          {/* Homepage — 실제 홈페이지가 있을 때만. 표시 텍스트는 hostname, 새 탭 외부 링크. */}
          {homepageUrl && (
            <div className={`flex items-start gap-2 ${flashClass('homepage')}`} data-refreshed={flashAttr('homepage')}>
              <Globe size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">
                  {t(homepageIsExternalChannel ? 'card.externalChannel' : 'card.website')}
                </span>
                <a
                  href={homepageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold-deep hover:text-gold underline font-bold tracking-tight"
                >
                  {homepageHost}
                </a>
              </div>
            </div>
          )}

          {/* TourAPI의 대표·취급 메뉴 — 근거가 있는 항목만 최대 5개. */}
          {firstMenuTokens.length > 0 && (
            <div className="flex items-start gap-2">
              <Utensils size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.signatureMenu')}</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {firstMenuTokens.map((menu) => (
                    <span key={menu} className="rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-muk">
                      {menu}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Rating/Reviews — 실제 데이터가 있을 때만. 별점/리뷰수는 지어내지 않는다. */}
          {(placeInfo?.rating != null || placeInfo?.reviewCount != null || placeInfo?.url) && (
            <div className="flex items-center gap-2">
              {placeInfo?.rating != null && (
                <div className="flex items-center text-gold">
                  <Star size={14} className="fill-gold mr-0.5" />
                  <span className="font-extrabold text-muk">{placeInfo.rating}</span>
                </div>
              )}
              {placeInfo?.rating != null && placeInfo?.reviewCount != null && (
                <span className="text-muk-soft/40">|</span>
              )}
              {placeInfo?.reviewCount != null && (
                <span className="text-muk-soft">{t('card.reviewCount', { n: placeInfo.reviewCount })}</span>
              )}

              {placeInfo?.url && (
                <a
                  href={placeInfo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-gold-deep hover:text-gold underline font-bold tracking-tight"
                >
                  {t('card.viewReviews')}
                </a>
              )}
            </div>
          )}

          {/* 추천 사유 — 관광객이 얻는 것(걷는 시간·대기)만. 첫 줄이 화살표 비교일 때만 '대신' 문장을 쓴다. */}
          {shownReason && (
            <p className="text-[13px] leading-relaxed text-muk bg-gold/10 border border-gold/25 rounded-2xl px-3.5 py-2.5">
              💡 {shownReason}
            </p>
          )}

          {/* '추천 근거 자세히' — 닫힌 채로 시작한다. SPOT 타일·출발/도착 타임라인·근거 칩(신선도 표 하나)·주변 붐빔
              근거·축제 보정 같은 순위 사정은 여기 안에만 있다(PM 규칙: 관광객 화면 앞에는 혜택만). */}
          {hasSpotMetrics && (
            <div id={`${whyPanelId}-box`} className="rounded-2xl border border-line">
              <button
                type="button"
                onClick={() => {
                  const next = !whyOpen;
                  setWhyOpen(next);
                  if (next) revealInScroller(`${whyPanelId}-box`, 'start');
                }}
                aria-expanded={whyOpen}
                aria-controls={whyPanelId}
                data-testid="why-toggle"
                className="flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-left text-[12px] font-bold text-muk hover:bg-hanji-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                <span>{t('card.whyToggle')}</span>
                {whyOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
              </button>
              {whyOpen && (
              <div id={whyPanelId} className="space-y-3 border-t border-line px-3 pb-3 pt-3" data-testid="why-panel">

              {/* 1위의 '추천 이유'(가치 문장과 같은 말이라 얼굴에서 뺐다). */}
              {spotComparisonReason && !spotReasonOnFace && (
                <div className="rounded-xl border border-jade/20 bg-jade/5 px-3 py-2">
                  <p className="text-[10px] font-extrabold text-jade">{t('recommend.spotComparison.current')}</p>
                  <p className="mt-0.5 text-[11px] font-semibold leading-snug text-muk">{spotComparisonReason}</p>
                </div>
              )}

              {/* SPOT 타일 — 보여 줄 대기가 있으면 '총 소요 시간 = 대기 + 이동', 없으면 '도보 시간' 하나. */}
              <div className="flex gap-2">
                <div className="flex-1 bg-gradient-to-br from-gold/10 to-gold/5 border border-gold/20 rounded-2xl p-3 flex flex-col justify-center relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-2 opacity-20">
                    <Clock size={24} className="text-gold" />
                  </div>
                  <span className="text-muk-soft text-[10px] font-semibold mb-1">{t(waitMins !== null ? 'card.totalTime' : 'card.walkTime')}</span>
                  <div className="flex items-baseline gap-1 mb-1.5">
                    <span className="text-2xl font-black text-muk">{times.totalMin}</span>
                    <span className="text-xs text-muk-soft font-medium">{t('card.minute')}</span>
                  </div>
                  {waitMins !== null && (
                    <div className="flex items-center gap-2 text-[10px] text-muk-soft font-medium">
                      <span className="bg-gold/15 px-1.5 py-0.5 rounded text-gold-deep whitespace-nowrap">{t('card.wait', { n: waitMins })}</span>
                      <span className="text-muk-soft/60">+</span>
                      <span className="bg-jade/15 px-1.5 py-0.5 rounded text-jade whitespace-nowrap">{t('card.travel', { n: displayedTravelMins })}</span>
                    </div>
                  )}
                  {travelSource && (
                    <span className="mt-1 text-[11px] font-semibold text-muk-soft">
                      {t(travelSource === 'osm_pedestrian' ? 'card.travelRoute' : 'card.travelEstimate')}
                    </span>
                  )}
                </div>
                <div className="w-[110px] bg-hanji-deep border border-line rounded-2xl p-3 flex flex-col justify-center items-center text-center">
                  <span className="text-muk-soft text-[10px] font-semibold mb-1">{t('card.prefMatch')}</span>
                  <div className="flex items-baseline gap-0.5 mb-1">
                    {/* 정수 값일 때만 카운트업(소수 값은 반올림이 표기를 바꾸므로 원본 그대로) */}
                    <span className="text-xl font-black text-jade">
                      {typeof preferencePercent === 'number' && Number.isInteger(preferencePercent)
                        ? animatedPreference
                        : preferencePercent}
                    </span>
                    <span className="text-xs text-jade/80 font-bold">%</span>
                  </div>
                  <span className="text-[10px] text-muk-soft mt-0.5 line-clamp-2">{t('card.prefBasis')}</span>
                </div>
              </div>

              {/* 출발 → 도착 → (대기 뒤) 이용 타임라인 */}
              {currentTime && arrivalTime && (
                <div className="bg-hanji-deep border border-line rounded-2xl px-4 py-3 flex flex-col gap-3">
                  <div className="flex items-start justify-between relative mt-1">
                    <div className="absolute top-[3px] left-4 right-4 h-[2px] bg-line z-0" />
                    <div className={`absolute top-[-10px] ${serviceTime ? 'left-[25%]' : 'left-1/2'} -translate-x-1/2 z-10`}>
                      <span className="text-[10px] font-medium text-jade bg-hanji-deep px-1.5 py-0.5 rounded border border-jade/25 whitespace-nowrap">{t('card.travel', { n: displayedTravelMins })}</span>
                    </div>
                    {serviceTime && waitMins !== null && <div className="absolute top-[-10px] left-[75%] -translate-x-1/2 z-10">
                      <span className="text-[10px] font-medium text-gold-deep bg-hanji-deep px-1.5 py-0.5 rounded border border-gold/25 whitespace-nowrap">{t('card.wait', { n: waitMins })}</span>
                    </div>}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-gold ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(currentTime)}</span>
                      <span className="text-[10px] text-muk-soft mt-0.5">{t('card.depart')}</span>
                    </div>
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-jade ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(arrivalTime)}</span>
                      <span className="text-[10px] text-muk-soft mt-0.5">{t('card.arrive')}</span>
                    </div>
                    {serviceTime && <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-gold ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(serviceTime)}</span>
                      <span className="text-[10px] text-muk-soft mt-0.5">{facilityType === 'restaurant' || facilityType === 'cafe' ? t('card.dine') : t('card.view')}</span>
                    </div>}
                  </div>
                </div>
              )}

              {/* 근거 칩 — 혼잡 판정(얼굴에 두지 않은 추정·주변 등급) + 신선도 표 하나(I10 one-stamp). */}
              {facility && (crowdChipData && !crowdChipOnFace || freshnessStamp || availabilityEvidence || (facility.currentCount != null && facility.capacity != null)) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {crowdChipData && !crowdChipOnFace && crowdChip(true)}
                  {freshnessStamp && (
                    <span className="rounded-md border border-dashed border-line bg-transparent px-2 py-0.5 text-[10px] font-medium text-muk-soft">
                      {freshnessStamp}
                    </span>
                  )}
                  {facility.currentCount != null && facility.capacity != null && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-hanji-deep border border-line text-muk-soft">
                      {t('card.remainingLabel')}: {t('card.remainingValue', {
                        seats: Math.max(0, facility.capacity - facility.currentCount),
                        total: facility.capacity,
                      })}
                    </span>
                  )}
                  {availabilityEvidence && availabilityFreshness && (
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
                      availabilityEvidence.status === 'open'
                        ? 'bg-jade/10 border-jade/25 text-jade'
                        : 'bg-terracotta/10 border-terracotta/25 text-terracotta'
                    }`}>
                      {t(
                        availabilityEvidence.evidenceTier === 'corroborated'
                          ? 'card.availabilityCorroborated'
                          : 'card.availabilitySingle',
                        {
                          count: availabilityEvidence.corroboratingCount,
                          status: t(availabilityEvidence.status === 'open'
                            ? 'card.availabilityStatusOpen'
                            : 'card.availabilityStatusClosed'),
                          time: availabilityFreshness,
                        },
                      )}
                    </span>
                  )}
                </div>
              )}
              {facility?.placeDataSource === 'localdata' && (
                <p className="text-[10px] text-muk-soft">
                  {t('card.publicLicenseSource', {
                    date: facility.dataUpdatedAt
                      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(facility.dataUpdatedAt))
                      : t('card.sourceDateUnknown'),
                  })}
                </p>
              )}

              {/* 주변 붐빔 근거(공영주차 실측 · 관광 수요 전망) — 근거를 보고 싶은 사람만 여기서 본다. */}
              {typeof areaDemandLevel === 'number' && (
                <div className="text-[11px] leading-snug text-sky-800 bg-sky-500/10 border border-sky-500/20 rounded-xl px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">
                      {areaDemandTourismEvidence
                        ? t('recommend.areaEvidenceCount', { n: evidenceCount })
                        : areaDemandParkingEvidence
                          ? `${t(areaDemandParkingEvidence.mode === 'forecast'
                            ? 'recommend.parkingEvidenceForecast'
                            : 'recommend.parkingEvidenceLive')}: ${congestionLabel(areaDemandParkingEvidence.level)}`
                          : `${t('recommend.areaDemand')}: ${congestionLabel(areaDemandLevel)}`}
                    </span>
                    {demandDisclosure.showQualitativeLevel && <span className="text-[10px] text-sky-700">
                      {t(areaDemandMode === 'live'
                        ? 'recommend.areaDemandLive'
                        : areaDemandMode === 'forecast'
                          ? 'recommend.areaDemandForecast'
                          : 'recommend.areaDemandStats')}
                    </span>}
                  </div>
                  {demandDisclosure.showQualitativeLevel && arrivalAction && (
                    <p className="mt-1.5 font-extrabold text-sky-900">
                      {t(`recommend.arrivalAction.${arrivalAction}`, {
                        n: recommendedDepartureDelayMinutes ?? 30,
                      })}
                    </p>
                  )}
                  {demandDisclosure.showQualitativeLevel && areaDemandDistinguishable && areaDemandRank && areaDemandComparableCount && (
                    <p className="mt-1 text-sky-800">
                      {t(areaDemandRank === 1 ? 'recommend.areaDemandRankTop' : 'recommend.areaDemandRank', {
                        rank: areaDemandRank,
                        total: areaDemandComparableCount,
                      })}
                      {typeof areaDemandDeltaVsMedian === 'number' && areaDemandDeltaVsMedian <= -0.08
                        ? ` · ${t('recommend.areaDemandLower', { n: Math.round(Math.abs(areaDemandDeltaVsMedian) * 100) })}`
                        : ''}
                    </p>
                  )}
                  {demandDisclosure.showQualitativeLevel && arrivalAction === 'wait_then_go' && typeof delayedAreaDemandLevel === 'number' && (
                    <p className="mt-1 text-sky-800">
                      {t('recommend.delayedDemand', {
                        n: recommendedDepartureDelayMinutes ?? 30,
                        level: congestionLabel(delayedAreaDemandLevel),
                      })}
                    </p>
                  )}
                  {areaDemandTourismEvidence && (
                    <p className="mt-1 text-sky-800/80">{t('recommend.areaDemandCompositeHint')}</p>
                  )}
                  {areaDemandParkingEvidence && (
                    <div className="mt-2 rounded-lg border border-sky-500/20 bg-white/55 px-2.5 py-2">
                      <p className="font-bold text-sky-900">
                        {t(areaDemandParkingEvidence.mode === 'live'
                          ? 'recommend.parkingEvidenceLive'
                          : 'recommend.parkingEvidenceForecast')}: {congestionLabel(areaDemandParkingEvidence.level)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-sky-700">
                        {typeof areaDemandParkingEvidence.radiusM === 'number'
                          ? t('recommend.parkingEvidenceRadius', { n: areaDemandParkingEvidence.radiusM.toLocaleString() })
                          : t('recommend.parkingEvidenceArea')}
                        {areaFreshness ? ` · ${areaFreshness}` : ''}
                      </p>
                    </div>
                  )}
                  {areaDemandTourismEvidence && (
                    <div className="mt-2 rounded-lg border border-indigo-500/20 bg-white/55 px-2.5 py-2 text-indigo-900">
                      <p className="font-bold">
                        {typeof areaDemandTourismEvidence.relativeIndex === 'number'
                          ? t('recommend.tourismEvidenceIndex', { n: Math.round(areaDemandTourismEvidence.relativeIndex) })
                          : t('recommend.tourismEvidenceTitle')}
                      </p>
                      <p className="mt-0.5 text-[10px] text-indigo-700">
                        {t('recommend.tourismEvidenceBasis', {
                          name: areaDemandTourismEvidence.referenceName ?? t('recommend.tourismReferenceUnknown'),
                          distance: typeof areaDemandTourismEvidence.distanceM === 'number'
                            ? Math.round(areaDemandTourismEvidence.distanceM).toLocaleString()
                            : '-',
                          date: areaDemandTourismEvidence.forecastDate ?? '-',
                        })}
                      </p>
                      <p className="mt-1 text-[10px] text-indigo-700/90">
                        {t('recommend.tourismEvidenceDisclaimer')}
                      </p>
                    </div>
                  )}
                  {!!areaDemandSources?.some((source) => source === 'festival' || source === 'weather') && (
                    <p className="mt-1 text-[10px] text-sky-700">
                      {areaDemandSources
                        .filter((source) => source !== 'parking' && source !== 'parking_history' && source !== 'tourism')
                        .map((source) => t(`recommend.areaSource.${source}`)).join(' · ')}
                    </p>
                  )}
                  {areaDemandConfidence && areaDemandConfidence !== 'none' && (
                    <p className="mt-1 text-[10px] text-sky-700">
                      {t(`recommend.areaConfidence.${areaDemandConfidence}`)}
                    </p>
                  )}
                </div>
              )}

              {/* A4: 행사 혼잡 보정 — 도착시점 인근 진행 중 축제로 예측이 가중됐을 때만. */}
              {(eventBoost ?? 0) > 0 && (
                <p className="text-[11px] leading-snug text-terracotta bg-terracotta/10 border border-terracotta/20 rounded-xl px-3 py-2">
                  🎪 {t('recommend.festivalAdjusted', {
                    title: eventTitle ?? '',
                    pct: Math.round((eventBoost ?? 0) * 100),
                  })}
                </p>
              )}

              {/* 골든타임 알리미 — 근거를 연 사람에게만(펼치기 전에는 서버를 부르지 않는다 — 계획 3.2 호출 예산). */}
              {facility?.id && <GoldenHourBadge facilityId={facility.id} />}

              {/* 최적 방문 시각 — 오늘 24시간 예측 혼잡 미니 막대(백엔드 성공 시에만). 가장 한산한 시각을 옥(jade)으로 강조. */}
              {dayPred && (
                <div className="border-t border-line/70 pt-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Clock size={13} className="text-gold-deep flex-shrink-0" />
                    <span className="text-[11px] font-bold text-muk">{t('card.todayForecast')}</span>
                  </div>
                  <div
                    className="flex items-end gap-[2px] h-10"
                    role="img"
                    aria-label={t('card.forecastAria', { time: formatKoreanHour(dayPred.bestHour) })}
                  >
                    {dayPred.hours.map((h) => {
                      const isBest = h.hour === dayPred.bestHour;
                      return (
                        <div
                          key={h.hour}
                          className="flex-1 flex items-end h-full"
                          title={`${formatKoreanHour(h.hour)} · ${congestionLabel(h.congestion)}`}
                        >
                          <div
                            aria-hidden="true"
                            className={`w-full rounded-sm transition-colors ${isBest ? 'bg-jade' : 'bg-gold/35'}`}
                            style={{ height: `${Math.max(8, Math.round(h.congestion * 100))}%` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between mt-1 text-[10px] text-muk-soft/70 font-medium" aria-hidden="true">
                    <span>{t('card.oClock', { h: 0 })}</span>
                    <span>{t('card.oClock', { h: 6 })}</span>
                    <span>{t('card.oClock', { h: 12 })}</span>
                    <span>{t('card.oClock', { h: 18 })}</span>
                    <span>{t('card.oClock', { h: 23 })}</span>
                  </div>
                  <p className="text-[11px] text-jade font-bold mt-2 flex items-center gap-1">
                    <Sparkles size={11} className="text-jade flex-shrink-0" />
                    {t('card.bestTime', { time: formatKoreanHour(dayPred.bestHour) })}
                  </p>
                </div>
              )}
              </div>
              )}
            </div>
          )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>

      <AnimatePresence>
        {hoursPromptOpen && (
          <motion.div
            ref={hoursPromptRef}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="rounded-2xl border border-gold/30 bg-gold/10 p-3"
            role="group"
            aria-label={t('card.hoursCheckQuestion')}
          >
            <p className="text-xs font-extrabold text-muk">{t('card.hoursCheckQuestion')}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muk-soft">{t('card.hoursCheckPrivacy')}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <button type="button" disabled={hoursSubmitting} onClick={() => void submitHoursStatus('open')} className="rounded-xl bg-jade px-2 py-2 text-[11px] font-bold text-white disabled:opacity-50">
                {t('card.hoursOpen')}
              </button>
              <button type="button" disabled={hoursSubmitting} onClick={() => void submitHoursStatus('closed')} className="rounded-xl bg-terracotta px-2 py-2 text-[11px] font-bold text-white disabled:opacity-50">
                {t('card.hoursClosed')}
              </button>
              <button type="button" disabled={hoursSubmitting} onClick={() => { setHoursPromptOpen(false); setHoursSubmitError(false); }} className="rounded-xl border border-line bg-white px-2 py-2 text-[11px] font-bold text-muk-soft disabled:opacity-50">
                {t('card.hoursUnsure')}
              </button>
            </div>
            {hoursSubmitError && <p className="mt-2 text-[10px] font-semibold text-terracotta">{t('card.hoursReportFailed')}</p>}
          </motion.div>
        )}
      </AnimatePresence>

          </div>
          </div>{/* /내부 스크롤 래퍼 — 버튼 두 줄은 아래에 바닥 고정 */}
          {scrollEdges.up && <div aria-hidden className="rec-fade-top pointer-events-none absolute inset-x-0 top-0 h-5" />}
          {scrollEdges.down && <div aria-hidden className="rec-fade-bottom pointer-events-none absolute inset-x-0 bottom-0 h-6" />}
          </div>

      {/* 바닥 버튼 두 줄(I31): [관심 없어요][나중에 볼게요][도보 길안내] / [자동차 길안내][혼잡 제보] */}
      <div className="flex shrink-0 gap-2 pt-1">
          <motion.button
            onClick={() => { haptic('selection'); onReject(); }}
            whileTap={tapMotion}
            transition={interactionSpring}
            aria-label={t('card.rejectAria')}
            className="min-h-11 flex-1 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-2.5 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            {t('card.reject')}
          </motion.button>
          {onPutOff && (
            <motion.button
              onClick={() => {
                haptic('confirm');
                setConfirmedAction('saved');
                onPutOff();
              }}
              whileTap={tapMotion}
              transition={interactionSpring}
              aria-label={t('card.putOffAria')}
              className="group min-h-11 flex-1 flex items-center justify-center gap-1.5 bg-hanji-deep hover:bg-gold/10 hover:text-gold-deep hover:border-gold/30 text-muk-soft font-bold py-2.5 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              {/* 저장 인지 강화용 북마크 — hover/press 시 채워지며 살짝 팝(순수 Tailwind, 과하지 않게) */}
              {confirmedAction === 'saved'
                ? <Check size={14} className="text-jade" aria-hidden />
                : <Bookmark size={14} className="fill-transparent transition-all duration-300 group-hover:fill-gold group-hover:scale-110 group-active:scale-125" />}
              {t('card.putOff')}
            </motion.button>
          )}
          <motion.button
            onClick={handleAcceptClick}
            whileTap={tapMotion}
            transition={interactionSpring}
            aria-label={t('card.acceptAria')}
            className="min-h-11 flex-1 cta-primary font-bold py-2.5 rounded-2xl transition-all active:scale-95 text-xs shadow-[0_4px_14px_rgba(168,70,47,0.28)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <span className="inline-flex items-center justify-center gap-1.5">
              {confirmedAction === 'accepted' && <Check size={14} aria-hidden />}
              {t('card.accept')}
            </span>
          </motion.button>
        </div>
        {(needsHoursConfirmation && kakaoPlaceUrl) || onDrive || facility?.id ? (
          <div className="flex shrink-0 items-center gap-2">
            {needsHoursConfirmation && kakaoPlaceUrl ? (
              <p className={`min-w-0 flex-1 text-[11px] font-medium leading-snug ${likelyClosedUnknown ? 'text-terracotta' : 'text-muk-soft'}`}>
                {t('card.checkHoursKakaoHint')}
              </p>
            ) : onDrive ? (
              <button type="button" onClick={onDrive} className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-white py-2 text-[12px] font-bold text-muk-soft hover:border-gold/40 hover:text-gold-deep">
                {t('card.drive')}
              </button>
            ) : <span className="flex-1" />}
            {facility?.id && (
              <CongestionReportButton
                facility={{ id: facility.id!, name: facility.name ?? title }}
                isFirst={displayCongestionSource === 'none'}
                onReported={(level) => setLocalReport({
                  level: level === '한산' ? 0.2 : level === '보통' ? 0.5 : 0.8,
                  timestamp: new Date().toISOString(),
                })}
              />
            )}
          </div>
        ) : null}
      </>
      )}
    </motion.div>
  );
}
