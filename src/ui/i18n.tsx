import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "zh" | "en";

/**
 * 中英文案对照。技术字段名（zcode、maxRequestLogs…）不翻译，保持与
 * schemas/gateway-config.schema.json 一致的标识符。
 */
const DICT = {
  zh: {
    brandBadge: "Web UI",
    localBadge: "仅本机",
    running: "运行中",
    logsBtn: "日志 / Logs",
    backToConfig: "返回配置 / Back",
    saveBtn: "保存 / Save",
    saving: "保存中…",
    card1Title: "运行行为 / Runtime",
    badgeEditable: "可编辑",
    labelReqLogging: "请求日志",
    descReqLogging: "开启后完整请求/响应交换按文件落盘。",
    pathNote: "落盘目录",
    labelMaxReqLogs: "请求日志保留数",
    descMaxReqLogs: "输入 0～1000 的整数，0 = 不限制。整个日志目录按修改时间保留最新文件。",
    requestLogCountInvalid: "请输入 0～1000 的整数。",
    labelMaxGwBytes: "进程日志大小上限",
    descMaxGwBytes: "输入 0～1024 的数字并选择 KB 或 MB；0 表示不限制。",
    logSizeUnit: "日志大小单位",
    logSizeInvalid: "请输入 0～1024 的有效数字。",
    labelZcode: "ZCode",
    zcodeMissingHint: "未检测到本机 ZCode 配置（~/.zcode）；请先在 ZCode 中登录并选择 provider，或关闭此开关。",
    labelCodebuddy: "CodeBuddy",
    codebuddyMissingHint: "未检测到本机 CodeBuddy/WorkBuddy 登录凭据；请在 CodeBuddy/WorkBuddy 桌面端或 CLI 重新登录，或关闭此开关。",
    labelCline: "Cline",
    clineMissingHint: "未检测到 Cline API Key；请在 app.cline.bot 控制台创建，并单行写入 ~/.local-aiproxy/cline-api-key（chmod 600），或关闭此开关。",
    labelQodercn: "QoderCN",
    qodercnMissingHint: "未检测到本机 QoderCN/通义灵码登录缓存；请在 QoderCN 桌面端重新登录，或关闭此开关。",
    cardProvidersTitle: "服务与模型 / Providers & Models",
    copyBaseUrl: "复制 baseUrl",
    copied: "已复制",
    cardModelsTitle: "模型列表 / Models",
    modelsEmpty: "（暂无模型——确认对应客户端已在本机登录）",
    modalTitle: "确认保存配置？ / Confirm Save",
    modalBody: "保存后网关将自动重启，期间请求会短暂失败。",
    cancel: "取消 / Cancel",
    confirm: "确认保存 / Confirm",
    savedRestarting: "已保存，网关重启中 / Saved. Gateway restarting",
    gatewayRestarted: "网关已恢复，配置已生效",
    loadFailed: "加载失败",
    retry: "重试",
    tokenTitle: "需要访问令牌",
    tokenDesc: "Web UI 需要令牌鉴权。请运行 local-aiproxy web 获取带令牌的地址，或粘贴令牌：",
    tokenPlaceholder: "ccp_…",
    tokenSubmit: "继续",
    tokenInvalid: "令牌无效",
    logsTitle: "日志 / Logs",
    tabGateway: "网关日志",
    tabRequests: "请求日志",
    refreshTail: "刷新文本 / Refresh tail",
    refreshList: "刷新目录 / Refresh list",
    refreshListTitle: "刷新目录列表（不重载已打开的预览）",
    splitterTitle: "拖动调整宽度 / Drag to resize",
    findPlaceholder: "查找 / Find…",
    prevMatch: "上一个 / Previous",
    nextMatch: "下一个 / Next",
    closeFind: "关闭 / Close",
    autoRefresh: "自动刷新",
    refresh: "刷新",
    filterPlaceholder: "Filter...",
    previewTruncated: "仅显示末尾 64KB / Showing last 64KB",
    logTruncated: "仅显示末尾 256KB / Showing last 256KB",
    requestsEmpty: "开启请求日志后，这里会出现按请求写下的完整交换记录",
    loggingOffHint: "请求日志未开启——在配置页打开「请求日志」，或运行 local-aiproxy config --log on",
    thFilename: "日志文件",
    thSize: "大小",
    thUpdated: "修改时间",
    pagerPrev: "上一页",
    pagerNext: "下一页",
    pagerStatus: "第 {page}/{pages} 页 · 共 {total} 条",
    perPage: "页",
    selectFile: "点击左侧文件查看内容",
    saveFailed: "保存失败",
    emptyLog: "（暂无日志）",
  },
  en: {
    brandBadge: "Web UI",
    localBadge: "localhost only",
    running: "Running",
    logsBtn: "日志 / Logs",
    backToConfig: "返回配置 / Back",
    saveBtn: "保存 / Save",
    saving: "Saving…",
    card1Title: "运行行为 / Runtime",
    badgeEditable: "Editable",
    labelReqLogging: "Request Logging",
    descReqLogging: "Writes full request/response exchanges to files.",
    pathNote: "Log directory",
    labelMaxReqLogs: "Max Request Logs",
    descMaxReqLogs: "Enter an integer from 0 to 1000; 0 = unlimited. Keeps the newest files by mtime across the directory.",
    requestLogCountInvalid: "Enter an integer from 0 to 1000.",
    labelMaxGwBytes: "Max Gateway Log Bytes",
    descMaxGwBytes: "Enter a number from 0 to 1024 and select KB or MB; 0 = unlimited.",
    logSizeUnit: "Log size unit",
    logSizeInvalid: "Enter a valid number from 0 to 1024.",
    labelZcode: "ZCode",
    zcodeMissingHint: "No local ZCode configuration found (~/.zcode); sign in and pick a provider in ZCode first, or turn this off.",
    labelCodebuddy: "CodeBuddy",
    codebuddyMissingHint: "No local CodeBuddy/WorkBuddy credentials found; sign in at the CodeBuddy/WorkBuddy desktop app or CLI, or turn this off.",
    labelCline: "Cline",
    clineMissingHint: "No Cline API Key found; create one at app.cline.bot and write it as a single line into ~/.local-aiproxy/cline-api-key (chmod 600), or turn this off.",
    labelQodercn: "QoderCN",
    qodercnMissingHint: "No local QoderCN/Lingma login cache found; sign in again in the QoderCN desktop app, or turn this off.",
    cardProvidersTitle: "服务与模型 / Providers & Models",
    copyBaseUrl: "Copy base URL",
    copied: "Copied",
    cardModelsTitle: "模型列表 / Models",
    modelsEmpty: "(no models — sign in to the client first)",
    modalTitle: "确认保存配置？ / Confirm Save",
    modalBody: "The gateway restarts after saving; requests may fail briefly.",
    cancel: "取消 / Cancel",
    confirm: "确认保存 / Confirm",
    savedRestarting: "已保存，网关重启中 / Saved. Gateway restarting",
    gatewayRestarted: "Gateway is back; configuration applied",
    loadFailed: "Failed to load",
    retry: "Retry",
    tokenTitle: "Access token required",
    tokenDesc: "The Web UI requires a token. Run local-aiproxy web for a ready link, or paste the token:",
    tokenPlaceholder: "ccp_…",
    tokenSubmit: "Continue",
    tokenInvalid: "Invalid token",
    logsTitle: "日志 / Logs",
    tabGateway: "Gateway Log",
    tabRequests: "Request Logs",
    refreshTail: "刷新文本 / Refresh tail",
    refreshList: "刷新目录 / Refresh list",
    refreshListTitle: "Refresh file list (opened preview is not reloaded)",
    splitterTitle: "拖动调整宽度 / Drag to resize",
    findPlaceholder: "Find…",
    prevMatch: "上一个 / Previous",
    nextMatch: "下一个 / Next",
    closeFind: "关闭 / Close",
    autoRefresh: "Auto refresh",
    refresh: "Refresh",
    filterPlaceholder: "Filter...",
    previewTruncated: "仅显示末尾 64KB / Showing last 64KB",
    logTruncated: "仅显示末尾 256KB / Showing last 256KB",
    requestsEmpty: "Turn on request logging to see full per-request exchanges here",
    loggingOffHint: "Request logging is off — enable it on the config page, or run local-aiproxy config --log on",
    thFilename: "File",
    thSize: "Size",
    thUpdated: "Modified",
    pagerPrev: "Prev",
    pagerNext: "Next",
    pagerStatus: "Page {page}/{pages} · {total} files",
    perPage: "per page",
    selectFile: "Select a file to preview",
    saveFailed: "Save failed",
    emptyLog: "(no logs yet)",
  },
} as const;

export type I18nKey = keyof typeof DICT.zh;

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey) => string;
}

const LangContext = createContext<LangContextValue>({
  lang: "zh",
  setLang: () => {},
  t: (key) => DICT.zh[key],
});

const LANG_STORAGE_KEY = "ccp-ui-lang";

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() =>
    window.localStorage.getItem(LANG_STORAGE_KEY) === "en" ? "en" : "zh");
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    window.localStorage.setItem(LANG_STORAGE_KEY, next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  }, [lang]);
  const t = useCallback((key: I18nKey) => DICT[lang][key] ?? DICT.zh[key], [lang]);
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}

export function useI18n(): LangContextValue {
  return useContext(LangContext);
}
