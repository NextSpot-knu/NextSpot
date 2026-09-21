'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { chartRows, formatKst, type ChartRow, type SeriesPoint } from '@/lib/engineValidation';

// recharts 는 SVG 속성으로 색을 내보내 var(--color-*) 를 못 읽는다 — globals.css 한옥 토큰을 미러링한다
// (components/admin/DashboardCharts.tsx 와 같은 방식). 라이트 종이 테마 전환에 맞춰 미러도 갱신했다 —
// 다크 시절 값이 남으면 축·툴팁이 한지 배경에서 씻겨 보인다. 두 선(실측 파랑·추정 골드)은 라이트
// 배경에서도 명도·색각이상 분리가 유지되고, 색만으로 구분하지 않도록 추정은 점선이다 —
// 프로젝트 전체에서 '추정' 은 실측과 같은 모양으로 그리지 않는다.
const COLOR = {
  grid: '#d8cab2',    // --color-hanok-line
  axis: '#63533f',    // --color-hanok-muted
  ink: '#251d15',     // --color-hanok-ink
  card: '#fffdf7',    // --color-hanok-card
  actual: '#2f6fb8',  // 서울 실측(정규화 인구) — 라이트 배경 대비를 위해 한 단계 진하게
  estimate: '#8a6a1c', // NextSpot 추정 혼잡도 — 라이트 배경 대비를 위해 한 단계 진하게
} as const;

const GRADE_EDGES: { y: number; label: string }[] = [
  { y: 0.25, label: '보통' },
  { y: 0.5, label: '약간 붐빔' },
  { y: 0.75, label: '붐빔' },
];

function percent(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
}

export function ValidationSeriesChart({ series }: { series: SeriesPoint[] }) {
  const rows = chartRows(series);
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-hanok-muted text-center px-4">
        10분 주기로 표본을 수집하는 중입니다 — 수집된 구간부터 곡선이 그려집니다.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 8, right: 56, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={COLOR.grid} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(t: number) => formatKst(new Date(t).toISOString())}
          axisLine={false}
          tickLine={false}
          tick={{ fill: COLOR.axis, fontSize: 11 }}
          minTickGap={48}
        />
        <YAxis
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          axisLine={false}
          tickLine={false}
          tick={{ fill: COLOR.axis, fontSize: 11 }}
          width={44}
        />
        {/* 추정 등급 경계(0.25·0.50·0.75). 선 위 이름은 그 경계부터 시작하는 등급이다. */}
        {GRADE_EDGES.map((edge) => (
          <ReferenceLine
            key={edge.y}
            y={edge.y}
            stroke={COLOR.axis}
            strokeOpacity={0.45}
            strokeDasharray="2 4"
            label={{ value: edge.label, position: 'right', fill: COLOR.axis, fontSize: 10 }}
          />
        ))}
        <Tooltip
          labelFormatter={(t) => `${formatKst(new Date(Number(t)).toISOString())} (KST)`}
          formatter={(value, name, item) => {
            const row = (item as { payload?: ChartRow } | undefined)?.payload;
            const grade = name === '서울 실측 (정규화 인구)' ? row?.actualGrade : row?.estimateGrade;
            return [grade ? `${percent(value)} · ${grade}` : percent(value), name];
          }}
          contentStyle={{ borderRadius: 8, backgroundColor: COLOR.card, border: `1px solid ${COLOR.grid}`, color: COLOR.ink, fontSize: 12 }}
          labelStyle={{ color: COLOR.ink }}
          cursor={{ stroke: COLOR.axis, strokeOpacity: 0.5 }}
        />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: COLOR.ink }} />
        {/* connectNulls 를 쓰지 않는다 — 수집이 끊긴 구간을 선으로 이으면 없는 관측이 추세로 보인다. */}
        <Line
          name="서울 실측 (정규화 인구)"
          type="linear"
          dataKey="actual"
          stroke={COLOR.actual}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
          connectNulls={false}
          isAnimationActive={false}
        />
        <Line
          name="NextSpot 추정 혼잡도"
          type="linear"
          dataKey="estimate"
          stroke={COLOR.estimate}
          strokeWidth={2}
          strokeDasharray="6 4"
          dot={false}
          activeDot={{ r: 4 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
