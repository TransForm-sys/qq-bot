// 配置中心：单一数据源 + 原子写 + 热加载 + 老格式迁移。
// 所有模块（engine / llm / webui）都读同一个 store，WebUI 改完立刻生效，
// 不需要重启进程（接收器间隔这类必须重建的，由 index.ts 订阅 change 后处理）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guessPreset, providerFromPreset } from "./providers.ts";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "config.json");

export const DEFAULT_CONFIG = {
    botUin: "",
    storagePath: "",
    receive: "notify",
    receiveIntervalMs: 1500,
    botName: "",
    personaFile: "persona.md",
    reply: {
        private: true,
        groups: [],
        minIntervalMs: 1200,
        maxPerMinute: 8,
        readDelayMs: [500, 1600],
        typingSpeedCps: 14,
        maxTypingMs: 3500,
        splitSegments: 2,
        quietHours: { enabled: false, start: "23:30", end: "08:00" },
        verifySend: true,
        staleAfterMs: 300000,
        // 发送时机闸门：UI 自动化必须抢前台，所以只在"用户没在用电脑"时才真的去抢。
        // 0 = 关闭闸门（立刻发）；>0 = 等到用户连续这么多毫秒没碰键鼠再发。
        sendIdleMs: 45000,
        // 闸门最长等待；超过就强行发送（否则对方可能等一整天）
        sendMaxWaitMs: 600000
    },
    models: {
        default: "",
        private: "",
        group: "",
        temperature: 0.8,
        maxTokens: 512,
        timeoutMs: 60000,
        retries: 2,
        fallback: true,
        fallbackChain: [],
        historyTokens: 3000
    },
    providers: [],
    plugins: { disabled: [] },
    // 联网搜索：默认开，零 key（走 cn.bing.com 的结果页）。
    // 有 Tavily/Serper 的 key 就填 provider + apiKey，结果更干净。
    search: {
        enabled: true,
        provider: "auto", // auto | bing | tavily | serper
        apiKey: "",
        maxResults: 5,
        maxRounds: 2, // 最多几轮工具往返
        maxCalls: 3 // 一条消息最多查几次
    },
    webui: { port: 8787, host: "127.0.0.1", token: "" }
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function merge(base, patch) {
    if (Array.isArray(patch)) return patch.slice();
    if (isObj(patch)) {
        const out = isObj(base) ? { ...base } : {};
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue;
            out[k] = merge(out[k], v);
        }
        return out;
    }
    return patch;
}

const PLACEHOLDER = /^(your_key|YOUR_KEY|sk-xxx|xxx)$/i;
const realKey = (k) => (typeof k === "string" && k && !PLACEHOLDER.test(k) ? k : "");

// 老 config 只有 llm:{baseURL,apiKey,model}；迁移成 providers + models
function migrate(raw) {
    const cfg = { ...raw };
    if (cfg.llm && typeof cfg.llm === "object") {
        const old = cfg.llm;
        const hasProviders = Array.isArray(cfg.providers) && cfg.providers.length > 0;
        if (!hasProviders) {
            const preset = guessPreset(old.baseURL);
            let p;
            if (preset) {
                p = providerFromPreset(preset.id, realKey(old.apiKey));
                if (old.model && !p.models.includes(old.model)) p.models = [old.model, ...p.models];
            } else {
                p = {
                    id: "custom",
                    name: "自定义端点",
                    kind: "openai",
                    baseURL: String(old.baseURL || ""),
                    apiKey: realKey(old.apiKey),
                    models: old.model ? [old.model] : ["your-model"],
                    enabled: true,
                    priority: 10,
                    rpm: 0
                };
            }
            cfg.providers = [p];
            cfg.models = merge(cfg.models || {}, {
                default: old.model ? `${p.id}/${old.model}` : "",
                temperature: typeof old.temperature === "number" ? old.temperature : undefined
            });
        }
        delete cfg.llm;
    }
    return cfg;
}

function normalize(cfg) {
    cfg.receive = cfg.receive === "db" ? "db" : "notify";
    cfg.receiveIntervalMs = clampInt(cfg.receiveIntervalMs, 300, 60000, 1500);
    cfg.providers = (Array.isArray(cfg.providers) ? cfg.providers : []).map((p, i) => ({
        id: String(p.id || `p${i}`),
        name: String(p.name || p.id || `provider-${i}`),
        kind: ["openai", "anthropic", "azure"].includes(p.kind) ? p.kind : "openai",
        baseURL: String(p.baseURL || ""),
        apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
        models: Array.isArray(p.models) && p.models.length ? p.models.map(String) : ["your-model"],
        enabled: p.enabled !== false,
        priority: clampInt(p.priority, 1, 999, i + 1),
        rpm: clampInt(p.rpm, 0, 100000, 0),
        apiVersion: String(p.apiVersion || (p.kind === "azure" ? "2024-10-21" : "")),
        note: String(p.note || "")
    }));
    const r = cfg.reply || {};
    cfg.reply = {
        private: r.private !== false,
        groups: Array.isArray(r.groups) ? r.groups.map(String) : [],
        minIntervalMs: clampInt(r.minIntervalMs, 0, 600000, 1200),
        maxPerMinute: clampInt(r.maxPerMinute, 1, 600, 8),
        readDelayMs: clampPair(r.readDelayMs, 0, 60000, [500, 1600]),
        typingSpeedCps: clampInt(r.typingSpeedCps, 1, 200, 14),
        maxTypingMs: clampInt(r.maxTypingMs, 0, 60000, 3500),
        splitSegments: clampInt(r.splitSegments, 1, 6, 2),
        quietHours: {
            enabled: Boolean(r.quietHours?.enabled),
            start: timeStr(r.quietHours?.start, "23:30"),
            end: timeStr(r.quietHours?.end, "08:00")
        },
        // 发送后校验输入框是否真的清空（消除"点击落空但仍记成功"）
        verifySend: r.verifySend !== false,
        // 超过这个时长的消息视为过期（睡眠/挂起醒来后不要回复一堆历史消息）
        staleAfterMs: clampInt(r.staleAfterMs, 0, 86400000, 300000),
        // 用户空闲多久才允许抢前台发送（0 = 不等待，立刻发）
        sendIdleMs: clampInt(r.sendIdleMs, 0, 3600000, 45000),
        // 最长等多久就强行发（0 = 不限）
        sendMaxWaitMs: clampInt(r.sendMaxWaitMs, 0, 86400000, 600000)
    };
    const m = cfg.models || {};
    cfg.models = {
        default: String(m.default || ""),
        private: String(m.private || ""),
        group: String(m.group || ""),
        temperature: clampNum(m.temperature, 0, 2, 0.8),
        maxTokens: clampInt(m.maxTokens, 0, 32000, 512),
        timeoutMs: clampInt(m.timeoutMs, 3000, 300000, 60000),
        retries: clampInt(m.retries, 0, 5, 2),
        fallback: m.fallback !== false,
        fallbackChain: Array.isArray(m.fallbackChain) ? m.fallbackChain.map(String) : [],
        // 送给模型的历史预算（token）。超了就从最旧的开始丢，避免 400 context length
        historyTokens: clampInt(m.historyTokens, 0, 32000, 3000)
    };
    cfg.plugins = { disabled: Array.isArray(cfg.plugins?.disabled) ? cfg.plugins.disabled.map(String) : [] };
    const sr = cfg.search || {};
    cfg.search = {
        enabled: sr.enabled !== false,
        provider: ["auto", "bing", "tavily", "serper"].includes(sr.provider) ? sr.provider : "auto",
        apiKey: String(sr.apiKey || ""),
        maxResults: clampInt(sr.maxResults, 1, 8, 5),
        maxRounds: clampInt(sr.maxRounds, 0, 3, 2),
        maxCalls: clampInt(sr.maxCalls, 1, 5, 3)
    };
    cfg.webui = {
        port: clampInt(cfg.webui?.port, 1, 65535, 8787),
        host: String(cfg.webui?.host || "127.0.0.1"),
        token: String(cfg.webui?.token || "")
    };
    return cfg;
}

function clampInt(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
}
function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}
function clampPair(v, min, max, dflt) {
    if (!Array.isArray(v) || v.length !== 2) return dflt.slice();
    return [clampInt(v[0], min, max, dflt[0]), clampInt(v[1], min, max, dflt[1])];
}
function timeStr(v, dflt) {
    return /^\d{1,2}:\d{2}$/.test(String(v || "")) ? String(v) : dflt;
}

class ConfigStore {
    constructor() {
        this.file = FILE;
        this.cfg = null;
        this.listeners = new Set();
        this._savedAt = 0;
        this._watching = false;
    }

    load() {
        let raw = {};
        try {
            raw = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
        } catch (e) {
            if (e.code !== "ENOENT") console.error("[config] 解析失败，用默认配置:", String(e).slice(0, 200));
        }
        const migrated = migrate(raw);
        const merged = merge(DEFAULT_CONFIG, migrated);
        this.cfg = normalize(merged);
        if (Object.keys(raw).length && JSON.stringify(raw) !== JSON.stringify(this.cfg)) {
            // 迁移/补全过一次就落盘，之后文件与内存始终同构
            this._write();
        }
        this._watch();
        return this.cfg;
    }

    get() {
        if (!this.cfg) this.load();
        return this.cfg;
    }

    // 深合并 patch 后写盘；返回新配置
    save(patch) {
        const next = normalize(merge(this.get(), patch || {}));
        this.cfg = next;
        this._write();
        this._emit("save");
        return next;
    }

    on(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    _emit(reason) {
        for (const fn of this.listeners) {
            try {
                fn(this.cfg, reason);
            } catch (e) {
                console.error("[config] listener error:", String(e).slice(0, 200));
            }
        }
    }

    _write() {
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, this.file);
        this._savedAt = Date.now();
    }

    _watch() {
        if (this._watching) return;
        this._watching = true;
        // 手改 config.json 也能热生效；自己写的 800ms 内忽略，避免回环
        fs.watchFile(this.file, { interval: 700 }, (cur, prev) => {
            if (cur.mtimeMs === prev.mtimeMs) return;
            if (Date.now() - this._savedAt < 800) return;
            try {
                const raw = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
                this.cfg = normalize(merge(DEFAULT_CONFIG, migrate(raw)));
                this._emit("external");
            } catch {
                /* 编辑器正在写，下个周期再读 */
            }
        });
    }
}

export const store = new ConfigStore();

export function maskKey(k) {
    if (!k) return "";
    if (k.length <= 8) return "••••";
    return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

// 给前端的安全视图：绝不把完整 apiKey 发到浏览器
export function publicConfig(cfg) {
    const c = JSON.parse(JSON.stringify(cfg));
    c.providers = c.providers.map((p) => {
        const copy = { ...p };
        copy.hasKey = Boolean(p.apiKey);
        copy.apiKeyMasked = maskKey(p.apiKey);
        delete copy.apiKey;
        return copy;
    });
    delete c.webui?.token;
    return c;
}
