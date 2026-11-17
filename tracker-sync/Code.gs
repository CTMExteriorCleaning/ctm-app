/**
 * CTM lead tracker: fills in bookings from the CTM app.
 *
 * Paste this into the Google Sheet under Extensions → Apps Script.
 * Every hour it reads the jobs booked in the app's calendar and, for each lead
 * row it can match, fills in Booked? = Yes, Job value (£) and Job date.
 *
 * It only ever writes into EMPTY cells, so anything you've typed stays as it is.
 * Leads are matched by phone number first, then by exact name.
 * Each filled cell gets a small note saying it came from the app.
 */

// Paste the key from the Supabase SQL Editor between the quotes.
const TRACKER_KEY = 'PASTE_YOUR_KEY_HERE';

// Your app's Supabase project (the same public details as the app's config.js).
const SUPABASE_URL = 'https://srrbokvjpehqexffkbwq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CRn9SGaTDK-0vuO0K-uCRw_pIW6rCrz';

// Which tabs to fill in, and where the lead rows start.
const TABS = ['Gutters'];
const FIRST_ROW = 13;
const COL = { date: 1, name: 2, phone: 3, booked: 9, value: 10, jobDate: 11 }; // A, B, C, I, J, K

/** Adds a "Lead tracker" menu so you can run it by hand. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Lead tracker')
    .addItem('Update bookings from the app now', 'syncBookingsNow')
    .addItem('Turn on hourly updates', 'setUpHourlySync')
    .addToUi();
}

/** Run once: checks every hour from now on. */
function setUpHourlySync() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncBookings')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncBookings').timeBased().everyHours(1).create();
  syncBookingsNow();
}

function syncBookingsNow() {
  const n = syncBookings();
  SpreadsheetApp.getActive().toast(n ? `Filled in ${n} booking${n === 1 ? '' : 's'} from the app.` : 'Up to date. No new bookings to fill in.', 'Lead tracker', 6);
}

/** Reads the booked jobs from the app. */
function fetchJobs() {
  if (!TRACKER_KEY || TRACKER_KEY.indexOf('PASTE') === 0) throw new Error('Paste your tracker key into TRACKER_KEY at the top of the script.');
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/tracker_feed', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    payload: JSON.stringify({ feed_key: TRACKER_KEY }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('The app replied ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText()) || [];
}

const digits = s => String(s || '').replace(/\D/g, '').replace(/^44/, '0');
const nameKey = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isBlank = v => v === '' || v === null || v === undefined;
const ymd = d => Utilities.formatDate(d, 'Europe/London', 'yyyy-MM-dd');
const toDate = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };

/**
 * Picks the job that belongs to a lead: the first job for that customer on or after
 * the date they enquired (an older job is a past clean, not this lead's booking).
 */
function jobForLead(jobs, leadDate) {
  const from = leadDate instanceof Date ? ymd(leadDate) : '';
  return jobs.filter(j => j.date && (!from || j.date >= from)).sort((a, b) => a.date.localeCompare(b.date))[0];
}

/** Fills the empty Booked?, Job value and Job date cells. Returns how many leads were updated. */
function syncBookings() {
  const jobs = fetchJobs();
  const byPhone = {}, byName = {}, customersByName = {};
  jobs.forEach(j => {
    const p = digits(j.phone);
    if (p.length > 6) (byPhone[p] = byPhone[p] || []).push(j);
    const n = nameKey(j.name);
    if (n) { (byName[n] = byName[n] || []).push(j); (customersByName[n] = customersByName[n] || {})[j.customerId] = true; }
  });

  const stamp = 'Filled in from the CTM app on ' + Utilities.formatDate(new Date(), 'Europe/London', 'd MMM yyyy');
  let updated = 0;
  TABS.forEach(tab => {
    const sh = SpreadsheetApp.getActive().getSheetByName(tab);
    if (!sh || sh.getLastRow() < FIRST_ROW) return;
    const rows = sh.getRange(FIRST_ROW, 1, sh.getLastRow() - FIRST_ROW + 1, COL.jobDate).getValues();
    rows.forEach((r, i) => {
      if (isBlank(r[COL.name - 1]) && isBlank(r[COL.phone - 1])) return;
      // You marked this lead "No" yourself: leave the whole row alone.
      if (!isBlank(r[COL.booked - 1]) && String(r[COL.booked - 1]).trim().toLowerCase() !== 'yes') return;
      const needs = isBlank(r[COL.booked - 1]) || isBlank(r[COL.value - 1]) || isBlank(r[COL.jobDate - 1]);
      if (!needs) return;

      // Phone first; then name, but only if exactly one customer in the app has that name.
      const p = digits(r[COL.phone - 1]), n = nameKey(r[COL.name - 1]);
      let list = p.length > 6 ? byPhone[p] : null;
      if (!list && n && customersByName[n] && Object.keys(customersByName[n]).length === 1) list = byName[n];
      const job = list && jobForLead(list, r[COL.date - 1]);
      if (!job) return;

      const row = FIRST_ROW + i;
      const fill = (col, value) => {
        if (!isBlank(r[col - 1]) || isBlank(value)) return false;
        sh.getRange(row, col).setValue(value).setNote(stamp);
        return true;
      };
      const price = Number(job.price);
      const a = fill(COL.booked, 'Yes');
      const b = fill(COL.value, price > 0 ? price : '');
      const c = fill(COL.jobDate, toDate(job.date));
      if (a || b || c) updated++;
    });
  });
  return updated;
}
