/**
 * OAuth mechanics for the YouTube Digest companion's ChatGPT / Codex
 * sign-in. Everything in this module stays inside the companion process:
 * authorization URLs, PKCE verifiers, authorization codes, and tokens must
 * never be returned to the extension, written to the state file, or logged.
 *
 * The flow mirrors the public PKCE flow used by OpenAI's Codex CLI against
 * auth.openai.com: a loopback redirect URI, an S256 code challenge, and a
 * code-for-token exchange. The companion is its own client; no sub2api,
 * proxy, or OpenAI API key is involved.
 */
"use strict";

const crypto = require("crypto");

const OAUTH = Object.freeze({
  ISSUER: "https://auth.openai.com",
  // Public client id of the Codex CLI OAuth app; the same app that grants
  // subscription-backed Codex access to CLI users.
  CLIENT_ID: "app_EMoamEEZ73f0CkXaXp7hrann",
  SCOPE: "openid profile email offline_access",
  CALLBACK_PATH: "/auth/callback",
  PREFERRED_PORT: 1455,
  FALLBACK_PORT: 1457,
  FLOW_TIMEOUT_MS: 10 * 60 * 1000,
  TOKEN_TIMEOUT_MS: 15000,
  MAX_LABEL_LENGTH: 64,
});

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createPkce(randomBytes = crypto.randomBytes) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createState(randomBytes = crypto.randomBytes) {
  return base64url(randomBytes(32));
}

function redirectUriForPort(port) {
  return `http://localhost:${port}${OAUTH.CALLBACK_PATH}`;
}

function buildAuthorizeUrl({
  issuer = OAUTH.ISSUER,
  clientId = OAUTH.CLIENT_ID,
  redirectUri,
  scope = OAUTH.SCOPE,
  challenge,
  state,
}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${issuer}/oauth/authorize?${params.toString()}`;
}

// Classifies the OAuth callback query. Returns a typed outcome; the
// authorization code, when present, stays inside the returned object and is
// consumed by the token exchange immediately.
function validateCallback(searchParams, expectedState) {
  const params =
    searchParams instanceof URLSearchParams
      ? searchParams
      : new URLSearchParams(String(searchParams || ""));

  if (params.get("state") !== expectedState) {
    return { ok: false, error: "state-mismatch" };
  }
  if (params.get("error")) {
    return { ok: false, error: "denied" };
  }
  const code = params.get("code");
  if (!code || code.length > 2048) {
    return { ok: false, error: "missing-code" };
  }
  return { ok: true, code };
}

async function exchangeCodeForTokens({
  fetchImpl = fetch,
  issuer = OAUTH.ISSUER,
  clientId = OAUTH.CLIENT_ID,
  redirectUri,
  code,
  verifier,
  timeoutMs = OAUTH.TOKEN_TIMEOUT_MS,
}) {
  return postTokenRequest({
    fetchImpl,
    url: `${issuer}/oauth/token`,
    timeoutMs,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
}

// Refreshes a stored credential with the refresh-token grant. Used by the
// completion path when the provider rejects an access token; the new tokens
// stay inside the companion and are re-stored only in the Keychain.
async function refreshTokens({
  fetchImpl = fetch,
  issuer = OAUTH.ISSUER,
  clientId = OAUTH.CLIENT_ID,
  refreshToken,
  timeoutMs = OAUTH.TOKEN_TIMEOUT_MS,
}) {
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("token-request-failed: missing refresh token");
  }
  return postTokenRequest({
    fetchImpl,
    url: `${issuer}/oauth/token`,
    timeoutMs,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}

async function postTokenRequest({ fetchImpl, url, timeoutMs, body }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`token-request-failed: ${redact(error?.message || "network error")}`);
  }
  if (!response.ok) {
    throw new Error(`token-endpoint-rejected: http ${response.status}`);
  }
  let tokens;
  try {
    tokens = await response.json();
  } catch (_error) {
    throw new Error("token-endpoint-invalid-response");
  }
  if (
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token
  ) {
    throw new Error("token-endpoint-missing-credentials");
  }
  return tokens;
}

// Extracts the email claim from the id_token JWT so Settings can show a
// masked account label. Decodes locally only; the raw JWT never leaves the
// companion.
function decodeIdTokenEmail(idToken) {
  if (typeof idToken !== "string" || idToken.length > 32768) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" && payload.email.includes("@")
      ? payload.email
      : null;
  } catch (_error) {
    return null;
  }
}

function maskEmail(email) {
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return null;
  }
  const [local, domain] = email.split("@");
  const labels = domain.split(".");
  const tld = labels[labels.length - 1];
  const maskedLocal = `${local[0]}\u2022\u2022\u2022`;
  const maskedDomain = `${labels[0][0]}\u2022\u2022\u2022.${tld}`;
  const label = `${maskedLocal}@${maskedDomain}`;
  return label.length <= OAUTH.MAX_LABEL_LENGTH
    ? label
    : label.slice(0, OAUTH.MAX_LABEL_LENGTH);
}

// Strips credential-shaped values from any text before it can reach the
// state file, a response, or stderr. Known secret values are replaced first
// so accidental echoes collapse to the same marker.
function redact(text, secrets = []) {
  let output = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      output = output.split(secret).join("[redacted]");
    }
  }
  output = output
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return output.slice(0, 200);
}

module.exports = {
  OAUTH,
  createPkce,
  createState,
  redirectUriForPort,
  buildAuthorizeUrl,
  validateCallback,
  exchangeCodeForTokens,
  refreshTokens,
  decodeIdTokenEmail,
  maskEmail,
  redact,
};
