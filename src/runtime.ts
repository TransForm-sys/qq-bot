// 进程内运行时状态：给 WebUI 提供实时数据（计数、最近事件、动作进度、告警、接收健康度）。
//
// 告警中心说明：这里不是"日志"，而是"需要人看一眼的异常"。所有原本会静默失败的路径
// （接收快照失败、发送未确认、Key 失效、会话超长、插件被停用、锁屏、睡眠）都往这里丢一条，
// WebUI 概览页顶部会显示横幅，同时落盘 data/alerts.jsonl 便于事后追。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ALERT_FILE = path.join(ROOT, "data", "alerts.jsonl");

let alertStream = null;
function writeAlert(row) {
    try {
        if (!alertStream) {
            fs.mkdirSync(path.dirname(ALERT_FILE), { recursive: true });
            alertStream = fs.createWriteStream(ALERT_FILE, { flags: "a" });
            // 磁盘满 / 权限问题不能让进程崩掉，也不能每轮都抛
            alertStream.on("error", () => {
                alertStream = null;
            });
        }
        alertStream.write(JSON.stringify(row) + "\n");
    } catch {
        alertStream = null;
    }
}

const MAX_ALERTS = 40;

export const runtime = {
    startedAt: Date.now(),
    counters: { in: 0, out: 0, skipped: 0, errors: 0, alerts: 0, segments: 0 },
    lastEvent: null,
    lastReply: null,
    lastLlm: null,
    receiver: { mode: "", startedAt: 0 },
    // 接收链路健康度：只有这里能区分"没人发消息"和"收不到消息"
    receiverHealth: {
        snapshotFails: 0,
        snapshotFailStreak: 0,
        lastSnapshotOkAt: 0,
        lastSnapshotError: "",
        handlerIds: "",
        handlerChanges: 0,
        lastId: -1,
        baselineRebuilt: 0,
        lastArrivalAt: 0
    },
    pidScan: { running: false, startedAt: 0, output: "", pid: "" },
    actions: [],
    alerts: [],
    // 发送链路：连续前台化失败次数（锁屏/焦点被抢的间接指标）
    // sending/lastSendAt: watchdog 用它判断"现在能不能把窗口收回托盘"。
    // 发送进行中收窗口会把粘贴/点击打空，所以必须等空闲。
    sendHealth: {
        focusFails: 0,
        lastFocusFailAt: 0,
        unconfirmed: 0,
        lastUnconfirmedAt: 0,
        sending: false,
        sendingSince: 0,
        lastSendAt: 0
    },

    event(evt) {
        this.counters.in += 1;
        this.lastEvent = { ...evt, at: Date.now() };
    },
    replied({ target, reply, providerId, model, ms, segments }) {
        this.counters.out += 1;
        this.counters.segments += segments || 1;
        this.lastReply = { target, reply, at: Date.now() };
        this.lastLlm = { providerId, model, ms, at: Date.now() };
    },
    skip(reason) {
        this.counters.skipped += 1;
        this.lastSkip = { reason, at: Date.now() };
    },
    error(where, error) {
        this.counters.errors += 1;
        this.lastError = { where, error: String(error).slice(0, 300), at: Date.now() };
    },
    action(name, ok, detail) {
        this.actions.unshift({ name, ok, detail: String(detail || "").slice(0, 200), at: Date.now() });
        this.actions = this.actions.slice(0, 20);
    },

    // ---------- 告警 ----------
    // level: "error" 需要处理 / "warn" 需要留意
    alert(code, level, message) {
        const now = Date.now();
        const hit = this.alerts.find((a) => a.code === code);
        if (hit) {
            hit.count += 1;
            hit.at = now;
            hit.message = String(message).slice(0, 300);
            hit.level = level;
            // 退出过又复发，重新置顶
            this.alerts = [hit, ...this.alerts.filter((a) => a !== hit)];
            if (hit.count % 10 === 0) writeAlert({ t: now, code, level, message: hit.message, count: hit.count });
        } else {
            const row = { code, level, message: String(message).slice(0, 300), at: now, count: 1 };
            this.alerts.unshift(row);
            if (this.alerts.length > MAX_ALERTS) this.alerts.pop();
            this.counters.alerts += 1;
            writeAlert({ t: now, ...row });
        }
        return this.alerts[0];
    },
    clearAlert(code) {
        const before = this.alerts.length;
        this.alerts = this.alerts.filter((a) => a.code !== code);
        return this.alerts.length !== before;
    },
    clearAlerts() {
        this.alerts = [];
    },
    hasAlert(code) {
        return this.alerts.some((a) => a.code === code);
    },

    // ---------- 发送健康度 ----------
    noteFocusFail() {
        this.sendHealth.focusFails += 1;
        this.sendHealth.lastFocusFailAt = Date.now();
        // 连续 3 次以上基本可以断定：锁屏、被全屏程序占用、或窗口被收进托盘
        if (this.sendHealth.focusFails === 3 || this.sendHealth.focusFails % 20 === 0) {
            this.alert(
                "send-focus",
                "error",
                `连续 ${this.sendHealth.focusFails} 次无法把 bot 窗口切到前台（锁屏 / 全屏程序 / 窗口收进托盘？）`
            );
        }
    },
    noteFocusOk() {
        if (this.sendHealth.focusFails >= 3) this.clearAlert("send-focus");
        this.sendHealth.focusFails = 0;
    },
    noteUnconfirmed() {
        this.sendHealth.unconfirmed += 1;
        this.sendHealth.lastUnconfirmedAt = Date.now();
        this.alert("send-unconfirmed", "error", "发送后输入框仍有内容：消息可能没发出去，请在 QQ 里确认");
    },

    // ---------- 接收健康度 ----------
    snapshotOk() {
        this.receiverHealth.snapshotFails = 0;
        this.receiverHealth.snapshotFailStreak = 0;
        this.receiverHealth.lastSnapshotOkAt = Date.now();
        if (this.hasAlert("recv-snapshot")) this.clearAlert("recv-snapshot");
    },
    snapshotFail(reason) {
        const h = this.receiverHealth;
        h.snapshotFails += 1;
        h.snapshotFailStreak += 1;
        h.lastSnapshotError = String(reason).slice(0, 300);
        // 偶发一次无所谓（WAL checkpoint 会短暂锁库），连续才值得报
        if (h.snapshotFailStreak === 5) {
            this.alert("recv-snapshot", "error", `连续 5 次读不到通知库：${h.lastSnapshotError} -> 现在收不到任何消息`);
        }
    }
};

export function snapshot() {
    return {
        pid: process.pid,
        startedAt: runtime.startedAt,
        uptimeMs: Date.now() - runtime.startedAt,
        node: process.version,
        counters: { ...runtime.counters },
        lastEvent: runtime.lastEvent,
        lastReply: runtime.lastReply,
        lastLlm: runtime.lastLlm,
        lastSkip: runtime.lastSkip || null,
        lastError: runtime.lastError || null,
        receiver: { ...runtime.receiver },
        receiverHealth: { ...runtime.receiverHealth },
        sendHealth: { ...runtime.sendHealth },
        pidScan: { ...runtime.pidScan },
        actions: runtime.actions,
        alerts: runtime.alerts
    };
}
