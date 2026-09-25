import { useCallback, useEffect, useMemo, useState } from "react";
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

type SavePhase = "idle" | "confirm" | "saving" | "restarting" | "failed";

function CopyButton({ text, title }: { text: string; title: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-icon-btn"
      title={title}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
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
  const dirty = useMemo(() => {
    if (!config || !form) return false;
    return form.zcode !== config.editable.zcode
      || form.codebuddy !== config.editable.codebuddy
      || form.cline !== config.editable.cline
      || form.qodercn !== config.editable.qodercn
      || form.requestLogging !== config.editable.requestLogging
      || form.maxRequestLogs !== String(config.editable.maxRequestLogs ?? 0)
      || parseLogSizeField(form.maxGatewayLogBytes, form.maxGatewayLogUnit)?.bytes !== (config.editable.maxGatewayLogBytes ?? 0);
  }, [config, form]);
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
  // 模型白名单：`*` 全部放行；否则只放行名单内的 slug（不区分大小写）。
  // 缺省/空 = 全部模型开关默认关闭。
  const enabledSet = useMemo(
    () => new Set((config?.editable.enabledModels ?? []).map((slug) => slug.toLowerCase())),
    [config],
  );
  const allModelsEnabled = enabledSet.has("*");

  /**
   * 模型级开关：立即保存 enabledModels 白名单（可能触发网关重启，由轮询恢复）。
   * 白名单为 `*`（全部放行）时关闭某个模型，会展开为「除它之外的全部已知模型」。
   */
  const toggleModel = (slug: string, allKnownSlugs: string[]): void => {
    if (!config || phase === "saving" || phase === "restarting") return;
    const current = config.editable.enabledModels ?? [];
    const key = slug.toLowerCase();
    let next: string[];
    if (allModelsEnabled) {
      next = allKnownSlugs.filter((item) => item.toLowerCase() !== key);
    } else if (current.some((item) => item.toLowerCase() === key)) {
      next = current.filter((item) => item.toLowerCase() !== key);
    } else {
      next = [...current, slug];
    }
    setPhase("saving");
    setSaveError(null);
    postUiConfig({ enabledModels: next })
      .then((result) => {
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
        setSaveError(cause instanceof Error ? cause.message : String(cause));
        setPhase("failed");
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

  /**
   * 保存序列：写其余配置（可能触发网关重启，由轮询恢复）。模型列表跟随本机
   * ZCode/CodeBuddy 登录态，无独立选择项。
   */
  const save = (): void => {
    if (!config || !form || !logSize || invalidRequestLogCount) return;
    const formSnapshot = form;
    setPhase("saving");
    setSaveError(null);
    const run = async (): Promise<"restarting" | "done"> => {
      const changes: UiConfigChanges = {};
      if (formSnapshot.zcode !== config.editable.zcode) changes.zcode = formSnapshot.zcode;
      if (formSnapshot.codebuddy !== config.editable.codebuddy) changes.codebuddy = formSnapshot.codebuddy;
      if (formSnapshot.cline !== config.editable.cline) changes.cline = formSnapshot.cline;
      if (formSnapshot.qodercn !== config.editable.qodercn) changes.qodercn = formSnapshot.qodercn;
      if (formSnapshot.requestLogging !== config.editable.requestLogging) {
        changes.requestLogging = formSnapshot.requestLogging;
      }
      if (formSnapshot.maxRequestLogs !== String(config.editable.maxRequestLogs ?? 0)) {
        changes.maxRequestLogs = formSnapshot.maxRequestLogs.trim();
      }
      if (logSize.bytes !== (config.editable.maxGatewayLogBytes ?? 0)) {
        changes.maxGatewayLogBytes = logSize.payload;
      }
      if (Object.keys(changes).length === 0) return "done";
      const result = await postUiConfig(changes);
      return result.restarting ? "restarting" : "done";
    };
    void run().then((outcome) => {
      if (outcome === "restarting") setPhase("restarting");
      else {
        setPhase("idle");
        loadConfig();
      }
    }).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) {
        onAuthExpired();
        return;
      }
      setSaveError(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    });
  };

  const restartBanner = phase === "restarting" || phase === "saving";

  return (
    <div className="page">
      <Header status={status}>
        <button
          className={`btn btn-save${dirty && phase === "idle" ? " dirty" : ""}`}
          disabled={!dirty || invalidLogSize || invalidRequestLogCount || (phase !== "idle" && phase !== "failed")}
          onClick={() => setPhase("confirm")}
        >
          <span>{phase === "saving" ? t("saving") : t("saveBtn")}</span>
        </button>
      </Header>
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
              <span className="card-badge badge-editable">{t("badgeEditable")}</span>
            </div>
            <button
              className="btn btn-secondary"
              style={{ padding: "4px 10px", fontSize: 11 }}
              disabled={modelsLoading}
              onClick={loadModels}
            >
              {modelsLoading ? t("saving") : t("refresh")}
            </button>
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
              const slugs = enabled ? modelGroups?.[group.key] ?? [] : [];
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
                          disabled={!config || !form}
                          onChange={(event) => setForm(form ? { ...form, [group.key]: event.target.checked } : form)}
                        />
                        <span className="slider" />
                      </label>
                      {enabled && <span className="field-keyname">{slugs.length}</span>}
                    </div>
                    {enabled && !detected && <p className="field-desc zcode-disabled-hint">{hint}</p>}
                    {enabled && (slugs.length === 0
                      ? <p className="field-desc">{t("modelsEmpty")}</p>
                      : (
                        <div style={{ maxHeight: 200, overflowY: "auto", scrollbarGutter: "stable", paddingRight: 6, marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                          {slugs.map((slug) => {
                            const off = !allModelsEnabled && !enabledSet.has(slug.toLowerCase());
                            return (
                              <div key={slug} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "2px 0" }}>
                                <code style={{ fontSize: 11.5, color: off ? "var(--fg-muted)" : "var(--fg-primary)" }}>{slug}</code>
                                <label
                                  className="switch"
                                  style={{ transform: "scale(0.72)", transformOrigin: "right center", margin: 0 }}
                                  title={slug}
                                >
                                  <input type="checkbox" checked={!off} onChange={() => toggleModel(slug, allKnownSlugs)} />
                                  <span className="slider" />
                                </label>
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
                      onChange={(event) =>
                        setForm({ ...form, requestLogging: event.target.checked })}
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
                    />
                    <select
                      className="input-text"
                      aria-label={t("logSizeUnit")}
                      value={form.maxGatewayLogUnit}
                      onChange={(event) => setForm({ ...form, maxGatewayLogUnit: event.target.value as LogSizeUnit })}
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

      {phase === "confirm" && config && form && (
        <div className="modal-overlay active" onClick={() => setPhase("idle")}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">
              <svg style={{ width: 18, height: 18, color: "#f59e0b" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>{t("modalTitle")}</span>
            </div>
            <p className="modal-body">{t("modalBody")}</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setPhase("idle")}>{t("cancel")}</button>
              <button
                className="btn btn-save dirty"
                onClick={() => save()}
              >
                {t("confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
