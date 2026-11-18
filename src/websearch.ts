// 联网搜索：给模型一个"现查"的能力，避免它对新闻/版本/价格这类会过时的东西瞎编。
//
// 为什么不用 API Key 的方案当默认：
//   这个 bot 部署在国内的 VM 上，能直连的搜索只有 cn.bing.com（实测 238ms/9 条结果），
//   DuckDuckGo 直接连不上。所以默认走 Bing 的 HTML 结果页，零依赖零费用；
//   有 Tavily / Serper / Bocha 的 key 时优先用它们（返回结构更干净）。
//
// 安全边界：只发 GET 请求、只读文本，不登录、不带任何本机信息。
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 结果缓存：同一条消息里模型可能重复搜同一个词，没必要打两次网
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

function cacheGet(k) {
    const hit = cache.get(k);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL) {
        cache.delete(k);
        return null;
    }
    return hit.v;
}

function cacheSet(k, v) {
    cache.set(k, { at: Date.now(), v });
    if (cache.size > 60) cache.delete(cache.keys().next().value);
}

function decodeEntities(s) {
    return String(s)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&ensp;/g, " ")
        .replace(/&emsp;/g, " ")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, "&");
}

function stripTags(s) {
    return decodeEntities(String(s).replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}

// Bing 的跳转链接长这样：/ck/a?...&u=a1aHR0cHM6Ly8...&ntb=1
// u 参数是 "a1" + base64url(真实 URL)，解出来才是干净地址。
function unwrapBingUrl(href) {
    let h = decodeEntities(href || "");
    if (h.startsWith("/")) h = "https://cn.bing.com" + h;
    const m = /[?&]u=a1([A-Za-z0-9_\-=]+)/.exec(h);
    if (m) {
        try {
            const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
            const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
            const url = Buffer.from(b64 + pad, "base64").toString("utf8");
            if (/^https?:\/\//i.test(url)) return url;
        } catch {
            /* 解不出来就用原链接 */
        }
    }
    return h;
}

// Bing 结果页的每一条都在 <li class="b_algo"> 里：
//   <h2><a href="...">标题</a></h2> ... <p class="b_lineclamp...">摘要</p>
export function parseBing(html, limit = 5) {
    const out = [];
    const blocks = String(html).split(/<li class="b_algo"/i).slice(1);
    for (const b of blocks) {
        if (out.length >= limit) break;
        const t = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
        if (!t) continue;
        const url = unwrapBingUrl(t[1]);
        const title = stripTags(t[2]);
        if (!title || !/^https?:\/\//i.test(url)) continue;
        // 摘要优先取 b_lineclamp（Bing 的截断摘要），没有就取第一个像样的 <p>
        let snippet = "";
        const p1 = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(b);
        const p2 = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b);
        snippet = stripTags((p1 || p2 || [, ""])[1]);
        if (!snippet) {
            const cap = /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
            if (cap) snippet = stripTags(cap[1]);
        }
        out.push({ title, url, snippet: snippet.slice(0, 300) });
    }
    return out;
}

async function bingSearch(query, limit) {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=${Math.max(
        limit,
        10
    )}&form=QBLH`;
    const res = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
            Accept: "text/html,application/xhtml+xml"
        },
        signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`bing http ${res.status}`);
    const html = await res.text();
    const rows = parseBing(html, limit);
    if (!rows.length) throw new Error("bing 没有解析出结果（可能被要求验证）");
    return rows;
}

async function tavilySearch(query, limit, key) {
    const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: "basic" }),
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`tavily http ${res.status}`);
    const j = await res.json();
    return (j.results || []).slice(0, limit).map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: String(r.content || "").slice(0, 300)
    }));
}

async function serperSearch(query, limit, key) {
    const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ q: query, num: limit, hl: "zh-cn" }),
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`serper http ${res.status}`);
    const j = await res.json();
    return (j.organic || []).slice(0, limit).map((r) => ({
        title: r.title || r.link,
        url: r.link,
        snippet: String(r.snippet || "").slice(0, 300)
    }));
}

// 首选 provider，失败按 bing 兜底。返回 { rows, engine, ms }
export async function webSearch(cfg, query, limit = 5) {
    const q = String(query || "").trim().slice(0, 200);
    if (!q) throw new Error("空搜索词");
    const s = cfg.search || {};
    const want = String(s.provider || "auto");
    const key = String(s.apiKey || "");

    // 有 key 且指定了付费引擎就先用它；否则一律走 Bing 免 key 通道
    const order = [];
    if (key && (want === "tavily" || (want === "auto" && s.apiKeyFor === "tavily"))) {
        order.push(["tavily", () => tavilySearch(q, limit, key)]);
    }
    if (key && (want === "serper" || (want === "auto" && s.apiKeyFor === "serper"))) {
        order.push(["serper", () => serperSearch(q, limit, key)]);
    }
    order.push(["bing", () => bingSearch(q, limit)]);

    const t0 = Date.now();
    let lastErr;
    for (const [engine, fn] of order) {
        try {
            const rows = await fn();
            return { rows, engine, ms: Date.now() - t0 };
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error("搜索失败");
}

// 打开一个网页并抓正文（模型觉得摘要不够时用）。
// 只取纯文本、去掉脚本样式、截断到 4000 字，避免把 300KB 的 HTML 塞进上下文。
export async function fetchPageText(url, limit = 4000) {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) throw new Error("只支持 http/https 链接");
    const res = await fetch(u, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(15000),
        redirect: "follow"
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const ct = String(res.headers.get("content-type") || "");
    if (!/text|html|json|xml/i.test(ct)) throw new Error(`不支持的内容类型 ${ct.slice(0, 40)}`);
    let html = await res.text();
    html = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ");
    const text = stripTags(html);
    return text.slice(0, limit);
}

// ---- 给模型用的工具定义（OpenAI function calling 格式）----
export const webTools = [
    {
        type: "function",
        function: {
            name: "web_search",
            description:
                "搜索互联网，获取实时信息。凡是你可能已经过时的内容（新闻、赛事、软件版本、价格、政策、人物现任职位、最近发生的事）都应该先搜再答。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "搜索词，尽量具体，可含年份/版本号" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "open_url",
            description: "打开一个网页读取正文。搜索结果摘要不够时使用。",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "完整 http/https 地址" } },
                required: ["url"]
            }
        }
    }
];

// 执行一次工具调用，返回给模型的字符串（永远不要抛出，失败也返回 JSON 说明）
export async function runWebTool(cfg, name, args) {
    try {
        if (name === "web_search") {
            const q = String(args?.query || "").trim();
            const hit = cacheGet("s:" + q);
            const r = hit || (await webSearch(cfg, q, Number(cfg.search?.maxResults ?? 5)));
            if (!hit) cacheSet("s:" + q, r);
            if (!r.rows.length) return JSON.stringify({ ok: true, count: 0, note: "没有搜到结果" });
            return JSON.stringify(
                {
                    ok: true,
                    engine: r.engine,
                    results: r.rows.map((x, i) => ({ i: i + 1, title: x.title, url: x.url, snippet: x.snippet }))
                },
                null,
                0
            );
        }
        if (name === "open_url") {
            const u = String(args?.url || "").trim();
            const hit = cacheGet("u:" + u);
            const text = hit || (await fetchPageText(u));
            if (!hit) cacheSet("u:" + u, text);
            return JSON.stringify({ ok: true, url: u, text });
        }
        return JSON.stringify({ ok: false, error: `未知工具 ${name}` });
    } catch (e) {
        return JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
}
