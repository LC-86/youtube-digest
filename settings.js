/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const PROVIDERS = Object.freeze(["deepseek", "codex"]);
  // Shape check for a saved Codex model id (letters, digits, dots, hyphens,
  // underscores). The companion's own catalog uses lowercase ids; this stays
  // permissive so a future host cannot invalidate stored choices by renaming.
  const CODEX_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    codexModel: "",
    supadataApiKey: "",
  });

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalizeProvider(value) {
    return PROVIDERS.includes(value) ? value : DEFAULTS.provider;
  }

  function normalizeCodexModel(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    return CODEX_MODEL_ID_PATTERN.test(trimmed) ? trimmed : "";
  }

  function normalize(input = {}) {
    return {
      provider: normalizeProvider(input.provider),
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl: DEFAULTS.aiBaseUrl,
      aiModel: DEFAULTS.aiModel,
      codexModel: normalizeCodexModel(input.codexModel),
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl() {
    return `${DEFAULTS.aiBaseUrl}/chat/completions`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    PROVIDERS,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
