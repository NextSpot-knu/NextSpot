// 대안 카드 한 장 — 웹 page.tsx 의 recommendations.map 본문(기준 커밋 0d145a1).
// 사진 → 이름 줄(종류·순위·휴무 칩, 이름, 대표 메뉴, SPOT 점수) → 혜택 칩 → 주 행동 둘(도보·자동차) → 보조 행동
// (👍 👎 공유) → '추천 근거 자세히'(펼침). 순위 근거·주변 수요·추정 근거는 원할 때만.
// 옮기지 않은 것: 현장 혼잡 제보 버튼(F3 에서 더한다), 구역 근거(내부 검증 지역 전용), 음성 비서 강조(v1.1).
import { ChevronDown } from 'lucide-react-native';
import { memo, useState } from 'react';
import { View } from 'react-native';

import { ShareButton } from '~/components/ShareButton';
import { Button, Icon, Text } from '~/components/ui';
import { Pressable } from '~/components/ui/Pressable';
import { RankBadge } from '~/components/ui/RankBadge';
import type { RecommendationResponse } from '~/lib/core/apiClient';
import type { ShareOutcome } from '~/lib/platform/share';
import { spotPoints } from '~/lib/core/spotPoints';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { shadows } from '~/lib/theme/tokens';
import { congestionKey, type CongestionKey } from '@/lib/congestionScale';
import { relativeParts } from '@/lib/freshness';
import { getArrivalOpenDisplayStatus, isClosedToday } from '@/lib/restDate';

import { MiniMapPreview } from './MiniMapPreview';
import { PhotoCover } from './PhotoCover';
import { Tag } from './Tag';
import {
  assertableCongestionLevel,
  buildFallbackReason,
  needsHoursCheck,
  typeLabelKey,
  type OriginGrade,
} from './logic';
import { isStrictlyCalmer } from './origin';
import {
  congestionDisplay,
  formatEstimateTime,
  formatLastObserved,
  isBaselinePrediction,
} from './port/congestionEstimate';
import { displayWalkingMinutes } from './port/walking';
import { faceTastePercent } from './port/taste';

const LEVEL_BUCKETS = (level: number): CongestionKey =>
  level >= 0.75 ? 'busy' : level >= 0.5 ? 'moderate' : level >= 0.25 ? 'relaxed' : 'quiet';

export interface AlternativeCardProps {
  rec: RecommendationResponse;
  index: number;
  busyAt: number;
  originGrade: OriginGrade;
  tastePeers: number[];
  /** 'Top 3 비교' 한 줄(없으면 칸을 그리지 않는다). */
  spotComparison?: string;
  vote?: 'up' | 'down';
  hoursOpen: boolean;
  hoursSubmitting: boolean;
  hoursSubmitError: boolean;
  /** 2열 배치일 때 카드 폭(%) — 1열이면 undefined(꽉 채움). */
  widthPct?: number;
  onAccept(rec: RecommendationResponse, mode: 'walk' | 'car'): void;
  onVote(rec: RecommendationResponse, vote: 'up' | 'down'): void;
  /** 공유 결과를 돌려준다 — 복사 ✓·실패 토스트는 ShareButton 이 띄운다. */
  onShare(rec: RecommendationResponse): Promise<ShareOutcome>;
  /** 공유 실패 토스트 아래에 보일 주소. */
  shareUrl?: string;
  onHoursAnswer(rec: RecommendationResponse, status: 'open' | 'closed'): void;
  onHoursDismiss(): void;
}

function AlternativeCardImpl(props: AlternativeCardProps) {
  const { rec, index, busyAt, originGrade, tastePeers, spotComparison, vote } = props;
  const { t, locale } = useI18n();
  const [whyOpen, setWhyOpen] = useState(false);

  const rawWait = rec.breakdown?.waitTime;
  const hasWait = typeof rawWait === 'number';
  const waitTime = hasWait ? String(Math.max(1, Math.round(rawWait))) : '--';
  const travelTime = displayWalkingMinutes(rec.breakdown?.travelTime, rec.distanceM);
  const arrivalStatus = rec.openStatusAtArrival
    ? getArrivalOpenDisplayStatus(rec.openStatusAtArrival, rec.facility.type, new Date(Date.now() + travelTime * 60_000))
    : null;
  const preferencePct = Math.round((rec.breakdown?.preference || 0) * 100);
  const faceTaste = faceTastePercent(preferencePct, tastePeers);
  const couponPct = Math.round(Math.max(0, Math.min(1, rec.facility.couponRate ?? 0)) * 100);
  const features = rec.facility.features as Record<string, unknown> | null | undefined;
  const firstMenuRaw = (features?.firstMenu ?? features?.first_menu) as string | undefined;
  const firstMenuTokens = firstMenuRaw
    ? firstMenuRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2)
    : [];
  const closedToday = isClosedToday((features?.restDateRaw ?? features?.rest_date_raw) as string | undefined) === true;
  const freshness = relativeParts(rec.congestionTimestamp);

  // 무엇을 '지금' 으로 칠할지 — 추천 카드·코스와 같은 함수(congestionDisplay)로 정한다.
  const display = congestionDisplay(rec);
  const estimate = display.estimate;
  const lastObserved = display.lastObserved;
  const shownLevel = display.mode === 'measured' || display.mode === 'predicted' ? display.level : null;
  const estimateKey = estimate ? congestionKey(estimate.level, busyAt) : null;
  const estimateOnFace = estimateKey !== null && isStrictlyCalmer(estimateKey, originGrade?.key ?? null);
  const freshnessText = freshness
    ? freshness.unit === 'now'
      ? t('freshness.justNow')
      : freshness.unit === 'min'
        ? t('freshness.minAgo', { n: freshness.value })
        : freshness.unit === 'hour'
          ? t('freshness.hourAgo', { n: freshness.value })
          : t('freshness.dayAgo', { n: freshness.value })
    : null;
  const localizedReason = buildFallbackReason(
    t,
    rec.facility.name,
    typeof rec.breakdown?.waitTime === 'number' ? rec.breakdown.waitTime : null,
    rec.distanceM,
    assertableCongestionLevel(rec),
  );
  // 서버 사유는 한국어 한 벌뿐이다 — 다른 언어에서는 그 언어로 만든 문장만 쓴다.
  const displayReason = locale === 'ko' && rec.reason ? rec.reason : localizedReason;
  const measuredKey = display.mode === 'measured' && shownLevel !== null ? congestionKey(shownLevel, busyAt) : null;
  const predictedKey = display.mode === 'predicted' && shownLevel !== null ? congestionKey(shownLevel, busyAt) : null;
  const predictedBaseline = predictedKey !== null && isBaselinePrediction(rec);
  const predictedLabel =
    predictedKey === null
      ? null
      : predictedBaseline
        ? t('card.baselineLevel', { label: t(`congestion.${predictedKey}`) })
        : `${t('map.forecast')} · ${t(`congestion.${predictedKey}`)}`;
  const measuredOnFace = measuredKey !== null && isStrictlyCalmer(measuredKey, originGrade?.key ?? null);
  const predictedOnFace =
    predictedKey !== null && !predictedBaseline && isStrictlyCalmer(predictedKey, originGrade?.key ?? null);
  const waitOnFace = display.mode !== 'none' && !estimate && hasWait;
  const toneOf = (key: CongestionKey) => (key === 'busy' ? 'terracotta' : key === 'moderate' ? 'gold' : 'jade');

  const showEvidenceRow =
    !!estimate ||
    !!lastObserved ||
    display.mode === 'none' ||
    (display.mode === 'measured' && rec.congestionIsStale) ||
    (measuredKey && !measuredOnFace) ||
    (predictedKey && !predictedOnFace);

  const area = rec.breakdown;
  const parking = area?.areaDemandParkingEvidence;
  const tourism = area?.areaDemandTourismEvidence;
  const hoursHint = needsHoursCheck(rec) && !props.hoursOpen;
  const spot = spotPoints(rec.spotScore);
  const whyLabel = t('card.whyToggle');

  return (
    <View
      testID="alt-card"
      className="gap-[12px] rounded-2xl border border-line bg-white p-[16px]"
      style={[{ boxShadow: shadows.surface }, props.widthPct ? { width: `${props.widthPct}%` } : null]}
    >
      {/* 순위 배지 — 카드 모서리 밖 -8/-8, 사진 위(웹 absolute -top-2 -left-2 z-10). 카드는 overflow visible. */}
      <RankBadge rank={index + 1} style={{ position: 'absolute', top: -8, left: -8 }} />
      <PhotoCover facility={rec.facility} />

      {/* 이름 줄 */}
      <View className="flex-row items-start justify-between gap-[12px]">
        <View className="min-w-0 flex-1">
          <View className="flex-row flex-wrap items-center gap-[6px]">
            <Tag tone="jade">{t(typeLabelKey(rec.facility.type))}</Tag>
            {rec.rank ? (
              <Tag tone="gold">{t(rec.rank === 1 ? 'card.rankBadgeTop' : 'card.rankBadge', { rank: rec.rank })}</Tag>
            ) : null}
            {closedToday ? <Tag tone="terracotta">{t('card.closedToday')}</Tag> : null}
          </View>
          <Text className="mt-[6px] text-[22px] font-extrabold leading-[30.25px] tracking-[-0.55px] text-muk" accessibilityRole="header">
            {rec.facility.name}
          </Text>
          {firstMenuTokens.length > 0 ? (
            <Text className="mt-[4px] text-[12px] text-muk-soft">
              <Text className="font-bold text-gold-deep">{t('card.signatureMenu')}</Text>
              {' · '}
              {firstMenuTokens.join(' · ')}
            </Text>
          ) : null}
        </View>
        <View
          className="shrink-0 items-center justify-center rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]"
          style={{ boxShadow: '0px 2px 10px rgba(193, 154, 62, 0.16)' }}
          accessible
          accessibilityLabel={`${t('recommend.spotIndex')} ${spot}${t('card.pointSuffix')}`}
        >
          <Text className="text-[10px] font-bold uppercase tracking-[0.25px] text-muk-soft">{t('recommend.spotIndex')}</Text>
          <Text className="mt-[4px] text-[16px] font-extrabold leading-[16px] text-gold-deep">
            {spot}
            {t('card.pointSuffix')}
          </Text>
        </View>
      </View>

      {/* 혜택 칩 */}
      <View testID="alt-benefits" className="flex-row flex-wrap items-center gap-[6px]">
        <Tag tone="jade" size="chip">{`🚶 ${t('compare.benefitWalk', { walk: travelTime })}`}</Tag>
        {arrivalStatus && arrivalStatus !== 'needs_confirmation' ? (
          <Tag
            size="chip"
            tone={
              arrivalStatus === 'open_expected'
                ? 'jade'
                : arrivalStatus === 'closing_soon' || arrivalStatus === 'likely_closed_unknown'
                  ? 'terracotta'
                  : 'soft'
            }
          >
            {t(`card.arrivalStatus.${arrivalStatus}`)}
          </Tag>
        ) : null}
        {waitOnFace ? (
          <Tag tone="gold" size="chip">{`⏱ ${t('recommend.expectedWait')} ${t('recommend.minutesValue', { n: waitTime })}`}</Tag>
        ) : null}
        {measuredKey && measuredOnFace ? (
          <Tag tone="jade" size="chip">{`${t('card.congestion')}: ${t(`congestion.${measuredKey}`)}`}</Tag>
        ) : null}
        {predictedKey && predictedOnFace ? <Tag tone="jade" size="chip">{predictedLabel ?? ''}</Tag> : null}
        {estimate && estimateKey && estimateOnFace ? (
          <Tag tone={estimateKey === 'moderate' ? 'gold' : 'jade'} size="chip" dashed surface="none">
            {t('card.estimateLevel', { label: t(`congestion.${estimateKey}`) })}
          </Tag>
        ) : null}
        {faceTaste !== null ? (
          <Tag tone="gold" size="chip">{`${t('recommend.prefMatch')} ${faceTaste}%`}</Tag>
        ) : null}
        {couponPct >= 1 ? (
          <Tag tone="terracotta" size="chip">{`⚡ ${t('recommend.spotComparison.coupon', { n: couponPct })}`}</Tag>
        ) : null}
      </View>

      {hoursHint ? (
        <Text
          testID="alt-hours-hint"
          className={`text-[12px] font-medium leading-[16.5px] ${arrivalStatus === 'likely_closed_unknown' ? 'text-terracotta' : 'text-muk-soft'}`}
        >
          {t('card.checkHoursKakaoHint')}
        </Text>
      ) : null}

      {/* 영업 중인가요? */}
      {props.hoursOpen ? (
        <View
          className="rounded-2xl border border-gold/30 bg-gold/10 p-[12px]"
          accessibilityRole="none"
          accessibilityLabel={t('card.hoursCheckQuestion')}
        >
          <Text className="text-xs font-extrabold text-muk">{t('card.hoursCheckQuestion')}</Text>
          <Text className="mt-[4px] text-[11px] leading-[17.875px] text-muk-soft">{t('card.hoursCheckPrivacy')}</Text>
          <View className="mt-[12px] flex-row gap-[8px]">
            <Pressable
              accessibilityRole="button"
              disabled={props.hoursSubmitting}
              onPress={() => props.onHoursAnswer(rec, 'open')}
              className={`min-h-[44px] flex-1 items-center justify-center rounded-xl bg-jade px-[8px] py-[8px] ${props.hoursSubmitting ? 'opacity-50' : ''}`}
            >
              <Text className="text-center text-[11px] font-bold text-white">{t('card.hoursOpen')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={props.hoursSubmitting}
              onPress={() => props.onHoursAnswer(rec, 'closed')}
              className={`min-h-[44px] flex-1 items-center justify-center rounded-xl bg-terracotta px-[8px] py-[8px] ${props.hoursSubmitting ? 'opacity-50' : ''}`}
            >
              <Text className="text-center text-[11px] font-bold text-white">{t('card.hoursClosed')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={props.hoursSubmitting}
              onPress={props.onHoursDismiss}
              className={`min-h-[44px] flex-1 items-center justify-center rounded-xl border border-line bg-white px-[8px] py-[8px] ${props.hoursSubmitting ? 'opacity-50' : ''}`}
            >
              <Text className="text-center text-[11px] font-bold text-muk-soft">{t('card.hoursUnsure')}</Text>
            </Pressable>
          </View>
          {props.hoursSubmitError ? (
            <Text className="mt-[8px] text-[10px] font-semibold text-terracotta" accessibilityLiveRegion="polite">
              {t('card.hoursReportFailed')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* 주 행동 둘 — 도보 길안내(주, 13px · 모서리 12 · shadow-sm) · 자동차 길안내(보조, 12px 먹 연) */}
      <View className="flex-row gap-[8px]">
        <View className="flex-1 rounded-xl" style={{ boxShadow: '0px 1px 3px rgba(0, 0, 0, 0.1), 0px 1px 2px -1px rgba(0, 0, 0, 0.1)' }}>
          <Button
            label={t('card.accept')}
            onPress={() => props.onAccept(rec, 'walk')}
            size={44}
            labelSize={13}
            shape="xl"
            paddingX={8}
            shadow="none"
            block
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('card.drive')}
          onPress={() => props.onAccept(rec, 'car')}
          className="min-h-[44px] flex-1 items-center justify-center rounded-xl border border-line bg-white px-[8px] py-[8px]"
        >
          <Text className="text-center text-[12px] leading-[15px] text-muk-soft" weight="bold">
            {t('card.drive')}
          </Text>
        </Pressable>
      </View>

      {/* 보조 행동 — 👍 👎 (혼잡 제보는 F3) 공유 */}
      <View className="flex-row flex-wrap items-center gap-[6px]">
        {vote ? (
          <Text className="min-h-[44px] px-[4px] py-[12px] text-[11px] font-semibold text-jade" accessibilityLiveRegion="polite">
            {`${vote === 'up' ? '👍' : '👎'} ${t('recommend.feedbackApplied')}`}
          </Text>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('recommend.feedbackUpAria')}
              onPress={() => props.onVote(rec, 'up')}
              className="min-h-[44px] justify-center rounded-lg border border-line bg-hanji-deep px-[10px]"
            >
              <Text className="text-[11px] font-semibold text-muk-soft">{`👍 ${t('recommend.like')}`}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('recommend.feedbackDownAria')}
              onPress={() => props.onVote(rec, 'down')}
              className="min-h-[44px] justify-center rounded-lg border border-line bg-hanji-deep px-[10px]"
            >
              <Text className="text-[11px] font-semibold text-muk-soft">{`👎 ${t('recommend.dislike')}`}</Text>
            </Pressable>
          </>
        )}
        <ShareButton onShare={() => props.onShare(rec)} url={props.shareUrl} className="min-h-[44px]" />
      </View>

      {/* 추천 근거 자세히 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={whyLabel}
        accessibilityState={{ expanded: whyOpen }}
        onPress={() => setWhyOpen((open) => !open)}
        className="min-h-[44px] flex-row items-center gap-[4px] self-start rounded-full px-[8px]"
      >
        <Text className="text-[12px] font-bold text-gold-deep">{whyLabel}</Text>
        <View style={{ transform: [{ rotate: whyOpen ? '180deg' : '0deg' }] }}>
          <Icon icon={ChevronDown} size={13} color="gold-deep" />
        </View>
      </Pressable>

      {whyOpen ? (
        <View className="gap-[12px] rounded-xl border border-line bg-hanji-deep/40 p-[12px]">
          {spotComparison ? (
            <View className="rounded-xl border border-jade/20 bg-jade/5 px-[12px] py-[10px]">
              <Text className="text-[10px] font-extrabold uppercase tracking-[0.25px] text-jade">{t('recommend.spotComparison.current')}</Text>
              <Text className="mt-[2px] text-[11px] font-semibold leading-[15.125px] text-muk">{spotComparison}</Text>
            </View>
          ) : null}

          {displayReason ? (
            <Text className="rounded-xl border border-gold/20 bg-gold/10 px-[12px] py-[8px] text-[11px] leading-[15.125px] text-muk">
              {`💡 ${displayReason}`}
            </Text>
          ) : null}

          {(rec.breakdown?.eventBoost ?? 0) > 0 ? (
            <Text className="rounded-xl border border-terracotta/20 bg-terracotta/10 px-[12px] py-[8px] text-[11px] leading-[15.125px] text-terracotta">
              {`🎪 ${t('recommend.festivalAdjusted', {
                title: rec.breakdown?.eventTitle ?? '',
                pct: Math.round((rec.breakdown?.eventBoost ?? 0) * 100),
              })}`}
            </Text>
          ) : null}

          {showEvidenceRow ? (
            <View className="flex-row flex-wrap items-center gap-[6px]">
              {measuredKey && !measuredOnFace ? (
                <Tag tone={toneOf(measuredKey)}>{`${t('card.congestion')}: ${t(`congestion.${measuredKey}`)}`}</Tag>
              ) : null}
              {predictedKey && !predictedOnFace ? (
                <Tag tone={predictedBaseline ? 'soft' : 'gold'} dashed={predictedBaseline} surface={predictedBaseline ? 'white70' : 'tone'}>
                  {predictedLabel ?? ''}
                </Tag>
              ) : null}
              {estimate && estimateKey ? (
                <>
                  <Tag tone={toneOf(estimateKey)} dashed surface="white70">{t('card.estimateLevel', { label: t(`congestion.${estimateKey}`) })}</Tag>
                  <Tag tone="soft" dashed surface="none" weight="medium">{t('card.evidenceEstimated', { time: formatEstimateTime(estimate.observedAt) ?? '—' })}</Tag>
                </>
              ) : display.mode === 'none' ? (
                <Tag tone="soft" surface="muk5">{t('card.congestionPreparing')}</Tag>
              ) : null}
              {lastObserved ? (
                <Tag tone="soft" dashed surface="none" weight="medium">
                  {typeof lastObserved.level === 'number'
                    ? t('card.lastObservedLevel', {
                        time: formatLastObserved(lastObserved.observedAt) ?? '—',
                        label: t(`congestion.${congestionKey(lastObserved.level, busyAt)}`),
                      })
                    : t('card.lastObserved', { time: formatLastObserved(lastObserved.observedAt) ?? '—' })}
                </Tag>
              ) : null}
              {display.mode === 'measured' && rec.congestionIsStale && !lastObserved ? (
                <Tag tone="soft" surface="hanjiDeep" weight="medium" faint>{t('card.freshStale')}</Tag>
              ) : null}
            </View>
          ) : null}

          {shownLevel !== null && freshnessText && !lastObserved ? (
            <Text className="text-[10px] text-muk-soft">
              {rec.congestionLogSource === 'user_report'
                ? t('card.freshReport', { rel: freshnessText })
                : t('card.freshLive', { rel: freshnessText })}
            </Text>
          ) : null}

          {rec.placeDataSource === 'localdata' ? (
            <Text className="text-[10px] text-muk-soft">
              {t('card.publicLicenseSource', {
                date: rec.dataUpdatedAt
                  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(rec.dataUpdatedAt))
                  : t('card.sourceDateUnknown'),
              })}
            </Text>
          ) : null}

          {typeof area?.areaDemandLevel === 'number' ? (
            <View className="rounded-xl border border-sky-500-web/20 bg-sky-500-web/10 px-[12px] py-[8px]">
              <View className="flex-row items-center justify-between gap-[8px]">
                <Text className="min-w-0 flex-1 text-[11px] leading-[15.125px] text-sky-800-web" weight="bold">
                  {tourism
                    ? t('recommend.areaEvidenceCount', { n: Number(!!parking) + 1 })
                    : parking
                      ? `${t(parking.mode === 'forecast' ? 'recommend.parkingEvidenceForecast' : 'recommend.parkingEvidenceLive')}: ${t(`congestion.${LEVEL_BUCKETS(parking.level)}`)}`
                      : `${t('recommend.areaDemand')}: ${t(`congestion.${LEVEL_BUCKETS(area.areaDemandLevel)}`)}`}
                </Text>
                {!tourism ? (
                  <Text className="text-[10px] text-sky-700-web">
                    {t(
                      area.areaDemandMode === 'live'
                        ? 'recommend.areaDemandLive'
                        : area.areaDemandMode === 'forecast'
                          ? 'recommend.areaDemandForecast'
                          : 'recommend.areaDemandStats',
                    )}
                  </Text>
                ) : null}
              </View>
              {tourism ? (
                <Text className="mt-[4px] text-[11px] leading-[15.125px] text-sky-800-web/80">{t('recommend.areaDemandCompositeHint')}</Text>
              ) : null}
              {parking ? (
                <View className="mt-[8px] rounded-lg border border-sky-500-web/20 bg-white/55 px-[10px] py-[8px]">
                  <Text className="text-[11px] leading-[15.125px] text-sky-900-web" weight="bold">
                    {`${t(parking.mode === 'live' ? 'recommend.parkingEvidenceLive' : 'recommend.parkingEvidenceForecast')}: ${t(`congestion.${LEVEL_BUCKETS(parking.level)}`)}`}
                  </Text>
                  <Text className="text-[10px] text-sky-700-web">
                    {typeof parking.radiusM === 'number'
                      ? t('recommend.parkingEvidenceRadius', { n: parking.radiusM.toLocaleString() })
                      : t('recommend.parkingEvidenceArea')}
                  </Text>
                </View>
              ) : null}
              {tourism ? (
                <View className="mt-[8px] rounded-lg border border-indigo-500-web/20 bg-white/55 px-[10px] py-[8px]">
                  <Text className="text-[11px] leading-[15.125px] text-indigo-900-web" weight="bold">
                    {typeof tourism.relativeIndex === 'number'
                      ? t('recommend.tourismEvidenceIndex', { n: Math.round(tourism.relativeIndex) })
                      : t('recommend.tourismEvidenceTitle')}
                  </Text>
                  <Text className="text-[10px] text-indigo-700-web">
                    {t('recommend.tourismEvidenceBasis', {
                      name: tourism.referenceName ?? t('recommend.tourismReferenceUnknown'),
                      distance:
                        typeof tourism.distanceM === 'number' ? Math.round(tourism.distanceM).toLocaleString() : '-',
                      date: tourism.forecastDate ?? '-',
                    })}
                  </Text>
                  <Text className="mt-[4px] text-[10px] text-indigo-700-web/90">{t('recommend.tourismEvidenceDisclaimer')}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <MiniMapPreview latitude={rec.facility.latitude} longitude={rec.facility.longitude} name={rec.facility.name} />

          {/* SPOT 구성 */}
          <View className="flex-row gap-[8px] border-y border-line py-[8px]">
            <View className="flex-1 items-center">
              <Text className="text-[10px] text-muk-soft">{t('recommend.prefMatch')}</Text>
              <Text className="text-[11px] font-bold text-jade">{`${preferencePct}%`}</Text>
            </View>
            {display.mode !== 'none' && !estimate && hasWait ? (
              <View className="flex-1 items-center border-x border-line">
                <Text className="text-[10px] text-muk-soft">{t('recommend.expectedWait')}</Text>
                <Text className="text-[11px] font-bold text-gold-deep">{t('recommend.minutesValue', { n: waitTime })}</Text>
              </View>
            ) : null}
            {estimate && estimateKey ? (
              <View className="flex-1 items-center border-x border-dashed border-line">
                <Text className="text-[10px] text-muk-soft">{t('course.estimateShort')}</Text>
                <Text className="text-[11px] font-bold text-muk-soft">{t(`congestion.${estimateKey}`)}</Text>
              </View>
            ) : null}
            <View className="flex-1 items-center">
              <Text className="text-[10px] text-muk-soft">{t('recommend.expectedWalk')}</Text>
              <Text className="text-center text-[11px] font-bold text-jade">
                {t('recommend.walkValue', { n: travelTime, dist: Math.round(rec.distanceM) })}
              </Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export const AlternativeCard = memo(AlternativeCardImpl);
