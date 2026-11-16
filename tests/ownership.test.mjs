// F-05፦ requirements/ownership_raci.yaml ከሦስቱም ምንጮች ጋር እኩል መሆኑን ይፈትሻል።
//   v2.8 §3 (አንድ ዋና የባለቤት መዝገብ)፣ requirements/requirements.yaml (123 መለያ)፣
//   docs/OWNERSHIP_RACI_AND_SECTION_API_v1_0_AM.md (የሰው ሚና ካርታ፣ API ውል፣ መጠባበቂያ ጥያቄዎች)።
// ይህ ፍተሻ አንብቦ ብቻ ያወዳድራል፤ ባለቤትነት አይቀይርም — ማንኛውም ለውጥ CR እና የባለቤት ውሳኔ ይጠብቃል (R-41)።
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RACI_FILE = join(REPO, 'requirements', 'ownership_raci.yaml');
const V28 = join(REPO, 'docs', 'FARMER_AI_PHONE_CANONICAL_REQUIREMENT_OWNER_EVIDENCE_REGISTRY_v2_8_AM.md');
const DOC = join(REPO, 'docs', 'OWNERSHIP_RACI_AND_SECTION_API_v1_0_AM.md');
const ID_RE = /^(?:R|CI|LC|RU|OP|VE|FD)-\d{2}$/;
const unq = (s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"');
const splitCs = (s) => s.split('፣').map((x) => x.trim()).filter(Boolean);

// -- R/C/I/W መለያ ዝርዝር አንባቢ፦ "CI-01–12፣ CI-13†" ወደ ሙሉ መለያዎች ይዘረጋል -------------
function parseIds(cell) {
  const out = [];
  for (const tokRaw of splitCs(cell)) {
    const tok = tokRaw.replace(/†/g, '').trim();
    const range = tok.match(/^([A-Z]+)-(\d{2})[–-](\d{2})$/);
    if (range) {
      const [, fam, a, b] = range;
      for (let n = Number(a); n <= Number(b); n++) out.push(`${fam}-${String(n).padStart(2, '0')}`);
      continue;
    }
    if (!ID_RE.test(tok)) throw new Error(`የተነበበ መለያ አይደለም፦ "${tokRaw}"`);
    out.push(tok);
  }
  return out;
}

// -- ትንሽ YAML አንባቢ (sections:/proposals: ቆንጆ ክፍሎች) -------------------------------
function parseRaci(text) {
  const out = { sections: [], proposals: [], top: {} };
  let section = null;
  let cur = null;
  const list = (v) => (v === '[]' ? [] : v.replace(/^\[|\]$/g, '').split(',').map((s) => unq(s.trim())).filter(Boolean));
  for (const raw of text.split('\n')) {
    if (raw.startsWith('sections:')) { section = 'sections'; cur = null; continue; }
    if (raw.startsWith('proposals:')) { section = 'proposals'; cur = null; continue; }
    if (raw.match(/^[a-z_0-9]+:/)) {
      if (section) continue;
      const f = raw.match(/^([a-z_0-9]+): (.*)$/);
      if (f) out.top[f[1]] = unq(f[2]);
      continue;
    }
    const id = raw.match(/^  - id: (\S+)$/);
    if (id) {
      cur = { id: id[1] };
      out[section].push(cur);
      continue;
    }
    if (!cur) continue;
    const f = raw.match(/^    ([a-z_0-9]+): (.*)$/);
    if (!f) continue;
    const [, key, val] = f;
    if (['roles', 'requirements', 'pending_transfer', 'responsible', 'consulted', 'informed'].includes(key)) cur[key] = list(val);
    else cur[key] = unq(val);
  }
  return out;
}

// -- ሰነድ ሰንጠረዦች -----------------------------------------------------------------
function docRows(md, firstCellRe) {
  const rows = [];
  md.split('\n').forEach((raw, i) => {
    if (!raw.startsWith('|')) return;
    const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
    if (firstCellRe.test(cells[0])) rows.push({ cells, line: i + 1 });
  });
  return rows;
}

const raci = parseRaci(readFileSync(RACI_FILE, 'utf8'));
const v28Lines = readFileSync(V28, 'utf8').split('\n');
const v28 = new Map();
docRows(readFileSync(V28, 'utf8'), ID_RE).forEach(({ cells, line }) => {
  assert.ok(!v28.has(cells[0]), `v2.8 ሰንጠረዥ ድግምስ መለያ፦ ${cells[0]} (ርዕድ ${line})`);
  v28.set(cells[0], { owner: cells[2], line });
});

const regText = readFileSync(join(REPO, 'requirements', 'requirements.yaml'), 'utf8').split('\n');
const registryOwner = new Map();
let curId = null;
for (const l of regText) {
  const id = l.match(/^  - id: (\S+)$/);
  if (id) { curId = id[1]; continue; }
  const o = l.match(/^    owner_role: (.*)$/);
  if (o && curId) registryOwner.set(curId, unq(o[1]));
}

const secOf = new Map();
for (const s of raci.sections) for (const r of s.requirements) secOf.set(r, s.id);

test('F-05፦ 123ቱ መለያዎች በትክክል በአንድ A ክፍል ውስጥ ብቻ ተመዝግበዋል (R-29 — አንድ ተጠያቂ)', () => {
  assert.deepEqual(raci.sections.map((s) => s.id), raci.sections.map((s) => s.id).sort(), 'የክፍሎች ቅደም ተከተል S-01… ተከታታይ መሆን አለበት');
  const dup = [];
  const seen = new Map();
  for (const s of raci.sections) {
    assert.equal(new Set(s.requirements).size, s.requirements.length, `${s.id} ውስጥ ድግምስ መለያ አለ`);
    assert.ok(s.accountable, `${s.id} A (ተጠያቂ) የለውም`);
    for (const r of s.requirements) {
      assert.ok(ID_RE.test(r), `${s.id} ውስጥ ያለ "${r}" ሕጋዊ መለያ አይደለም`);
      if (seen.has(r)) dup.push(`${r} በ${seen.get(r)}ና በ${s.id}`);
      seen.set(r, s.id);
    }
  }
  assert.deepEqual(dup, [], 'አንድ መስፈርት ሁለት A ክፍሎች ሲኖሩት R-29 ይጣሳል');
  const ids = [...registryOwner.keys()].sort();
  assert.equal(ids.length, 123, 'የመዝገብ መለያ ብዛት 123 መሆን አለበት');
  assert.deepEqual(ids, [...secOf.keys()].sort(), 'በRACI ውስጥ ያሉና በመዝገብ ያሉ መለያዎች እኩል አይደሉም');
});

test('F-05፦ የእያንዳንዱ መለያ ክፍል ሽፋን ከv2.8 owner_role ጋር ይጣጣም፤ 29ኙ ባለቤት ስሞች አንድ ጊዜ ብቻ ይኖራሉ', () => {
  for (const s of raci.sections) {
    assert.ok(s.accountable && s.roles.includes(s.accountable), `${s.id} A ("${s.accountable}") በራሱ roles ውስጥ የለም`);
    const mine = new Set(s.requirements);
    for (const r of s.requirements) {
      const owner = registryOwner.get(r);
      assert.ok(s.roles.includes(owner), `${r} የv2.8 ባለቤት "${owner}" በ${s.id} roles ውስጥ የለም`);
    }
    for (const [id, owner] of registryOwner) {
      if (s.roles.includes(owner)) assert.ok(mine.has(id), `${id} (${owner}) በ${s.id} ውስጥ ሊኖር ይገባ ነበር — የክፍል ዝርዝር ክፍተት አለ`);
    }
  }
  const allRoles = raci.sections.flatMap((s) => s.roles);
  assert.equal(new Set(allRoles).size, allRoles.length, 'አንድ የv2.8 ባለቤት ስም በሁለት ክፍል ተከፋፍሏል');
  assert.deepEqual([...new Set(allRoles)].sort(), [...new Set(registryOwner.values())].sort(), 'የv2.8 ባለቤት ስሞች በሙሉ በRACI መዘጋት አለባቸው');
});

test('F-05፦ RACI ከማሽን መዝገብና ከv2.8 ሰነድ ጋር አንድ አይነት ባለቤት ይዟል (v2.8 ሳይቀየር)', () => {
  assert.equal(v28.size, 123, 'v2.8 §3 በ85+38=123 መለያ ላይ አንድ ረድፍ መያዝ አለበት');
  for (const [id, owner] of registryOwner) {
    const row = v28.get(id);
    assert.ok(row, `${id} በv2.8 የለም — ሁለተኛ ዋና መዝገብ መፍጠር ተከለክሏል (F-04)`);
    assert.equal(owner, row.owner, `${id} የማሽን መዝገብ ባለቤት ከv2.8 ጋር አልተጣጠመም`);
  }
});

test('F-05፦ የ6ኛው ግጭት መስመሮች በv2.8 ላይ እንዳሉ ተረጋግተዋል፤ መጠባበቂያ ጥያቄ ብቻ ነው (ለውጥ አልተፈጸመም)', () => {
  assert.equal(raci.proposals.length, 6, 'F-05 የተገለጹት 6 ማዛመሪያ ጥያቄዎች ናቸው');
  for (const p of raci.proposals) {
    assert.ok(ID_RE.test(p.requirement), `${p.id} የተጠቀሰው መለያ ሕጋዊ አይደለም`);
    const row = v28.get(p.requirement);
    assert.equal(p.current_owner, row.owner, `${p.id} current_owner ከv2.8 ጋር አልተጣጠመም`);
    assert.equal(p.evidence, `v2.8:${row.line}`, `${p.id} የv2.8 ረድፍ ማስረጃ ተሳሳተ (እውነት፦ ርዕድ ${row.line})`);
    assert.ok([...registryOwner.values()].includes(p.proposed_owner), `${p.id} የሚቆራረጠው ባለቤት በv2.8 ውስጥ የለም — አዲስ ተጠያቂ መፍጠር ተከለክሏል`);
    const to = raci.sections.find((s) => s.id === p.to_section);
    const from = raci.sections.find((s) => s.id === p.from_section);
    assert.ok(to && from, `${p.id} የተጠቀሰው የክፍል መለያ በYAML የለም`);
    assert.ok(from.requirements.includes(p.requirement), `${p.id} ከ${p.from_section} ውጭ — መለያው እዚያ አይኖርም`);
    assert.ok(to.roles.includes(p.proposed_owner), `${p.id} የታቀደው ባለቤት "${p.proposed_owner}" የ${p.to_section} ክፍል ሽፋን ውስጥ የለም — ክፍል አደረጃጀት ተሰብሯል`);
    assert.equal(p.status, 'PROPOSED', `${p.id} ውሳኔ ያልተሰጠበት መሆን አለበት`);
    assert.equal(p.owner_decision, 'PENDING', `${p.id} የባለቤት ውሳኔ PENDING መባል አለበት`);
    assert.notEqual(registryOwner.get(p.requirement), p.proposed_owner, `${p.id} ጥያቄው ተፈጻሚ ሆኗል — ባለቤት ውሳኔ ሳይኖር v2.8 መቀየር አይቻልም`);
    assert.ok(!to.requirements.includes(p.requirement), `${p.id} መለያው ወደ ${p.to_section} ተዛወሯል — የባለቤት ውሳኔ ሳይኖር መተግበር አልተፈቀደም`);
  }
});

test('F-05፦ pending_transfer በYAMLና በሰነዱ † ምልክት እኩል ናቸው፤ ሌሎች መለያዎች ንጹህ A አላቸው', () => {
  const pending = new Set(raci.proposals.map((p) => p.requirement));
  const yamlPending = new Set(raci.sections.flatMap((s) => s.pending_transfer));
  assert.deepEqual([...yamlPending].sort(), [...pending].sort(), 'የYAML pending_transfer እና የጥያቄ ዝርዝር አንድ አይነት መሆን አለበት');
  const docPending = new Set();
  for (const { cells } of docRows(readFileSync(DOC, 'utf8'), /^S-\d{2}$/)) {
    for (const tokRaw of splitCs(cells[6])) if (tokRaw.includes('†')) docPending.add(tokRaw.replace(/†/g, '').trim());
  }
  assert.deepEqual([...docPending].sort(), [...pending].sort(), 'በሰነዱ ላይ የተመለኩት † መለያዎች ከጥያቄዎቹ ጋር እኩል አይደሉም');
  for (const s of raci.sections) {
    for (const r of s.pending_transfer) assert.ok(s.requirements.includes(r), `${s.id} pending_transfer ውስጥ ያለ ${r} በክፍሉ ዝርዝር የለም`);
  }
});

test('F-05፦ ሰነዱ §2 (R/C/I/A/መስፈርት) ከYAML ክፍሎች ጋር ቃል በቃል ይጣጣማል', () => {
  const rows = docRows(readFileSync(DOC, 'utf8'), /^S-\d{2}$/);
  assert.equal(rows.length, raci.sections.length, 'የሰነዱና የYAML ክፍል ብዛት እኩል አይደለም');
  rows.forEach(({ cells, line }, i) => {
    const s = raci.sections[i];
    assert.equal(cells[0], s.id, `ርዕድ ${line} የክፍል መለያ ልዩነት`);
    assert.equal(cells[1], s.title, `${s.id} ክፍል ርዕስ ከሰነዱ ጋር አልተጣጣመም`);
    assert.equal(cells[2], s.accountable, `${s.id} A ከሰነዱ ጋር አልተጣጣመም`);
    for (const [idx, key] of [[3, 'responsible'], [4, 'consulted'], [5, 'informed']]) {
      assert.deepEqual(splitCs(cells[idx]), s[key], `${s.id} ${key} ከሰነዱ ጋር አልተጣጣመም`);
    }
    assert.deepEqual(parseIds(cells[6]), s.requirements, `${s.id} የA መስፈርቶች ዝርዝር ከሰነዱ ጋር አልተጣጣመም`);
  });
});

test('F-05፦ የክፍል API ውል (ገቢ/ወጪ/ድንጋጌ/ስህተት) በሰነዱና በYAML መካከል አንድ አይነት ነው', () => {
  const rows = docRows(readFileSync(DOC, 'utf8'), /^S-\d{2} /);
  assert.equal(rows.length, raci.sections.length, 'የAPI ሰንጠረዥ ረድፍ ብዛት ከክፍሎች ጋር እኩል አይደለም');
  for (const { cells } of rows) {
    const [id, label] = [cells[0].slice(0, 4), cells[0].slice(5)];
    const s = raci.sections.find((x) => x.id === id);
    assert.ok(s, `API ረድፍ ${id} በYAML የለም`);
    assert.equal(label, s.api_label, `${id} አጭር ርዕስ አልተጣጣመም`);
    assert.equal(cells[1], s.api_input, `${id} ገቢ ውል አልተጣጣመም`);
    assert.equal(cells[2], s.api_output, `${id} ወጪ ውል አልተጣጣመም`);
    assert.equal(cells[3], s.api_invariant, `${id} ማይሻረር ድንጋጌ አልተጣጣመም`);
    assert.equal(cells[4], s.api_on_error, `${id} የስህተት ግምጣ ብዛት አልተጣጣመም`);
    assert.ok(s.api_invariant.length > 0, `${id} ድንጋጌ ባዶ ነው`);
  }
});

test('F-05፦ ሰነዱ §5 መጠባበቂያ ጠረጴዛ ከYAML proposals ጋር ቃል በቃል ይጣጣማል', () => {
  const rows = docRows(readFileSync(DOC, 'utf8'), ID_RE).filter(({ cells }) => cells.length === 5);
  assert.equal(rows.length, raci.proposals.length, 'የሰነዱና የYAML ጥያቄ ብዛት እኩል አይደለም');
  rows.forEach(({ cells }, i) => {
    const p = raci.proposals[i];
    assert.equal(cells[0], p.requirement, 'የጥያቄ መለያ ቅደም ተከተል ልዩነት');
    assert.equal(cells[1], p.current_owner, `${p.id} current owner በሰነዱ ላይ አልተጣጣመም`);
    const m = cells[2].match(/^(.*)\s\((S-\d{2})\)$/);
    assert.ok(m, `${p.id} የሰነዱ "የሚቆራረጥ A" ቅርጽ ተስማሚ አይደለም`);
    assert.equal(m[1], p.proposed_owner, `${p.id} የታቀደ ባለቤት አልተጣጣመም`);
    assert.equal(m[2], p.to_section, `${p.id} የታቀደ ክፍል አልተጣጣመም`);
    assert.equal(cells[3], p.reason, `${p.id} ምክንያት አልተጣጣመም`);
    assert.equal(cells[4], p.evidence, `${p.id} ማስረጃ አልተጣጣመም`);
  });
});

test('F-05፦ አርቲፋክቱ ያለው ደረጃ PARTIALና የባለቤት ውሳኔ PENDING ብቻ ነው (GO መግለጫ የለም)', () => {
  assert.equal(raci.top.status, 'PARTIAL', 'F-05 ሙሉ በሙሉ ሊዘጋ አይችልም — ተጠሪ በስም ገና የለም (F-03/F-25)');
  assert.equal(raci.top.owner_decision, 'PENDING', 'የባለቤት ውሳኔ ሳይኖር PENDING መሆን አለበት');
  assert.equal(raci.top.one_accountable_rule, 'R-29', 'የአንድ ተጠያቂ ሕግ መሠረቱ R-29 ነው');
  assert.equal(raci.top.source_owner_registry, 'docs/FARMER_AI_PHONE_CANONICAL_REQUIREMENT_OWNER_EVIDENCE_REGISTRY_v2_8_AM.md', 'አንድ ዋና የባለቤት ምንጭ ተመዝግቧል፤ ሌላ መፍጠር ተከለክሏል');
  const v28Head = v28Lines.filter((l) => /^\| R-01 /.test(l));
  assert.equal(v28Head.length, 1, 'የv2.8 መሠረት ረድፍ አንድ ብቻ መሆን አለበት');
});
