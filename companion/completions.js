/**
 * Codex completion service for the YouTube Digest companion.
 *
 * This module is the only place that turns an extension completion request
 * into a provider request: it loads the OAuth credential from the Keychain,
 * refreshes it once when the provider rejects it, and converts the Codex
 * Responses payload back into the plain text the extension expects. Provider
 * response parsing therefore never leaks into extension UI code.
 *
 * Every failure crosses the connection contract as one of the typed codes in
 * ERROR_CODES. Credential values never leave this module: they are sent only
 * to OpenAI's auth and Codex endpoints, and error details pass through
 * redact() before they can reach stderr.
 */
"use strict";

const {
  OAUTH,
  refreshTokens,
  redact,
} = require("./oauth.js");
const { resolveAccountPhase, markReconnectRequired } = require("./auth-state.js");

const COMPLETIONS = Object.freeze({
  ENDPOINT: "https://chatgpt.com/backend-api/codex/responses",
  PROVIDER_TIMEOUT_MS: 110 * 1000,
  MAX_MESSAGES: 16,
  MAX_PROMPT_CHARS: 1_000_000,
  MAX_TEXT_CHARS: 400_000,
  // SSE framing overhead (event wrappers, deltas, reasoning items) means
  // the raw stream runs larger than its text; three text budgets bound it.
  MAX_SSE_CHARS: 3 * 400_000,
  MAX_OUTPUT_TOKENS: 32_768,
});

const ERROR_CODES = Object.freeze([
  "invalid-request",
  "request-too-large",
  "signed-out",
  "reconnect-required",
  "model-unavailable",
  "entitlement-denied",
  "rate-limited",
  "provider-timeout",
  "response-too-large",
  "empty-response",
  "provider-error",
]);

function completionError(code, detail) {
  const message = detail ? `${code}: ${redact(detail)}` : code;
  const error = new Error(message);
  error.code = code;
  return error;
}

function isAbortError(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}

// Validates the extension's prompt messages and collapses them into the
// instructions/input pair the Codex Responses API expects. The extension
// sends one system and one user message; extra messages stay allowed so
// prompts can evolve without a contract bump, within the same bounds.
function normalizeMessages(value) {
  const invalid = () => completionError("invalid-request");
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > COMPLETIONS.MAX_MESSAGES
  ) {
    throw invalid();
  }
  const systemParts = [];
  const userParts = [];
  let totalChars = 0;
  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw invalid();
    }
    if (message.role !== "system" && message.role !== "user") {
      throw invalid();
    }
    if (typeof message.content !== "string" || message.content.length === 0) {
      throw invalid();
    }
    totalChars += message.content.length;
    (message.role === "system" ? systemParts : userParts).push(message.content);
  }
  if (userParts.length === 0) {
    throw invalid();
  }
  if (totalChars > COMPLETIONS.MAX_PROMPT_CHARS) {
    throw completionError("request-too-large");
  }
  return {
    instructions: systemParts.length ? systemParts.join("\n\n") : null,
    input: userParts.join("\n\n"),
  };
}

function normalizeMaxTokens(value) {
  if (value === undefined || value === null) return null;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > COMPLETIONS.MAX_OUTPUT_TOKENS
  ) {
    throw completionError("invalid-request");
  }
  return value;
}

// Pulls the assistant text out of a Responses API payload. Reasoning items,
// tool calls, and function outputs carry other content types; only assistant
// message items (or role-less text parts, for tolerant hosts) hold the
// completion the extension asked for.
function extractTextFromResponse(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const outputs = Array.isArray(payload.output) ? payload.output : [];
  const parts = [];
  for (const item of outputs) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.type === "string" && item.type !== "message") continue;
    if (typeof item.role === "string" && item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

// Parses the `data:` payloads of one SSE transcript. Malformed or partial
// lines are skipped: a torn frame must not discard the completed event.
function parseSseEvents(raw) {
  const events = [];
  for (const line of String(raw).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch (_error) {
      // Ignore malformed frames.
    }
  }
  return events;
}

function createCompletionService({
  fetchImpl = fetch,
  keychain,
  authState,
  now = Date.now,
  issuer = OAUTH.ISSUER,
  clientId = OAUTH.CLIENT_ID,
  endpoint = COMPLETIONS.ENDPOINT,
  providerTimeoutMs = COMPLETIONS.PROVIDER_TIMEOUT_MS,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (!keychain || !authState) {
    throw new Error("completions-missing-dependencies");
  }

  // One controller per in-flight provider request so the host can cancel
  // everything when Chrome drops the connection: an abandoned Digest must
  // not keep burning the provider request until its own timeout.
  const activeRequests = new Set();

  function abortActive() {
    for (const controller of activeRequests) {
      controller.abort();
    }
  }

  async function loadCredentials() {
    let credentials = null;
    try {
      credentials = await keychain.load();
    } catch (_error) {
      // A locked or unreadable Keychain cannot prove a connection; the
      // signed-out recovery path is the honest answer.
    }
    if (typeof credentials !== "string" || !credentials) {
      throw completionError("signed-out");
    }
    try {
      const tokens = JSON.parse(credentials);
      if (
        typeof tokens.access_token !== "string" ||
        !tokens.access_token ||
        typeof tokens.refresh_token !== "string" ||
        !tokens.refresh_token
      ) {
        throw new Error("credential is missing tokens");
      }
      return tokens;
    } catch (_error) {
      throw completionError("reconnect-required");
    }
  }

  async function refreshCredential(tokens) {
    let refreshed;
    try {
      refreshed = await refreshTokens({
        fetchImpl,
        issuer,
        clientId,
        refreshToken: tokens.refresh_token,
      });
    } catch (error) {
      // A rejected refresh token is permanent: the user must reconnect, and
      // the marker says so. A network or timeout failure is transient — one
      // offline blip must not force a manual reconnect — so it stays a
      // retryable provider error without touching the account phase.
      const message = String(error?.message || "");
      const transient = message.startsWith("token-request-failed");
      log(`codex token refresh failed: ${redact(message)}`);
      throw completionError(
        transient ? "provider-error" : "reconnect-required",
      );
    }
    const merged = {
      ...tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
    };
    if (typeof refreshed.id_token === "string" && refreshed.id_token) {
      merged.id_token = refreshed.id_token;
    }
    if (typeof refreshed.account_id === "string" && refreshed.account_id) {
      merged.account_id = refreshed.account_id;
    }
    await keychain.save(JSON.stringify(merged));
    return merged;
  }

  async function postCompletion(tokens, body) {
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
      "OpenAI-Beta": "responses=experimental",
    };
    if (typeof tokens.account_id === "string" && tokens.account_id) {
      headers["chatgpt-account-id"] = tokens.account_id;
    }
    const controller = new AbortController();
    activeRequests.add(controller);
    const timeoutId = setTimeout(
      () => controller.abort(),
      providerTimeoutMs,
    );
    try {
      return await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw completionError("provider-timeout", error?.message);
      }
      throw completionError("provider-error", error?.message);
    } finally {
      clearTimeout(timeoutId);
      activeRequests.delete(controller);
    }
  }

  async function readRawBody(response) {
    const reader = response.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      let raw = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        if (raw.length > COMPLETIONS.MAX_SSE_CHARS) {
          await reader.cancel?.().catch(() => {});
          throw completionError("response-too-large");
        }
      }
      return raw + decoder.decode();
    }
    if (typeof response.text === "function") {
      const raw = await response.text();
      if (raw.length > COMPLETIONS.MAX_SSE_CHARS) {
        throw completionError("response-too-large");
      }
      return raw;
    }
    throw completionError("provider-error", "unreadable provider body");
  }

  function statusError(status, detail) {
    if (status === 401 || status === 403) {
      // The catalog never proves entitlement; a 403 on a real request is the
      // final eligibility check the Settings caveat warns about.
      return completionError(
        status === 403 ? "entitlement-denied" : "reconnect-required",
        detail,
      );
    }
    if (status === 404) return completionError("model-unavailable", detail);
    if (status === 429) return completionError("rate-limited", detail);
    return completionError("provider-error", `http ${status} ${detail ?? ""}`.trim());
  }

  async function readErrorDetail(response) {
    try {
      const raw = await response.text();
      const parsed = JSON.parse(raw);
      const message = parsed?.error?.message || parsed?.message;
      return typeof message === "string" ? message : null;
    } catch (_error) {
      return null;
    }
  }

  async function readCompletionText(response) {
    if (!response.ok) {
      throw statusError(response.status, await readErrorDetail(response));
    }
    const contentType = String(
      response.headers?.get?.("content-type") || "",
    ).toLowerCase();
    const raw = await readRawBody(response);
    const isSse = contentType.includes("text/event-stream") ||
      (contentType === "" && raw.includes("data:"));
    let responseObject = null;
    let deltaText = "";
    if (isSse) {
      for (const event of parseSseEvents(raw)) {
        if (!event || typeof event !== "object") continue;
        if (event.type === "response.completed" && event.response) {
          responseObject = event.response;
        } else if (event.type === "response.failed" || event.type === "error") {
          const failure = event.response?.error ?? event;
          throw completionError(
            "provider-error",
            failure?.code || failure?.message,
          );
        } else if (
          event.type === "response.output_text.delta" &&
          typeof event.delta === "string"
        ) {
          deltaText += event.delta;
        }
      }
    } else {
      try {
        responseObject = JSON.parse(raw);
      } catch (_error) {
        throw completionError("provider-error", "invalid provider payload");
      }
    }
    const text = (extractTextFromResponse(responseObject) || deltaText).trim();
    if (!text) {
      throw completionError("empty-response");
    }
    if (text.length > COMPLETIONS.MAX_TEXT_CHARS) {
      throw completionError("response-too-large");
    }
    return text;
  }

  async function runCompletion({ model, messages, maxTokens }) {
    const { instructions, input } = normalizeMessages(messages);
    const outputTokens = normalizeMaxTokens(maxTokens);
    if (typeof model !== "string" || !model) {
      throw completionError("invalid-request");
    }

    let tokens = await loadCredentials();
    // A credential the companion already marked as rejected must not burn a
    // provider round-trip; the user recovery is an explicit reconnect.
    if (
      resolveAccountPhase(authState.read(), true, now()) === "reconnect-required"
    ) {
      throw completionError("reconnect-required");
    }

    const body = {
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input }],
        },
      ],
      stream: true,
      store: false,
    };
    if (instructions) body.instructions = instructions;
    if (outputTokens) body.max_output_tokens = outputTokens;

    let response = await postCompletion(tokens, body);
    if (response.status === 401) {
      tokens = await refreshCredential(tokens);
      response = await postCompletion(tokens, body);
    }
    return readCompletionText(response);
  }

  // Reconnect classification is state, not just a reply: once a credential is
  // rejected, persist the phase so Settings shows it before the next request.
  async function runCompletionGuarded(request) {
    try {
      return await runCompletion(request);
    } catch (error) {
      if (error?.code === "reconnect-required") {
        try {
          markReconnectRequired(authState, now());
        } catch (_writeError) {
          // The typed reply already tells the user what to do.
        }
      }
      throw error;
    }
  }

  return { runCompletion: runCompletionGuarded, abortActive };
}

module.exports = {
  COMPLETIONS,
  ERROR_CODES,
  createCompletionService,
  normalizeMessages,
  normalizeMaxTokens,
  extractTextFromResponse,
  parseSseEvents,
  completionError,
};
