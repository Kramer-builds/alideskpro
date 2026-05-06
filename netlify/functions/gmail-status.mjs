// gmail-status
// GET /.netlify/functions/gmail-status
// Returns: { connected: boolean, email?: string, lastSyncedAt?: string }
//
// Lets the frontend tell whether to show "Connect Gmail" or the actual inbox.
// Doesn't expose any tokens.

import { sbGet, json } from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});

  try {
    // Find the first active (not pending, not used, not disconnected) token row.
    const rows = await sbGet(
      "ali4_gmail_tokens",
      `?email=not.like.__pending_*&email=not.like.__used_*&email=not.like.__disconnected_*&select=email,last_synced_at&limit=1`,
    );
    if (!rows || rows.length === 0) {
      return json(200, { connected: false });
    }
    const r = rows[0];
    return json(200, {
      connected: true,
      email: r.email,
      lastSyncedAt: r.last_synced_at,
    });
  } catch (error) {
    console.error("status failed:", error);
    return json(500, { error: error.message });
  }
};
