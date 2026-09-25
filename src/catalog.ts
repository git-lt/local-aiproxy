import type { ModelCatalog, ModelEntry } from "./types.ts";

export interface ModelOverrideRule {
  patterns: string[];
  prefix: boolean;
  fields: Record<string, unknown>;
}

function invalidOverrides(file: string, message: string): never {
  throw new Error(`Invalid model overrides ${file}: ${message}`);
}

/** 编译分组覆盖表（根目录 models.json 与 models/vendor_models.json 同构）。 */
export function compileModelOverrides(value: unknown, source = "models"): ModelOverrideRule[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidOverrides(source, "expected an object of model groups");
  }

  const rules: ModelOverrideRule[] = [];
  for (const [rawGroup, entries] of Object.entries(value as Record<string, unknown>)) {
    const group = rawGroup.trim();
    if (!group || group.includes("/")) invalidOverrides(source, `invalid group ${JSON.stringify(rawGroup)}`);
    if (!Array.isArray(entries)) invalidOverrides(source, `group ${JSON.stringify(group)} must be an array`);

    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        invalidOverrides(source, `${group}[${index}] must be an object`);
      }
      const fields = entry as Record<string, unknown>;
      const name = typeof fields.name === "string" ? fields.name.trim() : "";
      if (!name) invalidOverrides(source, `${group}[${index}].name must be a non-empty string`);
      const star = name.indexOf("*");
      if (star >= 0 && star !== name.length - 1) {
        invalidOverrides(source, `${group}[${index}].name may contain only one trailing *`);
      }
      if (Object.hasOwn(fields, "slug") || Object.hasOwn(fields, "priority")) {
        invalidOverrides(source, `${group}[${index}] may not override slug or priority`);
      }

      const { name: _name, ...overrides } = fields;
      // openai 组的模型 ID 不带组名前缀；其余组同时编译「组名/名称」与裸「名称」两种
      // 模式，让同一份覆盖表既能命中 CLIProxy 的 vendor/model ID，也能命中 new-api
      // 这类 OpenAI 兼容上游的裸模型 ID。通配全部（*）的规则不加裸别名，否则它
      // 会升级成全局兜底，误伤其他组的模型。
      const scopedNames = group.toLowerCase() === "openai"
        ? [name]
        : name === "*" ? [`${group}/${name}`] : [`${group}/${name}`, name];
      rules.push({
        patterns: scopedNames.map((scoped) =>
          (star >= 0 ? scoped.slice(0, -1) : scoped).toLowerCase()),
        prefix: star >= 0,
        fields: overrides,
      });
    }
  }
  return rules;
}

/**
 * 校验 Codex 目录格式的快照（{"models":[...]}，兼容 models/codex_client_models.json
 * 与 models/vendor_models.json 两种来源）。二者均通过构建期 import 内联进 dist。
 */
export function parseCodexCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) {
    throw new Error('Invalid codex catalog: expected { "models": [...] }');
  }
  const models = (value as { models: unknown[] }).models.filter(
    (model): model is ModelEntry => Boolean(
      model && typeof model === "object" && "slug" in model
      && typeof (model as ModelEntry).slug === "string" && (model as ModelEntry).slug,
    ),
  );
  if (models.length === 0) {
    throw new Error("Invalid codex catalog: no models with a non-empty slug");
  }
  return { models: [...new Map(models.map((model) => [model.slug, model])).values()] };
}

/**
 * models.json 已知厂商命中的合成基底：仅包含 Codex 解析所需的保守字段，不携带任何
 * GPT 专属配置（model_messages、reasoning levels、prefer_websockets 等），由命中的
 * 覆盖规则补全厂商元数据。字段集与仓库 models.json 覆盖条目同源。
 */
function minimalModelEntry(id: string, priority: number): ModelEntry {
  return {
    slug: id,
    display_name: id,
    description: `OpenAI-compatible model "${id}" served by the configured upstream.`,
    visibility: "list",
    supported_in_api: true,
    priority,
    base_instructions: "",
    shell_type: "shell_command",
    apply_patch_tool_type: "freeform",
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10000 },
    context_window: 128000,
    max_context_window: 128000,
    effective_context_window_percent: 95,
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
  };
}

const EMPTY_RULES: ModelOverrideRule[] = [];

/**
 * 以厂商预设/官方目录为元数据源为外部模型 ID 合成条目，优先级：
 * 1. 厂商预设（models/vendor_models.json，z.ai/deepseek/moonshotai 分组，与根目录
 *    models.json 同构）规则命中 → 极简基底 + 官方条目字段，不继承任何 GPT 专属配置；
 * 2. Codex 目录快照（models/codex_client_models.json）精确命中 → 沿用真实条目；
 * 3. 根目录 models.json 覆盖规则命中 → 极简基底 + 规则字段；
 * 4. 均未命中 → 克隆 gpt-5.5 条目并替换标识字段、解除最小客户端版本限制。
 * 大小写不敏感匹配；priority 一律按序重排。
 */
export function synthesizeModelEntry(
  id: string,
  priority: number,
  snapshot: ModelCatalog,
  vendors: ModelOverrideRule[] = EMPTY_RULES,
  overrides: ModelOverrideRule[] = EMPTY_RULES,
  baseSlug = "gpt-5.5",
): ModelEntry {
  const vendorRule = findMatchingRule(id, vendors);
  if (vendorRule) {
    return applyModelOverrides(minimalModelEntry(id, priority), vendors);
  }
  const known = snapshot.models.find((model) => model.slug.toLowerCase() === id.toLowerCase());
  if (known) {
    const model = structuredClone(known);
    model.slug = id;
    model.priority = priority;
    return model;
  }
  if (findMatchingRule(id, overrides)) {
    return applyModelOverrides(minimalModelEntry(id, priority), overrides);
  }
  const base = snapshot.models.find((model) => model.slug === baseSlug);
  if (!base) {
    throw new Error(`codex_client_models snapshot does not contain the "${baseSlug}" base entry`);
  }
  const model = structuredClone(base);
  model.slug = id;
  model.display_name = id;
  model.description = `OpenAI-compatible model "${id}" served by the configured upstream.`;
  delete model.minimal_client_version;
  model.priority = priority;
  return model;
}

function prefixModel(source: ModelEntry, prefix: string, priority: number): ModelEntry {
  const model = structuredClone(source);
  model.slug = `${prefix}${source.slug}`;
  model.display_name = source.display_name || source.slug;
  model.priority = priority;
  return model;
}

function findMatchingRule(slug: string, rules: ModelOverrideRule[]): ModelOverrideRule | undefined {
  const lower = slug.toLowerCase();
  return rules.find((rule) =>
    rule.patterns.some((pattern) => (rule.prefix ? lower.startsWith(pattern) : lower === pattern)));
}

function applyModelOverrides(source: ModelEntry, rules: ModelOverrideRule[]): ModelEntry {
  const rule = findMatchingRule(source.slug, rules);
  const model = structuredClone(source);
  return rule ? { ...model, ...rule.fields } : model;
}

/**
 * 合并「基底目录 + 追加目录」：基底条目先过一遍覆盖规则，追加条目加上 `prefix` 后
 * 排在基底之后（priority 从基底的最高值 +100 起递增，保证基底始终优先）。
 * ZCode 以 `prefix = ""` 调用，表示不追加前缀。
 */
export function mergeCatalog(
  nativeCatalog: ModelCatalog,
  proxyCatalog: ModelCatalog,
  prefix = "",
  overrides: ModelOverrideRule[] = [],
): ModelCatalog {
  const nativeModels = nativeCatalog.models
    .filter((model) => !String(model.slug).startsWith(prefix))
    .map((model) => applyModelOverrides(model, overrides));
  const highestPriority = Math.max(0, ...nativeModels.map((model) => Number(model.priority) || 0));
  const proxyModels = proxyCatalog.models.map(
    (model, index) => prefixModel(
      applyModelOverrides(model, overrides),
      prefix,
      highestPriority + 100 + index,
    ),
  );
  return { models: [...nativeModels, ...proxyModels] };
}

