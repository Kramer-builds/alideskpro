// gmail-sync-scheduled
// Netlify Scheduled Function. Runs server-side on a cron schedule (every 5 minutes
// per netlify.toml) and triggers gmail-sync regardless of whether the browser is open.
//
// This delegates to the same logic as gmail-sync (no duplication) by calling the
// existing handler. Keeps a single source of truth for sync behavior.

import { handler as syncHandler } from "./gmail-sync.mjs";

export const handler = async (event, context) => {
  console.log("Scheduled sync starting at", new Date().toISOString());
  try {
    // Call the regular sync handler with an empty body (defaults to first connected account, 25 messages).
    const result = await syncHandler({
      httpMethod: "POST",
      body: JSON.stringify({ maxMessages: 25 }),
      headers: {},
    });
    console.log("Scheduled sync result:", result.statusCode, result.body?.slice(0, 200));
    return { statusCode: 200 };
  } catch (e) {
    // Log loudly — Netlify dashboard will surface this in function logs.
    console.error("Scheduled sync failed:", e.message);
    // Return 200 anyway so Netlify doesn't endlessly retry; we'll catch it next interval.
    return { statusCode: 200, body: e.message };
  }
};
