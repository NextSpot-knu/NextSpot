// 앱 셸 연결 — 이용 기록 전송 수단과 지금 화면 경로를 플랫폼 모듈에 알린다.
// 웹의 UsageTracker(app/layout) 자리다. 전송은 운영 빌드에서만 켜진다(lib/platform/analytics).
import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { env } from '~/lib/core/env';
import { createPublicClient } from '~/lib/core/supabase';
import { configureAnalytics, setUsagePage, trackEvent } from '~/lib/platform/analytics';

let configured = false;

function configureOnce() {
  if (configured) return;
  configured = true;
  configureAnalytics({
    insertUsageEvents: (rows) => createPublicClient().from('usage_events').insert(rows),
    postTrack: (payload) =>
      fetch(`${env.apiUrl}/api/v1/events/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NextSpot-Client': Platform.OS },
        body: payload,
      }),
  });
}

export function ShellBridge() {
  const pathname = usePathname();
  useEffect(configureOnce, []);
  useEffect(() => {
    setUsagePage(pathname);
    trackEvent('page_view');
  }, [pathname]);
  return null;
}
