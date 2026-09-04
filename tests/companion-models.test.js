const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const companion = require("../companion.js");
const host = require("../companion/host.js");
const modelsModule = require("../companion/models.js");
const authStateModule = require("../companion/auth-state.js");
const settings = require("../settings.js");
const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ytd-models-state-"));
}

function makeJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const FAKE_TOKENS = {
  access_token: "at-test",
  refresh_token: "rt-test",
  id_token: makeJwt({ email: "john.doe@example.com" }),
  account_id: "acct-test",
};

function createHostDeps({ credentials = null } = {}) {
  const stateDir = makeStateDir();
  return {
    authState: authStateModule.createAuthState({ dir: stateDir }),
    keychain: {
      load: async () => credentials,
      save: async () => {},
      remove: async () => true,
    },
    spawnAuthWorker() {},
    now: () => 1_000_000,
  };
}

async function call(request, deps = createHostDeps()) {
  return host.handleRequest(request, deps);
}

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

// -------------------------------------------------------------- models.js

test("companion catalog is a sanitized, unique, canonical model list", () => {
  const catalog = modelsModule.CATALOG;

  assert.ok(catalog.length >= 4, "the catalog offers a real choice");
  assert.equal(catalog.length, new Set(catalog.map((m) => m.id)).size);
  for (const model of catalog) {
    assert.deepEqual(Object.keys(model).sort(), ["id", "label"]);
    assert.match(model.id, /^[a-z0-9][a-z0-9.-]{0,63}$/);
    assert.equal(model.label.length, model.label.trim().length);
    assert.ok(model.label.length > 0 && model.label.length <= 64);
  }
  assert.ok(
    modelsModule.findModel(modelsModule.DEFAULT_MODEL_ID),
    "the default model exists in the catalog",
  );
  assert.equal(modelsModule.findModel("not-in-catalog"), null);
  assert.equal(modelsModule.findModel(42), null);
});

// ----------------------------------------------------------------- host.js

test("models.list answers with the catalog and the models capability", async () => {
  const deps = createHostDeps();

  const statusResponse = await call({ v: 1, type: "status" }, deps);
  assert.deepEqual(statusResponse.capabilities, [
    "status",
    "auth",
    "models",
  ]);

  const response = await call({ v: 1, type: "models.list" }, deps);

  assert.equal(response.ok, true);
  assert.equal(response.type, "models.list");
  assert.equal(response.defaultModel, modelsModule.DEFAULT_MODEL_ID);
  assert.deepEqual(
    response.models,
    modelsModule.CATALOG.map((model) => ({ ...model })),
  );
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("at-test"));
  assert.ok(!serialized.includes("rt-test"));
});

test("models.list works regardless of the account phase", async () => {
  const connected = createHostDeps({
    credentials: JSON.stringify(FAKE_TOKENS),
  });
  const signedOut = createHostDeps();

  for (const deps of [connected, signedOut]) {
    const response = await call({ v: 1, type: "models.list" }, deps);
    assert.equal(response.ok, true);
    assert.ok(response.models.length > 0);
  }
});

test("models.validate confirms catalog models and types every rejection", async () => {
  const deps = createHostDeps();

  const confirmed = await call(
    { v: 1, type: "models.validate", model: modelsModule.DEFAULT_MODEL_ID },
    deps,
  );
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.type, "models.validate");
  assert.deepEqual(confirmed.model, {
    id: modelsModule.DEFAULT_MODEL_ID,
    label: modelsModule.findModel(modelsModule.DEFAULT_MODEL_ID).label,
  });

  const unknown = await call(
    { v: 1, type: "models.validate", model: "gpt-99-future" },
    deps,
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "model-unavailable");

  for (const malformed of [undefined, 42, "", "x".repeat(65), "bad id!"]) {
    const response = await call(
      { v: 1, type: "models.validate", model: malformed },
      deps,
    );
    assert.equal(response.ok, false, JSON.stringify(malformed));
    assert.equal(response.error, "invalid-request", JSON.stringify(malformed));
  }

  const protocol = await call({ v: 99, type: "models.list" }, deps);
  assert.equal(protocol.error, "unsupported-protocol");
});

// ------------------------------------------------------ extension contract

test("contract loads the catalog through one models.list request", async () => {
  const catalog = [
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { id: "gpt-5.1", label: "GPT-5.1" },
  ];
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "models.list",
      models: catalog,
      defaultModel: "gpt-5.1-codex",
    },
  });

  const result = await companion.requestModelCatalog({ runtime });

  assert.deepEqual(result, {
    ok: true,
    models: catalog,
    defaultModel: "gpt-5.1-codex",
  });
  assert.deepEqual(runtime.calls, [
    { hostName: companion.HOST_NAME, message: { v: 1, type: "models.list" } },
  ]);
});

test("contract maps the models capability from status results", async () => {
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "status",
      status: "ready",
      protocol: 1,
      companionVersion: "1.2.0",
      capabilities: ["status", "auth", "models"],
      auth: { phase: "connected" },
    },
  });

  const result = await companion.checkStatus({ runtime });

  assert.equal(result.modelsSupported, true);
});

test("contract drops extra catalog fields and non-string labels", async () => {
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "models.list",
      models: [
        {
          id: "gpt-5.1-codex",
          label: "GPT-5.1 Codex",
          accessToken: "leak-at",
          endpoint: "https://chatgpt.com/leak",
        },
        { id: "gpt-5.1" },
      ],
      defaultModel: "gpt-5.1-codex",
    },
  });

  const result = await companion.requestModelCatalog({ runtime });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { id: "gpt-5.1" },
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("leak"));
});

test("contract rejects malformed catalogs with a typed reason", async () => {
  const cases = [
    { v: 1, ok: true, type: "models.list" },
    { v: 1, ok: true, type: "models.list", models: "gpt-5.1" },
    { v: 1, ok: true, type: "models.list", models: [] },
    {
      v: 1,
      ok: true,
      type: "models.list",
      models: [{ label: "Missing id" }],
    },
    {
      v: 1,
      ok: true,
      type: "models.list",
      models: [{ id: "invalid id!" }],
    },
    {
      v: 1,
      ok: true,
      type: "models.list",
      models: [{ id: "gpt-5.1", label: 42 }],
    },
    {
      v: 1,
      ok: true,
      type: "models.list",
      models: [
        { id: "gpt-5.1", label: "GPT-5.1" },
        { id: "gpt-5.1", label: "GPT-5.1 again" },
      ],
    },
    {
      v: 1,
      ok: true,
      type: "models.list",
      models: Array.from({ length: 33 }, (_unused, index) => ({
        id: `gpt-${index}`,
        label: `GPT ${index}`,
      })),
    },
  ];

  for (const response of cases) {
    const result = await companion.requestModelCatalog({
      runtime: createRuntime({ response }),
    });
    assert.deepEqual(
      result,
      { ok: false, reason: "catalog-malformed" },
      JSON.stringify(response),
    );
  }
});

test("contract reports unavailable catalogs from transport and host failures", async () => {
  const silent = await companion.requestModelCatalog({
    runtime: createRuntime({ neverRespond: true }),
    timeoutMs: 10,
  });
  assert.deepEqual(silent, { ok: false, reason: "host-not-responding" });

  const refused = await companion.requestModelCatalog({
    runtime: createRuntime({
      response: { v: 1, ok: false, error: "catalog-empty" },
    }),
  });
  assert.deepEqual(refused, { ok: false, reason: "catalog-empty" });

  const outdated = await companion.requestModelCatalog({
    runtime: createRuntime({ response: { v: 2, ok: false } }),
  });
  assert.deepEqual(outdated, { ok: false, reason: "protocol-unsupported" });

  const outside = await companion.requestModelCatalog({ runtime: undefined });
  assert.deepEqual(outside, { ok: false, reason: "browser-unsupported" });
});

test("contract validates a selected model and surfaces model-unavailable", async () => {
  const runtime = createRuntime({
    response: (message) => ({
      v: 1,
      ok: true,
      type: message.type,
      model: { id: message.model, label: "GPT-5.1 Codex" },
    }),
  });

  const confirmed = await companion.validateModel({
    runtime,
    model: "gpt-5.1-codex",
  });
  assert.deepEqual(confirmed, {
    ok: true,
    model: { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  });
  assert.deepEqual(runtime.calls, [
    {
      hostName: companion.HOST_NAME,
      message: { v: 1, type: "models.validate", model: "gpt-5.1-codex" },
    },
  ]);

  const unavailable = await companion.validateModel({
    runtime: createRuntime({
      response: { v: 1, ok: false, error: "model-unavailable" },
    }),
    model: "gpt-99-future",
  });
  assert.deepEqual(unavailable, { ok: false, reason: "model-unavailable" });

  const outside = await companion.validateModel({
    runtime: undefined,
    model: "gpt-5.1-codex",
  });
  assert.deepEqual(outside, { ok: false, reason: "browser-unsupported" });
});

// ---------------------------------------------------------------- settings

test("settings keep the DeepSeek and Codex choices independent", () => {
  const codexSaved = settings.normalize({
    provider: "codex",
    codexModel: "  gpt-5.1-codex  ",
    aiApiKey: "deepseek-key",
    supadataApiKey: "supadata-key",
  });
  assert.equal(codexSaved.provider, "codex");
  assert.equal(codexSaved.codexModel, "gpt-5.1-codex");
  assert.equal(codexSaved.aiApiKey, "deepseek-key");
  assert.equal(codexSaved.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(codexSaved.aiModel, settings.DEFAULTS.aiModel);

  // Switching back to DeepSeek keeps the saved Codex model for later.
  const switchedBack = settings.normalize({
    ...codexSaved,
    provider: "deepseek",
  });
  assert.equal(switchedBack.provider, "deepseek");
  assert.equal(switchedBack.codexModel, "gpt-5.1-codex");
  assert.equal(switchedBack.aiApiKey, "deepseek-key");

  // DeepSeek-only settings never gain a Codex model by default.
  const deepSeekOnly = settings.normalize({ aiApiKey: "key" });
  assert.equal(deepSeekOnly.provider, "deepseek");
  assert.equal(deepSeekOnly.codexModel, "");
});

test("settings normalize the provider and reject malformed codex models", () => {
  assert.equal(settings.normalize({ provider: "codex" }).provider, "codex");
  assert.equal(settings.normalize({ provider: "unknown" }).provider, "deepseek");
  assert.equal(settings.normalize({}).provider, "deepseek");

  assert.equal(settings.normalize({ codexModel: "bad model!" }).codexModel, "");
  assert.equal(settings.normalize({ codexModel: 42 }).codexModel, "");
  assert.equal(
    settings.normalize({ codexModel: "x".repeat(65) }).codexModel,
    "",
  );
});

// -------------------------------------------------------------- settings UI

test("settings map every codex model state to actionable bilingual copy", () => {
  const views = [
    [
      {
        companionState: "ready",
        modelsSupported: true,
        authPhase: "connected",
      },
      true,
      null,
    ],
    [
      {
        companionState: "ready",
        modelsSupported: true,
        authPhase: "signed-out",
      },
      false,
      "codexConnectFirst",
    ],
    [
      {
        companionState: "ready",
        modelsSupported: true,
        authPhase: "authorizing",
      },
      false,
      "codexConnectFirst",
    ],
    [
      {
        companionState: "ready",
        modelsSupported: true,
        authPhase: "reconnect-required",
      },
      false,
      "codexConnectFirst",
    ],
    [
      {
        companionState: "ready",
        modelsSupported: false,
        authPhase: "connected",
      },
      false,
      "companionModelsUnsupportedDetail",
    ],
    [
      { companionState: "unavailable", modelsSupported: true, authPhase: "connected" },
      false,
      "codexCompanionFirst",
    ],
    [
      { companionState: "checking", modelsSupported: true, authPhase: "connected" },
      false,
      "codexCompanionFirst",
    ],
  ];

  for (const [input, pickerEnabled, hintKey] of views) {
    const view = options.describeCodexModelView(input);
    assert.equal(view.pickerEnabled, pickerEnabled, JSON.stringify(input));
    assert.equal(view.hintKey, hintKey, JSON.stringify(input));
    if (hintKey) {
      for (const language of ["en", "zh-CN"]) {
        assert.ok(
          options.translate(language, hintKey),
          `${language} copy for ${hintKey}`,
        );
      }
    }
  }

  // The model-unavailable recovery copy exists in both languages.
  for (const language of ["en", "zh-CN"]) {
    const copy = options.translate(language, "codexModelUnavailable", {
      model: "gpt-5.1-codex",
    });
    assert.ok(copy.includes("gpt-5.1-codex"), `${language} names the model`);
    assert.ok(!copy.includes("undefined"), language);
  }
});

test("settings page wires model selection into the shared save path", () => {
  const html = read("options.html");
  const script = read("options.js");

  assert.match(html, /name="aiProvider"[^>]*value="deepseek"/);
  assert.match(html, /name="aiProvider"[^>]*value="codex"/);
  assert.match(html, /id="codexFields"[^>]*hidden/);
  assert.match(html, /id="deepseekFields"/);
  assert.match(html, /id="codexGetModelsBtn"/);
  assert.match(html, /id="codexModelList"[^>]*role="radiogroup"/);
  assert.match(html, /id="codexModelStatus"[^>]*role="status"/);
  assert.match(html, /id="codexModelHint"[^>]*role="status"/);
  assert.match(html, /data-i18n="codexEntitlementNote"/);
  assert.match(html, /data-i18n="codexModelLabel"/);

  assert.match(script, /requestModelCatalog/);
  assert.match(script, /validateModel/);
  assert.match(script, /describeCodexModelView/);
  // The persisted model is non-secret settings data saved through the same
  // normalize path as every other setting.
  assert.match(script, /codexModel:\s*selectedCodexModel\(\)\s*\|\|\s*persistedCodexModel/);
  // Loading must restore the provider and the model without a live companion.
  assert.match(script, /radio\.checked = radio\.value === settings\.provider/);
  assert.match(script, /persistedCodexModel\s*=\s*settings\.codexModel/);
  assert.match(script, /\[\{ id: persistedCodexModel \}\]/);
  // Each catalog option shows the canonical id so a saved choice stays
  // unambiguous even when a friendly label is present.
  assert.match(script, /\$\{model\.label\} \(\$\{model\.id\}\)/);
});

test("settings page blocks re-saving a model the companion reported unavailable", () => {
  const script = read("options.js");

  // The typed reason from the connection contract gates both the status
  // copy and the save path.
  assert.match(script, /reason === "model-unavailable"/);
  assert.match(script, /codexModelKnownUnavailable = true/);
  assert.match(
    script,
    /codexModelKnownUnavailable &&\s*settings\.codexModel === persistedCodexModel/,
  );
  // Saving a different model clears the block.
  assert.match(script, /codexModelKnownUnavailable = false/);
});
