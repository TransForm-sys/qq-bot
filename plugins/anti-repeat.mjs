// 防重复：同一个会话里短时间内出现高度相似的回复就丢掉，避免复读机。
// 阈值可用环境变量调整：REPEAT_THRESHOLD=0.9
export const meta = {
    title: "防重复回复",
    description: "同一会话里短时间内不重复说同样的话（相似度超过阈值就丢弃这条回复）",
    version: "1.0.0"
};

const THRESHOLD = Number(process.env.REPEAT_THRESHOLD || 0.86);
const WINDOW_MS = 10 * 60 * 1000;
const KEEP = 6;

const norm = (s) =>
    String(s)
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]/gu, "")
        .slice(0, 400);

function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
}

function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const x of A) if (B.has(x)) hit++;
    return (2 * hit) / (A.size + B.size);
}

export function setup(ctx) {
    const keyOf = (evt) => (evt.kind === "group" ? `g:${evt.groupName || evt.groupId}` : `p:${evt.peerUin}`);

    return {
        async afterReply({ evt, reply }) {
            const key = keyOf(evt);
            const store = ctx.kv.get("recent", {});
            const list = (store[key] || []).filter((x) => Date.now() - x.t < WINDOW_MS);
            const cur = norm(reply);
            const dup = list.find((x) => similarity(cur, x.n) >= THRESHOLD);
            if (dup) {
                ctx.log(`回复与 ${Math.round((Date.now() - dup.t) / 1000)}s 前那条过于相似，丢弃`);
                return "";
            }
            list.push({ n: cur, t: Date.now(), text: String(reply).slice(0, 80) });
            store[key] = list.slice(-KEEP);
            ctx.kv.set("recent", store);
            return reply;
        }
    };
}
