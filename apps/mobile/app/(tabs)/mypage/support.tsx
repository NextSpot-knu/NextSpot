// 문의하기 — 웹 app/mypage/support/page.tsx. Supabase `inquiries` 에 직접 insert 한다(웹과 같은 행 모양).
// 답장 받을 이메일 칸(사용자 요청)은 넣지 않았다: inquiries 표에 그 값을 담을 열이 없다(supabase/migrations 의 inquiries 열 =
// id·user_id·user_name·type·title·content·status·created_at·updated_at·reply_body·replied_at·replied_by). 열이 생기면 더한다.
import { useRouter } from 'expo-router';
import { CheckCircle, Send } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { Button, Icon, Screen, SelectField, Text, toast } from '~/components/ui';
import { createPublicClient } from '~/lib/core/supabase';
import { useT } from '~/lib/i18n/I18nProvider';

import { TextField } from '~/features/mypage/components/parts';
import { SubPageHeader } from '~/features/mypage/components/SubPageHeader';

// value 는 그대로 DB(inquiries.type)에 저장돼 관리자 화면의 분류 기준이 된다 — 번역하면 안 된다(라벨만 로케일).
const TYPES = [
  { value: '앱 버그', labelKey: 'support.typeBug' },
  { value: '인프라 불만', labelKey: 'support.typeInfra' },
  { value: '데이터 수정', labelKey: 'support.typeData' },
  { value: '기타 문의', labelKey: 'support.typeEtc' },
] as const;

const TITLE_MAX = 255; // inquiries.title VARCHAR(255)

export default function SupportScreen() {
  const t = useT();
  const router = useRouter();
  const [type, setType] = useState<string>(TYPES[0].value);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // 웹 required 말풍선 대신: 빈 채로 누르면 첫 빈 칸에 초점 + 칸 아래 안내(app.support.required, G5b-37).
  const [missing, setMissing] = useState<'title' | 'content' | null>(null);
  const titleRef = useRef<TextInput>(null);
  const contentRef = useRef<TextInput>(null);
  const { gap } = useNavInsets();
  // 기본은 익명 문의(user_id NULL) — RLS 가 user_id 를 'NULL 이거나 본인 auth.uid()' 로만 받는다.
  // 세션이 있을 때만 본인 id 를 싣고(웹과 같다), 세션이 없으면 답이 닿지 않는다는 알림을 쓰기 전에 보인다.
  const [userId, setUserId] = useState<string | null>(null);
  // user_name 은 NOT NULL — DB 로 보내는 값이라 i18n 대상이 아니다(관리자 화면에서만 읽힌다).
  const [userName, setUserName] = useState('익명');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { data: { session } } = await createPublicClient().auth.getSession();
        const user = session?.user;
        if (!alive || !user) return;
        setUserId(user.id);
        setUserName((user.user_metadata?.full_name as string | undefined) || user.email?.split('@')[0] || '사용자');
      } catch (err) {
        console.warn('[support] 세션 조회 실패', err);
      }
    })();
    return () => { alive = false; };
  }, []);

  const submit = async () => {
    if (submitting) return;
    if (!title.trim()) { setMissing('title'); titleRef.current?.focus(); return; }
    if (!content.trim()) { setMissing('content'); contentRef.current?.focus(); return; }
    setMissing(null);
    setSubmitting(true);
    try {
      const { error } = await createPublicClient().from('inquiries').insert([
        { user_id: userId, user_name: userName, type, title: title.trim(), content: content.trim(), status: 'new' },
      ]);
      if (error) throw error;
      setDone(true);
    } catch (err) {
      console.warn('[support] 문의 전송 실패', err);
      toast.error(t('support.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // 웹은 이 화면만 문서 전체가 스크롤돼 머리도 함께 올라간다(G5b-R02) — Stack 머리 대신 내용 맨 앞에 그린다(완료 화면도 같은 머리).
  // 뒤로 읽기 이름은 settings.backAria(웹은 라벨 없음 — R3 정정). 아래 안전 영역은 탭 막대가 맡는다.
  const header = <SubPageHeader title={t('support.title')} backLabel={t('settings.backAria')} variant="bordered" />;

  if (done) {
    return (
      <Screen edges={['top', 'left', 'right']} contentClassName="">
        {header}
        <View className="flex-1 items-center justify-center px-[24px] pt-[24px]" style={{ paddingBottom: 24 + gap }}>
          <View className="mb-[24px] h-[80px] w-[80px] items-center justify-center rounded-full bg-jade/15">
            <Icon icon={CheckCircle} size={40} color="jade" />
          </View>
          <Text className="mb-[8px] text-center text-2xl" weight="bold" accessibilityRole="header">{t('support.doneTitle')}</Text>
          <Text className="mb-[32px] max-w-[80%] text-center text-muk-soft">{t('support.doneDesc')}</Text>
          <Button variant="gold" size={48} labelSize={16} shape="xl" paddingX={32} label={t('support.backToMypage')} onPress={() => router.dismissTo('/mypage')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll edges={['top', 'left', 'right']} contentClassName="" scrollProps={{ keyboardDismissMode: 'on-drag' }}>
      {header}
      {/* 웹: main p-6 + 막대 여백 · form max-w-md gap-5 */}
      <View className="w-full max-w-[448px] gap-[20px] self-center" style={{ padding: 24, paddingBottom: 24 + gap }}>
        <Text className="mb-[8px] text-sm text-muk-soft">{t('support.intro')}</Text>

        <View className="gap-[8px]">
          <Text className="text-sm text-muk-soft" weight="semibold">{t('support.typeLabel')}</Text>
          <SelectField
            variant="field"
            value={type}
            options={TYPES.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            onChange={setType}
            accessibilityLabel={t('support.typeLabel')}
          />
        </View>

        <View className="gap-[8px]">
          <Text className="text-sm text-muk-soft" weight="semibold">{t('support.titleLabel')}</Text>
          <TextField
            inputRef={titleRef}
            size="field"
            value={title}
            onChangeText={(v) => { setTitle(v); if (missing === 'title') setMissing(null); }}
            placeholder={t('support.titlePlaceholder')}
            maxLength={TITLE_MAX}
            accessibilityLabel={t('support.titleLabel')}
            returnKeyType="next"
          />
          {missing === 'title' ? <Text className="text-xs text-terracotta" accessibilityRole="alert">{t('app.support.required')}</Text> : null}
        </View>

        <View className="gap-[8px]">
          <Text className="text-sm text-muk-soft" weight="semibold">{t('support.contentLabel')}</Text>
          <TextField
            inputRef={contentRef}
            size="field"
            value={content}
            onChangeText={(v) => { setContent(v); if (missing === 'content') setMissing(null); }}
            placeholder={t('support.contentPlaceholder')}
            accessibilityLabel={t('support.contentLabel')}
            multiline
            height={200}
          />
          {missing === 'content' ? <Text className="text-xs text-terracotta" accessibilityRole="alert">{t('app.support.required')}</Text> : null}
        </View>

        {userId === null ? (
          <View className="rounded-xl border border-gold/40 bg-gold/10 px-[16px] py-[12px]" accessibilityRole="summary">
            <Text className="text-[13px] leading-[21px]" weight="bold">{t('support.anonymousReplyNoticeTitle')}</Text>
            <Text className="mt-[2px] text-[13px] leading-[21px] text-muk-soft">{t('support.anonymousReplyNotice')}</Text>
          </View>
        ) : null}

        <Button
          className="mt-[16px]"
          variant="gold"
          size={56}
          labelSize={16}
          shape="xl"
          iconSize={20}
          shadow="none"
          label={submitting ? t('support.submitting') : t('support.submit')}
          icon={Send}
          block
          loading={submitting}
          showSpinner={false}
          onPress={() => { void submit(); }}
        />
      </View>
    </Screen>
  );
}
