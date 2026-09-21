'use client';

// 보정 블록의 두 그림.
//
//  1) 보정 곡선: 주차 점유율 → 혼잡 수준. **기준선 대각선을 같이 그린다.** 지금의 기본값이 기준선
//     (보정 없음)이라, 대각선이 없으면 "얼마나 휘었나" 도 "기준이 무엇인가" 도 볼 수 없다.
//  2) 시간대 모양: 서울 실측 인구와 경주 주차 점유율의 하루 모양. 두 신호의 **피크 시각 차이**가
//     주차 신호의 전이 한계를 시간대별로 드러낸다.
//
// recharts 는 SVG 속성으로 색을 내보내 var(--color-*) 를 못 읽는다 — ValidationSeriesChart 와
// 같은 한옥 토큰 미러를 쓴다. 색만으로 구분하지 않도록 '추정·주차' 쪽은 항상 점선이다.

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { CalibrationCurve, HourShapeRow } from '@/lib/engineValidation';
import { calibrationCurveRows } from '@/lib/engineValidation';

// 라이트 종이 테마 전환에 맞춰 미러도 갱신 — 다크 시절 값이 남으면 축·툴팁이 한지 배경에서 씻겨 보인다.
const COLOR = {
  grid: '#d8cab2',     // --color-hanok-line
  axis: '#63533f',     // --color-hanok-muted
  ink: '#251d15',      // --color-hanok-ink
  card: '#fffdf7',     // --color-hanok-card
  measured: '#2f6fb8', // 서울 실측 — 라이트 배경 대비를 위해 한 단계 진하게
  parking: '#8a6a1c',  // 주차 점유율(경주 신호) — 라이트 배경 대비를 위해 한 단계 진하게
  identity: '#8d7f6e', // 기준선 대각선 — 기준이라 일부러 눈에 덜 띄게(라이트에서도 가독 확인)
} as const;

const TOOLTIP = {
  contentStyle: { borderRadius: 8, backgroundColor: COLOR.card, border: `1px solid ${COLOR.grid}`, color: COLOR.ink, fontSize: 12 },
  labelStyle: { color: COLOR.ink },
  cursor: { stroke: COLOR.axis, strokeOpacity: 0.5 },
} as const;

function percent(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full text-sm text-hanok-muted text-center px-4">{children}</div>
  );
}

/** 주차 점유율 → 혼잡 수준. 보정 없음(기준선)이 비교 기준이다. */
export function CalibrationCurveChart({ curve }: { curve: CalibrationCurve | null }) {
  const rows = calibrationCurveRows(curve);
  if (rows.length < 2) {
    return <Empty>보정 곡선을 학습하는 중입니다. 표본이 차면 주차 점유율을 혼잡 수준으로 옮기는 곡선이 여기 그려집니다.</Empty>;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLOR.grid} />
        <XAxis
          dataKey="x"
          type="number"
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          tickFormatter={percent}
          axisLine={false}
          tickLine={false}
          tick={{ fill: COLOR.axis, fontSize: 11 }}
        />
        <YAxis
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          tickFormatter={percent}
          axisLine={false}
          tickLine={false}
          tick={{ fill: COLOR.axis, fontSize: 11 }}
          width={44}
        />
        <Tooltip
          {...TOOLTIP}
          labelFormatter={(x) => `주차 점유율 ${percent(x)}`}
          formatter={(value, name) => [percent(value), name]}
        />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: COLOR.ink }} />
        <Line
          name="기준선 (보정 없음 · 현재 기본값)"
          type="linear"
          dataKey="identity"
          stroke={COLOR.identity}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          name="서울 실측으로 적합한 보정"
          type="monotone"
          dataKey="calibrated"
          stroke={COLOR.measured}
          strokeWidth={2}
          dot={{ r: 2.5 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** 하루 모양 비교 — 서울 실측 인구 vs 경주 주차 점유율(평일·주말). */
export function HourShapeChart({ rows }: { rows: HourShapeRow[] }) {
  if (rows.length === 0) {
    return <Empty>시간대별 평균을 집계하는 중입니다 — 10분 주기로 표본이 누적됩니다.</Empty>;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={COLOR.grid} />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{ fill: COLOR.axis, fontSize: 11 }}
          minTickGap={16}
        />
        <YAxis
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          tickFormatter={percent}
          axisLine={false}
          tickLine={false}
          tick={{ fill: COLOR.axis, fontSize: 11 }}
          width={44}
        />
        <Tooltip {...TOOLTIP} formatter={(value, name) => [percent(value), name]} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: COLOR.ink }} />
        {/* connectNulls 를 쓰지 않는다 — 표본 0인 시각을 이으면 없는 관측이 모양으로 보인다. */}
        <Line name="서울 실측 (평일)" type="monotone" dataKey="seoul_weekday" stroke={COLOR.measured} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line name="서울 실측 (주말)" type="monotone" dataKey="seoul_weekend" stroke={COLOR.measured} strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} isAnimationActive={false} />
        <Line name="경주 주차 점유율 (평일)" type="monotone" dataKey="parking_weekday" stroke={COLOR.parking} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line name="경주 주차 점유율 (주말)" type="monotone" dataKey="parking_weekend" stroke={COLOR.parking} strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
