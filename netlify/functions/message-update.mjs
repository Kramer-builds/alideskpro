// message-update
// POST /.netlify/functions/message-update
// Body shapes:
//   { action: "assignVendor", fromEmail, fromName?, companyId, contactId? }
//     -> Updates all ali4_messages rows with that from_email to point to companyId.
//        Also adds the sender as a new contact on that company (if not already present).
//
//   { action: "ignoreSender", fromEmail }
//     -> Adds fromEmail to the ignored_senders list. Future incoming mail from this address
//        is still saved but marked with a flag so it doesn't appear in the Unmatched filter.
//        Also retroactively flags existing messages from that sender.
//
// Why a Function instead of direct Supabase calls from browser:
//   - Vendor assignment also needs to mutate ali4_store.companies (the JSON blob containing
//     the contacts array). Doing that atomically server-side is safer than client-side.

import { sbGet, sbInsert, sbUpdate, sbUpsert, json, parseBody } from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  try {
    const body = parseBody(event);
    const action = body.action;

    if (action === "assignVendor") {
      return await assignVendor(body);
    } else if (action === "ignoreSender") {
      return await ignoreSender(body);
    } else {
      return json(400, { error: "Unknown action: " + action });
    }
  } catch (e) {
    console.error("message-update failed:", e);
    return json(500, { error: e.message });
  }
};

async function assignVendor({ fromEmail, fromName, companyId, contactId }) {
  if (!fromEmail || !companyId) {
    return json(400, { error: "fromEmail and companyId are required" });
  }
  const lcEmail = fromEmail.toLowerCase();

  // Step 1: Update existing messages from this sender to point to the company.
  await sbUpdate(
    "ali4_messages",
    `?from_email=ilike.${encodeURIComponent(fromEmail)}`,
    { company_id: companyId, contact_id: contactId || null },
  );

  // Step 2: Add this email to the company's contacts (so future mail auto-matches).
  // The companies live as a JSON blob in ali4_store under key='companies'.
  // The frontend stores companies under the key 'ali4_companies' in ali4_store.
  // We must read from and write to the same key so the frontend sees our changes.
  const rows = await sbGet("ali4_store", "?key=eq.ali4_companies&select=value");
  if (!rows || rows.length === 0) {
    return json(200, { ok: true, note: "messages reassigned but companies blob not found" });
  }
  let companies;
  try {
    companies = JSON.parse(rows[0].value);
  } catch {
    return json(500, { error: "companies blob not parseable" });
  }
  const company = companies.find(c => c.id === companyId);
  if (!company) {
    return json(404, { error: "company not found in store" });
  }
  company.contacts = company.contacts || [];
  // Skip if a contact with this email already exists (case-insensitive).
  const existingContact = company.contacts.find(ct => ct.email && ct.email.toLowerCase() === lcEmail);
  if (!existingContact) {
    company.contacts.push({
      id: "ct_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: fromName || fromEmail.split("@")[0],
      email: fromEmail,
      role: "",
      phone: "",
    });
    // Save the updated companies blob.
    await sbUpsert("ali4_store", { key: "ali4_companies", value: JSON.stringify(companies) }, "key");
  }

  return json(200, { ok: true, contactAdded: !existingContact });
}

async function ignoreSender({ fromEmail }) {
  if (!fromEmail) return json(400, { error: "fromEmail required" });
  const lcEmail = fromEmail.toLowerCase();

  // Upsert into ignored_senders. Table is { email (PK), ignored_at }.
  await sbUpsert("ali4_ignored_senders",
    { email: lcEmail, ignored_at: new Date().toISOString() },
    "email",
  );

  // Retroactively mark messages — we use the existing archived_at column to hide them
  // from the Unmatched view, since "ignored" is essentially the same as "archived" for
  // routing purposes. But we set a marker in raw_headers to remember why they're hidden.
  // Cleaner alternative: a separate is_ignored column. For simplicity we lean on archived_at.
  await sbUpdate(
    "ali4_messages",
    `?from_email=ilike.${encodeURIComponent(fromEmail)}&archived_at=is.null`,
    { archived_at: new Date().toISOString() },
  );

  return json(200, { ok: true, ignored: lcEmail });
}
