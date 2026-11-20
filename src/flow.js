// Drives one consultation in the CDSS demo app and returns what the app recommended.
//
// Flow: open app (fresh ref_id) -> search + select symptom -> answer every question
// ("Not applicable" if offered, else the first option; realistic values for typed questions)
// -> optionally add associated symptoms -> read the "Specialities" list on the result screen.

const ATTEMPT_LIMIT_MS = Number(process.env.ATTEMPT_LIMIT_SEC || 150) * 1000;
const SERVER_ERROR_WAIT_MS = 20_000;

// Answers for free-text questions (first matching pattern wins)
const TYPED_ANSWERS = [
  [/temperature/i, '101'],
  [/systolic|blood pressure/i, '120/80'],
  [/sugar/i, '110'],
  [/haemoglobin|hemoglobin/i, '12'],
  [/thyroid|t3|tsh/i, '1.2, 8, 2.5'],
  [/kg/i, '3'],
  [/medicine/i, 'Paracetamol'],
  [/since when|how long/i, '2'],
];

const norm = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const typedAnswer = (question) => (TYPED_ANSWERS.find(([pattern]) => pattern.test(question)) || [null, '1'])[1];
const isServerError = (entry) => entry.startsWith('5');

/** App URL with a fresh ref_id and, optionally, a different patient ({ gender: 'male'|'female', dob: 'DD-MM-YYYY' }). */
function appUrl(patient = {}) {
  if (!process.env.CDSS_URL) throw new Error('CDSS_URL is not set');
  const url = new URL(process.env.CDSS_URL);
  url.searchParams.set('ref_id', String(100000 + Math.floor(Math.random() * 900000)));
  if (patient.gender) url.searchParams.set('gendercode', patient.gender === 'male' ? '1' : '2');
  if (patient.dob) url.searchParams.set('dob', patient.dob);
  return url.toString();
}

/** Reads the result pop-up ("OPD Recommended" and "Specialities" lists). */
function parseResult(pageText) {
  const text = pageText.slice(pageText.lastIndexOf('AI Recommended'));
  const section = (start, end) => {
    const from = text.indexOf(start);
    if (from < 0) return [];
    const to = end ? text.indexOf(end, from) : -1;
    return text.slice(from + start.length, to < 0 ? undefined : to)
      .split('\n').map((line) => line.replace(/^\s*\d+\.\s*/, '').trim()).filter(Boolean);
  };
  return {
    opdRecommended: section('OPD Recommended:', 'Specialities:'),
    specialities: section('Specialities:'),
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {string} options.symptom        symptom to search and select
 * @param {string} options.screenshot     where to save the final screenshot
 * @param {object} [options.patient]      override patient gender / dob
 * @param {Function} [options.onAssociated] ({ options, count }) => name | name[] | null
 *        called at every "Do you have any other associated problems?" question
 * @returns {Promise<{status: 'COMPLETED'|'NOT_FOUND'|'ERROR', specialities: string[], added: string[], answers: string[], apiErrors: string[], reason?: string, searchOptions?: string[]}>}
 */
async function runConsultation(page, { symptom, screenshot, patient, onAssociated }) {
  const run = { status: 'ERROR', specialities: [], opdRecommended: [], added: [], answers: [], apiErrors: [] };
  let currentQuestion = null;
  let formComplete = false;
  let associatedCount = 0;

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    if (response.status() >= 400) run.apiErrors.push(`${response.status()} ${url.split('/api/')[1].split('?')[0]}`);
    if (!url.includes('/api/fetch') || !response.ok()) return;
    const body = await response.json().catch(() => null);
    if (body?.resp_status === 'Form is complete') formComplete = true;
    else if (body) currentQuestion = body;
  });

  const inputArea = page.locator('.userInput');
  const chips = inputArea.locator('.chips');
  const nextQuestion = () => page.waitForResponse((r) => r.url().includes('/api/fetch'), { timeout: 30_000 }).catch(() => null);

  const clickChip = async (label) => {
    const labels = (await chips.allInnerTexts()).map((t) => t.trim());
    const index = labels.findIndex((l) => norm(l) === norm(label));
    if (index < 0) return false;
    await chips.nth(index).click();
    await page.waitForTimeout(400);
    // dermatology location questions open an optional photo upload - close it
    const closeUpload = page.locator('.filesUploadModel_cancel');
    if (await closeUpload.isVisible().catch(() => false)) await closeUpload.click();
    return true;
  };
  const clickSave = async () => {
    const button = inputArea.locator(':scope > .actionBtn, :scope > div > .actionBtn').last();
    if (!(await button.count()) || (await button.getAttribute('class')).includes('disable')) return false;
    await button.click();
    return true;
  };

  try {
    await page.goto(appUrl(patient), { waitUntil: 'networkidle' });

    // 1. search and select the symptom
    await page.locator('.searchText_input').fill(symptom);
    await page.waitForTimeout(1500);
    const searchOptions = (await page.locator('.multiSelectOpt .chips').allInnerTexts()).map((t) => t.trim());
    const match = searchOptions.find((option) => norm(option) === norm(symptom));
    if (!match) return Object.assign(run, { status: 'NOT_FOUND', searchOptions });
    await clickChip(match);
    let answered = nextQuestion();
    await page.locator('.userInput .actionBtn').click();
    await answered;

    // 2. answer questions until the result screen appears
    const startedAt = Date.now();
    let firstServerErrorAt = 0;
    let idleSteps = 0;
    while (!formComplete) {
      await page.waitForTimeout(700);
      if (formComplete || (await page.getByText('Specialities:').count())) break;
      const question = (await page.locator('.chatBlock_left .textBox').last().innerText().catch(() => '')).trim();

      if (run.apiErrors.some(isServerError)) {
        firstServerErrorAt ||= Date.now();
        if (Date.now() - firstServerErrorAt > SERVER_ERROR_WAIT_MS) { run.reason = `Backend HTTP 5xx at: ${question || '(no question)'}`; break; }
      }
      if (Date.now() - startedAt > ATTEMPT_LIMIT_MS) { run.reason = `No result after ${ATTEMPT_LIMIT_MS / 1000}s, at: ${question}`; break; }

      const labels = (await chips.allInnerTexts()).map((t) => t.trim());
      const realOptions = labels.filter((l) => !/^(add to the list|other|not applicable)$/i.test(l));
      const isAssociatedQuestion = currentQuestion && (currentQuestion.quesTag === 'Associated Symptoms' || String(currentQuestion.associated_flag) === 'True');
      const toAdd = isAssociatedQuestion && onAssociated && labels.length
        ? [].concat(onAssociated({ options: realOptions, count: associatedCount++ }) || [])
        : [];
      const textField = inputArea.locator('input:not(.searchText_input), textarea');

      answered = nextQuestion();
      if (toAdd.length) {
        for (const name of toAdd) await clickChip(name);
        run.added.push(...toAdd);
        run.answers.push(`${question} => ${toAdd.join(' + ')} (added)`);
        await clickSave();
      } else if (labels.length) {
        const answer = labels.find((l) => /^not applicable$/i.test(l)) || realOptions[0] || labels[0];
        await clickChip(answer);
        run.answers.push(`${question} => ${answer}`);
        await clickSave();
      } else if (await textField.count()) {
        const value = typedAnswer(question);
        await textField.first().fill(value);
        run.answers.push(`${question} => ${value}`);
        if (!(await clickSave())) await textField.first().press('Enter');
      } else {
        if (++idleSteps >= 8) { run.reason = `Nothing to answer at: ${question}`; break; }
        continue;
      }
      idleSteps = 0;
      await answered;
    }

    // 3. read the result
    await page.getByText('Specialities:').waitFor({ timeout: 15_000 }).catch(() => {});
    const pageText = await page.innerText('body');
    if (/Specialities:/.test(pageText)) Object.assign(run, parseResult(pageText), { status: 'COMPLETED' });
    return run;
  } catch (error) {
    run.reason = String(error.message || error).split('\n')[0];
    return run;
  } finally {
    if (screenshot) await page.screenshot({ path: screenshot, timeout: 15_000 }).catch(() => {});
  }
}

module.exports = { runConsultation, norm };
