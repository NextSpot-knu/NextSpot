// 앱 셸 연결 — 이용 기록 전송 수단·켜는 조건과 지금 화면 경로를 플랫폼 모듈에 알린다.
// 웹의 UsageTracker(app/layout) 자리다. 전송은 운영 빌드에서만 켜진다(env.usageEventsEnabled — 규칙은 lib/core/env 한 곳).
import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { env } from '~/lib/core/env';
import { CLIENT_HEADER, clientPlatformFrom } from '~/lib/core/httpCore';
import { createPublicClient } from '~/lib/core/supabase';
import { configureAnalytics, setUsagePage, trackEvent } from '~/lib/platform/analytics';
import { webPagePath } from '~/lib/platform/analyticsCore';

let configured = false;

function configureOnce() {
  if (configured) return;
  configured = true;
  const platform = clientPlatformFrom(Platform.OS);
  configureAnalytics({
    enabled: env.usageEventsEnabled,
    insertUsageEvents: (rows) => createPublicClient().from('usage_events').insert(rows),
    postTrack: (payload) =>
      fetch(`${env.apiUrl}/api/v1/events/track`, {
        method: 'POST',
        // API 클라이언트와 같은 헤더 상수·값(ios|android, 그 밖이면 싣지 않는다).
        headers: { 'Content-Type': 'application/json', ...(platform ? { [CLIENT_HEADER]: platform } : {}) },
        body: payload,
      }),
  });
}

export function ShellBridge() {
  const pathname = usePathname();
  useEffect(configureOnce, []);
  useEffect(() => {
    // usage_events.page 는 웹 경로로(홈 '/' → '/main') — 앱·웹 화면별 집계를 한 줄로 모은다.
    setUsagePage(webPagePath(pathname));
    trackEvent('page_view');
  }, [pathname]);
  return null;
}
