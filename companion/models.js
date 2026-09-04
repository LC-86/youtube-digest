/**
 * Canonical Codex model catalog owned by this companion.
 *
 * The catalog is host-provided and deliberately curated: these are the
 * canonical model ids the companion knows how to request for YouTube
 * Digest completions. Membership is NOT an account-entitlement guarantee;
 * which of these a ChatGPT plan can actually use is decided by the first
 * real request, so Settings must present the list with that caveat.
 *
 * Keep ids identical to the names OpenAI's Codex tooling accepts; the
 * label is display-only. Order is preference order.
 */
"use strict";

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

const CATALOG = Object.freeze([
  Object.freeze({ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }),
  Object.freeze({ id: "gpt-5.2-codex", label: "GPT-5.2 Codex" }),
  Object.freeze({ id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" }),
  Object.freeze({ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }),
  Object.freeze({ id: "gpt-5.1", label: "GPT-5.1" }),
  Object.freeze({ id: "gpt-5-codex", label: "GPT-5 Codex" }),
]);

const DEFAULT_MODEL_ID = "gpt-5.3-codex";

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

module.exports = {
  CATALOG,
  DEFAULT_MODEL_ID,
  isValidModelId,
  findModel,
};
