// 最近一条"收到的消息"的身份（谁发的、哪个会话）。
//
// 为什么需要：图片走的是"缩略图监视"这条独立通道（见 recv-image-watch.ts），
// 而缩略图文件名里只有 md5，没有 peer 信息。要知道这张图该回给谁，
// 只能借最近一条入站消息的会话身份 —— 正常人的操作就是"发图 + 紧接着打字"，
// 所以这个近似足够稳。
import fs from "node:fs";

export type InboundRef = {
    at: number;
    selfUin: string;
    kind: "private" | "group";
    peerUin: string;
    peerName: string;
    groupId: string;
    groupName: string;
    senderUin: string;
    senderName: string;
    atMe: boolean;
};

let last: InboundRef | null = null;

export function noteInbound(evt) {
    if (!evt || evt.dir !== "in") return;
    last = {
        at: evt.time || Date.now(),
        selfUin: String(evt.selfUin || ""),
        kind: evt.kind === "group" ? "group" : "private",
        peerUin: String(evt.peerUin || ""),
        peerName: String(evt.peerName || ""),
        groupId: String(evt.groupId || ""),
        groupName: String(evt.groupName || ""),
        senderUin: String(evt.senderUin || evt.peerUin || ""),
        senderName: String(evt.senderName || evt.peerName || ""),
        atMe: !!evt.atMe
    };
}

export function lastInbound(maxAgeMs = 180000): InboundRef | null {
    if (!last) return null;
    if (Date.now() - last.at > maxAgeMs) return null;
    return last;
}

// 进程启动时用 bot.jsonl 里的最后一条入站消息预热。
// 为什么需要：重启后内存里没有任何会话身份，此时若对方马上发图，
// 缩略图通道就不知道回给谁，只能把图丢掉。用日志里的真实历史预热即可。
export function seedFromLog(file: string, readLines = 200) {
    try {
        if (!fs.existsSync(file)) return null;
        const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-readLines);
        for (let i = lines.length - 1; i >= 0; i--) {
            let j: any;
            try {
                j = JSON.parse(lines[i]);
            } catch {
                continue;
            }
            if (j.dir !== "in" || !j.text) continue;
            if (j.via === "thumb-watch") continue;
            noteInbound(j);
            return last;
        }
    } catch {
        /* 预热失败不影响主流程 */
    }
    return null;
}
