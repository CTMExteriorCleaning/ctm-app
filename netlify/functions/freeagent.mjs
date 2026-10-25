// Connects the app to FreeAgent: sign in once, then send invoices (and their
// customers as contacts) and check which invoices FreeAgent has seen paid.
//
// Netlify environment variables: FREEAGENT_CLIENT_ID, FREEAGENT_CLIENT_SECRET,
// and optionally FREEAGENT_SANDBOX=true to use FreeAgent's test site.
//
// FreeAgent's tokens never reach the browser in readable form: they're sealed
// with a key derived from the client secret, the app stores that sealed blob in
// its settings, and sends it back with each request.

export const config = { path: "/api/freeagent" };

const env = (k) => process.env[k] || "";
const API = env("FREEAGENT_SANDBOX") === "true" ? "https://api.sandbox.freeagent.com/v2" : "https://api.freeagent.com/v2";

/* ---------- sealed tokens ---------- */
const b64u = (buf) => Buffer.from(buf).toString("base64url");
let keyP;
const key = () => keyP ||= crypto.subtle.digest("SHA-256", new TextEncoder().encode("ctm-freeagent:" + env("FREEAGENT_CLIENT_SECRET")))
  .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
async function seal(tok) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(tok)));
  return b64u(iv) + "." + b64u(ct);
}
async function unseal(s) {
  const [iv, ct] = String(s || "").split(".");
  if (!iv || !ct) throw new HttpError(401, "Not connected to FreeAgent.");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url") }, await key(), Buffer.from(ct, "base64url"));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new HttpError(401, "The FreeAgent connection has expired. Connect again from the Business page.");
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- OAuth ---------- */
async function tokenRequest(params) {
  const res = await fetch(API + "/token_endpoint", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(env("FREEAGENT_CLIENT_ID") + ":" + env("FREEAGENT_CLIENT_SECRET")).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    console.error("FreeAgent token", res.status, j);
    throw new HttpError(401, "FreeAgent didn't accept the sign-in. Connect again from the Business page.");
  }
  return j;
}

// A FreeAgent session for one request. Refreshes the access token when it's due
// and remembers whether the sealed blob needs saving again.
async function session(sealed) {
  let tok = await unseal(sealed), changed = false;
  async function ensure() {
    if (tok.exp && Date.now() < tok.exp - 60_000) return;
    const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh });
    tok = { access: j.access_token, refresh: j.refresh_token || tok.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    changed = true;
  }
  async function fa(path, opts = {}) {
    await ensure();
    const res = await fetch(path.startsWith("http") ? path : API + path, {
      ...opts,
      headers: { Authorization: "Bearer " + tok.access, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "CTM Quotes" },
    });
    const text = await res.text();
    const j = text ? JSON.parse(text) : {};
    if (!res.ok) {
      console.error("FreeAgent", opts.method || "GET", path, res.status, text);
      const msg = (j.errors && [].concat(j.errors.error || j.errors).map((e) => e.message || e).join(" ")) || "FreeAgent said no (" + res.status + ").";
      throw new HttpError(res.status === 401 ? 401 : 502, msg);
    }
    return j;
  }
  return { fa, token: async () => (changed ? seal(tok) : undefined) };
}

/* ---------- contacts ---------- */
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { organisation_name: parts[0] || "Customer" };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] };
}
function splitAddress(address) {
  const parts = String(address || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { address1: parts[0] };
  return { address1: parts[0], address2: parts.slice(1, -1).join(", ") || undefined, town: parts[parts.length - 1] };
}
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
function contactName(c) {
  return norm(c.organisation_name && !c.first_name ? c.organisation_name : [c.first_name, c.last_name].filter(Boolean).join(" "));
}

// Find the customer among existing FreeAgent contacts (by email, then name),
// so customers already invoiced in FreeAgent aren't duplicated.
async function findOrCreateContact(fa, customer) {
  const email = norm(customer.email), name = norm(customer.name);
  let byName = null;
  for (let page = 1; page <= 20; page++) {
    const { contacts = [] } = await fa(`/contacts?view=all&per_page=100&page=${page}`);
    for (const c of contacts) {
      if (email && norm(c.email) === email) return c.url;
      if (!byName && name && contactName(c) === name) byName = c.url;
    }
    if (contacts.length < 100) break;
  }
  if (byName) return byName;
  const { contact } = await fa("/contacts", {
    method: "POST",
    body: JSON.stringify({
      contact: {
        ...splitName(customer.name),
        email: customer.email || undefined,
        phone_number: customer.phone || undefined,
        ...splitAddress(customer.address),
        postcode: customer.postcode || undefined,
        country: "United Kingdom",
      },
    }),
  });
  return contact.url;
}

/* ---------- actions ---------- */
const days = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));

const ACTIONS = {
  async status({ fa }) {
    const { company } = await fa("/company");
    const host = (env("FREEAGENT_SANDBOX") === "true" ? ".sandbox" : "") + ".freeagent.com";
    return { company: company.name, web: company.subdomain ? "https://" + company.subdomain + host : "" };
  },

  // body.invoice: {number, date, dueDate, notes, vatOn, vatRate, items: [{description, amount}], discount}
  // body.customer: {name, email, phone, address, postcode, freeagentContact?}
  async send({ fa }, { invoice, customer }) {
    if (!invoice || !customer) throw new HttpError(400, "Missing invoice or customer.");
    const contact = customer.freeagentContact || (await findOrCreateContact(fa, customer));
    const tax = invoice.vatOn ? { sales_tax_rate: Number(invoice.vatRate) || 0 } : {};
    const items = (invoice.items || []).map((it) => ({ item_type: "Services", description: it.description, quantity: 1, price: Number(it.amount).toFixed(2), ...tax }));
    if (Number(invoice.discount) > 0) items.push({ item_type: "Discount", description: "Discount", quantity: 1, price: (-Number(invoice.discount)).toFixed(2), ...tax });
    const { invoice: created } = await fa("/invoices", {
      method: "POST",
      body: JSON.stringify({
        invoice: {
          contact,
          reference: invoice.number,
          dated_on: invoice.date,
          payment_terms_in_days: days(invoice.date, invoice.dueDate || invoice.date),
          currency: "GBP",
          comments: invoice.notes || undefined,
          invoice_items: items,
        },
      }),
    });
    // New FreeAgent invoices start as drafts; mark it sent so bank payments can be matched to it.
    await fa(created.url + "/transitions/mark_as_sent", { method: "PUT" });
    return { invoiceUrl: created.url, contactUrl: contact, reference: created.reference };
  },

  // body.urls: FreeAgent invoice URLs. Returns the ones FreeAgent has as paid.
  async check({ fa }, { urls }) {
    const paid = {};
    for (const url of (urls || []).slice(0, 50)) {
      if (!String(url).startsWith(API + "/invoices/")) continue;
      try {
        const { invoice } = await fa(url);
        if (/^(paid|overpaid)$/i.test(invoice.status)) paid[url] = invoice.paid_on || new Date().toISOString().slice(0, 10);
      } catch (e) {
        if (e.status === 401) throw e;
      }
    }
    return { paid };
  },
};

/* ---------- entry ---------- */
export default async (req) => {
  const url = new URL(req.url);
  const redirectUri = url.origin + url.pathname;
  if (!env("FREEAGENT_CLIENT_ID") || !env("FREEAGENT_CLIENT_SECRET")) {
    return req.method === "GET"
      ? Response.redirect(url.origin + "/#fa_error=" + encodeURIComponent("FreeAgent isn't set up on the website yet (missing client ID or secret)."), 302)
      : Response.json({ error: "FreeAgent isn't set up on the website yet (missing client ID or secret)." }, { status: 500 });
  }

  if (req.method === "GET") {
    // Step 1: the app sends the browser here to start signing in to FreeAgent.
    if (url.searchParams.has("start")) {
      const q = new URLSearchParams({ client_id: env("FREEAGENT_CLIENT_ID"), response_type: "code", redirect_uri: redirectUri, state: url.searchParams.get("start") });
      return Response.redirect(API + "/approve_app?" + q, 302);
    }
    // Step 2: FreeAgent sends the browser back here with a code.
    const state = url.searchParams.get("state") || "";
    const back = (hash) => Response.redirect(url.origin + "/#" + hash, 302);
    if (!url.searchParams.get("code")) return back("fa_error=" + encodeURIComponent(url.searchParams.get("error_description") || "FreeAgent sign-in was cancelled."));
    try {
      const j = await tokenRequest({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: redirectUri });
      const sealed = await seal({ access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
      return back("fa=" + encodeURIComponent(sealed) + "&state=" + encodeURIComponent(state));
    } catch (e) {
      return back("fa_error=" + encodeURIComponent(e.message));
    }
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const body = await req.json();
    const fn = ACTIONS[body.action];
    if (!fn) throw new HttpError(400, "Unknown action.");
    const s = await session(body.token);
    const result = await fn(s, body);
    return Response.json({ ...result, token: await s.token() });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return Response.json({ error: e.message || "Something went wrong talking to FreeAgent." }, { status: e.status || 500 });
  }
};
