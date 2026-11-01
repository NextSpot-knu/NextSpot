// 공유받은 코스(?s=) 읽기 전용 복원 — 웹 course/page.tsx 의 공유 모드(기준 커밋 0d145a1).
// 받는 사람은 웹 링크를 앱에서 열 수도 있다(딥링크가 연결되면 course?s=… 로 들어온다). 새 추천 호출은 없다.
// 정류지 id 로 facilities 를 읽어 이름·좌표는 최신, 오프셋·혼잡은 공유 시점 스냅샷으로 채운다.
import { useCallback, useEffect, useMemo, useState } from 'react';

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

  const load = useCallback(async () => {
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
      setStops(rebuildSharedStops(parsed.stops, (data ?? []) as SharedFacilityRow[], elapsedMin));
    } catch {
      setStops([]);
      setError(t('course.sharedError'));
    } finally {
      setLoading(false);
    }
  }, [isShareMode, parsed.stops, elapsedMin, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (isShareMode) trackCourseShareVisit();
    // 진입 1회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isShareMode, shareParam, stops, loading, error, elapsedMin, reload: () => void load() };
}
