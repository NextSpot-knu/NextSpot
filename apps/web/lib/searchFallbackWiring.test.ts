// 검색 폴백 배선 가드 — 백엔드는 살아 있는데 프런트에 호출자가 없던 두 기능을 소스에서 잠근다.
//
// 배경: GET /api/v1/search/keyword(관광공사 키워드 폴백)와 POST /api/v1/search/ingest-request
// (적재 요청 큐잉)는 백엔드도 관리자 승인 큐도 동작하는데 **웹 어디에서도 부르지 않았다**
// (전수 확인). main/page.tsx 주석은 '[다음 배치 추가 요청]으로 큐잉' 이라고 적고 있었지만
// 그 버튼이 화면에 없었다. 호출자가 사라지는 종류의 회귀는 타입도 테스트도 잡지 못하므로
// (아무것도 깨지지 않는다 — 기능만 조용히 없어진다) 소스에서 직접 막는다
// (lib/congestionAlertWiring.test.ts 와 같은 방식·같은 이유).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd(); // 러너가 cwd 를 apps/web 으로 고정한다
const page = readFileSync(join(WEB, 'app/main/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');

// --- (1) 관광공사 키워드 폴백을 실제로 부른다 --------------------------------
assert.match(
  page,
  /apiClient\.get\('\/api\/v1\/search\/keyword'/,
  '지도 화면이 관광공사 키워드 폴백을 부르지 않는다 — 백엔드만 살아 있는 상태로 되돌아갔다',
);

// --- (2) 0건일 때만 부른다 ----------------------------------------------------
// 우리 데이터/Kakao 가 찾은 장소가 있는데도 외부 목록을 함께 띄우면 어느 줄이 우리가 아는
// 장소인지 사용자가 구분할 수 없다. Kakao 결과가 있으면 그 자리에서 멈춰야 한다.
assert.match(
  page,
  /if \(kakaoItems\.length > 0\) return;/,
  'Kakao 결과가 있어도 관광공사 폴백까지 내려간다 — 출처가 섞인다',
);

// --- (3) 출처를 화면에 밝힌다 --------------------------------------------------
assert.match(page, /t\('map\.tourApiSource'\)/, '관광공사 결과에 출처 문구가 붙지 않는다');

// --- (4) 적재 요청을 실제로 보낸다 ---------------------------------------------
assert.match(
  page,
  /apiClient\.post\('\/api\/v1\/search\/ingest-request'/,
  "'추가 요청' 이 관리자 승인 큐로 가지 않는다",
);
assert.match(page, /onClick=\{\(\) => requestIngest\(item\)\}/, '추가 요청 버튼이 화면에 없다');

// --- (5) 실패를 성공처럼 보이게 하지 않는다 -------------------------------------
// 실패했는데 '접수됨' 으로 잠기면 사용자는 오지 않을 장소를 기다린다. 접수 표시는
// try 블록(성공 경로)에서만 세워져야 하고, catch 는 실패를 그대로 말해야 한다.
{
  const handler = page.slice(page.indexOf('const requestIngest'));
  const body = handler.slice(0, handler.indexOf('\n  };') + 5);
  const catchStart = body.indexOf('} catch');
  assert.ok(catchStart > 0, 'requestIngest 에 실패 처리가 없다');
  const catchBlock = body.slice(catchStart);
  assert.doesNotMatch(
    catchBlock,
    /setIngestRequested/,
    '실패한 요청을 접수된 것으로 기록한다 — 오지 않을 장소를 기다리게 만든다',
  );
  assert.match(catchBlock, /ingestRequestFailed/, '실패를 사용자에게 말하지 않는다');
}

console.log('searchFallbackWiring tests passed');
