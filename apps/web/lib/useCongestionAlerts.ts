'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from './api-client';

/**
 * 혼잡 알림(인앱 옵트인) 훅 — 정적 export 데모용.
 *
 * 서버 Web Push/VAPID 인프라 없이 브라우저 Notification API + 로컬 폴링만 사용한다.
 * 저장한 장소(localStorage: nextspot_saved_facilities)의 현재 혼잡도를
 * /api/v1/infrastructures(apiClient) 로 주기적으로 조회해, 어떤 장소가 '한산'(<0.3)으로
 * 바뀌면 로컬 Notification 을 띄운다. 같은 장소를 반복 알림하지 않도록 마지막 상태를
 * localStorage 에 기록해 '한산으로의 전이' 시점에만 1회 알린다.
 *
 * 모든 브라우저 전용 API 는 SSR/정적 export 안전하게 가드한다(절대 throw 하지 않음).
 */

// 저장한 장소 목록(app/saved/page.tsx 와 동일 키/스키마)
const SAVED_KEY = 'nextspot_saved_facilities';
// 알림 on/off 옵트인 상태
const ENABLED_KEY = 'nextspot_congestion_alerts_enabled';
// 시설별 마지막으로 관측한 '한산 여부' — 전이 감지 및 중복 알림 방지
const NOTIFIED_KEY = 'nextspot_congestion_alerts_notified';

// '한산' 임계값(이하이면 한산). main/page.tsx 의 혼잡 신호등(<0.25=blue/한산)과 정합적인
// 여유 상단 경계. 0.3 미만을 한산 트리거로 사용한다.
const CALM_THRESHOLD = 0.3;
// 폴링 주기(ms) — 데모에서 과도한 호출을 피하되 반응성 유지(3분).
const POLL_INTERVAL_MS = 3 * 60 * 1000;

export type AlertPermission = 'default' | 'granted' | 'denied' | 'unsupported';

interface SavedFacility {
  id: string;
  name: string;
  [k: string]: unknown;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function notificationSupported(): boolean {
  return isBrowser() && typeof Notification !== 'undefined';
}

function readPermission(): AlertPermission {
  if (!notificationSupported()) return 'unsupported';
  try {
    return Notification.permission as AlertPermission;
  } catch {
    return 'unsupported';
  }
}

function readSavedFacilities(): SavedFacility[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is SavedFacility => !!f && typeof f.id === 'string' && typeof f.name === 'string',
    );
  } catch {
    return [];
  }
}

function readNotifiedMap(): Record<string, boolean> {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(NOTIFIED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeNotifiedMap(map: Record<string, boolean>): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(map));
  } catch {
    /* 저장 실패는 무시(할당량 초과 등) — 절대 throw 하지 않음 */
  }
}

/** /api/v1/infrastructures 응답에서 시설 id -> 최신 혼잡도(0~1|null) 맵을 만든다. */
function buildCongestionMap(items: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!Array.isArray(items)) return out;
  for (const raw of items) {
    const f = raw as { id?: unknown; congestion?: { level?: unknown } | null };
    if (!f || typeof f.id !== 'string') continue;
    const level = f.congestion && typeof f.congestion.level === 'number' ? f.congestion.level : null;
    out[f.id] = level;
  }
  return out;
}

export interface UseCongestionAlerts {
  /** 옵트인(사용자가 켠 상태) 여부 */
  enabled: boolean;
  /** 브라우저 알림 권한 상태 */
  permission: AlertPermission;
  /** Notification API 지원 여부 */
  supported: boolean;
  /** 마지막 폴링에서 오류가 있었는지(백엔드 다운 등) — UI 힌트용, 동작은 계속됨 */
  lastCheckFailed: boolean;
  /** 토글: 켜져 있으면 끄고, 꺼져 있으면 권한 요청 후 켠다. */
  toggle: () => Promise<void>;
  /** 명시적으로 끄기 */
  disable: () => void;
}

export function useCongestionAlerts(): UseCongestionAlerts {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<AlertPermission>('default');
  const [lastCheckFailed, setLastCheckFailed] = useState(false);

  // 폴링 타이머 및 재진입 방지 플래그
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);

  // 초기 마운트: 클라이언트에서만 권한/옵트인 상태 복원(SSR 안전)
  useEffect(() => {
    setPermission(readPermission());
    if (!isBrowser()) return;
    try {
      const saved = window.localStorage.getItem(ENABLED_KEY);
      // 권한이 실제로 granted 일 때만 '켜짐'으로 복원(권한이 나중에 회수된 경우 방지)
      setEnabled(saved === 'true' && readPermission() === 'granted');
    } catch {
      /* noop */
    }
  }, []);

  /** 저장한 장소들의 혼잡도를 조회해 '한산 전이'에 대해 알림을 띄운다. */
  const check = useCallback(async () => {
    if (!notificationSupported() || readPermission() !== 'granted') return;
    if (runningRef.current) return; // 이전 폴링이 아직 진행 중이면 건너뜀
    runningRef.current = true;

    const saved = readSavedFacilities();
    if (saved.length === 0) {
      runningRef.current = false;
      return;
    }

    try {
      const items = await apiClient.get('/api/v1/infrastructures');
      setLastCheckFailed(false);

      const congestion = buildCongestionMap(items);
      const notified = readNotifiedMap();
      let changed = false;

      for (const place of saved) {
        const level = congestion[place.id];
        if (typeof level !== 'number') continue; // 데이터 없음 → 판단 보류

        const isCalm = level < CALM_THRESHOLD;
        const wasCalm = notified[place.id] === true;

        if (isCalm && !wasCalm) {
          // 한산으로 '전이' — 1회 알림
          try {
            new Notification('한산해졌어요 🍃', {
              body: `'${place.name}'이(가) 지금 한산해요. 다녀오기 좋은 때예요!`,
              tag: `nextspot-calm-${place.id}`, // 같은 장소 알림은 OS 레벨에서도 대체
              icon: '/icon.svg',
            });
          } catch {
            /* 알림 생성 실패는 무시 */
          }
          notified[place.id] = true;
          changed = true;
        } else if (!isCalm && wasCalm) {
          // 다시 붐빔 → 플래그 해제(다음 전이에서 재알림 허용)
          notified[place.id] = false;
          changed = true;
        }
      }

      // 더 이상 저장돼 있지 않은 장소의 잔여 플래그 정리
      const savedIds = new Set(saved.map((s) => s.id));
      for (const id of Object.keys(notified)) {
        if (!savedIds.has(id)) {
          delete notified[id];
          changed = true;
        }
      }

      if (changed) writeNotifiedMap(notified);
    } catch {
      // 백엔드 미기동/네트워크 실패 → 조용히 무시하고 다음 주기에 재시도
      setLastCheckFailed(true);
    } finally {
      runningRef.current = false;
    }
  }, []);

  // enabled + 권한 granted 일 때만 폴링 시작(즉시 1회 + 주기)
  useEffect(() => {
    if (!enabled || !notificationSupported() || permission !== 'granted') {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // 백그라운드 탭에서는 폴링을 건너뛴다(숨은 탭이 전체 데이터셋을 계속 조회하지 않도록).
    const pollIfVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void check();
    };

    pollIfVisible(); // 켜자마자(보이는 경우) 즉시 1회 확인
    timerRef.current = setInterval(pollIfVisible, POLL_INTERVAL_MS);

    // 탭이 다시 보이게 되면 즉시 한 번 재확인(숨어 있는 동안 놓친 전이 반영).
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) void check();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [enabled, permission, check]);

  const disable = useCallback(() => {
    setEnabled(false);
    if (isBrowser()) {
      try {
        window.localStorage.setItem(ENABLED_KEY, 'false');
      } catch {
        /* noop */
      }
    }
  }, []);

  const toggle = useCallback(async () => {
    // 지원하지 않으면 아무 동작도 하지 않음
    if (!notificationSupported()) {
      setPermission('unsupported');
      return;
    }

    // 이미 켜져 있으면 끈다
    if (enabled) {
      disable();
      return;
    }

    // 권한 요청(반드시 사용자 명시적 동작에서 호출)
    let result: AlertPermission = readPermission();
    if (result === 'default') {
      try {
        result = (await Notification.requestPermission()) as AlertPermission;
      } catch {
        result = readPermission();
      }
    }
    setPermission(result);

    if (result === 'granted') {
      setEnabled(true);
      if (isBrowser()) {
        try {
          window.localStorage.setItem(ENABLED_KEY, 'true');
        } catch {
          /* noop */
        }
      }
    } else {
      // denied/default → 켜지 않음
      disable();
    }
  }, [enabled, disable]);

  return {
    enabled,
    permission,
    supported: notificationSupported(),
    lastCheckFailed,
    toggle,
    disable,
  };
}
