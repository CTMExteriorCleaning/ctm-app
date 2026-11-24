/**
 * CTM lead tracker: keeps the Google Sheet up to date from the CTM app.
 *
 * Paste this into the Google Sheet under Extensions → Apps Script.
 * Every hour it:
 *  1. adds new Facebook/Instagram ad leads from the app as new rows on the Gutters tab, and
 *  2. for each lead with a job in the app's calendar, fills in Booked? = Yes, Job value (£) and Job date.
 *
 * It only writes into EMPTY cells, so anything you've typed stays as it is.
 * Leads are matched by phone number first, then by exact name.
 * Each cell it fills gets a small note saying it came from the app, and cell A5
 * shows when it last checked.
 */

// Paste the key from the Supabase SQL Editor between the quotes.
const TRACKER_KEY = 'PASTE_YOUR_KEY_HERE';

// Your app's Supabase project (the same public details as the app's config.js).
const SUPABASE_URL = 'https://srrbokvjpehqexffkbwq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CRn9SGaTDK-0vuO0K-uCRw_pIW6rCrz';

// Which tab gets new leads and bookings, and where the lead rows start and end.
const TABS = ['Gutters'];
const LEADS_TAB = 'Gutters';
const FIRST_ROW = 13;
const LAST_ROW = 512; // the totals at the top count rows 13 to 512
const STATUS_CELL = 'A5';
// Only ad leads from this date on are added (older ones were added by hand).
const ADD_LEADS_FROM = '2026-11-17';
const COL = { date: 1, name: 2, phone: 3, postcode: 4, source: 5, booked: 9, value: 10, jobDate: 11, notes: 13 };
const NOTE_PREFIX = 'Filled in from the CTM app';

/** Adds a "Lead tracker" menu so you can run it by hand. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Lead tracker')
    .addItem('Update from the app now', 'syncBookingsNow')
    .addItem('Turn on hourly updates', 'setUpHourlySync')
    .addToUi();
}

/** Run once: checks every hour from now on. Running it again is safe. */
function setUpHourlySync() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncBookings')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncBookings').timeBased().everyHours(1).create();
  syncBookingsNow();
}

function syncBookingsNow() {
  const r = syncBookings();
  SpreadsheetApp.getActive().toast(r.summary, 'Lead tracker', 8);
}

function callApp(fn) {
  if (!TRACKER_KEY || TRACKER_KEY.indexOf('PASTE') === 0) throw new Error('Paste your tracker key into TRACKER_KEY at the top of the script.');
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
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
const prettyPhone = p => { const d = digits(p); return d.length === 11 ? d.slice(0, 5) + ' ' + d.slice(5) : String(p || ''); };

/**
 * Picks the job that belongs to a lead: the first job for that customer on or after
 * the date they enquired (an older job is a past clean, not this lead's booking).
 */
function jobForLead(jobs, from) {
  return jobs.filter(j => j.date && (!from || j.date >= from)).sort((a, b) => a.date.localeCompare(b.date))[0];
}

/** An ad lead for gutters (window cleaning ads are paused, so leave those out). */
function isGutterAdLead(l) {
  return l.leadDate && l.leadDate >= ADD_LEADS_FROM && /ad$/i.test(l.source || '') && !/window/i.test(l.service || '');
}

/** Adds new ad leads from the app to the bottom of the lead list. Returns how many were added. */
function addNewLeads(sh, tz, leads) {
  const n = LAST_ROW - FIRST_ROW + 1;
  const rows = sh.getRange(FIRST_ROW, 1, n, COL.phone).getValues();
  const phones = {}, names = {};
  let last = -1;
  rows.forEach((r, i) => {
    if (isBlank(r[COL.name - 1]) && isBlank(r[COL.phone - 1]) && isBlank(r[COL.date - 1])) return;
    last = i;
    const p = digits(r[COL.phone - 1]); if (p.length > 6) phones[p] = true;
    const k = nameKey(r[COL.name - 1]); if (k) names[k] = true;
  });
  const fresh = leads.filter(isGutterAdLead).filter(l => {
    const p = digits(l.phone), k = nameKey(l.name);
    return !(p.length > 6 ? phones[p] : names[k]);
  }).sort((a, b) => a.leadDate.localeCompare(b.leadDate));

  let added = 0;
  fresh.forEach(l => {
    const row = FIRST_ROW + last + 1;
    if (row > LAST_ROW) return;
    const notes = [l.service, l.address, l.source].filter(Boolean).join('. ');
    sh.getRange(row, COL.date, 1, COL.source).setValues([[
      Utilities.parseDate(l.leadDate, tz, 'yyyy-MM-dd'), l.name || '', prettyPhone(l.phone), l.postcode || '', 'Meta ad',
    ]]);
    sh.getRange(row, COL.date).setNumberFormat('dd/mm/yyyy').setNote(NOTE_PREFIX + ' on ' + Utilities.formatDate(new Date(), tz, 'd MMM yyyy'));
    if (notes && isBlank(sh.getRange(row, COL.notes).getValue())) sh.getRange(row, COL.notes).setValue(notes);
    const p = digits(l.phone); if (p.length > 6) phones[p] = true;
    names[nameKey(l.name)] = true;
    last++; added++;
  });
  return added;
}

/** Fills the empty Booked?, Job value and Job date cells. Returns how many leads were updated. */
function fillBookings(sh, tz, jobs) {
  const byPhone = {}, byName = {}, customersByName = {};
  jobs.forEach(j => {
    const p = digits(j.phone);
    if (p.length > 6) (byPhone[p] = byPhone[p] || []).push(j);
    const n = nameKey(j.name);
    if (n) { (byName[n] = byName[n] || []).push(j); (customersByName[n] = customersByName[n] || {})[j.customerId] = true; }
  });

  const stamp = NOTE_PREFIX + ' on ' + Utilities.formatDate(new Date(), tz, 'd MMM yyyy');
  const n = sh.getLastRow() - FIRST_ROW + 1;
  if (n < 1) return 0;
  const rows = sh.getRange(FIRST_ROW, 1, n, COL.jobDate).getValues();
  const dateNotes = sh.getRange(FIRST_ROW, COL.jobDate, n, 1).getNotes();
  let updated = 0;
  rows.forEach((r, i) => {
    if (isBlank(r[COL.name - 1]) && isBlank(r[COL.phone - 1])) return;
    // You marked this lead "No" yourself: leave the whole row alone.
    if (!isBlank(r[COL.booked - 1]) && String(r[COL.booked - 1]).trim().toLowerCase() !== 'yes') return;

    // Phone first; then name, but only if exactly one customer in the app has that name.
    const p = digits(r[COL.phone - 1]), k = nameKey(r[COL.name - 1]);
    let list = p.length > 6 ? byPhone[p] : null;
    if (!list && k && customersByName[k] && Object.keys(customersByName[k]).length === 1) list = byName[k];
    const leadDate = r[COL.date - 1];
    const job = list && jobForLead(list, leadDate instanceof Date ? Utilities.formatDate(leadDate, tz, 'yyyy-MM-dd') : '');
    if (!job) return;

    const row = FIRST_ROW + i;
    const jobDate = Utilities.parseDate(job.date, tz, 'yyyy-MM-dd');
    const fill = (col, value) => {
      if (!isBlank(r[col - 1]) || isBlank(value)) return false;
      sh.getRange(row, col).setValue(value).setNote(stamp);
      return true;
    };
    // Repair job dates the first version wrote in the wrong time zone (they show a time
    // like 16:00 and can be a day early). Only cells this script filled are touched.
    let fixed = false;
    const old = r[COL.jobDate - 1];
    if (old instanceof Date && String(dateNotes[i][0]).indexOf(NOTE_PREFIX) === 0 &&
        Utilities.formatDate(old, tz, 'HH:mm') !== '00:00') {
      sh.getRange(row, COL.jobDate).setValue(jobDate).setNumberFormat('dd/mm/yyyy').setNote(stamp);
      fixed = true;
    }
    const price = Number(job.price);
    const a = fill(COL.booked, 'Yes');
    const b = fill(COL.value, price > 0 ? price : '');
    const c = fill(COL.jobDate, jobDate);
    if (c) sh.getRange(row, COL.jobDate).setNumberFormat('dd/mm/yyyy');
    if (a || b || c || fixed) updated++;
  });
  return updated;
}

/** The hourly job. */
function syncBookings() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const status = ss.getSheetByName(LEADS_TAB) && ss.getSheetByName(LEADS_TAB).getRange(STATUS_CELL);
  try {
    const jobs = callApp('tracker_feed');
    let leads = [], leadsNote = '';
    try { leads = callApp('tracker_leads'); }
    catch (e) { leadsNote = ' New leads need the updated Supabase step.'; }

    let added = 0, updated = 0;
    const lsh = ss.getSheetByName(LEADS_TAB);
    if (lsh && leads.length) added = addNewLeads(lsh, tz, leads);
    TABS.forEach(tab => { const sh = ss.getSheetByName(tab); if (sh) updated += fillBookings(sh, tz, jobs); });

    const summary = (added || updated)
      ? `Added ${added} new lead${added === 1 ? '' : 's'} and filled in ${updated} booking${updated === 1 ? '' : 's'}.` + leadsNote
      : 'Up to date. Nothing new in the app.' + leadsNote;
    if (status) status.setValue('Last checked with the app: ' + Utilities.formatDate(new Date(), tz, 'd MMM yyyy, HH:mm') + '. ' + summary);
    return { added, updated, summary };
  } catch (e) {
    if (status) status.setValue('Lead tracker could NOT reach the app at ' + Utilities.formatDate(new Date(), tz, 'd MMM yyyy, HH:mm') + ': ' + e.message);
    throw e;
  }
}
