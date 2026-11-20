// Runs after the tests (Playwright globalTeardown): writes results/<suite>-<date>/report.xlsx
// with a Summary sheet and one row per test, compared with the previous run of the same suite.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { RESULTS_DIR, RUN_DATE, readRecords, appSpecialities } = require('./helpers');

const SUITES = { single: 'Single symptom', double: 'Two symptoms', triple: 'Three symptoms' };
const COLORS = { PASS: 'C6EFCE', 'PASS (partial)': 'E2EFDA', FAIL: 'FFC7CE', 'NOT FOUND': 'FFEB9C', ERROR: 'F4B183', SKIPPED: 'D9D9D9' };

function previousRun(suite) {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const earlier = fs.readdirSync(RESULTS_DIR).filter((d) => d.startsWith(`${suite}-`) && d < `${suite}-${RUN_DATE}`).sort();
  return earlier.length ? earlier[earlier.length - 1] : null;
}

const expectedText = (record) => record.suite === 'single'
  ? `${record.expected[0].primary} / ${record.expected[0].secondary}`
  : record.expected.map((e) => `${e.symptom}: ${e.primary ?? 'not in sheet'}`).join('\n');

async function writeReport(suite) {
  const dir = path.join(RESULTS_DIR, `${suite}-${RUN_DATE}`);
  const records = readRecords(dir).sort((a, b) => a.index - b.index);
  if (!records.length) return null;

  const previousDir = previousRun(suite);
  const previous = new Map(previousDir ? readRecords(path.join(RESULTS_DIR, previousDir)).map((r) => [r.index, r.result]) : []);
  const counts = {};
  for (const r of records) counts[r.result] = (counts[r.result] || 0) + 1;
  const ran = records.length - (counts.SKIPPED || 0);
  const passed = (counts.PASS || 0) + (counts['PASS (partial)'] || 0);
  const changed = records.filter((r) => previous.has(r.index) && previous.get(r.index) !== r.result);

  const book = new ExcelJS.Workbook();
  const summary = book.addWorksheet('Summary');
  summary.columns = [{ width: 45 }, { width: 40 }];
  summary.addRow([`OPD Recommendation – ${SUITES[suite]} (${RUN_DATE})`]).font = { bold: true, size: 14 };
  summary.addRow([]);
  summary.addRow(['Tests', records.length]);
  for (const result of Object.keys(COLORS)) if (counts[result]) summary.addRow([result, counts[result]]);
  summary.addRow(['Pass rate (excluding skipped)', ran ? `${((passed / ran) * 100).toFixed(1)}%` : '-']);
  summary.addRow([]);
  summary.addRow(['Previous run', previousDir || 'none']);
  if (previousDir) {
    summary.addRow(['Results changed since previous run', changed.length]);
    for (const r of changed) summary.addRow([`  #${r.index} ${r.symptoms.join(' + ')}`, `${previous.get(r.index)} -> ${r.result}`]);
  }
  summary.addRow([]);
  summary.addRow(['PASS = expected primary (and, for single symptoms, secondary) speciality from the sheet is in the app result.']);
  summary.addRow(['Internal Medicine is accepted for General Medicine; Pediatrics is ignored.']);

  const sheet = book.addWorksheet('Results');
  sheet.columns = [
    { header: '#', key: 'index', width: 6 },
    { header: 'Symptoms', key: 'symptoms', width: 40 },
    { header: 'Expected (sheet)', key: 'expected', width: 40 },
    { header: 'App specialities', key: 'app', width: 45 },
    { header: 'Result', key: 'result', width: 15 },
    { header: 'Notes', key: 'notes', width: 60 },
    { header: 'Previous', key: 'previous', width: 15 },
    { header: 'Answers given', key: 'answers', width: 80 },
    { header: 'Screenshot', key: 'screenshot', width: 30 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
  for (const r of records) {
    const row = sheet.addRow({
      index: r.index,
      symptoms: r.symptoms.join(' + '),
      expected: expectedText(r),
      app: appSpecialities(r).join(', '),
      result: r.result,
      notes: (r.notes || []).join('\n'),
      previous: previous.get(r.index) || '',
      answers: (r.answers || []).join('\n'),
      screenshot: r.screenshot ? { text: path.basename(r.screenshot), hyperlink: r.screenshot } : '',
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('result').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${COLORS[r.result] || 'FFFFFF'}` } };
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:I1';

  const file = path.join(dir, 'report.xlsx');
  await book.xlsx.writeFile(file);
  return file;
}

module.exports = async () => {
  for (const suite of Object.keys(SUITES)) {
    const file = await writeReport(suite);
    if (file) console.log(`Excel report: ${path.relative(process.cwd(), file)}`);
  }
};
