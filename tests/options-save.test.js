const test = require("node:test");
const assert = require("node:assert/strict");
const options = require("../options.js");
const settings = require("../settings.js");

// Exercise the page's real event handlers with isolated storage and a small
// DOM double. No browser credentials or external services are involved.
function element() {
  return {
    value: "", dataset: {}, children: [], listeners: {}, textContent: "",
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute() {},
    setSelectionRange() {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    set innerHTML(value) { this.children = []; },
    querySelectorAll() {
      return this.children.flatMap((child) =>
        child.name === "codexModel" ? [child] : child.querySelectorAll());
    },
    querySelector() { return this.querySelectorAll().find((input) => input.checked); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function openPage({ stored = {}, language = "zh-CN", failSave = false } = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const radios = ["deepseek", "codex"].map((value) => ({ ...element(), value }));
  const values = {
    [settings.STORAGE_KEY]: structuredClone(stored),
    [options.LANGUAGE_STORAGE_KEY]: language,
  };
  let writes = 0;
  options.initialize({
    YTD_SETTINGS: settings,
    YTD_COMPANION: {
      STATUS: { CHECKING: "checking" },
      checkStatus: async () => ({
        state: "ready", modelsSupported: true, authSupported: true,
        auth: { phase: "connected" },
      }),
      requestModelCatalog: async () => ({
        ok: true, defaultModel: "gpt-5.6-terra",
        models: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }],
      }),
      validateModel: async () => ({ ok: true }),
    },
    document: {
      readyState: "complete", documentElement: {},
      getElementById: get,
      createElement: element,
      querySelectorAll: (selector) =>
        selector === 'input[name="aiProvider"]' ? radios : [],
    },
    chrome: { storage: { local: {
      get: async (key) => ({ [key]: structuredClone(values[key]) }),
      set: async (items) => {
        if (failSave) throw new Error("Storage unavailable");
        writes += 1;
        Object.assign(values, structuredClone(items));
      },
    } } },
  });
  await flush();
  return {
    get, values, writes: () => writes,
    async selectProvider(provider) {
      for (const radio of radios) radio.checked = radio.value === provider;
      radios.find((radio) => radio.checked).listeners.change();
      await flush();
    },
    async getModels() {
      get("codexGetModelsBtn").listeners.click();
      await flush();
    },
    save: () => get("settingsForm").listeners.submit({ preventDefault() {} }),
  };
}

test("Get models then Save persists Codex without a Supadata or DeepSeek key", async () => {
  const page = await openPage();
  await page.selectProvider("codex");
  await page.getModels();
  assert.equal(page.writes(), 0, "Get models must not save settings");
  await page.save();
  assert.equal(page.writes(), 1);
  const saved = page.values[settings.STORAGE_KEY];
  assert.equal(saved.provider, "codex");
  assert.equal(saved.codexModel, "gpt-5.6-terra");
  assert.equal(saved.supadataApiKey, "");
  assert.equal(saved.aiApiKey, "");
  assert.match(page.get("saveStatus").textContent, /^已保存。.*获取视频字幕.*Supadata/);
  const reopened = await openPage({ stored: saved });
  assert.equal(reopened.get("codexModelList").querySelector().value, saved.codexModel);
  await reopened.save();
  assert.equal(reopened.values[settings.STORAGE_KEY].provider, "codex");
});

test("saving a model preserves existing keys and reports full success", async () => {
  const page = await openPage({ stored: {
    provider: "codex", supadataApiKey: "test-transcript-key", aiApiKey: "test-ai-key",
  } });
  await page.getModels();
  await page.save();
  assert.equal(page.values[settings.STORAGE_KEY].supadataApiKey, "test-transcript-key");
  assert.equal(page.values[settings.STORAGE_KEY].aiApiKey, "test-ai-key");
  assert.equal(page.get("saveStatus").textContent, options.translate("zh-CN", "saved"));
});

test("missing Codex selection or DeepSeek key still blocks saving", async () => {
  for (const [provider, message] of [["codex", "selectCodexModel"], ["deepseek", "addDeepseekKey"]]) {
    const page = await openPage();
    await page.selectProvider(provider);
    await page.save();
    assert.equal(page.writes(), 0);
    assert.equal(page.get("saveStatus").textContent, options.translate("zh-CN", message));
  }
});

test("DeepSeek can also save independently of transcript setup with an English reminder", async () => {
  const page = await openPage({ language: "en", stored: { aiApiKey: "test-ai-key" } });
  await page.save();
  assert.equal(page.writes(), 1);
  assert.match(page.get("saveStatus").textContent, /^Saved\..*Supadata.*transcripts/);
});

test("storage failure never reports settings saved", async () => {
  const page = await openPage({ failSave: true, stored: { provider: "codex", codexModel: "gpt-5.6-terra" } });
  await page.save();
  assert.equal(page.writes(), 0);
  assert.equal(page.get("saveStatus").textContent, options.translate("zh-CN", "saveFailed"));
});
