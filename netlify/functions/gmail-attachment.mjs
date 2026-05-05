// gmail-attachment
// GET /.netlify/functions/gmail-attachment?messageId=...&attachmentId=...&filename=...&mimeType=...
//
// Fetches a single attachment from Gmail's API and returns it to the browser
// as a binary download. Auth via stored OAuth tokens (refreshed if expired).
//
// Why a Function instead of a direct browser-to-Gmail call:
//   1. Browsers can't talk to Gmail API directly (CORS / OAuth headers needed).
//   2. We don't want OAuth tokens exposed client-side.
//   3. Lets us refresh tokens transparently if expired.

import { sbGet, refreshAccessToken, json } from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});

  try {
    const params = event.queryStringParameters || {};
    const { messageId, attachmentId, filename, mimeType } = params;
    if (!messageId || !attachmentId) {
      return json(400, { error: "messageId and attachmentId required" });
    }

    // Find the active Gmail token row.
    const rows = await sbGet(
      "ali4_gmail_tokens",
      `?email=not.like.__pending_*&email=not.like.__used_*&email=not.like.__disconnected_*&select=*&limit=1`,
    );
    const tokenRow = rows[0];
    if (!tokenRow) return json(404, { error: "No connected Gmail account" });

    const accessToken = await refreshAccessToken(tokenRow);

    // Fetch the attachment payload from Gmail. The 'data' field is base64url-encoded bytes.
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const text = await r.text();
      return json(r.status, { error: "Gmail attachment fetch failed: " + text });
    }
    const data = await r.json();
    if (!data.data) return json(500, { error: "Gmail returned no attachment data" });

    // Decode from URL-safe base64 to binary.
    const normalized = data.data.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const buffer = Buffer.from(normalized + padding, "base64");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${(filename || "attachment").replace(/"/g, "")}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, max-age=300", // 5 min browser cache
        "Access-Control-Allow-Origin": "*",
      },
      body: buffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error("gmail-attachment failed:", e);
    return json(500, { error: e.message });
  }
};
