// 发送适配器：纯 UI 自动化（搜索会话 -> 双击打开 -> 粘贴 -> 点发送），零注入。
//
// 发送回执（消除 R-59 "假成功"）：
//   点发送前后各截一次输入框区域，比较"墨迹量"。发送成功 QQ 会清空输入框，墨迹骤降；
//   如果墨迹基本没变，说明点击落空（窗口移位/焦点丢失/QQ 卡顿），此时重点一次发送，
//   仍不通过就标记失败并告警，绝不假装成功。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./config.ts";
import { runtime } from "./runtime.ts";
import { readBmp, inkStats, diffPixels, blueRatio } from "./imgprobe.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tools = path.join(root, "tools");

function ps(script, args, sta = false) {
    return new Promise((resolve, reject) => {
        const a = ["-NoProfile", "-ExecutionPolicy", "Bypass"];
        if (sta) a.push("-STA");
        a.push("-File", path.join(tools, script), ...args);
        const p = spawn("powershell", a, { windowsHide: true });
        let out = "";
        let err = "";
        p.stdout.on("data", (c) => (out += c));
        p.stderr.on("data", (c) => (err += c));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${script} exit ${code}: ${err || out}`))));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 窗口内比例坐标（基于 1178x914 实测）
const R = {
    search: [0.14, 0.071],
    firstResult: [0.183, 0.17],
    input: [0.594, 0.897],
    send: [0.9295, 0.964]
};

// 输入区探测带（用于"文字到底进没进输入框"的判定）。
//
// 这里踩过两个坑，记下来免得再犯：
//   1. 按窗口高度百分比标定会随窗口尺寸漂（输入区不是等比缩放的）；
//   2. 换成"从底边量固定像素"仍然会漂 —— QQ 的占位符是**垂直居中**的，而输入的文字是
//      **顶部对齐**的。960x640 实测：工具栏 rel y 444~461，文字 478~489，占位符 522~537。
//      任何窄条都可能压在两者之间的空白上（实测两个状态都是 ink=0）。
// 所以：直接框住整块输入区（工具栏下沿到发送按钮上沿），判定改用**像素差分**，
// 不依赖文字落在第几行。实测两种窗口都能覆盖：960x640 -> rel 450~590；
// 1178x914 -> rel 724~864（同一公式 bottomPx 只跟底边有关）。
// 右边留出 0.84W 是为了避开蓝色发送按钮，避免鼠标悬停改变它的亮度造成假差分。
const PROBE = { left: 0.28, width: 0.56, bottomPx: 190, heightPx: 140 };
// 蓝色「发送」按钮：底部锚定（底距 17~48 像素，实测两种窗口一致）。
// 它的存在 = 聊天面板真的打开了；这是比"输入框有没有字"稳得多的结构信号。
const SEND_BTN = { left: 0.86, width: 0.13, bottomPx: 50, heightPx: 34 };
const MIN_BLUE_RATIO = 0.08;
// 粘贴后"变了多少像素"才算文字真的进了输入框。光标闪烁约 40px，所以下限取 90；
// 同时用两次空态截图量出的噪声自适应抬高（见 noise 变量），避免闪烁被当成粘贴成功。
const MIN_CHANGED_PX = 90;

let chain = Promise.resolve();
let lastTarget = null;
let lastPid = "";

// QQ 重启后 pid 会变，之前的"会话已打开"假设全部失效 —— 必须清掉 lastTarget，
// 否则会直接把回复粘贴进当前碰巧打开的另一个会话。
function currentPid() {
    try {
        return fs.readFileSync(path.join(root, "data", "bot-pid.txt"), "utf8").trim();
    } catch {
        return "";
    }
}

// ui-rect 现在可能返回 ERR_* 错误码（fail-closed）。任何非 "L T W H" 的输出都必须中止发送，
// 绝不能带着 NaN 坐标继续点鼠标 —— 那会点进别的窗口/别的 QQ 账号。
async function rectOnce() {
    let s;
    try {
        s = (await ps("ui-rect.ps1", [])).trim();
    } catch (e) {
        const msg = String(e.message || e);
        // 连续前台化失败是"锁屏 / 全屏程序占用 / 窗口进托盘"的间接指标（R-30）
        if (/ERR_FOCUS_FAILED|ERR_BOT_WINDOW_MISSING|ERR_WINDOW_TOO_SMALL/.test(msg)) runtime.noteFocusFail();
        if (/ERR_BOT_PID_GONE|ERR_BOT_PID_NOT_QQ|ERR_NO_BOTPID|ERR_BAD_BOTPID/.test(msg)) {
            runtime.alert("send-binding", "error", `窗口绑定失效：${msg.slice(0, 160)} -> 重跑 tools\\recover.ps1（或双击启动器）`);
        }
        throw e;
    }
    const parts = s.split(/\s+/);
    if (parts.length !== 4) {
        if (/^ERR_/.test(s)) runtime.noteFocusFail();
        throw new Error(`ui-rect refused: ${s || "(empty output)"}`);
    }
    const [l, t, w, h] = parts.map(Number);
    if (![l, t, w, h].every(Number.isFinite)) throw new Error(`ui-rect bad output: ${s}`);
    if (w < 480 || h < 360) throw new Error(`ui-rect window too small: ${w}x${h}`);
    runtime.noteFocusOk();
    return { l, t, w, h };
}

// 窗口被收进托盘（R-02）时 ui-rect 会 ERR_BOT_WINDOW_MISSING。这一步**零点击**，
// 所以恢复窗口后重试是安全的，不会重复发送。冷却 20s，避免每条消息都去戳托盘。
const RESTORE_COOLDOWN_MS = 20000;
const RESTORABLE = /ERR_BOT_WINDOW_MISSING|ERR_NO_BOT_WINDOW|ERR_WINDOW_TOO_SMALL|ERR_FOCUS_FAILED|ERR_WINDOW_VANISHED/;
let lastRestoreAt = 0;

async function restoreBotWindow(label) {
    const now = Date.now();
    if (now - lastRestoreAt < RESTORE_COOLDOWN_MS) return false;
    lastRestoreAt = now;
    try {
        const out = (await ps("ui-restore.ps1", ["-Yes"])).trim();
        const last = out.split(/\r?\n/).filter(Boolean).pop() || "";
        console.log(`[send] 窗口不可用(${label})，已尝试恢复：${last.slice(0, 120)}`);
        await sleep(400);
        return true;
    } catch (e) {
        console.error(`[send] 恢复窗口失败(${label})：${String(e.message || e).slice(0, 160)}`);
        return false;
    }
}

// 发送收尾：把 QQ 主窗口最小化。
// 为什么必须做：QQ 只在「自己不是前台、且窗口状态是**最小化**」时才发系统通知。
// 实测（2026-11-18，QQ 9.9.37）：
//   * 窗口在前台           -> 不发通知（聊天窗口开着，QQ 认为你正在看）
//   * SW_HIDE 隐藏到托盘   -> 依然不发（这是最坑的一条，之前一直用隐藏，白等了一晚上）
//   * SW_MINIMIZE 最小化   -> 正常发（toast 立刻进库）
// 而接收路径（R3）完全依赖通知，所以每次发送后必须把窗口收回最小化状态。
async function parkWindow() {
    try {
        const out = (await ps("ui-restore.ps1", ["-Minimize"])).trim();
        const last = out.split(/\r?\n/).filter(Boolean).pop() || "";
        if (/^MINIMIZED/.test(last)) console.log(`[send] 窗口已最小化（${last.slice(0, 40)}）`);
        else console.log(`[send] 最小化窗口未生效：${last.slice(0, 100)}`);
        // 是我们自己藏起来的，就别让恢复冷却挡住下一条消息的恢复
        lastRestoreAt = 0;
        return true;
    } catch (e) {
        console.log(`[send] 收回窗口失败：${String(e.message || e).slice(0, 120)}`);
        return false;
    }
}

async function rect() {
    try {
        return await rectOnce();
    } catch (e) {
        const msg = String(e.message || e);
        if (!RESTORABLE.test(msg)) throw e;
        const label = (msg.match(/ERR_[A-Z_]+/) || ["window-unusable"])[0];
        if (!(await restoreBotWindow(label))) throw e;
        // 恢复后再争取一次；仍失败就让调用方按原错误处理（此时已累加 focusFail 计数）
        return await rectOnce();
    }
}

// ── 发送时机闸门 ────────────────────────────────────────────────────────────
// UI 自动化的代价是"必须抢前台 + 移动光标"。在用户正用着电脑时抢，体验极差
// （打字被吞、鼠标被拽走）。所以真正发出去之前先问一句：现在能打扰吗？
//
//   * 用户已经连续 idleMs 没碰键鼠            -> 可以发（他不在，抢了也看不见）
//   * bot 的 QQ 窗口本来就在前台              -> 可以发（没额外打扰）
//   * 否则                                    -> 等，直到满足上面任一条
//
// 等待期间消息留在队列里（send 是串行链，后来的消息排在后面），不会丢。
// 超过 maxWaitMs 仍然强行发 —— 一直不发比"打扰一下"更糟。
async function gateOnce() {
    const out = (await ps("ui-gate.ps1", [])).trim();
    const idle = Number((out.match(/idle=(\d+)/) || [])[1] || 0);
    const fg = /fg=1/.test(out);
    return { idle, fg };
}

async function waitForIdleGate() {
    const cfg = store.get();
    const idleMs = cfg.reply?.sendIdleMs ?? 0;
    if (!idleMs) return; // 闸门关闭
    const maxWait = cfg.reply?.sendMaxWaitMs ?? 0;
    const t0 = Date.now();
    let waited = false;
    for (;;) {
        let g;
        try {
            g = await gateOnce();
        } catch (e) {
            // 闸门脚本自己出错不应该拦住发送（否则一个脚本 bug 会让 bot 永久哑掉）
            console.log("[send] 空闲检测失败，跳过闸门:", String(e).slice(0, 120));
            return;
        }
        if (g.fg || g.idle >= idleMs) {
            if (waited) console.log(`[send] 闸门放行（idle=${Math.round(g.idle / 1000)}s fg=${g.fg}）`);
            return;
        }
        if (maxWait > 0 && Date.now() - t0 >= maxWait) {
            const human = maxWait < 60000 ? `${Math.round(maxWait / 1000)} 秒` : `${Math.round(maxWait / 60000)} 分钟`;
            runtime.alert("send-forced", "warn", `用户一直在用电脑，等了 ${human} 仍未空闲，已强行发送`);
            console.log(`[send] 闸门超时（${human}），强行发送`);
            return;
        }
        if (!waited) {
            waited = true;
            console.log(`[send] 用户正在用电脑（idle=${Math.round(g.idle / 1000)}s），排队等待空闲…`);
        }
        await sleep(5000);
    }
}

async function click(r, ratio, double = false) {
    const x = Math.round(r.l + r.w * ratio[0]);
    const y = Math.round(r.t + r.h * ratio[1]);
    await ps("ui-click.ps1", ["-X", String(x), "-Y", String(y), ...(double ? ["-Double"] : [])]);
}

async function paste(text, enter = false) {
    await ps("ui-paste.ps1", ["-Text", text, ...(enter ? ["-Enter"] : "")], true);
}

// 便宜版前台确认：只花一次 ui-focus-ok（~1.1s）。已经在前台就直接返回，
// 不在前台才走完整的 ensureFocus（ui-rect 内部 SetForegroundWindow + 校验）。
// 用在"只读探测"之前 —— 那些地方抢错了没有破坏性，但抢慢了会让每次回复多等 3s。
async function ensureForegroundCheap() {
    try {
        await ps("ui-focus-ok.ps1", []);
        return true;
    } catch {
        return await ensureFocus();
    }
}

// 点击/粘贴之前必须确认前台仍然是 bot 窗口。
// 少了这一步，只要有别的窗口弹上来（通知、更新提示、用户切窗），
// 我们就会把文字粘进别人的输入框、甚至点到别人的按钮 —— 比"掉线"危险得多。
async function ensureFocus() {
    try {
        await ps("ui-focus-ok.ps1", []);
        return true;
    } catch (e) {
        const msg = String(e.message || e);
        if (/ERR_FOCUS_LOST|ERR_NO_FOREGROUND/.test(msg)) {
            // 别的窗口把前台抢走了（播放器、悬浮窗、通知、用户切窗）。这在实际使用里
            // 很常见，直接丢消息太浪费 —— 先把 bot 窗口重新提到前台再试一次，
            // 仍拿不到前台才中止。重试发生在"点击/粘贴之后可能"的位置，所以只重试
            // 前台化本身，绝不重跑整个发送流程（那会把文字粘贴两遍）。
            try {
                await ps("ui-rect.ps1", []); // 内部 SetForegroundWindow + 校验句柄
                await sleep(120);
                await ps("ui-focus-ok.ps1", []);
                return true;
            } catch {
                runtime.noteFocusFail();
                throw new Error(`FOCUS_LOST 发送前前台已不是 bot 窗口，已中止（不会盲点）：${msg.slice(0, 160)}`);
            }
        }
        if (/ERR_BOT_PID_GONE|ERR_NO_BOT_WINDOW|ERR_NO_BOTPID|ERR_BAD_BOTPID/.test(msg)) {
            runtime.alert("send-binding", "error", `窗口绑定失效：${msg.slice(0, 160)} -> 重跑 tools\\recover.ps1（或双击启动器）`);
        }
        throw e;
    }
}

// 截某块区域，同时给出"墨迹量"和"蓝色占比"；失败返回 null（校验不可用时不应该阻塞发送）
// 区域既支持按窗口比例的 top/height，也支持从窗口底边算起的 bottomPx/heightPx
// （后者用于底部锚定的输入框/发送按钮，换窗口尺寸不会漂）。
async function shot(r, area, tag) {
    try {
        const dir = path.join(root, "data", "ui");
        fs.mkdirSync(dir, { recursive: true });
        const abs = path.join(dir, `probe-${tag}.bmp`);
        const x = Math.round(r.l + r.w * area.left);
        const y = area.bottomPx !== undefined
            ? Math.round(r.t + r.h - area.bottomPx)
            : Math.round(r.t + r.h * area.top);
        const w = Math.max(1, Math.round(r.w * area.width));
        const h = area.heightPx !== undefined
            ? Math.max(1, Math.round(area.heightPx))
            : Math.max(1, Math.round(r.h * area.height));
        await ps("ui-probe.ps1", ["-X", String(x), "-Y", String(y), "-W", String(w), "-H", String(h), "-Out", abs]);
        const img = readBmp(fs.readFileSync(abs));
        return { ...inkStats(img), blue: blueRatio(img), img, file: abs };
    } catch (e) {
        console.log("[send] 回执截图失败（跳过校验）:", String(e).slice(0, 120));
        return null;
    }
}

async function probeInk(r, tag) {
    return shot(r, PROBE, tag);
}

// 「聊天面板到底开了没有」—— 靠右下角那颗蓝色发送按钮判断。
// 这是本轮最重要的修：之前只看"输入框里有没有字"，一旦会话压根没打开，
// 得到的是 empty=full=0，被误判成"点击没落到输入框"，重试粘贴一百次也没用。
async function chatOpen(r) {
    const s = await shot(r, SEND_BTN, "btn");
    return Boolean(s && s.blue >= MIN_BLUE_RATIO);
}

// 搜索会话 -> 双击第一条结果 -> 验证真的打开了。
// 每一步都可能被"窗口刚恢复/QQ 正在重绘/焦点抖动"吞掉，所以整体重试一次。
async function openChat(r, target) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        await ensureFocus();
        await click(r, R.search);
        await sleep(180);
        await ensureFocus();
        await ps("ui-clear.ps1", [], true); // 清掉上一次残留的搜索词，否则结果列表会串
        await paste(target);
        await sleep(850);
        await click(r, R.firstResult, true);
        await sleep(1000);
        if (await chatOpen(r)) return true;
        // 面板还在渲染时蓝色按钮可能没画出来（真机上第 1 次经常这样）。
        // 再等 600ms 复查一次 —— 只让失败路径付这 600ms，误判一次要重跑整轮（~12s）。
        await sleep(600);
        if (await chatOpen(r)) return true;
        console.log(`[send] 第 ${attempt} 次搜索打开会话后仍然看不到聊天面板（无蓝色发送按钮）`);
        await sleep(350);
    }
    return false;
}

async function doSend(target, text) {
    // 试运行开关：只记录不点鼠标，用于离线验证整条回复链路
    if (process.env.QQBOT_DRY_SEND === "1") {
        fs.appendFileSync(
            path.join(root, "data", "dry-send.jsonl"),
            JSON.stringify({ t: Date.now(), target, text }) + "\n"
        );
        await sleep(60);
        return;
    }
    const cfg = store.get();
    const verify = cfg.reply?.verifySend !== false;
    // 校准时不动会话列表：只针对"当前已打开的会话"验证输入框区域
    const probeOnly = process.env.QQBOT_PROBE_ONLY === "1";
    // 先过闸门：这一步在 rect() 之前，所以还没抢前台、还没动光标。
    // 手动标定（probe-only）时跳过 —— 那时用户就坐在电脑前，等空闲是自相矛盾。
    if (!probeOnly) await waitForIdleGate();
    const pid = currentPid();
    if (pid !== lastPid) {
        lastTarget = null;
        lastPid = pid;
    }
    const r = await rect();

    // 一轮 = 打开会话 + 粘贴 + 取基准。判定失败（像素差分不够）时重来一轮。
    // 这里之所以敢整轮重来：所有动作都发生在"点发送"之前，重做不会造成重复发送。
    let empty = null;
    let full = null;
    let noise = 0;      // 两次空态之间的自然抖动（光标闪烁/抗锯齿）像素数
    let span = 0;       // 空态 -> 粘贴后 变了多少像素
    let changed = !verify;
    for (let round = 1; round <= 2 && !changed; round++) {
        if (!probeOnly) {
            // 判断"会话本来就开着"也要先把 QQ 提到前台：chatOpen 走的是截屏，
            // 窗口被浏览器/别的程序盖住时读到的是别人的画面 -> 判成"没打开" ->
            // 白跑一遍 openChat（最坏 4 次重试 ≈ 48s）。ensureFocus 只要 ~3s，稳赚。
            if (lastTarget) await ensureForegroundCheap();
            const alreadyOpen = lastTarget === target && (await chatOpen(r));
            if (!alreadyOpen) {
                lastTarget = null;
                if (!(await openChat(r, target))) {
                    console.log(`[send] 第 ${round} 轮没能打开与「${target}」的会话面板`);
                    continue;
                }
            }
            lastTarget = target;
        }

        // 点击之前确认前台：焦点在别的窗口时，这一下会点进别的程序里
        await ensureFocus();
        await click(r, R.input);
        await sleep(150);
        await ensureFocus();
        // 先清空再拍基准。上一轮失败的粘贴 / 上一次发送失败都会在框里留下文字，
        // 不清的话"空态基准"里带着旧文字，发送成功后反而会被判定成"没发出去"
        // （实测 back=971 全落在文字行上），更糟的是旧文字会成为本次回复的前缀。
        await ps("ui-clear.ps1", [], true);
        await sleep(160);
        // 连拍两张空态：两张之间的差异就是噪声底噪（光标闪烁约 40px），
        // 后面的判定阈值按它自适应抬高，避免把闪烁当成"粘贴成功"。
        empty = verify ? await probeInk(r, `empty${round}`) : null;
        const emptyB = verify ? await probeInk(r, `empty${round}b`) : null;
        noise = empty && emptyB ? Math.max(0, diffPixels(empty.img, emptyB.img)) : 0;
        await paste(text);
        await sleep(220);
        full = verify ? await probeInk(r, `full${round}`) : null;

        // 粘贴前后像素差分太小 = 文字压根没进输入框（会话没打开 / 点击落空 / 焦点被抢走）。
        // 不判这个的话会出现最坏情况 —— 输入框是空的，点发送什么也没发出去，代码却记成功。
        span = empty && full ? diffPixels(empty.img, full.img) : 0;
        changed = !verify || span > Math.max(MIN_CHANGED_PX, noise * 3);
        if (!changed) {
            console.log(`[send] 第 ${round} 轮粘贴后输入框几乎没变化（span=${span} noise=${noise}）`);
        }
    }

    if (verify && !changed && !probeOnly) {
        // 到这一步还没变化，可能的两种原因分开报：
        //   send-no-chat  -> 会话面板根本没打开（截图右下角没有蓝色发送按钮）
        //   send-no-input -> 面板开着，但点击/粘贴没落到输入框
        const open = await chatOpen(r);
        const code = open ? "send-no-input" : "send-no-chat";
        runtime.alert(
            code,
            "error",
            open
                ? "聊天面板已打开但输入框没收到文字：点击未落到输入框（窗口被遮挡/焦点被抢）"
                : "搜索双击后聊天面板仍打不开：找不到与目标会话对应的输入框"
        );
        throw new Error(
            `SEND_NO_${open ? "INPUT" : "CHAT"} target=${target} span=${span} noise=${noise} ` +
                `（文字没有进入输入框，已中止不点发送）`
        );
    }

    // 试跑校准：只粘贴+清空，不点发送（用于在新机器/新分辨率上标定回执区域）
    if (process.env.QQBOT_PROBE_ONLY === "1") {
        await ps("ui-clear.ps1", [], true);
        console.log(`[probe-only] noise=${noise} span=${span}（阈值 ${Math.max(MIN_CHANGED_PX, noise * 3)}）截图见 data/ui/probe-*.bmp`);
        return;
    }

    await ensureFocus();
    await click(r, R.send);
    await sleep(500);

    // 发送成功后 QQ 会清空输入框（占位符回来），所以 after 应当和空态几乎一样。
    // 反过来，after 仍明显不同于空态 = 文字还在框里 = 这一下没点出去。
    const after = await probeInk(r, "after");
    const back = after && empty ? diffPixels(empty.img, after.img) : -1;
    if (after && back >= 0 && back <= Math.max(60, span * 0.4)) {
        await sleep(120);
        return;
    }

    // 文字确实还在输入框里时才重试点击：不可能造成重复发送。
    console.log(`[send] 回执未通过（span=${span} back=${back} noise=${noise}），重试一次发送`);
    await click(r, R.send);
    await sleep(550);
    const retry = await probeInk(r, "retry");
    const back2 = retry && empty ? diffPixels(empty.img, retry.img) : -1;
    if (retry && back2 >= 0 && back2 <= Math.max(60, span * 0.4)) {
        runtime.alert("send-retried", "warn", "首次点击发送未生效，已自动重试成功");
        await sleep(100);
        return;
    }

    runtime.noteUnconfirmed();
    throw new Error(
        `SEND_UNCONFIRMED target=${target} span=${span} back=${back} back2=${back2} noise=${noise} ` +
            `(截图见 data/ui/probe-*.bmp)`
    );
}

// 串行化所有发送，避免 UI 竞态
export function send(target, text) {
    const job = chain.then(async () => {
        runtime.sendHealth.sending = true;
        runtime.sendHealth.sendingSince = Date.now();
        try {
            try {
                return await doSend(target, text);
            } catch (e) {
                const msg = String((e as any)?.message || e);
                // 重试的四种情况都保证"上一次没把消息发出去"：
                //   FOCUS_LOST / ERR_FOCUS_FAILED  -> 每一处 ensureFocus 都排在点发送之前
                //   SEND_UNCONFIRMED               -> 判据就是"输入框里还有文字"，真发出去会被清空
                //   SEND_NO_INPUT / SEND_NO_CHAT   -> 文字压根没进输入框
                //   ERR_WINDOW_VANISHED            -> 窗口刚恢复就又缩回托盘，截图全是桌面
                // 以前这里直接抛错，用户的回复就这么没了（09:33、13:07 各丢一条）。
                const retriable =
                    /FOCUS_LOST|ERR_FOCUS_FAILED|ERR_NO_FOREGROUND|ERR_WINDOW_VANISHED|SEND_UNCONFIRMED|SEND_NO_INPUT|SEND_NO_CHAT/.test(
                        msg
                    );
                if (!retriable) throw e;
                console.log(`[send] 上一轮没发出去，整轮重试：${msg.slice(0, 140)}`);
                runtime.alert("send-retry", "warn", `发送未完成，正在自动重试一次：${msg.slice(0, 120)}`);
                await sleep(600);
                return await doSend(target, text);
            }
        } finally {
            runtime.sendHealth.sending = false;
            runtime.sendHealth.lastSendAt = Date.now();
            // 成功或失败都要收回去：失败时窗口同样停在前台，通知一样不会来。
            if (store.get().reply?.parkWindowAfterSend !== false) await parkWindow();
        }
    });
    chain = job.catch(() => {});
    return job;
}

// 启动时也收一次：recover.ps1 -RestoreWindow 会把窗口摆到前台，
// 在第一次发送之前一直占着前台，期间的消息全收不到。
export async function parkIfConfigured() {
    if (store.get().reply?.parkWindowAfterSend === false) return false;
    return await parkWindow();
}

export function resetTarget() {
    lastTarget = null;
}
