// 공유받은 코스(?s=) 읽기 전용 복원 — 웹 course/page.tsx 의 공유 모드(기준 커밋 0d145a1).
// 받는 사람은 웹 링크를 앱에서 열 수도 있다(딥링크가 연결되면 course?s=… 로 들어온다). 새 추천 호출은 없다.
// 정류지 id 로 facilities 를 읽어 이름·좌표는 최신, 오프셋·혼잡은 공유 시점 스냅샷으로 채운다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createPublicClient } from '~/lib/core/supabase';
import { useT } from '~/lib/i18n/I18nProvider';
import { parseShareParam } from '@/lib/courseShare';

import { trackCourseShareVisit } from './api';
import { rebuildSharedStops, type SharedFacilityRow } from './model';
import type { CourseStop } from './types';

export interface SharedCourseState {
  isShareMode: boolean;
  shareParam: string | null;
  stops: CourseStop[];
  loading: boolean;
  error: string | null;
  /** 공유 뒤 경과 분(옛 포맷·미상은 0). */
  elapsedMin: number;
  reload(): void;
}

export function useSharedCourse(shareParam: string | null): SharedCourseState {
  const t = useT();
  const parsed = useMemo(() => parseShareParam(shareParam), [shareParam]);
  const isShareMode = parsed.stops.length > 0;
  const elapsedMin = useMemo(
    () => (parsed.sharedAtMin == null ? 0 : Math.max(0, Math.floor(Date.now() / 60_000) - parsed.sharedAtMin)),
    [parsed.sharedAtMin],
  );
  const [stops, setStops] = useState<CourseStop[]>([]);
  const [loading, setLoading] = useState(isShareMode);
  const [error, setError] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  // 요청 세대 — 공유 코드(s)가 바뀌면 이전 코드의 늦은 응답이 새 코스를 덮지 않게 버린다(화면이 닫혀도 마찬가지).
  const genRef = useRef(0);
  useEffect(
    () => () => {
      genRef.current += 1;
    },
    [],
  );

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;
    if (!isShareMode) {
      setStops([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const ids = parsed.stops.map((p) => p.id);
      const { data, error: queryError } = await createPublicClient()
        .from('facilities')
        .select('id, name, type, latitude, longitude')
        .in('id', ids);
      if (queryError) throw queryError;
      if (stale()) return;
      setStops(rebuildSharedStops(parsed.stops, (data ?? []) as SharedFacilityRow[], elapsedMin));
    } catch {
      if (stale()) return;
      setStops([]);
      setError(tRef.current('course.sharedError'));
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [isShareMode, parsed.stops, elapsedMin]);

  useEffect(() => {
    void load();
  }, [load]);

  // 공유 코드마다 한 번 — 같은 화면에서 다른 공유 링크로 들어오면 그 코드도 센다(같은 코드로 다시 그려도 다시 세지 않는다).
  const trackedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isShareMode || !shareParam || trackedRef.current === shareParam) return;
    trackedRef.current = shareParam;
    trackCourseShareVisit();
  }, [isShareMode, shareParam]);

  return { isShareMode, shareParam, stops, loading, error, elapsedMin, reload: () => void load() };
}
