// 앱 전역 프로바이더 묶음 — app/_layout.tsx 가 네비게이터를 이것으로 감싼다.
//
// 웹 app/layout.tsx 의 셸 순서를 따른다: SessionBootstrap(렌더 없음) → AccountProvider → PublicSettingsProvider.
// 점검 모드면 PublicSettingsProvider 가 children(네비게이터) 대신 점검 화면을 그린다.
// SafeAreaProvider 는 이 안에서 만들지 않는다 — 공지 배너가 useSafeAreaInsets 를 쓰므로 _layout 이 바깥에 둬야 한다
// (expo-router 는 루트에 SafeAreaProvider 를 이미 깐다).
import type { ReactNode } from 'react';

import { AccountProvider } from './account';
import {
  PublicSettingsProvider,
  type PublicSettingsProviderProps,
} from './publicSettings';
import SessionBootstrap from './SessionBootstrap';

export interface AppProvidersProps {
  children: ReactNode;
  /** 점검·공지 문구(앱 i18n 이 붙으면 t(...) 로 넘긴다). 없으면 한국어 기본값. */
  publicSettingsLabels?: PublicSettingsProviderProps['labels'];
  renderMaintenance?: PublicSettingsProviderProps['renderMaintenance'];
  renderNotice?: PublicSettingsProviderProps['renderNotice'];
}

export function AppProviders({ children, publicSettingsLabels, renderMaintenance, renderNotice }: AppProvidersProps) {
  return (
    <>
      <SessionBootstrap />
      <AccountProvider>
        <PublicSettingsProvider
          labels={publicSettingsLabels}
          renderMaintenance={renderMaintenance}
          renderNotice={renderNotice}
        >
          {children}
        </PublicSettingsProvider>
      </AccountProvider>
    </>
  );
}

export default AppProviders;
