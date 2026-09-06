#!/usr/bin/env node
// run-web-tests.mjs — apps/web/lib/**/*.test.ts 를 전부 tsx 로 순서대로 실행한다 (실패 즉시 중단).
//
// 왜 필요한가: 예전 package.json 의 test 스크립트는 `tsx a.test.ts && tsx b.test.ts && …` 20개 체인이었다.
// 새 테스트 파일을 만들고 그 줄에 안 붙이면 조용히 안 돌았다 — CI 도 사람도 모른다.
// 이 러너는 glob 으로 찾으므로 파일을 만들기만 하면 돈다.
//
// 테스트 규약: 각 *.test.ts 는 node:assert 로 스스로 판정하고 종료코드로 결과를 알리는 독립 스크립트다
// (jest/vitest 없음). tsconfig 는 *.test.ts 를 typecheck 에서 제외하므로 컴파일은 tsx 만 한다.
// 실행: apps/web 에서 `npm run test` (check-i18n-keys 다음에 이 스크립트가 돈다). 루트에서는 `npm run web:test`.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web");
// tsx 는 apps/web 기준으로 해석한다(워크스페이스 호이스팅된 복사본을 찾는다). node 로 직접 실행 — 셸·.cmd 심 없음.
const tsxCli = createRequire(pathToFileURL(join(webDir, "package.json"))).resolve("tsx/cli");

const files = readdirSync(join(webDir, "lib"), { recursive: true })
  .map((f) => String(f).split("\\").join("/"))
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => "lib/" + f);

if (files.length === 0) {
  console.error("run-web-tests: apps/web/lib 아래에 *.test.ts 가 없다");
  process.exit(1);
}

for (const file of files) {
  console.log(`\n> ${file}`);
  // cwd 가 apps/web 이어야 tsx 가 tsconfig 의 "@/*" 경로 별칭을 읽는다.
  const r = spawnSync(process.execPath, [tsxCli, file], { cwd: webDir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`FAIL ${file} (exit ${r.status ?? r.signal})`);
    process.exit(r.status || 1);
  }
}
console.log(`\nOK ${files.length} test files passed`);
