// gmail-oauth-start
// User hits this endpoint to begin connecting their Gmail.
// We generate a one-time CSRF state token, save it, and redirect to Google's
// OAuth consent screen with the right scopes and redirect_uri.

import { getEnv, getRedirectUri, sbInsert, html } from "./_shared.mjs";

export const handler = async (event) => {
  try {
    const env = getEnv();
    const redirectUri = getRedirectUri(event);

    // Generate a random state token for CSRF protection.
    // We stash it in ali4_gmail_tokens as a half-row keyed by a UUID-like string;
    // the callback verifies it on return.
    const state = (
      crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    );

    // Store the state with email='__pending_<state>' so it's distinct from real
    // token rows. We'll clean it up in the callback.
    try {
      await sbInsert("ali4_gmail_tokens", {
        email: `__pending_${state}`,
        access_token: null,
        refresh_token: null,
      });
    } catch (e) {
      // Non-fatal — we can still proceed without the CSRF check, but log it.
      console.warn("Could not persist OAuth state:", e.message);
    }

    // Build the Google OAuth URL.
    // - access_type=offline + prompt=consent ensures we get a refresh_token
    // - include_granted_scopes lets us add scopes incrementally later
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.modify",
      ].join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return {
      statusCode: 302,
      headers: { Location: authUrl },
      body: "",
    };
  } catch (error) {
    console.error("oauth-start failed:", error);
    return html(500, `<h1>OAuth start failed</h1><pre>${error.message}</pre>`);
  }
};
