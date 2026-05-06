// whatsapp-send
// POST /.netlify/functions/whatsapp-send
//
// Body shape:
//   {
//     to: "+8613912345678",            // recipient WhatsApp number with + prefix
//     mode: "template" | "freeform",   // template required for cold start; freeform within 24h window
//     // For mode=template:
//     contentSid: "HX...",             // Twilio Content SID for an approved template
//     contentVariables: { "1": "Tila", "2": "SL-2026-006" },
//     templateName: "vendor_order_status",  // for our own logging only
//     // For mode=freeform:
//     body: "Free-form message text",
//     // Optional vendor association for mirroring to ali4_messages:
//     companyId, contactId
//   }
//
// Sends via Twilio's Messaging API and mirrors the outbound message into
// ali4_messages so it appears in the Inbox alongside email.

import { getTwilioEnv, sbInsert, json, parseBody } from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  try {
    const body = parseBody(event);
    const { to, mode, contentSid, contentVariables, templateName, body: messageBody, companyId, contactId } = body;

    if (!to) return json(400, { error: "to is required" });
    if (!mode) return json(400, { error: "mode is required (template | freeform)" });

    const env = getTwilioEnv();
    // Twilio expects the WhatsApp prefix on phone numbers
    const toFormatted = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

    // Build the form payload. Twilio's Messaging API takes form-encoded data.
    const params = new URLSearchParams();
    params.set("From", env.TWILIO_WHATSAPP_FROM);
    params.set("To", toFormatted);

    if (mode === "template") {
      if (!contentSid) return json(400, { error: "contentSid required for template mode" });
      params.set("ContentSid", contentSid);
      if (contentVariables && typeof contentVariables === "object") {
        params.set("ContentVariables", JSON.stringify(contentVariables));
      }
    } else if (mode === "freeform") {
      if (!messageBody) return json(400, { error: "body required for freeform mode" });
      params.set("Body", messageBody);
    } else {
      return json(400, { error: "Unknown mode: " + mode });
    }

    // Twilio API call. Uses HTTP Basic auth with Account SID + Auth Token.
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const result = await r.json();

    if (!r.ok) {
      // Twilio returns structured errors with code + message
      const errorMsg = result.message || result.error_message || "Twilio send failed";
      console.error("Twilio send failed:", result);
      return json(r.status, { error: errorMsg, twilioCode: result.code });
    }

    // For mirroring, we want to record what was actually sent.
    // For template mode, we don't have the rendered text (Twilio renders server-side).
    // We store templateName + the variables JSON so we can show "vendor_order_status: Tila, SL-2026-006"
    // in the inbox preview, even if we don't have the full rendered text.
    const previewText = mode === "template"
      ? `[${templateName || "template"}] ${contentVariables ? JSON.stringify(contentVariables) : ""}`
      : messageBody;

    try {
      await sbInsert("ali4_messages", {
        gmail_message_id: null,
        twilio_message_sid: result.sid,
        thread_id: null,
        company_id: companyId || null,
        contact_id: contactId || null,
        direction: "outbound",
        channel: "whatsapp",
        from_phone: env.TWILIO_WHATSAPP_FROM.replace("whatsapp:", ""),
        to_phone: to,
        from_email: null,
        to_emails: null,
        subject: null,
        body_text: previewText.slice(0, 60000),
        body_html: null,
        received_at: new Date().toISOString(),
        is_read: true,
        has_attachments: false,
        attachment_meta: null,
        template_name: mode === "template" ? (templateName || null) : null,
        raw_headers: result, // store the full Twilio response for debugging
      });
    } catch (mirrorError) {
      // Mirror failure is non-fatal — message DID send. Log and move on.
      console.error("Mirror to ali4_messages failed (message sent OK):", mirrorError);
    }

    return json(200, { ok: true, sid: result.sid, status: result.status });
  } catch (e) {
    console.error("whatsapp-send failed:", e);
    return json(500, { error: e.message });
  }
};
