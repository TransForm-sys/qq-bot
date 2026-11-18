// 本地假模型服务：不花钱验证整条链路（路由 / 重试 / 插件 / 发送）。
// 用法：node tools/mock-llm.mjs [port]   然后在 WebUI 添加自定义端点 http://127.0.0.1:8899/v1
import http from "node:http";

const port = Number(process.argv[2] || 8899);

const server = http.createServer((req, res) => {
    const chunk = [];
    req.on("data", (c) => chunk.push(c));
    req.on("end", () => {
        const url = new URL(req.url || "/", "http://x");
        if (url.pathname.endsWith("/models")) {
            const body = JSON.stringify({ data: [{ id: "mock-chat" }, { id: "mock-long" }] });
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(body);
        }
        if (url.pathname.endsWith("/chat/completions")) {
            let payload = {};
            try {
                payload = JSON.parse(Buffer.concat(chunk).toString("utf8"));
            } catch {
                /* ignore */
            }
            const last = (payload.messages || []).filter((m) => m.role === "user").pop();
            const text = last?.content || "";
            // mock-context：模拟"上下文超长"的厂商，消息数超过 5 条就返回 400。
            // 用于验证 engine 的裁剪重试逻辑（R-116）：裁到 [system, ...4] 后应当成功。
            if (payload.model === "mock-context" && (payload.messages || []).length > 5) {
                res.writeHead(400, { "content-type": "application/json" });
                return res.end(
                    JSON.stringify({
                        error: {
                            message: "This model's maximum context length is exceeded. Please reduce the length of the messages.",
                            type: "invalid_request_error"
                        }
                    })
                );
            }
            const reply =
                payload.model === "mock-long"
                    ? "这句话比较长。所以我把它拆成几句来说。你看这样是不是更像真人聊天？毕竟一口气发一大段话，看起来就很像机器人。"
                    : `收到：${String(text).slice(0, 40)}（mock）`;
            const body = JSON.stringify({
                id: "mock-1",
                object: "chat.completion",
                model: payload.model,
                choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }]
            });
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(body);
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });
});

server.listen(port, "127.0.0.1", () => console.log(`[mock-llm] http://127.0.0.1:${port}/v1`));
