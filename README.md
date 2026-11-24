# CTM Quotes & Customers

Quoting, customers, calendar, invoices and lead tracking for CTM Exterior Cleaning.
It's a single static page (`index.html`) with data stored in Supabase.

## Files

- `index.html`: the whole app
- `config.js`: your Supabase project URL and anon key
- `supabase/schema.sql`: database table and privacy rules (run once)
- `supabase/functions/meta-leads/`: receives Facebook/Instagram lead ads and saves them as customers
- `manifest.webmanifest`, `icon*.png`, `icon.svg`: let you add the app to your phone's home screen

## One-time setup

1. **Supabase**: create a project. In **SQL Editor**, paste in `supabase/schema.sql` and run it.
   Under **Authentication → URL Configuration**, set the Site URL to your Netlify address.
2. **config.js**: fill in the Project URL and anon public key from **Project Settings → API**.
3. **Netlify**: **Add new site → Import from GitHub**, then pick this repo. There's no build command, and the publish directory is the repo root.
4. Open the site, choose **Create your account**, and confirm your email.
   Then in Supabase, under **Authentication → Sign In / Providers**, turn off **Allow new users to sign up** so nobody else can register.
5. To bring across data from the Claude version: in the old app, go to **Business → Download full backup**. In the new site, go to **Business → Restore from backup**.

## Meta leads (optional)

Deploy the function with the Supabase CLI:

```
supabase functions deploy meta-leads --no-verify-jwt
supabase secrets set OWNER_USER_ID=<your user id from Authentication → Users> LEADS_SECRET=<any long random text>
```

Then either:
- **Make or Zapier**: POST each lead's fields as JSON to
  `https://<project>.supabase.co/functions/v1/meta-leads?key=<LEADS_SECRET>`.
  Use the field names `full_name`, `phone_number`, `email`, `street_address`, `post_code`, `service`.
- **Meta webhook (direct)**: in a Meta developer app, subscribe the Page to the `leadgen` webhook, using the function URL and a verify token.
  Then also set `META_VERIFY_TOKEN`, `META_APP_SECRET` and `META_PAGE_TOKEN` (a Page token with `leads_retrieval`).

## FreeAgent (optional)

Invoices can be created in FreeAgent automatically, with the customer added as a FreeAgent contact (an existing contact with the same email or name is reused).
FreeAgent numbers each invoice in its own sequence, and the app switches the invoice to that number.
The app also checks FreeAgent for payments it has matched from your bank and marks those invoices paid.

The connection runs in a Netlify function (`netlify/functions/freeagent.mjs`), which deploys with the site.

1. At [dev.freeagent.com](https://dev.freeagent.com), sign in and create an app.
   Set its **OAuth redirect URI** to `https://<your-site>/api/freeagent`.
2. In Netlify, under **Site configuration → Environment variables**, add `FREEAGENT_CLIENT_ID` (the app's OAuth identifier) and `FREEAGENT_CLIENT_SECRET` (its OAuth secret).
   Then redeploy (**Deploys → Trigger deploy**).
3. In the app, go to **Business → FreeAgent → Connect FreeAgent** and approve access.

Set `FREEAGENT_SANDBOX=true` as well to try it against a FreeAgent sandbox account first.

## Lead tracker sync (optional)

Keeps your Google Sheet lead tracker up to date from the app. Every hour it adds new Facebook/Instagram ad leads
(from 17 Nov 2026 on, skipping window cleaning ones) to the Gutters tab. Then, for each booked job, it finds the matching lead
(by phone number, then by exact name) and fills in **Booked?** = Yes, **Job value (£)** and **Job date**.
It only writes into empty cells, and it skips any lead you've marked "No" yourself.
It uses the first job booked on or after the date the lead enquired.

1. **Make the tracker a Google Sheet.** In Google Drive, open the tracker and choose **File → Save as Google Sheets**.
   Use the new Google Sheet from now on.
2. **Create your key.** In Supabase, open **SQL Editor**, paste in `supabase/tracker-feed.sql` and run it.
   Copy the long key it shows at the bottom.
3. **Add the script.** In the Google Sheet, choose **Extensions → Apps Script**. Delete what's there, paste in
   `tracker-sync/Code.gs`, and put your key between the quotes on the `TRACKER_KEY` line. Click **Save**.
4. **Turn it on.** Reload the sheet. A **Lead tracker** menu appears. Choose **Turn on hourly updates** and allow access when Google asks.

Use **Lead tracker → Update from the app now** to update it straight away. Cells it fills in have a small note saying so,
and cell A5 on the Gutters tab shows when it last checked.
It fills the Gutters tab; to include another tab, add its name to `TABS` at the top of the script.
