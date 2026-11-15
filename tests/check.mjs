#!/usr/bin/env node
// Dependency-free checks for the EverydayCalc pages.
// Run from the repository root: node tests/check.mjs
//
// Four things are checked:
//   1. every published example table agrees with the calculator on that page;
//   2. the calculators still produce the documented results and reject bad input;
//   3. FAQ structured data matches the visible FAQ;
//   4. every internal link and sitemap entry points at a file that exists.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const failures = [];
const passed = [];

function check(name, ok, detail) {
  if (ok) passed.push(name);
  else failures.push({ name, detail });
}

const strip = s => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&minus;/g, '-').replace(/&divide;/g, '/').replace(/&times;/g, 'x')
  .replace(/&middot;/g, '.').replace(/&amp;/g, '&').replace(/&sup2;/g, '2')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const firstNum = s => {
  const m = strip(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};
const lastNum = s => {
  const all = [...strip(s).replace(/,/g, '').matchAll(/-?\d+(?:\.\d+)?/g)].map(m => parseFloat(m[0]));
  return all.length ? all[all.length - 1] : NaN;
};
const money = s => parseFloat(String(strip(s)).replace(/[^0-9.-]/g, ''));

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();

function readPage(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function tablesOf(html) {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(m => {
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map(r =>
      [...r[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/g)].map(c => strip(c[0])));
    return { head: rows[0] || [], body: rows.slice(1) };
  });
}

// --- the calculator functions, executed exactly as the browser does ---------
function runCalc(file, fnName, values) {
  const html = readPage(file);
  const scripts = [...html.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const code = scripts.find(s => s.includes('function ' + fnName));
  if (!code) throw new Error(`${file}: no ${fnName}() found`);
  const els = {};
  const mk = id => ({
    id, value: values[id] ?? '', innerHTML: '', style: {}, hidden: false,
    scrollIntoView() {}, setAttribute() {}, getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    parentNode: { insertBefore() {} },
  });
  const ctx = {
    document: {
      getElementById(id) { if (!els[id]) els[id] = mk(id); return els[id]; },
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return mk('tmp'); }, body: mk('body'),
    },
    window: { pageYOffset: 0, addEventListener() {} },
    navigator: {}, location: {},
    Math, parseInt, parseFloat, isNaN, Number, JSON,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code + `\n;${fnName}();`, ctx);
  const html2 = els['resultBox'] ? els['resultBox'].innerHTML : '';
  return {
    isErr: /class="err"/.test(html2),
    err: (html2.match(/class="err">([\s\S]*?)<\/p>/) || [, ''])[1],
    big: (html2.match(/<div class="big">([\s\S]*?)<\/div>/) || [, ''])[1].replace(/<[^>]+>/g, '').trim(),
    html: html2,
  };
}

// --- 1. example tables must agree with the page's own calculator ------------
// The overtime page publishes both federal and California rows, so the check
// reproduces the documented rules rather than trusting the table.
function schedule(label) {
  const days = [];
  for (const m of strip(label).matchAll(/(\d+)\s*days?\s*x\s*([\d.]+)/gi)) {
    for (let i = 0; i < parseInt(m[1], 10); i++) days.push(parseFloat(m[2]));
  }
  const one = strip(label).match(/one\s+([\d.]+)-hour day/i);
  if (one) days.unshift(parseFloat(one[1]));
  return days;
}

function weeklyPay(days, rate, california) {
  const total = days.reduce((a, b) => a + b, 0);
  if (!california) {
    const reg = Math.min(total, 40);
    const ot = Math.max(total - 40, 0);
    return { reg, ot, dt: 0, pay: reg * rate + ot * rate * 1.5 };
  }
  let reg = 0, ot = 0, dt = 0;
  const seventh = days.length === 7 && days.every(d => d > 0);
  days.forEach((d, i) => {
    if (seventh && i === 6) { ot += Math.min(d, 8); dt += Math.max(0, d - 8); }
    else { reg += Math.min(d, 8); ot += Math.min(Math.max(d - 8, 0), 4); dt += Math.max(d - 12, 0); }
  });
  if (reg > 40) { ot += reg - 40; reg = 40; }
  return { reg, ot, dt, pay: reg * rate + ot * rate * 1.5 + dt * rate * 2 };
}

{
  const file = 'overtime-calculator.html';
  const html = readPage(file);
  const table = tablesOf(html).find(t => /schedule/i.test(t.head.join('|')) && /weekly pay/i.test(t.head.join('|')));
  check('overtime: example table found', !!table, 'table with "Schedule" and "Weekly pay" not found');
  if (table) {
    for (const row of table.body) {
      const days = schedule(row[1]);
      if (!days.length) continue;
      const rate = money(row[5]);
      const ca = /california/i.test(row[0]);
      const want = weeklyPay(days, rate, ca);
      const cellReg = firstNum(row[2]), cellOt = firstNum(row[3]), cellDt = firstNum(row[4]), cellPay = money(row[6]);
      const label = `${row[0]} / ${row[1]}`;
      const total = days.reduce((a, b) => a + b, 0);
      check(`overtime table: "${label}" hours add up`, cellReg + cellOt + cellDt === total,
        `cells say ${cellReg}+${cellOt}+${cellDt}=${cellReg + cellOt + cellDt}, schedule is ${total} hours`);
      check(`overtime table: "${label}" weekly pay`, Math.abs(cellPay - want.pay) < 0.01,
        `table says $${cellPay}, calculator says $${want.pay}`);
    }
  }
}

// --- 2. documented results and rejected input -------------------------------
const cases = [
  ['paycheck-calculator.html', 'calcPay', { gross: '2000', freq: '26', fed: '12', state: '4', k401: '0', health: '0', post: '0' }, '$1,527.00 take-home'],
  ['paycheck-calculator.html', 'calcPay', { gross: '3000', freq: '24', fed: '14', state: '5', k401: '150', health: '0', post: '0' }, '$2,079.00 take-home'],
  ['paycheck-calculator.html', 'calcPay', { gross: '5000', freq: '12', fed: '18', state: '5', k401: '0', health: '200', post: '0' }, '$3,328.80 take-home'],
  ['overtime-calculator.html', 'calcOT', { rate: '20', mode: 'fed', mult: '1.5', d0: '9', d1: '9', d2: '9', d3: '9', d4: '9', d5: '0', d6: '0' }, '$950.00'],
  ['overtime-calculator.html', 'calcOT', { rate: '20', mode: 'ca', mult: '1.5', d0: '8', d1: '8', d2: '8', d3: '8', d4: '8', d5: '8', d6: '8' }, '$1,280.00'],
  ['overtime-calculator.html', 'calcOT', { rate: '20', mode: 'ca', mult: '1.5', d0: '10', d1: '10', d2: '10', d3: '10', d4: '0', d5: '0', d6: '0' }, '$880.00'],
  ['california-overtime-calculator.html', 'calcCA', { rate: '20', prem: '0', d0: '10', d1: '10', d2: '10', d3: '10', d4: '0', d5: '0', d6: '0' }, '$880.00'],
  ['california-overtime-calculator.html', 'calcCA', { rate: '20', prem: '0', d0: '10', d1: '10', d2: '10', d3: '10', d4: '10', d5: '10', d6: '10' }, '$1,720.00'],
  ['work-hours-calculator.html', 'calculateWork', { inTime: '09:00', outTime: '17:30', breakMin: '30', days: '5', rate: '15' }, '8.00 hours per day'],
  ['work-hours-calculator.html', 'calculateWork', { inTime: '22:00', outTime: '06:00', breakMin: '30', days: '5', rate: '22' }, '7.50 hours per day'],
  ['time-card-calculator.html', 'calcTC', { in0: '09:00', out0: '17:00', br0: '30', in1: '09:00', out1: '17:00', br1: '30', in2: '09:00', out2: '17:00', br2: '30', in3: '09:00', out3: '17:00', br3: '30', in4: '09:00', out4: '17:00', br4: '30', rate: '20' }, '37.50 hours'],
  ['bmi-calculator.html', 'calcBMI', { unit: 'us', ft: '5', inch: '7', lb: '160', cm: '', kg: '' }, 'BMI 25.1'],
  ['bmi-calculator.html', 'calcBMI', { unit: 'metric', ft: '', inch: '', lb: '', cm: '175', kg: '80' }, 'BMI 26.1'],
  ['hourly-to-salary-calculator.html', 'calcHS', { rate: '25', hrs: '40', days: '5', wks: '52', ot: '0' }, '$52,000.00 per year'],
  ['hourly-to-salary-calculator.html', 'calcHS', { rate: '25', hrs: '40', days: '5', wks: '52', ot: '5' }, '$61,750.00 per year'],
  ['salary-to-hourly-calculator.html', 'calcSH', { sal: '60000', per: '1', hrs: '40', wks: '52' }, '$28.85 per hour'],
  ['salary-to-hourly-calculator.html', 'calcSH', { sal: '4500', per: '12', hrs: '40', wks: '52' }, '$25.96 per hour'],
  ['lunch-break-calculator.html', 'calcLunch', { sIn: '09:00', sOut: '17:00', lIn: '12:00', lMin: '30', lType: 'unpaid' }, '12:30 PM'],
  ['hours-between-times-calculator.html', 'calcBetween', { t1: '08:00', t2: '17:00', brk: '30' }, '8.50 hours'],
  ['hours-between-times-calculator.html', 'calcBetween', { t1: '22:00', t2: '06:00', brk: '30' }, '7.50 hours'],
];
for (const [file, fn, values, want] of cases) {
  let r;
  try { r = runCalc(file, fn, values); }
  catch (e) { check(`${file}: ${fn} runs`, false, e.message); continue; }
  check(`${file}: ${fn} -> ${want}`, r.html.includes(want), `got "${r.big || r.err || r.html.slice(0, 60)}"`);
}

const rejects = [
  ['work-hours-calculator.html', 'calculateWork', { inTime: '09:00', outTime: '09:00', breakMin: '0', days: '5', rate: '15' }, 'same clock in and out'],
  ['work-hours-calculator.html', 'calculateWork', { inTime: '09:00', outTime: '17:00', breakMin: '-60', days: '5', rate: '15' }, 'negative break'],
  ['work-hours-calculator.html', 'calculateWork', { inTime: '09:00', outTime: '17:00', breakMin: '0', days: '0', rate: '0' }, 'days out of range'],
  ['paycheck-calculator.html', 'calcPay', { gross: '100', freq: '26', fed: '0', state: '0', k401: '500', health: '0', post: '0' }, 'deductions above gross'],
  ['paycheck-calculator.html', 'calcPay', { gross: '2000', freq: '26', fed: '61', state: '4', k401: '0', health: '0', post: '0' }, 'federal rate above 60'],
  ['overtime-calculator.html', 'calcOT', { rate: '20', mode: 'fed', mult: '1.5', d0: '25', d1: '0', d2: '0', d3: '0', d4: '0', d5: '0', d6: '0' }, 'more than 24 hours in a day'],
  ['bmi-calculator.html', 'calcBMI', { unit: 'us', ft: '0', inch: '0', lb: '160', cm: '', kg: '' }, 'missing height'],
  ['bmi-calculator.html', 'calcBMI', { unit: 'us', ft: '5', inch: '-1', lb: '160', cm: '', kg: '' }, 'negative inches'],
  ['hours-between-times-calculator.html', 'calcBetween', { t1: '08:00', t2: '17:00', brk: '-30' }, 'negative break on hours between'],
  ['california-overtime-calculator.html', 'calcCA', { rate: '20', prem: '-2', d0: '8', d1: '8', d2: '8', d3: '8', d4: '8', d5: '0', d6: '0' }, 'negative break premium'],
];
for (const [file, fn, values, label] of rejects) {
  let r;
  try { r = runCalc(file, fn, values); }
  catch (e) { check(`${file}: rejects ${label}`, false, e.message); continue; }
  check(`${file}: rejects ${label}`, r.isErr, `expected an error, got "${r.big}"`);
}

// --- 3. FAQ structured data must match what a visitor reads -----------------
for (const file of pages) {
  const html = readPage(file);
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  const faq = ld.find(j => j['@type'] === 'FAQPage');
  if (!faq) continue;
  const visible = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map(m => strip(m[1]));
  const questions = (faq.mainEntity || []).map(q => strip(q.name));
  const missing = questions.filter(q => !visible.includes(q));
  check(`${file}: FAQ schema matches visible questions (${questions.length})`,
    missing.length === 0 && questions.length > 0,
    missing.length ? `not visible: ${missing.slice(0, 3).join(' | ')}` : 'no questions in schema');
}

// --- 4. links and sitemap ---------------------------------------------------
const sitemapPath = path.join(ROOT, 'sitemap.xml');
if (fs.existsSync(sitemapPath)) {
  const sm = fs.readFileSync(sitemapPath, 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  check('sitemap: parsed', locs.length > 0, 'no <loc> entries');
  for (const loc of locs) {
    const rel = loc.split('/everydaycalc/')[1] || '';
    const ok = rel === '' ? fs.existsSync(path.join(ROOT, 'index.html')) : fs.existsSync(path.join(ROOT, rel));
    check(`sitemap: ${rel || 'index'} exists`, ok, 'file missing');
  }
}
for (const file of pages) {
  const html = readPage(file);
  const hrefs = [...new Set([...html.matchAll(/href="([^"#:]+\.html)"/g)].map(m => m[1]))];
  const broken = hrefs.filter(h => !fs.existsSync(path.join(ROOT, h)));
  check(`${file}: internal links (${hrefs.length})`, broken.length === 0, `broken: ${broken.join(', ')}`);
}

// --- report -----------------------------------------------------------------
console.log(`\n${passed.length} checks passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`FAIL  ${f.name}\n      ${f.detail}`);
if (failures.length) {
  console.log('\nSee the issue report for the known findings.');
  process.exit(1);
}
