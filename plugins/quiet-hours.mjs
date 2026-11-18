// 免打扰时段：在设定时间段内完全不回复（消息照常记录，只是不打扰）。
// 时段跨零点也支持（例如 23:30 -> 08:00）。
export const meta = {
    title: "免打扰时段",
    description: "在设定时间段内不回复消息（支持跨零点），时段在「回复」页配置",
    version: "1.0.0"
};

function atMinutes(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}

export function setup(ctx) {
    return {
        async onMessage(evt) {
            const q = ctx.cfg().reply?.quietHours;
            if (!q?.enabled) return true;
            const now = new Date();
            const cur = now.getHours() * 60 + now.getMinutes();
            const start = atMinutes(q.start);
            const end = atMinutes(q.end);
            const inside = start <= end ? cur >= start && cur < end : cur >= start || cur < end;
            if (inside) {
                ctx.log(`免打扰中 ${q.start}-${q.end}，跳过 ${evt.senderName}: ${evt.text.slice(0, 30)}`);
                return false;
            }
            return true;
        }
    };
}
