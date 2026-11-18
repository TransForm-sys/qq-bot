// 插件内核：扫描 plugins/ 下的 .mjs/.js，动态加载并隔离错误。
// 插件通过导出 setup(ctx) 返回钩子；ctx 提供配置、日志、KV 存储、LLM 调用。
//
// 钩子（全部可选、可 async）：
//   onMessage(evt)            -> false 丢弃 / string 直接回复并跳过 LLM / 其它继续
//   beforeReply({evt,messages}) -> 返回新的 messages（或 {messages}）
//   afterReply({evt,reply})    -> 返回新 reply（或 {text, segments})
//   afterSend({evt,reply})     -> 发送后副作用
//   onStartup()                -> 加载时执行一次
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, store } from "./config.ts";
import { chat as llmChat } from "./llm.ts";
import { runtime } from "./runtime.ts";

const DIR = path.join(ROOT, "plugins");
const KV_DIR = path.join(ROOT, "data", "plugins");
const EXT = [".mjs", ".js", ".ts"];
const MAX_FAILS = 5;

// 插件连续报错会被停用。如果不告警，用户只会发现"某个功能悄悄不见了"（R-76）。
function noteFail(entry, hook, e) {
    entry.failCount += 1;
    entry.error = String(e).slice(0, 300);
    console.error(`[plugin:${entry.name}] ${hook} 出错(${entry.failCount}/${MAX_FAILS}):`, String(e).slice(0, 200));
    if (entry.failCount === MAX_FAILS) {
        runtime.alert("plugin-disabled", "warn", `插件 ${entry.name} 连续报错 ${MAX_FAILS} 次已被自动停用（WebUI 里重载可恢复）`);
    }
}

function ensureDirs() {
    fs.mkdirSync(DIR, { recursive: true });
    fs.mkdirSync(KV_DIR, { recursive: true });
}

function kvFor(name) {
    const file = path.join(KV_DIR, `${name}.json`);
    const read = () => {
        try {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            return {};
        }
    };
    const write = (o) => {
        fs.mkdirSync(KV_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(o, null, 1));
    };
    return {
        get: (k, dflt) => {
            const o = read();
            return k in o ? o[k] : dflt;
        },
        set: (k, v) => {
            const o = read();
            o[k] = v;
            write(o);
            return v;
        },
        del: (k) => {
            const o = read();
            delete o[k];
            write(o);
        },
        all: read
    };
}

class PluginManager {
    constructor() {
        this.entries = new Map();
        this.loadedAt = 0;
    }

    files() {
        ensureDirs();
        return fs
            .readdirSync(DIR)
            .filter((f) => EXT.includes(path.extname(f)))
            .map((f) => ({ name: path.basename(f, path.extname(f)), file: path.join(DIR, f) }));
    }

    async loadAll() {
        ensureDirs();
        const seen = new Set();
        for (const { name, file } of this.files()) {
            seen.add(name);
            await this.loadOne(name, file);
        }
        // 删掉的插件从内存里移除
        for (const key of [...this.entries.keys()]) if (!seen.has(key)) this.entries.delete(key);
        this.loadedAt = Date.now();
        return this.list();
    }

    async loadOne(name, file) {
        const prev = this.entries.get(name);
        try {
            const stat = fs.statSync(file);
            const url = `${pathToFileURL(file).href}?v=${stat.mtimeMs}`;
            const mod = await import(url);
            const ctx = {
                cfg: () => store.get(),
                log: (...a) => console.log(`[plugin:${name}]`, ...a),
                kv: kvFor(name),
                chat: (messages, opts) => llmChat(store.get(), messages, opts),
                dir: ROOT
            };
            const hooks = (typeof mod.setup === "function" ? await mod.setup(ctx) : mod.hooks) || {};
            const meta = mod.meta || {};
            const entry = {
                name,
                file,
                meta: {
                    title: meta.title || name,
                    description: meta.description || "",
                    version: meta.version || "0.0.0",
                    author: meta.author || ""
                },
                hooks,
                error: "",
                failCount: 0, // 新实例重新计数：否则「重载」无法恢复一个被停用的插件
                loadedAt: Date.now()
            };
            this.entries.set(name, entry);
            if (typeof hooks.onStartup === "function") {
                try {
                    await hooks.onStartup();
                } catch (e) {
                    entry.error = String(e).slice(0, 300);
                }
            }
            console.log(`[plugins] loaded ${name}${entry.meta.title !== name ? ` (${entry.meta.title})` : ""}`);
            return entry;
        } catch (e) {
            const entry = {
                name,
                file,
                meta: { title: name, description: prev?.meta?.description || "", version: "?" },
                hooks: {},
                error: String(e).slice(0, 500),
                failCount: (prev?.failCount || 0) + 1,
                loadedAt: Date.now()
            };
            this.entries.set(name, entry);
            console.error(`[plugins] ${name} 加载失败:`, String(e).slice(0, 300));
            return entry;
        }
    }

    isEnabled(name) {
        const cfg = store.get();
        return !(cfg.plugins?.disabled || []).includes(name);
    }

    // 首次调用时自动加载，避免"忘了 loadAll 导致插件静默失效"
    async ensure() {
        if (!this.loadedAt) await this.loadAll();
    }

    list() {
        return [...this.entries.values()]
            .map((e) => ({
                name: e.name,
                title: e.meta.title,
                description: e.meta.description,
                version: e.meta.version,
                author: e.meta.author,
                enabled: this.isEnabled(e.name),
                error: e.error,
                failCount: e.failCount,
                hooks: Object.keys(e.hooks || {}),
                loadedAt: e.loadedAt
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // 依次执行某个钩子。插件抛错只影响它自己。
    async run(hook, payload) {
        await this.ensure();
        const results = [];
        for (const entry of this.entries.values()) {
            if (!this.isEnabled(entry.name)) continue;
            if (entry.failCount >= MAX_FAILS) continue; // 反复报错的插件先停掉，等 WebUI 里 reload
            const fn = entry.hooks?.[hook];
            if (typeof fn !== "function") continue;
            try {
                const out = await fn(payload);
                if (out !== undefined) results.push({ name: entry.name, out });
            } catch (e) {
                noteFail(entry, hook, e);
            }
        }
        return results;
    }

    async messageGate(evt) {
        await this.ensure();
        let direct = null;
        for (const entry of this.entries.values()) {
            if (!this.isEnabled(entry.name)) continue;
            if (entry.failCount >= MAX_FAILS) continue;
            const fn = entry.hooks?.onMessage;
            if (typeof fn !== "function") continue;
            try {
                const out = await fn(evt);
                if (out === false) return { allow: false, direct: null, by: entry.name };
                if (typeof out === "string" && out.trim()) {
                    direct = out.trim();
                    break;
                }
            } catch (e) {
                noteFail(entry, "onMessage", e);
            }
        }
        return { allow: true, direct, by: direct ? "plugin" : "" };
    }

    async beforeReply(payload) {
        await this.ensure();
        let messages = payload.messages;
        for (const entry of this.entries.values()) {
            if (!this.isEnabled(entry.name) || entry.failCount >= MAX_FAILS) continue;
            const fn = entry.hooks?.beforeReply;
            if (typeof fn !== "function") continue;
            try {
                const out = await fn({ ...payload, messages });
                if (Array.isArray(out)) messages = out;
                else if (Array.isArray(out?.messages)) messages = out.messages;
                // 插件把上下文清空会导致模型直接 400，这个会话就永久哑了
                if (!Array.isArray(messages) || messages.length === 0) {
                    messages = payload.messages;
                    noteFail(entry, "beforeReply", new Error("返回了空 messages，已回滚"));
                }
            } catch (e) {
                noteFail(entry, "beforeReply", e);
            }
        }
        return messages;
    }

    async afterReply(payload) {
        await this.ensure();
        let reply = payload.reply;
        let segments = null;
        for (const entry of this.entries.values()) {
            if (!this.isEnabled(entry.name) || entry.failCount >= MAX_FAILS) continue;
            const fn = entry.hooks?.afterReply;
            if (typeof fn !== "function") continue;
            try {
                const out = await fn({ ...payload, reply });
                if (typeof out === "string") reply = out;
                else if (out && typeof out === "object") {
                    if (typeof out.text === "string") reply = out.text;
                    if (Array.isArray(out.segments)) segments = out.segments;
                }
            } catch (e) {
                noteFail(entry, "afterReply", e);
            }
        }
        return { reply, segments };
    }

    async afterSend(payload) {
        await this.run("afterSend", payload);
    }

    source(name) {
        const file = [...EXT.map((e) => path.join(DIR, name + e))].find((f) => fs.existsSync(f));
        if (!file) return null;
        return { name, file: path.basename(file), content: fs.readFileSync(file, "utf8") };
    }

    async saveSource(name, content) {
        ensureDirs();
        if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("插件名只能是字母数字和 _ - .");
        const existing = [...EXT.map((e) => path.join(DIR, name + e))].find((f) => fs.existsSync(f));
        const file = existing || path.join(DIR, name + ".mjs");
        fs.writeFileSync(file, content, "utf8");
        await this.loadOne(name, file);
        return this.list().find((p) => p.name === name);
    }

    async remove(name) {
        const file = [...EXT.map((e) => path.join(DIR, name + e))].find((f) => fs.existsSync(f));
        if (file) fs.unlinkSync(file);
        this.entries.delete(name);
        return this.list();
    }

    async reload() {
        return this.loadAll();
    }
}

export const plugins = new PluginManager();

export const PLUGIN_TEMPLATE = `// 新插件模板。改完保存，WebUI 里点「重载」即可生效。
export const meta = {
    title: "我的插件",
    description: "用一句话说明这个插件做什么",
    version: "1.0.0"
};

export function setup(ctx) {
    return {
        // 返回 false 丢弃这条消息；返回字符串则直接回复（不走大模型）
        async onMessage(evt) {
            return true;
        },
        // 改写喂给大模型的上下文
        async beforeReply({ evt, messages }) {
            return messages;
        },
        // 改写最终回复；也可以返回 { text, segments: ["第一句", "第二句"] }
        async afterReply({ evt, reply }) {
            return reply;
        },
        async afterSend({ evt, reply }) {
            ctx.log("sent:", reply.slice(0, 40));
        }
    };
}
`;
