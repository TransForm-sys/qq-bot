// 链接摘要：消息里带 URL 时抓一下页面标题和正文开头，作为背景注入上下文，
// 这样模型不用瞎猜链接内容。抓取失败就静默跳过，不影响正常回复。
export const meta = {
    title: "链接读取",
    description: "消息里出现链接时自动抓取标题与正文开头，注入上下文帮助模型回答",
    version: "1.0.0"
};

const MAX_BYTES = 400 * 1024;
const TIMEOUT_MS = 8000;

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}

async function fetchPage(url) {
    const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; qq-bot link reader)", accept: "text/html,*/*" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow"
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!/text\/html|text\/plain/i.test(type)) throw new Error(`unsupported ${type}`);
    const raw = await res.text();
    const html = raw.slice(0, MAX_BYTES);
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").trim();
    const body = stripHtml(html).slice(0, 1200);
    return { title: stripHtml(title), body };
}

export function setup(ctx) {
    return {
        async beforeReply({ evt, messages }) {
            const urls = [...String(evt.text || "").matchAll(/https?:\/\/[^\s，。！？、"'<>]+/g)].map((m) => m[0]);
            if (!urls.length) return messages;
            const url = urls[0].slice(0, 500);
            try {
                const { title, body } = await fetchPage(url);
                if (!body) return messages;
                ctx.log("已读取链接:", title || url);
                const note = {
                    role: "system",
                    content: `[链接背景] 用户分享了 ${url}\n标题：${title || "(无)"}\n正文摘录：${body}\n回答时可以自然引用这些信息，但不要逐字复述整段。`
                };
                return [...messages.slice(0, -1), note, messages[messages.length - 1]];
            } catch (e) {
                ctx.log("链接读取失败，跳过:", String(e).slice(0, 80));
                return messages;
            }
        }
    };
}
