// Three symptoms: A is selected, B is added at the 1st and C at the 2nd "other associated problems?" question.
// If the app asks that question only once, the test runs again selecting B and C together (multi-select).
// Every expected primary speciality must appear in the app result.
const { test, expect } = require('@playwright/test');
const h = require('../src/helpers');

const sets = h.loadData('triple.json');
const passed = h.passedSymptoms();

sets.forEach((set, i) => {
  const index = i + 1;

  test(`#${index} ${set.a} + ${set.b || '?'} + ${set.c || '?'}`, async ({ page }, testInfo) => {
    const base = { suite: 'triple', index, symptoms: [set.a] };
    h.skipKnownBug(test, base);

    const screenshot = h.screenshotPath('triple', index, set.a);
    const common = { symptom: set.a, patient: h.patientFor(set.a), screenshot };

    const oneByOne = () => {
      const used = [set.a];
      return {
        ...common,
        onAssociated: ({ options, count }) =>
          count < 2 ? h.pickAssociated(options, { preferred: count === 0 ? set.b : set.c, used, passed }) : null,
      };
    };
    const together = () => {
      const used = [set.a];
      return {
        ...common,
        onAssociated: ({ options, count }) => (count === 0
          ? [h.pickAssociated(options, { preferred: set.b, used, passed }), h.pickAssociated(options, { preferred: set.c, used, passed })].filter(Boolean)
          : null),
      };
    };

    let run = { ...(await h.runWithRetry(page, oneByOne)), mode: 'one by one' };
    if (run.status === 'COMPLETED' && run.added.length < 2) {
      run = { ...(await h.runWithRetry(await page.context().newPage(), together)), mode: 'together' };
    }
    const record = h.saveRecord(base, run, screenshot);
    await h.report(testInfo, record, screenshot);

    expect(record.result, record.notes.join('\n')).toBe('PASS');
  });
});
