// 心跳：每 60 秒写一次 data/heartbeat.json，供 tools/watchdog.ps1 判断"活着但已经废了"。
//
// 心跳能发现两件进程状态看不出来的事：
//   1) 事件循环被卡死（插件死循环）：进程在、心跳停了 -> watchdog 可重启
//   2) 系统睡眠/休眠：定时器被挂起，恢复后间隔会远大于周期 -> 告警 + 给 watchdog 留证据
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./config.ts";
import { runtime } from "./runtime.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "data", "heartbeat.json");
const GAP_FILE = path.join(ROOT, "data", "gaps.jsonl");
const INTERVAL = 60000;

export function startHeartbeat(intervalMs = INTERVAL) {
    let lastAt = Date.now();
    let timer = null;

    function beat() {
        const now = Date.now();
        const gap = now - lastAt;
        // 正常抖动几十毫秒；超过 3 个周期基本可以断定进程被挂起过（睡眠/休眠/系统卡顿）
        if (gap > intervalMs * 3) {
            runtime.alert(
                "system-sleep",
                "warn",
                `进程被挂起约 ${Math.round(gap / 1000)}s（睡眠/休眠/系统卡死？），这段时间的消息可能已丢失`
            );
            try {
                fs.appendFileSync(GAP_FILE, JSON.stringify({ t: now, gapMs: gap }) + "\n");
            } catch {
                /* ignore */
            }
        }
        lastAt = now;
        let cfg = {};
        try {
            cfg = store.get();
        } catch {
            /* ignore */
        }
        const payload = {
            pid: process.pid,
            at: now,
            intervalMs,
            gapMs: gap,
            uptimeMs: now - runtime.startedAt,
            receive: cfg.receive || "",
            counters: runtime.counters,
            lastEventAt: runtime.lastEvent?.at || 0,
            lastReplyAt: runtime.lastReply?.at || 0,
            receiver: runtime.receiverHealth,
            send: runtime.sendHealth,
            alerts: runtime.alerts.slice(0, 5)
        };
        try {
            const tmp = FILE + ".tmp";
            fs.mkdirSync(path.dirname(FILE), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), "utf8");
            fs.renameSync(tmp, FILE);
        } catch {
            /* 磁盘异常不影响 bot 本身 */
        }
    }

    beat();
    timer = setInterval(beat, intervalMs);
    // 不能让心跳定时器拖住进程退出
    timer.unref?.();
    return { stop: () => timer && clearInterval(timer), beat };
}
