// 回复引擎：账号绑定 + 白名单 + 限流 + 人设 LLM + 会话记忆 + 插件钩子 + 拟人节奏。
import fs from "node:fs";
import path from "node:path";
import { ROOT, store } from "./config.ts";
import { chat } from "./llm.ts";
import * as memory from "./memory.ts";
import { send } from "./send-ui.ts";
import { plugins } from "./plugins.ts";
import { runtime } from "./runtime.ts";
import { describeImage, looksLikeImage, waitForImage } from "./recv-image.ts";
import { noteInbound } from "./inbound-context.ts";
import { runWebTool, webTools } from "./websearch.ts";
import { plainParts, toPlain } from "./plain.ts";

const log = fs.createWriteStream(path.join(ROOT, "data", "bot.jsonl"), { flags: "a" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * Math.max(0, b - a);

// 每个会话最近一次"看图成功"的时间。图片有两条到达路径（通知 / 缩略图监视），
// 后者先回了的话，前者的 "[图片]" 就只当作重复，不再回一句空的。
const imageHandledAt = new Map();

// 联网工具的用法说明。拼在人设后面，让模型自己决定什么时候查 ——
// 关键词触发那种写法在中文里太脆（"最近""新出的"满地都是）。
const SEARCH_NOTE = `[联网]
你手上有两个工具：web_search（搜索互联网）、open_url（读某个网页的正文）。
- 涉及会变的事实时先搜再答：新闻、赛事、软件/模型版本、价格、政策、某人的现任职位、最近发生的事。
- 搜索结果只是素材。可以概括、可以不说来源；除非对方要链接，不要把 URL 贴出来。
- 搜不到、或者结果互相矛盾时，直说"这个我查了下没查到靠谱的"，不要凭印象硬凑。
- 日常闲聊、情绪回应、你自己的看法不需要搜，别为了显得勤快去查。`;

// 人设：按 mtime 缓存，WebUI 里改完下一条消息就生效
let personaCache = { file: "", mtime: 0, text: "" };
function persona() {
    const cfg = store.get();
    const file = path.join(ROOT, cfg.personaFile || "persona.md");
    try {
        const st = fs.statSync(file);
        if (personaCache.file !== file || st.mtimeMs !== personaCache.mtime) {
            personaCache = { file, mtime: st.mtimeMs, text: fs.readFileSync(file, "utf8") };
        }
        return personaCache.text;
    } catch {
        return "你是一个友好的聊天助手，回复简短自然。";
    }
}

function record(obj) {
    try {
        log.write(JSON.stringify({ t: Date.now(), ...obj }) + "\n");
    } catch {
        /* 磁盘异常不阻塞回复 */
    }
}

export function createEngine() {
    const stamps = [];
    let lastAt = 0;
    let chain = Promise.resolve();

    function allowed(evt, cfg) {
        if (evt.selfUin && cfg.botUin && evt.selfUin !== String(cfg.botUin)) return "not-my-account";
        if (evt.senderUin && evt.senderUin === String(cfg.botUin)) return "self";
        if (evt.kind === "private") return cfg.reply.private ? "" : "private-off";
        if (evt.kind === "group") {
            const groups = cfg.reply.groups || [];
            const name = String(evt.groupName || evt.groupId || "");
            const hit = groups.includes("*") || groups.some((g) => g && (g === name || name.includes(g)));
            if (!hit) return "group-not-allowed";
            if (evt.atMe) return "";
            const bn = cfg.botName;
            return bn && evt.text.includes(bn) ? "" : "not-mentioned";
        }
        return "unknown-kind";
    }

    function rateOk(cfg) {
        const now = Date.now();
        if (now - lastAt < cfg.reply.minIntervalMs) return false;
        while (stamps.length && now - stamps[0] > 60000) stamps.shift();
        return stamps.length < cfg.reply.maxPerMinute;
    }

    function markSent() {
        lastAt = Date.now();
        stamps.push(lastAt);
    }

    // 拟人节奏：先"看一会"，再按字数"打字"
    async function typingDelay(text, cfg) {
        const cps = Math.max(1, cfg.reply.typingSpeedCps || 14);
        const ms = Math.min(cfg.reply.maxTypingMs || 0, Math.round((String(text).length / cps) * 1000));
        await sleep(Math.max(180, ms));
    }

    // 发出去之前统一拍平 markdown（见 src/plain.ts）：QQ 不渲染 ** 和 #，
    // 原样发出去就是一串星号，读起来像在看源码。
    // 返回值是"实际发出去的文本"，日志/记忆/WebUI 都用它，
    // 这样界面上看到的和对方收到的完全一致。
    async function deliver(target, evt, cfg, segments, reply) {
        const parts = plainParts(segments, reply);
        for (let i = 0; i < parts.length; i++) {
            await typingDelay(parts[i], cfg);
            await send(target, parts[i]);
            if (i < parts.length - 1) await sleep(320 + Math.random() * 380);
        }
        return parts;
    }

    async function process(evt) {
        const cfg = store.get();
        runtime.event(evt);
        record({ dir: "in", ...evt });
        // 记下"最近是谁在说话"，图片的第二条通道（recv-image-watch.ts）靠它决定回给谁
        if (evt.via !== "thumb-watch") noteInbound(evt);

        // 睡眠/挂起醒来后，通知库里可能积压几小时前的消息：归档了但不回复，
        // 否则一睁眼就把 30 条历史消息全回一遍（R-31）。
        if (evt.stale) {
            runtime.skip("stale");
            record({ dir: "skip-stale", id: evt.msgId, staleMs: evt.staleMs, text: String(evt.text).slice(0, 60) });
            return;
        }

        // 同一道闸门的"队列版"：接收时还不算旧，但轮到它时已经排了很久。
        // 断网或发送卡住时消息会在 chain 里排队，等网络恢复再照着回一遍，
        // 用户看到的就是"几分钟前的答案"——比不回更糟。超过阈值直接丢。
        const staleAfter = Number(cfg.reply?.staleAfterMs ?? 300000);
        const ageMs = evt.time ? Date.now() - evt.time : 0;
        if (staleAfter > 0 && ageMs > staleAfter) {
            runtime.skip("stale-queued");
            record({
                dir: "skip-stale-queued",
                id: evt.msgId,
                ageMs,
                text: String(evt.text).slice(0, 60)
            });
            return;
        }

        const why = allowed(evt, cfg);
        if (why) {
            runtime.skip(why);
            return;
        }
        if (!evt.text || !String(evt.text).trim()) {
            runtime.skip("empty");
            return;
        }

        const gate = await plugins.messageGate(evt);
        if (!gate.allow) {
            runtime.skip(`plugin:${gate.by}`);
            record({ dir: "skip-plugin", id: evt.msgId, by: gate.by });
            return;
        }

        const target = evt.kind === "group" ? evt.groupName || evt.groupId : evt.peerName || evt.peerUin;
        if (!target) {
            runtime.skip("no-target");
            return;
        }

        // 插件直答（命令类），不走大模型也不占限流额度
        if (gate.direct) {
            try {
                const parts = await deliver(target, evt, cfg, null, gate.direct);
                const sent = parts.join("\n\n");
                runtime.replied({ target, reply: sent, providerId: "plugin", model: "-", ms: 0, segments: parts.length });
                record({ dir: "out", target, reply: sent, via: "plugin" });
            } catch (e) {
                runtime.error("send", e);
                record({ dir: "send-error", target, error: String(e) });
            }
            return;
        }

        if (!rateOk(cfg)) {
            runtime.skip("rate");
            record({ dir: "skip-rate", id: evt.msgId });
            return;
        }

        if (cfg.reply.readDelayMs?.[1] > 0) await sleep(rand(cfg.reply.readDelayMs));

        const key = evt.kind === "group" ? `g-${evt.groupName || evt.groupId}` : `p-${evt.peerUin}`;
        let userLine = evt.kind === "group" ? `${evt.senderName || "群友"}: ${evt.text}` : String(evt.text);
        const budget = Number(cfg.models?.historyTokens ?? 3000);

        // 图片消息：通知里只有 "[图片]" 两个字，图片本体得从 QQ 的本地缩略图里捞
        // （见 src/recv-image.ts）。这里先把它转成一段文字描述，再走正常对话 ——
        // 主链路保持纯文本，看图失败也只是少了描述，不会连回复一起挂掉。
        // 描述会一起写进会话记忆，后面几轮模型仍然"记得"这张图。
        //
        // evt.imagePath 来自缩略图监视通道（recv-image-watch.ts）：QQ 有时压根
        // 不发图片通知，那条通道直接盯文件，路径已经确定，不需要再配对。
        if (cfg.imageVision !== false && (evt.imagePath || looksLikeImage(evt.text))) {
            const imgPath = evt.imagePath || (await waitForImage(evt.selfUin || cfg.botUin, evt.time ?? Date.now()));
            if (!imgPath) {
                // 同一张图可能已经被缩略图通道回过了（两条通道的时间差可达几十秒），
                // 这时再回一句"[图片]"就是重复刷屏，直接跳过。
                const handledAt = imageHandledAt.get(key) || 0;
                if (Date.now() - handledAt < 120000) {
                    runtime.skip("image-dup");
                    return;
                }
                console.log("[image] 是图片消息，但本地没找到缩略图（闪照 / 表情 / 还没落盘）");
                runtime.alert("recv-image-miss", "warn", "收到图片消息但没找到本地缩略图，只能按文字处理");
            } else {
                const desc = await describeImage(cfg, imgPath).catch((e) => {
                    console.log("[image] 看图失败:", String(e).slice(0, 140));
                    return null;
                });
                if (desc) {
                    const prefix = evt.kind === "group" ? `${evt.senderName || "群友"}: ` : "";
                    // 措辞很重要：不写清"这是系统识别的"，模型会以为描述是对方手打的，
                    // 于是回出"你直接把画面转成文字了嘛"这种跑偏的话。
                    userLine = `${prefix}[图片]（系统识别到的画面，不是对方打的字：${desc}）`;
                    imageHandledAt.set(key, Date.now());
                    console.log(`[image] 已识别 ${path.basename(imgPath)}：${desc.slice(0, 60)}…`);
                    record({ dir: "recv-image", msgId: evt.msgId, file: path.basename(imgPath), desc: desc.slice(0, 200) });
                } else {
                    runtime.alert("recv-image-miss", "warn", "收到图片但看图失败，已按文字处理");
                }
            }
        }

        const history = memory.append(key, "user", userLine, budget);

        // 联网：给模型 web_search / open_url 两个工具，由它自己决定要不要查。
        // 关键词触发那种写法在中文里太脆（"最近""新出的"到处都有），
        // 交给模型判断更准，也不需要维护词表。
        const searchOn = cfg.search?.enabled !== false;

        let messages = [
            { role: "system", content: searchOn ? persona() + "\n\n" + SEARCH_NOTE : persona() },
            ...history.slice(0, -1),
            { role: "user", content: userLine }
        ];
        messages = await plugins.beforeReply({ evt, messages, cfg });

        let out;
        try {
            out = await chat(cfg, messages, {
                scope: evt.kind,
                tools: searchOn ? webTools : null,
                executeTool: searchOn ? (name, args) => runWebTool(cfg, name, args) : undefined,
                maxToolRounds: Number(cfg.search?.maxRounds ?? 2),
                maxToolCalls: Number(cfg.search?.maxCalls ?? 3)
            });
            if (out.toolCalls) record({ dir: "web", target, calls: out.toolCalls });
        } catch (e) {
            // 上下文超长：这个会话原本会就此永久哑掉。裁剪到最近几条再试一次（R-116）
            const isCtx = /context length|maximum context|too long|token limit|exceeds/i.test(String(e?.message || e));
            if (isCtx && messages.length > 4) {
                const slim = [messages[0], ...messages.slice(-4)];
                try {
                    out = await chat(cfg, slim, { scope: evt.kind });
                    runtime.alert("llm-context-trim", "warn", `会话 ${key} 上下文超长，已裁剪后重试成功`);
                    record({ dir: "context-trim", key, from: messages.length, to: slim.length });
                } catch (e2) {
                    runtime.error("llm", e2);
                    record({ dir: "llm-error", error: String(e2).slice(0, 500), attempts: e2.attempts || [], trimmed: true });
                    return;
                }
            } else {
                runtime.error("llm", e);
                // 断网：这条注定没有回复，而且不能"等网络恢复再补"——
                // 那会把几分钟前的旧答案发给现在的对话。宁可静默丢弃，让对方重发。
                if (e?.offline) {
                    runtime.skip("llm-offline");
                    console.log(`[llm] 网络不可达，本条不回复（恢复后不回补，需对方重发）: ${String(e).slice(0, 100)}`);
                }
                record({
                    dir: e?.offline ? "llm-offline" : "llm-error",
                    error: String(e).slice(0, 500),
                    attempts: e.attempts || []
                });
                return;
            }
        }

        const raw = String(out.text || "").trim();
        let { reply, segments } = await plugins.afterReply({
            evt,
            reply: out.text,
            llm: { providerId: out.providerId, model: out.model }
        });
        reply = toPlain(String(reply || ""));
        if (!reply) {
            // 两种情况：插件把回复吞了（正常），或者整条回复都是被清掉的记号
            // （模型偶尔会把工具调用协议 <｜｜DSML｜｜…> 当正文吐出来）。
            // 后者如果照发，群里就是一坨 XML —— 宁可不回。
            const reason = raw ? "empty-after-clean" : "plugin-empty";
            runtime.skip(reason);
            record({ dir: "skip-empty", id: evt.msgId, reason, raw: raw.slice(0, 200) });
            return;
        }

        try {
            const parts = await deliver(target, evt, cfg, segments, reply);
            const sent = parts.join("\n\n");
            markSent();
            memory.append(key, "assistant", sent);
            runtime.replied({
                target,
                reply: sent,
                providerId: out.providerId,
                model: out.model,
                ms: out.ms,
                segments: parts.length
            });
            record({ dir: "out", target, reply: sent, segments: parts.length, provider: out.providerId, model: out.model, ms: out.ms });
            await plugins.afterSend({ evt, reply: sent, target });
        } catch (e) {
            runtime.error("send", e);
            record({ dir: "send-error", target, error: String(e) });
        }
    }

    return {
        // 串行处理，避免同一时刻多条消息抢 UI 焦点
        handle(evt) {
            const job = chain.then(() => process(evt)).catch((e) => {
                runtime.error("engine", e);
                record({ dir: "engine-error", error: String(e) });
            });
            chain = job;
            return job;
        }
    };
}
