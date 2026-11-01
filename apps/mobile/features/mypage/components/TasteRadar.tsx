// 취향 레이더(AI 취향 프로필) — 웹 components/TasteRadar.tsx 의 앱판. recharts 대신 react-native-svg 로 8축 도형을 직접 그린다.
// 벡터: 1순위 서버 학습 벡터 → 2순위 첫 설정(온보딩) 카테고리로 만든 콜드스타트 벡터 → 3순위 균등 + '설정하러 가기'.
// 그림은 읽기 화면에 '축 이름 값/100' 목록으로 대신 알린다(그림 자체는 숨김).
import { useRouter } from 'expo-router';
import { ArrowRight, ChevronDown, Fingerprint, ThumbsDown, ThumbsUp } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Polygon, Text as SvgText } from 'react-native-svg';

import { Card, Icon, Pressable, Skeleton, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors, fontFamilies } from '~/lib/theme/tokens';

import { fetchTasteVector } from '../api';
import {
  AXIS_KEYS,
  TAG_KEYS,
  UNIFORM_VECTOR,
  axisDirection,
  categoriesFromStored,
  onboardingVector,
  polygonPoints,
  radarPoint,
  radarPolygon,
  radarValues,
  readTasteFeedback,
  tasteBadge,
  topDimensions,
  type VectorSource,
} from '../tasteCore';

interface TasteState { vector: number[]; source: VectorSource }

const SIZE = 300; // viewBox — 가로를 채우고 비율로 줄어든다(360pt 에서도 글자가 겹치지 않는 값)
const CENTER = SIZE / 2;
const RADIUS = 92;
const LABEL_RADIUS = RADIUS + 16;
const RINGS = [0.25, 0.5, 0.75, 1];

function storedOnboarding(): number[] | null {
  let raw: string | null = null;
  try { raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem('nextspot_setup_prefs') ?? null; } catch { /* 차단 */ }
  return onboardingVector(categoriesFromStored(raw));
}

export function TasteRadar() {
  const t = useT();
  const router = useRouter();
  const [taste, setTaste] = useState<TasteState | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const learned = await fetchTasteVector();
        if (learned) {
          if (!cancelled) setTaste({ vector: learned, source: 'learned' });
          return;
        }
      } catch { /* 401·네트워크 실패 → 기기 안 폴백 */ }
      if (cancelled) return;
      const onboarding = storedOnboarding();
      setTaste(onboarding ? { vector: onboarding, source: 'onboarding' } : { vector: [...UNIFORM_VECTOR], source: 'default' });
    })();
    return () => { cancelled = true; };
  }, []);

  const badge = taste
    ? tasteBadge(taste.source, taste.vector, { uniform: UNIFORM_VECTOR, onboarding: storedOnboarding() }, readTasteFeedback())
    : null;
  const values = taste ? radarValues(taste.vector) : [];
  const summary = values.map((v, i) => `${t(AXIS_KEYS[i])} ${v}`).join(', ');

  return (
    <Card className="mb-[16px]" padded={false} style={{ padding: 20 }}>
      <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
        <View className="flex-row items-center gap-[8px]">
          <Icon icon={Fingerprint} size="md" color="gold-deep" />
          <Text className="text-sm text-gold-deep" weight="bold" accessibilityRole="header">{t('taste.title')}</Text>
        </View>
        {badge ? (
          <View className={`rounded-full border px-[10px] py-[4px] ${badge === 'learned' ? 'border-gold/30 bg-gold/15' : 'border-line bg-hanji-deep'}`}>
            <Text className={`text-[11px] ${badge === 'learned' ? 'text-gold-deep' : 'text-muk-soft'}`} weight="semibold">
              {badge === 'learned' ? t('taste.badgeLearned') : t('taste.badgeOnboarding')}
            </Text>
          </View>
        ) : null}
      </View>
      <Text className="mb-[8px] mt-[4px] text-xs text-muk-soft">{t('taste.subtitle')}</Text>

      {!taste ? (
        <View className="items-center py-[16px]" accessibilityState={{ busy: true }}>
          <Skeleton width={240} height={240} radius={120} />
        </View>
      ) : (
        <>
          <View className="items-center" accessible accessibilityRole="image" accessibilityLabel={`${t('taste.radarName')}: ${summary}`}>
            <Svg width="100%" height={260} viewBox={`0 0 ${SIZE} ${SIZE}`} importantForAccessibility="no-hide-descendants">
              {RINGS.map((ratio) => (
                <Polygon
                  key={ratio}
                  points={polygonPoints(AXIS_KEYS.map((_, i) => radarPoint(i, AXIS_KEYS.length, ratio, CENTER, CENTER, RADIUS)))}
                  fill="none"
                  stroke={colors.line}
                  strokeWidth={1}
                />
              ))}
              <Polygon
                points={polygonPoints(radarPolygon(values, CENTER, CENTER, RADIUS))}
                fill={colors.gold}
                fillOpacity={0.22}
                stroke={colors.gold}
                strokeWidth={2}
              />
              {values.map((v, i) => {
                const p = radarPoint(i, values.length, v / 100, CENTER, CENTER, RADIUS);
                return <Circle key={i} cx={p.x} cy={p.y} r={2.5} fill={colors.gold} />;
              })}
              {AXIS_KEYS.map((key, i) => {
                const d = axisDirection(i, AXIS_KEYS.length);
                const anchor = Math.abs(d.x) < 0.2 ? 'middle' : d.x > 0 ? 'start' : 'end';
                return (
                  <SvgText
                    key={key}
                    x={CENTER + d.x * LABEL_RADIUS}
                    y={CENTER + d.y * LABEL_RADIUS + 4}
                    fontSize={11}
                    fontFamily={fontFamilies.medium}
                    fill={colors['muk-soft']}
                    textAnchor={anchor}
                  >
                    {t(key)}
                  </SvgText>
                );
              })}
            </Svg>
          </View>

          {taste.source === 'default' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('taste.setupCta')}
              onPress={() => router.push('/setup' as never)}
              className="mt-[12px] min-h-[48px] flex-row items-center justify-between rounded-xl border border-gold/30 bg-gold/15 px-[16px] py-[12px]"
            >
              <Text className="mr-[8px] flex-1 text-sm" weight="medium">{t('taste.setupCta')}</Text>
              <Icon icon={ArrowRight} size="md" color="gold-deep" />
            </Pressable>
          ) : (
            <View className="mt-[4px] flex-row flex-wrap items-center justify-center gap-[8px]">
              {topDimensions(taste.vector).map((idx) => (
                <View key={idx} className="rounded-full border border-jade/30 bg-jade/15 px-[12px] py-[6px]">
                  <Text className="text-xs text-jade" weight="semibold">{t(TAG_KEYS[idx])}</Text>
                </View>
              ))}
            </View>
          )}

          <View className="mt-[16px] rounded-xl border border-line bg-hanji px-[16px] py-[12px]">
            <Text className="text-center text-xs leading-[18px] text-muk-soft">{t('taste.learnHint')}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('taste.detailsToggle')}
              accessibilityState={{ expanded: detailsOpen }}
              onPress={() => setDetailsOpen((v) => !v)}
              className="min-h-[44px] flex-row items-center justify-center gap-[4px] self-center px-[12px]"
            >
              <Text className="text-xs text-gold-deep" weight="bold">{t('taste.detailsToggle')}</Text>
              <View style={{ transform: [{ rotate: detailsOpen ? '180deg' : '0deg' }] }}>
                <Icon icon={ChevronDown} size="sm" color="gold-deep" />
              </View>
            </Pressable>
            {detailsOpen ? (
              <View className="gap-[6px]">
                <View className="flex-row items-center justify-center gap-[16px]">
                  <View className="flex-row items-center gap-[6px]">
                    <Icon icon={ThumbsUp} size="sm" color="jade" />
                    <Text className="text-xs text-jade" weight="semibold">+10%</Text>
                  </View>
                  <Text className="text-xs text-muk-soft">·</Text>
                  <View className="flex-row items-center gap-[6px]">
                    <Icon icon={ThumbsDown} size="sm" color="terracotta" />
                    <Text className="text-xs text-terracotta" weight="semibold">−5%</Text>
                  </View>
                </View>
                <Text className="text-center text-[11px] leading-[17px] text-muk-soft">{t('taste.detailsBody')}</Text>
              </View>
            ) : null}
          </View>
        </>
      )}
    </Card>
  );
}
