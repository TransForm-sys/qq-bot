// 主流模型厂商预置表：除了 apiKey，其余（baseURL / 协议 / 常用模型）全部预填。
// WebUI 里选中一个厂商 -> 只填 Key -> 立刻可用；模型名支持从服务商 /models 实时拉取覆盖。
//
// kind:
//   openai    OpenAI 兼容（/chat/completions + Bearer）
//   anthropic Anthropic 原生（/v1/messages + x-api-key）
//   azure     Azure OpenAI（/openai/deployments/<model>/chat/completions?api-version=）
//
// region: cn | global | local，仅用于 UI 分组。

export const PRESETS = [
    // ---------- 国内 ----------
    {
        id: "deepseek",
        name: "DeepSeek 深度求索",
        short: "DS",
        kind: "openai",
        baseURL: "https://api.deepseek.com/v1",
        models: ["deepseek-chat", "deepseek-reasoner"],
        region: "cn",
        docs: "https://platform.deepseek.com/api_keys",
        note: "性价比高，中文聊天首选。reasoner 更聪明但更慢且不支持部分参数。"
    },
    {
        id: "moonshot",
        name: "Moonshot 月之暗面 (Kimi)",
        short: "KM",
        kind: "openai",
        baseURL: "https://api.moonshot.cn/v1",
        models: ["kimi-k2-0905-preview", "moonshot-v1-32k", "moonshot-v1-8k"],
        region: "cn",
        docs: "https://platform.moonshot.cn/console/api-keys",
        note: "长上下文见长，日常闲聊也自然。"
    },
    {
        id: "zhipu",
        name: "智谱 GLM",
        short: "GLM",
        kind: "openai",
        baseURL: "https://open.bigmodel.cn/api/paas/v4",
        models: ["glm-4.6", "glm-4-plus", "glm-4-air", "glm-4-flash"],
        region: "cn",
        docs: "https://open.bigmodel.cn/usercenter/apikeys",
        note: "glm-4-flash 免费额度大，适合先跑通链路。"
    },
    {
        id: "qwen",
        name: "阿里云百炼 (通义千问)",
        short: "QW",
        kind: "openai",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max"],
        region: "cn",
        docs: "https://bailian.console.aliyun.com/?tab=model#/api-key",
        note: "用「兼容模式」baseURL，不要填 native 的 dashscope.aliyuncs.com/api/v1。"
    },
    {
        id: "ark",
        name: "火山方舟 (豆包)",
        short: "DB",
        kind: "openai",
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
        models: ["doubao-seed-1-6-250615", "doubao-1-5-pro-32k-250115"],
        region: "cn",
        docs: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
        note: "模型名也可以填「推理接入点 ID」(ep-xxxxxxxx)，两者都支持。"
    },
    {
        id: "hunyuan",
        name: "腾讯混元",
        short: "HY",
        kind: "openai",
        baseURL: "https://api.hunyuan.cloud.tencent.com/v1",
        models: ["hunyuan-turbos-latest", "hunyuan-plus-latest", "hunyuan-lite"],
        region: "cn",
        docs: "https://console.cloud.tencent.com/hunyuan/api-key",
        note: "hunyuan-lite 有免费额度。"
    },
    {
        id: "minimax",
        name: "MiniMax",
        short: "MM",
        kind: "openai",
        baseURL: "https://api.minimaxi.com/v1",
        models: ["MiniMax-Text-01", "abab6.5s-chat"],
        region: "cn",
        docs: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        note: "国内站 api.minimaxi.com，海外站 api.minimax.io。"
    },
    {
        id: "siliconflow",
        name: "硅基流动 SiliconFlow",
        short: "SF",
        kind: "openai",
        baseURL: "https://api.siliconflow.cn/v1",
        models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "THUDM/glm-4-9b-chat"],
        region: "cn",
        docs: "https://cloud.siliconflow.cn/account/ak",
        note: "一个 Key 聚合几十个开源模型，模型名带命名空间（org/model）。"
    },
    {
        id: "stepfun",
        name: "阶跃星辰 StepFun",
        short: "ST",
        kind: "openai",
        baseURL: "https://api.stepfun.com/v1",
        models: ["step-2-16k", "step-1-flash"],
        region: "cn",
        docs: "https://platform.stepfun.com/interface-key",
        note: ""
    },
    {
        id: "lingyi",
        name: "零一万物 01.AI",
        short: "01",
        kind: "openai",
        baseURL: "https://api.lingyiwanwu.com/v1",
        models: ["yi-lightning", "yi-large"],
        region: "cn",
        docs: "https://platform.lingyiwanwu.com/apikeys",
        note: ""
    },

    // ---------- 海外 ----------
    {
        id: "openai",
        name: "OpenAI",
        short: "OA",
        kind: "openai",
        baseURL: "https://api.openai.com/v1",
        models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
        region: "global",
        docs: "https://platform.openai.com/api-keys",
        note: "o 系列推理模型不接受 temperature，程序会自动降级重试。"
    },
    {
        id: "anthropic",
        name: "Anthropic Claude",
        short: "CL",
        kind: "anthropic",
        baseURL: "https://api.anthropic.com",
        models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
        region: "global",
        docs: "https://console.anthropic.com/settings/keys",
        note: "走原生 /v1/messages 协议，不是 OpenAI 兼容格式。"
    },
    {
        id: "gemini",
        name: "Google Gemini",
        short: "GM",
        kind: "openai",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
        models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
        region: "global",
        docs: "https://aistudio.google.com/app/apikey",
        note: "用 Google 的 OpenAI 兼容层，Key 走 Bearer。"
    },
    {
        id: "xai",
        name: "xAI Grok",
        short: "X",
        kind: "openai",
        baseURL: "https://api.x.ai/v1",
        models: ["grok-4", "grok-3-mini"],
        region: "global",
        docs: "https://console.x.ai/",
        note: ""
    },
    {
        id: "mistral",
        name: "Mistral",
        short: "MI",
        kind: "openai",
        baseURL: "https://api.mistral.ai/v1",
        models: ["mistral-large-latest", "mistral-small-latest"],
        region: "global",
        docs: "https://console.mistral.ai/api-keys/",
        note: ""
    },
    {
        id: "groq",
        name: "Groq",
        short: "GQ",
        kind: "openai",
        baseURL: "https://api.groq.com/openai/v1",
        models: ["llama-3.3-70b-versatile", "qwen/qwen3-32b"],
        region: "global",
        docs: "https://console.groq.com/keys",
        note: "速度极快，适合当备用通道。"
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        short: "OR",
        kind: "openai",
        baseURL: "https://openrouter.ai/api/v1",
        models: ["anthropic/claude-sonnet-4", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
        region: "global",
        docs: "https://openrouter.ai/keys",
        note: "一个 Key 通吃各家模型，模型名必须带 org/ 前缀。"
    },
    {
        id: "together",
        name: "Together AI",
        short: "TG",
        kind: "openai",
        baseURL: "https://api.together.xyz/v1",
        models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
        region: "global",
        docs: "https://api.together.xyz/settings/api-keys",
        note: ""
    },

    // ---------- 本地 / 自建 ----------
    {
        id: "ollama",
        name: "Ollama 本地",
        short: "OL",
        kind: "openai",
        baseURL: "http://127.0.0.1:11434/v1",
        models: ["qwen2.5:7b", "llama3.1:8b"],
        region: "local",
        needsKey: false,
        docs: "https://ollama.com/download",
        note: "本地跑，不花钱。需要先 ollama serve 并 pull 过模型。"
    },
    {
        id: "lmstudio",
        name: "LM Studio 本地",
        short: "LM",
        kind: "openai",
        baseURL: "http://127.0.0.1:1234/v1",
        models: ["local-model"],
        region: "local",
        needsKey: false,
        docs: "https://lmstudio.ai/",
        note: "在 LM Studio 里开启 Local Server 后使用。"
    },
    {
        id: "vllm",
        name: "vLLM / 自建兼容端点",
        short: "VL",
        kind: "openai",
        baseURL: "http://127.0.0.1:8000/v1",
        models: ["your-model"],
        region: "local",
        needsKey: false,
        docs: "",
        note: "任何 OpenAI 兼容的自建服务都能用这里。"
    },
    {
        id: "azure",
        name: "Azure OpenAI",
        short: "AZ",
        kind: "azure",
        baseURL: "https://YOUR-RESOURCE.openai.azure.com",
        models: ["YOUR-DEPLOYMENT"],
        region: "global",
        docs: "https://portal.azure.com/",
        note: "baseURL 填资源名地址，模型名填「部署名」(deployment)，apiVersion 用 2024-10-21。"
    }
];

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function findPreset(id) {
    return BY_ID.get(id) || null;
}

// 老配置里只有一个 baseURL，用它反查是哪个厂商，迁移时能自动套上预置模型列表
export function guessPreset(baseURL) {
    if (!baseURL) return null;
    const norm = (u) => String(u).toLowerCase().replace(/\/+$/, "").replace(/^https?:\/\//, "");
    const target = norm(baseURL);
    for (const p of PRESETS) {
        const b = norm(p.baseURL);
        if (target === b || target.startsWith(b.split("/").slice(0, 2).join("/"))) return p;
    }
    return null;
}

// 生成一个可直接写进 config.providers 的条目（apiKey 留空等用户填）
export function providerFromPreset(id, apiKey = "") {
    const p = findPreset(id);
    if (!p) return null;
    return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseURL: p.baseURL,
        apiKey,
        models: [...p.models],
        enabled: true,
        priority: PRESETS.indexOf(p) + 1,
        rpm: 0,
        apiVersion: p.kind === "azure" ? "2024-10-21" : "",
        note: p.note || ""
    };
}

export function customProvider(patch = {}) {
    return {
        id: patch.id || `custom-${Date.now().toString(36)}`,
        name: patch.name || "自定义端点",
        kind: patch.kind || "openai",
        baseURL: patch.baseURL || "",
        apiKey: patch.apiKey || "",
        models: patch.models?.length ? patch.models : ["your-model"],
        enabled: true,
        priority: 100,
        rpm: 0,
        apiVersion: patch.apiVersion || "",
        note: patch.note || ""
    };
}

export function presetMeta(id) {
    const p = findPreset(id);
    if (!p) return null;
    return {
        short: p.short,
        region: p.region,
        docs: p.docs,
        note: p.note,
        needsKey: p.needsKey !== false,
        kind: p.kind,
        baseURL: p.baseURL,
        models: p.models
    };
}
