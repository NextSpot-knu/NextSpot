// facilities.features 에 식당별 '대표메뉴(signature_menu) + 실제 주소(address) + 전화(phone)' 를 병합한다.
//
// 배경(왜 필요한가):
//   대표메뉴가 '식당별'이 아니라 '카테고리별'로만 부여돼, 피자헛과 제이미버거하우스가 똑같은 메뉴를 보였고
//   주소는 카드 폴백 '경상북도 구미시 산단로' 로 단일화돼 보였다. samples/facility_enrichment.json 은
//   카카오 수집 103개 식당 + 일반시설 40개에 대해 '그 가게 고유 대표메뉴'와 '실제 도로명주소'를
//   웹검색 + 적대적 검증으로 채운 정본 데이터다. 이 스크립트가 그것을 라이브 facilities.features 에 병합한다.
//
// 매칭: facilities.id(UUID)는 카카오 CSV 에서 null 이라, **상호명(name) 정확 일치**로 매칭한다(명칭 유일).
// 병합: features 의 기존 키(cuisine_tags 등)는 보존하고 address/phone/signature_menu 만 set/갱신(멱등).
//
// 실행(레포 루트에서):
//   node --env-file=.env.local scripts/enrich_facilities.js            # 실제 적용
//   node --env-file=.env.local scripts/enrich_facilities.js --dry-run  # 미리보기(쓰기 없음)
//
// 적용 후: features.signature_menu/address 는 프런트(RecommendationCard 등)가 즉시 읽으므로 별도 재배포 불필요.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

const supabaseUrl = process.env.SUPABASE_URL || 'https://xdwnwrthrgflbzpvkouq.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY. Run with: node --env-file=.env.local scripts/enrich_facilities.js');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

function loadEnrichment() {
  const p = path.join(__dirname, '..', 'samples', 'facility_enrichment.json');
  if (!fs.existsSync(p)) {
    console.error(`Enrichment file not found: ${p}`);
    process.exit(1);
  }
  const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(arr)) {
    console.error('facility_enrichment.json must be a JSON array.');
    process.exit(1);
  }
  return arr;
}

function normFeatures(features) {
  // features 가 문자열 JSON 으로 저장된 경우까지 dict 로 정규화.
  if (typeof features === 'string') {
    try { return JSON.parse(features) || {}; } catch (_) { return {}; }
  }
  return features || {};
}

async function main() {
  console.log(`[1/3] facilities 로드...${DRY_RUN ? ' (dry-run)' : ''}`);
  const { data: facilities, error } = await supabase.from('facilities').select('id,name,features');
  if (error || !facilities) {
    console.error('facilities 조회 실패:', error);
    process.exit(1);
  }
  console.log(`      ${facilities.length}개 시설`);

  // 상호명 → facility (동명이 있으면 첫 번째). 공백 정규화로 사소한 차이 흡수.
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const byName = new Map();
  for (const f of facilities) {
    const k = norm(f.name);
    if (!byName.has(k)) byName.set(k, f);
  }

  const enrichment = loadEnrichment();
  console.log(`[2/3] enrichment ${enrichment.length}건 병합 매칭...`);

  let matched = 0, updated = 0;
  const unmatched = [];

  for (const e of enrichment) {
    const f = byName.get(norm(e.name));
    if (!f) { unmatched.push(e.name); continue; }
    matched++;

    const feats = normFeatures(f.features);
    const next = { ...feats };
    if (e.address) next.address = e.address;
    if (e.phone) next.phone = e.phone;
    if (e.signature_menu) next.signature_menu = e.signature_menu;
    // 주차장 상세(있을 때만): EV 충전·실내 여부. 기존 parking_type/is_public 등은 보존됨.
    if (typeof e.has_ev_charger === 'boolean') next.has_ev_charger = e.has_ev_charger;
    if (typeof e.indoor === 'boolean') next.indoor = e.indoor;
    if (e.ev_charger_count !== undefined && e.ev_charger_count !== null) next.ev_charger_count = e.ev_charger_count;
    if (e.ev_source) next.ev_source = e.ev_source;
    // 메타(선택): 출처 추적. 데모 신뢰도 설명용.
    if (e.address_source) next.address_source = e.address_source;
    if (e.menu_source && e.menu_source !== 'none') next.menu_source = e.menu_source;

    const changed = JSON.stringify(next) !== JSON.stringify(feats);
    if (!changed) continue;

    if (DRY_RUN) {
      updated++;
      console.log(`      ~ ${f.name}  →  주소:"${e.address || '-'}"  메뉴:"${e.signature_menu || '-'}"`);
      continue;
    }
    const { error: uErr } = await supabase.from('facilities').update({ features: next }).eq('id', f.id);
    if (uErr) { console.error(`      ✗ ${f.name} 업데이트 실패:`, uErr.message); continue; }
    updated++;
    if (updated % 25 === 0) console.log(`      ${updated}건 갱신...`);
  }

  console.log(`[3/3] 완료: 매칭 ${matched}/${enrichment.length}, 갱신 ${updated}건${DRY_RUN ? ' (dry-run, 미적용)' : ''}.`);
  if (unmatched.length) {
    console.log(`      미매칭(${unmatched.length}) — 라이브 DB 에 해당 상호 없음(이름 표기 차이 가능):`);
    for (const n of unmatched) console.log(`        · ${n}`);
  }
}

main();
