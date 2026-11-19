// 내 문의 — 웹 app/mypage/inquiries/page.tsx. 문의자가 자기 문의와 관리자 답변을 보는 화면(답변이 닿는 유일한 채널).
// 실패를 '문의 없음' 으로 그리지 않고, 로그인 필요(401)는 재시도를 권하지 않는다. 화면을 열면 답변을 '봤다' 고 기록한다(마이페이지 배지 기준).
import { useRouter } from 'expo-router';
import { AlertCircle, CheckCircle2, Clock, MessageSquare } from 'lucide-react-native';
import { useEffect } from 'react';
import { View } from 'react-native';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { Card, Icon, Screen, Text } from '~/components/ui';
import { InlineLoading, InlineState } from '~/features/mypage/components/InlineState';
import { SubPageHeader } from '~/features/mypage/components/SubPageHeader';
import { useLocale, useT } from '~/lib/i18n/I18nProvider';

import { fetchMyInquiries, type InquiryItem } from '~/features/mypage/api';
import { markInquiryRepliesSeen, repliedIds } from '~/features/mypage/inquiryCore';
import { useRemote } from '~/features/mypage/useRemote';

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function InquiriesScreen() {
  const t = useT();
  const router = useRouter();
  const [locale] = useLocale();
  const { state, data, reload } = useRemote(fetchMyInquiries);
  const items = data ?? [];
  const { gap } = useNavInsets();

  useEffect(() => {
    if (state === 'ok') markInquiryRepliesSeen(repliedIds(items));
  }, [state, items]);

  const statusLabel = (status: InquiryItem['status']) =>
    status === 'resolved' ? t('inquiries.statusResolved') : status === 'in_progress' ? t('inquiries.statusInProgress') : t('inquiries.statusNew');

  // 웹은 이 화면만 문서 전체가 스크롤돼 머리도 함께 올라간다(G5b-R02) — Stack 머리 대신 스크롤 내용 맨 앞에 그린다.
  // 아래 안전 영역은 탭 막대가 맡는다(탭 안 화면).
  return (
    <Screen scroll edges={['top', 'left', 'right']} contentClassName="">
      <SubPageHeader title={t('inquiries.title')} backLabel={t('settings.backAria')} variant="bordered" />
      {/* 웹: main p-6 + 막대 여백 · max-w-md 가운데 · gap-4 */}
      <View className="w-full max-w-[448px] gap-[16px] self-center" style={{ padding: 24, paddingBottom: 24 + gap }}>
        <Text className="text-sm text-muk-soft">{t('inquiries.subtitle')}</Text>

        {state === 'loading' ? <InlineLoading label={t('inquiries.loading')} /> : null}
        {state === 'unauthenticated' ? (
          <InlineState icon={MessageSquare} iconColor="rgba(107, 93, 79, 0.5)" text={t('inquiries.loginRequired')} />
        ) : null}
        {state === 'failed' ? (
          <InlineState
            icon={AlertCircle}
            iconColor="rgba(193, 85, 59, 0.7)"
            strong
            text={t('inquiries.loadFailed')}
            action={{ label: t('inquiries.retry'), onPress: reload }}
          />
        ) : null}
        {state === 'ok' && items.length === 0 ? (
          <InlineState
            icon={MessageSquare}
            iconColor="rgba(107, 93, 79, 0.5)"
            text={t('inquiries.empty')}
            action={{ label: t('inquiries.emptyCta'), onPress: () => router.push('/mypage/support' as never) }}
          />
        ) : null}

        {state === 'ok' ? items.map((item) => (
          <Card key={item.id} padded={false} className="overflow-hidden">
            <View className="p-[20px]">
              <View className="mb-[8px] flex-row items-center justify-between gap-[12px]">
                <Text className="min-w-0 flex-1 text-xs text-muk-soft" weight="semibold">{item.type}</Text>
                <View className="flex-row items-center gap-[4px]">
                  <Icon icon={item.status === 'resolved' ? CheckCircle2 : Clock} size={13} color={item.status === 'resolved' ? 'jade' : 'muk-soft'} />
                  <Text className={`text-xs ${item.status === 'resolved' ? 'text-jade' : 'text-muk-soft'}`} weight="bold">{statusLabel(item.status)}</Text>
                </View>
              </View>
              <Text className="mb-[4px] text-base" weight="bold" accessibilityRole="header">{item.title}</Text>
              <Text className="mb-[12px] text-xs text-muk-soft">{formatDate(item.createdAt, locale)}</Text>
              <Text className="text-sm leading-[22.75px] text-muk-soft">{item.content}</Text>
            </View>
            <View className="border-t border-line bg-hanji px-[20px] py-[16px]">
              {item.replyBody ? (
                <View>
                  <View className="mb-[8px] flex-row items-center justify-between gap-[12px]">
                    <Text className="text-xs text-jade" weight="bold">{t('inquiries.replyTitle')}</Text>
                    {item.repliedAt ? (
                      <Text className="text-xs text-muk-soft">{t('inquiries.repliedAt', { date: formatDate(item.repliedAt, locale) })}</Text>
                    ) : null}
                  </View>
                  <Text className="text-sm leading-[22.75px]">{item.replyBody}</Text>
                </View>
              ) : (
                <Text className="text-xs text-muk-soft">{t('inquiries.awaitingReply')}</Text>
              )}
            </View>
          </Card>
        )) : null}
      </View>
    </Screen>
  );
}
