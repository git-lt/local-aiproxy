import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  getProviderModels,
  getUiConfig,
  getUiStatus,
  postUiConfig,
  type UiConfig,
  type UiConfigChanges,
  type UiProviderModels,
  type UiStatus,
} from "./api.ts";
import { Header } from "./Header.tsx";
import { useI18n, type I18nKey } from "./i18n.tsx";
import { isValidRequestLogCount, LOG_SIZE_UNITS, parseLogSizeField, splitLogSize, type LogSizeUnit } from "./log-size-field.ts";

/** 表单态：数值/大小字段保持字符串，与服务端 CLI 解析规则一致。 */
interface FormState {
  zcode: boolean;
  codebuddy: boolean;
  cline: boolean;
  qodercn: boolean;
  requestLogging: boolean;
  maxRequestLogs: string;
  maxGatewayLogBytes: string;
  maxGatewayLogUnit: LogSizeUnit;
}

type SavePhase = "idle" | "saving" | "restarting" | "failed";

/** 「只显示启用的模型」开关的本地偏好：刷新后保持用户上次的选择。 */
const ONLY_ENABLED_STORAGE_KEY = "ccp-ui-only-enabled-models";

/**
 * 白名单比较（忽略大小写与顺序）：用于判断乐观值是否已被服务端确认。
 * 服务端会 trim / 去重，直接比较数组会把「其实已经生效」误判成未生效。
 */
function sameModelList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map((slug) => slug.trim().toLowerCase()).filter(Boolean));
  return right.every((slug) => keys.has(slug.trim().toLowerCase()));
}

function CopyButton({ text, title }: { text: string; title: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-icon-btn"
      title={title}
      aria-label={title}
      onClick={() => {
        // 非安全上下文（http 局域网访问）下 clipboard 可能不存在，此时静默跳过。
        const writing = navigator.clipboard?.writeText(text);
        if (!writing) return;
        void writing.then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <span style={{ fontSize: 11 }}>{t("copied")}</span> : (
        <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function ReadonlyRow({
  label, keyname, children,
}: { label: string; keyname: string; children: React.ReactNode }) {
  return (
    <div className="field-row">
      <div className="field-label-group">
        <span className="field-label">{label}</span>
        <span className="field-keyname">{keyname}</span>
      </div>
      <div className="field-control-area">{children}</div>
    </div>
  );
}

export function ConfigPage({
  status, onStatusChange, onAuthExpired,
}: {
  status: UiStatus;
  onStatusChange: (status: UiStatus) => void;
  onAuthExpired: () => void;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<UiConfig | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [phase, setPhase] = useState<SavePhase>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelGroups, setModelGroups] = useState<UiProviderModels | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  /** 待提交的配置变更：连续操作（勾多个开关）合并成一次请求，只触发一次重启。 */
  const pendingChangesRef = useRef<UiConfigChanges>({});
  const pendingTimerRef = useRef<number | undefined>(undefined);
  /** 待提交的模型白名单（乐观值）：连续点击模型开关时以它为基准计算下一次状态。 */
  const [pendingEnabled, setPendingEnabled] = useState<string[] | null>(null);
  /** 正在提交中的模型行（小写 slug）：用于行级 loading 指示与重复点击抑制。 */
  const [pendingSlugs, setPendingSlugs] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** 「只显示启用的模型」筛选。 */
  const [onlyEnabled, setOnlyEnabled] = useState<boolean>(
    () => window.localStorage.getItem(ONLY_ENABLED_STORAGE_KEY) === "1",
  );
  /** 与 pendingChangesRef 一同合并的收尾回调：debounce 合并提交后统一清理行级 pending。 */
  const pendingCallbacksRef = useRef<(() => void)[]>([]);

  const loadModels = useCallback((): void => {
    setModelsLoading(true);
    setModelsError(null);
    getProviderModels()
      .then((next) => setModelGroups(next))
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 401) {
          onAuthExpired();
          return;
        }
        setModelsError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setModelsLoading(false));
  }, [onAuthExpired]);
  useEffect(loadModels, [loadModels]);

  const loadConfig = useCallback((): void => {
    setLoadError(null);
    void getUiConfig().then((next) => {
      const logSize = splitLogSize(next.editable.maxGatewayLogBytes ?? 0);
      setConfig(next);
      // 乐观白名单只在服务端确认后才撤销：保存请求返回时 config 仍是旧值，
      // 立刻回退会让刚点过的开关闪回原状态，必须等到这次刷新拿到新值。
      setPendingEnabled((current) =>
        current === null || sameModelList(current, next.editable.enabledModels) ? null : current,
      );
      setForm({
        zcode: next.editable.zcode,
        codebuddy: next.editable.codebuddy,
        cline: next.editable.cline,
        qodercn: next.editable.qodercn,
        requestLogging: next.editable.requestLogging,
        maxRequestLogs: String(next.editable.maxRequestLogs ?? 0),
        maxGatewayLogBytes: logSize.value,
        maxGatewayLogUnit: logSize.unit,
      });
    }).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) {
        onAuthExpired();
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [onAuthExpired]);
  useEffect(loadConfig, [loadConfig]);

  const logSize = form ? parseLogSizeField(form.maxGatewayLogBytes, form.maxGatewayLogUnit) : null;
  const invalidLogSize = form !== null && logSize === null;
  const invalidRequestLogCount = form !== null && !isValidRequestLogCount(form.maxRequestLogs);
  // 待提交白名单优先：连续点击模型开关时，以「下一次要提交的值」为基准计算，
  // 否则第二次点击会基于尚未刷新的服务端值，把第一次点击丢掉。
  const effectiveEnabled = pendingEnabled ?? (config?.editable.enabledModels ?? []);
  const enabledSet = useMemo(
    () => new Set(effectiveEnabled.map((slug) => slug.toLowerCase())),
    [effectiveEnabled],
  );
  const allModelsEnabled = enabledSet.has("*");

  const SAVE_DEBOUNCE_MS = 600;

  /**
   * 合并待保存字段，静默 600ms 后一次性提交：连续勾选多个开关只触发一次请求、
   * 一次网关重启。重启完成由轮询恢复配置与模型清单。
   *
   * `onSettled` 在这次提交结束（成功或失败）后调用，用于清理行级 loading；
   * debounce 合并的多次改动共用同一次收尾。
   */
  const queueSave = (change: UiConfigChanges, onSettled?: () => void): void => {
    Object.assign(pendingChangesRef.current, change);
    if (onSettled) pendingCallbacksRef.current.push(onSettled);
    setSaveError(null);
    setPhase("saving");
    window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => {
      const changes = pendingChangesRef.current;
      const callbacks = pendingCallbacksRef.current;
      pendingChangesRef.current = {};
      pendingCallbacksRef.current = [];
      postUiConfig(changes)
        .then((result) => {
          // 这里刻意不清 pendingEnabled：响应到达时本地 config 还是旧白名单，
          // 清掉会让开关回跳。交给 loadConfig 在拿到一致的新配置后再撤销。
          if (result.restarting) setPhase("restarting");
          else {
            setPhase("idle");
            loadConfig();
            loadModels();
          }
        })
        .catch((cause: unknown) => {
          if (cause instanceof ApiError && cause.status === 401) {
            onAuthExpired();
            return;
          }
          // 保存失败：撤销乐观值，让界面回到服务端真值而不是停在假状态。
          setPendingEnabled(null);
          setSaveError(cause instanceof Error ? cause.message : String(cause));
          setPhase("failed");
        })
        .finally(() => {
          for (const done of callbacks) done();
        });
    }, SAVE_DEBOUNCE_MS);
  };
  // 开关按本机配置探测结果显示：未检测到本地配置时隐藏，避免展示永远无法生效的入口；
  // 开关已开启时（例如用户删掉了本机配置）仍显示，便于在 UI 里关回。
  const showZcode = Boolean(config && (config.detected.zcode || config.editable.zcode));
  const showCodebuddy = Boolean(config && (config.detected.codebuddy || config.editable.codebuddy));
  const showCline = Boolean(config && (config.detected.cline || config.editable.cline));
  const showQodercn = Boolean(config && (config.detected.qodercn || config.editable.qodercn));
  // provider 开关的展示元数据：新增 provider 只需在这里登记一条，渲染与文案都随之生效。
  const providerGroups = [
    { key: "zcode", visible: showZcode, label: "labelZcode", hint: "zcodeMissingHint" },
    { key: "codebuddy", visible: showCodebuddy, label: "labelCodebuddy", hint: "codebuddyMissingHint" },
    { key: "cline", visible: showCline, label: "labelCline", hint: "clineMissingHint" },
    { key: "qodercn", visible: showQodercn, label: "labelQodercn", hint: "qodercnMissingHint" },
  ] as const satisfies readonly { key: keyof FormState; visible: boolean; label: I18nKey; hint: I18nKey }[];
  /**
   * 模型级开关：加入/移出白名单并 debounce 保存。白名单为 `*`（全部放行）时
   * 关闭某个模型，会展开为「除它之外的全部已知模型」。
   *
   * 点击立即翻转（乐观值），提交期间该行显示 loading，直到服务端确认或报错。
   */
  const toggleModel = (slug: string, allKnownSlugs: string[]): void => {
    if (phase === "restarting") return;
    const key = slug.toLowerCase();
    let next: string[];
    if (allModelsEnabled) {
      next = allKnownSlugs.filter((item) => item.toLowerCase() !== key);
    } else if (enabledSet.has(key)) {
      next = effectiveEnabled.filter((item) => item.toLowerCase() !== key);
    } else {
      next = [...effectiveEnabled, slug];
    }
    setPendingEnabled(next);
    setPendingSlugs((prev) => new Set(prev).add(key));
    queueSave({ enabledModels: next }, () => {
      setPendingSlugs((prev) => {
        if (!prev.has(key)) return prev;
        const rest = new Set(prev);
        rest.delete(key);
        return rest;
      });
    });
  };

  /** 网关重启完成后恢复：刷新配置与状态并提示已生效。 */
  useEffect(() => {
    if (phase !== "restarting") return;
    const timer = window.setInterval(() => {
      void getUiStatus()
        .then((next) => {
          onStatusChange(next);
          setPhase("idle");
          loadConfig();
          loadModels();
        })
        .catch((cause: unknown) => {
          // 重启窗口期内 healthz 失败是预期行为，继续轮询；令牌失效例外，须回到输入框。
          if (cause instanceof ApiError && cause.status === 401) onAuthExpired();
        });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase, loadConfig, loadModels, onStatusChange, onAuthExpired]);

  const restartBanner = phase === "restarting" || phase === "saving";

  return (
    <div className="page">
      <Header status={status} />
      {restartBanner && (
        <div className="restart-banner">
          <span className="status-dot" />
          {phase === "saving" ? t("saving") : t("savedRestarting")}
        </div>
      )}
      {phase === "failed" && saveError && (
        <div className="restart-banner error">
          {t("saveFailed")}: {saveError}
        </div>
      )}
      {loadError && (
        <div className="restart-banner error">
          <span>{t("loadFailed")}: {loadError}</span>
          <button
            className="btn btn-secondary"
            style={{ padding: "4px 10px", fontSize: 11 }}
            onClick={loadConfig}
          >
            {t("retry")}
          </button>
        </div>
      )}
      <main className="content-container">
        <section className="card">
          <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="card-title-group">
              <h2 className="card-title">{t("cardProvidersTitle")}</h2>
            </div>
            <div className="card-header-actions">
              <label className="inline-check" title={t("showOnlyEnabled")}>
                <input
                  type="checkbox"
                  checked={onlyEnabled}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setOnlyEnabled(checked);
                    window.localStorage.setItem(ONLY_ENABLED_STORAGE_KEY, checked ? "1" : "0");
                  }}
                />
                <span>{t("showOnlyEnabled")}</span>
              </label>
              <button
                className="btn btn-secondary"
                style={{ padding: "4px 10px", fontSize: 11 }}
                disabled={modelsLoading}
                onClick={loadModels}
              >
                {modelsLoading ? t("saving") : t("refresh")}
              </button>
            </div>
          </div>
          <div className="card-body">
            {modelsError && (
              <div className="restart-banner error" style={{ marginBottom: 12 }}>
                <span>{t("loadFailed")}: {modelsError}</span>
                <button className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 11 }} onClick={loadModels}>{t("retry")}</button>
              </div>
            )}
            {providerGroups.map((group) => {
              if (!group.visible) return null;
              const label = t(group.label);
              const hint = t(group.hint);
              const enabled = form?.[group.key] ?? false;
              const detected = config?.detected[group.key] ?? false;
              // 关闭的 provider 不展示其模型列表与提示，避免列表与开关状态不一致。
              const allSlugs = enabled ? modelGroups?.[group.key] ?? [] : [];
              const isModelOff = (slug: string): boolean =>
                !allModelsEnabled && !enabledSet.has(slug.toLowerCase());
              // 「只显示启用的模型」只影响展示，不改变白名单语义（关闭的模型仍可被重新启用）。
              const slugs = onlyEnabled ? allSlugs.filter((slug) => !isModelOff(slug)) : allSlugs;
              const allKnownSlugs = providerGroups.flatMap((entry) => modelGroups?.[entry.key] ?? []);
              return (
                <div className="field-row" key={group.key}>
                  <div className="field-label-group">
                    <span className="field-label">{label}</span>
                  </div>
                  <div className="field-control-area">
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={!config || !form || phase === "restarting"}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setForm(form ? { ...form, [group.key]: checked } : form);
                            queueSave({ [group.key]: checked });
                          }}
                        />
                        <span className="slider" />
                      </label>
                      {enabled && <span className="field-keyname">{allSlugs.length}</span>}
                    </div>
                    {enabled && !detected && <p className="field-desc zcode-disabled-hint">{hint}</p>}
                    {enabled && (allSlugs.length === 0
                      ? <p className="field-desc">{t("modelsEmpty")}</p>
                      : slugs.length === 0
                        ? <p className="field-desc">{t("modelsNoneEnabled")}</p>
                        : (
                        <div style={{ maxHeight: 200, overflowY: "auto", scrollbarGutter: "stable", paddingRight: 6, marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                          {slugs.map((slug) => {
                            const off = isModelOff(slug);
                            const pending = pendingSlugs.has(slug.toLowerCase());
                            return (
                              <div
                                key={slug}
                                className="model-row"
                                aria-busy={pending || undefined}
                              >
                                <code style={{ fontSize: 11.5, color: off ? "var(--fg-muted)" : "var(--fg-primary)" }}>{slug}</code>
                                <div className="model-row-actions">
                                  {pending && (
                                    <svg
                                      className="model-row-pending"
                                      role="status"
                                      aria-label={t("saving")}
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      strokeLinecap="round"
                                    >
                                      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                                    </svg>
                                  )}
                                  <CopyButton text={slug} title={`${t("copyModelId")}: ${slug}`} />
                                  <label
                                    className={`switch${phase === "restarting" ? " disabled" : ""}`}
                                    style={{ transform: "scale(0.72)", transformOrigin: "right center", margin: 0 }}
                                    title={slug}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={!off}
                                      disabled={phase === "restarting"}
                                      onChange={() => toggleModel(slug, allKnownSlugs)}
                                    />
                                    <span className="slider" />
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div
            className="card-header"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}
            onClick={() => setRuntimeOpen((open) => !open)}
          >
            <div className="card-title-group">
              <h2 className="card-title">{t("card1Title")}</h2>
              <span className="card-badge badge-editable">{t("badgeEditable")}</span>
            </div>
            <svg
              style={{ width: 14, height: 14, color: "var(--fg-muted)", transform: runtimeOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          {runtimeOpen && config && form && (
            <div className="card-body">
              <div className="field-row">
                <div className="field-label-group">
                  <span className="field-label">{t("labelReqLogging")}</span>
                  <span className="field-keyname">requestLogging</span>
                </div>
                <div className="field-control-area">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={form.requestLogging}
                      disabled={phase === "restarting"}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setForm({ ...form, requestLogging: checked });
                        queueSave({ requestLogging: checked });
                      }}
                    />
                    <span className="slider" />
                  </label>
                  <p className="field-desc">{t("descReqLogging")}</p>
                  {form.requestLogging && (
                    <div className="log-dir-line">
                      <code>{config.editable.logDir}</code>
                      <span className="field-desc">{t("pathNote")}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="field-row">
                <div className="field-label-group">
                  <span className="field-label">{t("labelMaxReqLogs")}</span>
                  <span className="field-keyname">maxRequestLogs</span>
                </div>
                <div className="field-control-area">
                  <input
                    type="number"
                    className="input-number"
                    min={0}
                    max={1000}
                    step={10}
                    required
                    aria-label={t("labelMaxReqLogs")}
                    aria-invalid={invalidRequestLogCount}
                    aria-describedby={invalidRequestLogCount ? "request-log-count-error" : undefined}
                    value={form.maxRequestLogs}
                    onChange={(event) => setForm({ ...form, maxRequestLogs: event.target.value })}
                    onBlur={() => {
                      // 失焦才提交：输入中间态不落盘；非法值不保存，由 aria-invalid 提示。
                      if (invalidRequestLogCount) return;
                      if (form.maxRequestLogs !== String(config.editable.maxRequestLogs ?? 0)) {
                        queueSave({ maxRequestLogs: form.maxRequestLogs.trim() });
                      }
                    }}
                  />
                  <p className="field-desc">{t("descMaxReqLogs")}</p>
                  {invalidRequestLogCount && <p id="request-log-count-error" className="field-desc error-text" role="alert">{t("requestLogCountInvalid")}</p>}
                </div>
              </div>
              <div className="field-row">
                <div className="field-label-group">
                  <span className="field-label">{t("labelMaxGwBytes")}</span>
                  <span className="field-keyname">maxGatewayLogBytes</span>
                </div>
                <div className="field-control-area">
                  <div className="log-size-control">
                    <input
                      type="number"
                      className="input-number"
                      min={0}
                      max={1024}
                      step="any"
                      required
                      aria-label={t("labelMaxGwBytes")}
                      aria-invalid={invalidLogSize}
                      aria-describedby={invalidLogSize ? "log-size-error" : undefined}
                      value={form.maxGatewayLogBytes}
                      onChange={(event) => setForm({ ...form, maxGatewayLogBytes: event.target.value })}
                      onBlur={() => {
                        if (invalidLogSize) return;
                        const parsed = parseLogSizeField(form.maxGatewayLogBytes, form.maxGatewayLogUnit);
                        if (parsed && parsed.bytes !== (config.editable.maxGatewayLogBytes ?? 0)) {
                          queueSave({ maxGatewayLogBytes: parsed.payload });
                        }
                      }}
                      />
                      <select
                        className="input-text"
                        aria-label={t("logSizeUnit")}
                        value={form.maxGatewayLogUnit}
                        onChange={(event) => {
                          const unit = event.target.value as LogSizeUnit;
                          setForm({ ...form, maxGatewayLogUnit: unit });
                          if (!invalidLogSize) {
                            const parsed = parseLogSizeField(form.maxGatewayLogBytes, unit);
                            if (parsed && parsed.bytes !== (config.editable.maxGatewayLogBytes ?? 0)) {
                              queueSave({ maxGatewayLogBytes: parsed.payload });
                            }
                          }
                        }}
                      >
                      {LOG_SIZE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                    </select>
                  </div>
                  <p className="field-desc">{t("descMaxGwBytes")}</p>
                  {invalidLogSize && <p id="log-size-error" className="field-desc error-text" role="alert">{t("logSizeInvalid")}</p>}
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
