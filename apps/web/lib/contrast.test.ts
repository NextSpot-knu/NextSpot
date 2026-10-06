import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, minGradientContrast, mixHex, parseHex, relativeLuminance } from "./contrast";

// 계획 B3 · I86 — 주요 버튼은 흰 글자 + 금→주칠 그라데이션 하나로, 라이트·야간 모두 4.5:1 이상.
const WEB = process.cwd();

// 1) 계산 자체 — 알려진 값.
{
  assert.equal(Math.round(contrastRatio("#ffffff", "#000000") * 10) / 10, 21);
  assert.equal(contrastRatio("#777", "#777"), 1);
  assert.deepEqual(parseHex("#abc"), [170, 187, 204]);
  assert.throws(() => parseHex("gold"));
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.ok(relativeLuminance("#ffffff") > 0.99);
  // 예전 버튼(금 #c19a3e · 금 진 #a37f2a 위 흰 글자)은 기준에 못 미쳤다 — 이 테스트가 막으려는 것.
  assert.ok(contrastRatio("#c19a3e", "#ffffff") < 4.5);
  assert.ok(contrastRatio("#a37f2a", "#ffffff") < 4.5);
}

// 2) 토큰 — app/globals.css 의 라이트(:root)와 야간(html.nextspot-dark) 블록에 둘 다 있고, 전 구간 4.5:1 이상.
{
  const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
  const block = (selector: RegExp) => {
    const start = css.search(selector);
    assert.ok(start >= 0, `블록 없음: ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };
  const token = (src: string, name: string) => {
    const m = src.match(new RegExp(`--nextspot-${name}:\\s*(#[0-9a-fA-F]{3,6})`));
    assert.ok(m, `토큰 없음: --nextspot-${name}`);
    return m![1];
  };
  for (const [label, src] of [["light", block(/^:root\s*\{/m)], ["dark", block(/^html\.nextspot-dark\s*\{/m)]] as const) {
    const from = token(src, "cta-from");
    const to = token(src, "cta-to");
    const min = minGradientContrast(from, to);
    assert.ok(min >= 4.5, `${label} CTA 대비 ${min.toFixed(2)} < 4.5 (${from} → ${to})`);
  }
  assert.match(css, /\.cta-primary\s*\{[^}]*var\(--nextspot-cta-from\)[^}]*var\(--nextspot-cta-to\)/s, ".cta-primary 가 토큰을 쓰지 않는다");
  assert.match(css, /\.cta-primary\s*\{[^}]*color:\s*#fff/s, ".cta-primary 글자는 흰색");
}

// 3) 배선 — 추천 카드의 '도보 길안내'(전체 카드 · 휴대폰 미리보기)가 그 한 가지 스타일을 쓴다.
{
  const card = readFileSync(join(WEB, "components/RecommendationCard.tsx"), "utf8");
  assert.ok((card.match(/cta-primary/g) ?? []).length >= 2, "도보 길안내(전체 카드·미리보기)가 cta-primary 를 쓰지 않는다");
  assert.doesNotMatch(card, /from-gold to-terracotta[^"`]*text-white/, "옛 금→주칠(대비 미달) 버튼이 남아 있다");
}

console.log("contrast tests passed");
