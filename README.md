# CDSS OPD Recommendation Tests

Playwright tests that check the CDSS demo app recommends the right OPD specialities for each symptom,
based on the validated OPD recommendation sheet (internal data, see Setup).

| Test file | Tests | Checks |
|---|---|---|
| `tests/single.spec.js` | 330 – one per symptom | App's 1st / 2nd speciality = sheet Primary / Secondary |
| `tests/double.spec.js` | 50 – symptom A + one associated symptom B | A's and B's expected primary specialities are in the result |
| `tests/triple.spec.js` | 10 – symptom A + associated symptoms B and C | All three expected primary specialities are in the result |

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then put the demo URL (with token) in CDSS_URL
```

**Internal data (not in this repo):** copy `symptoms.json` (and optionally the source sheet
`opd-recommendation.xlsx`) into `data/` – ask the team for them. `symptoms.json` is a list of:

```json
{ "symptom": "Swelling", "primary": "General Medicine", "secondary": "Surgery" }
```

with an optional `"patient": { "gender": "male", "dob": "15-06-2013" }` for symptoms the app only shows to some patients.

## Run

```bash
npm test               # everything
npm run test:single    # single symptom
npm run test:double    # two symptoms
npm run test:triple    # three symptoms
npx playwright test -g "#30 "              # one test by number
npx playwright test --grep-invert @derma   # skip dermatology symptoms
npm run report         # open the HTML report
```

## Results

- `playwright-report/` – HTML report with a screenshot of every result screen
- `results/<suite>-<date>/report.xlsx` – Excel report (summary + one row per test, compared with the previous run)
- `results/<suite>-<date>/screenshots/` and `records/` – raw data behind the report

Result values: **PASS**, **PASS (partial)** (fewer associated symptoms could be added than wanted),
**FAIL** (speciality mismatch), **NOT FOUND** (symptom name not in the app), **ERROR** (app did not finish),
**SKIPPED** (known bug).

## How it works

```
data/       test data – symptoms.json (from the sheet), double.json, triple.json, known-bugs.json
src/
  flow.js     drives one consultation in the app
  helpers.js  scoring, retries, picking associated symptoms, result files
  report.js   builds the Excel report after the run
tests/      the three test files
```

For every test the app is opened with a fresh `ref_id`. Each question is answered with **"Not applicable"** if
offered, otherwise the first option; typed questions get realistic values (temperature 101, BP 120/80, …).
Dermatology photo uploads are skipped. Associated symptoms are added at *"Do you have any other associated
problems?"* – the one listed in `data/double.json` / `triple.json` if the app offers it, otherwise one that passed
on its own.

Scoring: Pediatrics is ignored and Internal Medicine is accepted for General Medicine.
Symptoms the app only shows for some patients have a `patient` override in `data/symptoms.json`
(e.g. `{"gender": "male", "dob": "15-06-2013"}`).

If the app gets stuck, the test retries up to 3 times on a new page. A backend HTTP 5xx is an app bug: the test
fails after ~1 minute without retrying.

## Known app bugs

Listed in `data/known-bugs.json` and skipped by default (`RUN_KNOWN_BUGS=1` to run them):

- **Problem With Gums** – backend HTTP 500 after the first question
- **Decreased Or No Urine + any associated symptom** – backend HTTP 500 at the end of the flow

## Settings (.env)

| Variable | Default | |
|---|---|---|
| `CDSS_URL` | – | Demo URL incl. token (`lang=1` = English). **Never commit it.** |
| `WORKERS` | 4 | Parallel browsers |
| `RUN_KNOWN_BUGS` | – | `1` = also run known-bug tests |
| `ATTEMPT_LIMIT_SEC` | 150 | Max seconds per consultation attempt |
| `RUN_DATE` | today | Date used in the results folder name |
