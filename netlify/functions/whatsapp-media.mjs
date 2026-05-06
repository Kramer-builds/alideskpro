// whatsapp-media
// GET /.netlify/functions/whatsapp-media?mediaUrl=...&filename=...&mimeType=...
//
// Twilio media URLs require Basic auth with the Account SID + Auth Token.
// Browsers can't include those credentials safely, so we proxy through here.
// Streams the bytes to the client as a download.

import { getTwilioEnv, json } from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});

  try {
    const params = event.queryStringParameters || {};
    const { mediaUrl, filename, mimeType } = params;
    if (!mediaUrl) return json(400, { error: "mediaUrl required" });

    // Validate the URL is actually a Twilio media URL — don't proxy arbitrary URLs.
    if (!mediaUrl.startsWith("https://api.twilio.com/")) {
      return json(400, { error: "Only Twilio media URLs allowed" });
    }

    const env = getTwilioEnv();
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");

    const r = await fetch(mediaUrl, {
      headers: { Authorization: "Basic " + auth },
    });
    if (!r.ok) {
      const text = await r.text();
      return json(r.status, { error: "Twilio media fetch failed: " + text });
    }
    const buffer = Buffer.from(await r.arrayBuffer());
    const responseMime = mimeType || r.headers.get("content-type") || "application/octet-stream";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": responseMime,
        "Content-Disposition": `attachment; filename="${(filename || "whatsapp-media").replace(/"/g, "")}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
      body: buffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error("whatsapp-media failed:", e);
    return json(500, { error: e.message });
  }
};
