/**
 * Versioned connection contract between YouTube Digest and the local
 * Codex companion over Chrome Native Messaging.
 *
 * The companion owns all sensitive work. This module classifies the
 * companion's observable state (ready, unavailable, incompatible) and its
 * account authorization phase (signed-out, authorizing, connected,
 * reconnect-required) so Settings can render a status and trigger the
 * user-initiated actions: begin authorization, cancel, and disconnect.
 *
 * It never handles credentials: responses are normalized through a
 * whitelist, so authorization URLs, codes, and tokens cannot reach
 * extension storage or UI even if a broken host tried to include them.
 */
var YTD_COMPANION = (() => {
  const HOST_NAME = "com.youtube_digest.companion";
  const PROTOCOL_VERSION = 1;
  const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1]);
  const DEFAULT_TIMEOUT_MS = 5000;
  const MAX_HOST_VERSION_LENGTH = 32;
  const MAX_ERROR_CODE_LENGTH = 40;
  const MAX_CAPABILITY_LENGTH = 24;
  const MAX_ACCOUNT_LABEL_LENGTH = 64;

  const STATUS = Object.freeze({
    CHECKING: "checking",
    READY: "ready",
    UNAVAILABLE: "unavailable",
    INCOMPATIBLE: "incompatible",
  });

  const REASON = Object.freeze({
    BROWSER_UNSUPPORTED: "browser-unsupported",
    HOST_NOT_INSTALLED: "host-not-installed",
    HOST_NOT_ALLOWED: "host-not-allowed",
    HOST_NOT_RUNNING: "host-not-running",
    HOST_NOT_RESPONDING: "host-not-responding",
    PROTOCOL_UNSUPPORTED: "protocol-unsupported",
    HOST_ERROR: "host-error",
  });

  const AUTH_PHASE = Object.freeze({
    SIGNED_OUT: "signed-out",
    AUTHORIZING: "authorizing",
    CONNECTED: "connected",
    RECONNECT_REQUIRED: "reconnect-required",
  });

  const AUTH_PHASES = Object.freeze(Object.values(AUTH_PHASE));

  const AUTH_OUTCOMES = Object.freeze([
    "connected",
    "expired",
    "denied",
    "cancelled",
    "state-mismatch",
    "error",
  ]);

  const AUTH_ACTIONS = Object.freeze({
    BEGIN: "auth.begin",
    CANCEL: "auth.cancel",
    DISCONNECT: "disconnect",
  });

  function statusRequest() {
    return { v: PROTOCOL_VERSION, type: "status" };
  }

  function normalizeHostVersion(value) {
    return typeof value === "string" && value.length <= MAX_HOST_VERSION_LENGTH
      ? value
      : null;
  }

  function normalizeCapabilities(value) {
    if (!Array.isArray(value)) return [];
    if (
      !value.every(
        (item) =>
          typeof item === "string" &&
          item.length > 0 &&
          item.length <= MAX_CAPABILITY_LENGTH &&
          /^[a-z0-9-]+$/.test(item),
      )
    ) {
      return [];
    }
    return [...value];
  }

  // Whitelists the account fields Settings may see. Anything else a host
  // sends (a URL, a code, a token) is dropped here.
  function sanitizeAuth(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (!AUTH_PHASES.includes(value.phase)) return null;
    const auth = { phase: value.phase };
    if (typeof value.accountLabel === "string" && value.accountLabel.length <= MAX_ACCOUNT_LABEL_LENGTH) {
      auth.accountLabel = value.accountLabel;
    }
    if (AUTH_OUTCOMES.includes(value.lastOutcome)) {
      auth.lastOutcome = value.lastOutcome;
    }
    return auth;
  }

  // Chrome reports native messaging failures through localized error text,
  // so classification matches keywords rather than exact strings. Every
  // branch resolves to UNAVAILABLE; only the recovery copy differs.
  function classifyChromeError(message) {
    const text = String(message || "").toLowerCase();
    if (text.includes("forbidden")) return REASON.HOST_NOT_ALLOWED;
    if (text.includes("not found")) return REASON.HOST_NOT_INSTALLED;
    if (text.includes("failed to start") || text.includes("exited"))
      return REASON.HOST_NOT_RUNNING;
    if (text.includes("communicating")) return REASON.HOST_NOT_RESPONDING;
    return REASON.HOST_ERROR;
  }

  function normalizeErrorCode(value) {
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_ERROR_CODE_LENGTH &&
      /^[a-z0-9-]+$/.test(value)
      ? value
      : REASON.HOST_ERROR;
  }

  function hasUnsupportedProtocol(response) {
    return (
      !Number.isInteger(response.v) ||
      !SUPPORTED_PROTOCOL_VERSIONS.includes(response.v)
    );
  }

  function classifyStatusResponse(response) {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return {
        state: STATUS.INCOMPATIBLE,
        reason: REASON.PROTOCOL_UNSUPPORTED,
        found: null,
      };
    }
    if (hasUnsupportedProtocol(response)) {
      return {
        state: STATUS.INCOMPATIBLE,
        reason: REASON.PROTOCOL_UNSUPPORTED,
        found: Number.isInteger(response.v) ? response.v : null,
      };
    }
    if (response.ok !== true) {
      return { state: STATUS.UNAVAILABLE, reason: REASON.HOST_ERROR };
    }
    // A host that answers in a supported protocol but reports itself not
    // ready is reachable, not compatible-ready; Settings must not claim Ready.
    if (typeof response.status === "string" && response.status !== "ready") {
      return { state: STATUS.UNAVAILABLE, reason: REASON.HOST_ERROR };
    }
    const capabilities = normalizeCapabilities(response.capabilities);
    return {
      state: STATUS.READY,
      protocol: response.v,
      hostVersion: normalizeHostVersion(response.companionVersion),
      capabilities,
      authSupported: capabilities.includes("auth"),
      auth: sanitizeAuth(response.auth),
    };
  }

  function sendNativeRequest(runtime, message) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      try {
        runtime.sendNativeMessage(HOST_NAME, message, (response) => {
          const error = runtime.lastError
            ? String(runtime.lastError.message || "")
            : "";
          settle(error ? { error } : { response });
        });
      } catch (error) {
        settle({ error: String(error?.message || error) });
      }
    });
  }

  function requestWithTimeout({ runtime, message, timeoutMs }) {
    const timeout = new Promise((resolve) => {
      setTimeout(resolve, timeoutMs, { timedOut: true });
    });
    return Promise.race([
      sendNativeRequest(runtime, message),
      timeout,
    ]).then((outcome) => {
      if (outcome.timedOut) {
        return { reason: REASON.HOST_NOT_RESPONDING };
      }
      if (outcome.error) {
        return { reason: classifyChromeError(outcome.error) };
      }
      return { response: outcome.response };
    });
  }

  async function checkStatus({
    runtime,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof runtime?.sendNativeMessage !== "function") {
      return {
        state: STATUS.UNAVAILABLE,
        reason: REASON.BROWSER_UNSUPPORTED,
      };
    }

    const outcome = await requestWithTimeout({
      runtime,
      message: statusRequest(),
      timeoutMs,
    });
    if (outcome.reason) return { state: STATUS.UNAVAILABLE, reason: outcome.reason };
    return classifyStatusResponse(outcome.response);
  }

  // Shared path for auth.begin / auth.cancel / disconnect. Returns
  // { ok: true, auth } on success or { ok: false, reason } for Settings.
  async function runAuthAction(action, { runtime, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof runtime?.sendNativeMessage !== "function") {
      return { ok: false, reason: REASON.BROWSER_UNSUPPORTED };
    }
    const outcome = await requestWithTimeout({
      runtime,
      message: { v: PROTOCOL_VERSION, type: action },
      timeoutMs,
    });
    if (outcome.reason) return { ok: false, reason: outcome.reason };

    const response = outcome.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return { ok: false, reason: REASON.HOST_ERROR };
    }
    if (hasUnsupportedProtocol(response)) {
      return { ok: false, reason: REASON.PROTOCOL_UNSUPPORTED };
    }
    if (response.ok !== true) {
      return { ok: false, reason: normalizeErrorCode(response.error) };
    }
    const auth = sanitizeAuth(response.auth);
    if (!auth) return { ok: false, reason: REASON.HOST_ERROR };
    return { ok: true, auth };
  }

  function beginAuthorization(options) {
    return runAuthAction(AUTH_ACTIONS.BEGIN, options);
  }

  function cancelAuthorization(options) {
    return runAuthAction(AUTH_ACTIONS.CANCEL, options);
  }

  function disconnectAccount(options) {
    return runAuthAction(AUTH_ACTIONS.DISCONNECT, options);
  }

  return {
    HOST_NAME,
    PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    DEFAULT_TIMEOUT_MS,
    STATUS,
    REASON,
    AUTH_PHASE,
    AUTH_PHASES,
    AUTH_OUTCOMES,
    AUTH_ACTIONS,
    statusRequest,
    classifyChromeError,
    classifyStatusResponse,
    normalizeCapabilities,
    sanitizeAuth,
    checkStatus,
    beginAuthorization,
    cancelAuthorization,
    disconnectAccount,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_COMPANION;
}
