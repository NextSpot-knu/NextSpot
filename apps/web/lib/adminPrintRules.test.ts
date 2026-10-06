// 관제 리포트 인쇄 규칙 가드(I69) — 'PDF로 저장' 은 브라우저 인쇄 창이다. 인쇄 규칙이 없으면 사이드바·머리글·버튼까지
// 함께 찍히고, 화면 높이로 잘린 본문 한 장만 나온다(통계 리포트가 그랬다). 렌더 테스트 러너가 없어 소스에서 막는다
// (adminDashboardWiring.test.ts 와 같은 방식).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

for (const file of ['app/admin/reports/page.tsx', 'app/admin/report/page.tsx']) {
  const src = strip(read(file));
  // A4 용지.
  assert.match(src, /@page \{ size: A4; margin: 14mm; \}/, `${file}: @page A4 규칙이 없다`);
  // 사이드바는 인쇄에서 빠진다(감싸는 요소가 print:hidden).
  const sidebar = src.indexOf('<AdminSidebar');
  assert.ok(sidebar > 0, `${file}: AdminSidebar 를 찾지 못했다`);
  const wrapper = src.lastIndexOf('<div', sidebar);
  assert.match(src.slice(wrapper, sidebar), /print:hidden/, `${file}: 사이드바가 인쇄에 찍힌다`);
  // 머리글(버튼 줄)은 인쇄에서 빠지고, 화면 높이 제약(h-screen·overflow)은 인쇄에서 풀린다.
  assert.match(src, /<header className="print:hidden/, `${file}: 머리글이 인쇄에 찍힌다`);
  assert.match(src, /print:h-auto print:overflow-visible/, `${file}: 인쇄에서 화면 높이 제약이 풀리지 않는다`);
}

{
  const reports = strip(read('app/admin/reports/page.tsx'));
  // 두 차트는 인쇄에서 한 줄에 하나 — 화면 폭 두 칸 그대로면 막대 차트가 추이 차트를 덮는다.
  assert.match(reports, /grid grid-cols-1 lg:grid-cols-2 print:grid-cols-1/, '통계 리포트 차트 줄이 인쇄에서 한 칸으로 바뀌지 않는다');
  assert.match(reports, /break-inside-avoid/, '카드가 인쇄 페이지 경계에서 잘린다');
  // 버튼 이름은 하는 일 그대로(인쇄 창 → PDF로 저장).
  assert.match(reports, /PDF로 저장/);
  assert.doesNotMatch(reports, /PDF 다운로드/, "'PDF 다운로드' 는 인쇄 창을 여는 버튼과 맞지 않는다");
  // 리뷰(10-07): 머리글·기간 막대가 인쇄에서 빠지므로 인쇄 전용 표지 줄이 제목·기간·출처를 말한다
  // (없으면 저장한 PDF 가 무엇의 몇 일치인지 모르는 차트 한 장으로 시작했다).
  const cover = reports.match(/<div className="hidden print:block[^"]*">([\s\S]*?)<\/div>/);
  assert.ok(cover, '통계 리포트에 인쇄 전용 표지 줄(hidden print:block)이 없다');
  assert.match(cover[1], /통계 리포트/, '인쇄 표지에 제목이 없다');
  assert.match(cover[1], /\{rangeLabel\}/, '인쇄 표지에 기간이 없다');
  assert.match(cover[1], /출처: ⓒ한국관광공사/, '인쇄 표지에 출처 표기가 없다');
}

{
  // 성과 리포트는 표지(제목·생성일·데이터 기간)가 종이 안에 있다 — 인쇄에서 감추지 않는다.
  const report = strip(read('app/admin/report/page.tsx'));
  const h1 = report.indexOf('<h1');
  assert.ok(h1 > 0, '성과 리포트 표지 제목(h1)을 찾지 못했다');
  const coverSection = report.slice(report.lastIndexOf('<section', h1), h1);
  assert.doesNotMatch(coverSection, /print:hidden/, '성과 리포트 표지가 인쇄에서 빠진다');
  assert.match(report.slice(h1, h1 + 600), /데이터 기간/, '성과 리포트 표지에 데이터 기간이 없다');
}

console.log('adminPrintRules.test.ts OK');
