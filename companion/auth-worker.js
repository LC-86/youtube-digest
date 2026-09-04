#!/usr/bin/env node
/**
 * Detached authorization worker for the YouTube Digest companion.
 *
 * Chrome's one-shot native messaging kills the host process right after it
 * replies, so the pending OAuth callback server cannot live there. The host
 * spawns this worker detached instead. The worker owns the entire flow in
 * memory: it generates the PKCE pair, binds the loopback redirect listener,
 * stores an "authorizing" marker, opens the browser, exchanges the callback
 * code for tokens, and saves the credential into the macOS Keychain.
 *
 * Nothing it writes to disk or stdout contains a secret: markers carry only
 * a phase and a typed outcome, and error reasons pass through redact().
 */
"use strict";

const http = require("http");
const { spawn } = require("child_process");

const {
  OAUTH,
  createPkce,
  createState,
  redirectUriForPort,
  buildAuthorizeUrl,
  validateCallback,
  exchangeCodeForTokens,
  redact,
} = require("./oauth.js");
const { createAuthState, markOutcome } = require("./auth-state.js");
const { createKeychainStore } = require("./keychain.js");
const { createProxyFetch } = require("./outbound.js");

const WORKER = Object.freeze({
  TICK_MS: 250,
  HOST: "127.0.0.1",
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Binds the loopback redirect listener, trying ports in order. Only the
// machine running the browser ever reaches it.
function startLoopbackServer({ ports, onCallback }) {
  const attempts = [...ports];
  function tryNext() {
    const port = attempts.shift();
    return new Promise((resolve, reject) => {
      if (port === undefined) {
        reject(new Error("loopback-port-unavailable"));
        return;
      }
      const server = http.createServer((request, response) => {
        void handleRequest(request, response).catch(() => {
          if (!response.headersSent) response.statusCode = 500;
          response.end("Authorization worker error.");
        });
      });
      async function handleRequest(request, response) {
        const url = new URL(request.url || "/", `http://${WORKER.HOST}`);
        if (url.pathname !== OAUTH.CALLBACK_PATH) {
          response.statusCode = 404;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end("Not found.");
          return;
        }
        const page = await onCallback(url.searchParams);
        response.statusCode = page.status;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        // Finish the browser response before the flow tears the listener
        // down, or the user sees a dropped connection instead of the page.
        await new Promise((resolveEnd) => response.end(page.body, resolveEnd));
        await page.afterResponse?.();
      }
      server.once("error", () => {
        server.removeAllListeners();
        tryNext().then(resolve, reject);
      });
      server.listen(port, WORKER.HOST, () => {
        // listen(0) asks for an ephemeral port; report the assigned one so
        // the redirect URI matches the socket actually bound.
        resolve({ server, port: server.address().port });
      });
    });
  }
  return tryNext();
}

function successPage() {
  return {
    status: 200,
    body:
      "Signed in to YouTube Digest. You can close this tab and return to the extension's Settings.",
  };
}

function failurePage(kind, reason) {
  const detail = reason ? `: ${reason}` : "";
  return {
    status: 400,
    body: `Authorization could not be completed (${kind}${detail}). Close this tab and try again from YouTube Digest Settings.`,
  };
}

async function openBrowser(url) {
  if (process.platform !== "darwin") {
    throw new Error("browser-open-unsupported");
  }
  await new Promise((resolve, reject) => {
    const child = spawn("open", [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => resolve());
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("browser-open-failed"))));
  });
}

function noop() {}

async function createAuthFlow({
  issuer,
  clientId,
  scope,
  ports = [OAUTH.PREFERRED_PORT, OAUTH.FALLBACK_PORT],
  timeoutMs = OAUTH.FLOW_TIMEOUT_MS,
  tickMs = WORKER.TICK_MS,
  now = Date.now,
  fetchImpl = fetch,
  keychain,
  authState,
  openBrowserImpl = openBrowser,
  log = noop,
} = {}) {
  if (!keychain || !authState) {
    throw new Error("auth-flow-missing-dependencies");
  }

  const pkce = createPkce();
  const state = createState();
  const startedAt = now();
  const expiresAt = startedAt + timeoutMs;
  const completion = createDeferred();
  let settled = false;

  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    completion.resolve(outcome);
  };

  const listener = await startLoopbackServer({
    ports,
    onCallback: async (searchParams) => {
      if (settled) {
        return { status: 409, body: "This authorization request already finished." };
      }
      const callback = validateCallback(searchParams, state);
      if (!callback.ok) {
        try {
          markOutcome(authState, { kind: callback.error }, now());
        } catch (_writeError) {
          // The typed reply still tells the user what happened.
        }
        return {
          ...failurePage(callback.error),
          afterResponse: () => finish({ kind: callback.error }),
        };
      }
      try {
        const tokens = await exchangeCodeForTokens({
          fetchImpl,
          issuer,
          clientId,
          redirectUri: redirectUriForPort(listener.port),
          code: callback.code,
          verifier: pkce.verifier,
        });
        // A cancel or disconnect can land while the token exchange is in
        // flight; storing now would reconnect an account the user just
        // removed, so drop the tokens instead.
        if (settled) {
          return failurePage("cancelled");
        }
        await keychain.save(JSON.stringify(tokens));
        markOutcome(authState, { kind: "connected" }, now());
        return {
          ...successPage(),
          afterResponse: () => finish({ kind: "connected" }),
        };
      } catch (error) {
        const reason = redact(error?.message || "unknown", [
          callback.code,
          pkce.verifier,
          state,
        ]);
        log(`auth flow failed: ${reason}`);
        markOutcome(authState, { kind: "error", reason }, now());
        return {
          ...failurePage("error", reason),
          afterResponse: () => finish({ kind: "error", reason }),
        };
      }
    },
  });

  try {
    // The host marks "authorizing" before spawning this worker. If that
    // marker is gone or already terminal (cancel or disconnect won the
    // race), exit without opening anything so a late callback cannot store
    // a credential the user just removed.
    const currentMarker = authState.read();
    if (currentMarker?.phase !== "authorizing") {
      finish({ kind: "cancelled" });
    } else {
      await authState.write({
        phase: "authorizing",
        expires_at: expiresAt,
        updated_at: startedAt,
      });

      await openBrowserImpl(
        buildAuthorizeUrl({
          issuer,
          clientId,
          scope,
          redirectUri: redirectUriForPort(listener.port),
          challenge: pkce.challenge,
          state,
        }),
      );
    }
  } catch (error) {
    const reason = redact(error?.message || "unknown");
    try {
      markOutcome(authState, { kind: "error", reason }, now());
    } catch (_writeError) {
      // The marker is best-effort; the setup failure is already terminal.
    }
    finish({ kind: "error", reason });
  }

  const ticker = setInterval(async () => {
    if (settled) return;
    if (now() >= expiresAt) {
      try {
        markOutcome(authState, { kind: "expired" }, now());
      } catch (_writeError) {
        // Best-effort: the expiry outcome is also returned to the caller.
      }
      finish({ kind: "expired" });
      return;
    }
    // The host's auth.cancel rewrites the marker; honoring it here is the
    // whole cancellation path. read() is synchronous and never throws.
    const marker = authState.read();
    if (marker && marker.phase !== "authorizing") {
      finish({ kind: "cancelled" });
    }
  }, tickMs);

  const outcome = await completion.promise;
  clearInterval(ticker);
  // fetch() keeps sockets alive; closeAllConnections() stops them from
  // holding the worker's exit open after the flow finished.
  listener.server.closeAllConnections?.();
  await new Promise((resolveClose) => listener.server.close(resolveClose));
  return outcome;
}

function createDefaultDependencies() {
  return {
    // The token exchange must leave through the same proxy the browser used
    // for sign-in, or region-restricted networks reject it outright.
    fetchImpl: createProxyFetch(),
    keychain: createKeychainStore({
      service: process.env.YTD_COMPANION_KEYCHAIN_SERVICE,
      account: process.env.YTD_COMPANION_KEYCHAIN_ACCOUNT,
    }),
    authState: createAuthState(),
    log: (message) => process.stderr.write(`${message}\n`),
  };
}

async function main() {
  const deps = createDefaultDependencies();
  try {
    const outcome = await createAuthFlow(deps);
    process.stderr.write(`auth worker finished: ${outcome.kind}\n`);
  } catch (error) {
    const reason = redact(error?.message || "unknown");
    try {
      markOutcome(deps.authState, { kind: "error", reason });
    } catch (_writeError) {
      // The marker is best-effort here; the flow has already failed.
    }
    process.stderr.write(`auth worker failed: ${reason}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  WORKER,
  createAuthFlow,
  createDefaultDependencies,
  startLoopbackServer,
  successPage,
  failurePage,
  openBrowser,
  main,
};
