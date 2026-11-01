// 사용자 스코프 로컬 데이터 격리 — 세션 uid 가 바뀌면 이전 사용자의 개인 데이터를 지운다.
//
// 웹 원본: apps/web/lib/userData.ts (기준 커밋 e07ea61)
// 바꾼 것: 내부 지역 캐시 지우기(purgeRegionCaches — lib/regionPacks 는 api-client 를 끌고 와 check:shared 에 걸린다)를 뺐다.
//          앱 v1 은 경주만 보므로 `nextspot_*__<지역>` 캐시를 만들지 않는다. 지역 선택 키(REGION_STORAGE_KEY)는 웹처럼 지운다.
//          저장소는 전역 localStorage(expo-sqlite). 키 목록·규칙은 웹과 같다 — 웹에 키가 늘면 여기도 맞춘다.
import { REGION_STORAGE_KEY } from '@/lib/regionState';

export const USER_SCOPED_KEYS = [
  'nextspot_saved_facilities',
  'nextspot_setup_prefs',
  'nextspot_display_name',
  'nextspot_visit_history',
  'nextspot_visit_count',
  'nextspot_visit_counted_session',
  'nextspot_pending_visit',
  'nextspot_active_trip',
  'nextspot_rejected_ids',
  'nextspot_onboarding_done',
  'nextspot_congestion_alerts_notified',
  // 저장 해제 대기(서버 삭제 실패분) — 다른 사용자에게 넘어가면 그 사람의 저장을 지운다. 웹 USER_SCOPED_KEYS 에는 아직 없다.
  'nextspot_saved_pending_deletes',
  REGION_STORAGE_KEY,
] as const;

const LAST_UID_KEY = 'nextspot_last_uid';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): KeyValueStore | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

/** 현재 사용자의 개인 데이터를 모두 지운다(기기 UI 설정은 남긴다). */
export function clearUserScopedData(store: KeyValueStore | null = defaultStore()): void {
  if (!store) return;
  try {
    for (const key of USER_SCOPED_KEYS) store.removeItem(key);
  } catch { /* 저장소 차단 — 무시 */ }
}

/**
 * 직전 uid 와 비교해 바뀌었으면 이전 사용자 데이터를 청소한다(멱등).
 * linkIdentity(게스트 → 계정 승격)는 uid 가 같아 지우지 않는다.
 */
export function reconcileUserData(currentUid: string | null, store: KeyValueStore | null = defaultStore()): void {
  if (!currentUid || !store) return;
  try {
    const last = store.getItem(LAST_UID_KEY);
    if (last && last !== currentUid) clearUserScopedData(store);
    if (last !== currentUid) store.setItem(LAST_UID_KEY, currentUid);
  } catch { /* 저장소 차단 — 무시 */ }
}
