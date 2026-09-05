/* Shared document/template rules. No browser access and no model execution. */
var YTD_MARKDOWN = (() => {
  const TYPES = ["text", "multitext", "number", "checkbox", "date", "datetime"];
  const VARIABLES = ["title", "url", "author", "site", "published", "date", "time", "content", "description", "language", "domain"];
  const DEFAULT_TEMPLATE = {
    name: "YouTube 逐字稿", schemaVersion: "0.1.0", behavior: "create",
    noteNameFormat: "{{title}}", path: "", triggers: [],
    properties: [
      { name: "type", type: "text", value: "inbox" },
      { name: "status", type: "text", value: "待处理" },
      { name: "title", type: "text", value: "{{title}}" },
      { name: "source", type: "text", value: "{{url}}" },
      { name: "author", type: "multitext", value: "{{author}}" },
      { name: "site", type: "text", value: "{{site}}" },
      { name: "published", type: "date", value: "{{published}}" },
      { name: "clipped", type: "date", value: "{{date}}" },
      { name: "tags", type: "multitext", value: "webclip" },
    ],
    noteContentFormat: "# {{title}}\n\n> [!info] 来源\n> 站点：{{site}} · 作者：{{author}} · 发布：{{published}}\n> 链接：[{{title}}]({{url}})\n\n## 📄 原始字幕逐字稿\n\n{{content}}",
  };

  function localDate(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  // Rendering is one pass: braces inside subtitle text are never evaluated.
  function expression(expr, values) {
    const match = expr.trim().match(/^(\w+)(?:\s*\|\s*date:\s*["'](YYYY-MM-DD)["'])?$/);
    if (!match || !VARIABLES.includes(match[1])) throw new Error(`不支持的模板变量或过滤器：{{${expr}}}`);
    const value = String(values[match[1]] ?? "");
    return match[2] ? value.slice(0, 10) : value;
  }

  function interpolate(source, values) {
    const text = String(source ?? "");
    if (text.includes("{%")) throw new Error("暂不支持模板条件、循环或赋值规则。");
    const remaining = text.replace(/{{([\s\S]*?)}}/g, (_, expr) => {
      expression(expr, values);
      return "";
    });
    if (remaining.includes("{{") || remaining.includes("}}")) throw new Error("模板变量括号不完整。");
    return text.replace(/{{([\s\S]*?)}}/g, (_, expr) => expression(expr, values));
  }

  function templateErrors(template) {
    const errors = [];
    if (!template || typeof template !== "object" || Array.isArray(template)) return ["模板必须是一个 JSON 对象。"];
    if (typeof template.name !== "string" || !template.name.trim()) errors.push("请填写模板名称。");
    if (!Array.isArray(template.properties) || template.properties.length > 50) return [...errors, "模板最多支持 50 个属性。"];
    const names = new Set();
    for (const property of template.properties) {
      if (!property || typeof property.name !== "string" || !property.name.trim() || property.name.length > 80) { errors.push("属性名称不能为空，且不得超过 80 个字符。"); continue; }
      if (names.has(property.name)) errors.push(`属性重名：${property.name}`);
      names.add(property.name);
      if (!TYPES.includes(property.type)) errors.push(`属性 ${property.name} 的类型不受支持：${property.type}`);
      if (typeof property.value !== "string") errors.push(`属性 ${property.name} 的默认值必须是文字。`);
      try { interpolate(property.value, {}); } catch (error) { errors.push(`${property.name}：${error.message}`); }
    }
    if (!template.properties.some(p => p?.name === "title" && p.type === "text")) errors.push("需要一个名为 title 的文本属性，它也是文件标题。");
    if (typeof template.noteContentFormat !== "string" || template.noteContentFormat.length > 100000) errors.push("正文模板不能为空或超过 100,000 个字符。");
    else {
      if (!/{{\s*content\s*}}/.test(template.noteContentFormat)) errors.push("正文模板必须包含 {{content}}，用于原始字幕逐字稿。");
      try { interpolate(template.noteContentFormat, {}); } catch (error) { errors.push(error.message); }
    }
    return [...new Set(errors)];
  }

  function importTemplate(text) {
    if (text.length > 1024 * 1024) throw new Error("模板文件不能超过 1 MiB。");
    const source = JSON.parse(text);
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("请选择单个 Web Clipper 模板 JSON 文件。");
    const warnings = [];
    if (source.schemaVersion && source.schemaVersion !== "0.1.0") warnings.push(`模板版本 ${source.schemaVersion} 未经兼容验证。`);
    if (source.behavior && source.behavior !== "create") warnings.push("原模板的追加／日记行为不支持；此处仅创建文档，同名时询问覆盖。");
    if (source.noteNameFormat && source.noteNameFormat !== "{{title}}") warnings.push("原文件名规则不适用；保存文件名始终跟随 title 属性。");
    if (source.path || source.vault) warnings.push("原 Obsidian 路径不会自动授权本地目录；请在保存窗口选择目录。");
    if (source.triggers?.length) warnings.push("自动匹配规则不执行；请手动选择模板。");
    if (source.context) warnings.push("Interpreter 上下文不执行；模型只用于你主动发起的说话人识别。");
    const known = new Set(["id", "name", "schemaVersion", "behavior", "noteNameFormat", "path", "vault", "triggers", "context", "properties", "noteContentFormat"]);
    const extra = Object.keys(source).filter(key => !known.has(key));
    if (extra.length) warnings.push(`以下额外字段不使用：${extra.join("、")}`);
    if (Array.isArray(source.properties)) {
      source.properties.forEach((property, index) => {
        if (!property || typeof property !== "object") return;
        const unused = Object.keys(property).filter(key => !["id", "name", "type", "value"].includes(key));
        if (unused.length) warnings.push(`第 ${index + 1} 个属性的额外规则不使用：${unused.join("、")}`);
      });
    }
    const template = { ...structuredClone(DEFAULT_TEMPLATE), name: source.name ?? "导入的模板", properties: source.properties ?? [], noteContentFormat: source.noteContentFormat ?? "" };
    const errors = templateErrors(template);
    return { template, warnings, errors };
  }

  function filename(title) {
    const clean = String(title ?? "").trim().replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/, "");
    if (!clean || clean === "." || clean === "..") throw new Error("请填写有效的标题。");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) throw new Error("此标题是系统保留文件名，请修改标题。");
    const result = `${clean}.md`;
    if (new TextEncoder().encode(result).length > 240) throw new Error("标题作为文件名过长，请缩短标题。");
    return result;
  }

  function snapshot(input) {
    const entries = Array.isArray(input.transcript) ? input.transcript : [];
    const segments = entries.map((entry, index) => ({ id: `s${index}`, text: String(entry.rawText ?? entry.text ?? "").trim() })).filter(entry => entry.text);
    if (!segments.length && input.transcriptText) segments.push({ id: "s0", text: String(input.transcriptText).trim() });
    if (!segments.length) throw new Error("请先获取字幕，再保存文档。");
    return {
      title: String(input.title || ""), url: String(input.url || ""),
      author: Array.isArray(input.authors) && input.authors.length
        ? [...new Set(input.authors.map(name => String(name).trim()).filter(Boolean))].join("\n") : String(input.author || ""),
      description: String(input.description || ""), published: String(input.published || ""),
      language: String(input.language || "未知"), site: "YouTube", domain: "youtube.com",
      date: localDate(), time: new Date().toISOString(), segments,
      legacySource: entries.some(entry => typeof entry.rawText !== "string"),
    };
  }

  function transcriptText(segments, confirmed = []) {
    const labels = new Map();
    for (const item of confirmed) {
      if (!item.confirmed || !item.name?.trim()) continue;
      const start = segments.findIndex(s => s.id === item.startId);
      const end = segments.findIndex(s => s.id === item.endId);
      if (start < 0 || end < start) throw new Error("说话人标注与当前字幕不匹配。");
      for (let index = start; index <= end; index++) {
        if (labels.has(index)) throw new Error("说话人标注范围重叠，请重新确认。");
        labels.set(index, item.name.trim());
      }
    }
    const paragraphs = [];
    let previous = "", buffer = "";
    for (let i = 0; i < segments.length; i++) {
      const text = segments[i].text;
      const label = labels.get(i) || "";
      const boundary = /(^|\n)\s*>>/.test(text) || /^[^\n:：]{1,35}[:：]\s/.test(text);
      if (buffer && (label !== previous || boundary || buffer.length >= 500)) { paragraphs.push(buffer); buffer = ""; }
      if (!buffer && label) buffer = `**${label.replace(/[\\`*_[\]<>]/g, "\\$&")}**\n\n`;
      // Retain source markers as literal text, not Markdown block quotes.
      const literal = text.replace(/(^|\n)(\s*)(>+)/g, (_, nl, spaces, arrows) => nl + spaces + arrows.replace(/>/g, "\\>"));
      buffer += (buffer && !buffer.endsWith("\n\n") ? " " : "") + literal;
      previous = label;
    }
    if (buffer) paragraphs.push(buffer);
    return paragraphs.join("\n\n");
  }

  function propertyValue(property, value) {
    const text = String(value ?? "").trim();
    if (property.type === "multitext") {
      if (!text) return [];
      if (text.startsWith("[")) {
        const list = JSON.parse(text);
        if (!Array.isArray(list) || list.some(item => typeof item !== "string")) throw new Error(`${property.name} 需要文字列表。`);
        return list;
      }
      return text.split(/\n/).map(item => item.trim()).filter(Boolean);
    }
    if (property.type === "number") {
      if (!text) return null;
      if (!Number.isFinite(Number(text))) throw new Error(`${property.name} 需要有效数字。`);
      return Number(text);
    }
    if (property.type === "checkbox") {
      if (!["", "true", "false"].includes(text)) throw new Error(`${property.name} 需要 true 或 false。`);
      return text === "true";
    }
    if ((property.type === "date" || property.type === "datetime") && text) {
      const pattern = property.type === "date" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
      if (!pattern.test(text) || Number.isNaN(Date.parse(text))) throw new Error(`${property.name} 需要有效日期。`);
    }
    return text;
  }

  function initialProperties(template, source) {
    return Object.fromEntries(template.properties.map(property => [property.name, interpolate(property.value, source)]));
  }

  function render(template, source, overrides, confirmed = []) {
    const errors = templateErrors(template);
    if (errors.length) throw new Error(errors.join("\n"));
    const properties = template.properties.map(property => [property.name, propertyValue(property, overrides[property.name])]);
    const props = Object.fromEntries(properties);
    const file = filename(props.title);
    const values = { ...source, title: props.title, url: props.source ?? source.url, author: Array.isArray(props.author) ? props.author.join("、") : props.author ?? source.author, site: props.site ?? source.site, published: props.published ?? source.published, date: props.clipped ?? source.date, content: transcriptText(source.segments, confirmed) };
    // JSON scalars and flow arrays are valid YAML. Quote keys and strings so
    // user/source text cannot escape the frontmatter or become YAML tags.
    const yaml = properties.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join("\n");
    return { filename: file, markdown: `---\n${yaml}\n---\n${interpolate(template.noteContentFormat, values)}\n` };
  }

  function speakerBatches(segments, limit = 10000) {
    const batches = [];
    let batch = [], size = 0;
    for (const segment of segments) {
      if (segment.text.length > limit) throw new Error("单个字幕段落过长，无法可靠识别说话人；请手动标注。");
      if (batch.length && (size + segment.text.length > limit || batch.length >= 60)) { batches.push(batch); batch = []; size = 0; }
      batch.push(segment); size += segment.text.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function validateSpeakers(result, segments) {
    if (!Array.isArray(result?.speakers) || result.speakers.length > segments.length) throw new Error("模型的说话人结果格式无效。");
    const used = new Set();
    return result.speakers.map(item => {
      const start = segments.findIndex(s => s.id === item.startId);
      const end = segments.findIndex(s => s.id === item.endId);
      if (start < 0 || end < start || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 || /[\r\n\x00-\x1f]/.test(item.name)) throw new Error("模型返回了无效的姓名或字幕范围。");
      const source = segments.slice(start, end + 1).map(s => s.text).join("\n");
      if (typeof item.evidence !== "string" || !item.evidence.trim() || item.evidence.length > 1000 || !source.includes(item.evidence)) throw new Error("模型提供的依据不在对应字幕中，请重试或手动填写。");
      for (let i = start; i <= end; i++) { if (used.has(i)) throw new Error("模型的说话人范围重叠。"); used.add(i); }
      return { startId: item.startId, endId: item.endId, name: item.name.trim(), evidence: item.evidence, confirmed: false };
    });
  }
  return { TYPES, VARIABLES, DEFAULT_TEMPLATE, localDate, interpolate, templateErrors, importTemplate, filename, snapshot, transcriptText, propertyValue, initialProperties, render, speakerBatches, validateSpeakers };
})();
if (typeof module !== "undefined" && module.exports) module.exports = YTD_MARKDOWN;
