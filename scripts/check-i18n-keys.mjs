// 코드가 실제로 쓰는 i18n 키가 메시지 파일에 존재하는지 검사한다.
//
// 왜 필요한가: 기존 `lib/i18n/parity.test.ts` 는 **로케일끼리** 비교한다(en/ja/zh 가 ko 와
// 같은 키를 갖는지). 그래서 ko 에도 없는 키를 코드가 부르는 경우는 잡지 못한다 — 네 로케일이
// 사이좋게 전부 비어 있으면 패리티는 통과한다.
//
// 그 결과 2026-08-21 실측에서 20개 키가 누락된 채 배포돼 있었고, `/course` 와 `/waiting` 의
// 로딩 화면은 번역문 대신 `optimization.course.title` 같은 **원시 키를 사용자에게 그대로**
// 노출하고 있었다. 이 스크립트는 그 부류를 CI 에서 잡기 위한 것이다.
//
// 검사 두 가지:
//   1) 리터럴 키   `t('a.b.c')`      → 해당 경로가 문자열로 존재해야 한다.
//   2) 동적 키     `t(`a.${x}.c`)`   → 정적 루트 네임스페이스(`a`)가 존재해야 한다.
//      동적 부분은 정적 분석으로 확정할 수 없지만, 네임스페이스 자체가 통째로 없는 사고
//      (위 optimization 사례가 정확히 이것)는 이 검사로 걸린다.
//
// 실행: node scripts/check-i18n-keys.mjs   (npm run check:i18n)
// 종료코드: 누락 0 이면 0, 하나라도 있으면 1.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const I18N = path.join(WEB, "lib", "i18n");
const MESSAGES = path.join(I18N, "messages");
const BASE_LOCALE = "ko"; // 원본 로케일 — 나머지는 parity.test.ts 가 담당한다.

// ⚠️ 사전은 JSON 하나가 아니다. I18nProvider 의 t() 는 아래 모듈들을 **JSON 보다 먼저** 조회한다.
// 이 목록을 빠뜨리면 멀쩡한 키를 누락으로 잡는다(실제로 2026-08-27 에 discovery/theme/areaDemand
// 세 묶음을 통째로 오검출했다). 새 사이드 모듈이 생기면 I18nProvider 와 함께 여기도 갱신할 것.
const SIDE_MODULES = ["discovery-messages.ts", "area-demand-messages.ts", "theme-messages.ts"];

const SKIP_DIRS = new Set(["node_modules", ".next", "out", ".git", "e2e"]);

function loadMessages() {
  const file = path.join(MESSAGES, `${BASE_LOCALE}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 사이드 모듈의 ko 블록에 있는 평면 키('discovery.entry' 형태) 집합. */
function loadSideKeys() {
  const keys = new Set();
  for (const name of SIDE_MODULES) {
    const file = path.join(I18N, name);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    // `ko: {` 부터 중괄호 균형이 맞는 지점까지가 ko 블록이다(로케일별로 같은 키를 반복하므로
    // 파일 전체를 훑으면 ko 에만 없는 키를 놓친다 — 원본 로케일만 본다).
    const start = src.search(/\bko\s*:\s*\{/);
    if (start === -1) continue;
    let i = src.indexOf("{", start);
    let depth = 0;
    let end = i;
    for (; end < src.length; end += 1) {
      if (src[end] === "{") depth += 1;
      else if (src[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const block = src.slice(i, end + 1);
    for (const m of block.matchAll(/['"]([A-Za-z][A-Za-z0-9_.]*)['"]\s*:/g)) keys.add(m[1]);
  }
  return keys;
}

/** 점 경로가 '문자열 값'으로 존재하는지. 중간 객체까지만 있으면 실패로 본다. */
function hasStringAt(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return false;
    cur = cur[part];
  }
  return typeof cur === "string";
}

function hasNamespace(obj, root) {
  return root in obj && typeof obj[root] === "object" && obj[root] !== null;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      yield path.join(dir, entry.name);
    }
  }
}

const LITERAL = /\bt\(\s*['"]([A-Za-z][A-Za-z0-9_.]*)['"]/g;
// t(`ns.${...}...`) — 백틱 안에서 첫 점 앞의 정적 조각만 뽑는다.
const TEMPLATE = /\bt\(\s*`([A-Za-z][A-Za-z0-9_]*)\.[^`]*\$\{/g;

const messages = loadMessages();
const sideKeys = loadSideKeys();
const missingLiteral = new Map();
const missingNamespace = new Map();
let scanned = 0;

for (const file of walk(WEB)) {
  const src = fs.readFileSync(file, "utf8");
  scanned += 1;
  const rel = path.relative(ROOT, file).replaceAll(path.sep, "/");

  for (const m of src.matchAll(LITERAL)) {
    const key = m[1];
    if (!key.includes(".")) continue; // 네임스페이스 없는 호출은 이 검사 대상이 아니다
    if (sideKeys.has(key) || hasStringAt(messages, key)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    if (!missingLiteral.has(key)) missingLiteral.set(key, []);
    missingLiteral.get(key).push(`${rel}:${line}`);
  }

  for (const m of src.matchAll(TEMPLATE)) {
    const root = m[1];
    if (hasNamespace(messages, root)) continue;
    // 사이드 모듈은 평면 키라 네임스페이스 객체가 없다 — 접두사 일치로 판정한다.
    if ([...sideKeys].some((k) => k.startsWith(`${root}.`))) continue;
    const line = src.slice(0, m.index).split("\n").length;
    if (!missingNamespace.has(root)) missingNamespace.set(root, []);
    missingNamespace.get(root).push(`${rel}:${line}`);
  }
}

const totalMissing = missingLiteral.size + missingNamespace.size;

console.log(
  `i18n key coverage — ${scanned} files scanned against ${BASE_LOCALE}.json` +
  ` + ${sideKeys.size} keys from ${SIDE_MODULES.length} side modules`
);

if (missingLiteral.size > 0) {
  console.log(`\n누락된 리터럴 키 ${missingLiteral.size}종 (사용자에게 원시 키가 노출된다):`);
  for (const key of [...missingLiteral.keys()].sort()) {
    console.log(`  ✗ ${key}`);
    for (const loc of missingLiteral.get(key)) console.log(`      ${loc}`);
  }
}

if (missingNamespace.size > 0) {
  console.log(`\n동적 키의 네임스페이스가 통째로 없음 ${missingNamespace.size}종:`);
  for (const root of [...missingNamespace.keys()].sort()) {
    console.log(`  ✗ ${root}.* — 이 네임스페이스가 ${BASE_LOCALE}.json 에 없다`);
    for (const loc of missingNamespace.get(root)) console.log(`      ${loc}`);
  }
}

if (totalMissing === 0) {
  console.log("\n✓ 코드가 쓰는 모든 키가 존재한다.");
  process.exit(0);
}

console.log(
  `\n✗ ${totalMissing}종 누락. ${BASE_LOCALE}.json 에 추가한 뒤 나머지 로케일도 채우면` +
  ` parity.test.ts 가 누락을 다시 잡아준다.`
);
process.exit(1);
