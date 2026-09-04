const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const companion = require("../companion.js");
const host = require("../companion/host.js");
const modelsModule = require("../companion/models.js");
const completionsModule = require("../companion/completions.js");

// ------------------------------------------------------------ test doubles

function makeJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const TOKENS = {
  access_token: "at-good",
  refresh_token: "rt-one",
  id_token: makeJwt({ email: "john.doe@example.com" }),
  account_id: "acct-1",
};

function createFakeKeychain(initial = null) {
  let stored = initial;
  const saves = [];
  return {
    load: async () => stored,
    save: async (secret) => {
      saves.push(secret);
      stored = secret;
    },
    remove: async () => {
      stored = null;
    },
    saves,
  };
}

function createFakeAuthState(initial = null) {
  let marker = initial;
  return {
    read: () => (marker ? { ...marker } : null),
    write: (next) => {
      marker = { ...next };
      return marker;
    },
    clear: () => {
      marker = null;
    },
  };
}

function sseResponse(events, { ok = true, status = 200 } = {}) {
  const raw =
    events
      .map((event) =>
        event === "[DONE]" ? "data: [DONE]" : `data: ${JSON.stringify(event)}`,
      )
      .join("\n\n") + "\n\n";
  return {
    ok,
    status,
    headers: { get: () => "text/event-stream" },
    text: async () => raw,
  };
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function textResponse(body, { ok = true, status = 200, contentType = "text/plain" } = {}) {
  return {
    ok,
    status,
    headers: { get: () => contentType },
    text: async () => body,
  };
}

const RESPONSE_OUTPUT = [
  { type: "reasoning", summary: [] },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: '{"chapters":[]}' }],
  },
];

function completedSse(text = '{"chapters":[]}') {
  return [
    { type: "response.output_text.delta", delta: "partial " },
    {
      type: "response.completed",
      response: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
      },
    },
    "[DONE]",
  ];
}

function createService({
  fetchImpl,
  keychain = createFakeKeychain(JSON.stringify(TOKENS)),
  authState = createFakeAuthState(),
  ...rest
} = {}) {
  return completionsModule.createCompletionService({
    fetchImpl,
    keychain,
    authState,
    log: () => {},
    ...rest,
  });
}

const MESSAGES = [
  { role: "system", content: "Summarize the transcript as JSON." },
  { role: "user", content: "[0:00] Hello world" },
];

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

// --------------------------------------------------- companion/completions

test("completion service posts the prompt pair to the Codex responses endpoint", async () => {
  const providerCalls = [];
  const service = createService({
    fetchImpl: async (url, options) => {
      providerCalls.push({ url, options });
      return sseResponse(completedSse('{"ok":true}'));
    },
  });

  const text = await service.runCompletion({
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
    maxTokens: 8192,
  });

  assert.equal(text, '{"ok":true}');
  assert.equal(providerCalls.length, 1);
  const { url, options } = providerCalls[0];
  assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.authorization, "Bearer at-good");
  assert.equal(options.headers["chatgpt-account-id"], "acct-1");

  const body = JSON.parse(options.body);
  assert.equal(body.model, modelsModule.DEFAULT_MODEL_ID);
  assert.equal(body.instructions, "Summarize the transcript as JSON.");
  assert.deepEqual(body.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[0:00] Hello world" }],
    },
  ]);
  // The current Codex model family rejects the parameter outright, so the
  // requested bound is validated but never forwarded to the provider.
  assert.equal("max_output_tokens" in body, false);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(Object.keys(body).includes("originator"), false);
});

test("completion service parses JSON responses and filters non-text output items", async () => {
  const service = createService({
    fetchImpl: async () => jsonResponse({ output: RESPONSE_OUTPUT }),
  });

  const text = await service.runCompletion({
    model: "gpt-5.1",
    messages: MESSAGES,
  });

  assert.equal(text, '{"chapters":[]}');
});

test("completion service falls back to delta text when no completed event arrives", async () => {
  const service = createService({
    fetchImpl: async () =>
      sseResponse([
        { type: "response.output_text.delta", delta: '{"a"' },
        { type: "response.output_text.delta", delta: ':1}' },
        "[DONE]",
      ]),
  });

  const text = await service.runCompletion({
    model: "gpt-5.1",
    messages: MESSAGES,
  });

  assert.equal(text, '{"a":1}');
});

test("a rejected access token refreshes once, re-stores the credential, and retries", async () => {
  const keychain = createFakeKeychain(JSON.stringify(TOKENS));
  const providerCalls = [];
  let backendAttempt = 0;
  const service = createService({
    keychain,
    fetchImpl: async (url, options) => {
      providerCalls.push({ url, options });
      if (url === "https://auth.openai.com/oauth/token") {
        return jsonResponse({
          access_token: "at-new",
          refresh_token: "rt-two",
          id_token: makeJwt({ email: "john.doe@example.com" }),
          account_id: "acct-1",
        });
      }
      backendAttempt += 1;
      if (backendAttempt === 1) {
        return jsonResponse({ error: { message: "token expired" } }, { ok: false, status: 401 });
      }
      return sseResponse(completedSse('{"fresh":true}'));
    },
  });

  const text = await service.runCompletion({
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
  });

  assert.equal(text, '{"fresh":true}');
  const tokenRequest = providerCalls.find((call) =>
    call.url.endsWith("/oauth/token"),
  );
  assert.ok(tokenRequest, "the refresh grant was posted");
  const form = new URLSearchParams(tokenRequest.options.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "rt-one");

  const backendCalls = providerCalls.filter((call) =>
    call.url.includes("codex/responses"),
  );
  assert.equal(backendCalls.length, 2);
  assert.equal(backendCalls[0].options.headers.authorization, "Bearer at-good");
  assert.equal(backendCalls[1].options.headers.authorization, "Bearer at-new");

  const stored = JSON.parse(keychain.saves.at(-1));
  assert.equal(stored.access_token, "at-new");
  assert.equal(stored.refresh_token, "rt-two");
  assert.equal(stored.account_id, "acct-1");
});

test("a rejected refresh marks reconnect-required and later requests fail fast", async () => {
  const keychain = createFakeKeychain(JSON.stringify(TOKENS));
  const authState = createFakeAuthState();
  const fetchCalls = [];
  const service = createService({
    keychain,
    authState,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      if (url.endsWith("/oauth/token")) {
        return textResponse("invalid_grant", { ok: false, status: 400 });
      }
      return jsonResponse({ error: { message: "expired" } }, { ok: false, status: 401 });
    },
  });

  await assert.rejects(
    service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "reconnect-required",
  );
  assert.equal(authState.read().phase, "reconnect-required");
  const callsAfterFailure = fetchCalls.length;
  assert.ok(callsAfterFailure >= 2, "one provider call plus one refresh attempt");

  await assert.rejects(
    service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "reconnect-required",
  );
  assert.equal(
    fetchCalls.length,
    callsAfterFailure,
    "the reconnect marker short-circuits before any provider call",
  );
});

test("provider failures map to typed completion errors", async () => {
  const cases = [
    [403, { error: { message: "model not allowed" } }, "entitlement-denied"],
    [404, { error: { message: "unknown model" } }, "model-unavailable"],
    [429, { error: { message: "slow down" } }, "rate-limited"],
    [500, { error: { message: "boom" } }, "provider-error"],
  ];
  for (const [status, payload, expectedCode] of cases) {
    const service = createService({
      fetchImpl: async () => jsonResponse(payload, { ok: false, status }),
    });
    await assert.rejects(
      service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
      (error) => error.code === expectedCode,
      `HTTP ${status} should map to ${expectedCode}`,
    );
  }
});

test("SSE failure events become provider errors without leaking tokens", async () => {
  const service = createService({
    fetchImpl: async () =>
      sseResponse([
        { type: "response.failed", response: { error: { code: "server_error" } } },
      ]),
  });

  await assert.rejects(
    service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "provider-error" && !error.message.includes("at-good"),
  );
});

test("an aborted provider request reports a typed timeout", async () => {
  const service = createService({
    fetchImpl: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
  });

  await assert.rejects(
    service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "provider-timeout",
  );
});

test("empty and oversized completions are typed failures", async () => {
  const empty = createService({
    fetchImpl: async () => sseResponse([{ type: "response.completed", response: { output: [] } }, "[DONE]"]),
  });
  await assert.rejects(
    empty.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "empty-response",
  );

  const tooLarge = createService({
    fetchImpl: async () =>
      sseResponse(completedSse("x".repeat(completionsModule.COMPLETIONS.MAX_TEXT_CHARS + 1))),
  });
  await assert.rejects(
    tooLarge.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "response-too-large",
  );
});

test("credential problems map to signed-out and reconnect-required", async () => {
  const signedOut = createService({
    keychain: createFakeKeychain(null),
    fetchImpl: async () => {
      throw new Error("provider must not be called");
    },
  });
  await assert.rejects(
    signedOut.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "signed-out",
  );

  const corrupt = createService({
    keychain: createFakeKeychain("not-json"),
    authState: createFakeAuthState(),
    fetchImpl: async () => {
      throw new Error("provider must not be called");
    },
  });
  await assert.rejects(
    corrupt.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "reconnect-required",
  );
  // The corrupt credential is classified, not silently signed out.
  assert.ok(corrupt);
});

test("request validation rejects bad messages, models, and token budgets", async () => {
  const service = createService({
    fetchImpl: async () => {
      throw new Error("provider must not be called");
    },
  });
  const invalidMessages = [
    undefined,
    [],
    "not-an-array",
    [{ role: "assistant", content: "hi" }],
    [{ role: "user", content: "" }],
    [{ role: "user" }],
    [{ role: "system", content: "only system" }],
    Array.from({ length: 17 }, (_unused, index) => ({
      role: "user",
      content: `line ${index}`,
    })),
    [
      { role: "user", content: "a".repeat(600_000) },
      { role: "user", content: "b".repeat(600_000) },
    ],
  ];
  for (const messages of invalidMessages) {
    await assert.rejects(
      service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages }),
      (error) =>
        error.code === "invalid-request" || error.code === "request-too-large",
      JSON.stringify(messages?.length),
    );
  }

  for (const maxTokens of [0, -1, 1.5, "8192", 99_999]) {
    await assert.rejects(
      service.runCompletion({
        model: modelsModule.DEFAULT_MODEL_ID,
        messages: MESSAGES,
        maxTokens,
      }),
      (error) => error.code === "invalid-request",
    );
  }

  await assert.rejects(
    service.runCompletion({ model: "", messages: MESSAGES }),
    (error) => error.code === "invalid-request",
  );
});

test("pure helpers extract text and parse SSE frames defensively", () => {
  assert.equal(
    completionsModule.extractTextFromResponse({
      output: [
        { type: "function_call", arguments: "{}" },
        { content: [{ text: "direct" }] },
        { type: "message", role: "user", content: [{ text: "ignored" }] },
        { type: "message", role: "assistant", content: [{ text: "kept" }] },
      ],
    }),
    "directkept",
  );
  assert.equal(completionsModule.extractTextFromResponse(null), "");
  assert.equal(completionsModule.extractTextFromResponse("nope"), "");

  const events = completionsModule.parseSseEvents(
    'data: {"type":"a"}\n\ndata: not-json\n\ndata: [DONE]\n\nnoise\n',
  );
  assert.deepEqual(events, [{ type: "a" }]);
});

// ------------------------------------------------------------- host wiring

function createHostDeps({ completionsBehavior } = {}) {
  const completionCalls = [];
  return {
    authState: createFakeAuthState(),
    keychain: createFakeKeychain(null),
    completions: {
      async runCompletion(request) {
        completionCalls.push(request);
        if (typeof completionsBehavior === "function") {
          return completionsBehavior(request);
        }
        if (completionsBehavior?.error) {
          const error = new Error("typed failure");
          error.code = completionsBehavior.error;
          throw error;
        }
        return completionsBehavior?.text ?? '{"chapters":[]}';
      },
    },
    spawnAuthWorker() {},
    now: () => 1_000_000,
    completionCalls,
  };
}

test("completion.create converts the request and whitelists the reply", async () => {
  const deps = createHostDeps({
    completionsBehavior: (request) => {
      assert.equal(request.model, modelsModule.DEFAULT_MODEL_ID);
      assert.deepEqual(request.messages, MESSAGES);
      assert.equal(request.maxTokens, 8192);
      return '{"chapters":[{"title":"Intro"}]}';
    },
  });

  const response = await host.handleRequest(
    {
      v: 1,
      type: "completion.create",
      model: modelsModule.DEFAULT_MODEL_ID,
      messages: MESSAGES,
      maxTokens: 8192,
    },
    deps,
  );

  assert.deepEqual(response, {
    v: 1,
    ok: true,
    type: "completion.create",
    text: '{"chapters":[{"title":"Intro"}]}',
  });
  assert.equal(deps.completionCalls.length, 1);
  assert.ok(!JSON.stringify(response).includes("at-"));
});

test("completion.create gates the model before touching credentials", async () => {
  const deps = createHostDeps();

  const unknown = await host.handleRequest(
    { v: 1, type: "completion.create", model: "gpt-99-future", messages: MESSAGES },
    deps,
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "model-unavailable");

  for (const malformed of [undefined, 42, "bad model!"]) {
    const response = await host.handleRequest(
      { v: 1, type: "completion.create", model: malformed, messages: MESSAGES },
      deps,
    );
    assert.equal(response.ok, false);
    assert.equal(response.error, "invalid-request");
  }
  assert.equal(deps.completionCalls.length, 0);
});

test("typed service failures cross the contract and unknown errors become host-error", async () => {
  const deps = createHostDeps({ completionsBehavior: { error: "entitlement-denied" } });
  const response = await host.handleRequest(
    { v: 1, type: "completion.create", model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES },
    deps,
  );
  assert.equal(response.ok, false);
  assert.equal(response.error, "entitlement-denied");

  const unexpected = createHostDeps({
    completionsBehavior: async () => {
      throw new Error("surprise");
    },
  });
  const crashed = await host.handleRequest(
    { v: 1, type: "completion.create", model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES },
    unexpected,
  );
  assert.equal(crashed.ok, false);
  assert.equal(crashed.error, "host-error");
});

test("failed completions keep transcript content out of logs, state, and replies", async () => {
  const canary = "CANARY-TRANSCRIPT-LINE-ZERO-THROUGH-NINE";
  const messages = [
    { role: "system", content: "Summarize the transcript as JSON." },
    { role: "user", content: `[0:00] ${canary}` },
  ];
  const logged = [];
  const authState = createFakeAuthState();
  const service = completionsModule.createCompletionService({
    // A provider that fails verbosely and echoes request content inside its
    // own error body is the worst case: transcript text must still never
    // reach stderr, the state file, or the extension reply.
    fetchImpl: async () =>
      jsonResponse(
        { error: { message: `provider exploded while reading ${canary}` } },
        { ok: false, status: 500 },
      ),
    keychain: createFakeKeychain(JSON.stringify(TOKENS)),
    authState,
    log: (message) => logged.push(message),
  });

  await assert.rejects(
    service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages }),
    (error) => error.code === "provider-error",
  );
  assert.equal(logged.join("\n").includes(canary), false);
  assert.equal(JSON.stringify(authState.read()).includes(canary), false);

  const deps = createHostDeps();
  deps.authState = authState;
  deps.completions = service;
  const response = await host.handleRequest(
    { v: 1, type: "completion.create", model: modelsModule.DEFAULT_MODEL_ID, messages },
    deps,
  );
  assert.equal(response.ok, false);
  assert.equal(response.error, "provider-error");
  assert.equal(JSON.stringify(response).includes(canary), false);
});

test("host serves a completion end-to-end through the real service", async () => {
  const deps = createHostDeps();
  deps.keychain = createFakeKeychain(JSON.stringify(TOKENS));
  deps.completions = completionsModule.createCompletionService({
    fetchImpl: async () => sseResponse(completedSse('{"end":"to-end"}')),
    keychain: deps.keychain,
    authState: deps.authState,
    log: () => {},
  });

  const response = await host.handleRequest(
    {
      v: 1,
      type: "completion.create",
      model: modelsModule.DEFAULT_MODEL_ID,
      messages: MESSAGES,
      maxTokens: 512,
    },
    deps,
  );

  assert.equal(response.ok, true);
  assert.equal(response.text, '{"end":"to-end"}');
});

test("extension and host enforce one aligned completion contract", () => {
  assert.equal(companion.PROTOCOL_VERSION, host.PROTOCOL_VERSION);
  assert.deepEqual(
    companion.SUPPORTED_PROTOCOL_VERSIONS,
    host.CONTRACT.SUPPORTED_PROTOCOL_VERSIONS,
  );
  // The size bounds are mirrored on both sides of the trust boundary by
  // design; this pin keeps a future edit from silently splitting them.
  assert.equal(
    companion.DEFAULT_COMPLETION_TIMEOUT_MS,
    120_000,
  );
  assert.ok(
    completionsModule.COMPLETIONS.PROVIDER_TIMEOUT_MS <
      companion.DEFAULT_COMPLETION_TIMEOUT_MS,
    "the provider timeout must fire before the extension gives up",
  );
  const maxima = host.CONTRACT.MAX_OUTBOUND_MESSAGE_BYTES;
  assert.ok(
    Buffer.byteLength("x".repeat(completionsModule.COMPLETIONS.MAX_TEXT_CHARS), "utf8") <=
      maxima,
    "the text cap must fit one native-messaging frame",
  );
});

test("abortActive cancels an in-flight provider request", async () => {
  const service = createService({
    fetchImpl: (url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const pending = service.runCompletion({
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
  });
  const assertion = assert.rejects(
    pending,
    (error) => error.code === "provider-timeout",
  );
  await new Promise((resolve) => setImmediate(resolve));
  service.abortActive();
  await assertion;
});

test("a transient refresh failure stays retryable and keeps the account connected", async () => {
  const keychain = createFakeKeychain(JSON.stringify(TOKENS));
  const authState = createFakeAuthState();
  const service = createService({
    keychain,
    authState,
    fetchImpl: async (url) => {
      if (url.endsWith("/oauth/token")) {
        const error = new Error("fetch failed");
        throw error;
      }
      return jsonResponse({ error: { message: "expired" } }, { ok: false, status: 401 });
    },
  });

  await assert.rejects(
    service.runCompletion({ model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES }),
    (error) => error.code === "provider-error",
  );
  assert.equal(authState.read(), null, "no reconnect marker was written");
  assert.equal(keychain.saves.length, 0, "the stored credential is untouched");

  // After connectivity returns, the same stored credential works again.
  const recovered = completionsModule.createCompletionService({
    fetchImpl: async () => sseResponse(completedSse('{"back":true}')),
    keychain,
    authState,
    log: () => {},
  });
  const text = await recovered.runCompletion({
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
  });
  assert.equal(text, '{"back":true}');
});

test("host gates oversized completions by byte length, not char count", async () => {
  // 310k CJK chars are under the 400k-char text cap but over the 900KB
  // frame budget once encoded as UTF-8 (3 bytes per char).
  const cjk = "\u4e2d".repeat(310_000);
  const deps = createHostDeps({ completionsBehavior: { text: cjk } });

  const response = await host.handleRequest(
    { v: 1, type: "completion.create", model: modelsModule.DEFAULT_MODEL_ID, messages: MESSAGES },
    deps,
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "response-too-large");
});

test("status advertises the completions capability", async () => {
  const deps = createHostDeps();
  const status = await host.handleRequest({ v: 1, type: "status" }, deps);
  assert.deepEqual(status.capabilities, [
    "status",
    "auth",
    "models",
    "completions",
  ]);
});

// ------------------------------------------------------ extension contract

test("contract sends one completion.create and whitelists the reply text", async () => {
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "completion.create",
      text: '{"chapters":[]}',
    },
  });

  const result = await companion.requestCompletion({
    runtime,
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
    maxTokens: 8192,
  });

  assert.deepEqual(result, { ok: true, text: '{"chapters":[]}' });
  assert.deepEqual(runtime.calls, [
    {
      hostName: companion.HOST_NAME,
      message: {
        v: 1,
        type: "completion.create",
        model: modelsModule.DEFAULT_MODEL_ID,
        messages: MESSAGES,
        maxTokens: 8192,
      },
    },
  ]);
  assert.equal(companion.DEFAULT_COMPLETION_TIMEOUT_MS, 120_000);
});

test("contract omits maxTokens when none is requested", async () => {
  const runtime = createRuntime({
    response: { v: 1, ok: true, type: "completion.create", text: "ok" },
  });

  await companion.requestCompletion({
    runtime,
    model: "gpt-5.1",
    messages: MESSAGES,
  });

  assert.ok(!("maxTokens" in runtime.calls[0].message));
});

test("contract drops extra reply fields and rejects malformed completions", async () => {
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "completion.create",
      text: '{"chapters":[]}',
      accessToken: "leak-at",
      endpoint: "https://chatgpt.com/leak",
    },
  });

  const result = await companion.requestCompletion({
    runtime,
    model: "gpt-5.1",
    messages: MESSAGES,
  });

  assert.deepEqual(result, { ok: true, text: '{"chapters":[]}' });
  assert.ok(!JSON.stringify(result).includes("leak"));

  for (const text of [undefined, "", "   ", 42, "x".repeat(400_001)]) {
    const malformed = await companion.requestCompletion({
      runtime: createRuntime({
        response: { v: 1, ok: true, type: "completion.create", text },
      }),
      model: "gpt-5.1",
      messages: MESSAGES,
    });
    assert.deepEqual(
      malformed,
      { ok: false, reason: "completion-malformed" },
      JSON.stringify(text?.length),
    );
  }
});

test("contract surfaces typed provider failures and transport timeouts", async () => {
  const entitlement = await companion.requestCompletion({
    runtime: createRuntime({
      response: { v: 1, ok: false, error: "entitlement-denied" },
    }),
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
  });
  assert.deepEqual(entitlement, { ok: false, reason: "entitlement-denied" });

  const outdated = await companion.requestCompletion({
    runtime: createRuntime({ response: { v: 2, ok: false } }),
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
  });
  assert.deepEqual(outdated, { ok: false, reason: "protocol-unsupported" });

  const silent = await companion.requestCompletion({
    runtime: createRuntime({ neverRespond: true }),
    model: modelsModule.DEFAULT_MODEL_ID,
    messages: MESSAGES,
    timeoutMs: 10,
  });
  assert.deepEqual(silent, { ok: false, reason: "host-not-responding" });
});

test("contract validates the outbound request before touching native messaging", async () => {
  const runtime = createRuntime({
    response: { v: 1, ok: true, type: "completion.create", text: "unused" },
  });

  const invalid = [
    { model: "bad model!", messages: MESSAGES },
    { model: 42, messages: MESSAGES },
    { model: "gpt-5.1", messages: [] },
    { model: "gpt-5.1", messages: "nope" },
    {
      model: "gpt-5.1",
      messages: [
        { role: "user", content: "a".repeat(600_000) },
        { role: "user", content: "b".repeat(600_000) },
      ],
    },
  ];
  for (const input of invalid) {
    const result = await companion.requestCompletion({ runtime, ...input });
    assert.deepEqual(
      result,
      { ok: false, reason: "invalid-request" },
      JSON.stringify(input.model),
    );
  }
  assert.equal(runtime.calls.length, 0);
});

// ------------------------------------- background: the AI-completion boundary

function loadBackgroundHelpers({
  settings = {
    provider: "codex",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    codexModel: "gpt-5.3-codex",
    supadataApiKey: "sup-key",
  },
  fetchImpl = fetch,
  companionApi,
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: () => 0,
    clearTimeout: () => {},
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => ({ [key]: localStorage[key] }),
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: () => "https://api.deepseek.com/chat/completions",
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  if (companionApi) sandbox.YTD_COMPANION = companionApi;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

function createFakeCompanion({ result } = {}) {
  const requests = [];
  return {
    requests,
    HOST_NAME: companion.HOST_NAME,
    PROTOCOL_VERSION: companion.PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS: companion.SUPPORTED_PROTOCOL_VERSIONS,
    DEFAULT_COMPLETION_TIMEOUT_MS: companion.DEFAULT_COMPLETION_TIMEOUT_MS,
    REASON: companion.REASON,
    STATUS: companion.STATUS,
    async requestCompletion(options) {
      requests.push(options);
      return typeof result === "function" ? result(options) : result;
    },
  };
}

const TRANSCRIPT = "[0:00] Hello world\n[0:42] Second line";

function analysisText() {
  return JSON.stringify({
    chapters: [
      { title: "Intro", summary: "Greeting.", timestampSeconds: 0 },
      { title: "Body", summary: "Details.", timestampSeconds: 30 },
    ],
    keyQuotes: [
      { quote: "Hello world", timestampSeconds: 0 },
    ],
    keyMoments: [0, 30],
  });
}

test("codex digest delegates the completion to the companion", async () => {
  const fakeCompanion = createFakeCompanion({
    result: { ok: true, text: analysisText() },
  });
  const fetchCalls = [];
  const background = loadBackgroundHelpers({
    companionApi: fakeCompanion,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/analysis.md") };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  const result = await background.handleAnalyzeTranscript(
    TRANSCRIPT,
    "Test video",
    "Test channel",
    "Description",
    90,
  );

  assert.equal(result.success, true);
  assert.equal(result.analysis.chapters.length, 2);
  assert.equal(result.analysis.chapters[0].timestamp, "0:00");
  assert.equal(fakeCompanion.requests.length, 1);
  const request = fakeCompanion.requests[0];
  assert.equal(request.model, "gpt-5.3-codex");
  assert.equal(request.maxTokens, 8192);
  assert.equal(request.timeoutMs, companion.DEFAULT_COMPLETION_TIMEOUT_MS);
  assert.deepEqual(
    JSON.parse(JSON.stringify(request.messages.map((message) => message.role))),
    ["system", "user"],
  );
  assert.match(request.messages[1].content, /\[0:00\] Hello world/);
  // The DeepSeek API is never contacted on the Codex path.
  assert.ok(
    fetchCalls.every((url) => url.startsWith("chrome-extension://")),
    fetchCalls.join(", "),
  );
});

test("codex failures surface actionable provider, model, and timeout states", async () => {
  const cases = [
    ["provider-timeout", /ChatGPT \/ Codex \(gpt-5\.3-codex\).*time limit.*Retry/s],
    ["entitlement-denied", /ChatGPT plan does not include gpt-5\.3-codex.*Settings/s],
    ["reconnect-required", /ChatGPT \/ Codex.*Settings.*reconnect/s],
    ["model-unavailable", /model gpt-5\.3-codex is not offered.*Settings/s],
    ["signed-out", /no account is connected.*Settings/s],
    ["rate-limited", /rate-limiting.*retry/s],
    ["host-not-responding", /companion is unavailable.*Settings/s],
    ["unknown-request-type", /companion is too old.*Update/s],
  ];
  for (const [reason, pattern] of cases) {
    const fakeCompanion = createFakeCompanion({
      result: { ok: false, reason },
    });
    const background = loadBackgroundHelpers({
      companionApi: fakeCompanion,
      fetchImpl: async (url) => {
        if (url.startsWith("chrome-extension://")) {
          return { ok: true, text: async () => read("prompts/analysis.md") };
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    const result = await background.handleAnalyzeTranscript(
      TRANSCRIPT,
      "Test video",
      "Test channel",
      "Description",
      90,
    );

    assert.equal(result.success, false, reason);
    assert.match(result.error, pattern, `${reason}: ${result.error}`);
  }
});

test("a codex provider without a saved model reports a Settings recovery", async () => {
  const fakeCompanion = createFakeCompanion({
    result: { ok: true, text: "unused" },
  });
  const background = loadBackgroundHelpers({
    settings: {
      provider: "codex",
      aiApiKey: "",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
      codexModel: "",
      supadataApiKey: "sup-key",
    },
    companionApi: fakeCompanion,
  });

  const result = await background.handleAnalyzeTranscript(
    TRANSCRIPT,
    "Test video",
    "Test channel",
    "Description",
    90,
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "NO_AI_KEY");
  assert.match(result.message, /ChatGPT \/ Codex model.*Settings/);
  assert.equal(fakeCompanion.requests.length, 0);
});

test("DeepSeek requests keep their DeepSeek-only fields and never use the companion", async () => {
  const fakeCompanion = createFakeCompanion({
    result: { ok: true, text: "unused" },
  });
  const providerRequests = [];
  const background = loadBackgroundHelpers({
    settings: {
      provider: "deepseek",
      aiApiKey: "sk-test-key",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
      codexModel: "",
      supadataApiKey: "sup-key",
    },
    companionApi: fakeCompanion,
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/analysis.md") };
      }
      if (url === "https://api.deepseek.com/chat/completions") {
        providerRequests.push({ url, options });
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: analysisText() } }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  const completion = await background.requestAiCompletion({
    maxTokens: 8192,
    responseFormat: { type: "json_object" },
    messages: MESSAGES,
  });
  assert.equal(completion.text, analysisText());

  const result = await background.handleAnalyzeTranscript(
    TRANSCRIPT,
    "Test video",
    "Test channel",
    "Description",
    90,
  );
  assert.equal(result.success, true);
  assert.equal(result.analysis.chapters.length, 2);

  assert.equal(fakeCompanion.requests.length, 0);
  assert.equal(providerRequests.length, 2);
  for (const { options } of providerRequests) {
    const body = JSON.parse(options.body);
    assert.equal(body.model, "deepseek-v4-flash");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(options.headers.Authorization, "Bearer sk-test-key");
    assert.ok(!("instructions" in body));
    assert.ok(!("store" in body));
  }
});

test("background checks the provider-specific AI requirement for config", async () => {
  const source = read("background.js");
  // The config surface a connected Codex user sees must not demand a
  // DeepSeek key, and DeepSeek users must not be pushed to connect Codex.
  assert.match(source, /hasAiKey: aiProviderConfigured\(settings\)/);
  assert.match(source, /provider: settings\.provider/);
  assert.match(
    source,
    /settings\.provider === "codex"\s*\?\s*Boolean\(settings\.codexModel\)/,
  );
});
