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
The app also checks FreeAgent for payments it has matched from your bank and marks those invoices paid.

The connection runs in a Netlify function (`netlify/functions/freeagent.mjs`), which deploys with the site.

1. At [dev.freeagent.com](https://dev.freeagent.com), sign in and create an app.
   Set its **OAuth redirect URI** to `https://<your-site>/api/freeagent`.
2. In Netlify, under **Site configuration → Environment variables**, add `FREEAGENT_CLIENT_ID` (the app's OAuth identifier) and `FREEAGENT_CLIENT_SECRET` (its OAuth secret).
   Then redeploy (**Deploys → Trigger deploy**).
3. In the app, go to **Business → FreeAgent → Connect FreeAgent** and approve access.

Set `FREEAGENT_SANDBOX=true` as well to try it against a FreeAgent sandbox account first.
