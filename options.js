const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "youtubeDigestPreview:";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const COPY = {
    en: {
      pageTitle: "YouTube Digest Settings",
      languageGroupLabel: "Interface language",
      heading: "Bring your own API keys",
      lede:
        "Keys stay in this Chrome profile and are sent only to Supadata and DeepSeek. This open-source extension has no developer server or analytics.",
      transcriptProvider: "Transcript provider",
      supadataApiKeyLabel: "Supadata API key",
      supadataHelp: "Used to fetch timestamped YouTube subtitles. ",
      supadataLink: "Create a Supadata account and key",
      supadataHelpSuffix:
        ". Supadata generates the key during onboarding.",
      aiProvider: "AI provider",
      providerSummaryLabel: "Supported AI provider",
      providerBadge: "Supported in this version",
      deepseekApiKeyLabel: "DeepSeek API key",
      deepseekHelp:
        "YouTube Digest uses DeepSeek V4 Flash for overviews, explanations, translation, and note polishing. ",
      deepseekLink: "Create a DeepSeek API key",
      deepseekHelpSuffix: ".",
      privacyNote:
        "When you use AI features, DeepSeek receives the video transcript and relevant video context. Review DeepSeek's terms and pricing before saving.",
      saveSettings: "Save settings",
      codexModelLabel: "ChatGPT / Codex model",
      codexGetModels: "Get models",
      codexModelsLoading: "Loading models…",
      codexModelsLoaded: ({ count }) =>
        `${count} model${count === 1 ? "" : "s"} available.`,
      codexModelsFailed:
        "Could not load the model list. Check the companion status, then try Get models again.",
      codexConnectFirst:
        "Finish the ChatGPT / Codex sign-in below, then select Get models.",
      codexCompanionFirst:
        "Set up the ChatGPT / Codex companion below, then sign in and get models.",
      companionModelsUnsupportedDetail:
        "The installed companion does not provide a model list yet. Update it by re-running the installer from the latest YouTube Digest folder, then check again.",
      codexModelUnavailable: ({ model }) =>
        `The saved model ${model} is not offered by the installed companion. Select Get models and choose a different model.`,
      codexEntitlementNote:
        "The list comes from the installed companion, not from your account: a listed model is not guaranteed to be included in your ChatGPT plan. If a request reports the model as unavailable, select Get models, choose another model, or sign in again.",
      selectCodexModel: "Choose a model from the list before saving.",
      companionTitle: "ChatGPT / Codex companion",
      companionIntro:
        "Optional macOS helper that connects YouTube Digest to a ChatGPT / Codex subscription through Chrome Native Messaging. No API key or token is entered in the extension.",
      companionChecking: "Checking…",
      companionReadyBadge: "Ready",
      companionUnavailableBadge: "Unavailable",
      companionIncompatibleBadge: "Incompatible",
      companionReadyDetail: ({ version }) =>
        `The extension can reach the companion through Chrome Native Messaging (companion ${version ?? "unknown version"}).`,
      companionReasonHostNotInstalled:
        "The companion is not installed for this Chrome profile. Follow the installation steps below, then check again.",
      companionReasonHostNotAllowed:
        "The installed companion does not accept this copy of the extension. Re-run the installer from this project folder, reload the extension, then check again.",
      companionReasonHostNotRunning:
        "The companion is installed but could not start. Re-running the installer from this project folder repairs it.",
      companionReasonHostNotResponding:
        "The companion did not answer the status request. Re-run the installer from the latest YouTube Digest folder, then check again.",
      companionReasonBrowserUnsupported:
        "Open these settings from the YouTube Digest extension in Chrome to check the companion.",
      companionReasonHostError:
        "The companion reported an error. Re-run the installer from this project folder, then check again.",
      companionReasonProtocolUnsupported: ({ found }) =>
        `The installed companion speaks protocol ${found ?? "unknown"}, which this version of the extension does not support. Update it by re-running the installer from the latest YouTube Digest folder, then check again.`,
      companionInstallIntro:
        "Install it from your YouTube Digest project folder:",
      companionStepNode: "Make sure Node.js is installed on this Mac.",
      companionStepInstall: "In Terminal, from the project folder, run:",
      companionStepReload:
        "Reload the unpacked extension at chrome://extensions, reopen Settings, and check again.",
      companionCheckAgain: "Check again",
      companionAccountSignedOutBadge: "Not signed in",
      companionAccountAuthorizingBadge: "Authorizing",
      companionAccountConnectedBadge: "Connected",
      companionAccountReconnectBadge: "Reconnect required",
      companionAccountUpdateBadge: "Update needed",
      companionAccountSignedOutDetail:
        "Sign in to use your ChatGPT / Codex subscription with YouTube Digest.",
      companionAccountAuthorizingDetail:
        "Finish signing in in the browser window that opened. This page updates automatically, so you can keep it open.",
      companionAccountConnectedDetail: ({ label }) =>
        `Signed in${label ? ` as ${label}` : ""}. The sign-in credential stays in this Mac's Keychain; the extension never receives tokens. Resetting extension data does not remove it; use Disconnect to delete it.`,
      companionAccountReconnectDetail:
        "The stored sign-in is no longer valid. Reconnect to sign in again, or disconnect to remove the stored credential.",
      companionAuthUnsupportedDetail:
        "The installed companion does not support signing in yet. Update it by re-running the installer from the latest YouTube Digest folder, then check again.",
      companionOutcomeExpired:
        "The previous authorization expired before it finished. Select Sign in with ChatGPT to try again.",
      companionOutcomeDenied:
        "The previous authorization was denied. Select Sign in with ChatGPT to try again.",
      companionOutcomeCancelled: "Authorization was cancelled.",
      companionOutcomeStateMismatch:
        "The previous authorization could not be verified and was discarded. Try again.",
      companionOutcomeError:
        "The previous authorization failed. Try again, and update the companion if it keeps failing.",
      companionConnect: "Sign in with ChatGPT",
      companionReconnect: "Reconnect",
      companionCancelAuth: "Cancel authorization",
      companionDisconnect: "Disconnect",
      companionDisconnectConfirm:
        "Disconnect your ChatGPT / Codex account and delete its credential from this Mac's Keychain?",
      companionAuthPrivacy:
        "Signing in opens chatgpt.com in your browser. YouTube Digest never sees your password, authorization code, or tokens.",
      companionActionFailed:
        "That action did not complete. Check the companion status, then try again.",
      localRemix: "Local remix",
      customizationTitle: "Want to use another AI model?",
      customizationPurpose: "Edit and copy a safe prompt for your coding agent",
      agentBadge: "Coding agent ready",
      customizationIntro:
        "You can edit the prompt directly. Complete these three steps before copying:",
      customizationStepFolder:
        "Open the extracted YouTube Digest project folder in your coding agent.",
      customizationStepReplace:
        "Replace [PROVIDER] and [MODEL] with the service and model you want to use.",
      customizationStepKeys:
        "Never include API keys in the prompt or chat. Enter them yourself after the code is ready.",
      customizationPromptLabel: "Editable customization prompt",
      customizationReminderLabel: "Prompt reminder",
      customizationReminder:
        "Before copying, replace [PROVIDER] and [MODEL] with the provider and model you want to use.",
      customizationPrompt:
        "Customize this local YouTube Digest workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is YouTube Digest. If verification fails, stop and ask me to open the extracted YouTube Digest project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real YouTube video.",
      copyCustomizationPrompt: "Copy edited prompt",
      localData: "Local data",
      localDataHelp:
        "Digests, translations, and notes are stored only in this Chrome profile. You can remove them at any time.",
      clearCache: "Clear cached digests",
      deleteNotes: "Delete all notes",
      resetData: "Reset extension data",
      footer:
        'Read <a href="PRIVACY.md" target="_blank">PRIVACY.md</a> in the repository for the complete data-flow description.',
      migrationWarning:
        "Custom provider settings were removed safely. Your Supadata key was kept, but the AI key was cleared. Enter a DeepSeek API key to continue.",
      saving: "Saving…",
      addSupadataKey: "Add a Supadata API key.",
      addDeepseekKey: "Add a DeepSeek API key.",
      saved: "Saved. Reopen YouTube Digest to use these settings.",
      saveFailed: "Could not save settings. Please try again.",
      copying: "Copying…",
      promptCopied: "Edited prompt copied.",
      copyFailed:
        "Could not copy the prompt. Select the prompt text and copy it manually.",
      clearedDigests: ({ count }) =>
        `Cleared ${count} cached digest${count === 1 ? "" : "s"}.`,
      notesDeleted: "Deleted all saved notes.",
      resetConfirm:
        "Delete API keys, cached digests, translations, and saved notes from this Chrome profile?",
      allDataDeleted: "All YouTube Digest data was deleted.",
      settingsLoadFailed:
        "Could not load saved settings. You can still preview this page.",
    },
    "zh-CN": {
      pageTitle: "YouTube Digest 设置",
      languageGroupLabel: "界面语言",
      heading: "使用你自己的 API 密钥",
      lede:
        "密钥仅保存在当前 Chrome 个人资料中，只会发送给 Supadata 和 DeepSeek。本开源扩展没有开发者服务器，也不使用分析服务。",
      transcriptProvider: "字幕服务",
      supadataApiKeyLabel: "Supadata API 密钥",
      supadataHelp: "用于获取带时间戳的 YouTube 字幕。",
      supadataLink: "创建 Supadata 账号并获取密钥",
      supadataHelpSuffix: "。Supadata 会在引导流程中生成密钥。",
      aiProvider: "AI 服务",
      providerSummaryLabel: "支持的 AI 服务",
      providerBadge: "当前版本支持",
      deepseekApiKeyLabel: "DeepSeek API 密钥",
      deepseekHelp:
        "YouTube Digest 使用 DeepSeek V4 Flash 生成概览、解释内容、翻译字幕和润色笔记。",
      deepseekLink: "创建 DeepSeek API 密钥",
      deepseekHelpSuffix: "。",
      privacyNote:
        "使用 AI 功能时，DeepSeek 会收到视频字幕及相关视频上下文。保存前请查看 DeepSeek 的服务条款和价格。",
      saveSettings: "保存设置",
      codexModelLabel: "ChatGPT / Codex 模型",
      codexGetModels: "获取模型",
      codexModelsLoading: "正在加载模型…",
      codexModelsLoaded: ({ count }) => `已加载 ${count} 个可用模型。`,
      codexModelsFailed: "无法加载模型列表。请先检查本地伴侣状态，然后重新获取模型。",
      codexConnectFirst: "请先在下方完成 ChatGPT / Codex 登录，再获取模型。",
      codexCompanionFirst: "请先在下方安装并就绪本地伴侣，登录后即可获取模型。",
      companionModelsUnsupportedDetail:
        "已安装的伴侣还不提供模型列表。请在最新的 YouTube Digest 文件夹重新运行安装脚本进行更新，然后再检查一次。",
      codexModelUnavailable: ({ model }) =>
        `已保存的模型 ${model} 不在当前本地伴侣提供的列表中。请重新获取模型并另选一个。`,
      codexEntitlementNote:
        "该列表来自本地伴侣而非你的账号：列出的模型不保证包含在你的 ChatGPT 套餐中。如果请求提示模型不可用，请重新获取模型、另选一个，或重新登录。",
      selectCodexModel: "保存前请先从列表中选择一个模型。",
      companionTitle: "ChatGPT / Codex 本地伴侣",
      companionIntro:
        "可选的 macOS 本地助手，通过 Chrome Native Messaging 把 YouTube Digest 连接到 ChatGPT / Codex 订阅。不需要在扩展中填写任何 API 密钥或令牌。",
      companionChecking: "正在检查…",
      companionReadyBadge: "已就绪",
      companionUnavailableBadge: "不可用",
      companionIncompatibleBadge: "不兼容",
      companionReadyDetail: ({ version }) =>
        `扩展已能通过 Chrome Native Messaging 与本地伴侣通信（伴侣版本 ${version ?? "未知"}）。`,
      companionReasonHostNotInstalled:
        "当前 Chrome 个人资料尚未安装本地伴侣。按下面的步骤安装，然后再检查一次。",
      companionReasonHostNotAllowed:
        "已安装的伴侣不接受这份扩展。请在当前项目文件夹重新运行安装脚本，重新加载扩展后再检查一次。",
      companionReasonHostNotRunning:
        "伴侣已安装但无法启动。在当前项目文件夹重新运行安装脚本即可修复。",
      companionReasonHostNotResponding:
        "本地伴侣没有响应状态请求。请在最新的 YouTube Digest 文件夹重新运行安装脚本，然后再检查一次。",
      companionReasonBrowserUnsupported:
        "请在 Chrome 中通过 YouTube Digest 扩展打开本设置页，才能检查本地伴侣。",
      companionReasonHostError:
        "本地伴侣返回了错误。请在当前项目文件夹重新运行安装脚本，然后再检查一次。",
      companionReasonProtocolUnsupported: ({ found }) =>
        `已安装的伴侣使用协议版本 ${found ?? "未知"}，当前扩展不支持。请在最新的 YouTube Digest 文件夹重新运行安装脚本进行更新，然后再检查一次。`,
      companionInstallIntro: "在 YouTube Digest 项目文件夹中安装：",
      companionStepNode: "确认这台 Mac 已安装 Node.js。",
      companionStepInstall: "在终端中进入项目文件夹并运行：",
      companionStepReload:
        "在 chrome://extensions 重新加载已解压的扩展，重新打开设置页，再检查一次。",
      companionCheckAgain: "再检查一次",
      companionAccountSignedOutBadge: "未登录",
      companionAccountAuthorizingBadge: "正在授权",
      companionAccountConnectedBadge: "已连接",
      companionAccountReconnectBadge: "需要重新连接",
      companionAccountUpdateBadge: "需要更新",
      companionAccountSignedOutDetail:
        "登录后即可在 YouTube Digest 中使用你的 ChatGPT / Codex 订阅。",
      companionAccountAuthorizingDetail:
        "请在已打开的浏览器窗口中完成登录。本页面会自动更新，可以保持打开。",
      companionAccountConnectedDetail: ({ label }) =>
        `已登录${label ? `（账号 ${label}）` : ""}。登录凭据只保存在这台 Mac 的钥匙串中，扩展不会收到任何令牌。重置扩展数据不会删除它；如需删除请使用断开连接。`,
      companionAccountReconnectDetail:
        "已保存的登录已失效。请重新连接再次登录，或断开连接以删除已保存的凭据。",
      companionAuthUnsupportedDetail:
        "已安装的伴侣还不支持登录。请在最新的 YouTube Digest 文件夹重新运行安装脚本进行更新，然后再检查一次。",
      companionOutcomeExpired:
        "上次授权在完成前已过期。请再次点击「使用 ChatGPT 登录」重试。",
      companionOutcomeDenied: "上次授权被拒绝。请再次点击「使用 ChatGPT 登录」重试。",
      companionOutcomeCancelled: "授权已取消。",
      companionOutcomeStateMismatch: "上次授权未能通过校验，已被放弃。请重试。",
      companionOutcomeError:
        "上次授权失败。请重试；如果继续失败，请更新本地伴侣。",
      companionConnect: "使用 ChatGPT 登录",
      companionReconnect: "重新连接",
      companionCancelAuth: "取消授权",
      companionDisconnect: "断开连接",
      companionDisconnectConfirm:
        "要断开 ChatGPT / Codex 账号，并从这台 Mac 的钥匙串中删除其凭据吗？",
      companionAuthPrivacy:
        "登录会在浏览器中打开 chatgpt.com。YouTube Digest 不会接触你的密码、授权码或令牌。",
      companionActionFailed: "操作未完成。请检查本地伴侣状态后重试。",
      localRemix: "本地改造",
      customizationTitle: "想使用其他 AI 模型？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。",
      customizationStepReplace:
        "把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder:
        "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationPrompt:
        "请把当前本地 YouTube Digest 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 YouTube Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，并在真实 YouTube 视频上测试。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      localData: "本地数据",
      localDataHelp:
        "摘要、翻译和笔记仅保存在当前 Chrome 个人资料中。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      footer:
        '完整数据流说明请参阅仓库中的 <a href="PRIVACY.md" target="_blank">PRIVACY.md</a>。',
      migrationWarning:
        "已安全移除自定义服务设置。Supadata 密钥已保留，AI 密钥已清除。请输入 DeepSeek API 密钥以继续使用。",
      saving: "正在保存…",
      addSupadataKey: "请添加 Supadata API 密钥。",
      addDeepseekKey: "请添加 DeepSeek API 密钥。",
      saved: "已保存。请重新打开 YouTube Digest 以使用这些设置。",
      saveFailed: "无法保存设置，请重试。",
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      clearedDigests: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeleted: "已删除全部已保存的笔记。",
      resetConfirm:
        "要从当前 Chrome 个人资料中删除 API 密钥、缓存摘要、翻译和已保存的笔记吗？",
      allDataDeleted: "已删除全部 YouTube Digest 数据。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "en";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? COPY.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      en: translate("en", "customizationPrompt"),
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  const COMPANION_BADGE_KEYS = {
    checking: "companionChecking",
    ready: "companionReadyBadge",
    unavailable: "companionUnavailableBadge",
    incompatible: "companionIncompatibleBadge",
  };

  const COMPANION_REASON_KEYS = {
    "browser-unsupported": "companionReasonBrowserUnsupported",
    "host-not-installed": "companionReasonHostNotInstalled",
    "host-not-allowed": "companionReasonHostNotAllowed",
    "host-not-running": "companionReasonHostNotRunning",
    "host-not-responding": "companionReasonHostNotResponding",
    "host-error": "companionReasonHostError",
  };

  // Maps a connection-contract result (see companion.js) to the copy shown
  // in Settings. Install steps are hidden when they cannot help: the ready,
  // checking, and browser-context cases.
  function describeCompanionStatus(result) {
    const state = result?.state ?? "checking";
    const badgeKey =
      COMPANION_BADGE_KEYS[state] ?? COMPANION_BADGE_KEYS.unavailable;
    if (state === "ready") {
      return {
        state,
        badgeKey,
        detailKey: "companionReadyDetail",
        detailParams: { version: result.hostVersion ?? null },
        showInstallSteps: false,
      };
    }
    if (state === "incompatible") {
      return {
        state,
        badgeKey,
        detailKey: "companionReasonProtocolUnsupported",
        detailParams: { found: result.found ?? null },
        showInstallSteps: true,
      };
    }
    if (state === "checking") {
      return {
        state,
        badgeKey,
        detailKey: null,
        detailParams: {},
        showInstallSteps: false,
      };
    }
    return {
      state: "unavailable",
      badgeKey,
      detailKey:
        COMPANION_REASON_KEYS[result?.reason] ?? "companionReasonHostError",
      detailParams: {},
      showInstallSteps: result?.reason !== "browser-unsupported",
    };
  }

  // Maps an account authorization phase from the connection contract (see
  // companion.js) to the Settings account view. The view is render-only
  // data: badge/detail copy keys, button visibility, and the connect-button
  // label, so no account state is ever persisted by the page.
  const ACCOUNT_OUTCOME_KEYS = {
    expired: "companionOutcomeExpired",
    denied: "companionOutcomeDenied",
    cancelled: "companionOutcomeCancelled",
    "state-mismatch": "companionOutcomeStateMismatch",
    error: "companionOutcomeError",
  };

  function describeAccountView({
    companionState,
    authSupported = false,
    phase = "signed-out",
    lastOutcome = null,
    accountLabel = null,
  } = {}) {
    if (companionState !== "ready") {
      return { visible: false, phase: "hidden" };
    }
    if (!authSupported) {
      return {
        visible: true,
        phase: "unsupported",
        badgeKey: "companionAccountUpdateBadge",
        detailKey: "companionAuthUnsupportedDetail",
        detailParams: {},
        connectLabelKey: null,
        showCancel: false,
        showDisconnect: false,
      };
    }
    if (phase === "authorizing") {
      return {
        visible: true,
        phase,
        badgeKey: "companionAccountAuthorizingBadge",
        detailKey: "companionAccountAuthorizingDetail",
        detailParams: {},
        connectLabelKey: null,
        showCancel: true,
        showDisconnect: false,
      };
    }
    if (phase === "connected") {
      return {
        visible: true,
        phase,
        badgeKey: "companionAccountConnectedBadge",
        detailKey: "companionAccountConnectedDetail",
        detailParams: { label: accountLabel ?? null },
        connectLabelKey: null,
        showCancel: false,
        showDisconnect: true,
      };
    }
    if (phase === "reconnect-required") {
      return {
        visible: true,
        phase,
        badgeKey: "companionAccountReconnectBadge",
        detailKey: "companionAccountReconnectDetail",
        detailParams: {},
        connectLabelKey: "companionReconnect",
        showCancel: false,
        showDisconnect: true,
      };
    }
    return {
      visible: true,
      phase: "signed-out",
      badgeKey: "companionAccountSignedOutBadge",
      detailKey:
        ACCOUNT_OUTCOME_KEYS[lastOutcome] ?? "companionAccountSignedOutDetail",
      detailParams: {},
      connectLabelKey: "companionConnect",
      showCancel: false,
      showDisconnect: false,
    };
  }

  // Maps the companion connection state to the Codex model picker view in
  // the AI provider card. Render-only data like describeAccountView: the
  // picker unlocks only when the installed companion both supports the
  // catalog and has a connected account; every not-ready case gets one
  // actionable hint instead of a dead control.
  function describeCodexModelView({
    companionState,
    modelsSupported = false,
    authPhase,
  } = {}) {
    if (companionState === "ready") {
      if (!modelsSupported) {
        return {
          pickerEnabled: false,
          hintKey: "companionModelsUnsupportedDetail",
        };
      }
      if (authPhase === "connected") {
        return { pickerEnabled: true, hintKey: null };
      }
      return { pickerEnabled: false, hintKey: "codexConnectFirst" };
    }
    return { pickerEnabled: false, hintKey: "codexCompanionFirst" };
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const companionApi = root.YTD_COMPANION;
    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    const supadataApiKeyInput = doc.getElementById("supadataApiKey");
    const providerRadios = [
      ...doc.querySelectorAll('input[name="aiProvider"]'),
    ];
    const deepseekFields = doc.getElementById("deepseekFields");
    const codexFields = doc.getElementById("codexFields");
    const codexModelList = doc.getElementById("codexModelList");
    const codexGetModelsBtn = doc.getElementById("codexGetModelsBtn");
    const codexModelStatus = doc.getElementById("codexModelStatus");
    const codexModelHint = doc.getElementById("codexModelHint");
    const companionCard = doc.getElementById("companionCard");
    const companionBadge = doc.getElementById("companionBadge");
    const companionDetail = doc.getElementById("companionDetail");
    const companionInstall = doc.getElementById("companionInstall");
    const companionCheckBtn = doc.getElementById("companionCheckBtn");
    const companionAccount = doc.getElementById("companionAccount");
    const accountBadge = doc.getElementById("accountBadge");
    const accountDetail = doc.getElementById("accountDetail");
    const companionConnectBtn = doc.getElementById("companionConnectBtn");
    const companionCancelAuthBtn = doc.getElementById("companionCancelAuthBtn");
    const companionDisconnectBtn = doc.getElementById("companionDisconnectBtn");
    const accountActionStatus = doc.getElementById("accountActionStatus");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = "en";
    let lastAccountView = { visible: false, phase: "hidden" };
    let authPollTimer = null;
    let companionActionInFlight = false;
    // Provider and saved model are non-secret settings; the picker state is
    // derived from the live companion status on every render.
    let persistedCodexModel = "";
    let codexModelKnownUnavailable = false;
    let lastCompanionStatus = null;
    let codexModelsInFlight = false;
    let savedCodexModelChecked = false;

    function renderStatus(element) {
      const state = statusStates.get(element);
      element.textContent =
        state && state.key ? translate(currentLanguage, state.key, state.params) : "";
    }

    function setStatus(element, key, params = {}) {
      if (key === null) statusStates.delete(element);
      else statusStates.set(element, { key, params });
      renderStatus(element);
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }

      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
      renderAccountView(lastAccountView);
    }

    function selectedProvider() {
      const checked = providerRadios.find((radio) => radio.checked);
      return checked?.value === "codex" ? "codex" : "deepseek";
    }

    function applyProviderSections(provider) {
      if (deepseekFields) deepseekFields.hidden = provider !== "deepseek";
      if (codexFields) codexFields.hidden = provider !== "codex";
      renderCodexModelView(codexModelViewFromStatus());
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        aiApiKeyInput.value = settings.aiApiKey;
        supadataApiKeyInput.value = settings.supadataApiKey;
        for (const radio of providerRadios) {
          radio.checked = radio.value === settings.provider;
        }
        persistedCodexModel = settings.codexModel;
        applyProviderSections(settings.provider);
        // Restoring the saved choice must not depend on a live companion:
        // seed the picker with the saved id alone; Get models replaces it
        // with the full labeled catalog when the user asks.
        if (persistedCodexModel) {
          renderCodexModelOptions(
            [{ id: persistedCodexModel }],
            persistedCodexModel,
          );
        }
        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (_error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage("en");
      }
      await loadSettings();
      void refreshCompanionStatus();
    }

    async function saveSettings(event) {
      event.preventDefault();
      setStatus(saveStatus, "saving");

      const settings = settingsApi.normalize({
        provider: selectedProvider(),
        aiApiKey: aiApiKeyInput.value,
        supadataApiKey: supadataApiKeyInput.value,
        codexModel: selectedCodexModel() || persistedCodexModel,
      });

      if (!settings.supadataApiKey) {
        setStatus(saveStatus, "addSupadataKey");
        return;
      }
      // Each provider guards its own credential or choice; saving one
      // never requires the other's fields to be present.
      if (settings.provider === "deepseek" && !settings.aiApiKey) {
        setStatus(saveStatus, "addDeepseekKey");
        return;
      }
      if (settings.provider === "codex" && !settings.codexModel) {
        setStatus(saveStatus, "selectCodexModel");
        return;
      }
      // A model the companion already reported unavailable cannot be
      // quietly re-saved; the recovery path is picking a different one.
      if (
        settings.provider === "codex" &&
        codexModelKnownUnavailable &&
        settings.codexModel === persistedCodexModel
      ) {
        setStatus(saveStatus, "codexModelUnavailable", {
          model: persistedCodexModel,
        });
        return;
      }

      try {
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
        persistedCodexModel = settings.codexModel;
        codexModelKnownUnavailable = false;
        setStatus(saveStatus, "saved");
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    async function clearCachedDigests() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
      if (keys.length) await storage.remove(keys);
      setStatus(dataStatus, "clearedDigests", { count: keys.length });
    }

    async function clearNotes() {
      await storage.remove("ytd_notes");
      setStatus(dataStatus, "notesDeleted");
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      await storage.clear();
      await persistPreferredLanguage(storage, currentLanguage);
      await loadSettings();
      setStatus(dataStatus, "allDataDeleted");
    }

    function renderCompanionStatus(result) {
      if (
        !companionCard ||
        !companionBadge ||
        !companionDetail ||
        !companionInstall
      ) {
        return;
      }
      const view = describeCompanionStatus(result);
      companionCard.dataset.companionState = view.state;
      setStatus(companionBadge, view.badgeKey);
      setStatus(companionDetail, view.detailKey, view.detailParams);
      companionInstall.hidden = !view.showInstallSteps;
    }

    // The account view is derived, never stored: every render comes from a
    // fresh contract result, and the page keeps only the view object in
    // memory so language switches can re-render it.
    function renderAccountView(view) {
      lastAccountView = view;
      if (!companionAccount || !accountBadge || !accountDetail) return;
      companionAccount.hidden = !view.visible;
      if (!view.visible) return;
      companionAccount.dataset.accountPhase = view.phase;
      setStatus(accountBadge, view.badgeKey);
      setStatus(accountDetail, view.detailKey, view.detailParams);
      if (companionConnectBtn) {
        companionConnectBtn.hidden = view.connectLabelKey === null;
        if (view.connectLabelKey) {
          companionConnectBtn.textContent = translate(
            currentLanguage,
            view.connectLabelKey,
          );
        }
      }
      if (companionCancelAuthBtn) {
        companionCancelAuthBtn.hidden = !view.showCancel;
      }
      if (companionDisconnectBtn) {
        companionDisconnectBtn.hidden = !view.showDisconnect;
      }
    }

    function setAccountButtonsDisabled(disabled) {
      for (const button of [
        companionConnectBtn,
        companionCancelAuthBtn,
        companionDisconnectBtn,
      ]) {
        if (button) button.disabled = disabled;
      }
    }

    // ------------------------------------------------------ codex models

    function codexModelViewFromStatus() {
      return describeCodexModelView({
        companionState: lastCompanionStatus?.state,
        modelsSupported: lastCompanionStatus?.modelsSupported === true,
        authPhase: lastCompanionStatus?.auth?.phase,
      });
    }

    function renderCodexModelView(view) {
      if (codexGetModelsBtn) {
        codexGetModelsBtn.disabled = !view.pickerEnabled || codexModelsInFlight;
      }
      for (const input of codexModelList?.querySelectorAll(
        'input[name="codexModel"]',
      ) ?? []) {
        input.disabled = !view.pickerEnabled;
      }
      setStatus(codexModelHint, view.hintKey);
    }

    // Rebuilds the picker from a catalog while keeping the saved selection
    // when the companion still offers it; otherwise the catalog's default
    // becomes the visible suggestion. The saved value in storage is never
    // overwritten by rendering alone.
    function renderCodexModelOptions(models, defaultModelId) {
      if (!codexModelList || models.length === 0) return;
      const enabled = codexModelViewFromStatus().pickerEnabled;
      const previous =
        selectedCodexModel() ||
        (models.some((model) => model.id === persistedCodexModel)
          ? persistedCodexModel
          : "");
      const selected =
        previous && models.some((model) => model.id === previous)
          ? previous
          : defaultModelId && models.some((model) => model.id === defaultModelId)
            ? defaultModelId
            : models[0].id;

      codexModelList.innerHTML = "";
      for (const model of models) {
        const label = doc.createElement("label");
        label.className = "codex-model-option";
        const input = doc.createElement("input");
        input.type = "radio";
        input.name = "codexModel";
        input.value = model.id;
        input.checked = model.id === selected;
        input.disabled = !enabled;
        const text = doc.createElement("span");
        // The canonical id is always visible; the label is a friendly
        // prefix only, so a saved choice stays unambiguous.
        text.textContent =
          model.label && model.label !== model.id
            ? `${model.label} (${model.id})`
            : model.id;
        label.append(input, text);
        codexModelList.appendChild(label);
      }
    }

    function selectedCodexModel() {
      const checked = codexModelList?.querySelector(
        'input[name="codexModel"]:checked',
      );
      return checked?.value || "";
    }

    async function loadCodexModels() {
      if (!companionApi || codexModelsInFlight) return;
      codexModelsInFlight = true;
      renderCodexModelView({ pickerEnabled: false, hintKey: null });
      setStatus(codexModelStatus, "codexModelsLoading");
      try {
        const result = await companionApi.requestModelCatalog({
          runtime: root.chrome?.runtime,
        });
        if (result.ok) {
          renderCodexModelOptions(result.models, result.defaultModel);
          setStatus(codexModelStatus, "codexModelsLoaded", {
            count: result.models.length,
          });
        } else {
          setStatus(codexModelStatus, "codexModelsFailed");
        }
      } catch (_error) {
        setStatus(codexModelStatus, "codexModelsFailed");
      } finally {
        codexModelsInFlight = false;
        renderCodexModelView(codexModelViewFromStatus());
      }
    }

    // One validate call per saved model: Settings reports the typed
    // model-unavailable recovery path when the installed companion no
    // longer offers what storage holds.
    async function checkSavedCodexModel() {
      if (savedCodexModelChecked || !companionApi) return;
      if (selectedProvider() !== "codex" || !persistedCodexModel) return;
      if (
        lastCompanionStatus?.state !== "ready" ||
        lastCompanionStatus?.modelsSupported !== true ||
        lastCompanionStatus?.auth?.phase !== "connected"
      ) {
        return;
      }
      savedCodexModelChecked = true;
      try {
        const result = await companionApi.validateModel({
          runtime: root.chrome?.runtime,
          model: persistedCodexModel,
        });
        if (result.ok === false && result.reason === "model-unavailable") {
          codexModelKnownUnavailable = true;
          setStatus(codexModelStatus, "codexModelUnavailable", {
            model: persistedCodexModel,
          });
        }
      } catch (_error) {
        // Validation is advisory; the picker stays usable.
      }
    }

    function syncAuthPolling(phase) {
      const shouldPoll = phase === "authorizing";
      if (shouldPoll && authPollTimer === null) {
        // Each poll is a one-shot status request through Native Messaging;
        // the companion resolves the fresh account phase from its state.
        authPollTimer = setInterval(() => {
          void refreshCompanionStatus({ silent: true });
        }, 2000);
      } else if (!shouldPoll && authPollTimer !== null) {
        clearInterval(authPollTimer);
        authPollTimer = null;
      }
    }

    async function runCompanionAction(runner, { confirmFirst = false } = {}) {
      if (companionActionInFlight || !companionApi || typeof runner !== "function") {
        return;
      }
      companionActionInFlight = true;
      setAccountButtonsDisabled(true);
      try {
        if (
          confirmFirst &&
          !root.confirm(translate(currentLanguage, "companionDisconnectConfirm"))
        ) {
          return;
        }
        const result = await runner({ runtime: root.chrome?.runtime });
        setStatus(
          accountActionStatus,
          result?.ok ? null : "companionActionFailed",
        );
        await refreshCompanionStatus({ silent: true });
      } catch (_error) {
        setStatus(accountActionStatus, "companionActionFailed");
      } finally {
        companionActionInFlight = false;
        setAccountButtonsDisabled(false);
      }
    }

    async function refreshCompanionStatus({ silent = false } = {}) {
      if (!companionApi || !companionCard) return;
      if (!silent) {
        renderCompanionStatus({ state: companionApi.STATUS.CHECKING });
      }
      const result = await companionApi.checkStatus({
        runtime: root.chrome?.runtime,
      });
      lastCompanionStatus = result;
      renderCompanionStatus(result);
      renderAccountView(
        describeAccountView({
          companionState: result.state,
          authSupported: result.authSupported === true,
          phase: result.auth?.phase,
          lastOutcome: result.auth?.lastOutcome ?? null,
          accountLabel: result.auth?.accountLabel ?? null,
        }),
      );
      renderCodexModelView(codexModelViewFromStatus());
      void checkSavedCodexModel();
      syncAuthPolling(result.auth?.phase);
    }

    form.addEventListener("submit", saveSettings);
    for (const radio of providerRadios) {
      radio.addEventListener("change", () => {
        applyProviderSections(selectedProvider());
        void checkSavedCodexModel();
      });
    }
    codexGetModelsBtn?.addEventListener("click", () => {
      void loadCodexModels();
    });
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedDigests);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);
    companionCheckBtn?.addEventListener("click", () => {
      void refreshCompanionStatus();
    });
    companionConnectBtn?.addEventListener("click", () => {
      void runCompanionAction(companionApi?.beginAuthorization);
    });
    companionCancelAuthBtn?.addEventListener("click", () => {
      void runCompanionAction(companionApi?.cancelAuthorization);
    });
    companionDisconnectBtn?.addEventListener("click", () => {
      void runCompanionAction(companionApi?.disconnectAccount, {
        confirmFirst: true,
      });
    });
    root.addEventListener?.("pagehide", () => syncAuthPolling(null));
    for (const button of languageButtons) {
      button.addEventListener("click", async () => {
        const language = button.dataset.language;
        applyLanguage(language);
        await persistPreferredLanguage(storage, language);
      });
    }

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }
  }

  return {
    COPY,
    LANGUAGE_STORAGE_KEY,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    describeAccountView,
    describeCodexModelView,
    describeCompanionStatus,
    normalizeLanguage,
    persistPreferredLanguage,
    readPreferredLanguage,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}
