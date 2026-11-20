// Two symptoms: A is selected, B is added at "Do you have any other associated problems?".
// B = the one listed in data/double.json if the app offers it, else an offered symptom that passed on its own.
// Both expected primary specialities must appear in the app result.
const { test, expect } = require('@playwright/test');
const h = require('../src/helpers');

const pairs = h.loadData('double.json');
const passed = h.passedSymptoms();

pairs.forEach((pair, i) => {
  const index = i + 1;

  test(`#${index} ${pair.a} + ${pair.b || 'associated symptom'}`, async ({ page }, testInfo) => {
    const base = { suite: 'double', index, symptoms: [pair.a] };
    h.skipKnownBug(test, base);

    const screenshot = h.screenshotPath('double', index, pair.a);
    const run = await h.runWithRetry(page, () => {
      const used = [pair.a];
      return {
        symptom: pair.a,
        patient: h.patientFor(pair.a),
        screenshot,
        onAssociated: ({ options, count }) => (count === 0 ? h.pickAssociated(options, { preferred: pair.b, used, passed }) : null),
      };
    });
    const record = h.saveRecord(base, run, screenshot);
    await h.report(testInfo, record, screenshot);

    expect(record.result, record.notes.join('\n')).toMatch(/^PASS/);
  });
});
