const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const DEEPSEEK_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const CODEX_MODEL = "gpt-5.2-codex";

// Chrome's native messaging answers through a callback plus lastError. The
// fake replays scripted replies in order; the last scripted reply repeats so
// "always fails" and "recovers later" sequences are both expressible.
function createNative() {
  const calls = [];
  const replies = [];
  const runtime = {
    lastError: null,
    sendNativeMessage(hostName, message, callback) {
      calls.push({ hostName, message: JSON.parse(JSON.stringify(message)) });
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      queueMicrotask(() => callback(reply));
    },
  };
  return {
    runtime,
    calls,
    replyWith(...values) {
      replies.push(...values);
    },
  };
}

function codexOk(text) {
  return { v: 1, ok: true, type: "completion.create", text };
}

function codexErr(reason) {
  return { v: 1, ok: false, type: "completion.create", error: reason };
}

// Loads the real settings, companion-contract, and background sources into
// one sandbox so provider selection is exercised across the same modules the
// shipped extension runs, with a fake native-messaging transport and a fetch
// that only serves prompt files and the DeepSeek endpoint.
function loadBackground({
  settings,
  native = createNative(),
  deepSeekText = "",
  storage = {},
} = {}) {
  const localStorage = { ytd_settings: settings, ...storage };
  const deepSeekRequests = [];
  let currentDeepSeekText = deepSeekText;
  let messageHandler;
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    fetch: async (url, options) => {
      const target = String(url);
      if (target.startsWith("chrome-extension://")) {
        return {
          ok: true,
          text: async () => read(target.slice("chrome-extension://test/".length)),
        };
      }
      if (target === DEEPSEEK_COMPLETIONS_URL) {
        deepSeekRequests.push(JSON.parse(options.body));
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: currentDeepSeekText } }],
          }),
        };
      }
      throw new Error(`Unexpected fetch in test: ${target}`);
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => ({ [key]: localStorage[key] }),
          set: async (values) => Object.assign(localStorage, values),
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        id: "test",
        onInstalled: listeners,
        onMessage: { addListener(handler) { messageHandler = handler; } },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
        sendNativeMessage: native.runtime.sendNativeMessage,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
  };
  sandbox.globalThis = sandbox;
  for (const file of ["settings.js", "companion.js", "markdown-export.js", "background.js"]) {
    vm.runInNewContext(read(file), sandbox, { filename: file });
  }
  return {
    dispatch: (message, sender) => new Promise(resolve => messageHandler(message, sender, resolve)),
    background: sandbox.__YTD_TRANSLATION_TESTING__,
    deepSeekRequests,
    setSettings(nextSettings) {
      localStorage.ytd_settings = nextSettings;
    },
    setDeepSeekText(text) {
      currentDeepSeekText = text;
    },
  };
}

const codexSettings = () => ({
  provider: "codex",
  codexModel: CODEX_MODEL,
  aiApiKey: "",
  supadataApiKey: "",
});

const deepSeekSettings = () => ({
  provider: "deepseek",
  aiApiKey: "test-key",
  supadataApiKey: "",
});

const DIGEST_SENTINEL = "digest-sentinel-title";
const EXPLAIN_SENTINEL = "explain-sentinel-selection";
const TRANSLATE_SOURCE = "A complete first sentence about shared ideas.";
const NOTE_TRANSCRIPT = [
  { start: 8, duration: 2, text: "Words before the marked line." },
  { start: 10, duration: 2, text: "The marked transcript line." },
  { start: 12, duration: 2, text: "Words after the marked line." },
];
const NOTE_RAW_FALLBACK =
  "Words before the marked line. The marked transcript line. Words after the marked line.";

const digestReply = JSON.stringify({
  chapters: [{ title: "Intro", summary: "Opening", timestampSeconds: 10 }],
  keyQuotes: [{ quote: "A quoted line", timestampSeconds: 10 }],
  keyMoments: [10],
});
const translateReply = JSON.stringify({
  segments: [{ id: "segment-0-0", text: "一个完整的句子。" }],
});
const polishReply = JSON.stringify({ quote: "A polished model sentence." });

// One entry per user-visible AI action. `run` drives the public background
// handler exactly as the side panel's messages do; `sentinel` is text that
// reaches the provider prompt but must never reach a failure message.
const ACTIONS = {
  speakers: {
    sentinel: "Hello, I am Alice.",
    providerText: JSON.stringify({ speakers: [{ startId: "s0", endId: "s0", name: "Alice", evidence: "I am Alice." }] }),
    maxTokens: 8192,
    run: background => background.handleIdentifyExportSpeakers({ segments: [{ id: "s0", text: "Hello, I am Alice." }], title: "Conversation", author: "Channel", context: "" }),
    assertSuccess(result) {
      assert.equal(result.success, true);
      assert.equal(result.speakers[0].name, "Alice");
      assert.equal(result.speakers[0].confirmed, false);
    },
  },
  digest: {
    sentinel: DIGEST_SENTINEL,
    providerText: digestReply,
    maxTokens: 8192,
    run: (background) =>
      background.handleAnalyzeTranscript(
        "[0:10] The sentinel transcript body appears only inside the prompt.",
        DIGEST_SENTINEL,
        "Channel",
        "Description",
        120,
      ),
    assertSuccess(result) {
      assert.equal(result.success, true);
      assert.equal(result.analysis.chapters[0].timestamp, "0:10");
    },
  },
  explain: {
    sentinel: EXPLAIN_SENTINEL,
    providerText: "The selection refers to a shared core idea.",
    maxTokens: 1024,
    run: (background) =>
      background.handleExplainSelection(
        EXPLAIN_SENTINEL,
        "Some transcript context",
        "Title",
      ),
    assertSuccess(result) {
      assert.equal(result.success, true);
      assert.equal(
        result.explanation,
        "The selection refers to a shared core idea.",
      );
    },
  },
  translate: {
    sentinel: TRANSLATE_SOURCE,
    providerText: translateReply,
    maxTokens: 1536,
    run: (background) =>
      background.handleTranslateContent(
        { segments: [{ id: "segment-0-0", text: TRANSLATE_SOURCE }] },
        "transcriptBatch",
        "zh",
        "Title",
      ),
    assertSuccess(result) {
      assert.equal(result.success, true);
      assert.equal(
        result.translatedContent.segments[0].text,
        "一个完整的句子。",
      );
    },
  },
  polish: {
    sentinel: "The marked transcript line.",
    providerText: polishReply,
    maxTokens: 512,
    storage: { digest_video123: { transcript: NOTE_TRANSCRIPT } },
    run: (background) =>
      background.handleSaveNote("video123", 10, "Title", "Channel", ""),
    assertSuccess(result) {
      assert.equal(result.success, true);
      assert.equal(result.note.text, "A polished model sentence.");
    },
    // Polishing degrades quietly: while the provider fails, the note must
    // still save with the raw transcript text.
    assertFallback(result) {
      assert.equal(result.success, true);
      assert.equal(result.note.text, NOTE_RAW_FALLBACK);
    },
  },
};

test("every AI action completes through the selected Codex model", async () => {
  for (const [name, action] of Object.entries(ACTIONS)) {
    const native = createNative();
    native.replyWith(codexOk(action.providerText));
    const harness = loadBackground({
      settings: codexSettings(),
      native,
      storage: action.storage,
    });

    const result = await action.run(harness.background);

    action.assertSuccess(result);
    assert.equal(
      native.calls.length,
      1,
      `${name} must delegate exactly one completion`,
    );
    const outbound = native.calls[0].message;
    assert.equal(outbound.v, 1, name);
    assert.equal(outbound.type, "completion.create", name);
    assert.equal(outbound.model, CODEX_MODEL, name);
    assert.equal(outbound.maxTokens, action.maxTokens, name);
    assert.deepEqual(
      outbound.messages.map((message) => message.role),
      ["system", "user"],
      name,
    );
    assert.match(
      outbound.messages.map((message) => message.content).join("\n"),
      new RegExp(action.sentinel),
      `${name} must forward its prompt through the contract`,
    );
    assert.equal(
      harness.deepSeekRequests.length,
      0,
      `${name} must not touch the DeepSeek endpoint under Codex`,
    );
  }
});

test("speaker inference is available only to the extension save page", async () => {
  const harness = loadBackground({ settings: deepSeekSettings(), deepSeekText: ACTIONS.speakers.providerText });
  const message = { action: "identifyExportSpeakers", segments: [{ id: "s0", text: "Hello, I am Alice." }] };
  for (const sender of [{ id: "test", url: "https://www.youtube.com/watch?v=example" }, { id: "other", url: "chrome-extension://test/export.html" }]) {
    assert.equal((await harness.dispatch(message, sender)).success, false);
  }
  assert.equal(harness.deepSeekRequests.length, 0);
  const good = await harness.dispatch(message, { id: "test", url: "chrome-extension://test/export.html?draft=example" });
  ACTIONS.speakers.assertSuccess(good);
  assert.equal(harness.deepSeekRequests.length, 1);
  const invalid = await harness.background.handleIdentifyExportSpeakers({ segments: [{ id: "bad", text: "Hello" }] });
  assert.equal(invalid.success, false);
  assert.equal(harness.deepSeekRequests.length, 1, "invalid input must not spend a model request");
});

test("every AI action stays on the DeepSeek path when DeepSeek is selected", async () => {
  for (const [name, action] of Object.entries(ACTIONS)) {
    const native = createNative();
    const harness = loadBackground({
      settings: deepSeekSettings(),
      native,
      deepSeekText: action.providerText,
      storage: action.storage,
    });

    const result = await action.run(harness.background);

    action.assertSuccess(result);
    assert.equal(
      native.calls.length,
      0,
      `${name} must not contact the companion under DeepSeek`,
    );
    assert.equal(
      harness.deepSeekRequests.length,
      1,
      `${name} must make exactly one DeepSeek request`,
    );
    const body = harness.deepSeekRequests[0];
    assert.equal(body.model, "deepseek-v4-flash", name);
    assert.deepEqual(body.thinking, { type: "disabled" }, name);
    if (name !== "explain") {
      assert.deepEqual(body.response_format, { type: "json_object" }, name);
    } else {
      assert.equal(Object.hasOwn(body, "response_format"), false, name);
    }
    if (name === "translate") {
      assert.equal(body.temperature, 0.2, name);
    }
  }
});

// Reasons whose recovery copy names the model because the model is the
// problem, and reasons where only the provider is relevant.
const MODEL_SPECIFIC_REASONS = [
  "model-unavailable",
  "entitlement-denied",
  "rate-limited",
  "provider-timeout",
  "empty-response",
  "invalid-request",
];
const PROVIDER_ONLY_REASONS = [
  "signed-out",
  "reconnect-required",
  "completion-malformed",
  "protocol-unsupported",
  "host-not-installed",
];

test("Codex failures surface actionable provider-and-model errors across actions", async () => {
  const surfacedActions = ["digest", "explain", "translate"];
  for (const name of surfacedActions) {
    const action = ACTIONS[name];
    for (const reason of [
      ...MODEL_SPECIFIC_REASONS,
      ...PROVIDER_ONLY_REASONS,
    ]) {
      const native = createNative();
      native.replyWith(codexErr(reason));
      const harness = loadBackground({ settings: codexSettings(), native });

      const result = await action.run(harness.background);

      assert.equal(result.success, false, `${name} ${reason}`);
      const message = String(result.error ?? result.message);
      assert.match(
        message,
        /ChatGPT \/ Codex/,
        `${name} ${reason} must name the provider`,
      );
      if (MODEL_SPECIFIC_REASONS.includes(reason)) {
        assert.match(
          message,
          new RegExp(CODEX_MODEL),
          `${name} ${reason} must name the model`,
        );
      }
      assert.match(
        message,
        /Settings|reconnect|sign in|[Rr]etry|Wait a moment|installer|companion/,
        `${name} ${reason} must state a recovery step`,
      );
      assert.doesNotMatch(
        message,
        /sentinel/i,
        `${name} ${reason} must not echo prompt or transcript content`,
      );
    }
  }
});

test("every action stays usable after a reconnect and follows a saved model change", async () => {
  for (const [name, action] of Object.entries(ACTIONS)) {
    const native = createNative();
    native.replyWith(codexErr("reconnect-required"), codexOk(action.providerText));
    const harness = loadBackground({
      settings: codexSettings(),
      native,
      storage: action.storage,
    });

    const failed = await action.run(harness.background);
    if (action.assertFallback) {
      action.assertFallback(failed);
    } else {
      assert.equal(failed.success, false, `${name} reconnect failure surfaces`);
      assert.match(
        String(failed.error ?? failed.message),
        /reconnect/,
        `${name} reconnect failure is actionable`,
      );
    }

    // The user reconnects: the same action must now succeed.
    const recovered = await action.run(harness.background);
    action.assertSuccess(recovered);

    // A saved model change applies to the very next request.
    harness.setSettings({ ...codexSettings(), codexModel: "gpt-5.3-codex" });
    native.replyWith(codexOk(action.providerText));
    const afterChange = await action.run(harness.background);
    action.assertSuccess(afterChange);
    assert.equal(
      native.calls.at(-1).message.model,
      "gpt-5.3-codex",
      `${name} must use the newly saved model`,
    );
  }
});

test("translation retries one empty Codex reply and reports exhaustion cleanly", async () => {
  const action = ACTIONS.translate;

  const native = createNative();
  native.replyWith(codexErr("empty-response"), codexOk(action.providerText));
  const harness = loadBackground({ settings: codexSettings(), native });
  const recovered = await action.run(harness.background);
  action.assertSuccess(recovered);
  assert.equal(native.calls.length, 2, "exactly one automatic retry");

  const exhausted = createNative();
  exhausted.replyWith(codexErr("empty-response"));
  const failingHarness = loadBackground({
    settings: codexSettings(),
    native: exhausted,
  });
  const result = await action.run(failingHarness.background);
  assert.equal(result.success, false);
  assert.match(result.error, /ChatGPT \/ Codex/);
  assert.match(result.error, /empty response.*Retry/i);
  assert.equal(exhausted.calls.length, 2, "no endless retries");
});

test("note polishing keeps the note usable when Codex fails", async () => {
  const native = createNative();
  native.replyWith(codexErr("reconnect-required"));
  const harness = loadBackground({
    settings: codexSettings(),
    native,
    storage: ACTIONS.polish.storage,
  });

  const result = await ACTIONS.polish.run(harness.background);

  assert.equal(result.success, true);
  assert.equal(result.note.text, NOTE_RAW_FALLBACK);
  assert.equal(result.note.rawText, "The marked transcript line.");
  assert.equal(native.calls.length, 1, "polishing is one attempt");
});

test("the explain modal prefers the actionable message over the raw error code", () => {
  const source = read("sidepanel.js");
  assert.match(
    source,
    /explain-error[\s\S]{0,160}result\.message \|\| result\.error/,
  );
});

test("unparseable or unusable model output names the provider and model", async () => {
  const prose = "Plain prose without any braces cannot be parsed as JSON.";

  const digestNative = createNative();
  digestNative.replyWith(codexOk(prose));
  const digest = await loadBackground({
    settings: codexSettings(),
    native: digestNative,
  });
  const digestResult =
    await ACTIONS.digest.run(digest.background);
  assert.equal(digestResult.success, false);
  assert.equal(digestResult.error, "AI_RESPONSE_UNPARSEABLE");
  assert.match(
    digestResult.message,
    /ChatGPT \/ Codex \(gpt-5\.2-codex\) returned a Digest that could not be read.*Retry/,
  );

  const translateNative = createNative();
  translateNative.replyWith(codexOk(prose));
  const translate = loadBackground({
    settings: codexSettings(),
    native: translateNative,
  });
  const translateResult = await ACTIONS.translate.run(translate.background);
  assert.equal(translateResult.success, false);
  assert.match(
    translateResult.error,
    /ChatGPT \/ Codex \(gpt-5\.2-codex\) returned a translation that could not be read.*Retry/,
  );

  // JSON that parses but carries no usable Chinese rows is the same class of
  // provider failure.
  const englishOnly = createNative();
  englishOnly.replyWith(
    codexOk('{"segments":[{"id":"segment-0-0","text":"Still English words."}]}'),
  );
  const englishHarness = loadBackground({
    settings: codexSettings(),
    native: englishOnly,
  });
  const englishResult =
    await ACTIONS.translate.run(englishHarness.background);
  assert.equal(englishResult.success, false);
  assert.match(
    englishResult.error,
    /ChatGPT \/ Codex \(gpt-5\.2-codex\) returned no valid Chinese segments.*Retry/,
  );

  // The DeepSeek path reports the same failure shape with its own name.
  const deepSeek = loadBackground({
    settings: deepSeekSettings(),
    deepSeekText: prose,
  });
  const deepSeekResult = await ACTIONS.digest.run(deepSeek.background);
  assert.equal(deepSeekResult.success, false);
  assert.match(
    deepSeekResult.message,
    /DeepSeek \(deepseek-v4-flash\) returned a Digest that could not be read.*Retry/,
  );
});
