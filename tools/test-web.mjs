// 单独验证"联网"这一层：模型决定要不要搜、搜到什么、最后怎么答。
// 不碰 QQ，不发消息，只打印过程。
//
//   node tools/test-web.mjs "TGA 2026 什么时候办"
import { store } from "../src/config.ts";
import { chat } from "../src/llm.ts";
import { webTools, runWebTool } from "../src/websearch.ts";

const q = process.argv.slice(2).join(" ").trim() || "今天有什么科技新闻";
const cfg = store.load();
const t0 = Date.now();

let calls = 0;
const out = await chat(
    cfg,
    [
        { role: "system", content: "你在聊天，回答简短自然。涉及会变的事实先搜再答。" },
        { role: "user", content: q }
    ],
    {
        tools: webTools,
        executeTool: async (name, args) => {
            calls++;
            const r = await runWebTool(cfg, name, args);
            console.log(`[tool ${calls}] ${name}(${JSON.stringify(args).slice(0, 80)}) -> ${String(r).slice(0, 200)}…`);
            return r;
        },
        maxRounds: cfg.search?.maxRounds ?? 2,
        maxCalls: cfg.search?.maxCalls ?? 3,
        timeoutMs: 40000,
        retries: 0
    }
);

console.log(`\n--- ${Date.now() - t0}ms | 工具调用 ${out.toolCalls} 次 ---`);
console.log(out.text);
process.exit(0);
