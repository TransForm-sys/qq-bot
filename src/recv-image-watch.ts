// 图片的第二条接收通道：直接盯 QQ 的本地缩略图目录。
//
// 为什么需要这条通道：
//   通知（R3）对图片消息并不可靠。实测 2026-11-18 13:34:19 用户发了一张图，
//   通知库里没有任何 QQ 记录（前后两条文字的 toast 都在，唯独图没有），
//   bot 只看到后面那句"你能看见这个图吗"，于是老老实实回"看不见"。
//   而 NTQQ 收到图一定会把缩略图落到本地，所以盯文件比等通知稳。
//
// 代价：缩略图文件名只有 md5，没有 peer 信息。所以用"最近一条入站消息"
// 推断该回给谁（见 inbound-context.ts）—— 人的习惯就是发完图紧跟着打字。
import { recentThumbs, isSeen, markSeen } from "./recv-image.ts";
import { lastInbound } from "./inbound-context.ts";

const TICK_MS = 2000;
const SCAN_WINDOW_MS = 30000; // 只看 30 秒内落盘的文件
const BOOT_GRACE_MS = 120000; // 启动时补看最近 2 分钟的图（重启不丢刚发的图）
const MIN_BYTES = 12 * 1024; // 太小的多半是表情/贴纸缩略，忽略
const SETTLE_MS = 500; // 等 QQ 把文件写完
const ORPHAN_MS = 45000; // 找不到会话身份时最多等这么久，超了就丢弃

export function startImageWatcher(cfgLive, onEvent) {
    const startedAt = Date.now();
    let stopped = false;
    let busy = false;

    console.log(`[img-watch] 已启动：每 ${TICK_MS}ms 扫一次缩略图目录`);

    const timer = setInterval(() => {
        void tick();
    }, TICK_MS);
    timer.unref?.();

    async function tick() {
        if (stopped || busy) return;
        busy = true;
        try {
            const cfg = cfgLive || {};
            if (cfg.imageWatch === false) return;
            const uin = String(cfg.botUin || "");
            if (!uin) return;

            const now = Date.now();
            const rows = recentThumbs(uin, now, SCAN_WINDOW_MS);
            if (!rows.length) return;

            // 从旧到新处理，连发多图时顺序才对
            for (const row of rows.slice().reverse()) {
                if (stopped) return;
                if (row.mtime > now) continue; // 时钟异常
                if (now - row.mtime < SETTLE_MS) continue; // 可能还在写
                if (row.mtime < startedAt - BOOT_GRACE_MS) continue;
                if (row.size < MIN_BYTES) continue;
                if (isSeen(row.base)) continue;

                // 优先用"最近的会话"；实在没有（比如对方只发图不说话、或者刚重启过很久）
                // 就退回到最后一条已知入站消息 —— 宁可推测归属，也别把图默默丢掉，
                // 丢掉的代价是对方问"你能看见吗"而我们回"看不见"。
                const ref = lastInbound(Number(cfg.imageWatchWindowMs ?? 600000)) || lastInbound(Infinity);
                if (!ref) {
                    if (now - row.mtime < ORPHAN_MS) continue; // 等对方把话说完
                    markSeen(row.base);
                    console.log(`[img-watch] ${row.name} 没有可归属的会话，已丢弃`);
                    continue;
                }

                markSeen(row.base);
                console.log(
                    `[img-watch] 新图片 ${row.name}（${Math.round(row.size / 1024)}KB）-> ${
                        ref.kind === "group" ? ref.groupName : ref.peerName
                    }`
                );
                try {
                    onEvent({
                        dir: "in",
                        selfUin: ref.selfUin || uin,
                        kind: ref.kind,
                        peerUin: ref.peerUin,
                        peerName: ref.peerName,
                        groupId: ref.groupId,
                        groupName: ref.groupName,
                        senderUin: ref.senderUin,
                        senderName: ref.senderName,
                        atMe: ref.atMe,
                        text: "[图片]",
                        msgId: `img-${row.base.slice(0, 10)}`,
                        time: row.mtime,
                        imagePath: row.path,
                        previewOnly: true,
                        via: "thumb-watch"
                    });
                } catch (e) {
                    console.log(`[img-watch] 派发失败: ${String(e).slice(0, 140)}`);
                }
            }
        } catch (e) {
            console.log(`[img-watch] 扫描异常: ${String(e).slice(0, 140)}`);
        } finally {
            busy = false;
        }
    }

    return {
        stop() {
            stopped = true;
            clearInterval(timer);
        }
    };
}
