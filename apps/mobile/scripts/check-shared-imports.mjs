// check-shared-imports.mjs — 앱이 import 하는 웹 모듈의 '의존 폐포'가 순수한지 검사한다.
//
// 왜: 앱은 apps/web/lib 의 순수 모듈을 복사하지 않고 그대로 읽는다(docs/MOBILE_APP_PLAN.md §5.2).
// 그런데 웹 모듈 하나가 순수해 보여도 import 사슬 끝에 API 클라이언트·Supabase·DOM 이 붙어 있으면
// 앱에서 실행 오류(React Native 는 window 를 정의해 `typeof window` 가드가 통과한다)나
// 깨끗한 설치에서의 타입 오류가 난다. 그래서 모듈 하나가 아니라 사슬 전체를 본다.
// 타입만 쓰는 import 도 tsc 가 따라가므로 똑같이 센다.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(MOBILE, '../web');
const SOURCE_DIRS = ['app', 'components', 'features', 'lib', 'constants'];
const ALLOWED_PACKAGES = new Set(['shared-types']);
const FORBIDDEN = [
  [/\bwindow\./, 'window.* — React Native 에도 window 가 있어 가드가 통과한다'],
  [/\bdocument\./, 'document.*'],
  [/\bCustomEvent\b/, 'CustomEvent'],
  [/\bDOMException\b/, 'DOMException'],
  [/\bnavigator\./, 'navigator.*'],
];
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

function specifiers(text) {
  const out = [];
  for (const m of stripComments(text).matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function resolveFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveSpecifier(spec, fromFile, fromWeb) {
  if (spec.startsWith('@/')) return { file: resolveFile(join(fromWeb ? WEB : WEB, spec.slice(2))) };
  if (spec.startsWith('~/')) return { file: resolveFile(join(MOBILE, spec.slice(2))) };
  if (spec.startsWith('.')) return { file: resolveFile(resolve(dirname(fromFile), spec)) };
  return { pkg: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] };
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(name)) files.push(full);
  }
  return files;
}

const isWeb = (file) => file.startsWith(WEB + sep);
const entries = new Set();
for (const dir of SOURCE_DIRS) {
  for (const file of walk(join(MOBILE, dir))) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const { file: target } = resolveSpecifier(spec, file, false);
      if (target && isWeb(target)) entries.add(target);
    }
  }
}

const problems = [];
const seen = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const rel = relative(resolve(MOBILE, '../..'), file);
  if (file.endsWith('.tsx')) problems.push(`${rel}: .tsx(웹 UI) 는 공유하지 않는다`);
  if (file.endsWith('.test.ts')) problems.push(`${rel}: 테스트 파일을 import 한다`);
  const text = readFileSync(file, 'utf8');
  stripComments(text).split('\n').forEach((line, i) => {
    for (const [re, why] of FORBIDDEN) if (re.test(line)) problems.push(`${rel}:${i + 1}: ${why}`);
  });
  for (const spec of specifiers(text)) {
    const { file: target, pkg } = resolveSpecifier(spec, file, true);
    if (pkg !== undefined) {
      if (!ALLOWED_PACKAGES.has(pkg)) problems.push(`${rel}: 허용되지 않은 패키지 import '${spec}'`);
    } else if (!target) problems.push(`${rel}: '${spec}' 를 찾을 수 없다`);
    else if (!isWeb(target) && !target.startsWith(resolve(MOBILE, '../../packages') + sep)) {
      problems.push(`${rel}: 웹 밖 파일 import '${spec}'`);
    } else if (isWeb(target)) queue.push(target);
  }
}

if (problems.length) {
  console.error(`check-shared-imports: ${problems.length}건 실패 (웹 모듈 ${seen.size}개 검사)`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('→ 그 웹 모듈은 import 하지 말고 apps/mobile/lib 에 앱용으로 다시 쓴다(PORTING.md 에 원본 기록).');
  process.exit(1);
}
console.log(`check-shared-imports: OK (앱이 직접 쓰는 웹 모듈 ${entries.size}개, 의존 폐포 ${seen.size}개)`);
