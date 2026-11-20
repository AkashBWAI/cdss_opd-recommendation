// One symptom per test: the app's 1st / 2nd speciality must match the sheet's Primary / Secondary.
const { test, expect } = require('@playwright/test');
const h = require('../src/helpers');

for (const s of h.symptoms) {
  const tag = h.norm(s.primary) === 'dermatology' ? ['@derma'] : [];

  test(`#${s.index} ${s.symptom}`, { tag }, async ({ page }, testInfo) => {
    const base = { suite: 'single', index: s.index, symptoms: [s.symptom] };
    h.skipKnownBug(test, base);

    const screenshot = h.screenshotPath('single', s.index, s.symptom);
    const run = await h.runWithRetry(page, () => ({ symptom: s.symptom, patient: s.patient, screenshot }));
    const record = h.saveRecord(base, run, screenshot);
    await h.report(testInfo, record, screenshot);

    expect(record.result, record.notes.join('\n')).toBe('PASS');
  });
}
