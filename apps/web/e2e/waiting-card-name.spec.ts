import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /waiting 대표 카드(최소 높이 h-72): 영어·일본어는 대기 문구·배지가 두 줄씩 접혀 아래 숫자 블록이 커진다.
// 예전에는 그만큼 위 이름 블록이 0 까지 눌려, 사진과 숫자만 있고 **장소 이름이 없는** 카드가 됐다.
// 이름은 어떤 언어·폭에서도 적어도 한 줄은 온전히 보여야 하고, 이름·메뉴·소개는 줄 단위로만 잘린다
// (가로로 반쯤 잘린 줄 없음). 카드의 주인공인 대기 숫자와 맨 아래 근거 주석도 카드 안에 온전히 보인다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

// 메뉴·소개가 긴 카드(두 줄씩 접힌다)와 짧은 카드를 섞는다 — 남는 높이가 카드마다 달라 자르는 자리도 다르다.
const LONG_FEATURES = {
  first_menu: '한우국밥, 육회비빔밥, 수육',
  overview_i18n: {
    en: 'A beloved gukbap house on Hwangnidan-gil serving slow-simmered beef soup since 1987, popular with locals and visitors alike.',
    ja: '皇理団通りにある老舗のクッパ店。1987年から牛骨スープを煮込み続け、地元の人にも観光客にも人気。',
    zh: '皇理团路上的老字号汤饭店，自1987年起熬制牛骨汤，深受本地人和游客喜爱。',
  },
};
const LONG_OVERVIEW = '황리단길에서 1987년부터 소뼈 국물을 우려 온 국밥집으로, 동네 사람과 여행객 모두에게 사랑받는 곳입니다.';

function item(id: string, name: string, rank: number, level: number | null, long = false, extra: { type?: string; wait?: number } = {}) {
  const facility = {
    id, name, type: extra.type ?? 'restaurant', latitude: 35.8363 + rank * 0.0006, longitude: 129.2107,
    capacity: 30, congestion: level, image_url: null, gallery_images: null, features: long ? LONG_FEATURES : {},
    overview: long ? LONG_OVERVIEW : '황리단길 국밥집', operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
  return {
    recommendation_id: `rec-${id}`, facility, spot_score: 0.8 - rank * 0.01,
    breakdown: { preference: 0.8, wait_time: extra.wait ?? null, travel_time: rank + 3, incentive: 0 },
    distance_m: 190 + rank * 60, reason: '테스트 추천', reason_source: 'template',
    congestion_level: level, congestion_source: level === null ? 'none' : 'measured',
    congestion_log_source: level === null ? null : 'user_report',
    congestion_is_stale: level === null ? null : false, congestion_timestamp: level === null ? null : new Date().toISOString(),
    rank: rank + 1, total_candidates: 3,
    open_status_at_arrival: 'open_expected', information_confidence: 'verified', eligibility_tier: 'verified_open_route',
    place_data_source: 'tourapi', data_updated_at: null,
    scoring_mode: 'degraded_rules', model_version: null, prediction_source: 'unavailable',
  };
}

const PLACES = [
  item('n1', '분황사 쉼터', 0, 0.3, true),
  item('n2', '황남 국밥', 1, 0.4, true),
  item('n3', '월정교 식당', 2, 0.5),
];

const CASES = (['ko', 'en', 'ja', 'zh'] as const).flatMap((l) => [[l, 360], [l, 390]] as const);

for (const [locale, width] of CASES) {
  test(`waiting board (${locale}, ${width}px): every card keeps at least one full line of its place name`, async ({ page }) => {
    test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((l) => {
      localStorage.setItem('nextspot_onboarding_done', '1');
      localStorage.setItem('nextspot_locale', l);
    }, locale);
    await page.route('**/api/v1/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/api/v1/recommendations/by-type')) {
        const type = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? '');
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(type === 'restaurant' ? PLACES : []) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/waiting');
    const cards = page.locator('div.grid-rows-\\[1fr_auto\\] > button');
    await expect(cards).toHaveCount(3, { timeout: 60_000 });

    for (const name of ['분황사 쉼터', '황남 국밥', '월정교 식당']) {
      const nameP = cards.locator('p', { hasText: name }).first();
      await expect(nameP).toHaveCount(1);
      // 이름 한 줄 높이만큼 잘리지 않고 보이는지: 이름 줄과 그것을 자르는 블록(overflow-hidden)의 겹침을 잰다.
      const { visible, line } = await nameP.evaluate((p) => {
        const r = p.getBoundingClientRect();
        const clip = p.parentElement!.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(p).lineHeight);
        return { visible: Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top), line: lineHeight };
      });
      expect(visible, `${name}: 보이는 이름 높이`).toBeGreaterThanOrEqual(line - 0.5);
    }

    // 웹 글꼴이 도착해 줄바꿈이 끝난 뒤 한 프레임을 넘겨 잰다 — 관광객이 보는 자리 잡힌 화면.
    await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    })));
    // 카드 = [사진, 본문[글 블록, 대기 스탯[대기 숫자, …, 근거 주석]]].
    const report = await cards.evaluateAll((buttons) => buttons.map((button) => {
      const card = button.getBoundingClientRect();
      const body = button.lastElementChild as HTMLElement;
      const intro = body.firstElementChild as HTMLElement;
      const stats = body.lastElementChild as HTMLElement;
      const clip = intro.getBoundingClientRect();
      const within = (el: Element, box: DOMRect) => {
        const r = el.getBoundingClientRect();
        return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
      };
      // 보이는 글 줄마다: 블록 안에 통째로 들어가고, 높이가 줄 높이의 정수배(줄 단위로만 잘림).
      // 숨기거나 줄인 글은 원래(자르지 않은) 줄 수도 잰다 — 잠깐 인라인 자르기를 풀고 재서 같은 작업 안에서 되돌린다.
      const paragraphs = (Array.from(intro.children) as HTMLElement[]).map((p) => {
        const style = getComputedStyle(p);
        const line = parseFloat(style.lineHeight);
        const hidden = style.display === 'none';
        const r = p.getBoundingClientRect();
        const lines = r.height / line;
        const saved = p.getAttribute('style');
        p.style.removeProperty('display');
        p.style.removeProperty('-webkit-line-clamp');
        const natural = Math.round(p.getBoundingClientRect().height / line);
        if (saved === null) p.removeAttribute('style');
        else p.setAttribute('style', saved);
        return {
          text: (p.textContent ?? '').slice(0, 16),
          hidden,
          shown: hidden ? 0 : Math.round(lines),
          natural,
          line,
          gapBefore: parseFloat(style.marginTop) || 0,
          bottom: r.bottom,
          inside: hidden || within(p, clip),
          wholeLines: hidden || (Math.abs(lines - Math.round(lines)) < 0.05 && Math.round(lines) >= 1),
        };
      });
      // 글 블록 아래에 남은 빈 높이 — 마지막으로 보이는 줄의 아래부터 블록 아래까지.
      const lastShown = [...paragraphs].reverse().find((p) => !p.hidden);
      const free = clip.bottom - (lastShown ? lastShown.bottom : clip.top);
      const headline = stats.firstElementChild as HTMLElement;
      const footnote = stats.lastElementChild as HTMLElement;
      return {
        paragraphs,
        free,
        // 대기 숫자: 카드 안에 온전히, 글자가 상자 밖으로 넘치지 않는다.
        waitVisible: within(headline, card) && headline.scrollHeight <= headline.clientHeight + 1,
        waitText: headline.textContent ?? '',
        footnoteVisible: within(footnote, card),
        // 근거 주석은 줄 수를 자르지 않는다 — 두 줄에서 자르면 영어 '… measured data' 가 통째로 사라졌다.
        footnoteWhole: getComputedStyle(footnote).getPropertyValue('-webkit-line-clamp') === 'none'
          && footnote.scrollHeight <= footnote.clientHeight + 1,
      };
    }));
    for (const [i, card] of report.entries()) {
      for (const p of card.paragraphs) {
        expect(p.inside, `card ${i + 1} "${p.text}": 글 블록 밖으로 반쯤 나간 줄`).toBe(true);
        expect(p.wholeLines, `card ${i + 1} "${p.text}": 줄 단위로 잘리지 않음`).toBe(true);
      }
      // 덜 싣지도 않는다: 처음으로 잘리거나 숨은 글의 다음 한 줄(숨었다면 그 위 여백까지)은 남은 빈 높이에 들어가지 않는다.
      // 자리가 남는데 메뉴·소개를 숨기거나 이름을 한 줄로 줄이면 관광객 카드가 괜히 덜 알려 준다.
      const firstCut = card.paragraphs.findIndex((p) => p.shown < p.natural);
      if (firstCut >= 0) {
        const p = card.paragraphs[firstCut];
        const need = p.line + (p.shown === 0 && firstCut > 0 ? p.gapBefore : 0);
        expect(card.free, `card ${i + 1} "${p.text}": ${p.shown}/${p.natural}줄인데 빈 높이 ${card.free.toFixed(1)}px 에 한 줄(${need}px)이 더 들어간다`).toBeLessThan(need);
      }
      expect(card.waitText.trim().length, `card ${i + 1}: 대기 숫자`).toBeGreaterThan(0);
      expect(card.waitVisible, `card ${i + 1}: 대기 숫자 "${card.waitText}" 가 온전히 보임`).toBe(true);
      expect(card.footnoteVisible, `card ${i + 1}: 근거 주석이 카드 안에 온전히 보임`).toBe(true);
      expect(card.footnoteWhole, `card ${i + 1}: 근거 주석이 줄 수로 잘리지 않음`).toBe(true);
    }
    // 긴 메뉴를 가진 첫 카드: 한국어·중국어 390px 에는 이름과 메뉴 한 줄 이상이 들어갈 자리가 있다(실측 — 메뉴 두 줄).
    if ((locale === 'ko' || locale === 'zh') && width === 390) {
      const [name, menu] = report[0].paragraphs;
      expect(name.shown, 'card 1: 이름 전부').toBe(name.natural);
      expect(menu.shown, 'card 1: 대표 메뉴가 적어도 한 줄').toBeGreaterThanOrEqual(1);
    }
  });
}

// 서버 실측 대기(분)가 있는 카드와 아무 근거도 없는 카드. 영어 근거 주석('Arriving 13:00 · Based on measured data')은
// 예전에 두 줄에서 잘려 'Prediction from…' 만 남았다 — 숫자를 받치는 말이 보이지 않았다. 한국어 골드 박스는
// '예상 대기 약 10 / 분'·'대기 정보 수집 / 중'처럼 숫자와 단위가 갈라지거나 한 글자만 넘어가 잘린 글처럼 보였다.
// 문화시설처럼 한 곳뿐인 섹터의 개수 칩은 영어로 '1 spot'(예전 '1 spots').
const SERVER_PLACES = [
  item('s1', '분황사 쉼터', 0, null, false, { wait: 10 }),
  item('s2', '황남 국밥', 1, null, false, { wait: 15 }),
  item('s3', '월정교 식당', 2, null, false, { wait: 20 }),
];
const LONE_CULTURE = [item('c1', '신라고분정보센터', 0, null, false, { type: 'culture' })];
const BASIS_SERVER = { ko: '실측 기반 예측', en: 'Based on measured data', ja: '実測に基づく予測', zh: '基于实测的预测' } as const;
const SINGLE_COUNT = { ko: '1곳', en: '1 spot', ja: '1か所', zh: '1处' } as const;

for (const [locale, width] of CASES) {
  test(`waiting board (${locale}, ${width}px): basis note stays whole, wait headline keeps number with unit, one-place count`, async ({ page }) => {
    test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((l) => {
      localStorage.setItem('nextspot_onboarding_done', '1');
      localStorage.setItem('nextspot_locale', l);
    }, locale);
    await page.route('**/api/v1/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/api/v1/recommendations/by-type')) {
        const type = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? '');
        const body = type === 'restaurant' ? SERVER_PLACES : type === 'culture' ? LONE_CULTURE : [];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/waiting');
    const cards = page.locator('div.grid-rows-\\[1fr_auto\\] > button');
    await expect(cards).toHaveCount(4, { timeout: 60_000 });
    // 그 언어 사전이 붙은 뒤(비-ko 첫 렌더의 한국어가 아니라)의 근거 주석을 잰다.
    await expect(cards.filter({ hasText: BASIS_SERVER[locale] })).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    })));

    const report = await cards.evaluateAll((buttons) => buttons.map((button) => {
      const card = button.getBoundingClientRect();
      const stats = (button.lastElementChild as HTMLElement).lastElementChild as HTMLElement;
      const headline = stats.firstElementChild as HTMLElement;
      const footnote = stats.lastElementChild as HTMLElement;
      const f = footnote.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(footnote).lineHeight);
      // 골드 박스 글의 줄바꿈 자리 — 새 줄 첫 글자의 바로 앞 글자를 모은다.
      const text = headline.textContent ?? '';
      const node = headline.firstChild;
      const breaksBefore: string[] = [];
      let lastLineStart = 0;
      if (node && node.nodeType === Node.TEXT_NODE) {
        let prevTop: number | null = null;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === ' ') continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          if (prevTop !== null && rect.top > prevTop + 2) {
            breaksBefore.push(text[i - 1] ?? '');
            lastLineStart = i;
          }
          prevTop = rect.top;
        }
      }
      return {
        headline: text,
        breaksBefore,
        lastLine: text.slice(lastLineStart),
        footnote: footnote.textContent ?? '',
        footnoteLines: Math.round(f.height / line),
        footnoteWhole: getComputedStyle(footnote).getPropertyValue('-webkit-line-clamp') === 'none'
          && footnote.scrollHeight <= footnote.clientHeight + 1
          && f.top >= card.top - 0.5 && f.bottom <= card.bottom + 0.5,
      };
    }));
    for (const [i, card] of report.slice(0, 3).entries()) {
      expect(card.footnote, `card ${i + 1}: 근거 주석 전문`).toContain(BASIS_SERVER[locale]);
      expect(card.footnoteWhole, `card ${i + 1}: 근거 주석 "${card.footnote}" 이 잘리지 않고 카드 안에`).toBe(true);
      // 짧게 고친 영어 문구는 390px 폰에서 다른 언어처럼 두 줄(360px 는 세 줄 — 잘리지 않고 글 블록이 양보한다).
      if (locale === 'en' && width === 390) expect(card.footnoteLines, `card ${i + 1}: "${card.footnote}" 줄 수`).toBeLessThanOrEqual(2);
    }
    if (locale === 'ko') {
      for (const card of report) {
        for (const before of card.breaksBefore) {
          expect(before, `"${card.headline}": 한국어 대기 문구는 띄어쓰기에서만 접힌다`).toBe(' ');
        }
        // 띄어쓰기에서 접혀도 '수집 / 중' 처럼 한 글자만 다음 줄로 가면 잘린 글처럼 읽힌다.
        expect(card.lastLine.replace(/\s/g, '').length, `"${card.headline}": 마지막 줄 "${card.lastLine}"`).toBeGreaterThan(1);
      }
    }
    const cultureSection = page.locator('main section.fractal-glass').filter({ has: page.getByText('신라고분정보센터') });
    await expect(cultureSection.locator('span.ml-auto')).toHaveText(SINGLE_COUNT[locale]);
  });
}
