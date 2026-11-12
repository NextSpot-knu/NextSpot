import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { webTypographyCss } from './webTypographyCore';

const css = webTypographyCss().replace(/\s+/g, ' ');

// 웹 globals.css 와 같은 규칙 — 웹 쪽이 바뀌면 여기서 걸린다.
const HERE = dirname(fileURLToPath(import.meta.url));
const webCss = readFileSync(resolve(HERE, '../../web/app/globals.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');
assert.ok(webCss.includes('html:lang(ko) body { word-break: keep-all; overflow-wrap: break-word; }'), 'web keep-all rule moved');
assert.ok(webCss.includes('html:is(:lang(ja), :lang(zh)) body { line-break: strict; }'), 'web line-break rule moved');

assert.ok(css.includes('html:lang(ko) body { word-break: keep-all; overflow-wrap: break-word; }'));
assert.ok(css.includes('html:is(:lang(ja), :lang(zh)) body { line-break: strict; }'));
assert.ok(css.includes('input:focus, textarea:focus { outline: none; }'));
assert.ok(css.includes('font-synthesis-weight: none'));
console.log('ok webTypographyCore');
