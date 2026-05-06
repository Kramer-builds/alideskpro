// whatsapp-status
// GET /.netlify/functions/whatsapp-status
// Returns: { configured: boolean, fromNumber?: string }

import { json } from "./_shared.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});

  const hasCredentials = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  return json(200, {
    configured: hasCredentials,
    fromNumber: hasCredentials ? "+1 929 399 4010" : null,
  });
};
