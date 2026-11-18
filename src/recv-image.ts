// 接收侧图片：把对方发来的图片喂给模型"看"。
//
// 为什么这条路能走通：
//   1. 通知库（R3 接收路径）只给一句文本，图片消息就是字面量 "[图片]"，
//      没有 md5、没有 url、没有附件 —— 通知里拿不到图。
//   2. 但 NTQQ 收到图片会在本地落一份**明文**缩略图：
//        <Documents>/Tencent Files/<uin>/nt_qq/nt_data/Pic/<YYYY-MM>/Thumb/<md5>_720.png
//      （实测 2026-11-18：用户发的"赛博朋克猫打麻将"，文件可直接打开）
//   3. 文件名里没有消息 id，只能靠"落盘时间 ≈ 通知到达时间"配对。
//
// 所以配对策略是：在通知到达时间 ±windowMs 内找最新落盘的缩略图，
// 且每张图只认领一次（同一个文件不会被两条消息重复使用）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 单张图的上限。DeepSeek 的请求体上限是 48 MiB，base64 会膨胀 4/3，
// 8 MiB 原图 -> 约 10.7 MiB 编码后，留足余量。
const MAX_BYTES = 8 * 1024 * 1024;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEEN_FILE = path.join(root, "data", "image-seen.json");

// 已处理的图片（md5 -> 处理时间秒）。同一张图有 _0/_720 两个文件，
// 但 md5 相同，所以用 md5 做键：任何一个版本被处理过，另一个版本也不会再触发一次。
let seen: Record<string, number> | null = null;
let flushTimer: any = null;

function loadSeen(): Record<string, number> {
    if (!seen) {
        try {
            const j = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
            seen = j && typeof j === "object" ? j : {};
        } catch {
            seen = {};
        }
    }
    return seen;
}

function flushSeenSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        try {
            const s = loadSeen();
            const keys = Object.keys(s);
            if (keys.length > 400) {
                // 只留最近 300 张（value 是落盘秒，越新越大）
                keys.sort((a, b) => s[b] - s[a]);
                for (const k of keys.slice(300)) delete s[k];
            }
            fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
            fs.writeFileSync(SEEN_FILE, JSON.stringify(s));
        } catch {
            /* 写不进去不影响收发，下次再写 */
        }
    }, 300);
    flushTimer.unref?.();
}

export function isSeen(key: string) {
    return !!loadSeen()[key];
}

export function markSeen(key: string) {
    loadSeen()[key] = Math.floor(Date.now() / 1000);
    flushSeenSoon();
}

function monthDir(atMs: number) {
    const d = new Date(atMs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function thumbDir(uin: string, atMs: number) {
    return path.join(
        os.homedir(),
        "Documents",
        "Tencent Files",
        uin,
        "nt_qq",
        "nt_data",
        "Pic",
        monthDir(atMs),
        "Thumb"
    );
}

// 列出 atMs 附近落盘的缩略图，按时间从新到旧。
// 同一张图通常有 _0.png / _720.png 两份，按 md5 去重，优先用非 _0 的那份；
// 极少数图只有 _0，那就用它兜底（不能因为筛尺寸把图整张漏掉）。
export function recentThumbs(uin, atMs, windowMs = 20000) {
    const dir = thumbDir(String(uin), atMs);
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return []; // 目录还不存在（这个月还没收过图）= 没有图片，静默返回
    }
    const byBase = new Map();
    for (const n of names) {
        const m = n.match(/^(.*?)(_\d+)?\.(png|jpe?g|webp)$/i);
        if (!m) continue;
        const base = m[1];
        const isOrig = m[2] === "_0"; // _0 是原图缩略，_720 是宽 720 的版本
        const p = path.join(dir, n);
        try {
            const st = fs.statSync(p);
            if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) continue;
            if (Math.abs(st.mtimeMs - atMs) > windowMs) continue;
            const row = { path: p, name: n, base, isOrig, mtime: st.mtimeMs, size: st.size };
            const prev = byBase.get(base);
            if (!prev || (prev.isOrig && !isOrig)) byBase.set(base, row);
        } catch {
            /* 文件正在被 QQ 写，下一轮再说 */
        }
    }
    return Array.from(byBase.values()).sort((a, b) => b.mtime - a.mtime);
}

// 认领一张图片：找到就标记为已用，返回本地路径；找不到返回 null。
export function claimIncomingImage(uin, atMs, windowMs = 20000) {
    for (const row of recentThumbs(uin, atMs, windowMs)) {
        if (isSeen(row.base)) continue;
        markSeen(row.base);
        return row.path;
    }
    return null;
}

export function toDataUrl(p) {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const mime =
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
}

// "这条消息是不是图片" —— 通知文本的实测形态就是字面量 "[图片]"。
// 群聊里可能带前后缀，所以用包含判断而不是全等。
export function looksLikeImage(text) {
    const s = String(text || "").trim();
    if (!s) return false;
    return /\[图片\]|\[图片消息\]|\[闪照\]/.test(s);
}

// 等图片落盘：通知可能比缩略图早几百毫秒到两三秒，
// 收到通知立刻找会扑空。总共最多等 tries * 700ms。
export async function waitForImage(uin, atMs, tries = 4) {
    for (let i = 0; i < tries; i++) {
        const p = claimIncomingImage(uin, atMs);
        if (p) return p;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 700));
    }
    return null;
}

// 让模型"看图"并转成一段文字描述。
//
// 为什么单独调一次、而不是把图直接塞进主对话：
//   * 主对话要维持人设、长度、拟人节奏，混进多模态 content 后一旦出错整条回复就没了；
//   * 单独调用的结果可以存进会话记忆，后面几轮模型仍然"记得看过这张图"；
//   * 失败只损失"看图"，不影响正常回文字。
//
// maxTokens 必须给足：deepseek-flash 是推理模型，图片本身约 620 prompt tokens，
// 它会先在 reasoning_content 里分析一遍（实测 566 tokens），预算给小了 content 就是空的。
const IMG_SYSTEM =
    "你在帮一个聊天机器人看图。用中文客观描述画面：主体、动作、画面里的文字（如果有）、整体风格氛围。" +
    "不要评论、不要猜测对方意图，120 字以内。";

export async function describeImage(cfg, p, maxTokens = 1200) {
    const { chat } = await import("./llm.ts");
    const messages = [
        { role: "system", content: IMG_SYSTEM },
        {
            role: "user",
            content: [
                { type: "text", text: "描述这张图。" },
                { type: "image_url", image_url: { url: toDataUrl(p) } }
            ]
        }
    ];
    const r = await chat(cfg, messages, { maxTokens });
    const t = String(r?.text || "").trim();
    if (!t) return null;
    // 推理模型没吐 content 时会兜底成 reasoning_content，里面常带"1. 分析请求"这类
    // 结构化思考，压成一段纯文字再用。
    return t.replace(/\s+/g, " ").slice(0, 300);
}

