// 多厂商模型路由。
// - provider/model 引用解析（支持 model 名里带斜杠，如 openrouter/anthropic/claude-...）
// - 三种协议适配：openai 兼容 / anthropic 原生 / azure openai
// - 按优先级故障转移（fallback chain）、每厂商 RPM 限速、熔断与健康度
// - 网络错误 & 429 & 5xx 退避重试；4xx 直接换下一个厂商
import { findPreset } from "./providers.ts";
import { runtime } from "./runtime.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 断网快速失败：所有通道都因网络失败后，进入一小段冷却。
// 没有冷却时，串行队列里每条消息都要重跑"60s 超时 ×3 次重试"，
// 用户连发 5 条就是十几分钟的积压；冷却期内直接失败，积压瞬时排空。
// 冷却结束后的第一条消息会自动充当探针，网络一恢复就能立刻回到正常。
const OFFLINE_COOLDOWN_MS = 15000;
let offlineUntil = 0;

export function offlineState() {
    return { offline: Date.now() < offlineUntil, until: offlineUntil };
}

// 网络类错误：没有 HTTP 状态码（有状态码说明网络是通的），且错误链里出现典型网络关键字。
// fetch 失败时真正的原因在 e.cause 里（getaddrinfo ENOTFOUND / ECONNREFUSED…），
// 只看 e.message 会漏掉。
const NET_RE =
    /fetch failed|enotfound|eai_again|econnrefused|econnreset|etimedout|und_err|socket hang up|network|terminated|aborted/i;

export function isNetworkError(e) {
    if (!e) return false;
    if (Number(e.status) > 0) return false;
    const chain = [e.message, e.code, e.cause?.message, e.cause?.code, String(e)].filter(Boolean).join(" ");
    return NET_RE.test(chain);
}

// 把 provider 的错误分成"需要人去处理"的几类，让 WebUI 能说出人话，
// 而不是每条消息都静默丢掉（R-111）。
export function classifyError(e) {
    if (e?.offline) return { code: "llm-offline", level: "warn", text: "网络不可达（离线冷却中）" };
    const status = Number(e?.status || 0);
    const body = String(e?.body || e?.message || "").toLowerCase();
    if (status === 401 || status === 403) return { code: "llm-auth", level: "error", text: "API Key 无效或无权限" };
    if (status === 402) return { code: "llm-quota", level: "error", text: "账户欠费/额度耗尽" };
    if (status === 429) {
        if (/quota|insufficient|balance|exceeded/.test(body)) return { code: "llm-quota", level: "error", text: "额度已用尽（429）" };
        return { code: "llm-ratelimit", level: "warn", text: "触发厂商限流（429）" };
    }
    if (status === 404) return { code: "llm-model", level: "error", text: "模型或接口不存在（检查模型名/baseURL）" };
    if (/context length|maximum context|too long|token limit|exceeds the max/i.test(body)) {
        return { code: "llm-context", level: "warn", text: "上下文超长" };
    }
    if (isNetworkError(e)) {
        return { code: "llm-network", level: "warn", text: "网络不可达" };
    }
    return { code: "llm-error", level: "warn", text: String(e).slice(0, 120) };
}

// providerId -> { ok, latencyMs, at, error, fails, lastFail, total, errors }
const health = new Map();
// providerId -> number[]（最近 60s 的调用时间戳，用于 RPM）
const usage = new Map();
// providerId -> { models: string[], at: number }
const modelCache = new Map();

export function getHealth() {
    return [...health.entries()].map(([id, h]) => ({ id, ...h }));
}

export function resetHealth() {
    health.clear();
}

function markOk(id, latencyMs) {
    const h = health.get(id) || { fails: 0, total: 0, errors: 0 };
    health.set(id, { ...h, ok: true, latencyMs, at: Date.now(), error: "", fails: 0, total: (h.total || 0) + 1 });
}

function markFail(id, error) {
    const h = health.get(id) || { total: 0, errors: 0 };
    health.set(id, {
        ...h,
        ok: false,
        at: Date.now(),
        error: String(error).slice(0, 300),
        fails: (h.fails || 0) + 1,
        lastFail: Date.now(),
        total: (h.total || 0) + 1,
        errors: (h.errors || 0) + 1
    });
}

function circuitOpen(id) {
    const h = health.get(id);
    return Boolean(h && h.fails >= 3 && Date.now() - (h.lastFail || 0) < 60000);
}

function rpmExceeded(provider) {
    if (!provider.rpm) return false;
    const now = Date.now();
    const arr = (usage.get(provider.id) || []).filter((t) => now - t < 60000);
    usage.set(provider.id, arr);
    return arr.length >= provider.rpm;
}

function noteUsage(id) {
    const arr = usage.get(id) || [];
    arr.push(Date.now());
    usage.set(id, arr);
}

// "providerId/model" 或裸模型名 -> { provider, model }
export function resolveRef(cfg, ref) {
    const providers = cfg.providers || [];
    if (!ref) return null;
    const s = String(ref);

    // 1) 精确命中某个 provider 的 models 列表（优先 enabled、priority 小的）
    const exact = providers
        .filter((p) => p.models.includes(s))
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.priority - b.priority);
    if (exact.length) return { provider: exact[0], model: s };

    // 2) providerId/ 前缀
    const slash = s.indexOf("/");
    if (slash > 0) {
        const pid = s.slice(0, slash);
        const provider = providers.find((p) => p.id === pid);
        if (provider) return { provider, model: s.slice(slash + 1) };
    }

    // 3) 兜底：挂在第一个可用厂商上
    const first = providers.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)[0];
    return first ? { provider: first, model: s } : null;
}

// 主模型 + fallback 链（去重、跳过未启用）
export function resolveCandidates(cfg, opts = {}) {
    const m = cfg.models || {};
    const primary = opts.model || (opts.scope && m[opts.scope]) || m.default || "";
    const refs = [];
    if (primary) refs.push(primary);
    if (m.fallback !== false) {
        for (const r of m.fallbackChain || []) if (r && !refs.includes(r)) refs.push(r);
    }
    const out = [];
    for (const ref of refs) {
        const hit = resolveRef(cfg, ref);
        if (!hit || !hit.provider) continue;
        if (!hit.provider.enabled) continue;
        if (out.some((x) => x.provider.id === hit.provider.id && x.model === hit.model)) continue;
        out.push(hit);
    }
    return out;
}

function authHeaders(provider) {
    const h = { "content-type": "application/json" };
    if (provider.kind === "anthropic") {
        if (provider.apiKey) h["x-api-key"] = provider.apiKey;
        h["anthropic-version"] = "2023-06-01";
    } else if (provider.kind === "azure") {
        if (provider.apiKey) h["api-key"] = provider.apiKey;
    } else if (provider.apiKey) {
        h.authorization = `Bearer ${provider.apiKey}`;
    }
    return h;
}

function endpoint(provider, op) {
    const base = String(provider.baseURL || "").replace(/\/+$/, "");
    if (provider.kind === "anthropic") return `${base}/v1/messages`;
    if (provider.kind === "azure") {
        return `${base}/openai/deployments/${encodeURIComponent(op.model)}/chat/completions?api-version=${encodeURIComponent(provider.apiVersion || "2024-10-21")}`;
    }
    return `${base}/chat/completions`;
}

function buildBody(provider, model, messages, opts) {
    const temperature = Number(opts.temperature ?? 0.8);
    const maxTokens = Number(opts.maxTokens || 0);
    if (provider.kind === "anthropic") {
        const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
        const rest = messages.filter((m) => m.role !== "system");
        const body = { model, messages: rest, max_tokens: maxTokens || 1024, temperature };
        if (sys) body.system = sys;
        return body;
    }
    const body = { model, messages, temperature, stream: false };
    if (maxTokens > 0) body.max_tokens = maxTokens;
    // 工具调用（OpenAI 兼容格式）。只有 openai/azure 通道能用，anthropic 的 schema 不同，
    // 上层会在 chat() 里按 provider.kind 过滤掉。
    if (opts.tools?.length) {
        body.tools = opts.tools;
        body.tool_choice = opts.toolChoice || "auto";
    }
    return body;
}

function pickText(j) {
    const c = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text || "")).join("");
    if (Array.isArray(j?.content)) return j.content.map((x) => (typeof x === "string" ? x : x?.text || "")).join("");
    if (typeof j?.output_text === "string") return j.output_text;
    return "";
}

async function postMessage(provider, model, messages, opts) {
    const url = endpoint(provider, { model });
    const body = buildBody(provider, model, messages, opts);
    const timeout = Number(opts.timeoutMs || 60000);
    const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(provider),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
    });
    if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        const err = new Error(`http ${res.status}: ${text}`);
        err.status = res.status;
        err.body = text;
        throw err;
    }
    const j = await res.json();
    return { json: j, message: j?.choices?.[0]?.message || {}, text: pickText(j).trim() };
}

async function post(provider, model, messages, opts) {
    const r = await postMessage(provider, model, messages, opts);
    if (r.text) return r.text;
    // 推理模型有时只给 reasoning_content，尽量捞回来
    const alt = r.message?.reasoning_content;
    if (alt) return String(alt).trim();
    throw new Error("empty response");
}

// 带工具的对话：模型可以要求调用 web_search / open_url，我们执行后把结果回填，
// 再让它基于结果作答。
//
// 三道刹车（不设的话模型会一直查下去，一条消息拖 2 分钟）：
//   * maxToolRounds：最多几轮 tool_calls 往返
//   * maxToolCalls：整条消息最多几次工具调用
//   * 预算用完就撤掉 tools，逼它拿现有信息作答
async function converse(provider, model, messages, opts) {
    const maxRounds = Math.max(0, Number(opts.maxToolRounds ?? 2));
    const maxCalls = Math.max(1, Number(opts.maxToolCalls ?? 3));
    let msgs = messages;
    let used = 0;

    const finish = (r) => {
        if (r.text) return { text: r.text, toolCalls: used };
        const alt = r.message?.reasoning_content;
        if (alt) return { text: String(alt).trim(), toolCalls: used };
        return null;
    };

    for (let round = 0; round <= maxRounds; round++) {
        const withTools = opts.tools?.length && used < maxCalls;
        const r = await postMessage(provider, model, msgs, withTools ? opts : { ...opts, tools: null });
        const tc = r.message?.tool_calls;
        if (!withTools || !Array.isArray(tc) || !tc.length) {
            const done = finish(r);
            if (done) return done;
            throw new Error("empty response");
        }
        // 关键：assistant.tool_calls 里的每一个 id 都必须有一条对应的 tool 消息，
        // 否则下一轮请求会被服务端判 400（"insufficient tool messages"）。
        // 所以先决定"这一轮到底答哪几个"，再一次性把 assistant + tool 追加进去。
        const answered = [];
        const toolMsgs = [];
        for (const c of tc) {
            if (used >= maxCalls) break;
            used++;
            const name = c?.function?.name || "";
            let args = {};
            try {
                args = JSON.parse(c?.function?.arguments || "{}");
            } catch {
                args = {};
            }
            let out;
            try {
                out = await opts.executeTool?.(name, args);
            } catch (e) {
                out = JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 200) });
            }
            if (typeof out !== "string") out = JSON.stringify(out ?? {});
            answered.push(c);
            toolMsgs.push({ role: "tool", tool_call_id: c.id, content: out.slice(0, 8000) });
        }
        if (!answered.length) break; // 预算用完：下一轮不带工具，让它直接作答
        const asst = { role: "assistant", content: r.message.content || "", tool_calls: answered };
        // DeepSeek 的思考模式要求把 reasoning_content 原样回传，
        // 否则下一轮会直接 400（"reasoning_content must be passed back"）。
        if (r.message.reasoning_content) asst.reasoning_content = r.message.reasoning_content;
        msgs = [...msgs, asst, ...toolMsgs];
    }
    const last = await postMessage(provider, model, msgs, { ...opts, tools: null });
    const done = finish(last);
    if (done) return done;
    throw new Error("empty response");
}

// 某些模型（o1/o3、部分推理模型）不接受 temperature / max_tokens：识别后去掉重试一次
function paramIssue(err) {
    const b = String(err?.body || err?.message || "").toLowerCase();
    if (err?.status !== 400) return null;
    if (b.includes("temperature")) return "temperature";
    if (b.includes("max_tokens") || b.includes("max_completion_tokens")) return "max_tokens";
    return null;
}

async function callWithRetry(provider, model, messages, opts) {
    const retries = Math.max(0, Number(opts.retries ?? 2));
    let lastErr;
    let networkFail = false;
    // 带工具时走 converse（多轮往返），不带工具就是单次补全
    const runOnce = async (o) => {
        if (o.tools?.length) {
            const r = await converse(provider, model, messages, o);
            return { text: r.text, toolCalls: r.toolCalls };
        }
        return { text: await post(provider, model, messages, o), toolCalls: 0 };
    };
    for (let i = 0; i <= retries; i++) {
        try {
            const t0 = Date.now();
            // 上一轮是网络错误 -> 后续尝试把超时压到 20s。
            // 断网/黑洞连接会一路挂到 60s，三次就是 3 分钟，串行队列会被一条消息堵死；
            // 而真正需要 60s 的情况（长上下文生成）第一次尝试已经用满了。
            const attemptOpts = networkFail
                ? { ...opts, timeoutMs: Math.min(Number(opts.timeoutMs || 60000), 20000) }
                : opts;
            const r = await runOnce(attemptOpts);
            return { text: r.text, ms: Date.now() - t0, toolCalls: r.toolCalls };
        } catch (e) {
            lastErr = e;
            networkFail = isNetworkError(e);
            const issue = paramIssue(e);
            if (issue) {
                // 去掉不被支持的参数重试一次（o1/o3 之类），仍失败就交给上层换厂商
                const retryOpts = { ...opts };
                if (issue === "temperature") retryOpts.temperature = 1;
                if (issue === "max_tokens") retryOpts.maxTokens = 0;
                try {
                    const t0 = Date.now();
                    const r = await runOnce(retryOpts);
                    return { text: r.text, ms: Date.now() - t0, toolCalls: r.toolCalls };
                } catch (e2) {
                    lastErr = e2;
                }
            }
            if (!retriable(e) || i === retries) break;
            // 网络类错误退避短一些：断网 800ms 后重试没有意义，快速失败交给冷却
            const wait = networkFail ? 300 : 800 * 2 ** i;
            console.log(`[llm] ${provider.id}/${model} 失败: ${String(e).slice(0, 90)} -> ${wait}ms 后重试`);
            await sleep(wait);
        }
    }
    throw lastErr;
}

function retriable(e) {
    if (e?.status === 429 || (e?.status >= 500 && e?.status < 600)) return true;
    return isNetworkError(e);
}

// 主入口：按候选链依次尝试，成功即返回。
// returns { text, providerId, model, ms, tries: [...] }
export async function chat(cfg, messages, opts = {}) {
    const m = cfg.models || {};
    const candidates = resolveCandidates(cfg, opts);
    if (!candidates.length) {
        throw new Error(
            cfg.providers?.length
                ? "没有可用的模型：请检查 providers 是否启用、models.default 是否指向存在的模型"
                : "还没有配置任何模型厂商，请打开 WebUI 添加"
        );
    }
    const attempts = [];
    let lastErr;

    // 离线冷却中：不再为每条消息重跑满额重试，直接失败。
    // 这样断网期间队列不会堆积，也不会让每条消息都往 alerts 里刷一条。
    if (Date.now() < offlineUntil) {
        const err = new Error(
            `网络不可达（离线冷却中，${Math.ceil((offlineUntil - Date.now()) / 1000)}s 后自动重探）`
        );
        err.code = "llm-offline";
        err.offline = true;
        throw err;
    }

    const ordered = [
        ...candidates.filter((c) => !circuitOpen(c.provider.id)),
        ...candidates.filter((c) => circuitOpen(c.provider.id)) // 全熔断时仍然兜底试一次
    ];

    for (const c of ordered) {
        if (!c.provider.baseURL) {
            attempts.push({ providerId: c.provider.id, model: c.model, error: "baseURL 为空" });
            continue;
        }
        if (c.provider.kind !== "openai" && c.provider.kind !== "azure" && c.provider.kind !== "anthropic") {
            attempts.push({ providerId: c.provider.id, model: c.model, error: "未知协议" });
            continue;
        }
        if (rpmExceeded(c.provider)) {
            attempts.push({ providerId: c.provider.id, model: c.model, error: `超过 RPM 上限 ${c.provider.rpm}` });
            continue;
        }
        noteUsage(c.provider.id);
        try {
            // anthropic 的工具 schema 与 OpenAI 不同，这里只对 openai/azure 放开
            const tools =
                opts.tools?.length && (c.provider.kind === "openai" || c.provider.kind === "azure")
                    ? opts.tools
                    : null;
            const r = await callWithRetry(c.provider, c.model, messages, {
                temperature: opts.temperature ?? m.temperature,
                maxTokens: opts.maxTokens ?? m.maxTokens,
                timeoutMs: opts.timeoutMs ?? m.timeoutMs,
                retries: opts.retries ?? m.retries,
                tools,
                toolChoice: opts.toolChoice,
                maxToolRounds: opts.maxToolRounds,
                maxToolCalls: opts.maxToolCalls,
                executeTool: opts.executeTool
            });
            markOk(c.provider.id, r.ms);
            offlineUntil = 0; // 通了就立刻解除冷却
            // 通道恢复：把之前的红字清掉，避免横幅一直挂着
            clearLlmAlerts();
            const tries = attempts.map((a) => ({ ...a, skipped: true }));
            const toolNote = r.toolCalls ? ` tools=${r.toolCalls}` : "";
            console.log(`[llm] ${c.provider.id}/${c.model} ok ${r.ms}ms${toolNote}`);
            return { text: r.text, providerId: c.provider.id, model: c.model, ms: r.ms, tries, toolCalls: r.toolCalls || 0 };
        } catch (e) {
            lastErr = e;
            markFail(c.provider.id, e);
            const cls = classifyError(e);
            attempts.push({ providerId: c.provider.id, model: c.model, error: String(e).slice(0, 200), code: cls.code });
            runtime.alert(cls.code, cls.level, `${c.provider.id}: ${cls.text}`);
            console.log(`[llm] ${c.provider.id}/${c.model} 放弃(${cls.code}): ${String(e).slice(0, 120)}`);
        }
    }
    const detail = attempts.map((a) => `${a.providerId}/${a.model}: ${a.error}`).join(" | ");
    const err = new Error(`所有模型通道均失败 -> ${detail}`);
    err.attempts = attempts;
    err.cause = lastErr;
    // 全部通道都是"网络不可达" -> 断网，不是配置问题。进入冷却：
    // 后续消息在 15s 内直接快速失败，不再各花 1~3 分钟拖住串行队列。
    const allNetwork = attempts.length > 0 && attempts.every((a) => a.code === "llm-network");
    if (allNetwork) {
        offlineUntil = Date.now() + OFFLINE_COOLDOWN_MS;
        err.offline = true;
        err.code = "llm-network";
    }
    // 全通道失败意味着"这条消息不会得到任何回复"，必须让人看见（R-111）
    runtime.alert("llm-all-failed", "error", `所有模型通道均失败：${detail.slice(0, 200)}`);
    throw err;
}

// ---------- WebUI 用的运营接口 ----------

function modelsEndpoint(provider) {
    const base = String(provider.baseURL || "").replace(/\/+$/, "");
    if (provider.kind === "anthropic") return `${base}/v1/models`;
    if (provider.kind === "azure") return null;
    return `${base}/models`;
}

export async function listModels(provider, timeoutMs = 15000) {
    const cached = modelCache.get(provider.id);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.models;
    const url = modelsEndpoint(provider);
    if (!url) return provider.models;
    const res = await fetch(url, { headers: authHeaders(provider), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const arr = j?.data || j?.models || [];
    const models = arr
        .map((x) => (typeof x === "string" ? x : x.id || x.name))
        .filter(Boolean)
        .sort();
    // 能拉到模型列表 = Key 有效，顺手把 auth 红字清掉
    if (models.length) {
        modelCache.set(provider.id, { models, at: Date.now() });
        offlineUntil = 0; // 能拉到模型列表 = 网络可用
        clearLlmAlerts();
    }
    return models.length ? models : provider.models;
}

// 通道恢复：把之前的红字清掉，避免横幅一直挂着。
// 连通性测试 / 拉模型 成功同样证明 Key 有效，必须一起销账 ——
// 否则用户填好 Key、测试已经"通了"，概览页还挂着 401 的红字。
function clearLlmAlerts() {
    for (const code of ["llm-auth", "llm-quota", "llm-ratelimit", "llm-network", "llm-all-failed"]) {
        runtime.clearAlert(code);
    }
}

export async function testProvider(provider, model, timeoutMs = 20000) {
    const t0 = Date.now();
    try {
        const text = await post(
            provider,
            model || provider.models?.[0] || "",
            [
                { role: "system", content: "你是一个连通性测试。" },
                { role: "user", content: "只回复两个字：通了" }
            ],
            { temperature: 0, maxTokens: 64, timeoutMs }
        );
        markOk(provider.id, Date.now() - t0);
        offlineUntil = 0; // 连通性测试通过 = 网络可用，解除离线冷却
        clearLlmAlerts();
        return { ok: true, ms: Date.now() - t0, text: text.slice(0, 80), model: model || provider.models?.[0] };
    } catch (e) {
        markFail(provider.id, e);
        const cls = classifyError(e);
        runtime.alert(cls.code, cls.level, `${provider.id}: ${cls.text}`);
        return { ok: false, ms: Date.now() - t0, error: `${cls.text}｜${String(e).slice(0, 260)}`, code: cls.code, model: model || provider.models?.[0] };
    }
}

export function presetOf(provider) {
    return findPreset(provider.id);
}
