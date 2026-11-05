// run-tests.mjs — 앱의 **/*.test.ts 를 하나씩 tsx 로 실행한다(웹 scripts/run-web-tests.mjs 와 같은 방식 —
// 각 파일은 node:assert 로 스스로 판정하는 독립 스크립트). 첫 실패에서 멈춘다.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['lib', 'features', 'components', 'scripts'];
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d))).sort();
for (const file of files) {
  const r = spawnSync(process.execPath, [tsxCli, file], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`FAIL ${relative(ROOT, file)}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`OK ${files.length} test files passed`);
