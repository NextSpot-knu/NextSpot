// 운영자 공개 설정(점검 모드·공지·혼잡 경계) — 앱을 켤 때 한 번 조회한다.
//
// 웹 원본: apps/web/components/shell/PublicSettingsProvider.tsx (기준 커밋 e07ea61)
// 파싱·폴백 판정은 웹 순수 모듈 `@/lib/publicSettings` 를 그대로 쓴다. 조회 실패(404·타임아웃·형식 이상)는 전부 '평소 화면'
// (FALLBACK_PUBLIC_SETTINGS)이다 — 실패를 점검으로 보이면 멀쩡한 서비스를 우리 손으로 내리는 것이다.
// 바꾼 것:
//   · 경로 판정(isTouristPath) 없음 — 앱은 관광객 화면만 있다.
//   · 점검 화면·공지 배너는 최소 자리 컴포넌트다. 문구는 props(labels)로 받는다 — 앱 i18n 이 붙으면 AppProviders 가
//     t('systemNotice.maintenanceTitle' | 'systemNotice.maintenanceBody' | 'systemNotice.dismiss') 를 넘긴다.
//     기본값은 웹 ko.json 의 같은 키 문구다. 디자인은 화면 담당이 renderMaintenance·renderNotice 로 바꿔 끼운다.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  FALLBACK_PUBLIC_SETTINGS,
  parsePublicSettings,
  type PublicSettings,
} from '@/lib/publicSettings';

import { apiClient } from './apiClient';
import { readDismissedNotice, shouldShowNotice, writeDismissedNotice } from './noticeDismissal';

export type { PublicSettings } from '@/lib/publicSettings';

/** 기본 타임아웃보다 짧게 — 없어도 앱이 정상 동작하는 값이다. */
export const PUBLIC_SETTINGS_TIMEOUT_MS = 4000;

const PublicSettingsContext = createContext<PublicSettings>(FALLBACK_PUBLIC_SETTINGS);

/** 운영자 설정. 프로바이더 밖에서도 폴백을 돌려준다. */
export function usePublicSettings(): PublicSettings {
  return useContext(PublicSettingsContext);
}

/** '혼잡' 등급 경계(0..1). 설정을 못 받았으면 DEFAULT_BUSY_THRESHOLD. */
export function useBusyThreshold(): number {
  return useContext(PublicSettingsContext).busyThreshold;
}

export interface PublicSettingsLabels {
  maintenanceTitle: string;
  maintenanceBody: string;
  dismiss: string;
}

/** 웹 ko.json systemNotice.* 와 같은 문구(앱 i18n 이 붙기 전의 기본값). */
export const DEFAULT_PUBLIC_SETTINGS_LABELS: PublicSettingsLabels = {
  maintenanceTitle: '지금은 점검 중이에요',
  maintenanceBody: '잠시 뒤에 다시 찾아와 주세요. 점검이 끝나면 평소처럼 이용할 수 있어요.',
  dismiss: '공지 닫기',
};

export interface PublicSettingsProviderProps {
  children: ReactNode;
  labels?: PublicSettingsLabels;
  renderMaintenance?: (props: { noticeText: string; labels: PublicSettingsLabels }) => ReactNode;
  renderNotice?: (props: { noticeText: string; labels: PublicSettingsLabels; onDismiss: () => void }) => ReactNode;
}

export function PublicSettingsProvider({
  children,
  labels = DEFAULT_PUBLIC_SETTINGS_LABELS,
  renderMaintenance,
  renderNotice,
}: PublicSettingsProviderProps) {
  const [settings, setSettings] = useState<PublicSettings>(FALLBACK_PUBLIC_SETTINGS);
  // 앱에는 하이드레이션이 없어 지연 초기화로 바로 읽는다(expo-sqlite localStorage 는 동기).
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(() => readDismissedNotice());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await apiClient.get('/api/v1/system/public-settings', { timeoutMs: PUBLIC_SETTINGS_TIMEOUT_MS });
        if (alive) setSettings(parsePublicSettings(data));
      } catch {
        // 조용히 폴백 — 지금 정상 상태다.
      }
    })();
    return () => { alive = false; };
  }, []);

  const value = useMemo(() => settings, [settings]);
  const showMaintenance = settings.maintenanceMode;
  const showNotice = !settings.maintenanceMode && shouldShowNotice(settings.noticeText, dismissedNotice);
  const dismiss = () => {
    writeDismissedNotice(settings.noticeText);
    setDismissedNotice(settings.noticeText);
  };

  return (
    <PublicSettingsContext.Provider value={value}>
      {showMaintenance ? (
        (renderMaintenance ?? ((p) => <MaintenanceScreen {...p} />))({ noticeText: settings.noticeText, labels })
      ) : (
        <View style={{ flex: 1 }}>
          {children}
          {showNotice &&
            (renderNotice ?? ((p) => <NoticeBanner {...p} />))({ noticeText: settings.noticeText, labels, onDismiss: dismiss })}
        </View>
      )}
    </PublicSettingsContext.Provider>
  );
}

/** 전면 점검 안내(자리 컴포넌트). 공지 문구가 있으면 함께 보여 준다 — 없으면 지어내지 않는다. */
export function MaintenanceScreen({ noticeText, labels }: { noticeText: string; labels: PublicSettingsLabels }) {
  return (
    <View
      accessibilityRole="summary"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, backgroundColor: '#F7F3EA' }}
    >
      <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: '700', color: '#2B2320', textAlign: 'center' }}>
        {labels.maintenanceTitle}
      </Text>
      <Text style={{ marginTop: 12, fontSize: 14, lineHeight: 21, color: '#5E5450', textAlign: 'center' }}>
        {labels.maintenanceBody}
      </Text>
      {noticeText !== '' && (
        <Text style={{ marginTop: 12, fontSize: 12, lineHeight: 18, color: '#2B2320', textAlign: 'center' }}>{noticeText}</Text>
      )}
    </View>
  );
}

/** 상단 공지 배너(자리 컴포넌트). 화면 위에 겹쳐 그린다 — 레이아웃을 밀지 않는다. */
export function NoticeBanner({
  noticeText,
  labels,
  onDismiss,
}: {
  noticeText: string;
  labels: PublicSettingsLabels;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="alert"
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, top: insets.top + 8, paddingHorizontal: 12 }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 8,
          borderRadius: 16,
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: 'rgba(255,255,255,0.97)',
          borderWidth: 1,
          borderColor: 'rgba(176,141,87,0.4)',
        }}
      >
        <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, fontWeight: '500', color: '#2B2320' }}>{noticeText}</Text>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={labels.dismiss}
          hitSlop={12}
          style={{ minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 14, color: '#5E5450' }}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}
