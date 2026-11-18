// 发送前置处理：把模型输出里的 markdown 记号拍平成纯文本。
//
// 为什么需要：QQ 的气泡不渲染 markdown，**加粗** 会原样显示成四个星号，
// `# 标题` 显示成井号，`---` 显示成三条横线。模型（尤其带联网笔记习惯的）
// 极爱加这些，读起来就像在读没渲染的源码。
//
// 原则：
//   1. 只动"记号"，不动内容 —— 星号去掉，字留下。
//   2. 幂等：clean 两次结果一样（engine 里两处都会过一遍，重复调用不能吃字）。
//   3. 宁可少删也不错删 —— 3*4 这种乘号保留，单独的 * 才丢。

/** 把一段模型输出拍平成可以直接塞进 QQ 输入框的纯文本。 */
export function toPlain(input) {
    let s = String(input ?? "").replace(/\r\n?/g, "\n");

    // ---- 0. 工具调用协议泄漏 ----
    // 见过的真实事故：模型把 <｜｜DSML｜｜ calls>…</｜｜DSML｜｜ calls> 当成正文吐出来，
    // 一整段 XML 原样发到群里。先整块砍掉（到配对闭合标签或文末），
    // 再扫一遍单个残留标签 —— 注意闭合标签是 </…，前面多一个 /
    s = s.replace(/<[|｜]{1,3}\s*DSML\s*[|｜]{1,3}[\s\S]*?(<\/[|｜]{1,3}\s*DSML\s*[|｜]{1,3}[^>]*>|$)/gi, "");
    s = s.replace(/<\/?[|｜]{1,3}\s*DSML\s*[|｜]{1,3}[^>]*>/gi, "");
    // 其它常见的特殊 token（<|im_start|>、<|endoftext|> 之类）
    s = s.replace(/<\|[a-z_]{2,20}\|>/gi, "");

    // ---- 1. 代码块：保留内容，去掉围栏 ----
    s = s.replace(/^[ \t]*```[^\n`]*\n?/gm, "");

    // ---- 2. 行内代码 `x` → x ----
    s = s.replace(/`([^`\n]+)`/g, "$1");

    // ---- 3. 水平分隔线（--- / *** / ___） ----
    // 模型爱用它分段，在 QQ 里就是一条莫名其妙的横杠，直接变空行。
    s = s.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");

    // ---- 4. 标题 # ## ### ----
    s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");

    // ---- 5. 引用 > （多层 >> 一次去干净，保证幂等） ----
    s = s.replace(/^[ \t]*(?:>[ \t]?)+/gm, "");

    // ---- 6. 列表符号：* + - → · （在去星号之前做，否则 * 会被当成斜体） ----
    s = s.replace(/^([ \t]*)[*+\-][ \t]+/gm, "$1· ");

    // ---- 7. 删除线 ~~x~~ ----
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");

    // ---- 8. 加粗 **x** ----
    // 下划线版（__x__）故意不处理：Python 的 __init__、Mac 的 _文件 会被吃掉，
    // 而模型用 __ 加粗的频率远低于用 ** 加粗。
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1");

    // ---- 9. 斜体 *x* ----
    // 要求：星号后非空白、行内、内容不含星号。这样 "3 * 4 * 5" 不会被吃成 "3 4 5"。
    s = s.replace(/\*(?![\s*])([^*\n]*?[^\s*])\*/g, "$1");

    // ---- 10. 链接 [文字](url) ----
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, text, url) => {
        if (text.trim() === url.trim()) return url;
        if (text.includes(url)) return text;
        return `${text}（${url}）`;
    });

    // ---- 11. 残留的星号 ----
    // 到了这一步还剩的 * 基本都是没配对完的记号。删掉，但两种情况手下留情：
    //   · 3*4 —— 两侧都是数字，当乘号
    //   · 单个 * 且两边都是空格（"3 * 4 * 5"）—— 同上，宁可留
    // 两个以上的星号连在一起（**、***）无论在哪都删，那必然是漏网的强调记号。
    s = s.replace(/\*+/g, (m, offset, whole) => {
        const prev = whole[offset - 1] || "";
        const next = whole[offset + m.length] || "";
        const isMath = /[0-9]/.test(prev) && /[0-9]/.test(next);
        const spaced = m.length === 1 && /\s/.test(prev) && /\s/.test(next);
        return isMath || spaced ? m : "";
    });

    // ---- 12. 收尾：行尾空格、被删记号留下的双空格、连续空行 ----
    s = s.replace(/[ \t]+$/gm, "");
    s = s.replace(/([^\n ]) {2,}(?=[^\n ])/g, "$1 ");
    s = s.replace(/\n{3,}/g, "\n\n");

    return s.trim();
}

/**
 * 把回复拆成要发出去的一条条消息（这里只做清洗，不负责分段）。
 * 返回的数组已经过滤掉清空后什么都没有的段。
 */
export function plainParts(segments, reply) {
    const list = Array.isArray(segments) && segments.length ? segments : [reply];
    return list.map((p) => toPlain(p)).filter((p) => p && p.trim());
}

/** 是否有"看着像没渲染的 markdown"的痕迹 —— 给 WebUI / 日志做提示用。 */
export function hasMarkdown(s) {
    return /\*\*|^#{1,6}\s|^[ \t]*[-*_]{3,}[ \t]*$|`|~~/m.test(String(s || ""));
}
