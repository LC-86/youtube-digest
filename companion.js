/**
 * Versioned connection contract between YouTube Digest and the local
 * Codex companion over Chrome Native Messaging.
 *
 * The companion owns all sensitive work. This module classifies the
 * companion's observable state (ready, unavailable, incompatible), its
 * account authorization phase (signed-out, authorizing, connected,
 * reconnect-required), and its model catalog, so Settings can render a
 * status and trigger the user-initiated actions: begin authorization,
 * cancel, disconnect, get models, and validate a saved model.
 *
 * It never handles credentials: responses are normalized through a
 * whitelist, so authorization URLs, codes, and tokens cannot reach
 * extension storage or UI even if a broken host tried to include them.
 * Completion replies are whitelisted the same way, down to their text.
 */
var YTD_COMPANION = (() => {
  const HOST_NAME = "com.youtube_digest.companion";
  const PROTOCOL_VERSION = 1;
  const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1]);
  const DEFAULT_TIMEOUT_MS = 5000;
  // A Digest completion is a full transcript analysis, so its transport
  // timeout matches the provider hard cap instead of the control requests.
  const DEFAULT_COMPLETION_TIMEOUT_MS = 120_000;
  const MAX_HOST_VERSION_LENGTH = 32;
  const MAX_ERROR_CODE_LENGTH = 40;
  const MAX_CAPABILITY_LENGTH = 24;
  const MAX_ACCOUNT_LABEL_LENGTH = 64;
  const MAX_MODEL_LABEL_LENGTH = 64;
  const MAX_CATALOG_MODELS = 32;
  const MAX_COMPLETION_TEXT_CHARS = 400_000;
  const MAX_COMPLETION_MESSAGES = 16;
  const MAX_COMPLETION_PROMPT_CHARS = 1_000_000;

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
    CATALOG_MALFORMED: "catalog-malformed",
    INVALID_REQUEST: "invalid-request",
    COMPLETION_MALFORMED: "completion-malformed",
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

  const MODELS_ACTIONS = Object.freeze({
    LIST: "models.list",
    VALIDATE: "models.validate",
  });

  const COMPLETION_ACTIONS = Object.freeze({
    CREATE: "completion.create",
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

  // Whitelists one catalog entry down to its canonical id and display
  // label. Extra fields a host might add (endpoints, tokens) are dropped.
  function sanitizeModel(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)
    ) {
      return null;
    }
    const model = { id: value.id };
    if (value.label !== undefined) {
      if (
        typeof value.label !== "string" ||
        value.label.length === 0 ||
        value.label.length > MAX_MODEL_LABEL_LENGTH
      ) {
        return null;
      }
      model.label = value.label;
    }
    return model;
  }

  // A catalog is either fully well-formed or rejected as malformed: a
  // partially usable list would let a broken host steer model selection.
  // Duplicate ids and oversized lists fail the same way.
  function sanitizeCatalog(value) {
    if (!Array.isArray(value) || value.length === 0) return null;
    if (value.length > MAX_CATALOG_MODELS) return null;
    const models = [];
    const seen = new Set();
    for (const entry of value) {
      const model = sanitizeModel(entry);
      if (!model || seen.has(model.id)) return null;
      seen.add(model.id);
      models.push(model);
    }
    return models;
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
      modelsSupported: capabilities.includes("models"),
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

  // Shared transport envelope for every one-shot request (auth and model
  // actions alike). Resolves to { response } or { reason } for Settings.
  async function sendContractRequest({ runtime, message, timeoutMs }) {
    if (typeof runtime?.sendNativeMessage !== "function") {
      return { reason: REASON.BROWSER_UNSUPPORTED };
    }
    const outcome = await requestWithTimeout({ runtime, message, timeoutMs });
    if (outcome.reason) return { reason: outcome.reason };

    const response = outcome.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return { reason: REASON.HOST_ERROR };
    }
    if (hasUnsupportedProtocol(response)) {
      return { reason: REASON.PROTOCOL_UNSUPPORTED };
    }
    return { response };
  }

  // Shared path for auth.begin / auth.cancel / disconnect. Returns
  // { ok: true, auth } on success or { ok: false, reason } for Settings.
  async function runAuthAction(action, { runtime, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const outcome = await sendContractRequest({
      runtime,
      message: { v: PROTOCOL_VERSION, type: action },
      timeoutMs,
    });
    if (outcome.reason) return { ok: false, reason: outcome.reason };
    if (outcome.response.ok !== true) {
      return { ok: false, reason: normalizeErrorCode(outcome.response.error) };
    }
    const auth = sanitizeAuth(outcome.response.auth);
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

  // Shared validation path for models.list and models.validate on top of
  // sendContractRequest. Returns { ok: true, ...payload } or
  // { ok: false, reason } with the same reason vocabulary as the auth
  // actions, plus catalog-malformed when an ok:true host reply still fails
  // the catalog whitelist.
  async function runModelsAction(action, { runtime, model, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const message = { v: PROTOCOL_VERSION, type: action };
    if (action === MODELS_ACTIONS.VALIDATE) {
      message.model = model;
    }
    const outcome = await sendContractRequest({ runtime, message, timeoutMs });
    if (outcome.reason) return { ok: false, reason: outcome.reason };

    const response = outcome.response;
    if (response.ok !== true) {
      return { ok: false, reason: normalizeErrorCode(response.error) };
    }
    if (action === MODELS_ACTIONS.LIST) {
      const models = sanitizeCatalog(response.models);
      if (!models) return { ok: false, reason: REASON.CATALOG_MALFORMED };
      // Reuse the entry sanitizer as a bare-id predicate: the default is
      // only reported when it is a well-formed member of the catalog.
      const defaultModel =
        typeof response.defaultModel === "string"
          ? sanitizeModel({ id: response.defaultModel })
          : null;
      return {
        ok: true,
        models,
        defaultModel: defaultModel && models.some((entry) => entry.id === defaultModel.id)
          ? defaultModel.id
          : null,
      };
    }
    const validated = sanitizeModel(response.model);
    if (!validated) return { ok: false, reason: REASON.HOST_ERROR };
    return { ok: true, model: validated };
  }

  function requestModelCatalog(options) {
    return runModelsAction(MODELS_ACTIONS.LIST, options);
  }

  function validateModel({ model, ...options } = {}) {
    return runModelsAction(MODELS_ACTIONS.VALIDATE, { ...options, model });
  }

  // Whitelists the outbound prompt pair. The host re-validates; this keeps
  // oversized transcripts and junk roles from ever crossing the wire.
  function normalizeOutboundMessages(messages) {
    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.length > MAX_COMPLETION_MESSAGES
    ) {
      return null;
    }
    const normalized = [];
    let totalChars = 0;
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return null;
      }
      if (message.role !== "system" && message.role !== "user") return null;
      if (typeof message.content !== "string" || message.content.length === 0) {
        return null;
      }
      totalChars += message.content.length;
      normalized.push({ role: message.role, content: message.content });
    }
    if (totalChars > MAX_COMPLETION_PROMPT_CHARS) return null;
    return normalized;
  }

  // A completion reply is whitelisted down to its text. An empty or
  // oversized text from a broken host is a typed failure, not a Digest.
  function sanitizeCompletionText(value) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > MAX_COMPLETION_TEXT_CHARS
    ) {
      return null;
    }
    return value;
  }

  // Delegates a provider completion to the companion. Returns
  // { ok: true, text } or { ok: false, reason } using the same reason
  // vocabulary as the auth and model actions, plus completion-malformed
  // when an ok:true host reply still fails the text whitelist.
  async function requestCompletion({
    runtime,
    model,
    messages,
    maxTokens,
    timeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
  } = {}) {
    const validatedModel = sanitizeModel({ id: model });
    const outboundMessages = normalizeOutboundMessages(messages);
    if (!validatedModel || !outboundMessages) {
      return { ok: false, reason: REASON.INVALID_REQUEST };
    }
    const message = {
      v: PROTOCOL_VERSION,
      type: COMPLETION_ACTIONS.CREATE,
      model: validatedModel.id,
      messages: outboundMessages,
    };
    if (Number.isInteger(maxTokens) && maxTokens > 0) {
      message.maxTokens = maxTokens;
    }

    const outcome = await sendContractRequest({
      runtime,
      message,
      timeoutMs,
    });
    if (outcome.reason) return { ok: false, reason: outcome.reason };

    const response = outcome.response;
    if (response.ok !== true) {
      return { ok: false, reason: normalizeErrorCode(response.error) };
    }
    const text = sanitizeCompletionText(response.text);
    if (!text) return { ok: false, reason: REASON.COMPLETION_MALFORMED };
    return { ok: true, text };
  }

  return {
    HOST_NAME,
    PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_COMPLETION_TIMEOUT_MS,
    STATUS,
    REASON,
    AUTH_PHASE,
    AUTH_PHASES,
    AUTH_OUTCOMES,
    AUTH_ACTIONS,
    MODELS_ACTIONS,
    COMPLETION_ACTIONS,
    statusRequest,
    classifyChromeError,
    classifyStatusResponse,
    normalizeCapabilities,
    sanitizeAuth,
    sanitizeModel,
    sanitizeCatalog,
    sanitizeCompletionText,
    normalizeOutboundMessages,
    checkStatus,
    beginAuthorization,
    cancelAuthorization,
    disconnectAccount,
    requestModelCatalog,
    validateModel,
    requestCompletion,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_COMPANION;
}
