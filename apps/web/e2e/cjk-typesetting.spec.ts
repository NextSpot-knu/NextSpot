import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 일본어·중국어 조판(2026-10-06 감사 I52/I53) — 한국어 규칙·한국어 글꼴만 쓰던 화면.
// - 글꼴: 그 언어의 시스템 글꼴이 맨 앞(일본어 Hiragino Sans…, 중국어 PingFang SC…). 한국어는 그대로.
// - 안내 화면 큰 제목: 쓴 그대로 두 줄(칸에 맞게 줄인 크기), 줄 머리에 '、' '。' '，' 가 홀로 오지 않는다.
// - 한국어용 낱말 단위 줄바꿈(break-keep)은 일본어·중국어에서 그 언어 규칙으로 돌아간다.
// 음성 기능과 무관하게 돈다(음성 언어는 다른 묶음).

test.beforeEach(async ({ page }) => {
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
});

const FONT_HEAD = { ja: '"Hiragino Sans"', zh: '"PingFang SC"' } as const;

async function openGuide(page: Page, locale: 'ja' | 'zh' | 'ko', viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript((l) => localStorage.setItem('nextspot_locale', l), locale);
  await page.goto('/guide');
  await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: 30_000 });
  const h1 = page.getByRole('heading', { level: 1 }).first();
  await expect(h1).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  return h1;
}

for (const locale of ['ja', 'zh'] as const) {
  for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
    test(`${locale} ${viewport.width}px: the guide headline is two whole lines in a ${locale} font, no orphan punctuation`, async ({ page }) => {
      test.setTimeout(90_000);
      const h1 = await openGuide(page, locale, viewport);
      const report = await h1.evaluate((el) => {
        const style = getComputedStyle(el);
        const lineHeight = parseFloat(style.lineHeight);
        // 줄마다 첫 글자 — 텍스트 노드를 한 글자씩 재서 새 줄이 시작되는 글자를 모은다.
        const firsts: string[] = [];
        let prevTop: number | null = null;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const s = n.textContent ?? '';
          for (let i = 0; i < s.length; i++) {
            if (/\s/.test(s[i])) continue;
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const rect = r.getClientRects()[0];
            if (!rect) continue;
            if (prevTop === null || rect.top > prevTop + lineHeight / 2) firsts.push(s[i]);
            prevTop = rect.top;
          }
        }
        return { font: style.fontFamily, height: el.getBoundingClientRect().height, lineHeight, firsts };
      });
      expect(report.font.startsWith(FONT_HEAD[locale]), `font-family: ${report.font}`).toBe(true);
      expect(report.firsts, `${locale}: 줄 수`).toHaveLength(2);
      expect(Math.abs(report.height - 2 * report.lineHeight), `${locale}: 제목 높이 ${report.height} vs 두 줄`).toBeLessThanOrEqual(2);
      for (const ch of report.firsts) expect('、。，．', `줄 머리 '${ch}'`).not.toContain(ch);
      // 큰 제목이 줄었으니 시작 버튼이 첫 화면 안에 있다(1536×730).
      if (viewport.width === 1536) {
        const cta = page.locator('a[href="/setup"]').first();
        const box = (await cta.boundingBox())!;
        expect(box.y + box.height, `${locale}: 시작 버튼이 첫 화면 밖`).toBeLessThanOrEqual(viewport.height);
      }
    });
  }

  test(`${locale}: break-keep text follows ${locale} line breaking, and body text uses a ${locale} font`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript((l) => {
      localStorage.setItem('nextspot_locale', l);
      localStorage.setItem('nextspot_onboarding_done', '1');
    }, locale);
    await page.goto('/mypage');
    await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: 30_000 });
    const probe = await page.evaluate(() => {
      const el = document.createElement('p');
      el.className = 'break-keep font-serif';
      el.textContent = '慶州';
      document.body.appendChild(el);
      const s = getComputedStyle(el);
      const out = { wordBreak: s.wordBreak, lineBreak: s.lineBreak, font: s.fontFamily, bodyFont: getComputedStyle(document.body).fontFamily };
      el.remove();
      return out;
    });
    expect(['normal', 'auto-phrase']).toContain(probe.wordBreak);
    expect(probe.lineBreak).toBe('strict');
    expect(probe.font.startsWith(FONT_HEAD[locale]), `font-serif: ${probe.font}`).toBe(true);
    expect(probe.bodyFont.startsWith(FONT_HEAD[locale]), `body: ${probe.bodyFont}`).toBe(true);
  });
}

test('ko keeps its own fonts and word-boundary wrapping', async ({ page }) => {
  test.setTimeout(90_000);
  const h1 = await openGuide(page, 'ko', { width: 390, height: 844 });
  const font = await h1.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font).toContain('Freesentation');
  expect(font.startsWith('"Hiragino') || font.startsWith('"PingFang')).toBe(false);
  await expect(page.locator('body')).toHaveCSS('word-break', 'keep-all');
});
