/**
 * Non-secret authorization state for the companion.
 *
 * The state file records only what Settings needs to render a status: which
 * phase an account connection is in and, after a finished attempt, a typed
 * outcome from a fixed allowlist. Authorization URLs, codes, PKCE verifiers,
 * and tokens never appear here; those live in process memory or the Keychain.
 *
 * Every native-messaging request spawns a fresh host process, so this file
 * is also the rendezvous between the short-lived host and the detached
 * auth worker that owns the pending loopback callback server.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const AUTH_STATE = Object.freeze({
  FILE_NAME: "auth-state.json",
  MAX_FILE_BYTES: 4096,
  PHASES: Object.freeze(["authorizing", "idle", "reconnect-required"]),
  OUTCOMES: Object.freeze([
    "connected",
    "expired",
    "denied",
    "cancelled",
    "state-mismatch",
    "error",
  ]),
});

function defaultStateDir() {
  return (
    process.env.YTD_COMPANION_STATE_DIR ||
    path.join(
      process.env.HOME || "",
      "Library",
      "Application Support",
      "YouTube Digest Companion",
    )
  );
}

function sanitizeMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!AUTH_STATE.PHASES.includes(value.phase)) return null;
  const marker = { phase: value.phase };
  if (Number.isFinite(value.expires_at)) marker.expires_at = value.expires_at;
  if (Number.isFinite(value.updated_at)) marker.updated_at = value.updated_at;
  if (value.outcome && typeof value.outcome === "object") {
    if (AUTH_STATE.OUTCOMES.includes(value.outcome.kind)) {
      marker.outcome = { kind: value.outcome.kind };
      if (
        typeof value.outcome.reason === "string" &&
        value.outcome.reason.length <= 200
      ) {
        marker.outcome.reason = value.outcome.reason;
      }
    }
  }
  return marker;
}

function createAuthState({ dir = defaultStateDir(), fsApi = fs } = {}) {
  const filePath = path.join(dir, AUTH_STATE.FILE_NAME);

  function ensureDir() {
    fsApi.mkdirSync(dir, { recursive: true });
  }

  function read() {
    let raw;
    try {
      const stats = fsApi.statSync(filePath);
      if (!stats.isFile() || stats.size > AUTH_STATE.MAX_FILE_BYTES) return null;
      raw = fsApi.readFileSync(filePath, "utf8");
    } catch (_error) {
      return null;
    }
    try {
      return sanitizeMarker(JSON.parse(raw));
    } catch (_error) {
      return null;
    }
  }

  // Atomic write (temp file + rename) so a concurrently reading host never
  // observes a torn marker.
  function write(marker) {
    const sanitized = sanitizeMarker({
      ...marker,
      updated_at: Number.isFinite(marker?.updated_at) ? marker.updated_at : Date.now(),
    });
    if (!sanitized) throw new Error("auth-state-invalid-marker");
    ensureDir();
    const tempPath = `${filePath}.tmp-${process.pid}`;
    fsApi.writeFileSync(tempPath, JSON.stringify(sanitized), "utf8");
    fsApi.renameSync(tempPath, filePath);
    return sanitized;
  }

  function clear() {
    try {
      fsApi.rmSync(filePath, { force: true });
    } catch (_error) {
      // A missing or already-removed marker is the intended end state.
    }
  }

  return { dir, filePath, read, write, clear };
}

// Pure phase resolution shared by every host process.
//
// "authorizing-expired" is a healing signal: the marker says a flow is in
// flight but its deadline passed (the worker died or never started), so the
// caller should rewrite the marker to a terminal expired outcome.
function resolveAccountPhase(marker, hasCredentials, now) {
  if (
    marker?.phase === "authorizing" &&
    Number.isFinite(marker.expires_at) &&
    now < marker.expires_at
  ) {
    return "authorizing";
  }
  if (marker?.phase === "authorizing") return "authorizing-expired";
  if (marker?.phase === "reconnect-required") return "reconnect-required";
  return hasCredentials ? "connected" : "signed-out";
}

// Writes the single terminal-marker shape used by host and worker: an idle
// phase carrying a typed outcome. Keeping one builder avoids drift between
// the five call sites that finish a flow.
function markOutcome(authState, outcome, now = Date.now()) {
  return authState.write({ phase: "idle", outcome, updated_at: now });
}

// Called when a stored refresh credential is rejected; a later protocol step
// (model requests) transitions the account here instead of silently signing
// the user out.
function markReconnectRequired(authState, now = Date.now()) {
  return authState.write({ phase: "reconnect-required", updated_at: now });
}

module.exports = {
  AUTH_STATE,
  createAuthState,
  defaultStateDir,
  sanitizeMarker,
  resolveAccountPhase,
  markOutcome,
  markReconnectRequired,
};
