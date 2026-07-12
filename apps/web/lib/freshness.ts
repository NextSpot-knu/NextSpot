// 데이터 신선도 상대시간 로직 — admin/DataFreshnessBadge.tsx 의 formatRelative 를 승격(단일 소스).
// 최신 타임스탬프와 현재시각의 차이를 사람이 읽는 상대시간 '조각'(값+단위)으로 환산한다.
// 미래 타임스탬프(음수 차이)는 '방금 전'(now)으로 안전하게 수렴한다.
// 표시 문자열의 i18n(ko/en/ja/zh)은 호출부(t())가 담당하도록 값/단위만 반환한다 —
// 정직성 원칙(로그 없음/파싱 실패는 null 반환)을 유지한다.

export type RelativeUnit = 'now' | 'min' | 'hour' | 'day';
export interface RelativeParts {
  value: number; // now 이면 0
  unit: RelativeUnit;
}

// 상대시간 조각. 입력이 없거나(널) 파싱 불가면 null(신선한 것으로 위장하지 않음).
export function relativeParts(from: Date | string | number | null | undefined): RelativeParts | null {
  if (from === null || from === undefined || from === '') return null;
  const d = from instanceof Date ? from : new Date(from);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return null;

  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 1) return { value: 0, unit: 'now' };
  if (diffMin < 60) return { value: diffMin, unit: 'min' };
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return { value: diffHour, unit: 'hour' };
  const diffDay = Math.floor(diffHour / 24);
  return { value: diffDay, unit: 'day' };
}

// admin/DataFreshnessBadge 의 기존 한국어 표기와 1:1 동일한 문자열(향후 그 배지가 이 헬퍼로 수렴할 때 재사용).
export function formatRelativeKo(from: Date | string | number): string {
  const p = relativeParts(from);
  if (!p || p.unit === 'now') return '방금 전';
  if (p.unit === 'min') return `${p.value}분 전`;
  if (p.unit === 'hour') return `${p.value}시간 전`;
  return `${p.value}일 전`;
}
