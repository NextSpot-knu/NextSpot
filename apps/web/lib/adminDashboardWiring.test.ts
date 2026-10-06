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
const estimateView = stripComments(read('lib/adminEstimateView.ts'));

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
  // 판정은 추정 갈래를 얹은 resolveDashboardView 가 하고, 그 안에서 기존 폴백 판정을 그대로 쓴다.
  assert.match(page, /resolveDashboardView\(congestion\)/, '기준 판정을 부르지 않는다 — 화면이 다시 추측한다');
  assert.match(
    estimateView,
    /return resolveCongestionView\(res\)/,
    '추정이 없을 때 기존 폴백 판정으로 물러나지 않는다 — 폴백 규칙이 두 벌이 된다',
  );
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

// ── (4) 추정 모드 — 추정치는 라벨·근거 없이 그려지지 않는다 ──────────────────
// 사용자 요구: 오늘 실측이 비면 추정을 보여 주되, 모든 추정 값에 '추정' 표식과 근거 문장이 붙는다.
{
  const props = page.slice(page.indexOf('<DashboardHeatmap'));
  const tag = props.slice(0, props.indexOf('/>') + 2);
  assert.ok(tag.includes('estimate={'), '히트맵에 추정 표식을 넘기지 않는다 — 추정 격자가 실측처럼 그려진다');
  assert.ok(tag.includes('pendingFromHour={'), "히트맵이 '아직 오지 않은 시간' 을 모른다 — 새벽 화면이 '수집 중단' 으로 읽힌다");
  assert.match(heatmap, /estimate\.basisLine/, '히트맵이 추정 근거 문장을 그리지 않는다');
  assert.match(heatmap, /아직 오지 않은 시간/, "히트맵 범례에 '아직 오지 않은 시간' 이 없다");

  // KPI 두 타일과 알림 목록이 전부 추정 배지를 단다(한 곳만 빠져도 그 카드는 실측으로 읽힌다).
  const badges = page.match(/isEstimate && <EstimateBadge/g) ?? [];
  assert.ok(badges.length >= 4, `추정 배지가 ${badges.length}곳뿐이다 — 평균·이상 건수·알림 제목·알림 항목에 모두 있어야 한다`);
  assert.match(page, /\{estimateLine\}/, '추정 근거 문장(주차장 수·관측 시각·반경)을 화면에 그리지 않는다');
  // 추정 모드에서 '손님 제보 · 좌석 방송 기반' 제목은 거짓이다.
  assert.match(page, /시설 혼잡 \(추정 · 주차 실측 \+ 관광 통계\)/, '추정 모드의 출처 제목이 없다');

  // 엔진 검증 화면으로 가는 링크(데이터 조회 없이 링크만).
  assert.match(page, /href="\/admin\/engine-validation"/, '엔진 검증 화면 링크가 없다');

  // D6: 합성·수동 적재 버튼은 걷어냈다 — 되살아나면 추정과 이중 집계된다.
  assert.doesNotMatch(page, /SimulatePeakButton|ParkingDerivedEstimateButton/, '걷어낸 모의 발생/수동 추정 적재 버튼이 돌아왔다');
}

// ── (5) 첫 화면은 기능설명서의 KPI 네 개 — 엔진 내부 수치는 맨 아래(2026-10-06 심사 동선) ──
// 심사위원은 관제 화면을 열자마자 '평균 혼잡도·추천 수락률·활성 사용자·이상 혼잡' 을 찾는다.
// 예전 첫 화면은 추천 신뢰도 패널(깔때기 0건·학습 관문)과 산식 박스가 차지해 KPI 가 한 화면 아래였다.
{
  const kpis = page.indexOf('id="dashboard-kpis"');
  const trust = page.indexOf('<ModelTrustPanel');
  assert.ok(kpis >= 0, 'KPI 격자 앵커(id="dashboard-kpis")가 없다');
  assert.ok(trust > kpis, '추천 신뢰도 패널이 KPI 격자보다 위에 있다 — 첫 화면이 다시 엔진 내부 수치가 된다');
  assert.equal(page.split('<ModelTrustPanel').length - 1, 1, '추천 신뢰도 패널이 두 번 그려진다');
  // 맨 아래로 내렸을 뿐 감추지 않는다(기능설명서 '모델 신뢰 패널') — 접힌 상자 안에 넣지 않는다.
  assert.ok(trust > page.indexOf('<FacilityTable'), '추천 신뢰도 패널이 페이지 맨 아래(장소 관리 표 다음)에 있지 않다');
  const openBefore = page.lastIndexOf('<details', trust);
  assert.ok(openBefore < 0 || page.lastIndexOf('</details>', trust) > openBefore, '추천 신뢰도 패널이 접힌 <details> 안에 들어갔다');

  // 추정·예측 배너는 한 줄 — 근거 문장·산식·전환 문장은 '산식 보기' 를 열어야 보인다.
  const detailsAround = (token: string) => {
    const at = page.indexOf(token);
    assert.ok(at >= 0, `${token} 을 그리지 않는다`);
    assert.equal(page.split(token).length - 1, 1, `${token} 이 배너 밖에서도 그려진다`);
    const open = page.lastIndexOf('<details', at);
    const close = page.indexOf('</details>', at);
    assert.ok(open >= 0 && close > at && page.lastIndexOf('</details>', at) < open, `${token} 이 <details> 안에 있지 않다 — 산식이 첫 화면에 펼쳐진다`);
    const block = page.slice(open, close);
    assert.match(block, /<summary[\s\S]*산식 보기[\s\S]*<\/summary>/, `${token} 을 여는 요약 줄에 '산식 보기' 가 없다`);
    return block;
  };
  const estimateBlock = detailsAround('{estimateMethod}');
  assert.ok(estimateBlock.includes('{estimateLine}'), '추정 근거 문장({estimateLine})이 산식 보기 안에 없다');
  assert.match(estimateBlock, /오늘 시설 혼잡은 공영주차 실측과 관광공사 통계로 추정했어요/, '추정 배너의 한 줄 문장이 없다');
  const predictedBlock = detailsAround('{predictedMethod}');
  assert.ok(predictedBlock.includes('{PREDICTED_SWITCH_SENTENCE}'), '예측 전환 문장이 산식 보기 안에 없다');
  // 예측 배너도 추정 배너와 같은 모양(칩 '예측 · 오늘' + 해요체 한 줄) — 두 모드가 첫 화면 같은 자리에서
  // 칩 형식·말투가 갈리지 않게. 앵커를 적는 긴 제목 문장({predictedHeadline})은 펼친 쪽에 둔다.
  const predictedSummary = predictedBlock.slice(0, predictedBlock.indexOf('</summary>'));
  assert.match(predictedSummary, /\{PREDICTED_BADGE\} · 오늘\s*</, "예측 배너 칩이 추정 배너와 같은 '예측 · 오늘' 이 아니다");
  assert.match(predictedSummary, /오늘 시설 혼잡은 업종 시간대 패턴으로 예측했어요/, '예측 배너의 한 줄 문장이 없다');
  assert.ok(!predictedSummary.includes('{predictedHeadline}') && predictedBlock.includes('{predictedHeadline}'), '예측 배너 제목 문장이 산식 보기 안에 있지 않다');
  const estimateSummary = estimateBlock.slice(0, estimateBlock.indexOf('</summary>'));
  assert.match(estimateSummary, /\{ESTIMATE_BADGE\} · 오늘\s*</, "추정 배너 칩이 '추정 · 오늘' 이 아니다");

  // 표본 절단 칩('최신 구간 기준')은 ① 제목 줄 안(내보내기 버튼 옆)에 있다 — 따로 한 줄을 차지하면
  // 1366×650 에서 두 줄 브리핑과 겹친 날 KPI 숫자가 첫 화면 밖으로 밀린다(e2e 1366×650 케이스).
  const stepOne = page.indexOf('badge="①"');
  const chip = page.indexOf('최신 구간 기준');
  assert.equal(page.split('최신 구간 기준').length - 1, 1, '표본 절단 칩이 두 번 그려진다');
  assert.ok(stepOne >= 0 && chip > stepOne && chip < page.indexOf('데이터 내보내기 (CSV)'), '표본 절단 칩이 ① 제목 줄(내보내기 버튼 옆)에 있지 않다');

  // ① 부제는 데이터 원천을 말하고, 출처 표기는 따로 한 줄이다(부제 안에 섞지 않는다).
  const stepOneTag = page.slice(page.lastIndexOf('<StepBanner', page.indexOf('badge="①"')), page.indexOf('/>', page.indexOf('badge="①"')));
  assert.match(stepOneTag, /경주 관광정보 .*경주 ITS 공영주차\(10분마다\)로 지금 경주의 혼잡을 봅니다/, '① 부제가 데이터 원천을 말하지 않는다');
  assert.match(stepOneTag, /credit="출처: ⓒ한국관광공사"/, '① 아래 출처 한 줄이 없다');
  // 서울 데이터는 경주 관제의 첫인상이 아니다 — 검증 화면 링크는 맨 아래, 서울 문구 없이.
  assert.doesNotMatch(page, /서울/, '대시보드 화면 문구에 서울이 남아 있다');
  assert.ok(page.indexOf('href="/admin/engine-validation"') > trust, '엔진 검증 링크가 추천 신뢰도 패널과 함께 맨 아래에 있지 않다');
}

// ── (6) 기능설명서 순서 ①→②→③ · 단계 바 · KPI 32px · 실선 테두리 · 관리 열 고정(2026-10-07 B4) ──────────
// 예전 순서는 ① → (30일 차트 = ③) → ② → ③ 이었고, 주차 소제목이 신뢰도 패널이 아니라 30일 차트 위에 있어
// 차트가 주차 데이터처럼 읽혔다(I17 · I20). 점선 카드 테두리는 디버그 선처럼 보였다.
{
  const at = (token: string) => {
    const i = page.indexOf(token);
    assert.ok(i >= 0, `${token} 을 찾지 못했다`);
    return i;
  };
  const stepOne = at('badge="①"');
  const kpis = at('id="dashboard-kpis"');
  const heatmapAt = at('<DashboardHeatmap');
  const parkingHeading = at('공영주차 실측 (경주 ITS');
  const reliability = at('<AreaDemandReliabilityPanel />');
  const stepTwo = at('badge="②"');
  const coupon = at('<CouponPolicyPanel');
  const impact = at('<ImpactWidget');
  const stepThree = at('badge="③"');
  const charts = at('<DashboardCharts');
  const tableAt = at('<FacilityTable');
  const trust = at('<ModelTrustPanel');
  const order = [stepOne, kpis, heatmapAt, parkingHeading, reliability, stepTwo, coupon, impact, stepThree, charts, tableAt, trust];
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `대시보드 순서가 I17 과 다르다(${i}번째 항목이 앞 항목보다 위에 있다)`);
  }
  assert.equal(page.split('<DashboardCharts').length - 1, 1, '30일 차트가 두 번 그려진다');

  // 단계 바 — KPI 보다 위(본문 맨 위)에 있고, 세 단계 배너가 바가 찾는 id 를 단다.
  assert.ok(at('<StepNav') < kpis, '단계 바가 KPI 아래에 있다');
  for (const id of ['step-monitor', 'step-policy', 'step-effect']) {
    assert.match(page, new RegExp(`id="${id}"`), `단계 배너에 ${id} 앵커가 없다 — 단계 바가 옮겨 갈 곳이 없다`);
  }
  const stepNav = stripComments(read('components/admin/StepNav.tsx'));
  assert.match(stepNav, /'① ?'|badge: '①'/);
  assert.match(stepNav, /실시간 관제[\s\S]*정책 개입[\s\S]*분산 효과/, '단계 바 이름이 ① 실시간 관제 · ② 정책 개입 · ③ 분산 효과 가 아니다');

  // 엔진 내부 상태 칩은 첫 줄에서 뺀다.
  assert.doesNotMatch(page, /<ModelAccuracyBadge/, "머리글에 '예측모델 상태' 칩이 돌아왔다");

  // KPI 숫자 32px, KPI~히트맵 사이에 점선 카드 테두리 없음, 숫자 아래 11px 근거 줄 없음.
  assert.match(page, /const KPI_NUMBER = 'text-\[32px\]/, 'KPI 숫자가 32px 이 아니다');
  const kpiBlock = page.slice(kpis, heatmapAt);
  assert.doesNotMatch(kpiBlock, /border-dashed/, 'KPI 카드에 점선 테두리가 남아 있다');
  assert.doesNotMatch(kpiBlock, /text-\[11px\][^"]*mt-1 leading-snug/, 'KPI 숫자 아래 근거 줄이 남아 있다(배지 툴팁으로 옮길 것)');
  assert.doesNotMatch(kpiBlock, /<MetricNoSample hint="추천 기록이/, "추천이 0건일 때 수락률 타일이 '—' 로 그려진다");
  assert.match(kpiBlock, /추천 제시 0건/, '추천이 0건일 때 수락률 타일이 제시 건수를 말하지 않는다');

  // 장소 관리 표 — 1800px 미만에서는 전폭(관리 열이 가로 스크롤 뒤로 숨지 않게), 관리 열은 오른쪽 고정 + 글자 버튼.
  const bottomGrid = page.slice(page.lastIndexOf('<div className="grid', tableAt), tableAt);
  assert.match(bottomGrid, /min-\[1800px\]:grid-cols-3/, '장소 관리 표 줄이 1800px 미만에서도 3칸으로 눌린다');
  assert.doesNotMatch(bottomGrid, / lg:grid-cols-3/, '장소 관리 표 줄이 lg 에서 3칸이다');
  assert.match(table, /<th className="sticky right-0[^"]*">관리<\/th>/, "'관리' 열 머리가 오른쪽에 고정되지 않는다");
  assert.match(table, /<td className="sticky right-0/, "'관리' 열 칸이 오른쪽에 고정되지 않는다");
  assert.match(table, /<Edit2[^>]*\/> 수정/, "수정 버튼에 '수정' 글자가 없다");
  assert.match(table, /<Trash2[^>]*\/> 삭제/, "삭제 버튼에 '삭제' 글자가 없다");
  assert.match(table, /min-\[1800px\]:col-span-2/, '장소 관리 카드가 넓은 화면의 2칸을 쓰지 않는다');

  // 분산 효과 — 최근 30일 창, 0건이면 카드 없이(쿠폰 정책이 줄을 다 쓴다).
  const impactSrc = stripComments(read('components/admin/ImpactWidget.tsx'));
  assert.match(impactSrc, /IMPACT_WINDOW_DAYS = 30/, '분산 효과 창이 30일이 아니다');
  assert.match(impactSrc, /relocationsMeasured === 0 && loopBasis === 'measured'\) return null/, '0건 분산 효과 카드가 그려진다');
  assert.match(page, /const impactHidden = impactSamples === 0 && loopBasis === 'measured'/, '분산 효과가 숨을 때 쿠폰 정책이 줄을 다 쓰지 않는다');
  // 리뷰(10-07): 시나리오 숫자는 '오늘' 값이지만 실측 표본은 30일 수락이다 — 실측 건수·전환 조건에는 30일 창을 붙이고,
  // '실측 5건이 쌓이면 … (KST 오늘 기준)' 처럼 틀린 창으로 전환 조건을 말하지 않는다.
  assert.doesNotMatch(impactSrc, /실측으로 전환됩니다 \(KST 오늘 기준\)/, '분산 효과 시나리오가 전환 조건을 오늘 창으로 말한다');
  assert.match(impactSrc, /최근 \$\{IMPACT_WINDOW_DAYS\}일 실측 \$\{MIN_MEASURED_SAMPLES\}건이 쌓이면/, '전환 조건에 30일 창이 없다');
  assert.match(impactSrc, /최근 \$\{IMPACT_WINDOW_DAYS\}일 실측 \$\{relocationsMeasured\}건 수집 중/, "'실측 N건 수집 중' 에 30일 창이 없다");
  assert.match(impactSrc, /unit: `건\(최근 \$\{IMPACT_WINDOW_DAYS\}일\)`/, '시나리오 근거 줄의 실측 건수에 30일 창이 없다');
}

console.log('adminDashboardWiring.test.ts OK');
