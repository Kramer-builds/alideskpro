// Shared helpers for AliDeskPro Gmail Functions
// Imported by oauth-start, oauth-callback, sync, and send.

// Read environment variables. These are set in Netlify Environment Variables.
// We throw early if any are missing so deploys fail loudly instead of returning
// confusing runtime errors when the integration is used.
export function getEnv() {
  const req = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY"];
  const missing = req.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error("Missing required env vars: " + missing.join(", "));
  }
  return {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  };
}

// Build the OAuth redirect URI for the current request.
// We support three deploy contexts: local dev (localhost:8888), the random
// netlify subdomain, and the production custom domain alideskpro.com.
// All three are registered in the Google Cloud OAuth Client.
export function getRedirectUri(eventOrUrl) {
  // eventOrUrl can be a Netlify function event (with `headers.host` or `rawUrl`)
  // or a plain string URL when called from elsewhere.
  let host;
  if (typeof eventOrUrl === "string") {
    host = new URL(eventOrUrl).host;
  } else if (eventOrUrl && eventOrUrl.headers) {
    host = eventOrUrl.headers.host || eventOrUrl.headers.Host;
  }
  // Localhost gets http; everywhere else https.
  const proto = host && host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}/.netlify/functions/gmail-oauth-callback`;
}

// Lightweight Supabase REST helpers. We don't use the official supabase-js
// SDK here to keep the function bundle small. PostgREST is a simple HTTP API.
export async function sbGet(table, query = "") {
  const env = getEnv();
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${query}`;
  const r = await fetch(url, {
    headers: {
      "apikey": env.SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + env.SUPABASE_ANON_KEY,
    },
  });
  if (!r.ok) throw new Error(`Supabase GET failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function sbInsert(table, row) {
  const env = getEnv();
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase INSERT failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function sbUpsert(table, row, onConflict) {
  const env = getEnv();
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase UPSERT failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function sbUpdate(table, query, patch) {
  const env = getEnv();
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: "PATCH",
    headers: {
      "apikey": env.SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Supabase UPDATE failed: ${r.status} ${await r.text()}`);
  return r.text();
}

// Standard JSON response helper.
export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

// HTML response helper (used by the OAuth callback to render a friendly
// "you're connected, you can close this tab" page).
export function html(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body,
  };
}

// Parse the JSON body of an incoming POST request.
export function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

// Given the saved tokens from Supabase, return a refreshed access_token if
// expired. Updates Supabase if a refresh actually happens.
export async function refreshAccessToken(tokenRow) {
  const now = Date.now();
  const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
  // Refresh if expired or expiring within 60 seconds.
  if (expiresAt > now + 60_000) return tokenRow.access_token;

  const env = getEnv();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!r.ok) throw new Error(`Token refresh failed: ${r.status} ${await r.text()}`);
  const data = await r.json();

  // Persist the new access token + new expiry.
  const newExpiresAt = new Date(now + data.expires_in * 1000).toISOString();
  await sbUpdate(
    "ali4_gmail_tokens",
    `?email=eq.${encodeURIComponent(tokenRow.email)}`,
    { access_token: data.access_token, expires_at: newExpiresAt },
  );
  return data.access_token;
}
