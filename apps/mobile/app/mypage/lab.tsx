// 나의 실험실(거절 실험실) — 웹 app/mypage/lab/page.tsx. 거절한 추천의 이유를 되짚어 다음 추천을 조율한다.
// 이유 칩 9종(기타만 메모) · 직접 설명하기(서버 LLM 분류) · 건너뛰기 · 숨기기. 답/건너뛰기/숨기기는 낙관적으로 빼고 실패하면 되돌린다.
// '직접 설명하기'는 서버가 문장을 외부 AI(Upstage)로 보낸다 — 외부 AI 전송을 허용했을 때만 입력 칸을 켠다
// (App Store 5.1.2(i), features/aiConsent). 허용하지 않아도 이유 칩·'기타' 메모(AI 없음)는 그대로 쓴다.
import { useRouter } from 'expo-router';
import { FlaskConical, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Chip, EmptyState, ErrorState, IconButton, Pressable, Screen, Text, toast } from '~/components/ui';
import { AiConsentNotice, canSendToAi, useAiConsent } from '~/features/aiConsent';
import { useLocale, useT } from '~/lib/i18n/I18nProvider';

import {
  answerLabReason,
  classifyLabReason,
  fetchLabPending,
  hideLabItem,
  skipLabItem,
  type LabPendingItem,
} from '~/features/mypage/api';
import { CardSkeletons, TextField } from '~/features/mypage/components/parts';
import { COUPON_TYPE_IDS } from '~/features/mypage/couponCore';
import { NOTE_MAX, REASON_CODES, answeredKey, formatRecommendedAt, withoutItem, type LabReasonCode } from '~/features/mypage/labCore';
import { useRemote } from '~/features/mypage/useRemote';

export default function LabScreen() {
  const t = useT();
  const router = useRouter();
  const [locale] = useLocale();
  const { state, data, setData, reload } = useRemote(fetchLabPending);
  const items = data ?? [];
  const { allowed: aiAllowed } = useAiConsent();

  // '기타' 메모 · '직접 설명하기' 입력은 카드 하나에서만(feedbackId).
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [freeTextFor, setFreeTextFor] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const mutate = useCallback(async <R,>(id: string, run: () => Promise<R>, successKey: string | ((r: R) => string)) => {
    if (busyId) return;
    setBusyId(id);
    const snapshot = items;
    setData(withoutItem(items, id));
    setNoteFor((prev) => (prev === id ? null : prev));
    try {
      const result = await run();
      toast.success(t(typeof successKey === 'function' ? successKey(result) : successKey));
    } catch (err) {
      console.warn('[lab] 처리 실패', err);
      if (alive.current) setData(snapshot); // 서버에 반영되지 않은 것을 사라진 것처럼 두지 않는다
      toast.error(t('common.error'));
    } finally {
      if (alive.current) setBusyId(null);
    }
  }, [busyId, items, setData, t]);

  const onReason = (item: LabPendingItem, code: LabReasonCode) => {
    if (code === 'other') {
      setNoteFor(item.id);
      setNoteText('');
      setFreeTextFor(null);
      return;
    }
    void mutate(item.id, () => answerLabReason(item.id, code), answeredKey);
  };

  const onNoteSubmit = (item: LabPendingItem) => {
    const note = noteText.trim();
    void mutate(item.id, () => answerLabReason(item.id, 'other', note || undefined), answeredKey);
  };

  const toggleFreeText = (id: string) => {
    setFreeText('');
    setNoteFor(null);
    setFreeTextFor((prev) => (prev === id ? null : id));
  };

  const onClassify = async (item: LabPendingItem) => {
    const text = freeText.trim();
    if (!text || busyId) return;
    if (!canSendToAi()) return; // 허용 전에는 문장을 보내지 않는다(버튼도 꺼져 있다)
    setBusyId(item.id);
    try {
      const result = await classifyLabReason(item.id, text);
      if (result.resolved) {
        setData(withoutItem(items, item.id));
        setFreeTextFor((prev) => (prev === item.id ? null : prev));
        toast.success(t(answeredKey(result)));
      } else {
        toast.error(t('lab.classifyFallback')); // 낙관적 제거를 하지 않는다 — 선택지에서 고르게
      }
    } catch (err) {
      console.warn('[lab] 분류 실패', err);
      toast.error(t('lab.classifyFallback'));
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  return (
    <Screen scroll edges={['left', 'right', 'bottom']} contentClassName="px-[16px] py-[16px] gap-[16px]" scrollProps={{ keyboardDismissMode: 'on-drag' }}>
      {state === 'loading' ? (
        <CardSkeletons count={3} label={t('common.loading')} />
      ) : state === 'unauthenticated' ? (
        <EmptyState
          icon={FlaskConical}
          title={t('lab.loadError')}
          action={{ label: t('nav.home'), onPress: () => router.navigate('/') }}
        />
      ) : state === 'failed' ? (
        <ErrorState message={t('lab.loadError')} retryLabel={t('common.retry')} onRetry={reload} />
      ) : items.length === 0 ? (
        <EmptyState icon={FlaskConical} title={t('lab.empty')} description={t('lab.emptyDesc')} />
      ) : (
        <>
          <Text className="px-[4px] text-sm leading-[21px] text-muk-soft">{t('lab.cardDesc')}</Text>
          {items.map((item) => {
            const typeLabel = item.facilityType && COUPON_TYPE_IDS.includes(item.facilityType)
              ? t(`category.${item.facilityType}`)
              : item.facilityType;
            const when = formatRecommendedAt(item.createdAt, locale);
            const noteOpen = noteFor === item.id;
            const freeOpen = freeTextFor === item.id;
            const busy = busyId === item.id;
            return (
              <Card key={item.id} className={busy ? 'opacity-60' : undefined}>
                <View className="flex-row items-start justify-between gap-[12px]">
                  <View className="min-w-0 flex-1 gap-[4px]">
                    <View className="flex-row flex-wrap items-center gap-[8px]">
                      <Text className="text-lg" weight="bold" accessibilityRole="header">{item.facilityName}</Text>
                      {typeLabel ? (
                        <View className="rounded-md border border-jade/25 bg-jade/10 px-[8px] py-[2px]">
                          <Text className="text-[11px] text-jade" weight="semibold">{typeLabel}</Text>
                        </View>
                      ) : null}
                    </View>
                    {when ? <Text className="text-xs text-muk-soft">{t('lab.recommendedAt')} · {when}</Text> : null}
                  </View>
                  <IconButton
                    icon={X}
                    accessibilityLabel={t('lab.hide')}
                    color="muk-soft"
                    disabled={busy}
                    onPress={() => { void mutate(item.id, () => hideLabItem(item.id), 'lab.hidden'); }}
                  />
                </View>

                <View className="mt-[16px] flex-row flex-wrap gap-[8px]">
                  {REASON_CODES.map((code) => (
                    <Chip
                      key={code}
                      label={t(`lab.reason.${code}`)}
                      selected={code === 'other' && noteOpen}
                      disabled={busy}
                      onPress={() => onReason(item, code)}
                      className="min-h-[40px] justify-center"
                    />
                  ))}
                </View>

                {noteOpen ? (
                  <View className="mt-[16px] gap-[8px]">
                    <Text className="text-sm text-muk-soft" weight="semibold">{t('lab.noteLabel')}</Text>
                    <TextField
                      value={noteText}
                      onChangeText={setNoteText}
                      placeholder={t('lab.notePlaceholder')}
                      maxLength={NOTE_MAX}
                      accessibilityLabel={t('lab.noteLabel')}
                      multiline
                    />
                    <View className="flex-row items-center justify-between gap-[12px]">
                      <Text className="text-[11px] text-muk-soft">{noteText.length}/{NOTE_MAX}</Text>
                      <Button label={t('lab.noteSubmit')} disabled={busy} onPress={() => onNoteSubmit(item)} />
                    </View>
                  </View>
                ) : null}

                {freeOpen ? (
                  <View className="mt-[16px] gap-[8px]">
                    <Text className="text-sm text-muk-soft" weight="semibold">{t('lab.freeTextLabel')}</Text>
                    <AiConsentNotice />
                    <TextField
                      editable={aiAllowed}
                      accessibilityState={{ disabled: !aiAllowed }}
                      value={freeText}
                      onChangeText={setFreeText}
                      placeholder={t('lab.freeTextPlaceholder')}
                      maxLength={NOTE_MAX}
                      accessibilityLabel={t('lab.freeTextLabel')}
                      multiline
                      minHeight={72}
                    />
                    <View className="flex-row items-center justify-between gap-[12px]">
                      <Text className="text-[11px] text-muk-soft">{freeText.length}/{NOTE_MAX}</Text>
                      <Button label={t('lab.freeTextSubmit')} loading={busy} disabled={busy || !aiAllowed || !freeText.trim()} onPress={() => { void onClassify(item); }} />
                    </View>
                  </View>
                ) : null}

                <View className="mt-[16px] flex-row items-center justify-between border-t border-line pt-[8px]">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('lab.freeText')}
                    accessibilityState={{ selected: freeOpen, disabled: busy }}
                    disabled={busy}
                    onPress={() => toggleFreeText(item.id)}
                    className="min-h-[44px] justify-center px-[8px]"
                  >
                    <Text className="text-xs text-gold-deep" weight="semibold">{t('lab.freeText')}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('lab.skip')}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    onPress={() => { void mutate(item.id, () => skipLabItem(item.id), 'lab.skipped'); }}
                    className="min-h-[44px] justify-center px-[8px]"
                  >
                    <Text className="text-xs text-muk-soft" weight="semibold">{t('lab.skip')}</Text>
                  </Pressable>
                </View>
              </Card>
            );
          })}
        </>
      )}
    </Screen>
  );
}
