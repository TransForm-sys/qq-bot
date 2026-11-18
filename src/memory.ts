// 每会话记忆：data/sessions/<key>.json
//
// 两重上限（消除 R-116 会话超长静默死亡）：
//   1) 条数上限 CAP
//   2) token 预算（默认 3000）：从最旧的开始丢，保证喂给模型的上下文不会撑爆
// 只按条数截断是不够的：40 条长消息轻松超过 8k token，模型直接返回 400，
// 之后这个会话就再也不回了，而且日志里只有一条 llm-error。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, "data", "sessions");
fs.mkdirSync(dir, { recursive: true });
const CAP = 40;

const file = (key) => path.join(dir, key.replace(/[^\w.-]/g, "_") + ".json");

// 粗略 token 估算：中日韩字符约 1.6 字/token，其余约 4 字符/token。
// 不追求精确，只要能把"必然超限"的上下文压下去。
export function estTokens(text) {
    const s = String(text || "");
    let cjk = 0;
    let other = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        const wide =
            (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x3000 && c <= 0x303f);
        if (wide) cjk++;
        else other++;
    }
    return Math.ceil(cjk / 1.6 + other / 4);
}

export function load(key) {
    try {
        return JSON.parse(fs.readFileSync(file(key), "utf8"));
    } catch {
        return [];
    }
}

export function append(key, role, content, budgetTokens = 3000) {
    const h = load(key);
    h.push({ role, content });
    while (h.length > CAP) h.shift();
    if (budgetTokens > 0) {
        let total = h.reduce((n, m) => n + estTokens(m.content) + 4, 0);
        // 至少保留 2 条（上一轮问答），否则模型完全没有上下文
        while (total > budgetTokens && h.length > 2) {
            const dropped = h.shift();
            total -= estTokens(dropped.content) + 4;
        }
    }
    // 原子写：直接覆盖时断电会留下半个 JSON，下次 load 返回 []，会话记忆静默清空
    try {
        const tmp = file(key) + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(h, null, 1));
        fs.renameSync(tmp, file(key));
    } catch {
        /* 磁盘异常不阻塞回复 */
    }
    return h;
}

export function trimAll(budgetTokens = 3000) {
    let n = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        const key = f.replace(/\.json$/, "");
        const h = load(key);
        if (!h.length) continue;
        let total = h.reduce((s, m) => s + estTokens(m.content) + 4, 0);
        const before = h.length;
        while (total > budgetTokens && h.length > 2) {
            const d = h.shift();
            total -= estTokens(d.content) + 4;
        }
        if (h.length !== before) {
            fs.writeFileSync(file(key), JSON.stringify(h, null, 1));
            n += 1;
        }
    }
    return n;
}
