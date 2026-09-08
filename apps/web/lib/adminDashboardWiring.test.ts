// 관리자 대시보드 배선 가드 — 판정 로직(lib/dashboardFallback.ts)이 살아 있어도 화면이
// 그것을 **부르지 않으면** 아무것도 깨지지 않고 기능만 조용히 사라진다. 타입도 테스트도
// 잡지 못하는 종류의 회귀라 소스에서 직접 막는다
// (lib/searchFallbackWiring.test.ts · lib/congestionAlertWiring.test.ts 와 같은 방식·같은 이유).
//
// 잠그는 사실(사용자가 직접 보고 지적한 것들):
//   (1) 장소 관리 표의 '상태' 배지가 좁은 칸에서 두 글자로 쪼개지지 않는다.
//   (2) 혼잡 카드가 '무엇을 보고 있는지' 를 화면에 말한다(오늘 / 폴백 기준일 / 왜 비었나).
//   (3) '시설 혼잡(제보)' 과 '공영주차 실측(경주 ITS)' 이 같은 지표처럼 읽히지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd(); // 러너가 cwd 를 apps/web 으로 고정한다
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');
// 주석은 걷어낸다 — 주석에 적힌 문자열이 '배선되어 있다' 는 증거가 되면 가드가 무의미해진다.
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

const page = stripComments(read('app/admin/dashboard/page.tsx'));
const heatmap = stripComments(read('components/admin/DashboardCharts.tsx'));
const table = stripComments(read('components/admin/FacilityTable.tsx'));

// ── (1) 장소 관리: '상태' 배지가 줄바꿈되지 않는다 ───────────────────────────
// 사용자 보고: "장소 관리 카드 1페이지의 상태 컬럼에서 '활성' 이라는 단어 절반이 줄바꿈됨".
// 원인은 6칸 표가 col-span-2 카드 안에서 균등 압축되어 상태 칸이 배지보다 좁아진 것이다.
{
  const badge = /<span className="[^"]*whitespace-nowrap[^"]*">활성<\/span>/;
  assert.match(table, badge, "'활성' 배지에 whitespace-nowrap 이 없다 — 좁은 폭에서 두 글자가 쪼개진다");
  // 표 자체에 최소 폭이 없으면 어떤 nowrap 도 칸 압축 자체를 막지 못한다(칸이 배지보다 좁아진다).
  assert.match(
    table,
    /<table className="[^"]*min-w-\[\d+px\][^"]*"/,
    '표에 최소 폭이 없다 — 390px 에서 열이 균등 압축되어 다시 쪼개진다',
  );
  // 최소 폭을 준 표는 부모가 가로 스크롤을 맡아야 한다(안 그러면 카드 밖으로 넘친다).
  assert.match(table, /className="overflow-x-auto"/, '표를 감싼 가로 스크롤 컨테이너가 사라졌다');
}

// ── (2) 혼잡 카드가 '무엇을 보고 있는지' 를 말한다 ──────────────────────────
{
  assert.match(page, /resolveCongestionView\(congestion\)/, '기준 판정을 부르지 않는다 — 화면이 다시 추측한다');
  // 지표를 응답 최상위(오늘 전용)에서 직접 뽑으면 폴백이 영영 그려지지 않는다.
  assert.doesNotMatch(
    page,
    /congestionMetric\(congestion,/,
    '지표를 오늘 슬라이스에서 직접 뽑는다 — 폴백일 집계가 화면에 도달하지 못한다',
  );
  assert.match(page, /const heatmap = \(view\.day\?\.heatmap/, '히트맵이 폴백 집계를 받지 않는다');
  assert.match(page, /const anomalies = \(view\.day\?\.anomalies/, '이상 알림이 폴백 집계를 받지 않는다');

  // 기준일 배지·사유·빈 안내가 실제로 히트맵까지 전달되어야 한다(만들어만 두면 소용없다).
  const props = page.slice(page.indexOf('<DashboardHeatmap'));
  const tag = props.slice(0, props.indexOf('/>') + 2);
  for (const prop of ['dateBadge={dateBadge}', 'basisNote={basisNote}', 'emptyNotice={emptyNotice}']) {
    assert.ok(tag.includes(prop), `히트맵에 ${prop} 을 넘기지 않는다 — 격자만 비고 이유는 안 보인다`);
  }

  // KPI 타일 제목이 기준을 따라가야 한다. '오늘' 로 하드코딩되어 있으면 폴백 중 타일이 거짓이 된다.
  assert.match(page, /\{periodLabel\} 평균 혼잡도/, "평균 혼잡도 제목이 기준을 따라가지 않는다");
  assert.match(page, /이상 혼잡 발생 \(\{periodLabel\}\)/, '이상 혼잡 제목이 기준을 따라가지 않는다');
  assert.doesNotMatch(page, />오늘 평균 혼잡도</, "제목이 '오늘' 로 하드코딩되어 있다");
  assert.doesNotMatch(page, /이상 혼잡 발생 \(오늘\)/, "제목이 '오늘' 로 하드코딩되어 있다");

  // 히트맵 컴포넌트가 빈 격자 대신 사실을 세울 수 있어야 한다.
  assert.match(heatmap, /heatmapData\.length === 0 && emptyNotice/, '셀이 0개일 때도 빈 격자를 그린다');
  assert.match(heatmap, /\{dateBadge\}/, '히트맵이 기준일 배지를 그리지 않는다');

  // 사실과 반대로 읽히던 옛 문구를 되살리지 않는다 — 지금 이 화면이 비는 이유는
  // 정확히 '데이터가 없어서' 다(congestion_logs 의 최신 행이 19일 전).
  assert.doesNotMatch(
    page,
    /데이터가 없다는 뜻이 아닙니다/,
    "빈 화면을 '데이터 없음이 아니다' 라고 단정하는 옛 문구가 돌아왔다",
  );
}

// ── (3) 두 지표를 섞지 않는다 ────────────────────────────────────────────────
// 시설 혼잡(제보 기반)과 공영주차 실측(경주 ITS)은 원천도 단위도 다르다. 같은 구역에
// 나란히 두는 대신, 각각 자기 출처 라벨을 달고 있어야 한다.
{
  const stepOne = page.indexOf('badge="①"');
  const stepTwo = page.indexOf('badge="②"');
  const parking = page.indexOf('<AreaDemandReliabilityPanel />');
  assert.ok(stepOne >= 0 && stepTwo > stepOne, '폐루프 ①/② 배너 구조가 바뀌었다');
  assert.ok(
    parking > stepOne && parking < stepTwo,
    "공영주차 실측이 '① 실시간 관제' 구역 밖에 있다 — 관제 구역이 통째로 죽은 것처럼 보인다",
  );
  assert.match(page, /공영주차 실측 \(경주 ITS/, '주차 실측 카드에 출처 라벨이 없다');
  assert.match(page, /시설 혼잡 \(손님 제보/, '시설 혼잡 지표에 출처 라벨이 없다');
  assert.match(page, /합산하지 않음/, '두 지표를 합치지 않는다는 사실이 화면에 없다');
  assert.match(heatmap, /시설 혼잡 · 제보 기반/, '히트맵 제목 옆 출처 라벨이 없다');
}

console.log('adminDashboardWiring.test.ts OK');
