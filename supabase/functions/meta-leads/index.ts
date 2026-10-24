// Receives Facebook/Instagram lead ads and saves each lead as a customer.
//
// Two ways in:
//  1. Meta webhook (leadgen): Meta calls GET to verify, then POSTs a leadgen_id;
//     we fetch the lead from the Graph API with META_PAGE_TOKEN.
//  2. Simple JSON POST (from Make/Zapier) to ?key=LEADS_SECRET with
//     {full_name, phone_number, email, street_address, post_code, service, ...}.
//
// Secrets (supabase secrets set ...): OWNER_USER_ID, META_VERIFY_TOKEN,
// META_APP_SECRET, META_PAGE_TOKEN, LEADS_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const GRAPH = "https://graph.facebook.com/v21.0";

type Lead = Record<string, string>;

function toCustomer(f: Lead, leadId: string, created: string, platform: string) {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (f[k]) return f[k].trim();
    return "";
  };
  const known = new Set(["full_name", "first_name", "last_name", "phone_number", "phone", "email",
    "street_address", "address", "city", "post_code", "postcode", "zip_code", "service"]);
  const extras = Object.entries(f).filter(([k, v]) => !known.has(k) && v);
  const svc = f.service || extras.find(([k]) => /service|clean|job|work|need|interest|looking/.test(k))?.[1] || "";
  const notes = extras.filter(([, v]) => v !== svc)
    .map(([k, v]) => k.replace(/_/g, " ").replace(/\?$/, "").replace(/^./, (c) => c.toUpperCase()) + ": " + v.replace(/_/g, " "))
    .join("\n");
  const now = new Date().toISOString();
  return {
    stage: "lead",
    leadId,
    leadDate: (created || now).slice(0, 10),
    name: pick("full_name") || [pick("first_name"), pick("last_name")].filter(Boolean).join(" ") || "Unnamed lead",
    phone: pick("phone_number", "phone").replace(/^\+44\s?/, "0"),
    email: pick("email"),
    address: [pick("street_address", "address"), pick("city")].filter(Boolean).join(", "),
    postcode: pick("post_code", "postcode", "zip_code").toUpperCase(),
    service: svc.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    notes,
    source: platform === "ig" ? "Instagram ad" : "Facebook ad",
    createdAt: now,
    updatedAt: now,
  };
}

async function save(customer: ReturnType<typeof toCustomer>) {
  const id = "lead-" + (customer.leadId || crypto.randomUUID()).replace(/[^\w-]/g, "");
  const { error } = await db.from("records").upsert(
    { user_id: env("OWNER_USER_ID"), col: "customers", id, data: customer, updated_at: customer.updatedAt },
    { onConflict: "user_id,col,id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

async function validSignature(req: Request, body: string) {
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("META_APP_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const hex = "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig.length === hex.length && sig === hex;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env("META_VERIFY_TOKEN")) {
      return new Response(url.searchParams.get("hub.challenge") ?? "");
    }
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await req.text();

  // Simple JSON from Make/Zapier
  if (url.searchParams.has("key")) {
    if (!env("LEADS_SECRET") || url.searchParams.get("key") !== env("LEADS_SECRET")) return new Response("Forbidden", { status: 403 });
    const f = JSON.parse(body) as Lead;
    await save(toCustomer(f, f.lead_id || f.id || "", f.created_time || "", (f.platform || "").toLowerCase()));
    return Response.json({ ok: true });
  }

  // Meta webhook
  if (!(await validSignature(req, body))) return new Response("Bad signature", { status: 401 });
  const payload = JSON.parse(body);
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const leadId = String(change.value?.leadgen_id ?? "");
      if (!leadId) continue;
      const res = await fetch(`${GRAPH}/${leadId}?fields=created_time,field_data,platform&access_token=${env("META_PAGE_TOKEN")}`);
      const lead = await res.json();
      if (!res.ok) { console.error("Graph API", lead); continue; }
      const f: Lead = {};
      for (const fd of lead.field_data ?? []) f[fd.name] = (fd.values ?? []).join(", ");
      await save(toCustomer(f, leadId, lead.created_time ?? "", lead.platform ?? ""));
    }
  }
  return new Response("ok");
});
