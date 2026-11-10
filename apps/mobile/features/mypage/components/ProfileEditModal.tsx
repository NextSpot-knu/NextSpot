// 표시 이름 바꾸기 — 웹 마이페이지의 프로필 수정 모달. 원격(public.users)에 먼저 쓰고 성공한 뒤에만 닫는다(실패하면 열어 둔 채 알림).
// G5b-17: 바탕 bg-muk/40(+ iOS·웹은 약한 흐림) · 머리 오른쪽 X · 입력칸 한지 54 · 취소(한지)/저장(금) 48 · 그림자 0 8 32 .18.
// RN Modal 은 따로 뜨는 창이라 루트 토스트가 뒤에 깔린다 — 안에 `<AppToaster id="profileEdit" />` 를 두고 실패 토스트는 toasterId 'profileEdit' 로(R3).
// 안드로이드는 흐림 없이 색만(expo-blur 안드로이드는 BlurTargetView 가 있어야 하고 RN Modal 은 뒤 화면을 흐릴 수 없다).
import { BlurView } from 'expo-blur';
import { Edit2, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppToaster, Button, Icon, IconButton, Pressable, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';

import { TextField } from './parts';

/** 모달 안 토스트 채널 이름 — 호출자가 실패 토스트에 toasterId 로 준다. */
export const PROFILE_EDIT_TOASTER = 'profileEdit';

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
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-center px-[24px]">
          {/* 바탕을 누르면 닫힌다 — 읽기 화면용 닫기 버튼은 머리 X */}
          <Pressable
            noFeedback
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          >
            {Platform.OS === 'android' ? null : <BlurView intensity={20} tint="light" style={StyleSheet.absoluteFill} />}
            <View className="bg-muk/40" style={StyleSheet.absoluteFill} />
          </Pressable>
          <View
            className="w-full max-w-[360px] self-center rounded-3xl border border-line bg-white p-[24px]"
            style={{ boxShadow: '0px 8px 32px rgba(43, 35, 32, 0.18)' }}
            accessibilityViewIsModal
          >
            <View className="mb-[20px] flex-row items-center justify-between gap-[8px]">
              <View className="min-w-0 flex-1 flex-row items-center gap-[8px]">
                <Icon icon={Edit2} size="lg" color="gold" />
                <Text className="text-lg" weight="bold" accessibilityRole="header">{t('mypage.editNameTitle')}</Text>
              </View>
              <IconButton icon={X} accessibilityLabel={t('common.close')} color="muk-soft" box={36} onPress={onClose} />
            </View>
            <Text className="mb-[8px] text-sm text-muk-soft" weight="semibold">{t('mypage.editNameLabel')}</Text>
            <TextField
              tone="hanji"
              size="modal"
              value={name}
              onChangeText={setName}
              placeholder={t('mypage.editNamePlaceholder')}
              maxLength={20}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => { void submit(); }}
              accessibilityLabel={t('mypage.editNameLabel')}
            />
            <Text className="mt-[8px] text-xs text-muk-soft">{t('mypage.editNameHint')}</Text>
            <View className="mt-[24px] flex-row gap-[12px]">
              <Button className="flex-1" variant="hanji" size={48} labelSize={16} labelWeight="semibold" shape="xl" label={t('common.cancel')} onPress={onClose} />
              <Button
                className="flex-1"
                variant="gold"
                size={48}
                labelSize={16}
                shape="xl"
                label={t('common.save')}
                loading={saving}
                disabled={!name.trim() || saving}
                onPress={() => { void submit(); }}
              />
            </View>
          </View>
          <AppToaster id={PROFILE_EDIT_TOASTER} />
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
