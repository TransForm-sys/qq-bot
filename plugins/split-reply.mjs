// 长回复自动分条：像真人一样把一大段拆成 2-3 条短消息发出去。
// 条数上限取 config.reply.splitSegments；短于 40 字不拆。
export const meta = {
    title: "分段发送",
    description: "把长回复按句子拆成多条短消息发送，更像真人；条数上限在「回复」页配置",
    version: "1.0.0"
};

function splitSentences(text) {
    const parts = String(text)
        .replace(/\r/g, "")
        .split(/(?<=[。！？!?…~～\n])\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    return parts.length > 1 ? parts : [String(text).trim()];
}

function pack(parts, max) {
    // 贪心合并：每段尽量接近平均长度，避免一条只剩两三个字
    const total = parts.join("").length;
    const target = Math.max(12, Math.ceil(total / max));
    const out = [];
    let buf = "";
    for (const p of parts) {
        if (buf && buf.length + p.length > target && out.length < max - 1) {
            out.push(buf);
            buf = p;
        } else {
            buf += p;
        }
    }
    if (buf) out.push(buf);
    return out;
}

export function setup(ctx) {
    return {
        async afterReply({ reply }) {
            const cfg = ctx.cfg().reply || {};
            const maxSeg = Math.max(1, Number(cfg.splitSegments || 1));
            const text = String(reply || "").trim();
            if (maxSeg <= 1 || text.length < 40) return reply;
            const parts = splitSentences(text);
            if (parts.length < 2) return reply;
            const segments = pack(parts, maxSeg);
            if (segments.length < 2) return reply;
            return { text, segments };
        }
    };
}
