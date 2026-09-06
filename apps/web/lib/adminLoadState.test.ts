import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countLabel,
  emptyOrFailedText,
  fetchAllPages,
  reportSourceLabel,
  reportSourceState,
  settingsSaveGuard,
} from './adminLoadState';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  // ── countLabel: 실패가 숫자(특히 0)로 새지 않는다 ────────────────────────────
  assert.equal(countLabel('ok', 0), '0', '실측 0건은 0 이라고 말해야 한다');
  assert.equal(countLabel('ok', 1664), (1664).toLocaleString());
  assert.equal(countLabel('loading', 0), '…');
  assert.notEqual(countLabel('failed', 0), '0', "조회 실패를 '0' 으로 그리면 '문제 없음' 으로 읽힌다");
  assert.equal(countLabel('failed', 0), '조회 실패');
  // 실패 상태에서는 손에 쥔 숫자가 무엇이든 그것을 사실로 말하지 않는다.
  assert.equal(countLabel('failed', 7), '조회 실패');

  // ── emptyOrFailedText: '아직 없음' 과 '못 불러옴' 이 같은 문장이 되면 안 된다 ──
  const empty = emptyOrFailedText('ok', '접수된 문의가 없습니다.');
  const failed = emptyOrFailedText('failed', '접수된 문의가 없습니다.');
  assert.equal(empty, '접수된 문의가 없습니다.');
  assert.notEqual(failed, empty);
  assert.match(failed, /실패/);
  assert.doesNotMatch(failed, /없습니다\.$/, "실패 문구가 '없습니다' 로 끝나면 빈 결과로 읽힌다");
  assert.equal(emptyOrFailedText('loading', '없음'), '불러오는 중...');
  assert.equal(emptyOrFailedText('loading', '없음', '데이터를 불러오는 중...'), '데이터를 불러오는 중...');

  // ── settingsSaveGuard: 조회 실패 상태에서 저장을 막는다 ──────────────────────
  const loadingGuard = settingsSaveGuard({ status: 'loading' }, false);
  assert.equal(loadingGuard.allowed, false);
  assert.ok(loadingGuard.reason);

  const failedGuard = settingsSaveGuard({ status: 'failed', message: 'HTTP 500' }, false);
  assert.equal(failedGuard.allowed, false, '조회 실패 상태의 저장은 실제 설정을 기본값으로 덮는다');
  assert.match(failedGuard.reason ?? '', /기본값/, '왜 막혔는지(화면 값이 기본값이라는 사실)를 말해야 한다');

  // 'missing' 은 실패가 아니다 — 덮어쓸 행 자체가 없으므로 저장을 막을 이유가 없다.
  assert.deepEqual(settingsSaveGuard({ status: 'missing' }, false), { allowed: true, reason: null });
  assert.deepEqual(settingsSaveGuard({ status: 'ok' }, false), { allowed: true, reason: null });

  // 저장 중 재클릭은 막되, 실패와 같은 사유로 뭉개지 않는다.
  const savingGuard = settingsSaveGuard({ status: 'ok' }, true);
  assert.equal(savingGuard.allowed, false);
  assert.notEqual(savingGuard.reason, failedGuard.reason);
  // 실패는 저장 중 여부와 무관하게 언제나 막힌다.
  assert.equal(settingsSaveGuard({ status: 'failed', message: 'x' }, true).allowed, false);

  // ── reportSourceState: 실패가 '데이터 없음' 으로 표기되지 않는다 ─────────────
  assert.equal(reportSourceState({ loading: true, failed: false, live: false }), 'loading');
  assert.equal(reportSourceState({ loading: true, failed: true, live: false }), 'loading');
  assert.equal(reportSourceState({ loading: false, failed: true, live: false }), 'failed');
  // 한쪽만 실패한 경우를 'DB 실시간 반영' 으로 말하면 실패한 차트의 빈자리가 실측으로 읽힌다.
  assert.equal(reportSourceState({ loading: false, failed: true, live: true }), 'partial');
  assert.equal(reportSourceState({ loading: false, failed: false, live: true }), 'live');
  assert.equal(reportSourceState({ loading: false, failed: false, live: false }), 'empty');

  assert.equal(reportSourceLabel('empty'), '데이터 없음');
  assert.notEqual(reportSourceLabel('failed'), reportSourceLabel('empty'));
  assert.notEqual(reportSourceLabel('partial'), reportSourceLabel('live'));
  assert.match(reportSourceLabel('failed'), /실패/);
  assert.match(reportSourceLabel('partial'), /실패/);

  // ── fetchAllPages: 1000행 캡을 넘겨 전량을 받는다 ────────────────────────────
  // 실제 PostgREST 를 흉내낸다: 요청 폭이 얼마든 서버는 1000행에서 자른다.
  const CAP = 1000;
  const makeServer = (total: number) => {
    const calls: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number) => {
      calls.push([from, to]);
      const width = Math.min(to - from + 1, CAP);
      return Array.from({ length: Math.max(0, Math.min(width, total - from)) }, (_, i) => from + i);
    };
    return { calls, fetchPage };
  };

  const s1664 = makeServer(1664);
  const all = await fetchAllPages(s1664.fetchPage, { pageSize: CAP, maxPages: 20 });
  assert.equal(all.length, 1664, '프로덕션 실측 시설 수 1,664곳이 전부 와야 한다');
  assert.deepEqual(all.slice(0, 3), [0, 1, 2]);
  assert.equal(all[1663], 1663, '마지막 행까지 왔는지 — 664곳이 잘리던 자리');
  assert.equal(new Set(all).size, all.length, '페이지 경계에서 중복된 행이 없어야 한다');
  assert.deepEqual(s1664.calls, [[0, 999], [1000, 1999]]);

  // 정확히 배수로 떨어지면 마지막에 빈 페이지를 한 번 더 받아 끝을 확인한다.
  const exact = makeServer(2000);
  assert.equal((await fetchAllPages(exact.fetchPage, { pageSize: CAP, maxPages: 20 })).length, 2000);
  assert.equal(exact.calls.length, 3, '경계에서 끝을 확인하려면 빈 페이지 한 번이 더 필요하다');

  // 빈 테이블
  const none = makeServer(0);
  assert.deepEqual(await fetchAllPages(none.fetchPage, { pageSize: CAP, maxPages: 20 }), []);

  // 상한을 넘으면 잘린 목록을 정상인 척 돌려주지 않고 throw 한다.
  const huge = makeServer(5000);
  await assert.rejects(
    () => fetchAllPages(huge.fetchPage, { pageSize: CAP, maxPages: 2 }),
    /상한/,
    '잘린 목록을 조용히 반환하면 이 결함이 그대로 되살아난다',
  );

  // 페이지 조회 실패는 그대로 전파된다(부분 목록을 성공으로 돌려주지 않는다).
  let hit = 0;
  await assert.rejects(
    () =>
      fetchAllPages(
        async (from) => {
          hit += 1;
          if (from > 0) throw new Error('네트워크 오류');
          return Array.from({ length: CAP }, (_, i) => i);
        },
        { pageSize: CAP, maxPages: 20 },
      ),
    /네트워크 오류/,
  );
  assert.equal(hit, 2);

  await assert.rejects(() => fetchAllPages(async () => [], { pageSize: 0, maxPages: 5 }), /pageSize/);
  await assert.rejects(() => fetchAllPages(async () => [], { pageSize: 10, maxPages: 0 }), /maxPages/);

  // ── 화면 배선 가드 ──────────────────────────────────────────────────────────
  // 판정 함수만 맞고 화면은 옛 코드로 남는 사고를 막는다(이 저장소에 렌더 테스트가 없어서).
  const couponSrc = readFileSync(join(WEB, 'components', 'admin', 'CouponPolicyPanel.tsx'), 'utf8');
  assert.match(couponSrc, /fetchAllPages[<(]/, '쿠폰 정책 패널이 전량 페이지네이션을 쓰지 않는다');
  assert.match(couponSrc, /\.order\('id'/, '페이지네이션에 유일키 정렬(전순서)이 없다 — 경계에서 행이 새거나 겹친다');
  // 주석에는 옛 코드가 인용돼 있으므로 줄 주석을 걷어낸 뒤 실제 호출만 본다.
  const couponCode = couponSrc.replace(/\/\/.*$/gm, '');
  assert.deepEqual(
    couponCode.match(/\.range\([^)]*\)/g),
    ['.range(from, to)'],
    '고정 범위 range 호출이 남아 있다 — PostgREST 가 1000행에서 잘라 664곳이 사라진다',
  );

  const settingsSrc = readFileSync(join(WEB, 'app', 'admin', 'settings', 'page.tsx'), 'utf8');
  assert.match(settingsSrc, /settingsSaveGuard\(/, '설정 화면이 저장 가드를 쓰지 않는다');
  assert.match(settingsSrc, /!saveGuard\.allowed/, '저장 핸들러가 실패 상태를 스스로 막지 않는다');
  assert.match(settingsSrc, /status: 'missing'/, "조회 실패와 '아직 설정 없음' 을 구분하지 않는다");
  assert.doesNotMatch(settingsSrc, /기본값 사용/, "조회 실패를 '기본값 사용' 으로 넘기던 경로가 남아 있다");

  const supportSrc = readFileSync(join(WEB, 'app', 'admin', 'support', 'page.tsx'), 'utf8');
  assert.match(supportSrc, /countLabel\(loadStatus/, "문의 건수가 조회 실패를 0 으로 그린다");
  assert.match(supportSrc, /setLoadStatus\('failed'\)/, '문의 목록 조회 실패를 구분하지 않는다');

  const infraSrc = readFileSync(join(WEB, 'app', 'admin', 'infrastructure', 'page.tsx'), 'utf8');
  assert.match(infraSrc, /countLabel\(ingestStatus/, "적재 요청 대기 배지가 조회 실패를 0 으로 그린다");
  assert.match(infraSrc, /setIngestStatus\('failed'\)/, '승인 큐 조회 실패를 구분하지 않는다');

  const reportsSrc = readFileSync(join(WEB, 'app', 'admin', 'reports', 'page.tsx'), 'utf8');
  assert.match(reportsSrc, /reportSourceState\(/, '리포트 배지가 조회 실패를 구분하지 않는다');
  assert.match(reportsSrc, /emptyOrFailedText\(/, "리포트 빈 자리가 실패를 '데이터 없음' 으로 말한다");
  assert.doesNotMatch(reportsSrc, /목업 유지/, '있지도 않은 목업을 유지한다고 말하는 주석이 남아 있다');

  console.log('admin load state tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
