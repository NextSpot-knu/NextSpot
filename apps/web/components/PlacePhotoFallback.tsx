import type { CSSProperties } from 'react';
import { Coffee, Landmark, MapPin, Mountain, UtensilsCrossed, type LucideIcon } from 'lucide-react';
import { PLACE_TONE_VAR, type PlaceGlyph, type PlaceMotif, type PlaceVisual } from '@/lib/placeVisual';

// 사진이 없는 장소의 표지 — 사진 자리를 같은 크기로 채우는 경주 문양 판 + 가운데 유형 그림.
// 무엇을 고를지는 lib/placeVisual.ts(장소 id → 문양·색, 결정적). 여기서는 그리기만 한다.
//
// - <img> 를 절대 넣지 않는다: 대기 보드 테스트와 출처 탐침은 카드의 첫 <img> 가 사진이라고 본다
//   (문양·그림은 인라인 SVG 뿐). 사진은 이 판 **위에** 겹쳐 그려지고, 로드되면 서서히 드러난다.
// - 장식이다(aria-hidden) — 카드의 이름은 카드 본문이 말한다. 글자·i18n 문구 없음.
// - 색은 --tile(장소마다) · 판 바탕은 globals.css 의 .place-tile(야간 값은 html.nextspot-dark 가 바꾼다).

// 섹터 머리의 기호와 같은 말을 한다: 문화시설(🏛) = 기둥 건물, 관광지 = 산·능(경주의 능선·고분·산사).
// 팔레트는 쓰지 않는다 — 고분정보센터 같은 곳에 붙으면 화실·공방으로 읽힌다.
const GLYPH_ICON: Record<PlaceGlyph, LucideIcon> = {
  restaurant: UtensilsCrossed,
  cafe: Coffee,
  attraction: Mountain,
  culture: Landmark,
  default: MapPin,
};

// 문장(紋章) — 판 아래쪽을 크게 잘라 채우는 경주 문양 한 점(viewBox 100×112). 선만 긋는다(currentColor).
// 기와(겹친 암키와 끝) · 수막새(연꽃 막새) · 석탑(3층 석탑) · 물결(파도문) · 문살(띠살 창).
const f1 = (n: number) => Number(n.toFixed(1));
function scallopRows(rows: number[], r: number): string {
  return rows
    .map((y, row) => {
      const start = row % 2 === 0 ? -r : 0;
      const arcs: string[] = [];
      for (let x = start; x < 100 + r; x += 2 * r) arcs.push(`M${f1(x)} ${y} A${r} ${r} 0 0 1 ${f1(x + 2 * r)} ${y}`);
      return arcs.join(' ');
    })
    .join(' ');
}
function roundelEmblem(cx: number, cy: number): string {
  const ring = (r: number) => `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy}`;
  const petals = Array.from({ length: 8 }, (_, k) => {
    const a = (k * Math.PI) / 4;
    const [x1, y1] = [cx + 8 * Math.cos(a), cy + 8 * Math.sin(a)];
    const [x2, y2] = [cx + 19 * Math.cos(a), cy + 19 * Math.sin(a)];
    const [nx, ny] = [-Math.sin(a) * 5, Math.cos(a) * 5];
    const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
    return `M${f1(x1)} ${f1(y1)} Q${f1(mx + nx)} ${f1(my + ny)} ${f1(x2)} ${f1(y2)} Q${f1(mx - nx)} ${f1(my - ny)} ${f1(x1)} ${f1(y1)}`;
  });
  return [ring(30), ring(24), ring(4.5), ...petals].join(' ');
}
function pagodaEmblem(cx: number): string {
  // 3층 석탑 — 기단, 층마다 몸돌과 끝이 들린 지붕돌, 꼭대기 상륜.
  const roof = (y: number, w: number) =>
    `M${f1(cx - w / 2)} ${y} Q${f1(cx - w / 2 + 3)} ${y - 4} ${f1(cx - w / 2 + 8)} ${y - 4} H${f1(cx + w / 2 - 8)} Q${f1(cx + w / 2 - 3)} ${y - 4} ${f1(cx + w / 2)} ${y}`;
  const body = (yTop: number, yBottom: number, w: number) =>
    `M${f1(cx - w / 2)} ${yBottom} V${yTop} H${f1(cx + w / 2)} V${yBottom}`;
  return [
    `M${cx - 28} 112 V106 H${cx + 28} V112`,
    body(94, 106, 20), roof(94, 42),
    body(82, 90, 16), roof(82, 34),
    body(72, 78, 12), roof(72, 26),
    `M${cx} 68 V56 M${cx - 3.5} 64 H${cx + 3.5} M${cx - 2.5} 60 H${cx + 2.5}`,
  ].join(' ');
}
function waveEmblem(): string {
  return [80, 91, 102]
    .map((y, i) => {
      const shift = i % 2 === 0 ? 0 : 12.5;
      let d = `M${-25 + shift} ${y}`;
      for (let x = -25 + shift; x < 125; x += 25) d += ` Q${x + 6.25} ${y - 7} ${x + 12.5} ${y} T${x + 25} ${y}`;
      return d;
    })
    .join(' ');
}
function latticeEmblem(): string {
  // 띠살 창 — 굵은 창틀 안에 가는 살. 오른쪽 아래로 잘려 들어간다.
  const lines: string[] = ['M56 58 H112 M56 58 V116', 'M60 62 H112 M60 62 V116'];
  for (let x = 68; x < 112; x += 8) lines.push(`M${x} 62 V116`);
  for (let y = 74; y < 116; y += 12) lines.push(`M60 ${y} H112`);
  return lines.join(' ');
}
const EMBLEM: Record<PlaceMotif, string> = {
  giwa: scallopRows([82, 92, 102, 112], 10),
  roundel: roundelEmblem(80, 94),
  pagoda: pagodaEmblem(80),
  wave: waveEmblem(),
  lattice: latticeEmblem(),
};

export function PlacePhotoFallback({
  visual,
  className = 'relative',
}: {
  visual: PlaceVisual;
  /** 자리·크기 — 기본은 relative(흐름 안). 사진 아래에 깔 때는 'absolute inset-0'. 내부 그림은 이 상자를 채운다. */
  className?: string;
}) {
  const Icon = GLYPH_ICON[visual.glyph];
  const style = { '--tile': `var(${PLACE_TONE_VAR[visual.tone]})` } as CSSProperties;
  // 같은 문양이라도 장소마다 문장이 조금씩 옆으로 비껴 선다(-6~+6).
  const shift = (visual.phase * 12 - 6).toFixed(1);

  return (
    <div
      className={`place-tile overflow-hidden ${className}`}
      style={style}
      data-photo-fallback={visual.glyph}
      data-motif={visual.motif}
      data-tone={visual.tone}
      aria-hidden
    >
      {/* ① 문장 — 장소의 문양을 크게 한 점, 오른쪽 아래로 잘라 넣는다. 잔무늬를 판 전체에 깔면 '벽지'·로딩 자리처럼
          보여서, 크게 잘린 한 점만 둔다 — 표지 그림으로 읽힌다. */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 112"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
        data-tile-pattern
      >
        <path
          transform={`translate(${shift} 0)`}
          d={EMBLEM[visual.motif]}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* ② 유형 그림 — 둥근 받침 위(야간에도 받침 테두리가 판과 갈린다). 세로 54%: 왼쪽 위의 순위 배지(28px)와
          320px 화면(카드 폭 ~80px)에서도 4px 넘게 떨어진다 — 40% 에서는 360px 부터 배지와 닿았다. */}
      <span className="absolute left-1/2 top-[54%] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-hanji/90 ring-1 ring-current/40 shadow-[0_2px_10px_rgba(43,35,32,0.12)]">
        <Icon size={20} strokeWidth={1.8} data-tile-glyph />
      </span>
    </div>
  );
}
