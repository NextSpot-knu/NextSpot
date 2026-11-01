// 보드 전체를 보고 정하는 것 — 히어로 최단 대기 · 한 등급 접기(I03) · 섹터 줄 세우기. 웹 waiting/page.tsx 의 본문 계산을
// React 없이 옮긴 순수 함수(테스트: boardView.test.ts). 앱 v1 은 경주만이라 boardCrowdView 의 isPublic 은 늘 true.
import { boardCrowdView, orderByWaitThenPhoto, waitHeadlineKey, type BoardCrowdView } from '@/lib/boardOrder';
import { calmAfterClose, heroWaitCandidate, showsCalmLine, type WaitEstimate } from '@/lib/waitEstimate';

import { TOP_CARD_COUNT, type BoardRow, type Sector } from './boardData';
import { PLAIN_DISPLAY, headlineOf, type CardDisplay } from './presentation';

export type WaitOf = (row: BoardRow) => WaitEstimate;

export interface BoardView {
  bestWait: { minutes: number; estimated: boolean } | null;
  showsAnyCalmLine: boolean;
  crowd: BoardCrowdView;
  sharedCalmHour: number | null;
  displayOf: (row: BoardRow) => CardDisplay;
}

/**
 * @param sectors      화면에 보이는 섹터(로딩 중이면 먼저 도착한 조각)
 * @param committed    다 찬 보드 — 한 등급 판정은 여기서만(도착 중인 섹터로 판정하면 카드 문구가 뒤집힌다)
 */
export function computeBoardView(
  sectors: readonly Sector[] | null,
  committed: readonly Sector[] | null,
  waitOf: WaitOf,
  estimateLevels: Record<string, number>,
  busyAt: number,
): BoardView {
  let bestWait: BoardView['bestWait'] = null;
  let showsAnyCalmLine = false;
  for (const sector of sectors ?? []) {
    for (const row of sector.rows) {
      const est = waitOf(row);
      if (!calmAfterClose(est, row.operatingHours) && showsCalmLine(est)) showsAnyCalmLine = true;
      if (row.closedToday) continue;
      if (!heroWaitCandidate(est) || est.minutes === null) continue;
      if (bestWait === null || est.minutes < bestWait.minutes) bestWait = { minutes: est.minutes, estimated: est.estimated };
    }
  }

  const gradedRows: string[] = [];
  const levels: number[] = [];
  const calmHours: (number | null)[] = [];
  for (const sector of committed ?? []) {
    for (const row of sector.rows) {
      if (row.closedToday) continue;
      const est = waitOf(row);
      const h = headlineOf(est, row, estimateLevels[row.facilityId], busyAt);
      const level = h.kind === 'estimate' ? estimateLevels[row.facilityId] : h.kind === 'area' ? row.areaDemandLevel : null;
      if (typeof level !== 'number') continue;
      gradedRows.push(row.facilityId);
      levels.push(level);
      calmHours.push(!calmAfterClose(est, row.operatingHours) && showsCalmLine(est) ? est.calmHour : null);
    }
  }
  const crowd = boardCrowdView(levels, busyAt, { isPublic: true, zoneLineShown: false });
  const uniformRows = new Set(gradedRows.filter((_, i) => crowd.members[i]));
  const uniformCalm = calmHours.filter((_, i) => crowd.members[i]);
  const sharedCalmHour =
    crowd.liftCalm && crowd.spread.uniform && uniformCalm.length > 0 && uniformCalm.every((h) => h !== null && h === uniformCalm[0])
      ? uniformCalm[0]
      : null;
  const displayOf = (row: BoardRow): CardDisplay =>
    !crowd.spread.uniform || !uniformRows.has(row.facilityId)
      ? PLAIN_DISPLAY
      : { walk: true, hideCalm: sharedCalmHour !== null };
  return { bestWait, showsAnyCalmLine, crowd, sharedCalmHour, displayOf };
}

/** 섹터 → 대표 카드(상위 3)와 나머지 행. 오늘 휴무 확정은 대표에서 빼고 행 맨 뒤로. */
export function splitSector(
  sector: Sector,
  waitOf: WaitOf,
  estimateLevels: Record<string, number>,
  busyAt: number,
): { topRows: BoardRow[]; restRows: BoardRow[] } {
  const open = orderByWaitThenPhoto(
    sector.rows.filter((r) => !r.closedToday),
    (row) => {
      const wait = waitOf(row);
      return {
        wait,
        headlineKey: waitHeadlineKey(headlineOf(wait, row, estimateLevels[row.facilityId], busyAt)),
        hasPhoto: row.imageUrls.length > 0,
      };
    },
  );
  const closed = sector.rows.filter((r) => r.closedToday);
  return { topRows: open.slice(0, TOP_CARD_COUNT), restRows: [...open.slice(TOP_CARD_COUNT), ...closed] };
}
