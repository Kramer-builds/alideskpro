// gmail-sync
// POST /.netlify/functions/gmail-sync
// Optional body: { email: "imports@shopatgrace.com", maxMessages: 50 }
//
// Flow:
//   1. Load OAuth tokens for the connected email.
//   2. Refresh access token if needed.
//   3. List Gmail messages newer than last_synced_at.
//   4. For each, fetch full content, match against vendors, write to ali4_messages.
//   5. Update last_synced_at on the token row.

import {
  getEnv,
  sbGet,
  sbUpsert,
  sbUpdate,
  refreshAccessToken,
  json,
  parseBody,
} from "./_shared.mjs";

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") return json(200, {});

  try {
    const body = parseBody(event);
    const targetEmail = body.email || null;
    const maxMessages = Math.min(body.maxMessages || 25, 100);

    // Load token row. If targetEmail not provided, pick the first non-pending row.
    let tokenRow;
    if (targetEmail) {
      const rows = await sbGet(
        "ali4_gmail_tokens",
        `?email=eq.${encodeURIComponent(targetEmail)}&select=*`,
      );
      tokenRow = rows[0];
    } else {
      const rows = await sbGet(
        "ali4_gmail_tokens",
        `?email=not.like.__pending_*&email=not.like.__used_*&email=not.like.__disconnected_*&select=*&limit=1`,
      );
      tokenRow = rows[0];
    }

    if (!tokenRow) {
      return json(404, { error: "No connected Gmail account found. Click Connect Gmail on the Inbox page first." });
    }

    // Ensure access token is fresh.
    const accessToken = await refreshAccessToken(tokenRow);
    const userEmail = tokenRow.email;

    // Build the search query. We use Gmail's `after:` operator with a Unix
    // timestamp for the last sync. On first sync we go back 30 days.
    const lastSyncMs = tokenRow.last_synced_at
      ? new Date(tokenRow.last_synced_at).getTime()
      : Date.now() - 30 * 24 * 60 * 60 * 1000;
    // Gmail's after: takes seconds, not ms.
    const afterSec = Math.floor(lastSyncMs / 1000);
    // Exclude promotions/social/spam to keep vendor mail focused.
    const q = `after:${afterSec} -category:promotions -category:social -in:spam -in:trash`;

    // List message IDs.
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxMessages}`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResp.ok) {
      const text = await listResp.text();
      throw new Error(`Gmail list failed: ${listResp.status} ${text}`);
    }
    const listData = await listResp.json();
    const messageRefs = listData.messages || [];

    // Load companies/contacts from ali4_store for vendor matching.
    // Frontend stores companies under the key 'ali4_companies' in ali4_store.
    const companiesBlob = await loadStoreKey("ali4_companies");
    const companies = Array.isArray(companiesBlob) ? companiesBlob : [];

    // Load the ignored-senders list. Messages from these addresses get auto-archived on sync
    // so they never clutter the Unmatched view.
    let ignoredSet = new Set();
    try {
      const igRows = await sbGet("ali4_ignored_senders", "?select=email");
      ignoredSet = new Set((igRows || []).map(r => String(r.email).toLowerCase()));
    } catch (e) {
      // Table may not exist yet on first deploy. Non-fatal.
      console.warn("ignored_senders table not available:", e.message);
    }

    // Build a flat lookup: lowercase email → { companyId, contactId }
    const emailIndex = new Map();
    const domainIndex = new Map();
    for (const c of companies) {
      // Top-level company email if present
      if (c.email) {
        emailIndex.set(String(c.email).toLowerCase(), { companyId: c.id, contactId: null });
      }
      for (const ct of c.contacts || []) {
        if (ct.email) {
          emailIndex.set(String(ct.email).toLowerCase(), { companyId: c.id, contactId: ct.id });
          // Track the domain so emails from any address at this domain auto-match.
          const dom = String(ct.email).toLowerCase().split("@")[1];
          if (dom && !domainIndex.has(dom)) {
            domainIndex.set(dom, { companyId: c.id, contactId: null });
          }
        }
      }
    }

    // Fetch message contents and persist.
    let processed = 0;
    let matched = 0;
    let skipped = 0;
    const errors = [];

    for (const ref of messageRefs) {
      try {
        const detail = await fetchMessage(accessToken, ref.id);
        if (!detail) { skipped++; continue; }

        // Parse headers for sender, subject, etc.
        const headers = headersToMap(detail.payload?.headers || []);
        const fromHeader = headers["from"] || "";
        const { name: fromName, email: fromEmail } = parseAddress(fromHeader);
        const subject = headers["subject"] || "(no subject)";
        const dateHeader = headers["date"];
        const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date(parseInt(detail.internalDate)).toISOString();

        // Determine direction by comparing the From address to the connected user.
        const direction = String(fromEmail).toLowerCase() === userEmail.toLowerCase() ? "outbound" : "inbound";

        // Match to vendor — for inbound emails we match the FROM address; for
        // outbound we match the FIRST TO address (since vendor is the recipient).
        let matchTarget = fromEmail;
        if (direction === "outbound") {
          const toHeader = headers["to"] || "";
          const firstTo = toHeader.split(",")[0];
          matchTarget = parseAddress(firstTo).email;
        }
        const match = matchVendor(matchTarget, emailIndex, domainIndex);
        if (match) matched++;

        const toEmails = parseAddressList(headers["to"]);
        const ccEmails = parseAddressList(headers["cc"]);
        const { textBody, htmlBody, hasAttachments, attachmentMeta } = extractContent(detail.payload);
        const orderRefs = detectOrderRefs(subject + " " + textBody);

        // If this sender is on the ignored list, mark the message archived so it doesn't
        // show up in Unmatched / All views. The data still gets stored — just hidden.
        const isIgnored = fromEmail && ignoredSet.has(String(fromEmail).toLowerCase());

        // Upsert into ali4_messages — gmail_message_id is unique so re-runs are safe.
        await sbUpsert(
          "ali4_messages",
          {
            gmail_message_id: detail.id,
            thread_id: detail.threadId,
            company_id: match?.companyId || null,
            contact_id: match?.contactId || null,
            direction,
            from_email: fromEmail || null,
            from_name: fromName || null,
            to_emails: toEmails,
            cc_emails: ccEmails.length > 0 ? ccEmails : null,
            subject,
            body_text: textBody.slice(0, 60000), // cap to avoid runaway sizes
            body_html: htmlBody ? htmlBody.slice(0, 200000) : null,
            received_at: receivedAt,
            is_read: !(detail.labelIds || []).includes("UNREAD"),
            has_attachments: hasAttachments,
            attachment_meta: attachmentMeta.length > 0 ? attachmentMeta : null,
            detected_order_refs: orderRefs.length > 0 ? orderRefs : null,
            raw_headers: headers,
            archived_at: isIgnored ? new Date().toISOString() : null,
          },
          "gmail_message_id",
        );
        processed++;
      } catch (e) {
        console.error("Failed processing message", ref.id, e.message);
        errors.push({ id: ref.id, error: e.message });
      }
    }

    // Update last_synced_at
    await sbUpdate(
      "ali4_gmail_tokens",
      `?email=eq.${encodeURIComponent(userEmail)}`,
      { last_synced_at: new Date().toISOString() },
    );

    return json(200, {
      ok: true,
      email: userEmail,
      listed: messageRefs.length,
      processed,
      matched,
      skipped,
      errors: errors.slice(0, 5), // cap response size
    });
  } catch (error) {
    console.error("sync failed:", error);
    return json(500, { error: error.message });
  }
};

// --- helpers ---

async function fetchMessage(accessToken, id) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`Gmail fetch ${id} failed: ${r.status}`);
  }
  return r.json();
}

function headersToMap(headersArray) {
  const m = {};
  for (const h of headersArray) {
    m[h.name.toLowerCase()] = h.value;
  }
  return m;
}

function parseAddress(s) {
  if (!s) return { name: "", email: "" };
  // Match `Name <email@domain>` or just `email@domain`
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) || s.match(/^\s*(.*)\s*$/);
  if (m && m[2]) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "", email: s.trim() };
}

function parseAddressList(s) {
  if (!s) return [];
  return s.split(",").map(part => parseAddress(part).email).filter(Boolean);
}

function matchVendor(email, emailIndex, domainIndex) {
  if (!email) return null;
  const lc = email.toLowerCase();
  if (emailIndex.has(lc)) return emailIndex.get(lc);
  const dom = lc.split("@")[1];
  if (dom && domainIndex.has(dom)) return domainIndex.get(dom);
  return null;
}

function extractContent(payload) {
  let textBody = "";
  let htmlBody = "";
  const attachmentMeta = [];
  let hasAttachments = false;

  const walk = (part) => {
    if (!part) return;
    if (part.parts) {
      for (const p of part.parts) walk(p);
    }
    const mime = part.mimeType || "";
    const isAttachment = part.filename && part.filename.length > 0;
    if (isAttachment) {
      hasAttachments = true;
      attachmentMeta.push({
        filename: part.filename,
        mimeType: mime,
        size: part.body?.size || 0,
        attachmentId: part.body?.attachmentId || null,
      });
      return;
    }
    if (mime === "text/plain" && part.body?.data) {
      textBody += decodeBase64Url(part.body.data);
    } else if (mime === "text/html" && part.body?.data) {
      htmlBody += decodeBase64Url(part.body.data);
    }
  };
  walk(payload);

  // If we only have HTML, derive a text fallback so search/snippets work.
  if (!textBody && htmlBody) {
    textBody = htmlBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  return { textBody, htmlBody, hasAttachments, attachmentMeta };
}

function decodeBase64Url(data) {
  // Gmail uses URL-safe base64 with no padding.
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  try {
    return Buffer.from(normalized + padding, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function detectOrderRefs(text) {
  if (!text) return [];
  // Match XX-YYYY-NNN style (1-4 letters, dash, 4 digits, dash, 2-4 digits).
  const matches = text.match(/\b[A-Z]{1,4}-\d{4}-\d{2,4}\b/g) || [];
  return [...new Set(matches)];
}

async function loadStoreKey(key) {
  const rows = await sbGet(
    "ali4_store",
    `?key=eq.${encodeURIComponent(key)}&select=value`,
  );
  if (!rows || rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}
