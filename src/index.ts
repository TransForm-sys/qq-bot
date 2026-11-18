// 入口：配置 -> 插件 -> 接收轮询 -> 引擎 -> UI 发送，同时起 WebUI 控制台。
import path from "node:path";
import { ROOT, store } from "./config.ts";
import { createEngine } from "./engine.ts";
import { startReceiver } from "./recv-db.ts";
import { startNotifyReceiver } from "./recv-notify.ts";
import { startImageWatcher } from "./recv-image-watch.ts";
import { seedFromLog } from "./inbound-context.ts";
import { plugins } from "./plugins.ts";
import { startWebui } from "./webui.ts";
import { runtime } from "./runtime.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { parkIfConfigured } from "./send-ui.ts";

// 接收器拿到的是 live 视图：配置热更新后无需重启进程，下一轮 tick 就用新值
const live = new Proxy({}, { get: (_, key) => store.get()[key] });

let receiver = null;
let receiverSig = "";

function bootReceiver() {
    const cfg = store.get();
    const mode = cfg.receive === "db" ? "db" : "notify";
    const fn = mode === "notify" ? startNotifyReceiver : startReceiver;
    try {
        receiver = fn(live, (evt) => engine.handle(evt));
        runtime.receiver = { mode, startedAt: Date.now() };
        receiverSig = `${mode}:${cfg.receiveIntervalMs}`;
        console.log(`[bot] 接收器 ${mode} 已启动，间隔 ${cfg.receiveIntervalMs}ms`);
    } catch (e) {
        console.error("[bot] 接收器启动失败:", String(e).slice(0, 300));
        runtime.error("receiver", e);
    }
}

const cfg0 = store.load();
await plugins.loadAll();
const engine = createEngine();

console.log(`[bot] botUin=${cfg0.botUin || "(未设置)"} groups=${(cfg0.reply.groups || []).join(",") || "(无)"}`);
console.log(`[bot] 模型默认=${cfg0.models.default || "(未配置)"} 厂商=${cfg0.providers.length} 人设=${cfg0.personaFile}`);
if (!cfg0.providers.some((p) => p.apiKey || /127\.0\.0\.1|localhost/.test(p.baseURL))) {
    console.log(`[bot] 提示：还没有可用的 API Key，打开 http://${cfg0.webui.host}:${cfg0.webui.port} 配置`);
}

bootReceiver();

// 图片的第二条接收通道：QQ 对图片消息经常不发系统通知（实测 2026-11-18 13:34），
// 所以另外盯 QQ 的本地缩略图目录，图片一到就当作一条 [图片] 消息处理。
// 缩略图文件名里没有 peer，只能靠"最近一条入站消息"定位会话，启动时先用日志预热。
seedFromLog(path.join(ROOT, "data", "bot.jsonl"));
startImageWatcher(live, (evt) => engine.handle(evt));

// 接收间隔/模式改了要重建定时器，其它配置引擎每条消息现读，不用重启
store.on((cfg) => {
    const sig = `${cfg.receive}:${cfg.receiveIntervalMs}`;
    if (sig !== receiverSig) {
        receiver?.stop?.();
        bootReceiver();
    }
});

startWebui({
    onRestartReceiver: async () => {
        receiver?.stop?.();
        bootReceiver();
        return { mode: runtime.receiver.mode };
    }
});

// 心跳：给 watchdog 判断"进程活着但事件循环卡死/系统睡过"用
startHeartbeat();

// 启动后把 QQ 窗口收回托盘。recover.ps1 -RestoreWindow 会把它摆到前台，
// 而 QQ 在窗口处于前台时不产生系统通知 —— 接收路径全靠通知，不收回去就一直聋。
setTimeout(() => {
    parkIfConfigured().catch(() => {});
}, 6000);

process.on("unhandledRejection", (e) => {
    console.error("[bot] unhandledRejection:", String(e).slice(0, 300));
    runtime.error("unhandled", e);
});
process.on("uncaughtException", (e) => {
    console.error("[bot] uncaughtException:", String(e).slice(0, 300));
    runtime.error("uncaught", e);
});
