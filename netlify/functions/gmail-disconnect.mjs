// gmail-disconnect
// POST /.netlify/functions/gmail-disconnect
// Body: { email?: string }
//
// Removes the saved token row. Doesn't revoke at Google's end — to do that the
// user goes to myaccount.google.com → Security → Your connections.

import { sbGet, sbUpdate, json, parseBody } from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed; use POST" });
  }

  try {
    const body = parseBody(event);
    let target = body.email;

    if (!target) {
      const rows = await sbGet(
        "ali4_gmail_tokens",
        `?email=not.like.__pending_*&email=not.like.__used_*&select=email&limit=1`,
      );
      if (!rows || rows.length === 0) {
        return json(404, { error: "No connected account to disconnect." });
      }
      target = rows[0].email;
    }

    // Soft-delete: rename row so tokens can no longer be looked up by their
    // original email. This preserves the message history (foreign keys point to
    // company_id, not to the token row).
    await sbUpdate(
      "ali4_gmail_tokens",
      `?email=eq.${encodeURIComponent(target)}`,
      { email: `__disconnected_${target}_${Date.now()}` },
    );

    return json(200, { ok: true, disconnected: target });
  } catch (error) {
    console.error("disconnect failed:", error);
    return json(500, { error: error.message });
  }
};
