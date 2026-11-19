// 홈 주차장 탭의 자료 — 웹 app/main/page.tsx 주차장 탭 effect(1231-1279)의 앱판(G2-25 5번).
// 탭이 켜져 있을 때만 묻는다(공개 GET, 반경 5km, 6초). 위치가 바뀌거나 '다시 시도'를 누르면 다시 묻는다. 실패는 목록·선택을 비우고
// error 를 켠다. 선택은 같은 id 를 이어 가고, 없으면 첫 주차장(가장 가까운 곳)을 고른다 — 웹과 같이 탭을 열면 카드가 바로 뜬다.
import { useCallback, useEffect, useState } from 'react';

import { getParkingLots } from '~/lib/core/apiClient';

import { keepParkingSelection, mapParkingLots, PARKING_RADIUS_M, type ParkingLot } from './parkingModel';

export interface ParkingLotsState {
  lots: ParkingLot[];
  loading: boolean;
  error: boolean;
  selected: ParkingLot | null;
  /** 핀을 눌렀을 때(웹 마커 click → setSelectedParkingLot). 카메라 이동은 화면 몫(panToVisible). */
  select: (lot: ParkingLot | null) => void;
  /** '다시 시도'(웹 parkingReloadNonce). */
  reload: () => void;
}

export function useParkingLots(active: boolean, location: { lat: number; lng: number }): ParkingLotsState {
  const [lots, setLots] = useState<ParkingLot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<ParkingLot | null>(null);
  const [nonce, setNonce] = useState(0);
  // 마지막으로 끝난 요청의 키 — 탭을 켠 첫 그림에서(효과가 돌기 전) '못 찾았어요' 가 한 번 번쩍이지 않게 그때도 '불러오는 중' 으로 본다.
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const { lat, lng } = location;
  const key = `${lat},${lng},${nonce}`;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setError(false);
    getParkingLots({ lat, lng }, { radiusM: PARKING_RADIUS_M })
      .then((response) => {
        if (!alive) return;
        const mapped = mapParkingLots(response);
        setLots(mapped);
        setSelected((current) => keepParkingSelection(current, mapped));
      })
      .catch(() => {
        if (!alive) return;
        setLots([]);
        setSelected(null);
        setError(true);
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        setDoneKey(`${lat},${lng},${nonce}`);
      });
    return () => {
      alive = false;
    };
  }, [active, lat, lng, nonce]);

  const select = useCallback((lot: ParkingLot | null) => setSelected(lot), []);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { lots, loading: active && (loading || doneKey !== key), error, selected, select, reload };
}
