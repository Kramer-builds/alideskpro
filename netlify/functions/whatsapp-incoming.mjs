// whatsapp-incoming
// POST /.netlify/functions/whatsapp-incoming
//
// Webhook called by Twilio whenever a vendor sends a WhatsApp message.
// Twilio sends form-encoded data with fields like:
//   From, To, Body, MessageSid, NumMedia, MediaUrl0, MediaContentType0, ProfileName
//
// Saves the message to ali4_messages, attempting to match the sender's phone
// to a known vendor contact. If no match, the message lands in Unmatched.

import { sbGet, sbUpsert, json, getTwilioEnv } from "./_shared.mjs";
import crypto from "node:crypto";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});

  try {
    // Twilio sends application/x-www-form-urlencoded
    const params = new URLSearchParams(event.body || "");
    const data = Object.fromEntries(params.entries());

    // Validate it's actually from Twilio (signature check).
    // Twilio signs every webhook request — if we don't validate, anyone could
    // POST fake messages to this endpoint and inject them into our inbox.
    const isValid = validateTwilioSignature(event, data);
    if (!isValid) {
      console.warn("whatsapp-incoming: invalid Twilio signature, rejecting");
      return json(403, { error: "Invalid signature" });
    }

    const fromPhoneRaw = data.From || ""; // e.g. "whatsapp:+8613912345678"
    const fromPhone = fromPhoneRaw.replace("whatsapp:", "").trim();
    const toPhoneRaw = data.To || "";
    const toPhone = toPhoneRaw.replace("whatsapp:", "").trim();
    const messageBody = data.Body || "";
    const messageSid = data.MessageSid || data.SmsSid;
    const profileName = data.ProfileName || null;
    const numMedia = parseInt(data.NumMedia || "0", 10);

    if (!messageSid) {
      console.warn("whatsapp-incoming: no MessageSid in payload");
      return json(400, { error: "MessageSid required" });
    }

    // Build attachment_meta from media fields. Twilio numbers them MediaUrl0..MediaUrlN.
    const attachmentMeta = [];
    for (let i = 0; i < numMedia; i++) {
      const url = data[`MediaUrl${i}`];
      const contentType = data[`MediaContentType${i}`];
      if (url) {
        attachmentMeta.push({
          filename: `whatsapp-media-${i}${guessExtension(contentType)}`,
          mimeType: contentType || "application/octet-stream",
          mediaUrl: url, // Twilio media URL — auth required to fetch
          size: 0, // Twilio doesn't tell us size in the webhook
        });
      }
    }

    // Match the sender phone to a known vendor contact.
    const match = await matchVendorByPhone(fromPhone);

    // Upsert (using twilio_message_sid as conflict key, defined as unique partial index).
    // If Twilio retries the webhook, we don't duplicate.
    await sbUpsert(
      "ali4_messages",
      {
        twilio_message_sid: messageSid,
        gmail_message_id: null,
        thread_id: null,
        company_id: match?.companyId || null,
        contact_id: match?.contactId || null,
        direction: "inbound",
        channel: "whatsapp",
        from_phone: fromPhone,
        to_phone: toPhone,
        from_name: profileName,
        from_email: null,
        to_emails: null,
        subject: null,
        body_text: messageBody.slice(0, 60000),
        body_html: null,
        received_at: new Date().toISOString(),
        is_read: false,
        has_attachments: attachmentMeta.length > 0,
        attachment_meta: attachmentMeta.length > 0 ? attachmentMeta : null,
        raw_headers: data, // full Twilio payload for debugging
      },
      "twilio_message_sid",
    );

    // Twilio expects us to respond with a TwiML response (or just empty 200).
    // We don't send an auto-reply, so just acknowledge.
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>",
    };
  } catch (e) {
    console.error("whatsapp-incoming failed:", e);
    return json(500, { error: e.message });
  }
};

// Validate the Twilio request signature.
// Twilio signs the URL + sorted form params with the Auth Token (HMAC-SHA1).
// See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
function validateTwilioSignature(event, params) {
  try {
    const env = getTwilioEnv();
    const signature = event.headers["x-twilio-signature"] || event.headers["X-Twilio-Signature"];
    if (!signature) return false;

    // Reconstruct the full URL Twilio called.
    const proto = event.headers["x-forwarded-proto"] || "https";
    const host = event.headers.host;
    const path = event.path || "/.netlify/functions/whatsapp-incoming";
    const fullUrl = `${proto}://${host}${path}`;

    // Twilio signs URL + sorted params concatenated.
    const sortedKeys = Object.keys(params).sort();
    const signatureString = sortedKeys.reduce((acc, key) => acc + key + params[key], fullUrl);
    const expected = crypto
      .createHmac("sha1", env.TWILIO_AUTH_TOKEN)
      .update(Buffer.from(signatureString, "utf-8"))
      .digest("base64");

    // Constant-time compare to avoid timing attacks
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    console.error("Signature validation error:", e);
    return false;
  }
}

// Find the vendor (company + contact) whose phone matches the incoming number.
// Phones in our companies blob are stored in vendor.contacts[].phone.
// We normalize both sides (strip non-digits) before comparing because users
// store phones with all kinds of spacing/symbols.
async function matchVendorByPhone(phone) {
  if (!phone) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const rows = await sbGet("ali4_store", "?key=eq.ali4_companies&select=value");
  if (!rows || rows.length === 0) return null;
  let companies;
  try {
    companies = JSON.parse(rows[0].value);
  } catch {
    return null;
  }
  if (!Array.isArray(companies)) return null;

  for (const c of companies) {
    if (!Array.isArray(c.contacts)) continue;
    for (const ct of c.contacts) {
      if (ct.phone && normalizePhone(ct.phone) === normalized) {
        return { companyId: c.id, contactId: ct.id };
      }
    }
  }
  return null;
}

function normalizePhone(p) {
  if (!p) return null;
  // Strip everything except digits. Also handle leading + by leaving digits only.
  return String(p).replace(/[^\d]/g, "");
}

function guessExtension(mime) {
  if (!mime) return "";
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
  };
  return map[mime.toLowerCase()] || "";
}
