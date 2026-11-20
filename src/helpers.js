// Shared test helpers: test data, scoring, retries and result files.
const fs = require('fs');
const path = require('path');
const { runConsultation, norm } = require('./flow');

const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const RUN_DATE = process.env.RUN_DATE || new Date().toISOString().slice(0, 10);

function loadData(file) {
  const fullPath = path.join(ROOT, 'data', file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`data/${file} is missing. It is internal data and not in the repo - get it from the team (see README).`);
  }
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}
const symptoms = loadData('symptoms.json').map((s, i) => ({ index: i + 1, ...s }));
const sheet = new Map(symptoms.map((s) => [norm(s.symptom), s]));
const knownBugs = loadData('known-bugs.json');

// ---------- specialities ----------
const isNone = (value) => ['', 'none'].includes(norm(value));
const GENERAL_MEDICINE = new Set(['general medicine', 'internal medicine']);

/** Same speciality? "None"/empty are equal, and Internal Medicine counts as General Medicine. */
function sameSpeciality(expected, actual) {
  const a = isNone(expected) ? '' : norm(expected);
  const b = isNone(actual) ? '' : norm(actual);
  return a === b || (GENERAL_MEDICINE.has(a) && GENERAL_MEDICINE.has(b));
}

/** App specialities without the automatic Pediatrics entry for children. */
const appSpecialities = (run) => (run.specialities || []).filter((s) => !/^p(a)?ediatrics$/i.test(s.trim()));

const expectedFor = (name) => {
  const row = sheet.get(norm(name));
  return { symptom: name, primary: row?.primary ?? null, secondary: row?.secondary ?? null };
};
const patientFor = (name) => sheet.get(norm(name))?.patient;

// ---------- scoring ----------
const WANTED_SYMPTOMS = { single: 1, double: 2, triple: 3 };

/** Turns a finished run into { result, notes }. Result: PASS | PASS (partial) | FAIL | NOT FOUND | ERROR | SKIPPED */
function judge(record) {
  if (record.status === 'SKIPPED') return { result: 'SKIPPED', notes: [record.reason] };
  if (record.status === 'NOT_FOUND') {
    return { result: 'NOT FOUND', notes: [`"${record.symptoms[0]}" is not in the app's symptom search. App showed: ${(record.searchOptions || []).slice(0, 6).join(', ') || 'nothing'}`] };
  }
  if (record.status !== 'COMPLETED') {
    const errors = [...new Set(record.apiErrors)].join('; ');
    return { result: 'ERROR', notes: [`App did not reach the result screen. ${record.reason || ''}${errors ? ` API errors: ${errors}` : ''}`.trim()] };
  }

  const found = appSpecialities(record);
  const notes = [];

  if (record.suite === 'single') {
    const [expected] = record.expected;
    if (!sameSpeciality(expected.primary, found[0])) notes.push(`Primary: expected "${expected.primary}", app gave "${found[0] || '-'}"`);
    if (!sameSpeciality(expected.secondary, found[1])) notes.push(`Secondary: expected "${expected.secondary}", app gave "${found[1] || '-'}"`);
    return { result: notes.length ? 'FAIL' : 'PASS', notes };
  }

  if (record.mode === 'together') notes.push('App asked "other associated problems?" only once, so B and C were selected together');
  let missing = false;
  for (const e of record.expected) {
    if (isNone(e.primary)) notes.push(`"${e.symptom}" has no expected speciality in the sheet (not checked)`);
    else if (!found.some((f) => sameSpeciality(e.primary, f))) { missing = true; notes.push(`"${e.symptom}": expected "${e.primary}" is missing`); }
  }
  if (missing) return { result: 'FAIL', notes };
  const wanted = WANTED_SYMPTOMS[record.suite];
  if (record.symptoms.length < wanted) {
    notes.push(`Only ${record.symptoms.length} of ${wanted} symptoms could be combined`);
    return { result: 'PASS (partial)', notes };
  }
  return { result: 'PASS', notes };
}

// ---------- picking associated symptoms ----------
/** Symptoms that passed in the latest single-symptom run (preferred as B / C). Empty set if no run yet. */
function passedSymptoms() {
  if (!fs.existsSync(RESULTS_DIR)) return new Set();
  const runs = fs.readdirSync(RESULTS_DIR).filter((d) => d.startsWith('single-')).sort();
  const records = runs.length ? readRecords(path.join(RESULTS_DIR, runs[runs.length - 1])) : [];
  return new Set(records.filter((r) => r.result === 'PASS').map((r) => norm(r.symptoms[0])));
}

/** Picks one offered option: preferred -> passed individually -> in the sheet -> first. Adds it to `used`. */
function pickAssociated(options, { preferred, used, passed }) {
  const free = options.filter((o) => !used.some((u) => norm(u) === norm(o)));
  const pick = free.find((o) => preferred && norm(o) === norm(preferred))
    || free.find((o) => passed.has(norm(o)))
    || free.find((o) => sheet.has(norm(o)))
    || free[0];
  if (pick) used.push(pick);
  return pick || null;
}

// ---------- running ----------
/** Runs a consultation, retrying on a new page (fresh ref_id) if the app gets stuck. Backend 5xx is not retried. */
async function runWithRetry(page, makeOptions, attempts = 3) {
  let run;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const tab = attempt === 1 ? page : await page.context().newPage();
    run = { ...(await runConsultation(tab, makeOptions())), attempt };
    if (tab !== page) await tab.close();
    if (run.status !== 'ERROR' || run.apiErrors.some((e) => e.startsWith('5'))) break;
  }
  return run;
}

// ---------- result files ----------
const runDir = (suite) => path.join(RESULTS_DIR, `${suite}-${RUN_DATE}`);

function screenshotPath(suite, index, name) {
  const dir = path.join(runDir(suite), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(index).padStart(3, '0')}-${norm(name).replace(/ /g, '-').slice(0, 40)}.png`);
}

/** Scores the run, writes results/<suite>-<date>/records/<index>.json and returns the record. */
function saveRecord(base, run = {}, screenshot = null) {
  const symptomsUsed = [...base.symptoms, ...(run.added || [])];
  const record = {
    ...base,
    ...run,
    symptoms: symptomsUsed,
    expected: symptomsUsed.map(expectedFor),
    screenshot: screenshot && fs.existsSync(screenshot) ? path.relative(runDir(base.suite), screenshot) : null,
  };
  Object.assign(record, judge(record));
  const dir = path.join(runDir(base.suite), 'records');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${String(base.index).padStart(3, '0')}.json`), JSON.stringify(record, null, 2));
  return record;
}

const readRecords = (dir) => {
  const recordsDir = path.join(dir, 'records');
  if (!fs.existsSync(recordsDir)) return [];
  return fs.readdirSync(recordsDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8')));
};

/** Skips tests listed in data/known-bugs.json (set RUN_KNOWN_BUGS=1 to run them). */
function skipKnownBug(test, base) {
  const reason = knownBugs[base.suite]?.[base.index];
  if (!reason || process.env.RUN_KNOWN_BUGS) return;
  saveRecord(base, { status: 'SKIPPED', reason });
  test.skip(true, reason);
}

/** Attaches the screenshot and a one-line summary to the Playwright HTML report. */
async function report(testInfo, record, screenshot) {
  testInfo.annotations.push({ type: 'App specialities', description: (record.specialities || []).join(', ') || '-' });
  if (record.symptoms.length > 1) testInfo.annotations.push({ type: 'Symptoms', description: record.symptoms.join(' + ') });
  if (screenshot && fs.existsSync(screenshot)) await testInfo.attach('result', { path: screenshot, contentType: 'image/png' });
}

module.exports = {
  RESULTS_DIR, RUN_DATE, loadData, symptoms, norm, patientFor, sameSpeciality, appSpecialities,
  passedSymptoms, pickAssociated, runWithRetry, runDir, screenshotPath, saveRecord, readRecords, skipKnownBug, report,
};
