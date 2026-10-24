'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import { MERCHANT_PHOTO_BUCKET, merchantPhotoUrl } from '@/lib/photoCredit';

// 관제 — 사장님이 올린 가게 사진의 사후 관리(10-24 PM: 사진은 바로 공개, 문제 사진은 관리자가 내린다).
// 사진이 있는 가게만 고른다(features->merchant_photo). 내리기 = clear_merchant_photo RPC(관리자 허용, 앞 경로를
// 돌려준다) → 파일 삭제(관리자 DELETE 정책). 올라온 사진이 없으면 아무것도 그리지 않는다.
interface PhotoRow {
  id: string;
  name: string;
  path: string;
  updatedAt: string | null;
}

export function MerchantPhotoReview() {
  const [rows, setRows] = useState<PhotoRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await createPublicClient()
        .from('facilities')
        .select('id, name, photo:features->merchant_photo')
        .not('features->merchant_photo', 'is', null)
        .limit(200);
      if (!alive || error || !Array.isArray(data)) return;
      const next = (data as Array<{ id: string; name: string; photo: { path?: unknown; updated_at?: unknown } | null }>)
        .map((r) => ({
          id: r.id,
          name: r.name,
          path: typeof r.photo?.path === 'string' ? r.photo.path : '',
          updatedAt: typeof r.photo?.updated_at === 'string' ? r.photo.updated_at : null,
        }))
        .filter((r) => r.path)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      setRows(next);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const takeDown = async (row: PhotoRow) => {
    setBusyId(row.id);
    const supabase = createPublicClient();
    try {
      const { data: previous, error } = await supabase.rpc('clear_merchant_photo', { p_facility_id: row.id });
      if (error) throw error;
      const path = typeof previous === 'string' && previous ? previous : row.path;
      void supabase.storage.from(MERCHANT_PHOTO_BUCKET).remove([path]);
      setRows((current) => current.filter((r) => r.id !== row.id));
      toast.success(`'${row.name}' 사진을 내렸어요.`);
    } catch {
      toast.error('잠시 후 다시 시도해 주세요.');
    } finally {
      setBusyId(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <section className="max-w-3xl mx-auto mb-6 rounded-2xl border border-hanok-line bg-hanok-panel p-4" data-testid="admin-merchant-photos">
      <h3 className="text-base font-bold text-hanok-ink">사장님이 올린 가게 사진 {rows.length}장</h3>
      <p className="mt-1 text-xs text-hanok-muted">올리면 바로 손님 카드에 보여요. 문제 있는 사진은 여기서 내립니다.</p>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {rows.map((row) => {
          const url = merchantPhotoUrl({ merchant_photo: { path: row.path } });
          return (
            <li key={row.id} className="overflow-hidden rounded-xl border border-hanok-line bg-hanok-card">
              {url && <img src={url} alt={`${row.name} 사장님 사진`} className="aspect-[4/3] w-full object-cover" loading="lazy" />}
              <div className="flex items-center justify-between gap-2 p-2">
                <span className="min-w-0 truncate text-xs font-semibold text-hanok-ink">{row.name}</span>
                <button
                  type="button"
                  onClick={() => void takeDown(row)}
                  disabled={busyId === row.id}
                  className="shrink-0 rounded-lg border border-terracotta/40 bg-terracotta/10 px-2.5 py-1 text-xs font-bold text-terracotta disabled:opacity-50"
                >
                  내리기
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
