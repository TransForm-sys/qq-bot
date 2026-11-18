// 接收适配器：轮询 live nt_msg.db -> 解密 -> 增量读新消息 -> 事件
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decryptDb } from "./dbcrypt.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");

// 极简 protobuf 遍历：收集可读 UTF-8 字符串（消息文本藏在嵌套元素里）
function pbStrings(buf, depth = 0, out = []) {
    if (depth > 4) return out;
    let i = 0;
    const varint = () => {
        let v = 0n;
        let s = 0n;
        while (i < buf.length) {
            const b = buf[i++];
            v |= BigInt(b & 0x7f) << s;
            if (!(b & 0x80)) break;
            s += 7n;
            if (s > 63n) return null;
        }
        return v;
    };
    while (i < buf.length) {
        const tag = varint();
        if (tag === null) break;
        const wt = Number(tag & 7n);
        if (wt === 0) {
            if (varint() === null) break;
        } else if (wt === 2) {
            const len = varint();
            if (len === null || len > BigInt(buf.length - i)) break;
            const payload = buf.subarray(i, i + Number(len));
            i += Number(len);
            const s = payload.toString("utf8");
            const printable = payload.length >= 2 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) && Buffer.from(s, "utf8").length === payload.length;
            if (printable) out.push(s);
            else pbStrings(payload, depth + 1, out);
        } else if (wt === 5) {
            i += 4;
        } else if (wt === 1) {
            i += 8;
        } else break;
    }
    return out;
}

function textOf(row) {
    for (const v of Object.values(row)) {
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
            const strs = pbStrings(Buffer.from(v));
            if (strs.length) return strs.join(" ").slice(0, 2000);
        }
    }
    return "";
}

function pickUin(row, names) {
    for (const n of names) {
        const v = row[n];
        if (typeof v === "number" && v > 10000) return String(v);
        if (typeof v === "string" && /^\d{5,12}$/.test(v)) return v;
    }
    return "";
}

export function startReceiver(cfg, onEvent) {
    const keyFile = path.join(dataDir, "key-found.json");
    const liveDb = path.join(cfg.storagePath, cfg.botUin, "nt_qq", "nt_db", "nt_msg.db");
    const copyPath = path.join(dataDir, "dbcopy", "live.db");
    const decPath = path.join(dataDir, "decrypted", "nt_msg.db");
    fs.mkdirSync(path.dirname(decPath), { recursive: true });
    const cursors = {};
    let schemaLogged = false;
    let warned = false;

    async function tick() {
        if (!fs.existsSync(keyFile)) {
            if (!warned) {
                console.log("[recv] waiting for data/key-found.json (memory key extraction unfinished)");
                warned = true;
            }
            return;
        }
        const p = JSON.parse(fs.readFileSync(keyFile, "utf8"));
        try {
            fs.copyFileSync(liveDb, copyPath);
        } catch {
            return;
        }
        const buf = fs.readFileSync(copyPath);
        let plain;
        try {
            plain = decryptDb(buf, p);
        } catch (e) {
            console.log("[recv] decrypt error:", String(e));
            return;
        }
        fs.writeFileSync(decPath, plain);
        let db;
        try {
            db = new DatabaseSync(decPath, { readOnly: true });
        } catch (e) {
            console.log("[recv] open error:", String(e));
            return;
        }
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
            if (!schemaLogged) {
                const schema = {};
                for (const t of tables) schema[t] = db.prepare(`PRAGMA table_info(${t})`).all();
                fs.writeFileSync(path.join(dataDir, "schema.json"), JSON.stringify(schema, null, 1));
                console.log("[recv] tables:", tables.join(", "));
                schemaLogged = true;
            }
            for (const t of tables) {
                if (!/msg_table$/.test(t) || /temp|discuss|dataline/.test(t)) continue;
                const kind = t.startsWith("group") ? "group" : "private";
                if (cursors[t] === undefined) {
                    cursors[t] = db.prepare(`SELECT MAX(rowid) AS m FROM ${t}`).get().m ?? 0;
                    continue;
                }
                const cur = cursors[t];
                const rows = db.prepare(`SELECT rowid AS rid, * FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT 50`).all(cur);
                for (const r of rows) {
                    cursors[t] = r.rid;
                    const names = Object.keys(r);
                    const uinNames = names.filter((n) => /uin|sender|peer|user/i.test(n));
                    const sender = pickUin(r, uinNames);
                    onEvent({
                        selfUin: cfg.botUin,
                        kind,
                        msgId: `${t}-${r.rid}`,
                        peerUin: sender,
                        peerName: "",
                        groupId: kind === "group" ? sender : "",
                        groupName: "",
                        senderUin: sender,
                        senderName: "",
                        atMe: false,
                        text: textOf(r),
                        time: Date.now()
                    });
                }
            }
        } finally {
            db.close();
        }
    }

    const timer = setInterval(() => tick().catch((e) => console.log("[recv] tick error:", String(e))), 3000);
    return { stop: () => clearInterval(timer) };
    tick().catch(() => {});
}