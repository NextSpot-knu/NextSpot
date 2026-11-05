// 표시 이름 바꾸기 — 웹 마이페이지의 프로필 수정 모달. 원격(public.users)에 먼저 쓰고 성공한 뒤에만 닫는다(실패하면 열어 둔 채 알림).
import { Edit2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, View } from 'react-native';

import { Button, Icon, Pressable, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';

import { TextField } from './parts';

export function ProfileEditModal({
  visible,
  initialName,
  onClose,
  onSave,
}: {
  visible: boolean;
  initialName: string;
  onClose: () => void;
  /** 저장. 던지면 실패로 보고 모달을 닫지 않는다. */
  onSave: (name: string) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) setName(initialName);
  }, [visible, initialName]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSave(trimmed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-center bg-muk/40 px-[24px]">
        {/* 바탕을 누르면 닫힌다 — 읽기 화면용 닫기 버튼도 따로 둔다 */}
        <Pressable accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={onClose} className="absolute inset-0" />
        <View
          className="w-full max-w-[360px] self-center gap-[12px] rounded-3xl border border-line bg-white p-[24px]"
          accessibilityViewIsModal
        >
          <View className="flex-row items-center gap-[8px]">
            <Icon icon={Edit2} size="lg" color="gold" />
            <Text className="text-lg" weight="bold" accessibilityRole="header">{t('mypage.editNameTitle')}</Text>
          </View>
          <Text className="text-sm text-muk-soft" weight="semibold">{t('mypage.editNameLabel')}</Text>
          <TextField
            value={name}
            onChangeText={setName}
            placeholder={t('mypage.editNamePlaceholder')}
            maxLength={20}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => { void submit(); }}
            accessibilityLabel={t('mypage.editNameLabel')}
          />
          <Text className="text-xs text-muk-soft">{t('mypage.editNameHint')}</Text>
          <View className="mt-[8px] flex-row gap-[12px]">
            <Button className="flex-1" variant="secondary" label={t('common.cancel')} onPress={onClose} />
            <Button className="flex-1" label={t('common.save')} loading={saving} disabled={!name.trim() || saving} onPress={() => { void submit(); }} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
