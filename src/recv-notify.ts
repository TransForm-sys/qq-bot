// 接收适配器（R3）：轮询 Windows 通知中心库 wpndatabase.db，解析 QQ toast → 事件。
// 零注入、不碰 QQ 文件、不抢焦点。事件结构与 recv-db.ts 对齐，engine 无需改动。
//
// 可靠性设计（对应 OFFLINE-RISKS.md）：
//   R-25 快照失败不再静默：返回失败原因 + 连续失败告警，偶发一次不报（WAL checkpoint 会短暂锁库）
//   R-23 handler 每轮重查：QQ 重装/改版后 RecordId 会变，缓存旧 id 会永久聋
//   R-24 Id 与 ArrivalTime 双判据：WPN 服务重启导致 Id 空间重置时，靠时间戳继续收
//   R-31 过期消息标记 stale：睡眠/挂起醒来后不回复几小时前的历史消息
//
// QQ toast payload 实测样例（私聊）：
//   <toast launch="ntqq-notification://externalCommand?subcmd=openExternalWindow;
//          peerUid=u_xxx;peerUin=1000000001;peerName=好友A;chatType=1;
//          fuin=1000000000;windowName=MainWindow;scene=aio;" activationType="protocol">
//     <text hint-maxLines="1">好友A</text>      <- 发送者/群名
//     <text hint-maxLines="1">消息正文</text>        <- 正文（可能被截断）
//   </toast>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runtime } from "./runtime.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpDir = path.join(root, "data", "wpn-live");
const NOTIF_DIR = path.join(os.homedir(), "AppData", "Local", "Microsoft", "Windows", "Notifications");

function unescapeXml(s) {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

// launch 里的参数是分号分隔的 key=value
export function parseLaunch(xml) {
    const m = /launch="([^"]*)"/.exec(xml);
    if (!m) return {};
    const raw = unescapeXml(m[1]);
    const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const out = {};
    for (const part of qs.split(/[;&]/)) {
        const i = part.indexOf("=");
        if (i <= 0) continue;
        out[part.slice(0, i)] = part.slice(i + 1);
    }
    return out;
}

export function parseTexts(xml) {
    return [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => unescapeXml(m[1]).trim());
}

// ArrivalTime 是 Windows FILETIME（自 1601 起的 100ns），需要转 epoch ms。
// 18 位整数超出 JS number 精度，用 BigInt 走一遍。
function filetimeToMs(v) {
    if (v === null || v === undefined || v === "") return 0;
    try {
        const ft = typeof v === "bigint" ? v : BigInt(String(v));
        const ms = ft / 10000n - 11644473600000n;
        return ms > 0n ? Number(ms) : 0;
    } catch {
        return 0;
    }
}

function filetimeOf(v) {
    try {
        return v === null || v === undefined || v === "" ? 0n : BigInt(String(v));
    } catch {
        return 0n;
    }
}

// 把一条 toast 行转成事件；不是 QQ 聊天类通知则返回 null
export function toEvent(row, appName, cfg) {
    if (row.Type !== "toast") return null;
    const xml = row.Payload ? Buffer.from(row.Payload).toString("utf8") : "";
    const p = parseLaunch(xml);
    if (!p.peerUin && !p.peerUid) return null;
    // 只接受发给 bot 账号的通知（主号自己的 toast 必须无视）
    if (cfg.botUin && p.fuin && p.fuin !== String(cfg.botUin)) return null;

    const texts = parseTexts(xml);
    const chatType = String(p.chatType || "1");
    const isGroup = chatType === "2" || chatType === "3";
    const head = texts[0] || "";
    const body = texts.slice(1).join(" ");

    // 群聊正文常是 "昵称: 内容"，拆出来；私聊 head 就是对方昵称
    let senderName = head;
    let text = body;
    if (isGroup) {
        const mm = /^(.{1,40}?)[:：]\s*([\s\S]*)$/.exec(body);
        if (mm) {
            senderName = mm[1];
            text = mm[2];
        }
    }
    const atMe = Boolean(cfg.botName) && (text.includes(cfg.botName) || text.includes("@" + cfg.botName));

    return {
        selfUin: String(cfg.botUin || ""),
        kind: isGroup ? "group" : "private",
        msgId: `toast-${row.Id}`,
        peerUin: String(p.peerUin || ""),
        peerName: isGroup ? "" : head,
        groupId: isGroup ? String(p.peerUin || "") : "",
        groupName: isGroup ? head : "",
        senderUin: isGroup ? "" : String(p.peerUin || ""),
        senderName,
        atMe,
        text,
        previewOnly: true, // toast 正文可能被截断（hint-maxLines=1）
        time: filetimeToMs(row.ArrivalTime) || Date.now(),
        app: appName
    };
}

// ---------- 快照 ----------
// 拷贝一份通知库（WAL 里是最近写入）。用 size+mtime 做签名，没变化就复用旧快照。
// 关键：失败必须带原因返回，不能静默 —— 否则"轮询在跑但永远读不到"无从发现。
let snapSig = "";

function snapshot() {
    const dbPath = path.join(NOTIF_DIR, "wpndatabase.db");
    const walPath = path.join(NOTIF_DIR, "wpndatabase.db-wal");
    try {
        if (!fs.existsSync(dbPath)) return { ok: false, reason: `通知库不存在: ${dbPath}` };
        fs.mkdirSync(tmpDir, { recursive: true });
        const s1 = fs.statSync(dbPath);
        const s2 = fs.existsSync(walPath) ? fs.statSync(walPath) : { size: 0, mtimeMs: 0 };
        const sig = `${s1.size}:${s1.mtimeMs}:${s2.size}:${s2.mtimeMs}`;
        if (sig === snapSig && fs.existsSync(path.join(tmpDir, "wpndatabase.db"))) return { ok: true, reused: true };
        fs.copyFileSync(dbPath, path.join(tmpDir, "wpndatabase.db"));
        if (fs.existsSync(walPath)) fs.copyFileSync(walPath, path.join(tmpDir, "wpndatabase.db-wal"));
        try {
            fs.copyFileSync(path.join(NOTIF_DIR, "wpndatabase.db-shm"), path.join(tmpDir, "wpndatabase.db-shm"));
        } catch {
            /* shm 可能不在，SQLite 会自行重建 */
        }
        snapSig = sig;
        return { ok: true, reused: false };
    } catch (e) {
        // EBUSY / EPERM / ENOSPC 都会走到这里，必须把错误码带出去
        return { ok: false, reason: `${e.code || "ERR"}: ${String(e.message || e).slice(0, 200)}` };
    }
}

function openSnapshotDb() {
    try {
        return new DatabaseSync(path.join(tmpDir, "wpndatabase.db"), { readOnly: true });
    } catch (e) {
        return { error: `open failed: ${String(e).slice(0, 200)}` };
    }
}

// 找出 handlerId -> 应用名，并挑出 QQ 的 handler。
// RecordId 由系统分配且会变（QQ 重装/升级/重新注册），所以调用方每轮都要重查。
function resolveQQHandlers(db) {
    const map = new Map();
    for (const h of db.prepare("SELECT RecordId, PrimaryId FROM NotificationHandler").all()) {
        map.set(h.RecordId, h.PrimaryId);
    }
    const ids = [...map.entries()]
        .filter(([, name]) => /^QQ$|\.QQ$|Tencent\.QQ|^QQNT$/i.test(String(name)))
        .map(([id]) => id);
    return { map, ids };
}

const SEEN_CAP = 500;

// 游标持久化：机器人重启后从上次读到的位置继续，而不是"跳过重启期间的所有消息"。
// 之前的行为是启动即把 lastId 设成库里 MAX(Id)，于是任何一次重启都会静默吞掉
// 停机窗口内到达的消息（实测 01:12:54 的 toast 就是这样丢的 —— 通知在库里躺着，
// 机器人重启后把它当历史跳过了）。超出 reply.staleAfterMs 的仍然只归档不回复。
const cursorPath = path.join(root, "data", "receive-cursor.json");

function readCursor() {
    try {
        const j = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
        if (Number.isFinite(Number(j.lastId)) && j.lastFt != null) {
            return { lastId: Number(j.lastId), lastFt: filetimeOf(j.lastFt) };
        }
    } catch {
        /* 没有游标 / 文件损坏都退回"不回放历史" */
    }
    return null;
}

function writeCursor(lastId, lastFt) {
    try {
        const tmp = cursorPath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ lastId, lastFt: String(lastFt), at: Date.now() }));
        fs.renameSync(tmp, cursorPath);
    } catch {
        /* 游标写不进去只影响"重启后补收"，不该拖垮接收 */
    }
}

// 一条通知是否"新"：Id 前进，或到达时间前进。
// 双判据的意义：WPN 服务重启后 Id 计数器可能被重置，只比 Id 会永久聋（R-24）；
// 反过来只比时间戳，则同一毫秒内的多条会被漏掉。两者取或，再用 msgId 去重兜底。
export function isNewRow(row, lastId, lastFt) {
    const ft = filetimeOf(row.ArrivalTime);
    if (Number(row.Id) > lastId) return true;
    return ft > 0n && ft > lastFt;
}

export function startNotifyReceiver(cfg, onEvent) {
    const intervalMs = Number(cfg.receiveIntervalMs || 1500);
    const archive = fs.createWriteStream(path.join(root, "data", "notify-archive.jsonl"), { flags: "a" });
    // 归档流出错（磁盘满/权限）不能拖垮接收
    let archiveBroken = false;
    archive.on("error", () => {
        archiveBroken = true;
    });

    // 原始通知流水：不管哪个应用、能不能解析，只要通知库多了一条就记一行。
    // 目的：区分"QQ 压根没发通知"和"发了但我们没解析出来" —— 这两种故障的
    // 处理方式完全相反，没有这份流水就只能在两种猜测之间来回试。
    const rawLog = fs.createWriteStream(path.join(root, "data", "notify-raw.jsonl"), { flags: "a" });
    let rawLastId = -1;

    let lastId = -1;
    let lastFt = 0n;
    let cursorWritten = -1;
    let handlerSig = "";
    let handlers = { map: new Map(), ids: [] };
    let missingTicks = 0;
    let tickNo = 0;
    // 去重：Id 空间若被重置，同一条可能被"时间戳判据"重复捞到
    const seen = new Set();
    const seenOrder = [];

    function remember(msgId) {
        if (seen.has(msgId)) return false;
        seen.add(msgId);
        seenOrder.push(msgId);
        while (seenOrder.length > SEEN_CAP) seen.delete(seenOrder.shift());
        return true;
    }

    function archiveWrite(obj) {        if (archiveBroken) return;
        try {
            archive.write(JSON.stringify(obj) + "\n");
        } catch {
            /* 归档失败不影响主流程 */
        }
    }

    // 所有应用的新通知都记一行（含 QQ）。QQ 没发通知时这里就是空的 —— 一眼能看出
    // 到底是"系统没给通知"还是"我们解析失败"。
    function logRawRows(db) {
        try {
            const maxId = db.prepare("SELECT COALESCE(MAX(Id),0) AS m FROM Notification").get().m;
            if (rawLastId < 0) {
                rawLastId = maxId;
                return;
            }
            if (maxId <= rawLastId) return;
            const rows = db
                .prepare(
                    "SELECT Id, HandlerId, Type, CAST(ArrivalTime AS TEXT) AS ArrivalTime FROM Notification " +
                        "WHERE Id > ? ORDER BY Id LIMIT 20"
                )
                .all(rawLastId);
            for (const r of rows) {
                rawLastId = Math.max(rawLastId, Number(r.Id));
                const app = handlers.map.get(r.HandlerId) || `h${r.HandlerId}`;
                rawLog.write(
                    JSON.stringify({ t: Date.now(), id: r.Id, app, type: r.Type, time: filetimeToMs(r.ArrivalTime) }) + "\n"
                );
            }
        } catch {
            /* 纯诊断，失败不影响接收 */
        }
    }

    function tick() {
        tickNo += 1;
        const snap = snapshot();
        if (!snap.ok) {
            runtime.snapshotFail(snap.reason);
            // 只在第 1、5、50 次打印，避免每 1.5s 刷屏
            const n = runtime.receiverHealth.snapshotFailStreak;
            if (n === 1 || n === 5 || n === 50) {
                console.log(`[rcv-notify] 读通知库失败(${n}): ${snap.reason}`);
            }
            return;
        }

        const db = openSnapshotDb();
        if (!db || db.error) {
            runtime.snapshotFail(db?.error || "openSnapshot 返回空");
            return;
        }

        try {
            // ---- handler 每轮刷新（R-23）----
            const fresh = resolveQQHandlers(db);
            const sig = fresh.ids.join(",");
            if (sig !== handlerSig) {
                if (!handlerSig && sig) {
                    console.log(`[rcv-notify] QQ handler = ${sig}（每轮复查，变更会自动跟随）`);
                }
                if (handlerSig && sig) {
                    console.log(`[rcv-notify] QQ handler 变更 ${handlerSig} -> ${sig}（已自动切换）`);
                    runtime.receiverHealth.handlerChanges += 1;
                    runtime.alert("recv-handler-changed", "warn", `QQ 通知 handler 从 ${handlerSig} 变为 ${sig}，已自动跟随`);
                }
                handlerSig = sig;
                handlers = fresh;
                runtime.receiverHealth.handlerIds = sig || "(none)";
            }
            if (!handlers.ids.length) {
                missingTicks += 1;
                // 约 60 秒还找不到 QQ handler 才告警（QQ 冷启动注册有延迟）
                if (missingTicks === 40) {
                    runtime.alert(
                        "recv-handler-missing",
                        "error",
                        "通知库里找不到 QQ 的 handler -> 可能 QQ 未登录 / 通知被系统关闭"
                    );
                }
                if (missingTicks % 40 === 0) console.log("[rcv-notify] 未找到 QQ handler，继续等待");
                return;
            }
            missingTicks = 0;
            if (runtime.hasAlert("recv-handler-missing")) runtime.clearAlert("recv-handler-missing");
            runtime.snapshotOk();

            // ---- 基线：优先沿用上次的游标，其次才是"不回放历史" ----
            if (lastId < 0) {
                const saved = readCursor();
                if (saved) {
                    lastId = saved.lastId;
                    lastFt = saved.lastFt;
                    runtime.receiverHealth.lastId = lastId;
                    console.log(`[rcv-notify] resume from cursor id=${lastId} ft=${lastFt}（补收停机期间的消息）`);
                    return;
                }
                lastId = db.prepare("SELECT COALESCE(MAX(Id),0) AS m FROM Notification").get().m;
                // ArrivalTime 是 18 位 INT64，node:sqlite 直接取会抛 "too large for a JS number"，
                // 必须 CAST 成 TEXT 再用 BigInt 解析
                const maxFt = db.prepare("SELECT CAST(COALESCE(MAX(ArrivalTime),0) AS TEXT) AS m FROM Notification").get().m;
                lastFt = filetimeOf(maxFt);
                runtime.receiverHealth.lastId = lastId;
                console.log(`[rcv-notify] baseline id=${lastId} ft=${lastFt}（不回放历史）`);
                return;
            }

            logRawRows(db);

            // ---- 取最近 60 条 QQ 通知，本地用 Id / 时间戳双判据过滤（R-24）----
            const marks = handlers.ids.map(() => "?").join(",");
            const rows = db
                .prepare(
                    `SELECT Id, HandlerId, Type, CAST(ArrivalTime AS TEXT) AS ArrivalTime, Payload FROM Notification ` +
                        `WHERE HandlerId IN (${marks}) ORDER BY Id DESC LIMIT 60`
                )
                .all(...handlers.ids);

            let maxFtSeen = lastFt;
            for (const r of rows.reverse()) {
                const ft = filetimeOf(r.ArrivalTime);
                const isNew = isNewRow(r, lastId, lastFt);
                if (!isNew) continue;
                if (r.Id > lastId) lastId = r.Id;
                if (ft > maxFtSeen) maxFtSeen = ft;
                const evt = toEvent(r, handlers.map.get(r.HandlerId), cfg);
                if (!evt) continue;
                if (!remember(evt.msgId)) continue;
                // 睡眠/挂起醒来后，库里可能积压几小时前的消息：归档但标记 stale，engine 不回复
                const staleAfter = Number(cfg.reply?.staleAfterMs ?? 300000);
                if (staleAfter > 0 && Date.now() - evt.time > staleAfter) {
                    evt.stale = true;
                    evt.staleMs = Date.now() - evt.time;
                }
                // toast 会被用户点掉/清空，落一份归档，避免"看到但没留住"
                archiveWrite({ t: Date.now(), ...evt });
                runtime.receiverHealth.lastId = lastId;
                runtime.receiverHealth.lastArrivalAt = evt.time;
                console.log(
                    `[rcv-notify] ${evt.kind} from ${evt.senderName || evt.peerUin}: ${evt.text.slice(0, 60)}` +
                        (evt.stale ? ` [stale ${Math.round(evt.staleMs / 1000)}s]` : "")
                );
                if (!evt.stale) onEvent(evt);
            }
            lastFt = maxFtSeen;
            if (lastId !== cursorWritten) {
                writeCursor(lastId, lastFt);
                cursorWritten = lastId;
            }

            // ---- Id 空间被重置的兜底（R-24）----
            // 库里 MAX(Id) 明显小于我们记住的 lastId，说明 WPN 服务重启过或库被重建。
            // 此时靠时间戳继续收；每 10 轮校正一次 Id 基线，避免新 id 从低位开始时被卡死。
            if (tickNo % 10 === 0) {
                const maxId = db.prepare("SELECT COALESCE(MAX(Id),0) AS m FROM Notification").get().m;
                if (maxId > 0 && maxId < lastId - 5) {
                    runtime.receiverHealth.baselineRebuilt += 1;
                    console.log(`[rcv-notify] 检测到 Id 基线异常 (max=${maxId} < last=${lastId})，已重建基线`);
                    runtime.alert("recv-id-reset", "warn", `通知 Id 空间疑似重置（max ${maxId} < last ${lastId}），已自动重建基线`);
                    lastId = maxId;
                    runtime.receiverHealth.lastId = lastId;
                }
            }
        } catch (e) {
            console.log("[rcv-notify] tick error:", String(e).slice(0, 200));
            runtime.error("receive", e);
        } finally {
            try {
                db.close();
            } catch {
                /* ignore */
            }
        }
    }

    const timer = setInterval(tick, intervalMs);
    tick();
    return { stop: () => clearInterval(timer) };
}

// 直接运行：--live = 只监听并打印事件（不回复）；否则回放最近的 QQ toast
const isMain = process.argv[1] ? /recv-notify\.ts$/.test(process.argv[1]) : false;
if (isMain) {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    if (process.argv.includes("--live")) {
        console.log("[rcv-notify] live 模式（只打印，不回复）");
        startNotifyReceiver(cfg, (evt) => {
            console.log("\n[EVENT]", JSON.stringify(evt, null, 1));
        });
    } else {
        const snap = snapshot();
        if (!snap.ok) {
            console.log("无法读取通知库:", snap.reason);
            process.exit(1);
        }
        const db = openSnapshotDb();
        if (!db || db.error) {
            console.log("无法打开通知库快照:", db?.error || "unknown");
            process.exit(1);
        }
        const { map, ids } = resolveQQHandlers(db);
        console.log("QQ handlerIds:", ids.join(",") || "(none)");
        if (ids.length) {
            const marks = ids.map(() => "?").join(",");
            const rows = db
                .prepare(
                    `SELECT Id, HandlerId, Type, CAST(ArrivalTime AS TEXT) AS ArrivalTime, Payload FROM Notification ` +
                        `WHERE HandlerId IN (${marks}) ORDER BY Id DESC LIMIT 5`
                )
                .all(...ids);
            for (const r of rows.reverse()) {
                console.log("\n---", r.Id, map.get(r.HandlerId));
                console.log(JSON.stringify(toEvent(r, map.get(r.HandlerId), cfg), null, 1));
            }
        }
        db.close();
    }
}
