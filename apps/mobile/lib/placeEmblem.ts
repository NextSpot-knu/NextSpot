// 사진 없는 장소 표지의 경주 문양 경로 — 웹 apps/web/components/PlacePhotoFallback.tsx 24-90 의 순수 함수를 그대로 복사했다
// (원본이 .tsx·lucide 에 묶여 있어 check:shared 로 공유할 수 없다. 원본 기준 커밋 f4dc88b — PORTING.md 참고).
// 문양 한 점은 viewBox 100×112 에 선으로만 그린다(색은 호출부). 무엇을 고를지는 @/lib/placeVisual(장소 id → 문양·색).
import type { PlaceMotif } from '@/lib/placeVisual';

const f1 = (n: number) => Number(n.toFixed(1));

/** 기와 — 겹친 암키와 끝(반원 호가 엇갈려 줄지음). */
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

/** 수막새 — 연꽃 막새(겹원 둘 + 가운데 + 꽃잎 8). */
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

/** 석탑 — 3층 석탑: 기단, 층마다 몸돌과 끝이 들린 지붕돌, 꼭대기 상륜. */
function pagodaEmblem(cx: number): string {
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

/** 물결 — 파도문 세 줄(줄마다 반 칸씩 어긋남). */
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

/** 문살 — 띠살 창: 굵은 창틀 안에 가는 살. 오른쪽 아래로 잘려 들어간다. */
function latticeEmblem(): string {
  const lines: string[] = ['M56 58 H112 M56 58 V116', 'M60 62 H112 M60 62 V116'];
  for (let x = 68; x < 112; x += 8) lines.push(`M${x} 62 V116`);
  for (let y = 74; y < 116; y += 12) lines.push(`M60 ${y} H112`);
  return lines.join(' ');
}

export const EMBLEM: Record<PlaceMotif, string> = {
  giwa: scallopRows([82, 92, 102, 112], 10),
  roundel: roundelEmblem(80, 94),
  pagoda: pagodaEmblem(80),
  wave: waveEmblem(),
  lattice: latticeEmblem(),
};

/** 같은 문양이라도 장소마다 문장이 조금씩 옆으로 비껴 선다(-6~+6). phase 0~1. */
export function emblemShift(phase: number): string {
  return (phase * 12 - 6).toFixed(1);
}
