/**
 * Canonical Codex model catalog owned by this companion.
 *
 * The catalog is host-provided. When the account is connected, the live
 * catalog comes from OpenAI's Codex models endpoint so new model families
 * appear without a companion update; the frozen list below is the offline
 * and signed-out fallback. Membership is NOT an account-entitlement
 * guarantee; which model a ChatGPT plan can actually use is decided by the
 * first real request, so Settings must present the list with that caveat.
 *
 * Keep ids identical to the slugs OpenAI's Codex tooling accepts; the label
 * is display-only. Order is preference order.
 */
"use strict";

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

const CATALOG = Object.freeze([
  Object.freeze({ id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }),
  Object.freeze({ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }),
  Object.freeze({ id: "gpt-5.6-luna", label: "GPT-5.6-Luna" }),
  Object.freeze({ id: "gpt-5.5", label: "GPT-5.5" }),
  Object.freeze({ id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" }),
]);

const DEFAULT_MODEL_ID = "gpt-5.6-terra";

const LIVE = Object.freeze({
  ENDPOINT:
    "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
  TIMEOUT_MS: 10_000,
  MAX_MODELS: 32,
});

// Guards the model field of inbound models.validate requests. Anything that
// cannot be a canonical id is rejected as invalid before catalog lookup.
function isValidModelId(value) {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

function findModel(id) {
  if (!isValidModelId(id)) return null;
  const entry = CATALOG.find((model) => model.id === id);
  return entry ? { id: entry.id, label: entry.label } : null;
}

// Fetches the live catalog with the stored credential. Returns the sanitized
// {id, label} list, or null for every failure mode (no usable credential,
// transport error, non-OK status, malformed payload, empty list) so callers
// can fall back to the static catalog without branching on error types.
async function fetchLiveCatalog({
  fetchImpl,
  tokens,
  endpoint = LIVE.ENDPOINT,
  timeoutMs = LIVE.TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function" || typeof tokens?.access_token !== "string" || !tokens.access_token) {
    return null;
  }
  const headers = {
    authorization: `Bearer ${tokens.access_token}`,
    accept: "application/json",
  };
  if (typeof tokens.account_id === "string" && tokens.account_id) {
    headers["chatgpt-account-id"] = tokens.account_id;
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (_error) {
    return null;
  }
  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    return null;
  }
  const entries = Array.isArray(payload?.models) ? payload.models : null;
  if (!entries) return null;

  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    const id = typeof entry?.slug === "string" ? entry.slug : null;
    if (!isValidModelId(id)) continue;
    // Internal tool models (auto-review and friends) are not user choices.
    if (id.startsWith("codex-")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof entry.label === "string" && entry.label.trim()
        ? entry.label.trim().slice(0, 64)
        : id;
    models.push({ id, label });
    if (models.length >= LIVE.MAX_MODELS) break;
  }
  return models.length ? models : null;
}

module.exports = {
  CATALOG,
  DEFAULT_MODEL_ID,
  LIVE,
  isValidModelId,
  findModel,
  fetchLiveCatalog,
};
