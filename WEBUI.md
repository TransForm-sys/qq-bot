# 爱弥斯控制台（WebUI）使用手册

> 打开方式：`npm run bot` 启动后访问 **http://127.0.0.1:8787**
> 只想改配置、不想让 bot 收消息：`npm run webui`（同一个界面，只读配置与插件）
> 端口/监听地址/访问令牌都在 `config.json` 的 `webui` 段里。

---

## 1. 三分钟跑通

1. 打开控制台 → 左侧「模型供应」→ 右上角「添加厂商」。
2. 从预置列表里挑一个（比如 DeepSeek），**只需填 API Key**，点「保存」。
   （直接点「测试」或「拉取模型」也行 —— 会先自动把输入框里的 Key 存下来再请求。）
3. 点该卡片上的「测试」，出现 `通了 320ms：通了` 说明链路正常。
   测试通过后，之前因 401 挂在概览顶部的红字横幅会自动消失。
4. 点模型名的小胶囊（如 `deepseek-flash`）→ 它变成「默认模型」。
5. 回到「概览」，右上角「测试对话」发一句，能看到回复就成功了。

之后主号给 bot 发一条 QQ 消息，就能看到完整闭环。

---

## 2. 七个面板

| 面板 | 用途 |
|---|---|
| **概览** | 运行状态、消息计数、最近动态、模型通道健康度；四个应急按钮：重启接收器 / 运行体检 / 恢复窗口 / 重扫窗口绑定 |
| **人设** | 在线编辑 `persona.md`；可新建多份人设并「设为当前」；`Ctrl+S` 保存；保存即生效 |
| **回复节奏** | 触发条件（私聊开关、群白名单、bot 名字、接收方式）+ 拟人节奏 + 免打扰时段 |
| **模型供应** | 路由（默认/私聊/群聊模型、温度、超时、重试、fallback 链）+ 厂商卡片（Key、测试、拉取模型、优先级、启停、删除） |
| **插件** | 插件启停、在线编辑源码、新建、重载；显示钩子与报错次数 |
| **日志** | 实时日志（SSE），按类型筛选、搜索、暂停、清空 |
| **会话记忆** | 每个会话最近 40 条，可查看/删除；对应 `data/sessions/*.json` |

---

## 3. 预置厂商（除 Key 外全部填好）

**国内**：DeepSeek、Moonshot(Kimi)、智谱 GLM、阿里云百炼(通义千问)、火山方舟(豆包)、腾讯混元、MiniMax、硅基流动、阶跃星辰、零一万物

**海外**：OpenAI、Anthropic Claude、Google Gemini、xAI Grok、Mistral、Groq、OpenRouter、Together AI

**本地/自建**：Ollama、LM Studio、vLLM（任意 OpenAI 兼容端点）、Azure OpenAI

- 所有厂商都支持在卡片上「拉取模型」——直接请求服务商的 `/models`，把真实可用模型列出来（Azure 除外，它没有这个接口）。
- 模型名可以手改：`config.json` 里 `providers[].models` 是普通数组，加一行就多一个可选模型。
- 协议不是 OpenAI 兼容的只有两家：**Anthropic** 走原生 `/v1/messages`，**Azure** 走 `deployments/<部署名>`。其余都走 `/chat/completions`。

---

## 4. 回复节奏参数怎么调

| 参数 | 作用 | 建议 |
|---|---|---|
| 最小回复间隔 | 两条回复之间至少隔多久（全局） | 800–2000ms，太短像刷屏 |
| 每分钟最多回复 | 硬上限，防刷屏 | 6–10 条 |
| 「看消息」停顿 | 收到消息后先等一会再调模型 | 500–1600ms，模拟"人看到消息" |
| 打字速度 | 每秒字数，决定发送前的等待 | 12–20 字/秒 |
| 打字停顿上限 | 长回复最多等多久 | 3000ms 左右，避免等太久 |
| 长回复分几条发 | 超过 40 字自动拆成几条 | 2 条最自然 |
| 免打扰时段 | 这段时间完全不回复 | 支持跨零点，如 23:30–08:00 |
| **发送回执校验** | 点完发送后核对输入框是否真的清空 | 默认开；换分辨率后误报就关掉 |
| **你空闲多久后 bot 才发** | UI 自动化要抢前台，所以等你停手这么久才真发 | 45 秒；设 0 = 收到即发（会打断你） |
| **最长等多久就强行发** | 你一直在用电脑时的兜底，超时就抢一次 | 10 分钟 |
| **多旧的消息不再回复** | 超过该时长的消息只归档不回复 | 5 分钟；防止睡眠醒来刷屏 |

**实际发送顺序**：收到 → 白名单/插件判断 → 读延迟 → 调模型 → 分段 → 每段按字数等一会儿 → 粘贴 → 截空态/满态 → 点发送 → 截发后态比对 → 发出去或告警。

---

## 5. 模型路由与「供应调节」

- **默认模型**：`providerId/model`，例 `deepseek/deepseek-chat`。
- **私聊 / 群聊专用**：留空则跟随默认；可以给群聊配便宜模型、给私聊配好模型。
- **故障转移链**：按顺序尝试。主模型 429、超时、5xx 时自动换下一个。
- **熔断**：某厂商连续失败 3 次，60 秒内跳过它（避免一直卡在坏通道）。
- **RPM 限速**：卡片上的 `rpm` 字段（默认 0 = 不限），设为 60 就是每分钟最多 60 次，超过直接跳过该厂商。
- **优先级**：卡片上的 ↑↓ 调整顺序，数值越小越优先。
- **停用**：开关关掉后不参与路由，但配置保留。

> 想让某个厂商"只做备用"：把它的优先级调到后面，再加进 fallback 链即可。

---

## 6. 插件开发

插件就是 `plugins/` 目录下的一个 `.mjs` 文件，保存后 WebUI 点「全部重载」立即生效。

```js
export const meta = {
    title: "我的插件",
    description: "一句话说明",
    version: "1.0.0"
};

export function setup(ctx) {
    return {
        // 返回 false 丢弃消息；返回字符串 = 直接回复（不走大模型）；返回其它 = 继续
        async onMessage(evt) {
            if (evt.text === "ping") return "pong";
            return true;
        },
        // 改写喂给模型的上下文（可以插入 system 消息）
        async beforeReply({ evt, messages }) {
            return messages;
        },
        // 改写最终回复；也可以分段
        async afterReply({ evt, reply }) {
            return reply; // 或 { text: reply, segments: ["第一句", "第二句"] }
        },
        async afterSend({ evt, reply, target }) {}
    };
}
```

`ctx` 提供：

| 字段 | 说明 |
|---|---|
| `ctx.cfg()` | 当前配置（热更新后的） |
| `ctx.log(...)` | 带插件名前缀的日志 |
| `ctx.kv.get/set/del/all` | 该插件独立的持久化 KV（`data/plugins/<name>.json`） |
| `ctx.chat(messages, opts)` | 直接调模型（走同一套路由） |
| `ctx.dir` | 项目根目录 |

**事件对象**（`evt`）主要字段：`kind`(private/group)、`peerUin`、`peerName`、`groupId`、`groupName`、`senderUin`、`senderName`、`text`、`atMe`、`msgId`、`time`。

**自带 4 个示例**：

| 插件 | 作用 |
|---|---|
| `quiet-hours.mjs` | 免打扰时段（读 `reply.quietHours`） |
| `split-reply.mjs` | 长回复拆条 |
| `anti-repeat.mjs` | 10 分钟内不复读（双字形相似度 > 0.86 丢弃） |
| `link-reader.mjs` | 消息含 URL 时抓标题与正文前 1200 字注入上下文 |

单个插件连续报错 5 次会自动停用（卡片上显示红色报错），修好后点「全部重载」。

---

## 7. 应急按钮（概览页）

| 按钮 | 背后脚本 | 什么时候用 |
|---|---|---|
| 重启接收器 | 进程内 | 通知库轮询卡住、改了接收方式 |
| 运行体检 | `tools/doctor.ps1` | 不确定哪里坏了，先跑它（输出贴在下方面板） |
| 恢复窗口 | `tools/ui-restore.ps1 -Yes` | bot 的 QQ 窗口被收进托盘，发不出消息 |
| 重扫窗口绑定 | `tools/recover.ps1 -NoStartBot` | QQ 重启过、pid 变了（秒级；不再跑内存扫描） |

### 浏览器显示「无法访问此页面 / 127.0.0.1 拒绝连接」

`ERR_CONNECTION_REFUSED` 只有一个意思：**8787 上没有进程在听**，也就是 bot 没在跑。控制台本身不会挂，它是 bot 进程里的一个 HTTP server。

```powershell
# 1. 有没有在听
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
# 2. bot 进程在不在
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]index\.ts' }
# 3. 为什么死的
Get-Content data\bot-stdout.log -Tail 20
```

按顺序处理：

| 现象 | 原因 | 处理 |
|---|---|---|
| 没监听、没进程 | bot 没启动，或被杀了 | `tools\install-autostart.ps1`（已装则 `Start-ScheduledTask QQBot-Start`） |
| 没监听、进程在 | 端口被占 / server 启动失败 | 看日志里有没有 `[webui]` 那一行；`netstat -ano \| findstr 8787` |
| 起了又秒退、日志无异常栈 | 进程被外部回收（远程会话/沙箱关闭） | 必须由任务计划或你自己的桌面会话拉起，见 `VM-SETUP.md` 第 8 节 |

> 判断"是被杀还是崩了"：崩溃会往 `data\bot-stdout.log` 写异常栈；被 `TerminateProcess` 杀掉则日志停在最后一条正常输出，没有任何栈 —— 后者一定是外部原因。

### 告警横幅

概览页最上方会出现红色/橙色横幅。它不是日志，是「需要你看一眼」的异常；点右侧「清除」消掉。

| code | 含义 | 怎么办 |
|---|---|---|
| `recv-snapshot` | 连续读不到通知库 | 检查磁盘/权限、杀软；点「重启接收器」 |
| `recv-handler-changed` | QQ 换了通知 handler（已自动跟随） | 一般无需处理 |
| `recv-handler-missing` | 库里找不到 QQ 的 handler | QQ 是否登录、系统通知是否被关 |
| `recv-id-reset` | 通知 Id 空间疑似重置（已自动重建基线） | 无需处理，留意后续是否正常 |
| `send-focus` | 连续 3 次切不到前台 | 锁屏了？有全屏程序？点「恢复窗口」 |
| `send-forced` | 你一直在用电脑，闸门等到超时后强行发了 | 想彻底不被打扰就把 bot 搬进虚拟机（见 HANDOFF 16） |
| `send-no-input` | 聊天面板开着，但粘贴后输入框没变化（点击没落到输入框 / 前台被抢） | 重试一次仍失败就手动发一条；看 `data/ui/probe-*1.bmp` |
| `send-no-chat` | 搜索双击后聊天面板压根没打开（右下角没有蓝色发送按钮） | 检查 QQ 是否卡顿；`tools\hung-check.ps1 -ProcId <bot pid>` |
| `send-unconfirmed` | 点完发送输入框仍有内容 | 去 QQ 里确认那条消息，看 `data/ui/probe-*.bmp` |
| `send-binding` | bot-pid 失效 | 点「重扫窗口绑定」 |
| `llm-auth` / `llm-quota` | Key 失效 / 欠费 | 模型供应页换 Key |
| `llm-ratelimit` | 触发厂商限流 | 降频或加 fallback |
| `llm-network` | 网络不可达 | 检查代理/DNS |
| `llm-all-failed` | 所有通道都失败 | 上面几条的原因之一 |
| `llm-context-trim` | 上下文超长已自动裁剪 | 无需处理 |
| `plugin-disabled` | 插件连续报错 5 次被停用 | 插件页修好后点「重载」 |
| `system-sleep` | 进程被挂起过（睡眠/休眠） | 检查电源计划 |

---

## 7.5 后台守护（watchdog）

WebUI 只能告诉你"现在坏了"，`tools/watchdog.ps1` 负责"坏了就修"：

```powershell
# 跑一次，看看现在什么状态
powershell -File tools\watchdog.ps1

# 常驻，每分钟检查一次（会自动拉起死掉的 bot）
powershell -File tools\watchdog.ps1 -Loop

# 更激进：窗口丢了也恢复、pid 失效也重扫
powershell -File tools\watchdog.ps1 -Loop -RestoreWindow -RescanPid
```

判断依据是 `data/heartbeat.json`：进程在但心跳停了 3 分钟 → 判定事件循环卡死 → 杀掉重启。
只想检查不想让它动手，加 `-NoStart`。

---


## 8. API 速查（写脚本/自动化用）

```
GET    /api/state                    运行状态 + 脱敏配置 + 健康度 + 插件
GET    /api/presets                  厂商预置
PUT    /api/config                   局部更新配置（深合并）
POST   /api/providers                添加厂商 {presetId} 或 {name,baseURL,kind,models}
PATCH  /api/providers/:id            改 Key / 启停 / 优先级
DELETE /api/providers/:id
GET    /api/providers/:id/models     拉取服务商真实模型（?save=1 顺手写回）
POST   /api/providers/:id/test       连通性测试
POST   /api/chat-test                一次性对话 {text|messages, model?}
GET    /api/personas                 人设文件列表
GET/PUT/POST/DELETE /api/persona      读/存/建/删人设
GET    /api/plugins                  插件列表
GET/PUT /api/plugins/:name/source    读/写插件源码
POST   /api/plugins/:name/toggle     启停
POST   /api/plugins/reload           全部重载
GET    /api/logs?lines=200&kind=     日志
GET    /api/alerts                   当前告警
DELETE /api/alerts[?code=xxx]        清除全部 / 指定告警
GET    /api/stream                   SSE：state + log 实时推送
GET/DELETE /api/sessions/:key        会话记忆
POST   /api/actions/{doctor|restore-window|rescan-pid|windows|restart-receiver}
```

安全说明：接口只监听 `127.0.0.1`；`apiKey` 永远不返回明文（只给 `hasKey` 与掩码）。若要暴露到局域网/公网，必须设置 `webui.token` 并套 HTTPS 反代。

---

## 9. 常见问题

**打开 8787 是空白/连不上**
先看 `data/bot-live.log`（或终端）有没有 `[webui] http://127.0.0.1:8787`。端口被占用时会打印 `端口 8787 已被占用`，改 `config.json` 的 `webui.port` 即可。

**测试对话报 401**
Key 不对或没填。点厂商卡片「测试」，错误会原样显示（例如 `Authentication Fails`）。
注意「测试」测的是**已保存**的 Key —— 不过现在点测试会先把输入框里的 Key 自动存下来，
所以填完直接点测试就行；如果仍报 401，那是 Key 本身无效（去厂商后台重新生成一个）。
判据：`GET {baseURL}/models` 用这个 Key 能返回 `200` 才叫有效，401 就是 Key 的问题，与 bot 无关。

**报「所有模型通道均失败」**
展开看 `-> provider/model: 原因`。常见：Key 无效(401)、模型名不存在(404)、额度用完(402/429)、baseURL 少了 `/v1`。
另一种常见情况是**故障链里全是同一个坏厂商**：模型供应页把可用厂商的优先级调上去，或在「故障链」里补一条备用。

**能测试但 QQ 里不回**
按顺序查：①「概览」计数里"收到消息"有没有涨（接收链路）；②"跳过"涨说明被限流/插件/白名单拦了（看日志的 `skip-*`）；③有没有 `send-error`（窗口问题，点「恢复窗口」）。

**通知收不到**
QQ 的 toast 必须开着、系统勿扰必须关；并且 toast 会被"点掉/清空通知中心"删除，所以轮询间隔别设太大（默认 1500ms 够用）。

**改了配置没反应**
WebUI 里保存是立即生效的；如果直接手改 `config.json`，也会在 ~1 秒内被热加载。只有 `webui.port` 这种启动参数需要重启进程。
