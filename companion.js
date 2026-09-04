/**
 * Versioned connection contract between YouTube Digest and the local
 * Codex companion over Chrome Native Messaging.
 *
 * The companion owns all sensitive work. This module only classifies the
 * companion's observable state (ready, unavailable, incompatible) so
 * Settings can show an actionable status. It never handles credentials.
 */
var YTD_COMPANION = (() => {
  const HOST_NAME = "com.youtube_digest.companion";
  const PROTOCOL_VERSION = 1;
  const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1]);
  const DEFAULT_TIMEOUT_MS = 5000;
  const MAX_HOST_VERSION_LENGTH = 32;

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

  function statusRequest() {
    return { v: PROTOCOL_VERSION, type: "status" };
  }

  function normalizeHostVersion(value) {
    return typeof value === "string" && value.length <= MAX_HOST_VERSION_LENGTH
      ? value
      : null;
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

  function classifyStatusResponse(response) {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return {
        state: STATUS.INCOMPATIBLE,
        reason: REASON.PROTOCOL_UNSUPPORTED,
        found: null,
      };
    }
    if (
      !Number.isInteger(response.v) ||
      !SUPPORTED_PROTOCOL_VERSIONS.includes(response.v)
    ) {
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
    return {
      state: STATUS.READY,
      protocol: response.v,
      hostVersion: normalizeHostVersion(response.companionVersion),
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

  function checkStatus({
    runtime,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof runtime?.sendNativeMessage !== "function") {
      return Promise.resolve({
        state: STATUS.UNAVAILABLE,
        reason: REASON.BROWSER_UNSUPPORTED,
      });
    }

    const timeout = new Promise((resolve) => {
      setTimeout(resolve, timeoutMs, { timedOut: true });
    });

    return Promise.race([
      sendNativeRequest(runtime, statusRequest()),
      timeout,
    ]).then((outcome) => {
      if (outcome.timedOut) {
        return {
          state: STATUS.UNAVAILABLE,
          reason: REASON.HOST_NOT_RESPONDING,
        };
      }
      if (outcome.error) {
        return {
          state: STATUS.UNAVAILABLE,
          reason: classifyChromeError(outcome.error),
        };
      }
      return classifyStatusResponse(outcome.response);
    });
  }

  return {
    HOST_NAME,
    PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    DEFAULT_TIMEOUT_MS,
    STATUS,
    REASON,
    statusRequest,
    classifyChromeError,
    classifyStatusResponse,
    checkStatus,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_COMPANION;
}
