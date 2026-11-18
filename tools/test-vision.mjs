// 一次性验证：deepseek-flash 能不能读本地图片（多模态）。
//   node tools/test-vision.mjs "<图片路径>"
// 不写任何数据，只打印模型返回。
import fs from "node:fs";
import path from "node:path";

const imgPath = process.argv[2];
if (!imgPath) {
    console.error("usage: node tools/test-vision.mjs <image path>");
    process.exit(2);
}

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
const provider = (cfg.providers || []).find((p) => p.enabled !== false);
if (!provider) {
    console.error("no provider");
    process.exit(2);
}

const buf = fs.readFileSync(imgPath);
const mime = /\.jpe?g$/i.test(imgPath) ? "image/jpeg" : "image/png";
const url = `data:${mime};base64,${buf.toString("base64")}`;
// config 里的模型名带 provider 前缀（deepseek/deepseek-flash），
// 发给 API 时要剥掉前缀，只留 deepseek-flash。
const modelName = String(cfg.models?.default || "deepseek-flash").split("/").pop();
console.log(`[test] provider=${provider.id} model=${modelName} bytes=${buf.length}`);

const body = {
    model: modelName,
    messages: [
        {
            role: "user",
            content: [
                { type: "text", text: "用两三句话描述这张图片的画面内容，中文回答。" },
                { type: "image_url", image_url: { url } }
            ]
        }
    ],
    max_tokens: Number(process.argv[3] || 300)
};

const r = await fetch(`${provider.baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body)
});
const text = await r.text();
console.log(`[test] HTTP ${r.status}`);
console.log(text.slice(0, 8000));
