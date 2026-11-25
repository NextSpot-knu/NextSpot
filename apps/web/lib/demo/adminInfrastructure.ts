// 관제 '장소 관리' 데모(/admin/infrastructure?demo=1) 고정값 — 백엔드·Supabase 를 부르지 않는다.
// 규칙은 lib/adminDemo.ts 머리말과 같다. 값은 결정적이다(난수·현재 시각 없음). 업체 이름은 일반 명칭이다.

import type { CategoryCode, CategoryShares } from '@/lib/demandPressure';
import type { FacilityCongestion } from '@/lib/adminMetricState';

/** 화면의 Infrastructure(app/admin/infrastructure/page.tsx)와 같은 모양. */
export interface DemoInfrastructure {
  id: string;
  name: string;
  type: '음식점' | '카페' | '관광지' | '문화시설';
  typeCode: CategoryCode | null;
  congestion: FacilityCongestion;
  capacity: string;
}

/** 화면의 IngestRequest 와 같은 모양(snake_case 그대로). */
export interface DemoIngestRequest {
  id: string;
  contentid: string;
  name: string | null;
  content_type_id: number | null;
  status: string;
  created_at: string;
}

export interface DemoChartPoint {
  time: string;
  demand: number;
}

/** MerchantPhotoReview 의 한 행(+ 데모는 로컬 정적 이미지를 직접 가리킨다). */
export interface DemoMerchantPhoto {
  id: string;
  name: string;
  path: string;
  updatedAt: string | null;
  url: string;
}

const TYPE_LABEL: Record<CategoryCode, DemoInfrastructure['type']> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

function place(
  n: number,
  name: string,
  typeCode: CategoryCode,
  congestion: FacilityCongestion,
  capacity: number,
  count: number | null = null,
): DemoInfrastructure {
  return {
    id: `0a1b2c${String(n).padStart(2, '0')}-demo-gyeongju`,
    name,
    type: TYPE_LABEL[typeCode],
    typeCode,
    congestion,
    capacity: count === null ? `정원 ${capacity}명` : `${count}/${capacity}`,
  };
}

export const DEMO_INFRASTRUCTURES: readonly DemoInfrastructure[] = [
  place(1, '황리단길 거리', 'attraction', { kind: 'observed', level: 0.93 }, 1800, 1674),
  place(2, '첨성대', 'attraction', { kind: 'observed', level: 0.91 }, 600, 546),
  place(3, '동궁과 월지', 'attraction', { kind: 'observed', level: 0.66 }, 900, 594),
  place(4, '대릉원', 'attraction', { kind: 'observed', level: 0.48 }, 1200),
  place(5, '월정교', 'attraction', { kind: 'estimated', level: 0.35 }, 500),
  place(6, '교촌마을', 'attraction', { kind: 'estimated', level: 0.22 }, 700),
  place(7, '분황사', 'attraction', { kind: 'observed', level: 0.14 }, 400),
  place(8, '국립경주박물관', 'culture', { kind: 'observed', level: 0.58 }, 1500),
  place(9, '신라 공예 체험관 A', 'culture', { kind: 'estimated', level: 0.27 }, 120),
  place(10, '한옥 찻집 A', 'cafe', { kind: 'observed', level: 0.88 }, 60, 53),
  place(11, '한옥 찻집 B', 'cafe', { kind: 'observed', level: 0.52 }, 45),
  place(12, '골목 로스터리 C', 'cafe', { kind: 'estimated', level: 0.31 }, 38),
  place(13, '한식당 A', 'restaurant', { kind: 'observed', level: 0.91 }, 80, 73),
  place(14, '쌈밥 식당 B', 'restaurant', { kind: 'observed', level: 0.61 }, 70),
  place(15, '분식집 C', 'restaurant', { kind: 'estimated', level: 0.19 }, 32),
];

export const DEMO_INGEST_REQUESTS: readonly DemoIngestRequest[] = [
  {
    id: 'demo-ingest-1',
    contentid: '2950001',
    name: '한옥 공방 체험관 D',
    content_type_id: 12,
    status: 'pending',
    created_at: '2026-11-24T05:12:00.000Z',
  },
  {
    id: 'demo-ingest-2',
    contentid: '2950002',
    name: '보문 호수 산책로',
    content_type_id: 12,
    status: 'pending',
    created_at: '2026-11-24T08:40:00.000Z',
  },
];

/** 업종별 온보딩 선호 비율(수요 압력 카드의 두 번째 항). */
export const DEMO_CATEGORY_SHARES: CategoryShares = {
  sampleSize: 186,
  totalUsers: 412,
  shares: { restaurant: 0.34, cafe: 0.22, attraction: 0.31, culture: 0.13 },
};

export const DEMO_MERCHANT_PHOTOS: readonly DemoMerchantPhoto[] = [
  {
    id: '0a1b2c10-demo-gyeongju',
    name: '한옥 찻집 A',
    path: 'demo/cafe.webp',
    updatedAt: '2026-11-24T02:30:00.000Z',
    url: '/category/cafe.webp',
  },
];

// 낮 시간대 곡선(09~18시) — 현재 혼잡도에 곱해 하루 추이를 그린다. 시설 id 의 글자 합으로 조금씩 달라진다.
const HOUR_CURVE: readonly (readonly [string, number])[] = [
  ['09:00', 0.45],
  ['10:00', 0.62],
  ['11:00', 0.8],
  ['12:00', 0.95],
  ['13:00', 1.0],
  ['14:00', 0.92],
  ['15:00', 0.85],
  ['16:00', 0.78],
];

/** 시설 하나의 '오늘' 추이. level 은 현재 혼잡도(0..1). */
export function demoChartData(facilityId: string, level: number): DemoChartPoint[] {
  let seed = 0;
  for (let i = 0; i < facilityId.length; i++) seed += facilityId.charCodeAt(i);
  return HOUR_CURVE.map(([time, mult], i) => {
    const wobble = ((seed + i * 7) % 9) - 4; // -4..+4
    const raw = Math.round(level * mult * 100) + wobble;
    return { time, demand: Math.min(100, Math.max(0, raw)) };
  });
}
