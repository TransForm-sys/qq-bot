// bot hub：接收 QQ loader 上报的事件，向 loader 下发执行命令（HTTP 长轮询）。
// 探针阶段：事件落盘 data/events.jsonl，probe 单独存 data/probes/ 供分析。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");
const probeDir = path.join(dataDir, "probes");
fs.mkdirSync(probeDir, { recursive: true });
const eventLog = fs.createWriteStream(path.join(dataDir, "events.jsonl"), { flags: "a" });

const PORT = 5100;
const queues = new Map();

function queue(conn) {
    let q = queues.get(conn);
    if (!q) {
        q = { cmds: [], waiters: [] };
        queues.set(conn, q);
    }
    return q;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
        if (req.method === "POST" && url.pathname === "/event") {
            const ev = JSON.parse(await readBody(req));
            eventLog.write(JSON.stringify(ev) + "\n");
            if (ev.type === "probe") {
                fs.writeFileSync(path.join(probeDir, `${ev.conn}-${ev.wcId}.json`), JSON.stringify(ev, null, 2));
                console.log(
                    `[probe] conn=${ev.conn} wc=${ev.wcId} modules=${ev.moduleCount ?? "?"} candidates=${ev.candidates?.length ?? 0} uinHints=${JSON.stringify(ev.uinHints ?? [])} url=${ev.url}`
                );
            } else if (ev.type === "loader-hello") {
                console.log(`[hello] conn=${ev.conn} pid=${ev.pid} version=${ev.appVersion}`);
            } else if (ev.type === "loader-error") {
                console.log(`[loader-error] conn=${ev.conn} stage=${ev.stage} ${ev.error}`);
            } else {
                console.log(`[event] ${ev.type} conn=${ev.conn} wc=${ev.wcId}`);
            }
            res.end("{}");
            return;
        }
        if (req.method === "GET" && url.pathname === "/next") {
            const conn = url.searchParams.get("conn") || "unknown";
            const q = queue(conn);
            if (q.cmds.length) {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(q.cmds.shift()));
                return;
            }
            const timer = setTimeout(() => {
                q.waiters = q.waiters.filter((w) => w !== res);
                res.end("{}");
            }, 25000);
            q.waiters.push(res);
            res.on("close", () => {
                clearTimeout(timer);
                q.waiters = q.waiters.filter((w) => w !== res);
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/result") {
            const r = JSON.parse(await readBody(req));
            eventLog.write(JSON.stringify({ type: "result", ...r }) + "\n");
            console.log(`[result] id=${r.id} ok=${r.ok}`, r.ok ? JSON.stringify(r.value).slice(0, 200) : r.error);
            res.end("{}");
            return;
        }
        if (req.method === "POST" && url.pathname === "/send") {
            const cmd = JSON.parse(await readBody(req));
            cmd.id = cmd.id || "cmd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
            const q = queue(cmd.conn);
            const waiter = q.waiters.shift();
            if (waiter) {
                waiter.setHeader("content-type", "application/json");
                waiter.end(JSON.stringify(cmd));
            } else {
                q.cmds.push(cmd);
            }
            res.end(JSON.stringify({ id: cmd.id }));
            return;
        }
        res.statusCode = 404;
        res.end("{}");
    } catch (e) {
        console.error("[hub-error]", e);
        res.statusCode = 500;
        res.end("{}");
    }
});

server.listen(PORT, "127.0.0.1", () => console.log(`hub listening on 127.0.0.1:${PORT}, data -> ${dataDir}`));