// 핀 점수에 쓰는 선호 분류 — 로그인했으면 Supabase users.preferred_categories(웹 page.tsx 1165-1172), 없으면 빈 목록(전체 균등).
// 실패는 조용히 빈 목록 — 핀 순서가 조금 달라질 뿐 화면을 막지 않는다.
import { useEffect, useState } from 'react';

import { createPublicClient } from '~/lib/core/supabase';

export function usePreferredCategories(): readonly string[] {
  const [categories, setCategories] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const supabase = createPublicClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.user) return;
        const { data } = await supabase.from('users').select('preferred_categories').eq('id', session.user.id).single();
        const list = data?.preferred_categories;
        if (alive && Array.isArray(list)) setCategories(list.map(String));
      } catch {
        /* 선호를 모르면 균등 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return categories;
}
