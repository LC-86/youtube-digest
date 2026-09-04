const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");

const companion = require("../companion.js");
const host = require("../companion/host.js");
const oauth = require("../companion/oauth.js");
const keychain = require("../companion/keychain.js");
const authStateModule = require("../companion/auth-state.js");
const authWorker = require("../companion/auth-worker.js");
const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ytd-auth-state-"));
}

function makeJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

// Short fake values on purpose: the release credential scan rejects
// 16+ character literal assignments, and the semantics do not need realism.
const FAKE_TOKENS = {
  access_token: "at-test",
  refresh_token: "rt-test",
  id_token: makeJwt({ email: "john.doe@example.com" }),
  account_id: "acct-test",
};

function credentialsWith(tokens = FAKE_TOKENS) {
  return JSON.stringify(tokens);
}

function createMemoryKeychain(initial = null) {
  let secret = initial;
  return {
    async load() {
      return secret;
    },
    async save(value) {
      secret = value;
    },
    async remove() {
      const existed = secret !== null;
      secret = null;
      return existed;
    },
  };
}

function createHostDeps({ credentials = null, keychainOverride } = {}) {
  const stateDir = makeStateDir();
  const memoryKeychain = createMemoryKeychain(credentials);
  const spawned = [];
  return {
    stateDir,
    spawned,
    authState: authStateModule.createAuthState({ dir: stateDir }),
    keychain: keychainOverride ?? memoryKeychain,
    spawnAuthWorker() {
      spawned.push(spawned.length);
    },
    now: () => 1_000_000,
  };
}

async function call(request, deps) {
  return host.handleRequest(request, deps);
}

// ---------------------------------------------------------------- oauth.js

test("PKCE pair derives the S256 challenge from the verifier", () => {
  const pkce = oauth.createPkce();

  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto
    .createHash("sha256")
    .update(pkce.verifier)
    .digest("base64url");
  assert.equal(pkce.challenge, expected);
});

test("authorize URL carries the public PKCE flow parameters", () => {
  const url = new URL(
    oauth.buildAuthorizeUrl({
      redirectUri: "http://localhost:1455/auth/callback",
      challenge: "challenge-value",
      state: "state-value",
    }),
  );

  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(
    url.searchParams.get("client_id"),
    oauth.OAUTH.CLIENT_ID,
  );
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:1455/auth/callback",
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.ok(url.searchParams.get("scope").includes("offline_access"));
});

test("callback validation classifies code, denial, mismatch, and loss", () => {
  assert.deepEqual(oauth.validateCallback("code=abc&state=right", "right"), {
    ok: true,
    code: "abc",
  });
  assert.deepEqual(
    oauth.validateCallback("error=access_denied&state=right", "right"),
    { ok: false, error: "denied" },
  );
  assert.deepEqual(
    oauth.validateCallback("code=abc&state=wrong", "right"),
    { ok: false, error: "state-mismatch" },
  );
  assert.deepEqual(
    oauth.validateCallback("state=right", "right"),
    { ok: false, error: "missing-code" },
  );
});

test("token exchange posts the code grant and validates the reply", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ...FAKE_TOKENS }) };
  };

  const tokens = await oauth.exchangeCodeForTokens({
    fetchImpl,
    redirectUri: "http://localhost:1455/auth/callback",
    code: "the-code",
    verifier: "the-verifier",
  });

  assert.equal(tokens.refresh_token, "rt-test");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.openai.com/oauth/token");
  assert.equal(calls[0].init.method, "POST");
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "the-code");
  assert.equal(body.get("code_verifier"), "the-verifier");

  await assert.rejects(
    oauth.exchangeCodeForTokens({
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }),
      redirectUri: "http://localhost:1455/auth/callback",
      code: "c",
      verifier: "v",
    }),
    /token-endpoint-rejected/,
  );
  await assert.rejects(
    oauth.exchangeCodeForTokens({
      fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: "only" }) }),
      redirectUri: "http://localhost:1455/auth/callback",
      code: "c",
      verifier: "v",
    }),
    /token-endpoint-missing-credentials/,
  );
});

test("account labels are masked and malformed inputs are dropped", () => {
  assert.equal(
    oauth.maskEmail(oauth.decodeIdTokenEmail(FAKE_TOKENS.id_token)),
    "j\u2022\u2022\u2022@e\u2022\u2022\u2022.com",
  );
  assert.equal(oauth.maskEmail("not-an-email"), null);
  assert.equal(oauth.decodeIdTokenEmail("garbage"), null);
  assert.equal(oauth.decodeIdTokenEmail(makeJwt({})), null);
});

test("redact strips known secrets and token-shaped values", () => {
  const redacted = oauth.redact(
    "failed code=SECRET-CODE-123 verifier=SECRET-VERIFIER-XYZ sk-short123 Bearer abcdefghijk.eyJhbGciOi.abc",
    ["SECRET-CODE-123", "SECRET-VERIFIER-XYZ"],
  );

  assert.ok(redacted.includes("[redacted]"));
  assert.ok(!redacted.includes("SECRET-CODE-123"));
  assert.ok(!redacted.includes("SECRET-VERIFIER-XYZ"));
  assert.ok(!redacted.includes("sk-short123"));
  assert.ok(!redacted.includes("abcdefghijk.eyJhbGciOi.abc"));
});

// ------------------------------------------------------------ keychain.js

test("keychain store keeps the secret off argv and round-trips it", async () => {
  const calls = [];
  const items = new Map();
  const keyOf = (args) =>
    `${args[args.indexOf("-s") + 1]}:${args[args.indexOf("-a") + 1]}`;
  // Mirrors the real tool's surface: writes arrive as an interactive
  // command on stdin (`security -i`), reads and deletes as plain argv.
  const run = async (args, options = {}) => {
    calls.push({ args, input: options.input ?? null });
    if (args[0] === "-i") {
      const command = options.input;
      const writeMatch = command.match(
        /^add-generic-password -U -s (\S+) -a (\S+) -w "(.*)"\n$/,
      );
      assert.ok(writeMatch, `unexpected interactive command: ${command}`);
      const [, service, account, escaped] = writeMatch;
      items.set(
        `${service}:${account}`,
        escaped.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      );
      return "";
    }
    if (args[0] === "find-generic-password") {
      if (!items.has(keyOf(args))) {
        throw new Error("The specified item could not be found in the keychain.");
      }
      return items.get(keyOf(args));
    }
    if (args[0] === "delete-generic-password") {
      if (!items.delete(keyOf(args))) {
        throw new Error("The specified item could not be found in the keychain.");
      }
      return "";
    }
    throw new Error(`unexpected security command: ${args.join(" ")}`);
  };

  const store = keychain.createKeychainStore({
    service: "svc-test",
    account: "acct-test",
    run,
  });

  const secret = JSON.stringify({
    access_token: "at two words",
    quoted: 'say "hi"',
    back: "a\\b",
  });
  await store.save(secret);
  assert.equal(await store.load(), secret);
  assert.equal(await store.remove(), true);
  assert.equal(await store.load(), null);
  assert.equal(await store.remove(), false);

  assert.deepEqual(calls[0].args, ["-i"]);
  assert.match(calls[0].input, /^add-generic-password -U -s svc-test -a acct-test -w "/);
  // The secret travels on stdin only; no argv of any call exposes it.
  for (const call of calls) {
    assert.ok(!call.args.includes(secret));
  }
  assert.deepEqual(calls[1].args, [
    "find-generic-password",
    "-s",
    "svc-test",
    "-a",
    "acct-test",
    "-w",
  ]);
  assert.deepEqual(calls[2].args, [
    "delete-generic-password",
    "-s",
    "svc-test",
    "-a",
    "acct-test",
  ]);
});

// --------------------------------------------------------- auth-state.js

test("auth state file round-trips sanitized markers and heals garbage", () => {
  const dir = makeStateDir();
  const state = authStateModule.createAuthState({ dir });

  const written = state.write({
    phase: "authorizing",
    expires_at: 123,
    outcome: { kind: "tampered", reason: "x".repeat(500) },
  });
  assert.equal(written.phase, "authorizing");
  assert.equal(written.expires_at, 123);
  assert.ok(!("outcome" in written));
  assert.ok(Number.isFinite(written.updated_at));
  assert.deepEqual(state.read(), written);

  state.write({ phase: "idle", outcome: { kind: "expired" }, updated_at: 5 });
  assert.deepEqual(state.read(), {
    phase: "idle",
    outcome: { kind: "expired" },
    updated_at: 5,
  });

  state.clear();
  assert.equal(state.read(), null);

  fs.writeFileSync(path.join(dir, "auth-state.json"), "{not json");
  assert.equal(state.read(), null);
});

test("phase resolution covers every observable account phase", () => {
  assert.equal(
    authStateModule.resolveAccountPhase({ phase: "authorizing", expires_at: 200 }, false, 100),
    "authorizing",
  );
  assert.equal(
    authStateModule.resolveAccountPhase({ phase: "authorizing", expires_at: 200 }, false, 300),
    "authorizing-expired",
  );
  assert.equal(
    authStateModule.resolveAccountPhase({ phase: "reconnect-required" }, true, 1),
    "reconnect-required",
  );
  assert.equal(authStateModule.resolveAccountPhase(null, true, 1), "connected");
  assert.equal(authStateModule.resolveAccountPhase(null, false, 1), "signed-out");
  assert.equal(
    authStateModule.resolveAccountPhase({ phase: "idle", outcome: { kind: "denied" } }, false, 1),
    "signed-out",
  );
});

// -------------------------------------------------------- auth-worker.js

async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

function createWorkerDeps(overrides = {}) {
  const stateDir = makeStateDir();
  const deps = {
    ports: [0],
    timeoutMs: 10_000,
    tickMs: 20,
    keychain: createMemoryKeychain(),
    authState: authStateModule.createAuthState({ dir: stateDir }),
    openBrowserImpl: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ ...FAKE_TOKENS }) }),
    ...overrides,
  };
  // In production the host's auth.begin writes the authorizing marker before
  // spawning the worker; mirror that so the worker's startup guard passes.
  deps.authState.write({
    phase: "authorizing",
    expires_at: Date.now() + 600_000,
    updated_at: Date.now(),
  });
  return deps;
}

test("worker completes the full loopback flow and stores only keychain secrets", async () => {
  const openedUrls = [];
  const deps = createWorkerDeps({
    openBrowserImpl: async (url) => {
      openedUrls.push(url);
    },
  });
  const flowPromise = authWorker.createAuthFlow(deps);

  await waitFor(() => openedUrls.length === 1);
  const authorizeUrl = new URL(openedUrls[0]);
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  const state = authorizeUrl.searchParams.get("state");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");

  assert.deepEqual(deps.authState.read().phase, "authorizing");

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", "the-auth-code");
  callback.searchParams.set("state", state);
  const response = await fetch(callback);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Signed in to YouTube Digest/);
  assert.deepEqual(await flowPromise, { kind: "connected" });

  const stored = JSON.parse(await deps.keychain.load());
  assert.equal(stored.refresh_token, "rt-test");
  assert.equal(stored.id_token, FAKE_TOKENS.id_token);
  assert.deepEqual(deps.authState.read(), {
    phase: "idle",
    outcome: { kind: "connected" },
    updated_at: deps.authState.read().updated_at,
  });

  // The state file must never echo the authorization code or tokens.
  const markerText = JSON.stringify(deps.authState.read());
  assert.ok(!markerText.includes("the-auth-code"));
  assert.ok(!markerText.includes("rt-test"));
  assert.ok(!body.includes("the-auth-code"));
});

test("worker reports denial and state mismatch without storing anything", async () => {
  const deniedDeps = createWorkerDeps();
  const deniedUrlHolder = { url: null };
  deniedDeps.openBrowserImpl = async (url) => {
    deniedUrlHolder.url = new URL(url);
  };
  const deniedFlow = authWorker.createAuthFlow(deniedDeps);
  await waitFor(() => deniedUrlHolder.url !== null);
  const deniedCallback = new URL(deniedUrlHolder.url.searchParams.get("redirect_uri"));
  deniedCallback.searchParams.set("error", "access_denied");
  deniedCallback.searchParams.set("state", deniedUrlHolder.url.searchParams.get("state"));
  const deniedResponse = await fetch(deniedCallback);

  assert.equal(deniedResponse.status, 400);
  assert.deepEqual(await deniedFlow, { kind: "denied" });
  assert.equal(await deniedDeps.keychain.load(), null);
  assert.deepEqual(deniedDeps.authState.read().outcome, { kind: "denied" });

  const mismatchDeps = createWorkerDeps();
  const mismatchUrlHolder = { url: null };
  mismatchDeps.openBrowserImpl = async (url) => {
    mismatchUrlHolder.url = new URL(url);
  };
  const mismatchFlow = authWorker.createAuthFlow(mismatchDeps);
  await waitFor(() => mismatchUrlHolder.url !== null);
  const mismatchCallback = new URL(mismatchUrlHolder.url.searchParams.get("redirect_uri"));
  mismatchCallback.searchParams.set("code", "code-from-elsewhere");
  mismatchCallback.searchParams.set("state", "not-the-state");
  await fetch(mismatchCallback);

  assert.deepEqual(await mismatchFlow, { kind: "state-mismatch" });
  assert.equal(await mismatchDeps.keychain.load(), null);
  assert.deepEqual(mismatchDeps.authState.read().outcome, { kind: "state-mismatch" });
});

test("worker expires an abandoned flow and reports it as a typed outcome", async () => {
  const deps = createWorkerDeps({ timeoutMs: 60 });

  const outcome = await authWorker.createAuthFlow(deps);

  assert.deepEqual(outcome, { kind: "expired" });
  assert.equal(await deps.keychain.load(), null);
  assert.deepEqual(deps.authState.read().outcome, { kind: "expired" });
});

test("worker honors a cancel written by the host and keeps the marker", async () => {
  const deps = createWorkerDeps();
  const flowPromise = authWorker.createAuthFlow(deps);
  await waitFor(() => deps.authState.read()?.phase === "authorizing");

  deps.authState.write({
    phase: "idle",
    outcome: { kind: "cancelled" },
    updated_at: Date.now(),
  });

  assert.deepEqual(await flowPromise, { kind: "cancelled" });
  assert.deepEqual(deps.authState.read().outcome, { kind: "cancelled" });
  assert.equal(await deps.keychain.load(), null);
});

test("worker refuses to start when the flow was cancelled first", async () => {
  const deps = createWorkerDeps();
  const openedUrls = [];
  deps.openBrowserImpl = async (url) => {
    openedUrls.push(url);
  };
  deps.authState.write({
    phase: "idle",
    outcome: { kind: "cancelled" },
    updated_at: Date.now(),
  });

  assert.deepEqual(await authWorker.createAuthFlow(deps), { kind: "cancelled" });
  assert.equal(openedUrls.length, 0);
  assert.equal(await deps.keychain.load(), null);
  assert.deepEqual(deps.authState.read().outcome, { kind: "cancelled" });
});

test("worker redacts secrets from exchange failures before persisting", async () => {
  const deps = createWorkerDeps({
    fetchImpl: async (_url, init) => {
      const body = String(init.body);
      throw new Error(`exchange failed ${body} sk-short456`);
    },
  });
  const urlHolder = { url: null };
  deps.openBrowserImpl = async (url) => {
    urlHolder.url = new URL(url);
  };
  const flowPromise = authWorker.createAuthFlow(deps);
  await waitFor(() => urlHolder.url !== null);
  const callback = new URL(urlHolder.url.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", "the-auth-code");
  callback.searchParams.set("state", urlHolder.url.searchParams.get("state"));
  const response = await fetch(callback);

  assert.equal(response.status, 400);
  const outcome = await flowPromise;
  assert.equal(outcome.kind, "error");
  assert.ok(outcome.reason.includes("[redacted]"));
  assert.ok(!outcome.reason.includes("the-auth-code"));
  assert.ok(!outcome.reason.includes("sk-short456"));

  const marker = deps.authState.read();
  assert.equal(marker.outcome.kind, "error");
  assert.ok(!marker.outcome.reason.includes("the-auth-code"));
  assert.equal(await deps.keychain.load(), null);
});

test("worker drops tokens when a cancel lands during the token exchange", async () => {
  let resolveExchange;
  const deps = createWorkerDeps({
    fetchImpl: () =>
      new Promise((resolve) => {
        resolveExchange = () =>
          resolve({ ok: true, json: async () => ({ ...FAKE_TOKENS }) });
      }),
  });
  const urlHolder = { url: null };
  deps.openBrowserImpl = async (url) => {
    urlHolder.url = new URL(url);
  };
  const flowPromise = authWorker.createAuthFlow(deps);
  await waitFor(() => urlHolder.url !== null);
  const callback = new URL(urlHolder.url.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", "the-auth-code");
  callback.searchParams.set("state", urlHolder.url.searchParams.get("state"));
  const responsePromise = fetch(callback);

  // Cancel while the exchange request is still pending, then let the
  // exchange succeed: the tokens must still be dropped.
  deps.authState.write({
    phase: "idle",
    outcome: { kind: "cancelled" },
    updated_at: Date.now(),
  });
  assert.deepEqual(await flowPromise, { kind: "cancelled" });
  resolveExchange();
  await assert.rejects(responsePromise);

  assert.equal(await deps.keychain.load(), null);
  assert.deepEqual(deps.authState.read().outcome, { kind: "cancelled" });
});

test("loopback server serves only the OAuth callback path", async () => {
  const handle = await authWorker.startLoopbackServer({
    ports: [0],
    onCallback: async () => authWorker.successPage(),
  });
  try {
    const denied = await fetch(`http://127.0.0.1:${handle.port}/other`);
    assert.equal(denied.status, 404);
    const granted = await fetch(
      `http://127.0.0.1:${handle.port}${oauth.OAUTH.CALLBACK_PATH}`,
    );
    assert.equal(granted.status, 200);
  } finally {
    handle.server.closeAllConnections?.();
    handle.server.close();
  }
});

// ----------------------------------------------------------------- host.js

test("status reports the account phase and auth capability", async () => {
  const deps = createHostDeps();

  const response = await call({ v: 1, type: "status" }, deps);

  assert.equal(response.ok, true);
  assert.equal(response.status, "ready");
  assert.deepEqual(response.capabilities, ["status", "auth", "models"]);
  assert.deepEqual(response.auth, { phase: "signed-out", lastOutcome: null });
});

test("status shows connected with a masked label and no raw identifiers", async () => {
  const deps = createHostDeps({ credentials: credentialsWith() });

  const response = await call({ v: 1, type: "status" }, deps);

  assert.deepEqual(response.auth, {
    phase: "connected",
    accountLabel: "j\u2022\u2022\u2022@e\u2022\u2022\u2022.com",
  });
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("john.doe@example.com"));
  assert.ok(!serialized.includes("at-test"));
  assert.ok(!serialized.includes("rt-test"));
  assert.ok(!serialized.includes(FAKE_TOKENS.id_token));
});

test("status heals a stale authorizing marker into an expired outcome", async () => {
  const deps = createHostDeps();
  deps.now = () => 5_000_000;
  deps.authState.write({
    phase: "authorizing",
    expires_at: 1_000_000,
    updated_at: 900_000,
  });

  const response = await call({ v: 1, type: "status" }, deps);

  assert.deepEqual(response.auth, { phase: "signed-out", lastOutcome: "expired" });
  assert.equal(deps.authState.read().phase, "idle");
  assert.deepEqual(deps.authState.read().outcome, { kind: "expired" });
});

test("status surfaces a reconnect-required account", async () => {
  const deps = createHostDeps({ credentials: credentialsWith() });
  authStateModule.markReconnectRequired(
    deps.authState,
    1,
  );

  const response = await call({ v: 1, type: "status" }, deps);

  assert.equal(response.auth.phase, "reconnect-required");
  assert.equal(response.auth.accountLabel, "j\u2022\u2022\u2022@e\u2022\u2022\u2022.com");
});

test("auth.begin spawns the worker and answers authorizing without secrets", async () => {
  const deps = createHostDeps();

  const response = await call({ v: 1, type: "auth.begin" }, deps);

  assert.equal(response.ok, true);
  assert.equal(response.type, "auth.begin");
  assert.deepEqual(response.auth, { phase: "authorizing" });
  assert.equal(deps.spawned.length, 1);
  const marker = deps.authState.read();
  assert.equal(marker.phase, "authorizing");
  assert.ok(Number.isFinite(marker.expires_at));
  const markerText = JSON.stringify(marker);
  assert.ok(!/[a-f0-9]{40,}/.test(markerText));
  assert.ok(!("url" in response) && !("code" in response) && !("authorizeUrl" in response));
});

test("auth.begin is idempotent while authorizing and refused when connected", async () => {
  const authorizing = createHostDeps();
  authorizing.authState.write({
    phase: "authorizing",
    expires_at: 2_000_000,
    updated_at: 1_000_000,
  });
  const again = await call({ v: 1, type: "auth.begin" }, authorizing);
  assert.deepEqual(again.auth, { phase: "authorizing" });
  assert.equal(authorizing.spawned.length, 0);

  const connected = createHostDeps({ credentials: credentialsWith() });
  const refused = await call({ v: 1, type: "auth.begin" }, connected);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "already-connected");
  assert.equal(connected.spawned.length, 0);
});

test("auth.begin rolls the marker back when the worker cannot start", async () => {
  const deps = createHostDeps();
  deps.spawnAuthWorker = () => {
    throw new Error("spawn exploded");
  };

  const response = await call({ v: 1, type: "auth.begin" }, deps);

  assert.equal(response.ok, false);
  assert.equal(response.error, "auth-worker-failed");
  assert.equal(deps.authState.read(), null);
});

test("auth.cancel ends a pending flow and is a no-op otherwise", async () => {
  const pending = createHostDeps();
  pending.authState.write({
    phase: "authorizing",
    expires_at: 2_000_000,
    updated_at: 1_000_000,
  });
  const cancelled = await call({ v: 1, type: "auth.cancel" }, pending);
  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelled.auth, {
    phase: "signed-out",
    lastOutcome: "cancelled",
  });
  assert.deepEqual(pending.authState.read().outcome, { kind: "cancelled" });

  const idle = createHostDeps();
  const noop = await call({ v: 1, type: "auth.cancel" }, idle);
  assert.equal(noop.ok, true);
  assert.deepEqual(noop.auth, { phase: "signed-out", lastOutcome: null });
});

test("disconnect deletes the keychain credential and every marker", async () => {
  const deps = createHostDeps({ credentials: credentialsWith() });
  authStateModule.markReconnectRequired(deps.authState, 1);

  const response = await call({ v: 1, type: "disconnect" }, deps);

  assert.equal(response.ok, true);
  assert.deepEqual(response.auth, { phase: "signed-out" });
  assert.equal(await deps.keychain.load(), null);
  assert.equal(deps.authState.read(), null);

  const idleDeps = createHostDeps();
  const idleResponse = await call({ v: 1, type: "disconnect" }, idleDeps);
  assert.equal(idleResponse.ok, true);
  assert.deepEqual(idleResponse.auth, { phase: "signed-out" });
});

test("disconnect during a pending flow parks a cancelled marker for the worker", async () => {
  const deps = createHostDeps();
  deps.authState.write({
    phase: "authorizing",
    expires_at: 2_000_000,
    updated_at: 1_000_000,
  });

  const response = await call({ v: 1, type: "disconnect" }, deps);

  assert.equal(response.ok, true);
  assert.deepEqual(response.auth, { phase: "signed-out" });
  assert.equal(await deps.keychain.load(), null);
  const marker = deps.authState.read();
  assert.equal(marker.phase, "idle");
  assert.deepEqual(marker.outcome, { kind: "cancelled" });
});

test("disconnect surfaces keychain failures as a typed error", async () => {
  const deps = createHostDeps({
    keychainOverride: {
      load: async () => null,
      remove: async () => {
        throw new Error("keychain locked");
      },
    },
  });

  const response = await call({ v: 1, type: "disconnect" }, deps);

  assert.equal(response.ok, false);
  assert.equal(response.error, "disconnect-failed");
});

// ------------------------------------------------------ extension contract

function createRuntime(behavior = {}) {
  const calls = [];
  const runtime = {
    lastError: null,
    sendNativeMessage(hostName, message, callback) {
      calls.push({ hostName, message });
      if (behavior.neverRespond) return;
      queueMicrotask(() => {
        if (behavior.errorMessage) {
          runtime.lastError = { message: behavior.errorMessage };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        callback(
          typeof behavior.response === "function"
            ? behavior.response(message)
            : behavior.response,
        );
      });
    },
  };
  runtime.calls = calls;
  return runtime;
}

test("contract sanitizes account fields out of status responses", async () => {
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "status",
      status: "ready",
      protocol: 1,
      companionVersion: "1.2.0",
      capabilities: ["status", "auth"],
      auth: {
        phase: "connected",
        accountLabel: "j\u2022\u2022\u2022@e\u2022\u2022\u2022.com",
        authorizeUrl: "https://auth.openai.com/oauth/authorize?code=leak",
        code: "leak",
        accessToken: "leak-at",
        refreshToken: "leak-rt",
        accountId: "acct-raw",
        lastOutcome: "denied",
      },
    },
  });

  const result = await companion.checkStatus({ runtime });

  assert.deepEqual(result.auth, {
    phase: "connected",
    accountLabel: "j\u2022\u2022\u2022@e\u2022\u2022\u2022.com",
    lastOutcome: "denied",
  });
  assert.equal(result.authSupported, true);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("leak"));
  assert.ok(!serialized.includes("acct-raw"));
});

test("contract reports auth-unsupported companions instead of hiding them", async () => {
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "status",
      status: "ready",
      protocol: 1,
      companionVersion: "1.2.0",
      capabilities: ["status"],
    },
  });

  const result = await companion.checkStatus({ runtime });

  assert.equal(result.state, "ready");
  assert.equal(result.authSupported, false);
  assert.equal(result.auth, null);
});

test("begin, cancel, and disconnect send typed one-shot requests", async () => {
  const runtime = createRuntime({
    response: (message) => ({
      v: 1,
      ok: true,
      type: message.type,
      auth: { phase: message.type === "disconnect" ? "signed-out" : "authorizing" },
    }),
  });

  const begun = await companion.beginAuthorization({ runtime });
  const cancelled = await companion.cancelAuthorization({ runtime });
  const disconnected = await companion.disconnectAccount({ runtime });

  assert.deepEqual(begun, { ok: true, auth: { phase: "authorizing" } });
  assert.deepEqual(cancelled, { ok: true, auth: { phase: "authorizing" } });
  assert.deepEqual(disconnected, { ok: true, auth: { phase: "signed-out" } });
  assert.deepEqual(runtime.calls.map((call) => call.message), [
    { v: 1, type: "auth.begin" },
    { v: 1, type: "auth.cancel" },
    { v: 1, type: "disconnect" },
  ]);
});

test("auth actions classify host refusals and transport failures", async () => {
  const refusal = await companion.beginAuthorization({
    runtime: createRuntime({
      response: { v: 1, ok: false, error: "already-connected" },
    }),
  });
  assert.deepEqual(refusal, { ok: false, reason: "already-connected" });

  const silent = await companion.disconnectAccount({
    runtime: createRuntime({ neverRespond: true }),
    timeoutMs: 10,
  });
  assert.deepEqual(silent, { ok: false, reason: "host-not-responding" });

  const broken = await companion.cancelAuthorization({
    runtime: createRuntime({
      response: { v: 1, ok: true, auth: { phase: "unknown-phase" } },
    }),
  });
  assert.deepEqual(broken, { ok: false, reason: "host-error" });

  const outside = await companion.beginAuthorization({ runtime: undefined });
  assert.deepEqual(outside, { ok: false, reason: "browser-unsupported" });
});

// ------------------------------------------------------------- settings UI

test("settings map every account phase to actionable bilingual copy", () => {
  const views = [
    [
      { companionState: "ready", authSupported: true, phase: "signed-out" },
      "companionAccountSignedOutBadge",
      "companionAccountSignedOutDetail",
      "companionConnect",
      false,
      false,
    ],
    [
      {
        companionState: "ready",
        authSupported: true,
        phase: "signed-out",
        lastOutcome: "expired",
      },
      "companionAccountSignedOutBadge",
      "companionOutcomeExpired",
      "companionConnect",
      false,
      false,
    ],
    [
      {
        companionState: "ready",
        authSupported: true,
        phase: "signed-out",
        lastOutcome: "denied",
      },
      "companionAccountSignedOutBadge",
      "companionOutcomeDenied",
      "companionConnect",
      false,
      false,
    ],
    [
      { companionState: "ready", authSupported: true, phase: "authorizing" },
      "companionAccountAuthorizingBadge",
      "companionAccountAuthorizingDetail",
      null,
      true,
      false,
    ],
    [
      {
        companionState: "ready",
        authSupported: true,
        phase: "connected",
        accountLabel: "j\u2022\u2022\u2022@e\u2022\u2022\u2022.com",
      },
      "companionAccountConnectedBadge",
      "companionAccountConnectedDetail",
      null,
      false,
      true,
    ],
    [
      {
        companionState: "ready",
        authSupported: true,
        phase: "reconnect-required",
      },
      "companionAccountReconnectBadge",
      "companionAccountReconnectDetail",
      "companionReconnect",
      false,
      true,
    ],
    [
      { companionState: "ready", authSupported: false, phase: "signed-out" },
      "companionAccountUpdateBadge",
      "companionAuthUnsupportedDetail",
      null,
      false,
      false,
    ],
  ];

  for (const [
    input,
    badgeKey,
    detailKey,
    connectLabelKey,
    showCancel,
    showDisconnect,
  ] of views) {
    const view = options.describeAccountView(input);
    assert.equal(view.visible, true, JSON.stringify(input));
    assert.equal(view.badgeKey, badgeKey, JSON.stringify(input));
    assert.equal(view.detailKey, detailKey, JSON.stringify(input));
    assert.equal(view.connectLabelKey, connectLabelKey, JSON.stringify(input));
    assert.equal(view.showCancel, showCancel, JSON.stringify(input));
    assert.equal(view.showDisconnect, showDisconnect, JSON.stringify(input));
    for (const language of ["en", "zh-CN"]) {
      assert.ok(
        options.translate(language, badgeKey),
        `${language} copy for ${badgeKey}`,
      );
      assert.ok(
        options.translate(language, detailKey, { label: input.accountLabel ?? null }),
        `${language} copy for ${detailKey}`,
      );
      if (connectLabelKey) {
        assert.ok(
          options.translate(language, connectLabelKey),
          `${language} copy for ${connectLabelKey}`,
        );
      }
    }
  }

  assert.deepEqual(options.describeAccountView({ companionState: "unavailable" }), {
    visible: false,
    phase: "hidden",
  });
  assert.deepEqual(options.describeAccountView({}), {
    visible: false,
    phase: "hidden",
  });
});

test("settings page wires the account actions without storing auth state", () => {
  const html = read("options.html");
  const script = read("options.js");

  assert.match(html, /id="companionAccount"[^>]*hidden/);
  assert.match(html, /id="accountBadge"/);
  assert.match(html, /id="accountDetail"[^>]*role="status"/);
  assert.match(html, /id="companionConnectBtn"[^>]*hidden/);
  assert.match(html, /id="companionCancelAuthBtn"[^>]*hidden/);
  assert.match(html, /id="companionDisconnectBtn"[^>]*hidden/);
  assert.match(html, /id="accountActionStatus"/);
  assert.match(html, /data-i18n="companionAuthPrivacy"/);

  assert.match(script, /beginAuthorization/);
  assert.match(script, /cancelAuthorization/);
  assert.match(script, /disconnectAccount/);
  assert.match(script, /describeAccountView/);
  assert.match(script, /companionDisconnectConfirm/);
  // Account state is rendered from fresh contract results only; the page
  // must not gain a persisted auth setting.
  assert.doesNotMatch(script, /storage\.set\(\{[^}]*auth/s);
});
