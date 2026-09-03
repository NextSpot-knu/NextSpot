#!/usr/bin/env node
// check-docs.mjs — 문서 트리 규칙 검사 (CI schema job · `npm run check:docs`)
//
// 왜 필요한가: 문서가 27개를 넘어가면서 끝난 계획서와 살아 있는 문서가 한 층에 섞이고,
// 옮기거나 지운 파일을 가리키는 링크가 조용히 남았다(2026-09-04 감사에서 깨진 링크 3건).
// 사람이 규칙을 기억하는 대신 이 스크립트가 커밋마다 확인한다. 순수 node:fs, 의존성 없음.
//
// 검사 4가지 (하나라도 걸리면 종료코드 1):
//   1) docs/**/*.md 는 전부 docs/README.md 색인에 링크되어야 한다 — 색인 없는 문서는 곧 잊힌다.
//   2) 모든 *.md 의 상대 링크는 실제 파일/폴더를 가리켜야 한다 (http·mailto·#앵커는 제외).
//   3) 루트 *.md 는 README.md · AGENTS.md · CLAUDE.md 만 — 새 문서는 docs/ 아래에 만든다.
//   4) docs/HANDOVER.md 는 '## YYYY-MM-DD — 제목' 형식의 세션 제목만 쓰고(중복 금지),
//      400줄을 넘기지 않는다 — 넘치면 오래된 항목을 docs/archive/HANDOVER_LOG.md 로 옮긴다.
//
// 실행: node scripts/check-docs.mjs   (루트 어디서 실행해도 된다)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", ".next", "out", "scratch", "__pycache__"]);
const ROOT_MD_ALLOWLIST = new Set(["README.md", "AGENTS.md", "CLAUDE.md"]);
const HANDOVER = "docs/HANDOVER.md";
const HANDOVER_MAX_LINES = 400;
const HANDOVER_FIXED_HEADINGS = new Set(["## 배포 상태", "## 우선순위", "## 사람 작업 대기", "## 알려진 이슈", "## 마이그레이션 확인", "## 최근 세션", "## 기록 규칙"]);
const SESSION_HEADING = /^## (\d{4}-\d{2}-\d{2}[a-z]?) — .+/;

const errors = [];
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function walkMd(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkMd(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const mdFiles = walkMd(ROOT, []);

// 3) 루트 마크다운 허용 목록
for (const f of mdFiles) {
  const r = rel(f);
  if (!r.includes("/") && !ROOT_MD_ALLOWLIST.has(r)) {
    errors.push(`${r}: 루트에 새 마크다운을 두지 않는다 — docs/ 아래로 옮기고 docs/README.md 색인에 추가할 것`);
  }
}

// 2) 상대 링크 해석
const LINK_RE = /\]\(([^)\s]+)\)/g;
function resolveTargets(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[1];
      if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
      const clean = target.split("#")[0];
      if (!clean) continue;
      found.push({ line: i + 1, target, abs: path.resolve(path.dirname(file), decodeURIComponent(clean)) });
    }
  });
  return found;
}
for (const f of mdFiles) {
  for (const { line, target, abs } of resolveTargets(f)) {
    if (!existsSync(abs)) errors.push(`${rel(f)}:${line}: 깨진 링크 → ${target}`);
  }
}

// 1) docs/ 색인 완전성
const indexPath = path.join(ROOT, "docs", "README.md");
if (!existsSync(indexPath)) {
  errors.push("docs/README.md: 문서 색인이 없다");
} else {
  const indexed = new Set(resolveTargets(indexPath).map((t) => path.normalize(t.abs)));
  for (const f of mdFiles) {
    const r = rel(f);
    if (!r.startsWith("docs/") || r === "docs/README.md") continue;
    if (!indexed.has(path.normalize(f))) errors.push(`${r}: docs/README.md 색인에 없다 — 한 줄 용도와 상태(living/frozen/archived)를 적어 추가할 것`);
  }
}

// 4) HANDOVER 형식
const handoverPath = path.join(ROOT, HANDOVER);
if (existsSync(handoverPath)) {
  const lines = readFileSync(handoverPath, "utf8").split(/\r?\n/);
  if (lines.length > HANDOVER_MAX_LINES) {
    errors.push(`${HANDOVER}: ${lines.length}줄 — ${HANDOVER_MAX_LINES}줄 초과. 오래된 세션 항목을 docs/archive/HANDOVER_LOG.md 로 옮길 것`);
  }
  const seen = new Map();
  lines.forEach((line, i) => {
    if (!line.startsWith("## ")) return;
    if (HANDOVER_FIXED_HEADINGS.has(line.trim())) return;
    const m = line.match(SESSION_HEADING);
    if (!m) {
      errors.push(`${HANDOVER}:${i + 1}: 세션 제목은 '## YYYY-MM-DD — 제목' 형식이어야 한다 (같은 날 두 번째는 YYYY-MM-DDb)`);
      return;
    }
    if (seen.has(m[1])) errors.push(`${HANDOVER}:${i + 1}: 세션 ID ${m[1]} 중복 (첫 등장 ${seen.get(m[1])}줄) — 접미사 b/c 를 붙일 것`);
    else seen.set(m[1], i + 1);
  });
}

if (errors.length) {
  console.error(`check-docs: ${errors.length}건 실패\n` + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log(`check-docs: OK (${mdFiles.length} markdown files checked)`);
