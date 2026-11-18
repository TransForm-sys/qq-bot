// 让引擎把一句话当成"刚收到的一条私聊"，走完整条链路并真的发出回复。
// 用来验证：联网、看图、插件这些改动在真实链路里是否生效（会真的发一条 QQ 消息）。
//
//   BOT_TEST_PEER=张三 node tools/test-ask.mjs "TGA 2026 入围名单出了吗"
// （PowerShell: $env:BOT_TEST_PEER="张三"; node tools/test-ask.mjs "…"）
// 必须给 BOT_TEST_PEER（好友昵称或 QQ 号），否则不知道回给谁 —— 故意不设默认值，
// 免得手一滑把测试消息发给陌生人。
import { store } from "../src/config.ts";
import { plugins } from "../src/plugins.ts";
import { createEngine } from "../src/engine.ts";

const text = process.argv.slice(2).join(" ").trim();
const peer = String(process.env.BOT_TEST_PEER || "").trim();
if (!text || !peer) {
    console.log('用法: BOT_TEST_PEER="好友昵称或QQ号" node tools/test-ask.mjs "要问的话"');
    process.exit(1);
}
const isUin = /^\d+$/.test(peer);

const cfg = store.load();
await plugins.loadAll();
const engine = createEngine();
const t0 = Date.now();

await engine.handle({
    dir: "in",
    selfUin: String(cfg.botUin),
    kind: "private",
    peerUin: isUin ? peer : "",
    peerName: isUin ? "" : peer,
    groupId: "",
    groupName: "",
    senderUin: isUin ? peer : "",
    senderName: isUin ? "" : peer,
    atMe: false,
    text,
    msgId: "probe-ask-" + Date.now(),
    time: Date.now(),
    previewOnly: true
});

console.log(`[test] 链路结束，用时 ${Date.now() - t0}ms`);
process.exit(0);
