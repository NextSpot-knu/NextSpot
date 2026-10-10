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

// 4) 배선 — 랜딩 '바로 시작'(휴대폰·데스크톱 히어로 둘 다)도 같은 한 가지 스타일(계획 B3 I86 · 통합 10-07).
{
  const landing = readFileSync(join(WEB, "app/page.tsx"), "utf8");
  assert.ok((landing.match(/cta-primary/g) ?? []).length >= 2, "랜딩 '바로 시작'(휴대폰·데스크톱)이 cta-primary 를 쓰지 않는다");
  assert.doesNotMatch(landing, /from-gold to-terracotta[^"`]*text-white/, "랜딩에 옛 금→주칠(대비 미달) 버튼이 남아 있다");
}

// 5) 배선 — 같은 '도보 길안내' 와 빈 화면의 다음 행동 버튼(대안 목록 · 대기 보드 · 분산 코스)도 같은 한 가지 스타일
//    (리뷰 10-07: /main 카드는 cta-primary 인데 /explore/recommend 카드의 '도보 길안내' 는 옛 금→주칠 3.7:1 이었다).
for (const page of ["app/explore/recommend/page.tsx", "app/waiting/page.tsx", "app/course/page.tsx"]) {
  const source = readFileSync(join(WEB, page), "utf8");
  assert.ok(source.includes("cta-primary"), `${page} 의 주 버튼이 cta-primary 를 쓰지 않는다`);
  assert.doesNotMatch(source, /from-gold to-terracotta[^"`]*text-white/, `${page} 에 옛 금→주칠(대비 미달) 버튼이 남아 있다`);
  assert.doesNotMatch(source, /from-gold to-terracotta text-\[\d+px\] font-bold text-white/, `${page} 에 옛 금→주칠(대비 미달) 버튼이 남아 있다`);
}

// 6) 글자 토큰 — 라이트 화면의 본문(먹)·보조(먹 연)·강조 라벨(금 진)은 앉는 바탕(흰 · 한지 · 한지 진 · 금 10~15% 칩)
//    어디서나 4.5:1 이상(WCAG 1.4.3, Apple HIG). 금 칩은 흰·한지 위 10~25%, 한지 진 위 15% 까지. 금 진은 라벨·배지·활성 탭 글자로 249곳에 쓰여 예전 #a37f2a(3.0~3.7:1)가
//    가장 넓은 미달이었다(10-10 실서비스 비교 감사). 금(#c19a3e)은 장식·아이콘 색이라 글자 기준에서 뺀다.
{
  const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
  const root = css.slice(css.search(/^:root\s*\{/m), css.indexOf("}", css.search(/^:root\s*\{/m)));
  const tok = (name: string) => {
    const m = root.match(new RegExp(`--nextspot-${name}:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(m, `토큰 없음: --nextspot-${name}`);
    return m![1];
  };
  const gold = tok("gold");
  const surfaces: Record<string, string> = {
    white: "#ffffff",
    hanji: tok("hanji"),
    "hanji-deep": tok("hanji-deep"),
    "gold/10 on white": mixHex("#ffffff", gold, 0.1),
    "gold/15 on white": mixHex("#ffffff", gold, 0.15),
    "gold/15 on hanji": mixHex(tok("hanji"), gold, 0.15),
    "gold/25 on white": mixHex("#ffffff", gold, 0.25),
    "gold/25 on hanji": mixHex(tok("hanji"), gold, 0.25),
    "gold/15 on hanji-deep": mixHex(tok("hanji-deep"), gold, 0.15),
  };
  for (const name of ["muk", "muk-soft", "gold-deep"]) {
    for (const [bg, hex] of Object.entries(surfaces)) {
      const ratio = contrastRatio(tok(name), hex);
      assert.ok(ratio >= 4.5, `${name} on ${bg}: ${ratio.toFixed(2)} < 4.5`);
    }
  }
}

// 7) Liquid Glass(app/globals.css .liquid-glass) — 지도 위 탐색 층의 바탕은 한지를 --nextspot-glass-tint 만큼 덮은 반투명이라
//    뒤의 지도 색에 따라 달라진다. 그래서 두 가지를 잠근다: 주 글자(먹)는 뒤가 완전히 검거나(라이트) 흰(야간) 최악에도 4.5:1,
//    보조 글자(먹 연·금 진)는 중간 회색(#808080) 지도 위에서 4.5:1. 비율을 낮추면 이 테스트가 먼저 깨진다.
{
  const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
  for (const [label, selector, worst] of [
    ["light", /^:root\s*\{/m, "#000000"],
    ["dark", /^html\.nextspot-dark\s*\{/m, "#ffffff"],
  ] as const) {
    const start = css.search(selector);
    const block = css.slice(start, css.indexOf("}", start));
    const hex = (name: string) => {
      const m = block.match(new RegExp(`--nextspot-${name}:\\s*(#[0-9a-fA-F]{6})`));
      assert.ok(m, `${label} 토큰 없음: --nextspot-${name}`);
      return m![1];
    };
    const tintMatch = block.match(/--nextspot-glass-tint:\s*(\d+(?:\.\d+)?)%/);
    assert.ok(tintMatch, `${label} 토큰 없음: --nextspot-glass-tint`);
    const tint = Number(tintMatch![1]) / 100;
    const glassOver = (backdrop: string) => mixHex(backdrop, hex("hanji"), tint);
    const primary = contrastRatio(hex("muk"), glassOver(worst));
    assert.ok(primary >= 4.5, `${label} glass: muk over ${worst} ${primary.toFixed(2)} < 4.5`);
    for (const name of ["muk-soft", "gold-deep"]) {
      const ratio = contrastRatio(hex(name), glassOver("#808080"));
      assert.ok(ratio >= 4.5, `${label} glass: ${name} over mid-gray ${ratio.toFixed(2)} < 4.5`);
    }
  }
}

console.log("contrast tests passed");
