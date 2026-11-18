// WebUI 后端：零依赖 HTTP 服务。
// 静态托管 webui/ + REST API + SSE（实时日志/状态）。
// 只监听 127.0.0.1；config.webui.token 非空时 /api/* 需要带 token。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, store, publicConfig } from "./config.ts";
import { PRESETS, providerFromPreset, customProvider, presetMeta } from "./providers.ts";
import { chat, listModels, testProvider, getHealth, resolveCandidates } from "./llm.ts";
import { plugins, PLUGIN_TEMPLATE } from "./plugins.ts";
import { runtime, snapshot } from "./runtime.ts";

const WEB_DIR = path.join(ROOT, "webui");
const DATA = path.join(ROOT, "data");
const TOOLS = path.join(ROOT, "tools");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8"
};

let restartReceiverHook = null;

function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body)
    });
    res.end(body);
}

function text(res, code, body, type = "text/plain; charset=utf-8") {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > limit) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error("invalid json"));
            }
        });
        req.on("error", reject);
    });
}

function safeJoin(base, rel) {
    const p = path.normalize(path.join(base, rel));
    if (!p.startsWith(base)) return null;
    return p;
}

function providerById(id) {
    return store.get().providers.find((p) => p.id === id) || null;
}

function ensureProviderApiKey(providerId, incoming) {
    // 前端拿到的是掩码，空/掩码值一律视为"不改"，避免误清空
    const cur = providerById(providerId);
    if (!cur) return incoming;
    const next = { ...incoming };
    if (next.apiKey === undefined || next.apiKey === null || String(next.apiKey).includes("••••")) {
        next.apiKey = cur.apiKey;
    }
    return next;
}

// ---------- 人设文件 ----------
function personaFiles() {
    const out = [];
    const push = (abs, base) => {
        try {
            const st = fs.statSync(abs);
            out.push({ file: base, size: st.size, modified: st.mtimeMs });
        } catch {
            /* ignore */
        }
    };
    for (const f of fs.readdirSync(ROOT)) {
        if (/^persona.*\.md$/i.test(f)) push(path.join(ROOT, f), f);
    }
    const dir = path.join(ROOT, "personas");
    if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) if (/\.md$/i.test(f)) push(path.join(dir, f), `personas/${f}`);
    }
    return out.sort((a, b) => b.modified - a.modified);
}

function personaPath(file) {
    const cfg = store.get();
    const rel = file || cfg.personaFile || "persona.md";
    const abs = safeJoin(ROOT, rel);
    if (!abs || !abs.endsWith(".md")) throw new Error("非法人设路径");
    return { abs, rel };
}

// ---------- 日志 ----------
function readTail(file, lines = 200) {
    try {
        const st = fs.statSync(file);
        const take = Math.min(st.size, 512 * 1024);
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, st.size - take);
        fs.closeSync(fd);
        const rows = buf.toString("utf8").split("\n").filter(Boolean);
        return rows.slice(-lines);
    } catch {
        return [];
    }
}

// ---------- 动作（复用已有 PowerShell 工具） ----------
function runPs(script, args = [], timeoutMs = 120000) {
    return new Promise((resolve) => {
        const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(TOOLS, script), ...args], {
            windowsHide: true
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
            try {
                p.kill();
            } catch {
                /* ignore */
            }
        }, timeoutMs);
        p.stdout.on("data", (c) => (out += c));
        p.stderr.on("data", (c) => (err += c));
        p.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out: out.trim(), err: err.trim() });
        });
        p.on("error", (e) => {
            clearTimeout(timer);
            resolve({ code: -1, out: "", err: String(e) });
        });
    });
}

function startPidScan() {
    if (runtime.pidScan.running) return false;
    runtime.pidScan = { running: true, startedAt: Date.now(), output: "", pid: "" };
    // 绑定改由 recover.ps1 负责（先按"进程树 + 本地账号"确定性判定，扫盐只作兜底）。
    // -NoStartBot：只重绑 + 恢复窗口 + 体检，不在用户点按钮时偷偷起 bot。
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(TOOLS, "recover.ps1"), "-NoStartBot"], {
        windowsHide: true
    });
    const collect = (c) => {
        runtime.pidScan.output = (runtime.pidScan.output + c.toString()).slice(-4000);
    };
    p.stdout.on("data", collect);
    p.stderr.on("data", collect);
    p.on("close", (code) => {
        runtime.pidScan.running = false;
        try {
            runtime.pidScan.pid = fs.readFileSync(path.join(DATA, "bot-pid.txt"), "utf8").trim();
        } catch {
            /* ignore */
        }
        runtime.action("rescan-pid", code === 0, `pid=${runtime.pidScan.pid} exit=${code}`);
    });
    runtime.action("rescan-pid", true, "已启动扫描");
    return true;
}

// ---------- SSE ----------
const clients = new Set();
let logOffset = 0;

function sseSend(res, obj) {
    try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
        clients.delete(res);
    }
}

function broadcast(obj) {
    for (const res of clients) sseSend(res, obj);
}

function statePayload() {
    const cfg = store.get();
    return {
        bot: snapshot(),
        config: publicConfig(cfg),
        health: getHealth(),
        plugins: plugins.list(),
        personas: personaFiles().map((p) => ({ ...p, active: p.file === cfg.personaFile })),
        candidates: resolveCandidates(cfg, {}).map((c) => `${c.provider.id}/${c.model}`),
        providersConfigured: cfg.providers.filter((p) => p.enabled && (p.apiKey || p.baseURL.includes("127.0.0.1"))).length
    };
}

setInterval(() => {
    if (!clients.size) return;
    const file = path.join(DATA, "bot.jsonl");
    try {
        const st = fs.statSync(file);
        if (st.size < logOffset) logOffset = 0;
        if (st.size > logOffset) {
            const len = Math.min(st.size - logOffset, 256 * 1024);
            const fd = fs.openSync(file, "r");
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, logOffset);
            fs.closeSync(fd);
            logOffset = st.size;
            const chunk = buf.toString("utf8");
            if (chunk.trim()) broadcast({ type: "log", chunk });
        }
    } catch {
        /* 文件还没创建 */
    }
    broadcast({ type: "state", state: statePayload() });
}, 2000).unref?.();

// ---------- 路由 ----------
async function handleApi(req, res, url) {
    const cfg = store.get();
    const method = req.method || "GET";
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const q = url.searchParams;

    // --- state ---
    if (parts[0] === "state" && method === "GET") return json(res, 200, statePayload());
    if (parts[0] === "presets" && method === "GET") {
        return json(
            res,
            200,
            PRESETS.map((p) => ({
                id: p.id,
                name: p.name,
                short: p.short,
                kind: p.kind,
                baseURL: p.baseURL,
                models: p.models,
                region: p.region,
                docs: p.docs,
                note: p.note,
                needsKey: p.needsKey !== false,
                configured: cfg.providers.some((x) => x.id === p.id)
            }))
        );
    }

    // --- config ---
    if (parts[0] === "config" && method === "PUT") {
        const patch = await readBody(req);
        if (patch.providers) {
            patch.providers = patch.providers.map((p) => ensureProviderApiKey(p.id, p));
        }
        const next = store.save(patch);
        runtime.action("save-config", true, Object.keys(patch).join(","));
        return json(res, 200, { ok: true, config: publicConfig(next) });
    }

    // --- providers ---
    if (parts[0] === "providers") {
        const id = parts[1];
        if (!id && method === "POST") {
            const body = await readBody(req);
            const max = Math.max(0, ...cfg.providers.map((p) => p.priority));
            let provider;
            if (body.presetId) {
                if (cfg.providers.some((p) => p.id === body.presetId)) return json(res, 409, { error: "该厂商已添加" });
                provider = providerFromPreset(body.presetId, body.apiKey || "");
            } else {
                provider = customProvider(body);
            }
            if (!provider) return json(res, 400, { error: "未知厂商" });
            provider.priority = max + 1;
            store.save({ providers: [...cfg.providers, provider] });
            return json(res, 200, { ok: true, provider: { id: provider.id } });
        }
        if (id && method === "PATCH") {
            const body = await readBody(req);
            const cur = providerById(id);
            if (!cur) return json(res, 404, { error: "厂商不存在" });
            const merged = { ...cur, ...ensureProviderApiKey(id, body) };
            const next = cfg.providers.map((p) => (p.id === id ? merged : p));
            store.save({ providers: next });
            return json(res, 200, { ok: true });
        }
        if (id && method === "DELETE") {
            if (!providerById(id)) return json(res, 404, { error: "厂商不存在" });
            const next = cfg.providers.filter((p) => p.id !== id);
            const models = { ...cfg.models };
            for (const k of ["default", "private", "group"]) {
                if (models[k] && models[k].startsWith(`${id}/`)) models[k] = "";
            }
            models.fallbackChain = (models.fallbackChain || []).filter((r) => !r.startsWith(`${id}/`));
            store.save({ providers: next, models });
            return json(res, 200, { ok: true });
        }
        if (id && parts[2] === "models" && method === "GET") {
            const p = providerById(id);
            if (!p) return json(res, 404, { error: "厂商不存在" });
            try {
                const models = await listModels(p);
                if (q.get("save") === "1") {
                    const trimmed = models.slice(0, 60);
                    const next = cfg.providers.map((x) => (x.id === id ? { ...x, models: trimmed } : x));
                    store.save({ providers: next });
                }
                return json(res, 200, { ok: true, models, count: models.length });
            } catch (e) {
                return json(res, 200, { ok: false, error: String(e).slice(0, 300), models: p.models });
            }
        }
        if (id && parts[2] === "test" && method === "POST") {
            const p = providerById(id);
            if (!p) return json(res, 404, { error: "厂商不存在" });
            const body = await readBody(req);
            const r = await testProvider(p, body.model);
            return json(res, 200, r);
        }
    }

    // --- 测试对话 ---
    if (parts[0] === "chat-test" && method === "POST") {
        const body = await readBody(req);
        const msgs = Array.isArray(body.messages) && body.messages.length
            ? body.messages
            : [{ role: "system", content: "你是一个测试助手。" }, { role: "user", content: body.text || "你好" }];
        try {
            const r = await chat(cfg, msgs, {
                model: body.model || undefined,
                scope: body.scope || undefined,
                temperature: body.temperature,
                maxTokens: body.maxTokens
            });
            return json(res, 200, { ok: true, ...r });
        } catch (e) {
            return json(res, 200, { ok: false, error: String(e).slice(0, 600), attempts: e.attempts || [] });
        }
    }

    // --- 人设 ---
    if (parts[0] === "personas" && method === "GET") {
        return json(res, 200, { files: personaFiles().map((p) => ({ ...p, active: p.file === cfg.personaFile })) });
    }
    if (parts[0] === "persona") {
        if (method === "GET") {
            const { abs, rel } = personaPath(q.get("file"));
            try {
                return json(res, 200, { file: rel, content: fs.readFileSync(abs, "utf8") });
            } catch {
                return json(res, 404, { error: "文件不存在" });
            }
        }
        if (method === "PUT") {
            const body = await readBody(req);
            const { abs, rel } = personaPath(body.file);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, String(body.content ?? ""), "utf8");
            if (body.activate) store.save({ personaFile: rel });
            runtime.action("save-persona", true, rel);
            return json(res, 200, { ok: true, file: rel });
        }
        if (method === "POST") {
            const body = await readBody(req);
            const name = String(body.name || "persona-new").replace(/[^\w\u4e00-\u9fa5.-]/g, "");
            const rel = `personas/${name || "persona-new"}.md`;
            const abs = safeJoin(ROOT, rel);
            if (fs.existsSync(abs)) return json(res, 409, { error: "同名文件已存在" });
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, String(body.content || "# 人设\n\n你是……\n"), "utf8");
            if (body.activate) store.save({ personaFile: rel });
            return json(res, 200, { ok: true, file: rel });
        }
        if (method === "DELETE") {
            const { abs, rel } = personaPath(q.get("file"));
            if (rel === cfg.personaFile) return json(res, 400, { error: "不能删除当前启用的人设" });
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
            return json(res, 200, { ok: true });
        }
    }

    // --- 插件 ---
    if (parts[0] === "plugins") {
        if (!parts[1] && method === "GET") return json(res, 200, { plugins: plugins.list(), template: PLUGIN_TEMPLATE });
        if (parts[1] === "reload" && method === "POST") {
            const list = await plugins.reload();
            return json(res, 200, { ok: true, plugins: list });
        }
        if (parts[1] === "template" && method === "GET") return json(res, 200, { template: PLUGIN_TEMPLATE });
        const name = parts[1];
        if (name && method === "GET" && parts[2] === "source") {
            const src = plugins.source(name);
            if (!src) return json(res, 404, { error: "插件不存在" });
            return json(res, 200, src);
        }
        if (name && method === "PUT" && parts[2] === "source") {
            const body = await readBody(req);
            try {
                const meta = await plugins.saveSource(name, String(body.content ?? ""));
                return json(res, 200, { ok: true, plugin: meta });
            } catch (e) {
                return json(res, 400, { error: String(e).slice(0, 300) });
            }
        }
        if (name && parts[2] === "toggle" && method === "POST") {
            const body = await readBody(req);
            const disabled = new Set(cfg.plugins.disabled || []);
            if (body.enabled) disabled.delete(name);
            else disabled.add(name);
            store.save({ plugins: { disabled: [...disabled] } });
            return json(res, 200, { ok: true, plugins: plugins.list() });
        }
        if (name && method === "POST" && parts[2] === "create") {
            const list = await plugins.saveSource(name, PLUGIN_TEMPLATE);
            return json(res, 200, { ok: true, plugin: list.find((p) => p.name === name) });
        }
        if (name && method === "DELETE") {
            const list = await plugins.remove(name);
            return json(res, 200, { ok: true, plugins: list });
        }
    }

    // --- 告警 ---
    if (parts[0] === "alerts" && method === "GET") {
        return json(res, 200, { alerts: runtime.alerts });
    }
    if (parts[0] === "alerts" && method === "DELETE") {
        const code = q.get("code");
        if (code) runtime.clearAlert(code);
        else runtime.clearAlerts();
        return json(res, 200, { ok: true, alerts: runtime.alerts });
    }

    // --- 日志 ---
    if (parts[0] === "logs" && method === "GET") {
        const lines = Math.min(2000, Math.max(20, Number(q.get("lines") || 200)));
        const kind = q.get("kind") || "";
        const rows = readTail(path.join(DATA, "bot.jsonl"), 4000)
            .map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return { raw: l };
                }
            })
            .filter((r) => !kind || r.dir === kind)
            .slice(-lines);
        return json(res, 200, { rows });
    }
    if (parts[0] === "logs" && method === "DELETE") {
        const file = path.join(DATA, "bot.jsonl");
        try {
            fs.truncateSync(file, 0);
            logOffset = 0;
        } catch {
            /* ignore */
        }
        return json(res, 200, { ok: true });
    }

    // --- 会话记忆 ---
    if (parts[0] === "sessions") {
        const dir = path.join(DATA, "sessions");
        if (!parts[1] && method === "GET") {
            let files = [];
            try {
                files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
            } catch {
                files = [];
            }
            const rows = files.map((f) => {
                let items = [];
                try {
                    items = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                } catch {
                    /* ignore */
                }
                const last = items[items.length - 1];
                return {
                    key: f.replace(/\.json$/, ""),
                    count: items.length,
                    updated: fs.statSync(path.join(dir, f)).mtimeMs,
                    preview: last ? String(last.content).slice(0, 60) : ""
                };
            });
            return json(res, 200, { sessions: rows.sort((a, b) => b.updated - a.updated) });
        }
        const key = parts[1];
        const file = path.join(dir, `${key.replace(/[^\w.-]/g, "_")}.json`);
        if (method === "GET") {
            try {
                return json(res, 200, { key, items: JSON.parse(fs.readFileSync(file, "utf8")) });
            } catch {
                return json(res, 404, { error: "会话不存在" });
            }
        }
        if (method === "DELETE") {
            try {
                fs.unlinkSync(file);
            } catch {
                /* ignore */
            }
            return json(res, 200, { ok: true });
        }
    }

    // --- 动作 ---
    if (parts[0] === "actions" && method === "POST") {
        const name = parts[1];
        if (name === "rescan-pid") {
            const started = startPidScan();
            return json(res, 200, { ok: true, started });
        }
        if (name === "restore-window") {
            const r = await runPs("ui-restore.ps1", ["-Yes"], 60000);
            runtime.action("restore-window", r.code === 0, r.out || r.err);
            return json(res, 200, { ok: r.code === 0, output: r.out || r.err });
        }
        if (name === "doctor") {
            const r = await runPs("doctor.ps1", [], 120000);
            runtime.action("doctor", r.code === 0, `exit=${r.code}`);
            return json(res, 200, { ok: r.code === 0, exit: r.code, output: r.out || r.err });
        }
        if (name === "windows") {
            const r = await runPs("ui-windows.ps1", [], 30000);
            return json(res, 200, { ok: r.code === 0, output: r.out || r.err });
        }
        if (name === "restart-receiver") {
            if (restartReceiverHook) {
                const r = await restartReceiverHook();
                runtime.action("restart-receiver", true, JSON.stringify(r));
                return json(res, 200, { ok: true, ...r });
            }
            return json(res, 400, { error: "当前进程未接入接收器" });
        }
        return json(res, 404, { error: "未知动作" });
    }

    return json(res, 404, { error: `no route: ${method} ${url.pathname}` });
}

function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const abs = safeJoin(WEB_DIR, rel);
    if (!abs) return text(res, 403, "forbidden");
    fs.readFile(abs, (err, data) => {
        if (err) {
            // 单页应用回退
            if (!path.extname(rel)) return serveStatic(req, res, new URL("/index.html", "http://x"));
            return text(res, 404, "not found");
        }
        res.writeHead(200, {
            "content-type": MIME[path.extname(abs)] || "application/octet-stream",
            "cache-control": "no-cache",
            "content-length": data.length
        });
        res.end(data);
    });
}

export function startWebui({ onRestartReceiver } = {}) {
    restartReceiverHook = onRestartReceiver || null;
    const cfg = store.get();
    const port = cfg.webui?.port || 8787;
    const host = cfg.webui?.host || "127.0.0.1";
    const token = cfg.webui?.token || "";

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
        try {
            if (url.pathname.startsWith("/api/")) {
                if (token) {
                    const got = req.headers["x-token"] || url.searchParams.get("token");
                    if (got !== token) return json(res, 401, { error: "需要访问令牌", needToken: true });
                }
                if (url.pathname === "/api/stream") {
                    res.writeHead(200, {
                        "content-type": "text/event-stream",
                        "cache-control": "no-cache",
                        connection: "keep-alive",
                        "x-accel-buffering": "no"
                    });
                    res.write(": connected\n\n");
                    clients.add(res);
                    // 首屏补一段历史日志
                    const rows = readTail(path.join(DATA, "bot.jsonl"), 60);
                    if (rows.length) sseSend(res, { type: "log", chunk: rows.join("\n") + "\n" });
                    sseSend(res, { type: "state", state: statePayload() });
                    req.on("close", () => clients.delete(res));
                    return;
                }
                await handleApi(req, res, url);
                return;
            }
            serveStatic(req, res, url);
        } catch (e) {
            console.error("[webui]", String(e).slice(0, 300));
            if (!res.headersSent) json(res, 500, { error: String(e).slice(0, 300) });
            else res.end();
        }
    });

    server.on("error", (e) => {
        if (e.code === "EADDRINUSE") console.error(`[webui] 端口 ${port} 已被占用，控制台未启动`);
        else console.error("[webui] server error:", String(e).slice(0, 200));
    });

    server.listen(port, host, () => {
        console.log(`[webui] http://${host}:${port}`);
    });
    return server;
}

const isMain = process.argv[1] ? /webui\.ts$/.test(process.argv[1]) : false;
if (isMain) {
    store.load();
    await plugins.loadAll();
    startWebui({});
    console.log("[webui] standalone 模式（只读配置与插件，不接收/发送消息）");
}
