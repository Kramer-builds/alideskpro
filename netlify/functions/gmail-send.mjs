// gmail-send
// POST /.netlify/functions/gmail-send
// Body: { to: "vendor@example.com", subject: "...", body: "...", cc?: "...",
//         threadId?: "...", inReplyTo?: "<message-id>", companyId?: "...", contactId?: "..." }
//
// We assemble a RFC 2822 MIME message, base64url-encode it, and POST to Gmail.
// On success we also write the outbound message into ali4_messages immediately
// so the Inbox UI shows it without waiting for the next sync.

import {
  sbGet,
  sbInsert,
  refreshAccessToken,
  json,
  parseBody,
} from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed; use POST" });
  }

  try {
    const body = parseBody(event);
    const { to, subject, body: messageBody, cc, threadId, inReplyTo, companyId, contactId, fromEmail } = body;

    if (!to || !subject || !messageBody) {
      return json(400, { error: "Missing required fields: to, subject, body" });
    }

    // Load tokens for the sender. If fromEmail not specified, use the first
    // connected account.
    let tokenRow;
    if (fromEmail) {
      const rows = await sbGet(
        "ali4_gmail_tokens",
        `?email=eq.${encodeURIComponent(fromEmail)}&select=*`,
      );
      tokenRow = rows[0];
    } else {
      const rows = await sbGet(
        "ali4_gmail_tokens",
        `?email=not.like.__pending_*&email=not.like.__used_*&select=*&limit=1`,
      );
      tokenRow = rows[0];
    }
    if (!tokenRow) {
      return json(404, { error: "No connected Gmail account. Connect on the Inbox page first." });
    }

    const accessToken = await refreshAccessToken(tokenRow);
    const senderEmail = tokenRow.email;

    // Build the raw RFC-2822 message.
    const headers = [
      `From: ${senderEmail}`,
      `To: ${to}`,
    ];
    if (cc) headers.push(`Cc: ${cc}`);
    headers.push(`Subject: ${encodeRfc2047(subject)}`);
    headers.push(`MIME-Version: 1.0`);
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    headers.push(`Content-Transfer-Encoding: 7bit`);
    if (inReplyTo) {
      headers.push(`In-Reply-To: ${inReplyTo}`);
      headers.push(`References: ${inReplyTo}`);
    }
    const rawMessage = headers.join("\r\n") + "\r\n\r\n" + messageBody;
    const encodedMessage = Buffer.from(rawMessage, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sendBody = { raw: encodedMessage };
    if (threadId) sendBody.threadId = threadId;

    const sendResp = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sendBody),
      },
    );

    if (!sendResp.ok) {
      const text = await sendResp.text();
      throw new Error(`Gmail send failed: ${sendResp.status} ${text}`);
    }

    const sent = await sendResp.json();
    // sent shape: { id, threadId, labelIds }

    // Also persist this outbound message to our ali4_messages table so the UI
    // shows it immediately without a full Gmail sync.
    try {
      await sbInsert("ali4_messages", {
        gmail_message_id: sent.id,
        thread_id: sent.threadId || null,
        company_id: companyId || null,
        contact_id: contactId || null,
        direction: "outbound",
        from_email: senderEmail,
        from_name: null,
        to_emails: to.split(",").map(s => s.trim()),
        cc_emails: cc ? cc.split(",").map(s => s.trim()) : null,
        subject,
        body_text: messageBody.slice(0, 60000),
        body_html: null,
        received_at: new Date().toISOString(),
        is_read: true,
        has_attachments: false,
        attachment_meta: null,
        detected_order_refs: detectOrderRefs(subject + " " + messageBody),
        raw_headers: { from: senderEmail, to, subject },
      });
    } catch (e) {
      // Non-fatal — Gmail has the message; next sync will pick it up too.
      console.warn("Could not mirror sent message to Supabase:", e.message);
    }

    return json(200, { ok: true, gmailMessageId: sent.id, threadId: sent.threadId });
  } catch (error) {
    console.error("send failed:", error);
    return json(500, { error: error.message });
  }
};

// Encode subject lines that contain non-ASCII characters per RFC 2047.
function encodeRfc2047(s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const encoded = Buffer.from(s, "utf-8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

function detectOrderRefs(text) {
  if (!text) return null;
  const matches = text.match(/\b[A-Z]{1,4}-\d{4}-\d{2,4}\b/g) || [];
  const unique = [...new Set(matches)];
  return unique.length > 0 ? unique : null;
}
