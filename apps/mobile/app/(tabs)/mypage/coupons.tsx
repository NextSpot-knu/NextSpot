// 내 쿠폰 — 웹 app/mypage/coupons/page.tsx. 목록 · 사용 처리(매장에서 바로 보이는 흐름이라 확인 없이) · 로딩/빈/오류/로그인 필요.
import { useRouter } from 'expo-router';
import { AlertCircle, CheckCircle2, Compass, Ticket } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Gradient, Icon, Text, toast } from '~/components/ui';
import { useLocale, useT } from '~/lib/i18n/I18nProvider';

import { fetchMyCoupons, markCouponUsed } from '~/features/mypage/api';
import { CouponSkeletons, SubScreen } from '~/features/mypage/components/parts';
import { StateCard } from '~/features/mypage/components/StateCard';
import {
  COUPON_TYPE_IDS,
  couponPercent,
  ddayBadge,
  formatCouponDate,
  type Coupon,
} from '~/features/mypage/couponCore';
import { useRemote } from '~/features/mypage/useRemote';

export default function CouponsScreen() {
  const t = useT();
  const router = useRouter();
  const [locale] = useLocale();
  // 쿠폰 첫 실패는 웹도 재시도하지 않는다(사용자가 '다시 시도').
  const { state, data, reload } = useRemote(fetchMyCoupons, { retryOnce: false });
  const [usingId, setUsingId] = useState<string | null>(null);

  const goHome = useCallback(() => router.navigate('/'), [router]);

  const onUse = useCallback(async (id: string) => {
    if (usingId) return;
    setUsingId(id);
    try {
      await markCouponUsed(id);
      toast.success(t('coupons.useSuccess'));
      reload();
    } catch (err) {
      console.warn('[coupons] 사용 처리 실패', err);
      toast.error(t('coupons.useFail'));
    } finally {
      setUsingId(null);
    }
  }, [usingId, t, reload]);

  const dateLocale = locale === 'ko' ? 'ko-KR' : locale === 'ja' ? 'ja-JP' : locale === 'zh' ? 'zh-CN' : 'en-US';
  const coupons = data ?? [];

  // 웹 coupons: main px-6 · 목록 mt-2 gap-4 · 노을 광원 top-1/4 right-1/4.
  return (
    <SubScreen glow="right">
      {state === 'loading' ? (
        <CouponSkeletons label={t('common.loading')} />
      ) : state === 'unauthenticated' ? (
        <StateCard
          icon={Ticket}
          title={t('coupons.authTitle')}
          body={t('coupons.authBody')}
          action={{ label: t('coupons.authCta'), onPress: goHome, icon: Compass }}
        />
      ) : state === 'failed' ? (
        <StateCard
          tone="error"
          icon={AlertCircle}
          title={t('coupons.errorTitle')}
          body={t('coupons.errorBody')}
          action={{ label: t('common.retry'), onPress: reload }}
        />
      ) : coupons.length === 0 ? (
        <StateCard
          icon={Ticket}
          title={t('coupons.emptyTitle')}
          body={t('coupons.emptyBody')}
          action={{ label: t('coupons.browse'), onPress: goHome, icon: Compass }}
        />
      ) : (
        <>
          <Text className="px-[4px] text-sm text-muk-soft">{t('coupons.listHint')}</Text>
          {coupons.map((coupon) => (
            <CouponCard
              key={coupon.id}
              coupon={coupon}
              busy={usingId === coupon.id}
              dateLocale={dateLocale}
              onUse={() => { void onUse(coupon.id); }}
            />
          ))}
        </>
      )}
    </SubScreen>
  );
}

function CouponCard({
  coupon,
  busy,
  dateLocale,
  onUse,
}: {
  coupon: Coupon;
  busy: boolean;
  dateLocale: string;
  onUse: () => void;
}) {
  const t = useT();
  const used = coupon.status === 'used';
  const expired = coupon.status === 'expired';
  const dimmed = used || expired;
  const pct = couponPercent(coupon.couponRate);
  const typeLabel = coupon.facilityType
    ? (COUPON_TYPE_IDS.includes(coupon.facilityType) ? t(`category.${coupon.facilityType}`) : coupon.facilityType)
    : null;
  const dday = ddayBadge(coupon);
  const name = coupon.facilityName ?? t('coupons.partner');
  const issued = coupon.issuedAt ? t('coupons.issued', { date: formatCouponDate(coupon.issuedAt, dateLocale) }) : '';
  const statusLabel = used ? t('coupons.used') : expired ? t('coupons.expired') : t('coupons.available');
  const ddayLabel = dday ? (dday.daysLeft <= 0 ? t('coupons.dDayToday') : t('coupons.dDay', { n: dday.daysLeft })) : '';

  return (
    <Card
      padded={false}
      className={`flex-row overflow-hidden ${dimmed ? 'border-line bg-hanji-deep opacity-70' : 'border-gold/40 bg-white'}`}
    >
      {/* 카드 전체를 한 요소로 묶으면 안의 '사용하기' 버튼에 VoiceOver·TalkBack 이 닿지 않는다. 쿠폰 내용은 왼쪽 할인 칸 한 요소가
          읽고(오른쪽 글자는 중복이라 숨긴다), 버튼은 따로 초점을 받는다. */}
      <View
        accessible
        accessibilityLabel={[`${pct}% ${t('coupons.discount')}`, name, typeLabel, statusLabel, ddayLabel, issued].filter(Boolean).join(', ')}
        className={`items-center justify-center overflow-hidden px-[20px] py-[16px] ${dimmed ? 'bg-muk-soft/15' : ''}`}
      >
        {dimmed ? null : <Gradient name="goldTerracotta" start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />}
        <Text className={`text-2xl leading-[24px] ${dimmed ? 'text-muk-soft' : 'text-white'}`} weight="bold">{pct}%</Text>
        <Text className={`mt-[4px] text-[10px] leading-[15px] tracking-[0.25px] ${dimmed ? 'text-muk-soft' : 'text-white'}`} weight="semibold">{t('coupons.discount')}</Text>
      </View>
      <View className="min-w-0 flex-1 justify-center gap-[4px] px-[16px] py-[12px]">
        <View className="gap-[4px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View className="flex-row flex-wrap items-center gap-[8px]">
            {typeLabel ? (
              <View className="rounded-md border border-jade/25 bg-jade/[0.12] px-[8px] py-[2px]">
                <Text className="text-[11px] text-jade" weight="semibold">{typeLabel}</Text>
              </View>
            ) : null}
            <View className="flex-row items-center gap-[4px]">
              {used ? <Icon icon={CheckCircle2} size="xs" color="muk-soft" /> : expired ? <Icon icon={AlertCircle} size="xs" color="muk-soft" /> : null}
              <Text className={`text-[11px] ${dimmed ? 'text-muk-soft' : 'text-gold-deep'}`} weight="semibold">{statusLabel}</Text>
            </View>
            {dday ? (
              <View className={`rounded-md border px-[8px] py-[2px] ${dday.urgent ? 'border-terracotta/30 bg-terracotta/[0.12]' : 'border-muk-soft/20 bg-muk-soft/10'}`}>
                <Text className={`text-[11px] ${dday.urgent ? 'text-terracotta' : 'text-muk-soft'}`} weight="bold">{ddayLabel}</Text>
              </View>
            ) : null}
          </View>
          <Text className={`text-base ${dimmed ? 'text-muk-soft' : 'text-muk'}`} weight="bold" numberOfLines={1}>{name}</Text>
          {issued ? <Text className="text-[11px] text-muk-soft">{issued}</Text> : null}
        </View>
        {!dimmed ? (
          <Button
            className="mt-[8px] self-start"
            variant="gold"
            size={30}
            labelSize={12}
            shape="lg"
            label={busy ? t('common.loading') : t('coupons.use')}
            showSpinner={false}
            loading={busy}
            onPress={onUse}
          />
        ) : null}
      </View>
    </Card>
  );
}
