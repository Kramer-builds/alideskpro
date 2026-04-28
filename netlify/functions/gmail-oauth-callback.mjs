// gmail-oauth-callback
// Google redirects here after the user grants permission.
// We exchange the auth code for tokens, identify the user's email, and persist
// the tokens to ali4_gmail_tokens for future syncs.

import {
  getEnv,
  getRedirectUri,
  sbGet,
  sbUpsert,
  sbUpdate,
  html,
} from "./_shared.mjs";

export const handler = async (event) => {
  try {
    const env = getEnv();
    const params = event.queryStringParameters || {};
    const { code, state, error: oauthError } = params;

    if (oauthError) {
      return html(400, errorPage(`Google returned error: ${oauthError}`));
    }
    if (!code || !state) {
      return html(400, errorPage("Missing authorization code or state."));
    }

    // CSRF check — the state must match a row we created in oauth-start.
    const pendingEmail = `__pending_${state}`;
    const pendingRows = await sbGet(
      "ali4_gmail_tokens",
      `?email=eq.${encodeURIComponent(pendingEmail)}&select=email`,
    );
    if (!pendingRows || pendingRows.length === 0) {
      return html(400, errorPage("Invalid or expired state token. Please try connecting again."));
    }
    // Clean up the pending row.
    await sbUpdate(
      "ali4_gmail_tokens",
      `?email=eq.${encodeURIComponent(pendingEmail)}`,
      { email: `__used_${state}_${Date.now()}` },
    );

    // Exchange the code for tokens.
    const redirectUri = getRedirectUri(event);
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      return html(500, errorPage(`Token exchange failed (${tokenResp.status}): ${text}`));
    }

    const tokens = await tokenResp.json();
    // tokens shape: { access_token, refresh_token, expires_in, scope, token_type, id_token }

    if (!tokens.refresh_token) {
      // This happens if the user previously authorized this app and Google
      // doesn't re-issue a refresh token. We forced prompt=consent in oauth-start
      // to mitigate, but this can still occur.
      return html(400, errorPage(
        "Google didn't return a refresh token. Please disconnect this app from your Google Account " +
        "(myaccount.google.com → Security → Your connections → AliDeskPro → Remove Access), " +
        "then try connecting again."
      ));
    }

    // Identify which email this token belongs to. We hit the userinfo endpoint
    // with the new access_token to get the email of the authenticated account.
    const userinfoResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userinfoResp.ok) {
      return html(500, errorPage("Could not identify the connected Gmail account."));
    }
    const userinfo = await userinfoResp.json();
    const email = userinfo.email;
    if (!email) {
      return html(500, errorPage("Connected Google account has no email address."));
    }

    // Persist tokens. Upsert so re-authorizing the same address overwrites.
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await sbUpsert(
      "ali4_gmail_tokens",
      {
        email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        last_synced_at: null,
        history_id: null,
      },
      "email",
    );

    // Friendly success page. Closes itself if opened in a popup, otherwise
    // navigates back to the Inbox page.
    return html(200, successPage(email));
  } catch (error) {
    console.error("oauth-callback failed:", error);
    return html(500, errorPage(error.message));
  }
};

// --- HTML page templates ---

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #F0F4F8; color: #111827; margin: 0;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 12px; border: 1px solid #E2E8F0;
            padding: 32px 36px; max-width: 480px; width: 100%; box-shadow: 0 4px 12px rgba(0,0,0,0.04); }
    h1 { color: #2C3E6B; margin: 0 0 8px 0; font-size: 22px; }
    p { color: #374151; line-height: 1.55; font-size: 14px; }
    .pill { display: inline-block; background: #E0E7FF; color: #3730A3;
            padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600;
            font-family: monospace; }
    .err { background: #FEF2F2; border-left: 4px solid #EF4444; padding: 12px 14px;
           border-radius: 6px; margin-top: 12px; color: #991B1B; font-size: 13px; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 12px;
          background: #F8FAFC; padding: 10px; border-radius: 6px; }
    button { background: #2C3E6B; color: white; border: none; border-radius: 8px;
             padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
             margin-top: 16px; font-family: inherit; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;
}

function successPage(email) {
  return pageShell("Gmail connected — AliDeskPro", `
    <h1>✓ Connected</h1>
    <p>AliDeskPro is now linked to <span class="pill">${escapeHtml(email)}</span>.</p>
    <p>You can close this tab and return to AliDeskPro. Click "Sync Now" on the Inbox page to pull your latest vendor messages.</p>
    <button onclick="window.close(); window.location.href='/';">Close & Return</button>
    <script>
      // Auto-close if opened in a popup; otherwise leave the page.
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({type:'gmail_connected', email:${JSON.stringify(email)}}, '*');
          setTimeout(() => window.close(), 1500);
        }
      } catch (e) {}
    </script>
  `);
}

function errorPage(message) {
  return pageShell("Connection failed — AliDeskPro", `
    <h1>Couldn't connect Gmail</h1>
    <p>Something went wrong while connecting your inbox. Details:</p>
    <div class="err">${escapeHtml(message)}</div>
    <button onclick="window.location.href='/';">Back to AliDeskPro</button>
  `);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
