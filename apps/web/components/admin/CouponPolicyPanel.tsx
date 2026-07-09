'use client';

import { useState, useEffect, useRef } from 'react';
import { Ticket, Search } from 'lucide-react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import { adminApi } from '@/lib/admin-api';
import { SPOT_WEIGHTS, SPOT_INCENTIVE } from 'shared-types';

// 개입 폐루프(B2G 관제→개입): POI 별 제휴 할인율(coupon_rate)을 슬라이더로 조정하면
// PATCH /api/v1/admin/facilities/{id} 로 즉시 저장되고, 다음 추천 요청부터 w3 인센티브의
// 쿠폰강도(min(1, rate/캡))에 반영돼 사용자 앱 추천 순위가 실시간으로 변한다.
// 읽기는 anon(RLS anon_select_facilities), 쓰기는 관리자 API(service_role) — FacilityTable 과 동일 경로.
const supabase = createPublicClient();

const TYPE_KO: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

// 슬라이더 범위: 산식 캡(20%)까지 — 그 이상은 쿠폰강도 만점으로 동일해 정책적 의미가 없다.
const MAX_RATE_PERCENT = Math.round(SPOT_INCENTIVE.couponRateCap * 100);

interface CouponFacility {
  id: string;
  name: string;
  type: string;
  coupon_rate: number;
}

// 정규화 SPOT 점수(0~1)에 대한 쿠폰강도의 기여분 — score.py 산식과 동일:
// w3 × couponShare × min(1, rate/캡) (정규화 분모 w1+w2+w3=1.0 이라 그대로 점수 기여).
function couponScoreBoost(rate: number): number {
  const strength = Math.min(1, rate / SPOT_INCENTIVE.couponRateCap);
  return SPOT_WEIGHTS.incentive * SPOT_INCENTIVE.couponShare * strength;
}

export function CouponPolicyPanel() {
  const [facilities, setFacilities] = useState<CouponFacility[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // 슬라이더 조작 중의 미저장 값(id → %). 커밋(포인터 릴리즈/포커스 이탈) 시 PATCH 후 본 상태로 병합.
  const [pending, setPending] = useState<Record<string, number>>({});
  // 저장 상태는 '시설별'로 추적한다(여러 슬라이더를 잇달아 조정해도 서로의 상태를 덮지 않게).
  // 단일 savingId 로는 A 저장 중 B 를 저장하면 A 의 상태가 사라지는 레이스가 났다.
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({});
  // 동일 시설의 in-flight PATCH 를 동기적으로 차단(이중 발사 방지). state 는 비동기라
  // 커밋 재진입 가드로는 늦어, 렌더와 무관한 ref 로 즉시 판정한다.
  const inFlight = useRef<Set<string>>(new Set());
  // commitRate 의 finally 는 await 이후에 실행돼 클로저의 pending 이 낡을 수 있다.
  // 최신 pending 을 동기적으로 읽으려고 렌더마다 갱신되는 ref 로 미러링한다.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from('facilities')
          .select('id, name, type, coupon_rate')
          .order('coupon_rate', { ascending: false })
          .order('name', { ascending: true })
          .range(0, 1999);
        if (error) throw error;
        setFacilities(data || []);
      } catch (err: any) {
        console.error('쿠폰 정책 패널 시설 로드 실패:', err);
        // coupon_rate 컬럼 부재(마이그레이션 20260707150000 미적용)도 이 경로로 떨어진다.
        setLoadError(err?.message || '시설 목록을 불러오지 못했습니다.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const ratePercentOf = (f: CouponFacility) =>
    pending[f.id] ?? Math.round((f.coupon_rate || 0) * 100);

  const commitRate = async (f: CouponFacility) => {
    // 커밋 값은 항상 최신 pending(ref)에서 읽는다 — finally 의 재커밋이 낡은 클로저로
    // 호출돼도 사용자의 마지막 값을 집도록.
    const percent = pendingRef.current[f.id];
    // 변경 없음(스냅 값과 동일)이거나 동일 시설이 이미 저장 중이면 재커밋하지 않는다.
    // 후자 가드가 없으면 포인터 릴리즈+포커스 이탈이 겹칠 때 같은 시설에 PATCH 가 이중 발사된다.
    if (percent === undefined || percent === Math.round((f.coupon_rate || 0) * 100)) return;
    if (inFlight.current.has(f.id)) return;
    const rate = percent / 100;
    inFlight.current.add(f.id);
    setSavingIds(prev => ({ ...prev, [f.id]: true }));
    try {
      await adminApi.patch(`/api/v1/admin/facilities/${f.id}`, { coupon_rate: rate });
      setFacilities(prev => prev.map(x => (x.id === f.id ? { ...x, coupon_rate: rate } : x)));
      setSavedIds(prev => ({ ...prev, [f.id]: true }));
      setTimeout(() => setSavedIds(prev => {
        const next = { ...prev };
        delete next[f.id];
        return next;
      }), 1500);
    } catch (err: any) {
      toast.error(`쿠폰 정책 저장 실패: ${err?.message || '알 수 없는 오류'}`);
    } finally {
      inFlight.current.delete(f.id);
      // in-flight 사이 사용자가 값을 더 바꿨을 수 있다(두 번째 릴리즈가 inFlight 가드에 막힌 경우).
      // 방금 커밋한 percent 와 최신 pending 이 같을 때만 pending 을 정리한다. 값이 그새 바뀌었으면
      // pending 을 유지한 채 최신 값으로 재커밋해, 낡은 값으로 '저장됨 ✓' 이 뜨는 레이스를 막는다.
      const latest = pendingRef.current[f.id];
      const superseded = latest !== undefined && latest !== percent;
      if (!superseded) {
        setPending(prev => {
          const next = { ...prev };
          delete next[f.id];
          return next;
        });
      }
      setSavingIds(prev => {
        const next = { ...prev };
        delete next[f.id];
        return next;
      });
      // 재커밋의 no-op 가드가 방금 저장한 값(rate)을 기준으로 판정하도록 f.coupon_rate 를 갱신해 넘긴다.
      if (superseded) commitRate({ ...f, coupon_rate: rate });
    }
  };

  const filtered = facilities.filter(
    f => !search || f.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden col-span-2 flex flex-col">
      <div className="p-6 border-b border-hanok-line bg-hanok-card/30 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-2">
            <Ticket className="text-amber-400" size={20} />
            <h3 className="text-lg font-bold text-hanok-ink">쿠폰 정책 개입 (w3 인센티브)</h3>
          </div>
          <p className="text-xs text-hanok-muted mt-1">
            제휴 할인율을 조정하면 즉시 저장되어 사용자 앱의 추천 순위에 실시간 반영됩니다 — 분산
            목적지에 쿠폰을 걸어 수요를 유도하세요.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-hanok-muted" size={14} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="시설명 검색"
            className="pl-8 pr-3 py-1.5 bg-hanok-card text-hanok-ink placeholder-hanok-muted rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-amber-500 w-40"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto max-h-96">
        {loading ? (
          <div className="p-8 text-center text-hanok-muted text-sm">데이터 로딩 중...</div>
        ) : loadError ? (
          <div className="p-8 text-center text-hanok-muted text-sm">
            시설 목록을 불러오지 못했습니다.
            <div className="text-xs mt-2 text-hanok-muted">
              coupon_rate 마이그레이션(20260707150000) 미적용이면 <code>supabase db push</code> 후
              새로고침하세요.
            </div>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-hanok-panel z-10">
              <tr className="text-hanok-muted text-xs border-b border-hanok-line">
                <th className="px-4 py-3 font-semibold">시설명</th>
                <th className="px-4 py-3 font-semibold w-24">유형</th>
                <th className="px-4 py-3 font-semibold w-64">할인율 (0–{MAX_RATE_PERCENT}%)</th>
                <th className="px-4 py-3 font-semibold w-32 text-right">SPOT 점수 기여</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filtered.map(f => {
                const percent = ratePercentOf(f);
                const boost = couponScoreBoost(percent / 100);
                return (
                  <tr key={f.id} className="border-b border-hanok-line/60 hover:bg-hanok-card/40 transition-colors">
                    <td className="px-4 py-2.5 font-semibold text-hanok-ink">{f.name}</td>
                    <td className="px-4 py-2.5">
                      <span className="px-2 py-0.5 bg-hanok-card text-hanok-muted rounded-md text-xs">
                        {TYPE_KO[f.type] || f.type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={MAX_RATE_PERCENT}
                          step={1}
                          value={percent}
                          // 커밋 시점: 포인터 릴리즈(마우스/터치) + 포커스 이탈(키보드는 화살표로
                          // 자유 조정 후 Tab 이탈 시 1회 커밋). 저장 중에도 disabled 로 막지 않는다 —
                          // disabled 는 포커스를 강제로 날려 키보드 연속 조정을 불가능하게 했다(재커밋은
                          // commitRate 의 in-flight 가드가 차단하므로 disabled 없이도 이중 저장은 없다).
                          onChange={e =>
                            setPending(prev => ({ ...prev, [f.id]: Number(e.target.value) }))
                          }
                          onPointerUp={() => commitRate(f)}
                          onBlur={() => commitRate(f)}
                          className="w-40 accent-amber-500 cursor-pointer"
                        />
                        <span
                          className={`text-xs font-bold w-16 ${
                            percent > 0 ? 'text-amber-300' : 'text-hanok-muted'
                          }`}
                        >
                          {percent > 0 ? `${percent}% 할인` : '제휴 없음'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {savingIds[f.id] ? (
                        <span className="text-xs text-hanok-muted">저장 중…</span>
                      ) : savedIds[f.id] ? (
                        <span className="text-xs font-bold text-emerald-400">저장됨 ✓</span>
                      ) : (
                        <span
                          className={`text-xs font-bold ${
                            boost > 0 ? 'text-amber-300' : 'text-hanok-muted'
                          }`}
                        >
                          +{boost.toFixed(3)}점
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center p-8 text-hanok-muted text-sm">
                    검색 결과가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
