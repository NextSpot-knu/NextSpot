// check-shared-imports.mjs — 앱이 import 하는 웹 모듈의 '의존 폐포'가 순수한지 검사한다. + WebView 패키지 금지.
//
// 왜: 앱은 apps/web/lib 의 순수 모듈을 복사하지 않고 그대로 읽는다(docs/MOBILE_APP_PLAN.md §5.2).
// 그런데 웹 모듈 하나가 순수해 보여도 import 사슬 끝에 API 클라이언트·Supabase·DOM 이 붙어 있으면
// 앱에서 실행 오류(React Native 는 window 를 정의해 `typeof window` 가드가 통과한다)나
// 깨끗한 설치에서의 타입 오류가 난다. 그래서 모듈 하나가 아니라 사슬 전체를 본다.
// 타입만 쓰는 import 도 tsc 가 따라가므로 똑같이 센다. Metro 처럼 `.android.ts`·`.ios.ts`·`.native.ts` 변형도 따라간다.
//
// WebView: react-native-webview 를 설치하지 않는다(App Store 4.2 — apps/mobile/AGENTS.md). package.json 의 의존성이나
// package-lock.json 에 설치된 패키지로 있으면 실패한다(expo 의 선택 peer 로 이름만 적힌 것은 괜찮다).
// 테스트: check-shared-imports.test.ts.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(MOBILE, '../web');
const SOURCE_DIRS = ['app', 'components', 'features', 'lib', 'constants'];
const ALLOWED_PACKAGES = new Set(['shared-types']);
const BANNED_PACKAGES = ['react-native-webview'];

export const FORBIDDEN = [
  [/\bwindow\./, 'window.* — React Native 에도 window 가 있어 가드가 통과한다'],
  [/\bwindow\s*\[/, 'window[…]'],
  [/\bglobalThis\s*\.\s*window\b/, 'globalThis.window'],
  // 아래 location. · self. 규칙은 앞이 '.' 이면 넘어가므로 globalThis.location 을 따로 막는다.
  [/\bglobalThis\s*\.\s*(location|self)\b/, 'globalThis.location · globalThis.self — 브라우저 전역'],
  [/\bdocument\./, 'document.*'],
  [/\bCustomEvent\b/, 'CustomEvent'],
  [/\bDOMException\b/, 'DOMException'],
  [/\bnavigator\./, 'navigator.*'],
  // 앞이 '.' 나 이름 글자가 아닌 location. / self. — window.location 은 위에서, obj.location 은 걸리지 않는다.
  [/(^|[^.\w$])location\./, 'location.* — 앱에는 주소창이 없다'],
  [/(^|[^.\w$])self\./, 'self.* — 브라우저 전역(window 별칭)'],
  [/\bprocess\.env\.NEXT_PUBLIC_/, 'process.env.NEXT_PUBLIC_* — 앱 번들에는 없다(EXPO_PUBLIC_* 만 들어간다)'],
];
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
/** Metro 가 고르는 순서(안드로이드·iOS 각각) — 검사는 있는 변형을 모두 본다. */
const PLATFORM_SUFFIXES = ['.android', '.ios', '.native', ''];
const EXTENSIONS = ['.ts', '.tsx'];

/** 이 글자 뒤의 '/' 는 나눗셈이 아니라 정규식 리터럴의 시작이다. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof']);

/** 지금까지 쓴 코드(out)의 끝을 보고 '/' 가 정규식 리터럴을 여는지 판정한다. */
function regexAllowedAfter(out) {
  let k = out.length - 1;
  while (k >= 0 && /\s/.test(out[k])) k -= 1;
  const last = k >= 0 ? out[k] : '';
  if (REGEX_PRECEDERS.has(last)) return true;
  let s = k;
  while (s >= 0 && /[\w$]/.test(out[s])) s -= 1;
  return s < k && REGEX_KEYWORDS.has(out.slice(s + 1, k + 1));
}

/**
 * 주석을 같은 길이의 공백으로 지운다(줄 번호 유지). 문자열('…' "…" `…`)과 정규식 리터럴(/…/) 안의 // · /* 는 주석이 아니다.
 * 정규식은 앞 글자로 나눗셈과 가른다(연산자·여는 괄호·키워드 뒤면 정규식). 문자 집합 [...] 안의 '/' 는 끝이 아니다.
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next !== '/' && next !== '*' && regexAllowedAfter(out)) {
      // 정규식 리터럴 — 이스케이프와 문자 집합을 건너 닫는 '/' 까지 그대로 옮긴다. 줄이 끝나면 정규식이 아니었던 것.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        const ch = text[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += c;
      i += 1;
    } else if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\' && i + 1 < n) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (c !== '`' && text[i] === '\n') break; // 닫히지 않은 따옴표 — 줄 끝에서 끊는다
        out += text[i];
        i += 1;
      }
      if (i < n && text[i] === c) {
        out += c;
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** 금지 패턴 — [줄 번호(1부터), 이유] 목록. */
export function forbiddenIn(text) {
  const found = [];
  stripComments(text)
    .split('\n')
    .forEach((line, i) => {
      for (const [re, why] of FORBIDDEN) if (re.test(line)) found.push([i + 1, why]);
    });
  return found;
}

export function specifiers(text) {
  const out = [];
  for (const m of stripComments(text).matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();

/** import 경로 → 있는 파일들. 플랫폼 변형(.android/.ios/.native)이 있으면 모두, 없으면 기본 파일 하나. */
export function resolveFiles(base) {
  if (isFile(base)) return [base];
  // foo.ts 가 foo/index.ts 보다 먼저(TS·Metro 와 같다).
  for (const dir of [null, base]) {
    const stem = dir ? join(dir, 'index') : base;
    const found = [];
    for (const suffix of PLATFORM_SUFFIXES) {
      for (const ext of EXTENSIONS) {
        const candidate = `${stem}${suffix}${ext}`;
        if (isFile(candidate)) found.push(candidate);
      }
    }
    if (found.length) return found;
  }
  return [];
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('@/')) return { files: resolveFiles(join(WEB, spec.slice(2))) };
  if (spec.startsWith('~/')) return { files: resolveFiles(join(MOBILE, spec.slice(2))) };
  if (spec.startsWith('.')) return { files: resolveFiles(resolve(dirname(fromFile), spec)) };
  return { pkg: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] };
}

/**
 * 금지 패키지가 직접 의존성이거나 설치돼 있는가. lock 의 `packages` 에 node_modules/<이름> 항목이 있으면 설치된 것이다
 * (선택 peer 로 이름만 적힌 것은 다른 패키지의 peerDependencies 안에만 있고 이 항목이 없다).
 */
export function bannedPackageProblems(pkgJson, lockJson, banned = BANNED_PACKAGES) {
  const problems = [];
  for (const name of banned) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (pkgJson?.[field] && Object.prototype.hasOwnProperty.call(pkgJson[field], name)) {
        problems.push(`package.json ${field} 에 '${name}' — 설치하지 않는다(App Store 4.2, WebView 금지)`);
      }
    }
    for (const key of Object.keys(lockJson?.packages ?? {})) {
      if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) {
        problems.push(`package-lock.json 에 설치된 '${key}' — 어떤 패키지가 끌고 왔는지 확인하고 뺀다`);
      }
    }
  }
  return problems;
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

function main() {
  const isWeb = (file) => file.startsWith(WEB + sep);
  const packagesRoot = resolve(MOBILE, '../../packages') + sep;
  const problems = [];

  const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
  problems.push(...bannedPackageProblems(readJson(join(MOBILE, 'package.json')), readJson(join(MOBILE, 'package-lock.json'))));

  const entries = new Set();
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(MOBILE, dir))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (BANNED_PACKAGES.includes(spec) || BANNED_PACKAGES.some((b) => spec.startsWith(`${b}/`))) {
          problems.push(`${relative(MOBILE, file)}: '${spec}' import — WebView 금지`);
        }
        for (const target of resolveSpecifier(spec, file).files ?? []) if (isWeb(target)) entries.add(target);
      }
    }
  }

  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = relative(resolve(MOBILE, '../..'), file);
    if (file.endsWith('.tsx')) problems.push(`${rel}: .tsx(웹 UI) 는 공유하지 않는다`);
    if (file.endsWith('.test.ts')) problems.push(`${rel}: 테스트 파일을 import 한다`);
    // JSON(문구 데이터)은 코드가 아니다 — 'document.' 같은 영어 문장이 걸리지 않게 본문 검사와 import 추적을 건너뛴다.
    if (file.endsWith('.json')) continue;
    const text = readFileSync(file, 'utf8');
    for (const [line, why] of forbiddenIn(text)) problems.push(`${rel}:${line}: ${why}`);
    for (const spec of specifiers(text)) {
      const { files, pkg } = resolveSpecifier(spec, file);
      if (pkg !== undefined) {
        if (!ALLOWED_PACKAGES.has(pkg)) problems.push(`${rel}: 허용되지 않은 패키지 import '${spec}'`);
        continue;
      }
      if (!files.length) {
        problems.push(`${rel}: '${spec}' 를 찾을 수 없다`);
        continue;
      }
      for (const target of files) {
        if (isWeb(target)) queue.push(target);
        else if (!target.startsWith(packagesRoot)) problems.push(`${rel}: 웹 밖 파일 import '${spec}'`);
      }
    }
  }

  if (problems.length) {
    console.error(`check-shared-imports: ${problems.length}건 실패 (웹 모듈 ${seen.size}개 검사)`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('→ 웹 모듈 문제면 그 모듈은 import 하지 말고 apps/mobile/lib 에 앱용으로 다시 쓴다(PORTING.md 에 원본 기록).');
    process.exit(1);
  }
  console.log(`check-shared-imports: OK (앱이 직접 쓰는 웹 모듈 ${entries.size}개, 의존 폐포 ${seen.size}개, WebView 없음)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
