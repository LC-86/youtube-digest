#!/usr/bin/env node
/**
 * YouTube Digest local Codex companion: a Chrome Native Messaging host.
 *
 * Chrome launches this process with a stdio pipe and speaks a versioned
 * JSON contract: every message is a UTF-8 JSON body prefixed with a 4-byte
 * little-endian length, per Chrome's native messaging framing.
 *
 * The host answers `status`, the account authorization requests
 * (`auth.begin`, `auth.cancel`, `disconnect`), the model catalog requests
 * (`models.list`, `models.validate`), and delegated provider completions
 * (`completion.create`). Each native-messaging request spawns a fresh host
 * process, so pending authorization state lives in a non-secret state file
 * plus a detached auth worker, and the OAuth credential lives only in the
 * macOS Keychain. The catalog is companion-defined and carries no account
 * data, so it is answered regardless of the account phase; completions
 * require a stored credential and convert provider failures into typed
 * errors. Every request type stays inside this envelope so Settings can
 * detect outdated companions through the version negotiation and
 * capability list.
 */
"use strict";

const path = require("path");
const { spawn } = require("child_process");

const {
  createAuthState,
  resolveAccountPhase,
  markOutcome,
} = require("./auth-state.js");
const { createKeychainStore } = require("./keychain.js");
const { createCompletionService, ERROR_CODES } = require("./completions.js");
const { createProxyFetch } = require("./outbound.js");
const models = require("./models.js");
const { OAUTH, decodeIdTokenEmail, maskEmail, redact } = require("./oauth.js");

const CONTRACT = Object.freeze({
  HOST_NAME: "com.youtube_digest.companion",
  PROTOCOL_VERSION: 1,
  SUPPORTED_PROTOCOL_VERSIONS: Object.freeze([1]),
  CAPABILITIES: Object.freeze(["status", "auth", "models", "completions"]),
  MAX_INBOUND_MESSAGE_BYTES: 4 * 1024 * 1024,
  // Chrome closes the port when a host message exceeds 1 MB; stay below it.
  MAX_OUTBOUND_MESSAGE_BYTES: 900 * 1024,
});

const COMPANION_VERSION = require("../package.json").version;

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function errorResponse(error) {
  return { v: CONTRACT.PROTOCOL_VERSION, ok: false, error };
}

function createDefaultDeps() {
  const authState = createAuthState();
  const keychain = createKeychainStore({
    service: process.env.YTD_COMPANION_KEYCHAIN_SERVICE,
    account: process.env.YTD_COMPANION_KEYCHAIN_ACCOUNT,
  });
  // OpenAI's auth and Codex endpoints must leave through the same proxy the
  // browser uses, or region-restricted networks reject the companion outright.
  const fetchImpl = createProxyFetch();
  return {
    authState,
    keychain,
    fetchImpl,
    completions: createCompletionService({ fetchImpl, keychain, authState }),
    spawnAuthWorker() {
      const child = spawn(
        process.execPath,
        [path.join(__dirname, "auth-worker.js")],
        { detached: true, stdio: "ignore", env: process.env },
      );
      child.unref();
    },
    now: Date.now,
  };
}

// Loads the stored credential as token fields for authenticated catalog
// fetches. Every failure collapses to null: the caller falls back to the
// static catalog rather than branching on keychain error types.
async function loadCatalogTokens(deps) {
  try {
    const credentials = await deps.keychain.load();
    if (typeof credentials !== "string" || !credentials) return null;
    const tokens = JSON.parse(credentials);
    return typeof tokens?.access_token === "string" && tokens.access_token
      ? tokens
      : null;
  } catch (_error) {
    return null;
  }
}

// The live catalog wins when the account can fetch it, so new model families
// appear without a companion update; otherwise the frozen fallback answers.
async function resolveCatalog(deps) {
  try {
    const tokens = await loadCatalogTokens(deps);
    if (tokens) {
      const live = await models.fetchLiveCatalog({ fetchImpl: deps.fetchImpl, tokens });
      if (live) {
        return {
          models: live,
          defaultModel: live.some((model) => model.id === models.DEFAULT_MODEL_ID)
            ? models.DEFAULT_MODEL_ID
            : live[0].id,
        };
      }
    }
  } catch (_error) {
    // Fall through to the static catalog.
  }
  return {
    models: models.CATALOG.map((model) => ({ ...model })),
    defaultModel: models.DEFAULT_MODEL_ID,
  };
}

// Membership check that accepts both the static catalog and, while
// connected, the live catalog. Returns the {id, label} entry or null.
async function findModelAnywhere(deps, id) {
  const local = models.findModel(id);
  if (local) return local;
  const tokens = await loadCatalogTokens(deps);
  if (!tokens) return null;
  const live = await models.fetchLiveCatalog({ fetchImpl: deps.fetchImpl, tokens });
  const entry = live?.find((model) => model.id === id) ?? null;
  return entry ? { id: entry.id, label: entry.label } : null;
}

// Builds the accountLabel shown in Settings. The raw email stays inside the
// companion; only the masked form ever leaves.
function accountLabelFromCredentials(credentials) {
  if (typeof credentials !== "string") return null;
  try {
    const tokens = JSON.parse(credentials);
    return maskEmail(decodeIdTokenEmail(tokens.id_token));
  } catch (_error) {
    return null;
  }
}

function sanitizeAuthPayload(auth) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const payload = {};
  if (typeof auth.phase === "string" && auth.phase.length <= 32) {
    payload.phase = auth.phase;
  } else {
    return null;
  }
  if (typeof auth.accountLabel === "string" && auth.accountLabel.length <= 64) {
    payload.accountLabel = auth.accountLabel;
  }
  if (auth.lastOutcome === null) {
    payload.lastOutcome = null;
  } else if (
    typeof auth.lastOutcome === "string" &&
    auth.lastOutcome.length <= 32
  ) {
    payload.lastOutcome = auth.lastOutcome;
  }
  return payload;
}

// Belt-and-braces: if any secret value we just loaded somehow reaches a
// response field, drop the offending fields instead of shipping them.
function stripSecretValues(payload, secrets) {
  let serialized = JSON.stringify(payload);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8 && serialized.includes(secret)) {
      return { ...payload, auth: payload.auth ? { phase: payload.auth.phase } : undefined };
    }
  }
  return payload;
}

async function accountStatus(deps) {
  const marker = deps.authState.read();
  let credentials = null;
  try {
    credentials = await deps.keychain.load();
  } catch (_error) {
    // An unreadable Keychain (locked, missing tooling) must not fake a
    // connected state; treat as absent and let actions surface errors.
  }

  const phase = resolveAccountPhase(marker, Boolean(credentials), deps.now());
  if (phase === "authorizing") {
    return { auth: { phase: "authorizing" }, secrets: [] };
  }
  if (phase === "authorizing-expired") {
    markOutcome(deps.authState, { kind: "expired" }, deps.now());
    return { auth: { phase: "signed-out", lastOutcome: "expired" }, secrets: [] };
  }
  if (phase === "reconnect-required") {
    return {
      auth: {
        phase: "reconnect-required",
        accountLabel: accountLabelFromCredentials(credentials),
        lastOutcome: marker?.outcome?.kind ?? null,
      },
      secrets: [],
    };
  }
  if (phase === "connected") {
    const secrets = secretValuesFrom(credentials);
    return {
      auth: {
        phase: "connected",
        accountLabel: accountLabelFromCredentials(credentials),
      },
      secrets,
    };
  }
  return {
    auth: { phase: "signed-out", lastOutcome: marker?.outcome?.kind ?? null },
    secrets: [],
  };
}

function secretValuesFrom(credentials) {
  if (typeof credentials !== "string") return [];
  try {
    const tokens = JSON.parse(credentials);
    return [tokens.access_token, tokens.refresh_token, tokens.id_token].filter(
      (value) => typeof value === "string" && value.length >= 8,
    );
  } catch (_error) {
    return [];
  }
}

function safeWriteMarker(deps, marker) {
  try {
    deps.authState.write(marker);
    return true;
  } catch (_error) {
    // State-file failures degrade status accuracy but must not crash the
    // host before it can answer the extension.
    return false;
  }
}

function safeClearMarker(deps) {
  try {
    deps.authState.clear();
  } catch (_error) {
    // Same policy as safeWriteMarker.
  }
}

async function handleAuthBegin(deps) {
  const { auth } = await accountStatus(deps);
  if (auth.phase === "connected") {
    return errorResponse("already-connected");
  }
  if (auth.phase === "authorizing") {
    return okAuthResponse("auth.begin", { phase: "authorizing" });
  }
  // Optimistically mark authorizing so an immediate status poll cannot
  // flash back to signed-out before the worker starts. The deadline must
  // match the worker's own flow timeout, or the two would heal at
  // different times.
  safeWriteMarker(deps, {
    phase: "authorizing",
    expires_at: deps.now() + OAUTH.FLOW_TIMEOUT_MS,
    updated_at: deps.now(),
  });
  try {
    deps.spawnAuthWorker();
  } catch (error) {
    safeClearMarker(deps);
    process.stderr.write(`could not start auth worker: ${redact(error?.message)}\n`);
    return errorResponse("auth-worker-failed");
  }
  return okAuthResponse("auth.begin", { phase: "authorizing" });
}

async function handleAuthCancel(deps) {
  const marker = deps.authState.read();
  if (marker?.phase === "authorizing") {
    // The worker polls the marker and shuts its loopback server down.
    markOutcome(deps.authState, { kind: "cancelled" }, deps.now());
    return okAuthResponse("auth.cancel", {
      phase: "signed-out",
      lastOutcome: "cancelled",
    });
  }
  const { auth, secrets } = await accountStatus(deps);
  return stripSecretValues(okAuthResponse("auth.cancel", auth), secrets);
}

async function handleDisconnect(deps) {
  try {
    await deps.keychain.remove();
  } catch (error) {
    process.stderr.write(`disconnect failed: ${redact(error?.message)}\n`);
    return errorResponse("disconnect-failed");
  }
  // A pending flow must not survive a disconnect: a cancelled marker stops
  // the detached worker, so a late callback cannot re-store the credential.
  const marker = deps.authState.read();
  if (marker?.phase === "authorizing") {
    markOutcome(deps.authState, { kind: "cancelled" }, deps.now());
  } else {
    safeClearMarker(deps);
  }
  return okAuthResponse("disconnect", { phase: "signed-out" });
}

function okAuthResponse(type, auth) {
  const sanitized = sanitizeAuthPayload(auth);
  if (!sanitized) return errorResponse("host-error");
  return { v: CONTRACT.PROTOCOL_VERSION, ok: true, type, auth: sanitized };
}

async function handleRequest(request, deps = createDefaultDeps()) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return errorResponse("invalid-request");
  }
  if (
    !Number.isInteger(request.v) ||
    !CONTRACT.SUPPORTED_PROTOCOL_VERSIONS.includes(request.v)
  ) {
    return {
      ...errorResponse("unsupported-protocol"),
      found: Number.isInteger(request.v) ? request.v : null,
    };
  }
  if (request.type === "status") {
    const { auth, secrets } = await accountStatus(deps);
    return stripSecretValues(
      {
        v: request.v,
        ok: true,
        type: "status",
        status: "ready",
        protocol: CONTRACT.PROTOCOL_VERSION,
        companionVersion: COMPANION_VERSION,
        capabilities: CONTRACT.CAPABILITIES,
        auth,
      },
      secrets,
    );
  }
  if (request.type === "auth.begin") {
    return handleAuthBegin(deps);
  }
  if (request.type === "auth.cancel") {
    return handleAuthCancel(deps);
  }
  if (request.type === "disconnect") {
    return handleDisconnect(deps);
  }
  if (request.type === "models.list") {
    const catalog = await resolveCatalog(deps);
    return {
      v: request.v,
      ok: true,
      type: "models.list",
      models: catalog.models,
      defaultModel: catalog.defaultModel,
    };
  }
  if (request.type === "models.validate") {
    // Shape-check first so junk never reaches the catalog; a well-formed id
    // the companion cannot serve is the typed model-unavailable recovery
    // path Settings relies on.
    if (!models.isValidModelId(request.model)) {
      return errorResponse("invalid-request");
    }
    const model = await findModelAnywhere(deps, request.model);
    if (!model) return errorResponse("model-unavailable");
    return { v: request.v, ok: true, type: "models.validate", model };
  }
  if (request.type === "completion.create") {
    // Catalog membership is enforced host-side so an unknown model fails
    // before any credential is touched; the check accepts the static and
    // live catalogs so newly shipped models work without a companion
    // update. Only the typed text field is ever copied into the reply, so
    // provider payloads cannot smuggle extra fields (let alone credentials)
    // back to the extension.
    if (!models.isValidModelId(request.model)) {
      return errorResponse("invalid-request");
    }
    if (!(await findModelAnywhere(deps, request.model))) {
      return errorResponse("model-unavailable");
    }
    try {
      const text = await deps.completions.runCompletion({
        model: request.model,
        messages: request.messages,
        maxTokens: request.maxTokens,
      });
      if (typeof text !== "string" || !text) {
        return errorResponse("host-error");
      }
      // Byte length, not char length: a CJK Digest under-counts in UTF-16
      // units, and writeFrame's frame budget is bytes.
      if (Buffer.byteLength(text, "utf8") > CONTRACT.MAX_OUTBOUND_MESSAGE_BYTES) {
        return errorResponse("response-too-large");
      }
      return { v: request.v, ok: true, type: "completion.create", text };
    } catch (error) {
      const code = ERROR_CODES.includes(error?.code) ? error.code : "host-error";
      if (code === "host-error") {
        process.stderr.write(`completion failed: ${redact(error?.message)}\n`);
      }
      return errorResponse(code);
    }
  }
  return errorResponse("unknown-request-type");
}

function createFrameReader({ onMessage, onError }) {
  let buffer = Buffer.alloc(0);
  let failed = false;

  return {
    push(chunk) {
      if (failed || !chunk?.length) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length > CONTRACT.MAX_INBOUND_MESSAGE_BYTES) {
          failed = true;
          onError(
            new Error(
              `inbound message of ${length} bytes exceeds the ${CONTRACT.MAX_INBOUND_MESSAGE_BYTES} byte limit`,
            ),
          );
          return;
        }
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch (_error) {
          failed = true;
          onError(new Error("inbound frame is not valid JSON"));
          return;
        }
        onMessage(message);
      }
    },
  };
}

function writeFrame(payload) {
  let body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > CONTRACT.MAX_OUTBOUND_MESSAGE_BYTES) {
    // Chrome silently drops oversized host messages, which would leave the
    // extension waiting for a reply. Answer with a typed error instead.
    process.stderr.write("outbound message exceeds the native messaging size limit; replying with an error\n");
    body = Buffer.from(
      JSON.stringify(errorResponse("response-too-large")),
      "utf8",
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function main() {
  if (process.argv.includes("--version")) {
    process.stdout.write(
      `${JSON.stringify({
        companionVersion: COMPANION_VERSION,
        protocol: CONTRACT.PROTOCOL_VERSION,
        hostName: CONTRACT.HOST_NAME,
      })}\n`,
    );
    return;
  }

  const deps = createDefaultDeps();
  // Requests are asynchronous (status reads the Keychain), so stdin closing
  // must not exit the process while a reply is still being produced.
  let pendingRequests = 0;
  let stdinEnded = false;
  const maybeExit = () => {
    if (stdinEnded && pendingRequests === 0) {
      // setImmediate lets the queued stdout write reach the pipe first.
      setImmediate(() => process.exit(0));
    }
  };
  const reader = createFrameReader({
    onMessage(message) {
      pendingRequests += 1;
      handleRequest(message, deps)
        .then(writeFrame)
        .catch((error) => {
          process.stderr.write(`request failed: ${redact(error?.message)}\n`);
          writeFrame(errorResponse("host-error"));
        })
        .finally(() => {
          pendingRequests -= 1;
          maybeExit();
        });
    },
    onError(error) {
      process.stderr.write(`companion error: ${error.message}\n`);
      process.exit(1);
    },
  });

  process.stdin.on("data", (chunk) => reader.push(chunk));
  process.stdin.on("end", () => {
    stdinEnded = true;
    // Chrome closed the connection (the extension stopped waiting): cancel
    // in-flight provider work instead of letting it run to its own timeout.
    deps.completions?.abortActive?.();
    maybeExit();
  });
  process.stdin.on("error", () => {
    stdinEnded = true;
    deps.completions?.abortActive?.();
    maybeExit();
  });
  process.stdin.resume();
}

if (require.main === module) {
  main();
}

module.exports = {
  CONTRACT,
  COMPANION_VERSION,
  HOST_NAME: CONTRACT.HOST_NAME,
  PROTOCOL_VERSION: CONTRACT.PROTOCOL_VERSION,
  encodeFrame,
  createFrameReader,
  createDefaultDeps,
  handleRequest,
  accountStatus,
  sanitizeAuthPayload,
  stripSecretValues,
  writeFrame,
  main,
};
