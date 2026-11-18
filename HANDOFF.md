# QQ-bridge 项目交接文档

> 生成日期：2026-11-17。用途：换工具/换会话继续本项目时的完整状态交接。
> 项目根目录：`D:\<you>\Documents\project\QQ-bridge\qq-bot\`（所有产出必须留在 D 盘工作区，禁止写 C 盘）。

---

## 1. 项目目标

在**真实桌面 QQ 客户端**里养一个稳定不掉线的 persona 聊天机器人：

- 收到消息 → 交给 LLM（OpenAI 兼容端点）→ 按自写人设（`persona.md`）回复 → 通过 UI 自动化发出。
- **不是 OneBot 协议桥，不仿 SnowLuma，不用 NapCat/Lagrange 等协议库**（掉线/封号/律师函风险，用户明确排除）。
- 用户原话："我就是想要一个能够稳定不掉线的机器人然后想聊就聊"。

### 账号绑定（关键，不可搞错）

| 账号 | 角色 |
|---|---|
| **1000000000** | 机器人（自动回复只允许发生在它身上） |
| 1000000001 | 用户主号，**绝不自动回复** |

用户日常同时开两个 QQ 实例（bot + 主号），命令行完全相同（无 uin 参数），不能靠命令行区分。

### 硬约束

1. **零注入、零 QQ 文件修改**（用户选定路线：消息库读取接收 + UI 自动化发送）。
2. 所有产出放工作区 D 盘，不放 C 盘。
3. 动用户日常 QQ 前必须确认；**禁止在一个实例运行时强杀另一个**（白屏级联）。安全模式：全杀 → 等 ~4 秒 → 只起一个。
4. 清缓存只清 GPUCache/DawnGraphiteCache/DawnWebGPUCache/Code Cache/Cache，**绝不碰登录存储**（Local Storage/Session Storage/auth）。
5. UI 自动化必须绑定 bot 实例（`data/bot-pid.txt`），禁止盲选"第一个 QQ 窗口"。

---

## 2. 环境事实（已探明，勿重复探索）

- QQ：NTQQ **9.9.31-49738**（9.9.37-54395 已 staged 未启用），安装于 `D:\Program Files\Tencent\QQNT`。
- 消息数据：`D:\<you>\Documents\QQ-chat\Tencent Files\<uin>\nt_qq\nt_db\*.db`。
- Node **v22.22.2**（实测；`node src/index.ts` 可直接跑 TS —— 类型擦除默认开启，`process.features.typescript=strip`），`node:sqlite` 可用（仅 `ExperimentalWarning`），**零 npm 依赖**（node:sqlite / node:crypto / PowerShell）。
- PowerShell 5.1。

### 注入向量——全部已验证关闭（勿再尝试）

| 向量 | 结论 |
|---|---|
| package.json `main` 补丁 | 启动器无视 main，直载 application.asar/background.js；改 package.json 触发"文件已损坏"完整性弹窗（补丁已完全还原，`patch/` 脚本废弃仅留参考） |
| asar 补丁 | 主进程 JS 是加密 80 字节 stub，应用级完整性校验存在 |
| CDP 调试端口 | 自动开 9210/9211，但 HTTP CDP 被 JWT 门禁（errCode 4001），无本地密钥文件，不可廉价破解 |
| NODE_OPTIONS / 调试 argv | QQ shell 剥离，实测无效（env-hook.cjs 无心跳） |
| Electron fuses | NodeCliInspect/NodeOptions 虽 ENABLED 但被上层剥离；asar integrity 校验 DISABLED 但应用级校验仍在 |
| UIA 无障碍树 | 此 build 编译期剥离，screen-reader 标志无用（已还原） |
| devtools CLI | 所有本地 asar/zip 均无（release 剥离） |

### NTQQ DB 格式（已解码）

- 前 **1024 字节 = 明文自定义页 1**：magic `SQLite header 3\0`，offset16 大端页大小=1024，offset32 `QQ_NT DB`，~40 起 protobuf：field2 = 128 个 hex 字符（字节 47..174），field3 `1.1.0.1`，field4 `HMAC_SHA1`，field5 varint。
- **加密区从 1024 开始 = 页 2**（b-tree 页）。
- 真实 SQLCipher salt = `db[1024:1040]` = `5f3438eadeb4c37245b5811e8c948795`（page2head）。
- field2 的 hex **不驻留任何进程内存**；page2head **只驻留 bot 主窗口进程**。
- WAL 头确认 SQLCipher 页大小 **4096**；内存中解密页 1 图像显示 reserve **0x50=80**。(1758208−1024)/4096 = 429 页。
- `nt_msg.db-first/last.material`（16KB）= [salt16][密文备份页]，**不是密钥材料**（用于 DB 修复）。
- `nt_db/` 下**所有** db（含 FTS 索引、profile_info、group_info 等）都带加密 QQ_NT 头——**没有明文辅助库可抄近路**。
- 内存中存在**解密的 pager-cache 页**（含 nt_msg master 页、明文表名），但**没有整库连续明文镜像**。

### 进程拓扑与 bot 绑定

- codec/salt 在 **bot 主窗口进程**（当时 pid 34260，67 处 salt 命中），**不在** `--no-sandbox` renderer（0 命中）。早期只扫 renderer 是错误方向。
- **pid 会随 QQ 重启变化**。绑定方法：`tools/mem-allsalt-scan.ps1` 扫所有 QQ.exe pid 找 page2head raw+ascii 针 → 命中 pid 的带窗口祖先写入 `data/bot-pid.txt`。**任何 QQ 重启后必须重跑**。
- 内存读取：C# P/Invoke（OpenProcess 0x0010|0x0400，VirtualQueryEx，ReadProcessMemory），区域过滤 State=0x1000，Protect {02,04,20,40,08,80}，Type private 0x20000（DumpAll 另含 mapped 0x40000）。

---

## 3. 已完成 ✅

### 3.1 发送链路（端到端验证通过，零注入）

`src/send-ui.ts` + PowerShell 工具驱动 QQ：

1. 搜索框比例坐标 (0.14, 0.071) → 粘贴会话名
2. **双击**第一条结果 (0.183, 0.17)（单击只是选中，双击才打开会话）
3. 输入框 (0.594, 0.897) → 粘贴文本
4. 发送按钮 (0.9295, 0.964)

- 中文必须走剪贴板 + Ctrl+V（`powershell -STA`）。
- 已向"测试用群"成功发送测试消息。
- 窗口坐标按 bot-pid 绑定实例的比例计算（`tools/ui-rect.ps1`）。

### 3.2 框架骨架（代码就绪，等接收激活）

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/index.ts` | 入口：配置 → 插件 → 接收器 → 引擎 → WebUI；`npm run bot` 一条起全部 | ✅ |
| `src/config.ts` | **配置中心**：默认值、深合并、原子写、`fs.watchFile` 热加载、老 `llm` 字段自动迁移成 `providers`+`models` | ✅ 新增 |
| `src/providers.ts` | **厂商预置表**：24 家（DeepSeek/Kimi/GLM/百炼/豆包/混元/MiniMax/硅基/阶跃/零一/OpenAI/Claude/Gemini/Grok/Mistral/Groq/OpenRouter/Together/Ollama/LM Studio/vLLM/Azure…），除 apiKey 外全部填好 | ✅ 新增 |
| `src/llm.ts` | **多厂商路由**：openai / anthropic 原生 / azure 三种适配；优先级 + fallback 链；每厂商 RPM 限速；失败 3 次熔断 60s；429/5xx 退避重试；o 系列 `temperature` 不兼容自动降级 | ✅ 重写 |
| `src/plugins.ts` | **插件内核**：扫描 `plugins/`、动态 import、热重载、5 个钩子、单插件错误隔离（连续 5 次停用）、插件 KV 存储 | ✅ 新增 |
| `src/runtime.ts` | 进程内运行时统计（计数/最近事件/动作进度），供 WebUI 读取 | ✅ 新增 |
| `src/webui.ts` | **控制台后端**：零依赖 HTTP，REST + SSE + 静态托管；可独立 `npm run webui` | ✅ 新增 |
| `webui/` | 控制台前端（原生 JS/CSS，无构建）：概览 / 人设 / 回复节奏 / 模型供应 / 插件 / 日志 / 会话 | ✅ 新增 |
| `src/engine.ts` | 引擎：账号与白名单、限流、拟人节奏（读延迟/打字/分段）、插件钩子、按 private/group 选模型 | ✅ 重写 |
| `src/memory.ts` | 会话记忆（每会话 40 条） | ✅ |
| `src/send-ui.ts` | UI 发送；已加 fail-closed（`ERR_*` 即中止）与 `QQBOT_DRY_SEND=1` 试运行 | **已验证** |
| `src/recv-db.ts` | 3 秒轮询 live nt_msg.db → 解密 → 增量读；`key-found.json` 存在才激活 | 就绪，**被密钥卡死** |
| `src/recv-notify.ts` | **R3 接收适配器**：轮询 `wpndatabase.db` 解析 QQ toast；1.5s；快照去重；归档 `data/notify-archive.jsonl`；返回 `stop()` 供热重建 | **已验证（私聊实收）** |
| `src/dbcrypt.ts` | 页解密；AES-256/128、SM4、CBC/CTR/ECB、三种 master 布局 | 就绪 |
| `src/hub.ts` | 旧 HTTP 事件 sink（被子进程直连模式取代） | 骨架 |
| `config.json` | 新结构：`providers[]` + `models{}` + `reply{}` + `plugins{}` + `webui{}` | ✅ |
| `persona.md` / `personas/` | 人设，支持多份，WebUI 内切换与在线编辑 | ✅ |

### 3.3 逆向/搜索工具（全部可复用）

| 工具 | 用途 |
|---|---|
| `tools/memscan2.cs` | 内存扫描核心：Scan（针±256 step1）/ Contexts / ReadAt / DumpAll（私有+映射区流式 dump） |
| `tools/mem-allsalt-scan.ps1` | **bot 实例绑定**：全 QQ pid 扫 salt 针，**按命中数最多**的 pid 定为 bot（旧版是"最后一个命中"→ 曾误绑 12520 并写进 explorer 的 pid 14928，已修）；祖先必须是 QQ.exe；候选只收 bot 的 → `bot-pid.txt` + `salt-candidates.txt` + `salt-scan.json`（审计） |
| `tools/ui-windows.ps1` | 列出所有 QQ 顶层窗口（含隐藏），排查"窗口收进托盘"导致的绑定失效 |
| `tools/doctor.ps1` | **体检**（只读）：QQ 进程 / bot-pid / 窗口 / 接收活跃度 / bot 进程 / LLM 配置 / 接收模式；`-Deep` 额外复核绑定；exit 0/1/2 |
| `tools/recover.ps1` | **一键恢复**：自检 → 重绑 pid → (可选)恢复窗口 → (可选)起 QQ → 拉起 bot → 复检。`-RestoreWindow` / `-StartQQ` / `-NoStartBot` |
| `tools/ui-restore.ps1` | 从托盘恢复主面板：优先 `data/ui-state.json` 记录的 hwnd，其次"可见但很小"的窗口，再按面积；`-Yes` 才真的拉起，`-Hwnd n` 定向，`-Hide` 收回 |
| `tools/capture-rect.ps1` | 按屏幕坐标截指定区域，用于校验 ui-rect 坐标是否真的框住窗口 |
| `tools/mem-main-scan.ps1` / `mem-salt-scan.ps1` / `mem-renderer-scan.ps1` | 定向候选采集 |
| `tools/mem-dump.ps1` | DumpAll → memdump-main*.bin |
| `tools/dump-plain.ps1` / `magic-context.ps1` / `salt-context.ps1` | magic 命中处 12KB dump → data/plain/*.bin（48 个，含已知明文页） |
| `tools/keysearch.mjs` | **已知明文 oracle 搜密钥**：`<dump> <step> [layout] [ps] [reserve] [mode] [ctrsrc] [bits] [family]`；family=aes/sm4；命中写 data/key-found.json |
| `tools/verify2.mjs` | 候选密钥验证（raw 预检 + KDF 全参数，头感知三布局） |
| `tools/keysched.mjs` | AES 密钥扩展递推搜索（enc/dec） |
| `tools/rawprobe.mjs` | 宽参数 raw 密钥探针 |
| `tools/search-watch.ps1` | 监视器脚本（命中/全部结束才报；须先见过 worker 再连续 100s 无 worker 才报结束，防误报） |
| `tools/ui-rect/ui-click/ui-paste.ps1`、`screenshot.ps1`、`qq-procs.ps1` | UI 自动化与截图 |
| `tools/verify-key.mjs`、`memscan.cs`、`mem-key-scan.ps1`、`uia-probe.ps1`、`set-screenreader.ps1` | 旧版/已废弃方向，留参考 |

### 3.4 数据资产（`data/`）

- `dbcopy/nt_msg.db`：live 库快照（1758208B）。**QQ 运行后内容会变，验证前需重新拷贝**。
- `memdump-main.bin`（164MB 私有区）、`memdump-main2.bin`（369MB 私有+映射）：bot 主进程内存快照。**重启后失效，需重 dump**。
- `plain/*.bin`：48 个解密页 dump；`2446680970376.bin` 字节 16..32 是 oracle 用的已知明文。
- `salt-candidates.txt`（10568）、`main-candidates.txt`（5779）、`renderer-candidates.txt`（1676）：候选密钥。
- `bot-pid.txt`：**34260（2026-11-17 13:40 重扫确认，68 处 salt 命中）**。注意：bot 主窗口当前处于**隐藏/托盘**状态（`MainWindowHandle=0`），此时 UI 自动化会 fail-closed 报 `ERR_BOT_WINDOW_MISSING`，必须先把 bot 窗口点开再发。另一个实例 12520 有 18 处杂散命中，不是 bot。
- `key-found.json`：**不存在**（从未命中）。

---

## 4. 未完成 / 被卡 ❌

### 4.1 核心卡点：DB 密钥（接收路径的唯一障碍）

**穷尽搜索矩阵，全部无命中**（截至 2026-11-17）：

| 搜索线 | 参数 | 结果 |
|---|---|---|
| raw 32B 候选 | salt 邻域±256 step1 / 文件名邻域 / main hex 候选 × CBC{master,masterfull,page} × PS{1024,4096} × reserve{48,36,32,64,80,16,20,60} × IV{end,head,zero,tail} | 无 |
| KDF 4000 迭代 | sha512/sha1/sha256 × 5 salts × renderer+salt+main 候选 | 无 |
| KDF 高迭代 | sha512/sha1×64000 + sha512×256000 × {hex64,hex16head,page2head}，109819 测试 | 无 |
| AES-256 全内存 oracle | 164MB dump，step8，CBC 4 组 + CTR/ECB 8 组矩阵（各 ~2058 万窗口） | 无 |
| AES-256 step1 | 逐字节对齐，master+masterfull，各 1.646 亿窗口 | 无 |
| AES-256 映射区 | 369MB dump，step4，master+masterfull，各 9222 万窗口 | 无 |
| AES-128 矩阵 | 6 组 CBC/CTR/ECB × master/masterfull，step8，各 2058 万 | 无 |
| AES 密钥扩展 | enc+dec 递推搜索，4115 万窗口 | 0 符合 |
| **SM4 矩阵** | 6 组 CBC/CTR/ECB × master/masterfull，step4，各 4116 万 | 无 |

**结论**：密钥不以连续原始形式驻留内存（可能随用随推导、掩码存放、或在受保护区域）。
**未试的低价值假设**：sha256×64000 / sha1+sha256×256000 KDF、映射区上的 CTR/ECB+AES-128+SM4、XOR 掩码密钥。继续搜的期望收益很低。

### 4.2 其他未完成

- [ ] **接收路径激活**：被 4.1 卡死；若改备用接收方案则需新写适配器。
- [ ] **LLM 配置**：`config.json` 的 `llm.baseURL/apiKey/model` 是占位符，**必须用户提供**才能让人设回复生效。
- [ ] 群名/昵称 → QQ 号映射（recv-db 的 pickUin/textOf 是启发式，拿到真实 schema 后需校准；UI 复制方案则只能拿昵称）。
- [ ] 人设回复端到端测试（依赖 LLM 配置 + 接收激活）。
- [ ] hub 与 bot 的正式联动（骨架已有）。
- [ ] 长期稳定性验证（掉线重连、QQ 更新后的坐标/格式回归）。

---

## 5. 需要决策的地方 🔀

### 决策 A：接收路线（完整方案目录，由用户选定）

> 编号 R1–R32，直接说"选 R几"即可。可行性标注：✅可做 / 🔬研究性 / 🔑被密钥卡 / 💀已验证死路 / ⚠️违反当前约束 / 🚫用户已排除。

#### A 类：UI / 系统层（零注入、零密钥，符合当前约束）

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| R1 | UI 复制全文 | 定时切会话→全选→剪贴板复制→解析增量 | ✅ | 复用已验证 UI 链路，实现量最小 | 每会话几秒、抢 bot 窗口焦点、只有昵称无 QQ 号 |
| R2 | Windows toast 通知 API 监听 | WinRT `UserNotificationListener` 读 QQ 通知（发送者+预览） | ✅ | 完全被动、不碰 QQ 窗口、实时 | 需系统权限授权；预览文本截断；依赖 QQ 通知开启 |
| R3 | 通知中心数据库直读 | 读 `%LocalAppData%\Microsoft\Windows\Notifications\wpndatabase.db`（明文 SQLite，存 QQ 通知 payload XML） | ✅ | 无需 API 权限弹窗、被动、含结构化 payload | 文件可能被锁需拷贝读；同样依赖通知开启；文本截断 |
| R4 | 聊天窗口截图 OCR | 截 bot 聊天区→OCR→解析 | ✅ | 不依赖剪贴板、能收图片内文字 | 重、准确率差、排版解析麻烦 |
| R5 | 会话列表预览 OCR / 图像差分 | 只截会话列表，OCR 最后一条预览或像素差分检测新消息 | ✅ | 轻量触发器，判断"哪个会话有新消息" | 只能当触发器，全文仍需 R1/R4 |
| R6 | UIA 无障碍树读取 | Windows UI Automation 读聊天控件文本 | 💀 | （若可用则最干净） | 此 build 编译期剥离，已实测无效；换 QQ 版本或可复活 |
| R7 | Win32 控件文本（WM_GETTEXT） | 直接读窗口控件文本 | 💀 | — | Electron 单 HWND 无子控件，读不到内容 |
| R8 | QQ 本地日志解析 | 扫 QQ 日志目录找明文消息事件 | 🔬 | 完全被动 | 未调查；NTQQ 日志多为加密/二进制，期望低 |

#### B 类：内存读取（零注入，符合约束）

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| R9 | 解密页缓存轮询 | 扫 bot 主进程堆中已解密的 nt_msg 页，提取新消息 | 🔬✅ | 不碰 UI、结构化数据（QQ 号/群号/时间戳）、近实时 | 页边界/缓存淘汰处理脆；工具现成但需研发 |
| R10 | 堆内明文消息串扫描 | R9 简化版：不重组页，直接搜堆里的消息 protobuf/文本特征 | 🔬✅ | 比 R9 简单 | 误报/漏报多，去重难，拿不全上下文 |
| R11 | 整库明文镜像扫描 | 找内存中连续解密整库 | 💀 | — | 已验证不存在（只有零散 pager-cache 页） |
| R12 | 继续密钥提取 | 剩余假设：sha256×64000 / sha1+sha256×256000 KDF、映射区 CTR/ECB/SM4、XOR 掩码密钥、其他子进程 | 🔬 | 若命中则 R16 全活，一劳永逸 | 9 条搜索线已穷尽无命中，期望收益很低 |
| R13 | 进程间 IPC 嗅探 | 抓 QQ 主/渲染进程间 mojo 命名管道流量 | 🔬 | 可能含明文消息事件 | Chromium 结构化序列化难解析，研究成本高 |
| R14 | ETW 加密 API 事件 | Windows BCrypt ETW 提供程序可能暴露密钥/明文操作 | 🔬 | 系统级被动，不注入 | 高度研究性，不保证 QQ 走的 API 会发事件 |

#### C 类：文件 / 数据库（零注入）

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| R15 | WAL / .material 备份解析 | 读 nt_msg.db-wal 或 first/last.material 里的页 | 🔑 | 可能比主库更新 | 同样加密，本质依赖 R12 密钥 |
| R16 | nt_msg.db 解密轮询 | 现成 recv-db.ts + dbcrypt.ts，key-found.json 即激活 | 🔑 | **代码 100% 就绪**，结构化数据最全 | 唯一卡点 = 密钥（R12） |
| R17 | 辅助库（FTS/profile/group_info） | 从搜索索引或资料库拿消息 | 💀 | — | 已验证全部带加密 QQ_NT 头，无明文近路 |
| R18 | QQ 自带导出/迁移 | 聊天记录备份与迁移功能 | ✅(手动) | 官方功能 | 非实时、手动或半自动、迁移协议加密，不适合机器人 |
| R19 | 媒体缓存目录监听 | 监听图片/文件缓存目录新增 | ✅(部分) | 能收图片/文件类消息 | 文本消息不收，只能当辅助通道 |

#### D 类：注入 / Hook（⚠️ 违反当前零注入约束，需用户明确放宽才可选）

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| R20 | DLL 注入 hook 密钥函数 | CreateRemoteThread 注入，hook sqlite3_key/codec 直接截获密钥 | ⚠️🔬 | 经典手法，命中即 R16 全活 | 轻量向量已关但远程线程注入未试；完整性检测/封号/白屏风险 |
| R21 | Frida attach | 动态插桩同 R20 | ⚠️🔬 | 灵活 | 同 R20，且 Frida 特征易被检测 |
| R22 | 代理 DLL 劫持 | QQ 目录放 version.dll 等代理 DLL 截密钥 | ⚠️ | 社区 NTQQ 截密钥常用手法 | 需改 QQ 目录文件，违反零修改约束；更新即失效 |
| R23 | asar / 二进制补丁 | 改 QQ 代码 | 💀⚠️ | — | 应用级完整性校验，已验证触发"文件已损坏" |
| R24 | 流量中间人 | mitmproxy 抓 QQ 服务器流量 | 💀 | — | TLS+私有协议+证书固定，基本不可行 |

#### E 类：换客户端 / 换平台（绕开本机 NTQQ）

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| R25 | 官方 QQ 机器人开放平台 API | 注册官方 bot，webhook/websocket 收消息 | ✅(受限) | 最稳、官方支持、不掉线 | 群聊必须 @、主动消息配额、审核，不符"想聊就聊" |
| R26 | 协议库（NapCat/LLOneBot/Lagrange/Chronocat） | 模拟协议直连 | 🚫 | 功能全 | 用户已明确排除：掉线、封号、法律风险 |
| R27 | 旧版 PC QQ / TIM（9.7.x 及更早） | 旧版 Msg3.0.db 解密社区已解决 | ⚠️🔬 | 密钥问题现成解法 | 旧版停服/强制升级、功能缺失、账号风险，需降级日常客户端 |
| R28 | 安卓手机/模拟器 QQ + 通知转发 | 手机通知监听（Tasker/Auto.js/ADB）→ HTTP 推给 PC bot | ✅ | 真实可行、PC 端零接触、通知实时 | 需额外设备/模拟器；通知文本截断（可配手机端 UI 复制补全）；多一套维护 |
| R29 | QQ 频道机器人 API | 官方频道 bot | ✅(不适用) | 官方 | 仅频道，不是普通群/私聊，场景不符 |

#### F 类：组合方案

| # | 组合 | 说明 |
|---|---|---|
| R30 | R2 或 R3（门铃）+ R1（取全文） | 通知触发定向复制，省 CPU 不盲轮询；此前推荐 |
| R31 | R5（列表触发）+ R1（取全文） | 不依赖系统通知权限的纯 UI 版门铃 |
| R32 | R9/R10（结构化）+ R1（兜底） | 内存接收为主、UI 补漏；研发量最大但体验最好 |

#### 状态速查

- **今天就能开工**：R1 R2 R3 R4 R5 R19 R28 R30 R31
- **需研发/研究**：R8 R9 R10 R12 R13 R14 R32
- **被密钥卡（代码就绪）**：R15 R16
- **已验证死路**：R6 R7 R11 R17 R23 R24
- **需放宽零注入约束**：R20 R21 R22 R27
- **官方但受限/不适用**：R25 R29
- **用户已排除**：R26

### 决策 B：发送路线（完整方案目录，由用户选定）

> 编号 S1–S22。可行性标注同决策 A。当前默认 = S1（已端到端验证）。

#### A 类：UI 自动化（零注入，符合当前约束）

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| S1 | **全坐标 UI 链路（已验证）** | 搜索框(0.14,0.071)→粘贴会话名→双击结果(0.183,0.17)→输入框(0.594,0.897)→粘贴→发送按钮(0.9295,0.964)；bot-pid 绑定+比例坐标 | ✅已验证 | 今天就能用，中文剪贴板+Ctrl+V 已解决 | 固定比例坐标怕版本/布局变化；抢 bot 窗口焦点 |
| S2 | 键盘流简化 | SetForegroundWindow 聚焦 bot 窗→搜索快捷键→粘贴→Enter 打开会话→粘贴→Enter 发送 | ✅ | 坐标依赖最小、更快 | Enter 发送依赖 QQ 设置（默认 Enter，若用户改 Ctrl+Enter 需适配） |
| S3 | 最近会话直点 | 高频会话已在会话列表→按列表位置直接点击→粘贴→Enter，免搜索 | ✅ | 常用群/私聊最快 | 会话掉出列表需回退 S1/S2；列表顺序会变 |
| S4 | 图像识别定位 | OpenCV 模板匹配搜索框/输入框/发送按钮，替代固定比例 | ✅(升级) | 抗布局/版本变化，S1 的稳健化 | 需维护模板图；多一层依赖 |
| S5 | OCR 定位控件 | 截屏 OCR 找"发送"按钮/输入区坐标 | ✅ | 不依赖模板 | 重、慢、准确率波动 |
| S6 | UIA Invoke 模式 | 无障碍树调用按钮 | 💀 | — | 此 build UIA 编译期剥离（同 R6） |
| S7 | Win32 合成消息 | PostMessage WM_CHAR/WM_KEYDOWN 直投 HWND | 💀🔬 | 不抢焦点（若可用） | Chromium 自绘输入管线，基本不吃合成消息 |
| S8 | 通知中心快捷回复 | Windows toast 若带"回复"输入框，直接在通知上回复 | 🔬 | **完全不碰 QQ 窗口** | 待验证 NTQQ toast 是否支持 inline reply；只能回最近一条 |

#### B 类：QQ 自带功能 / 文件

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| S9 | 状态自动回复 | QQ 离开/忙碌状态的固定自动回复文本，UI 切换状态换话术 | ✅(受限) | 零研发 | 固定 canned 文本，不能按消息内容智能回，不算真机器人 |
| S10 | 直接写 DB 插消息 | 向 nt_msg.db 插入发送记录 | 💀 | — | DB 是**记录不是发件箱**，插入不会触发网络发送；且还有密钥问题 |

#### C 类：注入 / Hook（⚠️ 违反当前零注入约束）

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| S11 | DLL 注入调内部 send | hook/调用 QQ 内部发送函数 | ⚠️🔬 | 结构化发送（富文本、@、图片）、不抢焦点 | 完整性/封号/白屏风险；需逆向 send 调用 |
| S12 | Frida 调 send | 动态插桩同上 | ⚠️🔬 | 灵活 | 同 S11，Frida 特征易检测 |
| S13 | CDP 发送 | Input.dispatchKeyEvent / Runtime.evaluate 调内部 API | 💀 | （若门禁可破则最干净） | CDP 被 JWT 门禁（errCode 4001），已验证不可廉价破解 |
| S14 | 代理 DLL 劫持 | QQ 目录放代理 DLL 暴露 send | ⚠️ | 社区手法 | 改 QQ 目录文件，违反零修改；更新失效 |
| S15 | asar 补丁暴露 send | 改 QQ 代码加发送接口 | 💀⚠️ | — | 应用级完整性校验（同 R23） |

#### D 类：换客户端 / 平台

| # | 方案 | 原理 | 可行性 | 优点 | 缺点 |
|---|---|---|---|---|---|
| S16 | 官方机器人 API 发送 | 开放平台被动回复/主动消息接口 | ✅(受限) | 最稳、结构化富文本 | 被动回复有时效窗口、主动消息配额、群聊须 @ |
| S17 | 协议库发送 | NapCat/Lagrange 等 | 🚫 | 功能全 | 用户已排除（掉线/封号/法律风险） |
| S18 | 旧版 QQ/TIM UI 自动化 | 降级客户端后跑 S1–S5 | ⚠️ | 旧版可能无完整性校验 | 停服/强制升级/账号风险（同 R27） |
| S19 | 手机 QQ 自动化发送 | Auto.js/ADB 点击+输入，或手机剪贴板 | ✅ | PC 零接触，配 R28 收组成全手机方案 | 需额外设备/模拟器；UI 脚本维护 |
| S20 | QQ 频道 API | 频道 bot 发送 | 💀(不适用) | — | 仅频道，非普通群/私聊 |

#### E 类：组合

| # | 组合 | 说明 |
|---|---|---|
| S21 | S3 优先 + S2 兜底 + S4 定位 | 日常稳健发送：最近会话直点，掉列表走键盘流，图像识别抗布局变化 |
| S22 | R28 收 + S19 发 | 全手机端闭环，PC 上的 QQ 完全不被自动化触碰 |

#### 状态速查

- **已验证可用**：S1
- **今天就能开工**：S2 S3 S9 S19 S21
- **需研发/验证**：S4 S5 S8 S22
- **已验证死路**：S6 S7 S10 S13 S15 S20
- **需放宽零注入约束**：S11 S12 S14 S18
- **官方但受限**：S16
- **用户已排除**：S17

---

### 决策 C：LLM 端点

用户需提供 baseURL / apiKey / model（OpenAI 兼容）。框架已支持，填 config 即可。

### 决策 D：是否接受 UI 方案的固有限制

- 回复延迟 = 轮询/通知间隔 + UI 操作时间（秒级）。
- bot QQ 窗口会被自动化操作占用（用户同时用主号不受影响，但 bot 窗口不能同时手动用）。
- 只能按昵称/群名定位会话，重名需人工消歧。

### 决策 E：QQ 版本策略

当前 9.9.31，9.9.37 已 staged。**升级可能改变 DB 格式/UI 坐标/内存布局**，所有逆向结论需回归验证。建议冻结版本直到机器人稳定。

---

## 6. 恢复工作的步骤（给接手的工具）

1. 读本文档 + `config.json` + `persona.md`，明确账号绑定与硬约束。
2. `powershell -File tools/qq-procs.ps1` 确认两个 QQ 实例都在；**若 QQ 重启过**：重跑 `tools/mem-allsalt-scan.ps1` 刷新 `data/bot-pid.txt`（UI 绑定依赖它）。
2.5 **发消息前先跑 `tools/ui-rect.ps1`**：必须输出 4 个数字才算就绪。输出 `ERR_BOT_WINDOW_MISSING` = bot 窗口被收进托盘，手动点开 bot 那个 QQ 窗口再试（`tools/ui-windows.ps1` 可看隐藏窗口状态）。绝不删掉 bot-pid.txt 来"绕过"——那等于放弃绑定。
3. 按决策 A 的结果实现接收适配器，事件格式对齐 `recv-db.ts` 的 onEvent 结构（selfUin/kind/peerUin/groupId/senderUin/text/time…），engine 无需改。
4. 让用户打开 **WebUI** `http://127.0.0.1:8787`：在「模型供应」里选厂商、填 API Key、点「测试」，再把默认模型指过去。人设、回复节奏、插件都在同一个面板里改，**保存即生效不必重启**。
5. `npm run bot`（会同时起 WebUI；只想改配置而不收消息可用 `npm run webui`）。
6. 真实消息端到端测试：主号给 bot 发私聊 / 测试用群发消息 → 观察人设回复。
7. 若走 DB 路线且未来出现密钥：写入 `data/key-found.json`（字段：candidate/passForm/mode/salt/reserve/ps/base/layout/cipher/ctrsrc/bits/family），recv-db 3 秒内自动激活；验证前先重新拷贝 live 库到 `data/dbcopy/`。

### 已知坑（勿再踩）

- PowerShell 5.1：**.ps1 保持纯 ASCII**；bash 双引号内联 `powershell -Command` 会展开 `$_` → 用脚本文件，别内联。
- UI：单击=选中会话，**双击=打开**；中文必须剪贴板+Ctrl+V（STA）。
- 多实例：强杀单个 QQ 会白屏另一个；全杀→等 4s→起一个。白屏补救：清 GPU/Code/Cache 缓存（不碰登录存储）后单实例启动。
- 内存 dump/候选/bot-pid 都是**快照**，QQ 重启即过期。
- 后台长任务：换会话后旧任务输出文件会被删、通知可能丢失，但 node 子进程继续跑——用 `Get-Process node` 的 StartTime/CPU 追踪（搜索 worker = CPU>60s）。
- 验证密钥前确认 dbcopy 与 live 库一致（曾出现 salt 相同但页 2 密文不同的陈旧快照）。

---

## 7. 一句话总结

**接收（R3 通知中心）与发送（UI 自动化）都已实测打通，控制台/多模型/插件已就绪；现在唯一的阻塞是给某个厂商填一个 API Key。填完即可端到端对话。**

---

## 8. 2026-11-17 13:40 第二轮修正（实测）

### 已修 ✅

1. **UI 发送 fail-closed**：`tools/ui-rect.ps1` 重写。只认 `data/bot-pid.txt` 指定的 QQ 进程；进程不存在/非 QQ/主窗口句柄为 0 一律返回 `ERR_*` 且 exit≠0，**删除"回落到第一个 QQ 窗口"的分支**；前台化后校验 `GetForegroundWindow()==目标 hwnd`，失败再试一次 ALT 键技巧，仍失败返回 `ERR_FOCUS_FAILED`；窗口小于 480x360 返回 `ERR_WINDOW_TOO_SMALL`。
   - 起因：13:36 实测 bot(34260) 主窗口在托盘（hwnd=0），唯一"带标题窗口"是**主号实例 12520 的 160x28 小窗**，旧逻辑会回落到它并把点击坐标算成 NaN/乱点 → 直接在主号窗口里打字发送。
2. `src/send-ui.ts` 的 `rect()` 增加严格解析：非 `L T W H` 四段或非有限数或尺寸过小 → 抛错中止，不再带着 NaN 点鼠标。已实测：`send()` 返回 `ui-rect.ps1 exit 2: ERR_BOT_WINDOW_MISSING pid=34260`，全程零点击。
3. `tools/screenshot.ps1` 同步改为只认 bot-pid（原来也会回落到主号窗口）。
4. `tools/mem-allsalt-scan.ps1` 选择逻辑修正：按**命中数最多**取 bot（原来取最后一次命中，被 12520 的 18 处杂散命中覆盖）；祖先必须是 QQ.exe 且有窗口（原来会一路走到 explorer.exe 并把 pid 14928 写进 bot-pid.txt）；候选只收 bot 的；新增 `data/salt-scan.json` 审计。
5. 重扫结果：`34260` 命中 68 处（10249 候选）→ `bot-pid.txt=34260`；`12520` 18 处杂散。

### 仍未修 ❌（拿到密钥也跑不通的 6 个洞，按优先级）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `src/recv-db.ts:138-142` | `groupName` 恒 `""`、`atMe` 恒 `false`、`groupId` 错填发送者 uin |
| 2 | `src/engine.ts:22` | 群白名单 `groups.includes(evt.groupName)` 因上条永远 false → 群消息 100% 不回复 |
| 3 | `src/engine.ts:23` + `config.json` | 群触发依赖 `cfg.botName`，config 里没有这个字段 |
| 4 | `src/recv-db.ts:94-102` | 只解密主库，不读 `nt_msg.db-wal`（当前 WAL 478KB），checkpoint 前的新消息会漏 |
| 5 | `src/send-ui.ts:56` | `lastTarget` 缓存：用户中途手动切会话后仍按旧目标粘贴 → 可能发错会话 |
| 6 | 私聊路径 | `peerName` 恒空，target 退化成纯数字 uin，依赖 QQ 搜索的精确匹配 |

### 环境结论更新

- QQ 仍是 9.9.31（9.9.37 zip staged 未解包）；`versions/config.json`、`setting.json` 今天被改，自动更新仍在活动 → 仍建议冻结。
- bot 库 `1000000000/nt_msg.db` 今天 13:25 仍在写（1,815,552B），说明 bot 实例在线；主号库 1.33GB。
- `data/dbcopy/live.db` 仍是 11/16 22:55 快照（比 live 少 57KB），**但前 1024 字节头与 live 完全一致**（`cmp -n 1024` 通过），salt 针与 oracle 仍然有效；密钥验证前仍需重拷。
- `data/` 516MB，其中 533MB 级 memdump 是 11/16 的旧进程快照（QQ 未重启才勉强可用，重启即废）。`SnowLuma-main`(44MB) + `main-exe`(110MB) 是已排除路线的遗留，可删。

---

## 9. 2026-11-17 14:00 接收路线定案：R3 实测可用 ✅

### 结论：接收不再被密钥卡死，走 R3（通知中心库直读）

之前把 R3 标成"只有昵称、文本截断"是**低估**了。实测 QQ 的 toast payload 里带完整结构化字段：

```xml
<toast launch="ntqq-notification://externalCommand?subcmd=openExternalWindow;
        peerUid=u_iozvX_0O3SUPU1xxon9ECw;peerUin=1000000001;peerName=好友A;
        chatType=1;fuin=1000000000;windowName=MainWindow;scene=aio;">
  <text hint-maxLines="1">好友A</text>   <!-- 发送者/群名 -->
  <text hint-maxLines="1">12345678910</text> <!-- 正文（可能截断） -->
</toast>
```

- `peerUin` = **真实 QQ 号**（不是只有昵称，HANDOFF 原文判断有误）
- `chatType`：1 = 私聊（群聊值待一条真实群消息确认，预期 2）
- `fuin` = 收到通知的账号 → **可用来过滤主号的 toast**（关键，否则会把主号的消息当 bot 的）
- `ArrivalTime` 是 Windows FILETIME（100ns/1601 起），必须先转 epoch ms（用 BigInt，18 位超 JS 精度）

### 已交付

- `src/recv-notify.ts`：轮询 `%LocalAppData%\Microsoft\Windows\Notifications\wpndatabase.db`（连同 -wal/-shm 一起拷贝快照，按 size+mtime 去重，默认 1.5s），解析 toast → 事件，结构与 `recv-db.ts` 对齐（`engine` 零改动）。
  - `node src/recv-notify.ts` = 回放最近 5 条 QQ toast + 解析结果
  - `node src/recv-notify.ts --live` = 只监听打印，不回复
- `config.json` 新增 `receive: "notify"` / `receiveIntervalMs: 1500` / `botName: "爱弥斯"`（群聊触发用的昵称，待用户确认）
- `src/index.ts`：按 `cfg.receive` 选择 `recv-notify`（notify）或 `recv-db`（db）
- 事件同时落 `data/notify-archive.jsonl`（见下方"toast 会消失"）
- `tools/probe-wpn.mjs`（结构探测）、`tools/watch-wpn.mjs`（早期监听原型，已被 recv-notify 取代）

**实测**：主号发 "1" → 1.5s 内抓到 `toast-3246`，`kind=private peerUin=1000000001 text="1" time=2026-11-17 13:49:13`。`npm run bot` 启动正常，`receive=notify` 生效。

### R3 的三个真实限制（必须知道）

1. **toast 会被清掉**：用户点掉通知或清空操作中心后，行立刻从库里删除（实测 3242 号行几秒后消失，总数从 8 回到 7）。所以轮询必须高频（1.5s）+ 自己存归档，绝不能依赖"稍后再读"。
2. **正文可能截断**：`hint-maxLines="1"`。事件里 `previewOnly: true` 标记了这点；超长消息需要 R1（切会话全选复制）补齐。
3. **依赖通知开关**：QQ handler(274) 需保持 `s:toast=1`，且系统勿扰/专注助手必须关（本次就是用户关掉免打扰后才通的）。

### 仍缺 / 下一步

- [ ] LLM 三项配置（`config.json` 的 `llm.*` 仍是占位符）→ 这是端到端回复的**唯一剩余阻塞**
- [ ] 群聊 payload 格式确认（需在"测试用群"发一条给 bot，看 `chatType` 和群名/发送者怎么切分）
- [ ] 第 8 节列出的 6 个逻辑洞里，`recv-db.ts` 的 4 条（群名/atMe/WAL）已不适用于 notify 路线；但 `engine.ts:22` 群白名单、`engine.ts:23` 的 `botName`、`send-ui.ts` 的 `lastTarget` 缓存仍需修
- [ ] 长消息截断的 R1 补齐（门铃=notify，取全文=UI 复制），即原 R30
---

## 10. 2026-11-17 14:05 故障恢复能力（重启 / QQ 关后台 / 断网）

详见 **`RECOVERY.md`**（面向操作的完整手册）。要点：

- `tools/doctor.ps1` 只读体检，8 项检查 + exit code（0 健康 / 1 降级 / 2 致命）。
- `tools/recover.ps1` 一键恢复：pid 失效自动重扫、窗口可选恢复、bot 进程自动拉起、末尾复检。
- 断网：`src/llm.ts` 改为退避重试 3 次（1s/2s/4s），只重试网络错误与 429/5xx，4xx 不重试；失败只记 `llm-error`，不回滚状态。
- `send-ui.ts` 增加 pid 变化检测：`bot-pid.txt` 变了就清 `lastTarget`，避免 QQ 重启后把回复粘进错误的会话。

### 本机窗口事实（重要，别再猜）

| hwnd | 尺寸 | 身份 |
|---|---|---|
| 724632 | 1178x914 | **主面板**（发送基准） |
| 921934 | 800x600 | 窄面板，**不是**主面板 |
| 724632 | 160x28 | 主面板收进托盘后的浮条（同一 hwnd） |

结论：`ui-restore` 不能按"面积最大"选窗口（主面板收起时最小），改为优先 `data/ui-state.json` 里的 hwnd（ui-rect 每次成功都会写），其次"可见但很小"的窗口。

### 两个踩过的坑

- **`.ps1` 必须纯 ASCII**：PS 5.1 按 ANSI 读无 BOM 脚本，中文注释会变乱码并报"意外的标记 }"。
- **`.ps1` 里别用 `Start-Process` 起 bot**：本机环境有 `HTTPS_PROXY`/`https_proxy` 大小写重复键，PS 5.1 直接抛"字典中的关键字重复"，改用 .NET `ProcessStartInfo`。

### 当前状态

`recover.ps1` 全流程跑通：pid 重绑、窗口恢复、bot 拉起、复检都验证过（曾拉起 pid 40328 / 35868 并输出 `receive=notify`、`baseline 3248`）。doctor 仅剩 `llm-config` FAIL（占位符未填）。

> **注意**：本次验证是在受限沙箱里做的，工具调用结束时其子进程会被回收，所以"启动后长期存活"没能在这里验证。你在**自己的 PowerShell 窗口**里跑 `recover.ps1`（或按 `RECOVERY.md` 第 5 节挂计划任务）时，node 进程会正常常驻，不受这个限制。

---

## 11. 2026-11-17 14:40 WebUI + 多模型 + 插件（v0.2）

### 做了什么

一套本地控制台 + 把单一 LLM 客户端换成多厂商路由 + 插件内核。`npm run bot` 一条命令同时起「接收器 + 引擎 + WebUI」。

| 能力 | 位置 | 说明 |
|---|---|---|
| 控制台 | `src/webui.ts` + `webui/` | 127.0.0.1:8787，7 个面板：概览/人设/回复节奏/模型供应/插件/日志/会话 |
| 配置热加载 | `src/config.ts` | 保存即生效；改接收间隔会自动重建定时器，改人设下一条消息就用新内容 |
| 多厂商 | `src/providers.ts` + `src/llm.ts` | 24 家预置，除 Key 外全填；openai/anthropic/azure 三种协议 |
| 故障转移 | `src/llm.ts` | 主模型 + 有序 fallback 链；失败 3 次熔断 60s；每厂商可设 RPM |
| 插件 | `src/plugins.ts` + `plugins/*.mjs` | 5 个钩子、热重载、错误隔离、KV 存储；自带 4 个示例 |
| 拟人节奏 | `src/engine.ts` | 读延迟区间、按字数的打字延迟、长回复拆条、限流 |

### 配置结构变了（重要）

`config.json` 从「`llm: {baseURL,apiKey,model}`」变成：

```json
{
  "models": { "default": "deepseek/deepseek-chat", "private": "", "group": "",
              "temperature": 0.8, "maxTokens": 512, "timeoutMs": 60000,
              "retries": 2, "fallback": true, "fallbackChain": [] },
  "providers": [ { "id": "deepseek", "kind": "openai", "baseURL": "...", "apiKey": "",
                   "models": ["deepseek-chat"], "enabled": true, "priority": 1, "rpm": 0 } ],
  "reply": { "minIntervalMs": 1200, "maxPerMinute": 8, "readDelayMs": [500,1600],
             "typingSpeedCps": 14, "maxTypingMs": 3500, "splitSegments": 2,
             "quietHours": { "enabled": false, "start": "23:30", "end": "08:00" } },
  "plugins": { "disabled": [] },
  "webui": { "port": 8787, "host": "127.0.0.1", "token": "" }
}
```

- 模型引用格式 **`providerId/model`**；模型名本身带斜杠也能正确解析（优先精确匹配 models 列表，再按 `providerId/` 前缀切）。
- 老配置会在首次加载时自动迁移（`guessPreset` 按 baseURL 反查厂商），迁移后写回文件，原 `llm` 字段删除。
- `webui.token` 非空时 `/api/*` 需带 `x-token`（前端会提示输入，存 localStorage）。

### 插件钩子约定

```js
export const meta = { title, description, version };
export function setup(ctx) {
  return {
    onMessage(evt),            // false=丢弃 / string=直接回复(不走 LLM) / 其它=继续
    beforeReply({evt,messages}),// 返回新 messages
    afterReply({evt,reply}),   // 返回 string 或 { text, segments: [...] }
    afterSend({evt,reply}),
    onStartup()
  };
}
```
`ctx` = `{ cfg(), log(), kv{get,set,del,all}, chat(messages,opts), dir }`。
单插件连续报错 5 次自动停用；WebUI「全部重载」可恢复。插件 KV 落在 `data/plugins/<name>.json`。

### 实测证据

- `doctor.ps1` 已改成校验新结构：`[OK] bot-window visible 1178x914`、`[FAIL] llm-config no provider has an apiKey`（预期，等待填 Key）。
- 起 `tools/mock-llm.mjs 8899` 做假模型，验证：添加厂商 → 拉取模型（2 个）→ 连通测试 3ms → 对话成功。
- `QQBOT_DRY_SEND=1` 干跑引擎（不点鼠标）：私聊长回复拆成 2 条、群聊未 @ 自动跳过、群聊 @ 后回复 2 条，会话记忆正确落盘。
- 热重建验证：WebUI 改 `receiveIntervalMs` 1500→2500，日志出现 `接收器 notify 已启动，间隔 2500ms`，无需重启进程。

### 边界与注意事项

- WebUI 只监听 127.0.0.1；要远程访问请自己套反向代理并设 `webui.token`。
- 控制台与 bot 同进程，**WebUI 挂了不影响 bot**（server `error` 事件只打日志）；但 `bot` 进程挂了 WebUI 也一起没了。
- 插件是本地代码，等同于给 bot 开写权限，只放自己信得过的。
- UI 发送仍受「bot 窗口必须存在且前台化成功」约束，WebUI 里能看到 `send-error` 日志便于排查。

---

## 12. 2026-11-17 15:00 v0.3 消除九条"沉默掉线"

`OFFLINE-RISKS.md` 里第 9 节列的九条「进程活着但已经废了」的故障，全部处理完。
共同基础是**心跳 + 告警中心**：不再以「进程在不在」判断健康，而是看心跳、看接收快照、看发送回执。

### 新增/改动

| 文件 | 作用 |
|---|---|
| `src/runtime.ts` | 告警中心 `runtime.alert(code, level, msg)`：按 code 去重合并、计数、置顶；落盘 `data/alerts.jsonl`；新增 `receiverHealth` / `sendHealth` |
| `src/heartbeat.ts` | 每 60s 写 `data/heartbeat.json`（含计数、接收健康、最近事件时间）；检测到间隔 > 3 个周期就判为睡眠/挂起 |
| `src/imgprobe.ts` | 零依赖 BMP 解析 + 墨迹统计 + 三点比对判据 |
| `tools/ui-probe.ps1` | 按坐标截 BMP（未压缩，Node 可直接读像素） |
| `tools/ui-focus-ok.ps1` | 点击前校验前台窗口仍属于 bot pid，否则中止（防点进别的程序） |
| `tools/ui-clear.ps1` | 清空当前输入框（Ctrl+A / Delete），回执自检与失败善后用 |
| `tools/session-state.ps1` | 输出 ACTIVE / LOCKED，判断是否锁屏 |
| `tools/watchdog.ps1` | 读心跳做自愈：进程死了拉起、心跳卡死则杀掉重启、窗口丢了可恢复、pid 失效可重扫 |
| `tools/window-geom.ps1` | 打印屏幕/窗口/客户区几何，排查坐标问题用 |

已改：

- `src/recv-notify.ts`：快照失败带原因 + 连续失败告警；**handler 每轮重查**；**Id/时间双判据** + msgId 去重 + 基线自校正；过期消息打 `stale`
- `src/send-ui.ts`：发送前后三点墨迹比对；未确认自动重点一次；仍失败抛 `SEND_UNCONFIRMED`；每次点击前 `ui-focus-ok`
- `src/llm.ts`：`classifyError` 把 401/402/403/404/429/网络/超长分级，成功即清红字
- `src/memory.ts`：token 预算裁剪（`estTokens`）+ 原子写
- `src/engine.ts`：跳过 `stale`；捕获上下文超长后裁到最近 4 条重试
- `src/plugins.ts`：失败 5 次告警；**重载后 failCount 归零**（原来重载也救不回来）；`beforeReply` 返回空数组时回滚
- `config.ts` / `config.json`：新增 `reply.verifySend`、`reply.staleAfterMs`、`models.historyTokens`
- `webui/`：概览页告警横幅（可清除）、接收健康度、回复页新增「发送可靠性」卡片
- `tools/doctor.ps1`：新增 `session` 与 `heartbeat` 两项检查

### 实测证据

```
# 单测（21 项，全通过）
配置新字段 / token 预算 / 告警去重与清除 / 快照告警阈值 / 焦点失败阈值 / 插件停用与重载恢复 / 心跳文件

# 真机回执（QQ 输入框真实像素，深色主题）
[probe-only] empty=504 full=1463 delta=959   -> 区域敏感，判据可用
长文本→空 PASS / 长文本→长文本 PASS / 短文本→空 PASS / 短文本→短文本 PASS

# 接收器
[rcv-notify] QQ handler = 274（每轮复查，变更会自动跟随）
[rcv-notify] baseline id=3251 ft=134393707682283060（不回放历史）

# 上下文超长自动降级
12 条历史 + mock-context(>5 条即 400) -> 裁剪后仍成功回复，告警 llm-context-trim
# 通道失败分级
baseURL 指向死端口 -> llm-network + llm-all-failed；换回可用通道后红字自动清除

# 看门狗
[heartbeat STALE 606s] -> 杀掉目标 pid，并检测到 bot 已在运行（ALREADY_RUNNING pid=43664）

# doctor
[OK] session unlocked / [OK] heartbeat beat 1s ago / 仅 llm-config FAIL（无 Key）
```

### 两个实测踩到的坑（已在代码里修）

- **node:sqlite 读 18 位 FILETIME 会抛** `Value is too large to be represented as a JavaScript number`。
  必须 `CAST(ArrivalTime AS TEXT)` 再用 BigInt 解析 —— 原来读基线就是这么静默失败的第一个 tick。
- **`Clipboard.SetText("")` 会抛**，随后 Ctrl+V 会把剪贴板上**上一次的残留内容**粘出去。
  `ui-paste.ps1` 已加空串短路。

### 已知残留

- R-11（群消息免打扰）无法从通知侧检测：群里不产生 toast，就没有任何信号可看。
- `PROBE` 区域按 1178×914 标定；换分辨率/缩放后若出现「发送未确认」，先跑
  `QQBOT_PROBE_ONLY=1 node -e "import('./src/send-ui.ts').then(m=>m.send('x','自检文本'))"` 重新确认 delta。
- 三条线上仍有 R-50（窗口尺寸变化导致比例坐标偏移）等 UI 自动化固有风险，见 `OFFLINE-RISKS.md` 第 4 节。

---

## 13. 2026-11-17 19:15 填了 Key 仍报 401 —— 三个连带问题

用户填好真实 DeepSeek Key 后，模型供应页「测试」仍返回
`401 Authentication Fails (governor)`，概览页红字横幅也不消。排查后是三个独立问题叠在一起：

### 13.1 测试按钮测的是"已保存的 Key"，不是输入框里的

`POST /api/providers/:id/test` 走 `providerById(id)` → `store.get()`，读的是**已落盘并在内存里**的
provider。用户填完 Key 直接点「测试」，测到的还是上一次那个假 Key，所以稳定 401，
看上去像"我明明填了 Key 还是不行"。

**修**：`webui/app.js` 加 `flushKey()`，点「测试」或「拉取模型」前先看输入框里有没有未保存的 Key，
有就 `PATCH` 落盘再请求，并 toast 一句「已先保存 Key，正在测试…」。
「保存」按钮保留，习惯先存的人不受影响。

### 13.2 测试通过也不清红字

`chat()` 成功会 `clearAlert()` 掉 `llm-auth/llm-quota/llm-ratelimit/llm-network/llm-all-failed`，
但 `testProvider()` 和 `listModels()` 不走 `chat()`，所以**连通性测试已经"通了"，横幅还挂着 401**。

**修**：抽出 `clearLlmAlerts()`，三处共用；`listModels` 能拉到模型列表也等同"Key 有效"，一起销账。
`testProvider` 失败时也按 `classifyError()` 分级告警（并把 code 回给前端），
让横幅始终反映**最近一次探测**的真实状态。

### 13.3 doctor 的 receive 检查会误报 FATAL

「last event 323min ago」被判 FATAL —— 但那是**没人给 bot 发消息**，不是故障。
低流量 bot 必然长时间空闲，这个检查按天算都会红。

**修**：改为区分两件事——

- 通知库在涨（`db ≤ 60min`）但 `notify-archive.jsonl` 停在 30min 前 → **WARN**，指向 QQ 通知内容开关 / 告警
- 两边都静 → **WARN** "idle - nobody messaged the bot"

只有 `wpndatabase.db` 一天没写过（WPN 被禁用）才升 FAIL。现在空闲状态是 `DEGRADED (1 warn)`，不再 FATAL。

### 13.4 顺带

- `testProvider` 的 `maxTokens` 16 → 64。deepseek-flash 是推理模型，16 token 会被思维链吃光，
  测试结果里返回的是半句思考（`"The user is asking me to reply with exactly two characters…"`）。
- 诊断用事实：Key 长度 35（`sk-` + 32 hex）符合 DeepSeek 格式；直连 `GET /v1/models` 200、
  `POST /v1/chat/completions` 200，说明 Key 本身没问题，问题全在上面三条。

### 13.5 修复后的实测

```
POST /api/chat-test        -> {"ok":true,"providerId":"deepseek","model":"deepseek-flash","ms":709}
POST /api/providers/deepseek/test -> {"ok":true,"ms":752,...}
GET  /api/alerts           -> {"alerts":[]}
引擎干跑（QQBOT_DRY_SEND=1） -> [llm] deepseek/deepseek-flash ok 876ms -> [dry] done in 4440ms
                               回复内容："我是霎弥斯，你 QQ 里那个随叫随到的朋友。"
doctor.ps1                 -> 8 OK / 1 WARN（receive idle），DEGRADED
```

注意 bot 已重启（新 pid，8787），`data/bot-stdout.log` 里旧内容仍在（`tee -a` 追加）。

---

## 14. 2026-11-17 19:45 一键启动 + 发送链路三处真机修正

### 14.1 双击即用（新文件）

| 文件 | 作用 |
|---|---|
| `启动bot.bat` | 双击跑 `recover.ps1 -RestoreWindow`：查 QQ → 重绑实例 → 把主面板从托盘拉出来 → 启动 bot → 体检，最后打开 `http://127.0.0.1:8787` |
| `停止bot.bat` | 只停 node 进程，QQ 不动（bot 号保持登录，重启不用重新扫码） |
| `tools/stop-bot.ps1` | 停止脚本本体（ASCII，可被 WebUI/别的脚本复用） |

`.bat` 内容纯 ASCII + CRLF（PS 5.1 / cmd 对编码的容忍度很低，别再塞中文进去）。
启动失败时（`recover` exit ≥ 2）不进浏览器，直接停在窗口里显示原因。

**一个必须知道的细节**：从「我这个工具体系」里调的 `Start-Process` / `WScript.Shell` 会被安全策略拦，
而且子进程会随调用结束被回收；你自己双击 `.bat` 不受这两个限制。

### 14.2 三道新的硬门禁（都是为了不"发错人"）

1. **`mem-allsalt-scan.ps1` 加了 `MIN_HITS = 40`**：bot 号实测 68 处命中，非 bot 实例只有 ~18 处杂散命中。
   原来只取"命中最多"，bot 号没登录时就可能把**主号**绑成 bot —— 那意味着每条回复都从你主号发出去（R-09）。
   现在低于下限直接拒绝重绑（exit 3），`bot-pid.txt` 保持原样（失效 pid 会 fail-closed）。
2. **`recover.ps1` 加了绑定门禁**：重扫后如果 `bot-pid.txt` 指向的进程不是活着的 QQ，直接 exit 2，
   **不启动 bot** —— 否则会拉起一个"能收不能发"的半死实例，白占端口还让你以为在跑。
3. **`doctor.ps1` 的 receive 判定**（本轮早先改的）：空闲不再是 FATAL，只有"通知库在涨但我们没解析到"才可疑。

### 14.3 发送链路：三个真机上必然踩到的坑

**(a) 窗口进托盘 → 自动恢复后重试**
`rect()` 遇到 `ERR_BOT_WINDOW_MISSING / ERR_WINDOW_TOO_SMALL / ERR_FOCUS_FAILED` 时，
先 `ui-restore.ps1 -Yes` 把窗口拉出来，等 400ms 再试一次。失败发生在**点击之前**，重试是安全的（不会重复发送）。
20 秒冷却，避免每条消息都去戳托盘。

**(b) 前台被别的窗口抢走 → 重新前台化后重试一次**
实测：QQ 主面板被播放器盖住时 `ui-focus-ok.ps1` 报 `ERR_FOCUS_LOST fgPid=10248`（QQMusic），
旧逻辑直接丢这条回复。现在 `ensureFocus()` 会调 `ui-rect.ps1`（内部前台化 + 校验）再试一次，
仍拿不到前台才中止。注意：只重试"前台化"本身，不重跑发送流程 —— 否则会把文字贴两遍。

**(c) 粘贴后像素零变化 → 这是"没贴上"，不是"区域不敏感"**
旧逻辑把 `full - empty < 60` 一律当成"回执区域对文字不敏感"然后**跳过校验**。
但输入框是空的时候，点发送等于什么也没发，代码却记 `out` —— R-59 从后门又回来了。
现在区分两种情况：

- `delta == 0`（像素完全一致）→ 重点输入框 + 重粘一次；仍为 0 就 `SEND_NO_INPUT` 中止并告警，绝不点发送
- `0 < delta < 60` → 才允许跳过校验

### 14.4 PROBE 区域重新标定（重要）

用 `ui-probe.ps1` 分两次截图做逐行差分，量出真实布局（窗口 1178x914）：

```
y 0.855 ~ 0.870   工具栏图标行（剪刀/文件夹/图片/麦克风…）—— 静态，永远不变
y 0.885 ~ 0.905   输入框文字行     <- 真正该测的
y 0.955 ~ 0.970   发送按钮         <- 有文字时变蓝，也可利用
```

旧 `PROBE.top = 0.855 / height 0.078` 正好压在工具栏上，所以才会出现 `empty=504 full=504 delta=0`。
新值 `{ left: 0.34, top: 0.876, width: 0.55, height: 0.034 }`，实测 `empty=0 full=164 delta=164` ——
空态是纯背景 0，有字 164，从"被静态图标稀释"变成"干净的二值"。

换分辨率/缩放后重标：用逐行差分定位文字行，或直接 `QQBOT_PROBE_ONLY=1` 看 `empty/full/delta`，
`empty` 应该接近 0。

### 14.5 其它

- `botName` = **`爱弥斯`**。本节当时"截图确认 QQ 昵称是霎弥斯"的判断是**看错了**（"霎"与"爱"字形接近），
  已于 2026-11-17 22:57 纠正回 `爱弥斯`。旁证：`webui/index.html` 从第一版起写的就是"爱弥斯 · QQ Bot 控制台"，
  另外 `persona.md`、`config.json` 里当时的"霎"与它不一致 —— 一个名字出现两套写法，本身就是错的信号。
  群聊 @ 判定靠 `text.includes(cfg.botName)`，名字错了群里永远不回复；所以改动前先看 `webui` 标题与 QQ 昵称是否一致。
- 新增 `tools/hung-check.ps1 -ProcId <pid>`：逐窗口 `SendMessageTimeout(WM_NULL, 3s)`，
  区分"真挂起"和"只是空闲"。但它只能看**进程消息泵** —— QQ 是 Electron，
  渲染/输入层卡死时消息泵照样应答（`Responding=True`），这种只能重启进程。本轮就遇到一次。

### 14.6 工具层观察（不是产品 bug）

在这套工具里跑长一点的 node 脚本（尤其内部 spawn `-STA` 子进程的），
Bash 调用会以 `SIGTERM` 结束且不返回 stdout。解决办法：`> file 2>&1` 再单独 `cat`。
另外从 PowerShell 工具里用 `WScript.Shell` 启动的 bot 会随调用结束被回收，
跨轮存活的启动方式是在 Bash 里 `run_in_background`。

---

## 15. 2026-11-17 20:12 `SEND_NO_INPUT` 的真正原因：会话面板根本没打开

### 15.1 症状

用户截图：19:56:25 收到「私聊·Transform」一条消息，19:56:47 `发送错 Transform Error:
SEND_NO_INPUT target=Tran...`，概览横幅 `send-no-input / 粘贴两次输入框都没变化`。
日志只有一行 `[send] 粘贴后输入框像素无变化（empty=full=0）-> 重点一次输入框再粘`。

### 15.2 定位过程（都是一手实测，不是猜）

1. `data/ui/probe-full.bmp` 打开是**一整片纯背景**，一个像素的文字都没有。
2. 手动按顺序跑 `ui-rect → click 搜索框 → ui-paste "Transform"`，截图里搜索框**正常出现了
   Transform 和搜索结果**——说明点击和粘贴本身没问题。
3. 再 `双击第一条结果`，截图里聊天面板**正常打开**，输入框、工具栏、蓝色发送按钮全在。
4. 但把 4 分钟前失败那一刻之后的窗口截图翻出来看：**没有任何会话处于打开状态**
   （右半边是企鹅占位图，搜索框是空的）。

结论：粘贴没错、坐标没错，是**那一次「搜索 → 双击结果」没有把会话打开**。
QQNT 在窗口刚被 `SetForegroundWindow` 拉起、或渲染进程刚重启时，双击偶尔会吞掉，
表现是「什么都没发生」，而不是报错。而旧代码只校验"输入框有没有字"，于是把它
误判成"点击没落到输入框"，再粘一遍当然还是 0。

### 15.3 修法：给「会话是否打开」找一个**结构**判据

输入框里有没有字是"结果"，不是"状态"。真正的状态信号是 QQ 右下角那颗**蓝色发送按钮**：
有会话打开时它一定在（输入框为空时也是蓝的），没有会话打开时那块区域是纯背景。

- `src/imgprobe.ts`：`readBmp` 顺带吐出 `rgb`，新增 `blueRatio(img)`（蓝 > 红+40 且蓝 > 90 的像素占比）。
- `src/send-ui.ts`：
  - `SEND_BTN = { left: 0.86, top: 0.93, width: 0.13, height: 0.062 }`、`MIN_BLUE_RATIO = 0.08`
  - `chatOpen(r)` —— 截图算蓝色占比
  - `openChat(r, target)` —— 搜索（先 `ui-clear` 清掉残留搜索词）→ 双击第一条 → **验证**，
    不通过整体重试一次；仍不通过返回 false
  - `doSend` 改成"最多两轮"：每轮先确保会话打开（`lastTarget === target` 且面板确实开着才跳过），
    再点输入框、取空态、粘贴、取满态；像素零变化就整轮重来。
    **所有重试都发生在点发送之前，不存在重复发送。**
  - 两轮都失败时按 `chatOpen` 的结果分开报 `send-no-chat` / `send-no-input`，不再混为一谈。

双向验证：

```
有会话打开  probe-btn.bmp  blueRatio = 0.3362  (阈值 0.08，4 倍余量)
无会话打开  同一区域       blueRatio = 0.0000
```

### 15.4 顺手修掉的第二个坑：短回复会被判成"没贴上"

`PROBE.left` 原来是 `0.34`（x=400），而 QQ 输入框的文字起点在 **x≈326**。
逐行差分量出来（窗口 1178x914）：

```
y 780~791   工具栏图标行
y 806~823   输入文字行      <- 文字左边缘 x≈326
y 866~897   蓝色发送按钮
```

所以像「好」「在」这种一两个字的回复，整句都落在 400 左边，`empty=full=0`，
一样会被判"没贴上"。`PROBE` 改成 `{ left: 0.272, top: 0.876, width: 0.6, height: 0.034 }`
（x 320..1027，故意左边界贴着文字起点、又不碰到左侧分隔线，这样空态仍然是 0）。

### 15.5 实测证据

试粘贴（`QQBOT_PROBE_ONLY=1`，只粘贴+清空，绝不发送）：

```
[probe-only] empty=20 full=1707 delta=1687
```

`empty=20` 是闪烁的光标，`full=1707` 是文字——差值够大，`MIN_INK_DELTA=60` 完全满足。

真实发送一条到「Transform」：

```
probe-empty1.bmp ink=20    （空态：只有光标）
probe-full1.bmp  ink=1971  （满态）
probe-after.bmp  ink=0     （发后：0 <= 20 + (1971-20)*0.45 -> 已发出）
SEND OK in 16549ms
```

QQ 截图确认：右侧出现了 bot 自己发的蓝色气泡「回执自检：这是一条由 bot 发出的测试消息（v0.4）」。

### 15.6 已知代价

- 第一次给某个联系人发消息要 **16s 左右**（要搜索、双击、验证、三次截图）；
  同一联系人后续消息走 `lastTarget` 快路径，约 7s。
  慢的原因是每次 UI 动作都要 spawn 一个 PowerShell 进程（每个 ~0.6s，一轮十几到二十个）。
  想提速就把「点击+粘贴+截图」合并成一个常驻执行器，属于后续优化，不影响正确性。
- 每条回复都会把 bot 的 QQ 窗口抢到前台，这是 UI 自动化的固有代价（R-50）。

---

## 16. 2026-11-17 20:45 发送方案选型：为什么最终是「虚拟机 + 空闲闸门」

### 16.1 先明确物理边界

在 Windows 上做 UI 自动化，抢焦点是**物理必然**，不是实现问题：

- Chromium（QQNT 是 Electron）不消费 `PostMessage(WM_CHAR/WM_LBUTTONDOWN)`，
  合成消息到不了渲染层 —— 决策表 S7 的「完全不能全 QQ 窗口」是对的。
- 唯一可靠的注入是 `SendInput`，而它的落点由「前台窗口 + 物理光标」决定。
  所以要发消息就必须先 `SetForegroundWindow`，必须移动光标。
- 想绕开只能换层：往下（CDP / DLL 注入 = S11/S13），或往外（换执行环境 = S19/S22）。
  S13 已实测被 `errCode 4001` 拦死，S11 要逆内部 send 且有完整性校验 → 封号风险不可控。

结论：**问题不是"哪个 UI 方案更优雅"，而是"要不要继续和用户在同一个桌面里跑"。**

### 16.2 选型结论

| 选择 | 为什么 |
|---|---|
| **主：Hyper-V Win11 虚拟机** | 客户端还是 PC 版 QQ，风控面与现在完全一致；`src/` 一行都不用改；宿主机彻底无感 |
| 否：S19 安卓模拟器/真机 | 可行，但等于换成移动端 QQ（新设备=风控面变大），还要维护一套 adb/UI 脚本 |
| 否：S11 DLL 注入 | 体验最好但风险是"账号没了"，不适合当主力 |
| 否：S2 键盘驱动 | 只解决"鼠标跳"，仍然抢键盘焦点（你打的字会进 QQ），体感没好多少 |

### 16.3 过渡期：空闲闸门（已实现）

在还在宿主机跑的时候，用「用户空闲」作为发送许可，把打扰降到最低。

- `tools/ui-gate.ps1`（只读）：`GetLastInputInfo` 算空闲毫秒 + `GetForegroundWindow` 判断 bot 是否已在前台。
  输出 `idle=<ms> fg=<0|1>`，实测单次 0.6s。
- `src/send-ui.ts` `waitForIdleGate()`：在 **`rect()` 之前**（此时还没抢前台、没动光标）判断——
  - `fg=1`（bot QQ 本来就在前台）→ 直接发，无额外打扰
  - `idle >= sendIdleMs`（默认 45s）→ 发，你不在，抢了也看不见
  - 否则每 5s 重试；超过 `sendMaxWaitMs`（默认 10min）强行发 + `send-forced` warning
- 配置：`reply.sendIdleMs`（0=关闭）、`reply.sendMaxWaitMs`（0=不限），WebUI 回复页新增「发送时机」卡片。
- **VM 里会自动失效**：虚拟机内键鼠永远没输入 → `idle` 一直是满的 → 立即放行。
  所以搬 VM 之后不用关闸门，它自然不生效。

实测（把 idle 门槛设成 1 小时、超时 20s）：

```
[send] 用户正在用电脑（idle=0s），排队等待空闲…
[send] 闸门超时（20 秒），强行发送
[send] 窗口不可用(ERR_BOT_WINDOW_MISSING)，已尝试恢复：RESTORED hwnd=2557846 1178x914
SEND OK in 39666ms
```

QQ 侧确认收到「闸门自检：这条应该在等待超时后才发出」。
同时验证了闸门和托盘自动恢复能串起来工作。

### 16.4 Hyper-V 迁移清单（照着做，别踩坑）

1. **必须用「基本会话」，不要增强会话**。增强会话本质是 RDP，窗口一关就锁屏 →
   `tools/session-state.ps1` 报 LOCKED → `SendInput` 全部失效。基本会话关掉 VMConnect 窗口后仍在跑。
2. **必须开自动登录**（`netplwiz` 或 Sysinternals Autologon）。停在锁屏 = UI 自动化全废。
3. **固定缩放 100%**，分辨率随便（1920x1080 够）。比例坐标跟窗口走，但 DPI 变化会改变
   「文字行占窗口的比例」，所以别开 125%/150%。QQ 窗口拉成 1178x914 最省事，`PROBE` 不用重标。
4. **WebUI 访问**：`config.json` 里 `webui.host` 改成 `0.0.0.0`（已支持），
   宿主机再 `netsh interface portproxy add v4tov4 listenport=8787 listenaddress=127.0.0.1 connectport=8787 connectaddress=<VM IP>`。
   嫌麻烦就 VMConnect 进去用浏览器。
5. **网络**：Hyper-V `Default Switch` 是 NAT，能上网，但 VM IP 每次重启可能变。要稳定就自建 Internal + NAT。
6. **搬什么**：整个 `qq-bot` 目录（含 `config.json`、`data/`、`persona.md`、`plugins/`）+ Node 22。
7. **同一账号不能两个 PC 客户端同时在线**：VM 里登录 bot 号之前，先把宿主机上的 bot 号退出。
   （手机 + PC 可以同时在线，PC + PC 不行。）
8. **资源**：2 vCPU / 4GB 起。动态内存最好关掉（或最小 3GB），否则 UI 卡顿会让发送回执变慢。
9. `watchdog.ps1` / `doctor.ps1` / `启动bot.bat` 全部原样搬进去即可。

### 16.5 一个必须知道的取舍

VM 方案把「打扰」降到了 0，代价是多一层操作系统：多占 2 vCPU + 4GB 内存，
QQ 在 VM 里的渲染性能比裸机差（发送一轮可能从 7s 变 10s）。
如果哪天觉得太重，退路是 S19（模拟器 + adb），但那时要处理「移动端和 PC 端同账号消息同步 →
bot 回复自己」的回环过滤（`fromUin === selfUin` 直接丢）。

---

## 17. 2026-11-17 21:50 可移植化：从「只在这台机器能跑」到「拷过去就能跑」

用户装好了 Hyper-V Win11，要搬过去。搬之前发现两处**硬编码死路**，不修的话搬过去 100% 起不来。

### 17.1 17 个脚本把项目路径写死了

```powershell
$root = "D:\<you>\Documents\project\QQ-bridge\qq-bot"
```

`doctor / recover / start-bot / stop-bot / watchdog / ui-* / mem-* / screenshot / capture-rect ...`
全部这样。VM 里盘符和用户名不同，每个脚本都会去一个不存在的路径找 `data/`。

**修**：统一改成 `$root = Split-Path -Parent $PSScriptRoot`。所有脚本都在 `tools\` 下，
父目录就是项目根，跟具体放在哪无关。另外三个带默认输出路径的
（`screenshot.ps1` / `capture-rect.ps1` / `mem-key-scan.ps1`）把绝对默认值也改成了 `Join-Path $root ...`。
改完跑了一遍 AST 语法校验（18 个 ps1 全部 0 错误）+ 实际执行 `ui-gate` / `stop-bot` / `doctor`，行为不变。

### 17.2 `recover.ps1` 把 QQ 安装路径写死了

```powershell
$QQEXE = "D:\Program Files\Tencent\QQNT\QQ.exe"
```

**修**：新增 `Find-QQExe`，顺序是「任何活着的 QQ 进程的 ExecutablePath」→
`%ProgramFiles%\Tencent\QQNT\QQ.exe` → `%ProgramFiles(x86)%` → `%LOCALAPPDATA%\Programs` →
几个常见盘符。取到空串时 `-StartQQ` 会给出可读错误，而不是 `Test-Path ""` 崩。

### 17.3 打包脚本 `tools/make-portable.ps1`

`data\` 有 525MB，其中 509MB 是两次 QQ 进程内存转储（`memdump-main*.bin`，DB 路线的调试残留）。
直接拷整个目录既慢又没意义。打包脚本按白名单取：

| 收起 | 排除 |
|---|---|
| `src/ webui/ tools/ plugins/ patch/`、`package.json`、`config.json`、`persona.md`、全部 `.md`、`*.bat`、`data/sessions/`、`data/plugins/` | `data/*.bin`（509MB）、`dbcopy/`、`decrypted/`、`wpn*/`、`plain/`、`probes/`、`*.log`、`*.bmp` |

并**主动删掉 4 个「每台机器独有」的状态文件**：

- `data/bot-pid.txt` —— pid 绑定，换机器必然错
- `data/ui-state.json` —— 窗口句柄
- `data/heartbeat.json` —— **不删的话 watchdog 一启动就判定卡死并重启**
- `data/alerts.jsonl` —— 不删的话新机器一进来就挂着一片红字

产物 **197.9 KB / 84 个文件**。项目零 npm 依赖，所以拷过去不需要 `npm install`。

**踩到的坑**：第一版把两个中文名的 `.bat` 写死在数组里，结果包不进去 ——
PS 5.1 按 ANSI 读无 BOM 脚本，中文字面量变乱码，`Test-Path` 直接 false（静默跳过）。
改成 `Get-ChildItem -Filter *.bat` 枚举才行。**这是本项目第 N 次踩 PS 5.1 编码**，
结论固定下来：`.ps1` 里不要出现任何中文字面量，要用中文路径就枚举。

### 17.4 `tools/selftest-send.mjs`（新增）

换屏幕 / 换 DPI / 进 VM 之后，用来判断回执判据还灵不灵：

```powershell
node tools\selftest-send.mjs              # 只粘贴+清空，绝不发送
node tools\selftest-send.mjs --send 张三   # 真发一条
```

判读：`empty≈0 且 delta≥60` = 正常；`empty` 几百 = 区域压在静态工具栏上；`delta=0` = 没贴上。
本机实测（bot QQ 未运行时）正确 fail-closed 到 `ERR_BOT_PID_GONE`，说明脚本加载链路没问题。

### 17.5 部署文档 `VM-SETUP.md`

按「VM 设置 → 装 QQ → 装 Node → 拷包 → 首启 → 标定 → 宿主机看控制台」写的，
把四条会让 VM 方案直接失效的设置单独列出来：

1. **必须用基本会话**，增强会话（=RDP）一关窗口就锁屏，`SendInput` 全废
2. 必须开自动登录，否则重启停在锁屏
3. 缩放必须 100%，DPI 变了回执判据会失准
4. **PC 端和 PC 端同账号不能同时在线** —— VM 登录 bot 号前，宿主机必须先退掉

Node 要求写清楚了：**≥ 22.18**（直接跑 `.ts` + `node:sqlite`），和宿主机一致用 22.22.2 最省事。



---

## 18. 2026-11-17 22:20 VM 首启三连坑：启动器卡死 + 路径错 + 回执判据全失效

用户把这套拷进 Hyper-V Win11，登录 bot 号后双击启动器，窗口停在：

```
=== 1. bot instance binding
    re-scanning salt needles across QQ processes (~30s)...
```

然后**一直不动**（实测两个进程 `recover.ps1` + `mem-allsalt-scan.ps1` 从 22:11:36 挂到 22:20）。

### 18.1 根因一：缺 `data\dbcopy\nt_msg.db`，扫描退化成"全内存瞎扫"

`make-portable.ps1` 的白名单里没有 `data/dbcopy/`（有意剔除），所以 VM 里没有这个文件。
而 `mem-allsalt-scan.ps1` 第 9 行 `[System.IO.File]::ReadAllBytes()` 抛的异常**不终止脚本**
（PS 5.1 的 .NET 方法异常只终止该语句），于是：

```
$dbBytes = $null  ->  [Array]::Copy($null,...) 抛 ArgumentNullException  ->  $p2 全 0
        ->  needles 退化成空串/全 0  ->  MemScan2::Scan 对 8 个 QQ 进程各扫 4GB 地址空间
```

`data/salt-scan.log` 里就是那两条异常（UTF-16 编码），是"看起来卡死、其实在扫内存"的证据。

### 18.2 根因二：`config.json` 的 `storagePath` 还是宿主机路径

`D:/<you>/Documents/QQ-chat/Tencent Files` 在 VM 里不存在。真实位置是
`C:\Users\<you>\Documents\Tencent Files`（下面只有一个 `1000000000` 目录 = bot 号）。
接收走 R3（通知库）不受影响，但"按账号目录核对身份"和 `recv-db.ts` 会用到它。

### 18.3 根因三：回执判据按宿主机窗口标定，VM 的窗口形状不同

`PROBE` 原本是 1178x914 上的**百分比**标定。VM 窗口是 960x640。更要命的是实测发现：

| 元素 | 960x640（rel y） | 说明 |
|---|---|---|
| 工具栏图标行 | 444~461 | 静态 |
| 输入文字行 | 478~489 | **顶部对齐** |
| 占位符 | 522~537 | **垂直居中** |
| 蓝色发送按钮 | 597~623 | 底距 17~43，两种窗口一致 |

占位符居中、文字顶部对齐 —— 任何"固定高度窄条"都可能压在两者之间的空白上。
实测原 PROBE 在新窗口上 `empty=full=0`，于是"贴上了"被判成"没贴上"，重试两轮后抛
`SEND_NO_INPUT`（真机表现为：**bot 收到了消息但永远发不出去**）。

### 18.4 修法

1. **`recover.ps1` 第 1 步改成确定性绑定**（不再依赖内存扫描）：
   - `QQ instance trees` = 父进程不是 QQ.exe 的 QQ 进程数（一棵树 = 一个已登录账号）；
   - `accounts with local data` = `<QQ 数据根>\<uin>` 目录（取最近写入的作为当前账号）；
   - 两棵树以上 / 账号对不上 / 没有 botUin → **拒绝快绑**，退到扫盐兜底；
   - 兜底前先查 `dbcopy` 是否存在，缺就 fail-fast 退出 2 并给出拷贝路径；扫描本身加了
     240s `Wait-Job -Timeout`，不可能再无限挂。
2. **`mem-allsalt-scan.ps1` 三处 fail-fast**：缺 dbcopy / 文件 <2048 字节 / needles 退化成空或全 0，
   一律 `exit 4` 且**不动 `bot-pid.txt`**（宁可不绑，也不绑错）。
3. **`doctor.ps1`**：提示文案改指 `recover.ps1`；`-Deep` 缺 dbcopy 时给 WARN 跳过；扫描非 0 退出时
   不再把"pid 没变"误判成"已确认绑定"。
4. **`send-ui.ts` 回执改成像素差分**（新增 `imgprobe.ts::diffPixels`）：
   - `PROBE` 改成框住**整块输入区**（`left 0.28 / width 0.56 / 底距 190 / 高 140`），
     两种窗口都能覆盖，与文字落在第几行无关；
   - 判定：连拍两张空态得噪声 `noise`（光标闪烁约 40px），粘贴后 `span` 必须
     `> max(90, noise*3)` 才算"文字进了输入框"；
   - 发送后 `after` 与空态的差分 `< max(60, span*0.4)` 才算"清空 = 已发出"。
5. **拍空态基准前先 `ui-clear`**。这是本轮的隐藏 bug：第 1 轮失败残留的文字会被当成第 2 轮的
   "空输入框"，于是发送成功后差分反而很大（实测 `back=971`，差异全部落在文字行 478~489），
   消息明明发出去了却判失败。清空还顺带解决了"上一条失败回复成为下一条前缀"。
6. `webui.ts` 的「重扫窗口绑定」按钮改调 `recover.ps1 -NoStartBot`（原来直接调扫盐脚本）。
7. `config.json` 的 `storagePath` 改成 VM 实际路径。

### 18.5 实测证据（均在 VM 内）

```
recover.ps1 -RestoreWindow
  QQ instance trees: 1
  accounts with local data: 1000000000
  bound pid 13720 (single instance, account 1000000000 verified from disk - no memory scan)
  not usable: ERR_BOT_WINDOW_MISSING (window exists but hidden/tray) -> RESTORED 960x640
  STARTED pid=11124
  VERDICT: HEALTHY

node tools\selftest-send.mjs
  [probe-only] noise=0 span=772（阈值 90）

node tools\selftest-send.mjs --send 好友A
  [selftest] OK in 46591ms
```

真机截图核对：`自检文本 self-test 14:33:47` / `14:36:24` 各一条，**没有重复发送**，输入框干净。

### 18.6 PS 5.1 又一个坑（记下来）

`function Get-QQRoots { ... return @($x) }` 只命中 1 个对象时，函数返回值被**摊平成单个对象**，
而单个 `CimInstance` 在 PS 5.1 里 `.Count` 是 `$null`（不是 1）。于是 `$rootsQQ.Count -ne 1` 恒真，
误报"more than one QQ instance tree"。**函数返回集合，调用处一律 `@(函数名)`**。

### 18.7 残留 / 待观察

- `openChat` 第 1 次 `chatOpen` 常报"看不到聊天面板（无蓝色发送按钮）"，第 2 次才成功 ——
  刚双击打开会话时面板还在渲染。结果正确（按钮实测 blue=0.688），只是日志噪音；
  如果以后频繁出现，把 `chatOpen` 的首次判定加 150ms 延时即可。
- VM 里只登了 bot 号（唯一账号目录），绑定无歧义。**若以后在同一 VM 里再登主号**，
  `recover` 会因"两棵树/两个账号"拒绝快绑，需要 dbcopy 兜底或人工确认 —— 这是有意保守。
- 回执判据换了实现，宿主机（1178x914）尚未回归验证；下次回宿主机跑一次
  `node tools\selftest-send.mjs` 看 `span` 是否仍然远大于 90。

---

## 19. 2026-11-17 22:50 webui 打不开 = bot 没跑，补上「开机自启 + 自动重启」

### 19.1 现象与误判

浏览器打开 `http://127.0.0.1:8787` 显示「无法访问此页面 / ERR_CONNECTION_REFUSED」。
**控制台本身不会单独挂**：它是 bot 进程内的一个 HTTP server（`src/webui.ts`），
所以拒绝连接 = bot 进程不在，等于"什么都没在听 8787"，不是前端/端口/防火墙问题。

### 19.2 排查时踩到的假象

`data\bot-stdout.log` 里没有任何异常栈，最后一行是正常的 `[webui] http://127.0.0.1:8787`，
心跳也写到了最后一刻 —— 说明**不是崩溃，是被 `TerminateProcess` 外部杀掉**。

做对照测试确认：同一次工具调用里启动 bot，连续 30 秒每秒探测，
`alive=True listen=True http=200` 全程正常；**调用一结束进程就消失**。
原因：远程/沙箱会话结束时其子进程树被整体回收。

**推论（重要）**：在远程会话里"帮用户启动 bot"是做不到的 —— 必须由
任务计划、或用户自己的桌面会话拉起。所以这一轮的正解不是"再启动一次"，
而是**把常驻这件事交给系统**。

### 19.3 落地：`tools/install-autostart.ps1`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1           # 安装并立即启动
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Status   # 看状态
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove   # 卸载
```

注册两个「登录时」任务（幂等，`-Force` 覆盖），装完自动轮询 8787 直到 200：

| 任务 | 动作 | 作用 |
|---|---|---|
| `QQBot-Start` | `recover.ps1 -RestoreWindow -StartQQ` | 登录后重绑 + 取消托盘 + 起 bot；QQ 没开就一起拉起 |
| `QQBot-Watchdog` | `watchdog.ps1 -Loop -IntervalSec 60 -RestoreWindow -RescanPid` | 每 60s 复查，进程没了 / 心跳过期就拉起 |

关键设置：

- `LogonType Interactive` + 当前用户 —— **不能注册成服务**。session 0 没有桌面，
  粘贴和点击落不到 QQ 窗口上，发送全废。
- `ExecutionTimeLimit = [TimeSpan]::Zero` —— 默认 3 天到期会被调度器杀掉，
  对 `-Loop` 的看门狗来说等于"三年后静默停止守护"。
- `MultipleInstances IgnoreNew` —— 防止重复点启动器叠出两个 bot 抢 UI。

### 19.4 顺带修掉的看门狗两处

1. `Start-Bot` 原来只调 `start-bot.ps1`（裸起 node）。QQ 重启后 `bot-pid.txt` 是旧的，
   bot 起来也会往"不属于这个账号的窗口"里粘。改成调 `recover.ps1 -RestoreWindow`
   （检查 QQ → 重绑 → 取消托盘 → 起 bot → 体检）。
2. `-RescanPid` 原来调 `mem-allsalt-scan.ps1`，而它现在缺 `dbcopy` 会 `exit 4`
   直接退出（第 18 节），等于这个开关永远无效。改成调 `recover.ps1 -NoStartBot`。

### 19.5 实测

```
install-autostart.ps1  -> registered x2, webui UP after 2s (http 200)
doctor.ps1             -> VERDICT: HEALTHY（bot/QQ 均在 session 1）
杀死 bot 进程（pid 9808）后：50s 自愈 -> pid 11808, http 200, 实例数=1
```

自愈时间取决于看门狗 60s 周期（最坏约 65s 无控制台，期间 QQ 侧消息会排队
在通知库里，接收器恢复后按 `lastId` 续读，不会丢）。

### 19.6 以后怎么判断"是被杀还是崩了"

- 崩了：`data\bot-stdout.log` 末尾有异常栈。
- 被杀：日志停在最后一条正常输出、无栈、心跳文件停在被杀那一刻。
后者一律查"谁在管这个进程"，不要去改代码。

---

## 20. 2026-11-17 23:05 改回本名「爱弥斯」—— 一个名字有 5 个同步点

### 20.1 现象

bot 自我介绍时自称「霎弥斯」，用户确认她叫**爱弥斯**。而 `webui/index.html` 的标题从第一版起
就是"爱弥斯 · QQ Bot 控制台" —— **同一个名字在项目里存在两套写法**，这本身就是错的信号。

### 20.2 根因

第 14.5 节那轮"截图确认 QQ 昵称是霎弥斯"的结论是**看错了**。这两个字形近：

- **爱** = 爫 + 冖 + 友，上部是爪字头
- **霎** = 雨 + 妾，上部是雨字头（四个点）

13px 字号下确实容易混。本轮把昵称区域裁出来放大 5 倍再读，结论明确：**QQ 昵称就是「爱弥斯」**
（头像右侧，实际像素结构是爪字头）。教训：**认字有歧义时，裁图放大再判，不要凭整屏截图下结论。**

### 20.3 改名要改的 5 处（漏一处的后果）

| 位置 | 作用 | 漏改会怎样 |
|---|---|---|
| `config.json` → `botName` | 群聊 @ 判定（`text.includes(cfg.botName)`）+ 面板显示 | 群里永远不回复（判定不到被叫） |
| `persona.md` 第 3 行 | 模型的自我认知 | 模型继续自称旧名字 |
| `data/sessions/*.json` 的 **assistant** 条目 | 会话记忆会作为上下文喂回去 | 模型照着自己过去的说法继续用旧名 |
| `data/plugins/anti-repeat.json` | 10 分钟内相似度 >0.86 就丢弃 | **新回复被当成复读丢掉** → bot 看起来突然哑了 |
| `data/bot.jsonl` 的 `reply` 字段 | 面板「最近回复」 | 界面显示旧名，看着像没改成功 |

只改前两处是最常见的半吊子改法：改完立刻测"你叫什么"，答案可能还是旧的（历史记忆），
或者干脆没有任何回复（防重复缓存）。

### 20.4 已验证

```
botName = 爱弥斯 | persona 首行 = 你是爱弥斯，一个住在 QQ 里的朋友。
会话历史 6 条，含「霎」= 0
直接调 chat(cfg, [system=persona, ...history, user="你叫什么名字？"]) -> "爱弥斯。"
```

改完把 bot 重启一次，`/api/state` 的 `lastReply` 与面板都干净了。
另：`anti-repeat` 的 kv 是每次 `get` 都读磁盘（`src/plugins.ts:39`），所以清缓存不需要重启。

### 20.5 顺带确认的产品约束

- QQ 昵称**不受代码控制**：如果哪天账号昵称被改，群聊 @ 判定就会失效（私聊不受影响）。
  `botName` 必须与 QQ 昵称一致，这是人工约定。
- 运行策略已定为 **A 方案**（见 21 节）：VM 只跑 bot，不在里面做别的输入。

---

## 21. 运行策略定为 A：VM 专用，不与人共用桌面

### 21.1 用户的问题

"虚拟机运行这个项目能不抢我鼠标吗" —— 担心 UI 自动化把光标拽走。结论分两层：

1. **宿主机完全不受影响**。Hyper-V 的 VM 是独立 OS 实例，有独立的输入队列。
   `ui-click.ps1` 的 `SetCursorPos` + `mouse_event` 作用于 VM 的 session 1，
   移动的是虚拟机虚拟光标，宿主机的物理光标/焦点/拖拽一个字节都收不到。
2. **VM 内部会抢**。如果人正在 VMConnect 里操作同一个 VM，那就是同一 session 抢同一个输入队列：
   光标跳到输入框、QQ 被提到前台、正在打的字可能被吞。

唯一会"溢出"到宿主机的通道是**剪贴板**：`ui-paste.ps1` 用剪贴板 + `SendKeys ^v`，
粘完 600ms 后还原原内容；VMConnect 默认双向同步剪贴板，理论上可能与宿主机的复制粘贴撞车（窗口极短）。

### 21.2 选择 A 的含义（无需改代码）

- VM 只跑 bot，人不在里面做别的输入 → 抢光标这件事不可见，不需要动注入方式。
- `reply.sendIdleMs = 45000` 保持默认。注意它的 `fg` 短路（bot 的 QQ 已在前台就直接放行）：
  搬到无人值守 VM 后这条常常命中，所以**它保护不了"有人正在用这个 VM"的场景** —— 这也是选 A
  而不选 B 的原因。真要边用边跑，必须先把 `fg` 短路改成"只有窗口本来就在前台才算"。
- VMConnect 窗口可以关掉，bot 照常运行（前提：客户机没锁屏、没休眠、没进睡眠）。
  但窗口尺寸变了会影响 UI 几何，改完跑一次 `tools\doctor.ps1` 确认 `bot-window` 仍 OK。

### 21.3 被否掉的 B / C（备查）

| 方案 | 内容 | 否掉的原因 |
|---|---|---|
| B | 改闸门：有人在动键鼠就不发 | A 方案下没有人用 VM，改了也没收益 |
| C | 改用 UIA `ValuePattern.SetValue` + 窗口消息点击，彻底不碰光标 | QQ NT 是自绘窗口，`WM_PASTE` 大概率无效；仍可能需要 `SetForegroundWindow`。等真需要"边用边跑"再探 |

---

## 22. 2026-11-18 00:10 "经常掉线" —— 其实是回复慢到 1~3 分钟

### 22.1 先排除"掉线"

用户报"经常掉线"，但同一时刻的证据全是健康的：

- 控制台：`爱弥斯 正在运行 PID 11136 已运行 1 小时 5 分`，心跳 hbAge 7→57s 循环
- `doctor.ps1`：10 项全 `[OK]`，`VERDICT: HEALTHY`
- 心跳：`in=3 out=2 err=0 snapFails=0`，接收器 `lastArrivalAt` 只有 2 分钟前
- `bot.jsonl`：每条入站都有对应记录，`toast-26/27/28` 都是正常收到的

**掉线（进程死/接收断）和"发了不回"是两种病。** 判据：心跳在跳 + `in` 在涨 = 进程活着，问题在出站。

### 22.2 真正的卡点：日志停在"排队等待空闲"

```
[rcv-notify] private from 好友A: 计算二重积分 …     <- 00:06:00 收到
[llm] deepseek/deepseek-flash ok 2138ms                <- 00:06:02 模型回了
[send] 用户正在用电脑（idle=12s），排队等待空闲…          <- 然后不动了
```

`waitForIdleGate()` 在等"键鼠空闲 ≥ `sendIdleMs`（当时 45s）"。而用户正在 VM 里看控制台、
点终端、翻截图 —— **每一次点击都把 idle 重置为 0**，于是这条消息在队列里空等。
闸门原本是给"用户坐在电脑前打字，别抢他鼠标"设计的（见 16 节），A 方案下它是纯负担。

### 22.3 时间账（实测，不是估算）

| 环节 | 耗时 | 说明 |
|---|---|---|
| 单次 UI 动作 | 1.0~1.7s | `ps()` 每调一次就新起一个 `powershell.exe`（`ui-rect` 1.70s / `ui-probe` 0.98s / `ui-focus-ok` 1.13s） |
| 一次 `openChat` | ≈12s | 7 次 ps + 2s 固定 sleep |
| `openChat` 全部重试 | 最坏 ≈48s | 内层 2 次 × 外层 2 轮 |
| 空闲闸门 | 45s | 有人在 VM 里动键鼠时必然触发 |
| 实测 in→out | 45s / 94s / **>160s** | 三条样本 |

### 22.4 三个具体缺陷（已改）

1. **闸门对专用 VM 无意义** → `config.json` 的 `reply.sendIdleMs` 改为 `0`（关闸）。
   代价：bot 回复时会抢焦点；这是 A 方案（21 节）本来就接受的前提。
2. **"会话是不是本来就开着"的探测没先确认前台**。`chatOpen()` 走 `ui-probe.ps1`，
   而它是 `CopyFromScreen` —— **截屏幕像素**。QQ 被浏览器盖住时读到的是浏览器画面 →
   判成"面板没打开" → 白跑一遍 `openChat`（最坏 48s）。这就是"第 1 次搜索打开会话后
   仍然看不到聊天面板"那条日志的真正来源：不是 QQ 没打开，是**我们看不见它**。
   改法：新增 `ensureForegroundCheap()`，先花一次 `ui-focus-ok`（~1.1s），不在前台才走
   完整 `ensureFocus()`（~2.8s）。比无条件抢省 1.7s，比不确认省 48s。
3. **搜索双击后只等 1000ms 就判死**。面板还在渲染时蓝色按钮尚未画出来 → 误判。
   加一次 600ms 复核，只让失败路径付这 600ms。

### 22.5 顺手修掉一处误导文案

`recover.ps1` 结尾原本打印：

```
recover exit=0 (0 healthy / 1 degraded / 2 fatal)
```

这是**退出码图例**（0=健康 1=降级 2=致命），但排版看着像"0 项健康 / 1 项降级 / 2 项致命"，
和上面 10 个 `[OK]` + `VERDICT: HEALTHY` 自相矛盾 —— 用户第一反应就是"这不是有 2 个致命错误吗"。
改为 `(exit code: 0=healthy 1=degraded 2=fatal)`。

### 22.6 改完的结果

```
node tools\selftest-send.mjs  ->  noise=0 span=767（阈值 90），13.3s
/api/state -> sendIdleMs = 0
```

预期 in→out 从 45~160s 降到 **≈15s**（LLM 2~3s + 发送 10~13s）。

### 22.7 仍然存在的结构性延迟（没改，先记账）

- **每次 UI 动作 = 一次 `powershell.exe` 启动（1~1.7s）**，这是延迟的地板。真要再快，
  得把 `ui-rect / ui-click / ui-paste / ui-probe` 合并成一个常驻的 PowerShell 会话（读写 stdin），
  能把单次发送压到 2~3s。工作量不小，等真的嫌慢再做。
- **重启期间的私聊不回放**：启动时 `baseline id=N（不回放历史）`，停机窗口里的消息直接跳过。
  watchdog 重启最多造成 ~60s 盲区。
- **人在 VM 桌面上时，bot 每次回复都会抢焦点**（`ensureFocus`）。想边看控制台边不被打扰，
  就把 webui 暴露到宿主机浏览器（`webui.host = 0.0.0.0` + 防火墙放行，见 VM-SETUP 7.1），
  VM 桌面留给 bot 一个人用。

## 23. 2026-11-18 00:25 断网会发生什么（以及启动器那句 exit 文案）

用户问："电脑不关，但网会断，有没有问题？"顺带贴了启动器结尾：

```
VERDICT: HEALTHY
recover exit=0 (0 healthy / 1 degraded / 2 fatal)      <- 迷惑来源
```

**那不是统计结果，是退出码图例**（0=健康 / 1=降级 / 2=致命）。旧文案看起来像
"0 项健康 / 1 项降级 / 2 项致命"，和上面十个 `[OK]` 直接矛盾。现改为
`(exit code: 0=healthy 1=degraded 2=fatal)`。

同时发现一个真正的 bug：**旧文案根本没被打印出来**。上一轮把注释写成中文，而
`recover.ps1` 是 UTF-8 无 BOM，Windows PowerShell 5.1 按 ANSI 解析，CJK 注释把紧随其后的
整条 `Write-Output` 语句吞掉了（语法树里那条语句直接不存在，行号整体错位 2 行）。
教训：**`tools/*.ps1` 一律 ASCII-only**（`watchdog.ps1` 开头早就写了这句）。
已确认现在全部脚本无一个含非 ASCII 字符。

### 断网影响矩阵（实测）

| 环节 | 断网时 | 依据 |
|---|---|---|
| 接收 | **完全正常** | 读本机 `wpndatabase.db`，不走网 |
| WebUI | **完全正常** | `127.0.0.1:8787`，本地 HTTP |
| 发送 | **完全正常** | UI 自动化，纯本地 |
| 模型 | 失败 | 只有这一环依赖外网 |
| 进程 | **不退出、不被看门狗杀** | 心跳写本地文件，看门狗只看心跳/进程 |

所以断网 = **这些消息不会有回复**，不是"掉线"。恢复网络后也不回补（见下）。

### 修掉的三处（都在断网路径上）

1. **离线冷却 15s**（`src/llm.ts`）：全部候选通道都因网络失败后置 `offlineUntil`，
   期间任何消息 **0ms 直接失败**。实测：DNS 失败 705ms 进冷却，随后连发 3 条总耗时 0ms。
   没有它，串行队列里每条消息都要跑"60s 超时 ×3 次重试"（最坏 180s），连发 5 条就是十几分钟积压。
2. **网络重试预算收紧**：网络类错误退避 300ms（原来 800/1600），且失败后的后续尝试
   超时压到 20s。真正需要 60s 的长上下文生成，第一次尝试已经用满 60s，不会被砍。
3. **处理时再判过期**（`src/engine.ts`）：接收时不算旧、但轮到它时已排队超过
   `reply.staleAfterMs`（5min）的消息直接丢（`skip-stale-queued`）。否则网络恢复瞬间会把
   几分钟前的旧答案一次性补发，比不回更糟。

恢复语义：冷却结束后的第一条消息自动当探针；成功即 `offlineUntil = 0` 并清掉
`llm-network` / `llm-all-failed` 红字。实测 15s 后真实调用 667ms 成功。
401（Key 错）不会触发冷却（有 HTTP 状态码 = 网络是通的），实测 `offline=false`。

### 仍然存在的边界

- **断网期间的私聊永久丢失**：事件已被消费，没有重试队列（有意不加：重试队列 = 回旧答案）。
- QQ 自己会掉线重连；重连后积压的 toast 一次性到达，超过 5 分钟的会被 `staleAfterMs`
  标记不回复（既有保护，R-31）。
- `skip-stale-queued` 会让 `counters.skipped` 增长，排查时看 `data/bot.jsonl` 里的
  `dir=skip-stale-queued` 与 `dir=llm-offline`。
- 机器不关不等于服务不中断：Windows 自动更新重启后，计划任务要等**用户登录**才跑；
  QQ 若没设自动登录，`-StartQQ` 只会拉起登录界面。

## 24. 2026-11-18 00:40 收不到消息的真因：QQ 窗口在前台就不弹通知

用户报："我发出去的消息没有到 webui 界面里面"。控制台显示接收 1 / 已回复 1，
但右侧聊天里 00:23、00:24 各有一条，全都没进来。

### 证据链（说明是"没生成通知"，不是"读不到通知"）

| 观察点 | 结果 |
|---|---|
| `data/notify-archive.jsonl` 最后一条 | 00:21:45 |
| 通知库 `MAX(Id)`（含 WAL 副本） | 31 @ **00:19:58** |
| 源库 `wpndatabase.db-wal` 最后写入时间 | 00:21 |
| 00:22:51 之后有没有任何 App 的通知 | 没有 |

结论：00:21 之后系统层面**根本没有新通知产生**。接收适配器（R3）读的是通知库，
没有通知就等于没有消息。

### 机制

QQ 在"当前会话窗口处于前台/活动"时不产生 Windows 通知（它认为你已经看到了）。
而发送路径必须 `SetForegroundWindow` + 点输入框 + 点发送 —— **每次回复都把 QQ
推到前台**，于是回复完就"聋"了，直到窗口失焦。时间线完全吻合：00:22:51 回复完，
用户 00:23 起发的三条全部没进来。

### 还有一个帮凶：双 watchdog 实例

`Get-CimInstance` 抓到一个 **22:47:36 启动的旧 watchdog 进程**，参数是 `-RestoreWindow`，
每 60 秒把窗口拉回前台并 `SetForegroundWindow`。任务计划里 `MultipleInstances=IgnoreNew`，
所以重新注册任务并不会替换正在跑的那个旧进程。它一直在和"收回托盘"对着干，
这也是"窗口怎么自己又冒出来了"的原因。

> 排查口诀：**"进程/窗口自己活了"先数实例**，别急着改代码。

### 改动

| 文件 | 改动 |
|---|---|
| `config.json` | 新增 `reply.parkWindowAfterSend: true` |
| `src/send-ui.ts` | 发送结束（成功或失败）把窗口收回托盘；新增 `parkIfConfigured()`；`runtime.sendHealth.sending/lastSendAt` 标记"正在发送" |
| `src/index.ts` | 启动 6 秒后自动收一次窗口（`recover -RestoreWindow` 会把它摆到前台） |
| `tools/ui-restore.ps1` | `-Hide` 支持不带 `-Hwnd`（按 ui-state.json / 最大可见窗口选目标）；隐藏后把恢复冷却清零，下一条消息能立刻恢复 |
| `tools/watchdog.ps1` | 新增 `-ParkWindow`：窗口被打开且**发送空闲 >90s** 就重新收起（`sendHealth.sending` 保护，绝不在粘贴/点击中途收窗口） |
| `tools/install-autostart.ps1` | 两个任务去掉 `-RestoreWindow`，watchdog 加 `-ParkWindow` |
| `tools/doctor.ps1` | "窗口在托盘里"判为 **OK**（parked 是正常态），不再报错 |
| `tools/recover.ps1` | 第 2 步文案改为"parked 正常，发送时自动恢复" |

### 实测

```
隐藏状态下 node tools\selftest-send.mjs
  [send] 窗口不可用(ERR_BOT_WINDOW_MISSING)，已尝试恢复：RESTORED hwnd=263620 960x640
  [probe-only] noise=0 span=798
  [send] 窗口已收回托盘（HIDDEN hwnd=263620 was 960x640）
手动把窗口拉出来 -> 50s 后被看门狗自动收回
doctor.ps1 -> bot-window: parked in tray (auto-restored on next send) / VERDICT: HEALTHY
```

### 使用含义（重要）

- **读回复看 webui，不要在 VM 里点开 QQ 窗口**：点开并聚焦 = 接收暂停，直到窗口失焦
  或看门狗把他收回去（≤ 一个周期 + 90s）。
- 这是 R3（通知库接收）的固有边界，不是 bug：QQ 只在"你没看着"的时候才通知。
  要彻底摆脱这个约束，只有两条路：拿到 `nt_msg.db` 的密钥走 DB 直读（旧路线，密钥未拿到），
  或者做窗口 OCR 轮询（脆弱）。目前选"把窗口收起来"。

---

## 2026-11-18 01:30 更正：隐藏(SW_HIDE) 不等于收起，必须"最小化"

上一轮把"发送后把窗口收回托盘"当成修复，其实是**错的**：QQ 9.9.37 在窗口被
`SW_HIDE` 隐藏时**根本不发系统通知**，而 R3 接收完全依赖通知。实测三态：

| 窗口状态 | QQ 是否发系统通知 | 结果 |
|---|---|---|
| 前台/桌面可见 | 否 | 接收哑 |
| `SW_HIDE` 隐藏到托盘 | **否**（这轮才发现的坑） | 接收哑，白等一整晚 |
| `SW_MINIMIZE` 最小化 | **是** | toast 正常进库 |

证据：最小化后连续收到 toast-36/37/39，`heartbeat.counters.in` 递增，机器人正常回复。

### 本轮改动

| 文件 | 改动 |
|---|---|
| `src/send-ui.ts` | `parkWindow()` 改用 `ui-restore.ps1 -Minimize`（原来是 `-Hide`） |
| `tools/ui-restore.ps1` | 新增 `-Minimize`（先 SW_RESTORE 再 SW_MINIMIZE；隐藏态也能一步到位） |
| `tools/ui-windows.ps1` | 窗口状态新增 `minimized`（用 `IsIconic` 判定），原来只有 visible/hidden |
| `tools/watchdog.ps1` | 1)`-ParkWindow` 改为最小化；2)**新增 QQ 进程监护**：没有 QQ.exe 就自己拉起；3)`Log` 同时写 `data\watchdog.log`（任务窗口隐藏，stdout 全丢） |
| `tools/install-autostart.ps1` | watchdog 任务加"每 5 分钟重复触发"（`IgnoreNew` 不叠进程）：循环进程自己死了也能被拉回来（实测死过两次，任务状态还显示 Ready） |
| `src/recv-notify.ts` | **接收游标持久化** `data\receive-cursor.json`：重启后从上次位置续收，不再"启动即跳过停机期间的全部消息"（01:12:54 那条 toast 就是这么丢的） |
| `src/recv-notify.ts` | 新增 `data\notify-raw.jsonl`：所有应用的新通知都记一行，用来区分"QQ 没发通知"与"发了但没解析" |
| `config.json` | `reply.staleAfterMs` 300000 -> 600000（停机补收时，10 分钟内的消息仍然回复） |
| `tools/recover.ps1` | QQ 启动从 `Start-Process` 改成 `WScript.Shell.Run`（前者起的 QQ 会跟着调用方一起死） |
| `tools/ui-close-aio.ps1` | **已删除**。对 NTQQ 窗口发 `WM_CLOSE` 会留下"有句柄但页面空白"的僵尸窗口（UIA 只剩 `RootWebArea`），发送直接 `SEND_NO_CHAT`，只能重启 QQ 才能恢复 |

### 踩过的坑（务必别再踩）

1. `WM_CLOSE` 到 QQ 任何窗口 = 渲染进程报废，只能杀掉全部 QQ 重启（自动登录能救回来）。
2. 从工具会话里起的 QQ/机器人都会在几十秒~几分钟内被杀；**唯一可靠的是计划任务**。
3. `start-bot.ps1` 打印的 pid 只是"启动成功"，不代表能活；判断存活看 `data\watchdog.log`。
4. 诊断顺序：先看 `data\notify-raw.jsonl` 有没有 QQ 行 —— 没有就是 QQ 没发（窗口状态问题），
   有行但没进 `notify-archive.jsonl` 才是解析问题。






---

## 2026-11-18 01:50 修复：发送报 FOCUS_LOST（前台被抢）+ 托盘态窗口恢复选错窗口

### 现象

webui 里一条 `send-error`：

```
FOCUS_LOST 发送前前台已不是 bot 窗口，已中止（不会盲点）：
ui-focus-ok.ps1 exit 2: ERR_FOCUS_LOST fgPid=2344 botPid=15464
```

`fgPid=2344` = **WorkBuddy 客户端**（就是我操作这台 VM 的窗口）。结果是那条回复被直接丢弃。

### 三个叠加的问题

1. **`ui-rect.ps1` 把最小化窗口当成不存在**。`IsWindowVisible` 对最小化窗口仍返回 true，
   但 `GetWindowRect` 返回 160x28（假的），被 `>=480x360` 门槛 `continue` 掉 ——
   既不选为候选，也不进"待恢复"列表，于是直接 `ERR_BOT_WINDOW_MISSING`。
   发送链只有 `rect()` 会恢复一次，其余每一步 `ensureFocus` 都直接失败。
2. **强制前台不够狠**。原来只有 `AttachThreadInput + SetForegroundWindow` 一次 + ALT tap 一次；
   别的程序占着前台时仍拿不到。
3. **拿不到前台就丢消息**。`ensureFocus` 抛错 → `doSend` 抛错 → 整条回复没了。

### 本轮改动

| 文件 | 改动 |
|---|---|
| `tools/ui-rect.ps1` | ①候选收集不再按尺寸过滤（最小化 160x28 也进候选，只挡 100px 以下托盘小球）；②自愈：逐个 `SW_RESTORE` 候选 → 按**恢复后的真实面积**选最大的（排除 `Chrome_WidgetWin_0` 宿主框）→ 其余重新 `SW_MINIMIZE`；③前台三连：AttachThreadInput → ALT tap → **临时 `SPI_SETFOREGROUNDLOCKTIMEOUT=0` + `SwitchToThisWindow`**（用完恢复原值） |
| `src/send-ui.ts` | `send()` 捕获 `FOCUS_LOST / ERR_FOCUS_FAILED / ERR_NO_FOREGROUND` 时**整轮重试一次**。安全性：所有 `ensureFocus` 都排在"点发送"之前，文字没发出去，重试不会重复发送 |
| `tools/doctor.ps1` | parked 判定不再按尺寸过滤（最小化 160x28 会误判 `no usable window` → `VERDICT: FATAL`）；只认 `Chrome_WidgetWin_1` |
| `tools/watchdog.ps1` | 历史告警不再每分钟重复打印（新增 `data\alerts-seen.txt` 记录已报过的最大时间戳） |
| `tools/ui-hide-hwnd.ps1` | **新增**：按句柄隐藏/最小化任意窗口。QQ 的 `Chrome_WidgetWin_0` 宿主框（1440x753、无标题）被误恢复后会盖屏并占前台，现有脚本只认 `_1` 碰不到它 |

### 实测

| 场景 | 结果 |
|---|---|
| 全部窗口最小化 + `ui-state.json` 记着错误句柄 656836 | `ui-rect` 自愈选回 2425470 `960x1032`，`ui-focus-ok` OK |
| `ui-restore -Hide`（SW_HIDE 到托盘） | 同样自愈成功 |
| `selftest-send.mjs`（只粘贴不发送） | `noise=0 span=782`（阈值 90） |
| `selftest-send.mjs --send 好友A` | 31.98s 成功，发完自动最小化 |
| `tools\doctor.ps1` | `VERDICT: HEALTHY` |

### 还没解决的

- 01:37:52 那条回复（"按我的爱好写 seedream 提示词"）内容已丢，需要用户重发。
- 前台锁超时被临时改成 0 是**兜底路径**，正常路径不会走到；如果以后每条消息都走到那里，
  说明 VM 里有个程序长期霸占前台（WorkBuddy / 浏览器 / 播放器），应该找出来最小化掉。

---

## 2026-11-18 13:20 修复：SEND_UNCONFIRMED（发送中窗口缩回托盘，截图全是桌面）

### 现象

webui 后台两条 `send-unconfirmed`：

```
13:07:29 send-error Error: SEND_UNCONFIRMED target=好友A span=75027 back=75027 noise=0
09:33:18 send-error Error: SEND_UNCONFIRMED target=好友A span=74740 back=74740 noise=20
```

用户在 13:06 问"推荐几个插件"、09:32 发的图片，**两次回复都丢了**。

### 根因

`data/ui/probe-full1.bmp`（13:07 那次的截图）打开一看：**黑底 + "激活 Windows" 水印**，
根本没有 QQ 输入框。也就是说 `rect()` 报出了合法几何 `960 0 960 1032`，
但那一刻窗口已经不在屏幕上（QQ 恢复后几百毫秒又缩回托盘），
所以：

- `empty` / `full` / `after` 三张图其实都是桌面
- `back == span` → 判定"文字还在输入框" → `SEND_UNCONFIRMED`
- 抛错 → 回复丢弃

09:33 那次 `noise=20`（有光标闪烁，说明截图正常）是另一种：点发送落在了空处。

### 本轮改动

| 文件 | 改动 |
|---|---|
| `tools/ui-rect.ps1` | ①`Grab()` 先 `SW_SHOW(5)` 再 `SW_RESTORE(9)`（SW_RESTORE 对 SW_HIDE 的托盘窗口不一定生效）；②前台成功后加**三重可见性校验**（`IsWindowVisible && !IsIconic`，间隔 220ms，失败就重新 Grab），仍不动就报 `ERR_WINDOW_VANISHED` |
| `src/send-ui.ts` | 重试集合从 3 类扩到 7 类：`FOCUS_LOST / ERR_FOCUS_FAILED / ERR_NO_FOREGROUND / ERR_WINDOW_VANISHED / SEND_UNCONFIRMED / SEND_NO_INPUT / SEND_NO_CHAT`，整轮重试一次并记 `send-retry` 告警。安全前提：这些错误都只在"消息确实没送出去"时抛出（输入框还有文字 / 文字没进框 / 面板没开） |
| `src/send-ui.ts` | `RESTORABLE` 加 `ERR_WINDOW_VANISHED`（带上恢复重试） |

### 实测

| 场景 | 结果 |
|---|---|
| `selftest-send.mjs`（只粘贴） | `noise=0 span=799`，截图里能看到"自检文本 self-test 05:17:40" |
| `selftest-send.mjs --send 好友A` | 42.8s 成功（中间"搜索打开会话后看不到聊天面板"一轮，第 2 轮打开成功） |
| 最小化 → `ui-rect` | 恢复 `960x1032`，2 秒后仍 visible（不再缩回） |
| `tools\doctor.ps1` | `VERDICT: HEALTHY` |

### 结论与注意

- 这台 VM 的 QQ 有"最小化即进托盘"的行为，发送前后会形成
  `SW_MINIMIZE -> SW_HIDE -> SW_RESTORE` 的拉锯，偶尔在发送中途又缩回去。
  现在靠 `ui-rect` 的可见性校验 + `send()` 整轮重试兜住。
- 如果再出现 `ERR_WINDOW_VANISHED` 频繁刷屏，最彻底的解法是进 QQ 设置
  关掉"关闭主面板时最小化到系统托盘"，让最小化就只是最小化。

---

## 2026-11-18 13:40 新增：接收图片（看图说话）

### 问题

用户发图片，bot 只看到字面量 `[图片]`，完全不知道画面内容。

根因：接收走 Windows 通知库（R3），通知 payload 里**只有那四个字** —— 没有 md5、
没有 url、没有附件。图片本体不在通知里。

### 找到的突破口

NTQQ 收到图片会在本地落一份**明文**缩略图：

```
~/Documents/Tencent Files/<uin>/nt_qq/nt_data/Pic/<YYYY-MM>/Thumb/<md5>_720.png
```

实测：用户 09:32 发的"赛博朋克猫打麻将"，`ed66f874..._720.png`（1.2 MB）可以直接打开，
画面就是原图。同一张图还有 `_0.png`（59 KB）。

文件名里没有消息 id，所以只能**按落盘时间配对通知到达时间**（±20s 窗口，
每张图只认领一次，避免同图被两条消息重复用）。

### 模型侧

`deepseek-flash`（V4.1 Flash）**原生支持多模态**，OpenAI 兼容格式，base64 内联即可：

```json
{"role":"user","content":[
  {"type":"text","text":"描述这张图。"},
  {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}
]}
```

注意两点（实测踩到）：

1. config 里的模型名是 `deepseek/deepseek-flash`（带 provider 前缀），发给 API 必须剥成 `deepseek-flash`。
2. 它是推理模型：图片约 620 prompt tokens，它先在 `reasoning_content` 里思考（实测 566 tokens）。
   `max_tokens` 给小了（如 300）`content` 就是**空字符串**，只剩 `finish_reason: length`。用 1200 才稳定。

### 设计：两步走，不把图塞进主对话

```
[图片] 通知 → 按时间找缩略图 → describeImage() 单独调一次模型 → 一段中文描述
        → 拼成 "[图片]（画面内容：……）" 写进会话记忆 → 正常走主对话
```

为什么不直接把图塞进主对话：

- 主对话要维持人设、长度、拟人节奏，混进多模态 content 一旦出错整条回复就没了；
- 描述存进记忆后，后面几轮模型仍然"记得看过这张图"；
- 看图失败只损失描述，不会连回复一起挂掉。

### 本轮改动

| 文件 | 改动 |
|---|---|
| `src/recv-image.ts` | **新增**。`looksLikeImage` / `recentThumbs`（按 md5 去重，优先非 `_0`）/ `claimIncomingImage`（认领一次）/ `waitForImage`（等落盘，最多 2.8s）/ `describeImage`（maxTokens 1200） |
| `src/engine.ts` | 图片消息先转描述再入 `userLine`，历史和 messages 都用描述文本；失败记 `recv-image-miss` 告警 |
| `tools/test-vision.mjs` | **新增**。手动验证"某张图能不能被读"：`node tools/test-vision.mjs <图> [maxTokens]` |

### 实测

- `describeImage` 单次 **1.8s**，输出：
  > 三只猫围坐打麻将。橘猫戴护目镜，狸花猫叼着烟，中间猫专注摸牌。桌上有发光麻将牌，
  > 可见"二萬""八萬""六萬"等字样……背景是霓虹灯、雨夜窗景和旧海报，赛博朋克氛围浓厚。
- 配对：09:32 那条 `[图片]` 能命中 `ed66f874..._720.png`，第二次认领返回 null（不重复用图）。

### 边界

- **闪照 / 表情包**：表情走 `Emoji` 目录不在此逻辑内；闪照可能没落盘 → 走 `recv-image-miss` 降级为纯文本。
- **连发多图**：按 mtime 配对，可能顺序错乱，但每张都会被描述。
- **关闭开关**：`config.json` 里设 `"imageVision": false` 即回到纯文本。

---

## 2026-11-18 13:56 修正：图片消息根本收不到通知，改用"缩略图监视"通道

### 上一轮方案的致命前提被证伪

上一轮把"图片识别"接在 `[图片]` 通知上，前提是**QQ 会为图片消息发系统通知**。
实测 13:34:19 用户发了一张图（`86cbcef3...`，内容是聊天截图），通知库里
**完全没有这条**：前后两条文字的 toast（60 @13:23、62 @13:32）都在，
`notify-raw.jsonl` 里也没有任何 QQ 记录。所以 bot 只看到后面那句
"话说你能看见这个图吗"，老老实实回了"看不见"——它没说谎，是它真的没收到。

结论：**不能把图片接收挂在通知上**。通知对图片是不可靠的（QQ 会合并/抑制）。

### 改法：多一条独立通道，直接盯文件

QQ 收到图片一定会把缩略图落到
`<Documents>/Tencent Files/<uin>/nt_qq/nt_data/Pic/<YYYY-MM>/Thumb/<md5>_720.png`，
这条通道与通知无关，图一到就在。

| 文件 | 作用 |
|---|---|
| `src/recv-image-watch.ts` | **新增**。每 2s 扫一次 Thumb 目录：新文件（mtime 30s 内、≥12KB、非表情）合成一条 `text="[图片]"` 的入站事件，带 `imagePath` 直接交给引擎。启动时允许补看最近 2 分钟的图（重启不丢刚发的图） |
| `src/inbound-context.ts` | **新增**。缩略图文件名只有 md5、没有 peer，靠"最近一条入站消息"推断回给谁。`seedFromLog()` 在进程启动时用 `data/bot.jsonl` 最后一条 `dir:"in"` 预热——否则重启后内存里没有会话身份，图只能丢 |
| `src/recv-image.ts` | 认领记录改为**持久化**的 `data/image-seen.json`，键用 **md5**（同一张图的 `_0`/`_720` 两个文件算一张）。原来只有内存 Set，重启即失忆，两条通道会各回一遍 |
| `src/engine.ts` | ①支持 `evt.imagePath`（监视通道已确定路径，不再配对）；②同一会话 2 分钟内已成功看过图时，后来的 `[图片]` 通知判 `image-dup` 跳过；③描述前缀改成"系统识别到的画面，不是对方打的字"——否则模型会回"你直接把画面转成文字了嘛" |
| `src/index.ts` | 启动预热 + 启动监视器 |
| `tools/test-img-e2e.mjs` | **新增**。构造带 `imagePath` 的事件直喂引擎，验证"描述→记忆→模型→发送"整条链（会真的发一条 QQ 消息） |

### 实测

| 项目 | 结果 |
|---|---|
| `describeImage`（猫打麻将图） | 6.1s，读出"二万/九万"等牌面文字 |
| 监视器单元测试（复制文件 + 改 mtime） | `[img-watch] 新图片 ... -> 好友A`，事件字段完整 |
| 引擎端到端（`tools/test-img-e2e.mjs`） | 13:40:19 `recv-image` 记录 → 13:41:39 真实发出回复 |
| **正式进程内**注入（13:54:34 落盘） | 13:54:40 `[img-watch]` 捕获 → 13:54:44 识别 → 13:55:41 回复 |

### 边界（务必知道）

- **归属靠推测**：缩略图没有 peer 信息，只能归到最后一条入站消息的会话。
  多人同时发图会串（个人 bot 场景够用）。找不到任何入站消息时等 45s 后丢弃。
- **表情包 / 闪照**不走这条（表情在 `Emoji` 目录）。
- **"图里套图"只有文字**：截图里的那张小图，模型看到的是描述文字，不是像素。
  对方如果发"截图里套着一张图"，小图内容它读不到。
- 关掉：`config.json` 里 `"imageWatch": false`（停监视）或 `"imageVision": false`（整体停）。
- 可调：`imageWatchWindowMs`（默认 600000，归属窗口）。

---

## 2026-11-18 14:14 新增：自动联网（模型自己决定要不要搜）

### 目标

用户问"新东西"时不再一问三不知（13:32 它连"TGA 2026 有入围名单了"都不知道，
还回"颁奖礼还没开，谈不上看法"）。

### 为什么用"工具调用"而不是关键词触发

中文里"最近/新出的/现在"满地都是，词表既漏判又误判；而模型自己判断
"这条要不要查"更准，且不需要维护规则。所以给模型两个 function calling 工具：

- `web_search(query)` —— 搜网
- `open_url(url)` —— 读某个网页正文（摘要不够时）

### 搜索后端

| 优先级 | 引擎 | 条件 |
|---|---|---|
| 1 | Tavily / Serper | `config.search.provider` + `apiKey`（可选） |
| 2 | **cn.bing.com HTML 结果页** | 默认，零 key 零费用 |

实测：`cn.bing.com` 直连 200（238ms，9 条结果）；DuckDuckGo 在这台 VM 上**连不上**，
所以没做 DDG 兜底。

Bing 的链接是 `bing.com/ck/a?...&u=a1<base64url>` 跳转，`parseBing()` 里解出真实 URL，
否则模型拿到一堆跳转地址没法用。

### 三道刹车（不设的话一条消息能查两分钟）

- `search.maxRounds`（默认 2）：最多几轮 tool_calls 往返
- `search.maxCalls`（默认 3）：整条消息最多几次工具调用
- 预算用完就**撤掉 tools**，逼模型拿现有信息作答

### 踩到的两个 API 坑（都会直接 400）

1. `assistant.tool_calls` 里的每个 id **必须**有一条对应的 `tool` 消息。
   第一版在"预算用完"时 `break` 掉了循环，留下未应答的 tool_call，
   服务端报 `insufficient tool messages following tool_calls message`。
   现在先算"这轮答哪几个"，再一次性追加 assistant + tool。
2. DeepSeek 思考模式要求把 `reasoning_content` **原样回传**，
   否则报 `The reasoning_content in the thinking mode must be passed back`。
   追加 assistant 消息时带上 `reasoning_content`。

### 本轮改动

| 文件 | 改动 |
|---|---|
| `src/websearch.ts` | **新增**。Bing/Tavily/Serper 搜索、`parseBing` 解析 + 跳转链接解码、`fetchPageText` 抓正文、5 分钟结果缓存、两个工具定义、`runWebTool` 执行器（永远返回 JSON，不抛错） |
| `src/llm.ts` | `post()` 拆成 `postMessage()`（返回整个 message，能看到 tool_calls）；新增 `converse()` 工具循环；`buildBody` 支持 `tools/tool_choice`；`chat()` 返回值加 `toolCalls`；只对 openai/azure 通道放开 tools |
| `src/engine.ts` | 系统提示后追加 `SEARCH_NOTE`（什么时候该搜、搜到别贴 URL、搜不到直说）；`chat()` 带 tools + executeTool；查过就记一条 `{"dir":"web","calls":n}` |
| `src/config.ts` | `DEFAULT_CONFIG.search` + normalize（`enabled/provider/apiKey/maxResults/maxRounds/maxCalls`） |
| `tools/test-web.mjs` | **新增**。不碰 QQ，只看"搜没搜、搜到什么、怎么答" |
| `tools/test-ask.mjs` | **新增**。把一句话当私聊喂引擎，走完整链路并真发一条（验证用） |

### 实测

| 项目 | 结果 |
|---|---|
| `test-web.mjs "TGA 2026 什么时候办"` | 3 次搜索、4.5s，答"12 月 10 日、入围名单今天凌晨公布、《GTA 6》8 项领跑" |
| 闲聊"今天上班有点累" | **0 次搜索**、1.3s（不会为了显得勤快乱查） |
| 端到端（`test-ask.mjs`） | 14:11:39 `{"dir":"web","calls":3}` → 14:13:17 真实发出，且主动纠正了此前"还没发生"的说法 |

### 配置

```json
"search": { "enabled": true, "provider": "auto", "apiKey": "",
            "maxResults": 5, "maxRounds": 2, "maxCalls": 3 }
```

关掉：`enabled: false`。换付费引擎：`provider: "tavily", apiKey: "tvly-..."`。

### 注意

- 联网后单条回复明显变长（模型会列名单/时间），`reply.splitSegments` 会分段发，
  发送耗时本来就长（UI 自动化），一条带搜索的回复 60~110s 属正常。
- 搜索只发 GET、只读文本、不带本机信息；不登录、不提交表单。

---

## 2026-11-18 14:20 回复里的 `**` / `#` / `---`：发送前统一拍平

用户原话：「回复消息的时候能不能把 `*` 去掉，很影响读消息的观感」。

### 为什么会有星号

QQ 气泡是**纯文本**，不渲染 markdown。模型（尤其开了联网、习惯写笔记体的）
会输出 `**加粗**`、`# 标题`、`---` 分隔线、`` `code` ``，这些在气泡里原样显示
就是一堆星号和井号 —— 读起来像没渲染的源码。真实历史回复里已经有：

```
**提示词：**           → 提示词：
---                   → 一条莫名其妙的横杠
- **联网搜索**：…     → 需要 · 联网搜索：…
```

### 做法：发送前统一过一遍 `toPlain()`

新增 `src/plain.ts`，一个纯函数，不改内容只去记号：

| 输入 | 输出 | 说明 |
|---|---|---|
| `**加粗**` / `*斜体*` | 加粗 / 斜体 | 星号去掉，字留下 |
| `# 标题`（1~6 级） | 标题 | 井号去掉 |
| `---` / `***` / `___` | （空行） | 水平线在 QQ 里只是条横杠 |
| `* 一` / `+ 二` / `- 三` | `· 一` … | 列表符号统一成 `·` |
| ` ```ts … ``` ` | 内容 | 围栏去掉，代码保留 |
| `` `x` `` | x | 行内反引号 |
| `> 引用`（含 `>>`） | 引用 | 多层一次去干净 |
| `~~删除~~` | 删除 | |
| `[文字](url)` | `文字（url）` | 文字就是 url 时只留 url |
| `3*4`、`3 * 4 * 5` | 原样 | **乘号不误伤** |
| `__init__`、`my_file_name` | 原样 | 故意不处理 `__` 加粗，怕吃蛇形命名 |
| `<｜｜DSML｜｜ calls>…` | （整条清空） | 见下 |

**幂等**：`toPlain(toPlain(x)) === toPlain(x)`。engine 里两处都会过一遍
（先清 reply，再在 `deliver()` 里清每个分段），重复调用不能吃字。

### 顺带修掉一个更严重的事故

历史回复里有一条**整条都是工具调用协议**：

```
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="open_url">…</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

模型把协议当正文吐出来，这段话**真的发到对方手机上了**。现在这类块整块删掉，
删完为空就不发（`runtime.skip("empty-after-clean")`，日志里留 `raw` 前 200 字）。
注意闭合标签是 `</｜｜DSML｜｜`，正则要允许 `<` 后多一个 `/` —— 第一版就漏了这个，
残留了半截 `</｜｜DSML｜｜ invoke>`。

### 接入点（唯一出口）

`src/engine.ts` 的 `deliver()` 改成返回**实际发出去的文本数组**：

```ts
const parts = plainParts(segments, reply);   // 清洗 + 过滤空段
// …逐条 send…
return parts;
```

调用方用 `parts.join("\n\n")` 写日志 / 记忆 / WebUI。这样界面里看到的、
对方收到的、模型下一轮记得的，是**同一份字符串** —— 不会出现"WebUI 显示有星号，
实际发出去没星号"这种对不上的情况。插件直答（`gate.direct`）也走 `deliver()`，
一并覆盖。

### 同时从源头减量

- `persona.md` 加一条：QQ 是纯文本，不要写 `**加粗**`、`# 标题`、代码围栏、`---`，
  分点用「·」或「1. 2. 3.」，分段空一行。
- `SEARCH_NOTE` 里原来写着 `**会变的**`（模型会照着模仿），已去掉星号。

### 自检

```bash
node tools/test-plain.mjs      # 11 项：该删的删了、不该动的没动、幂等
```

覆盖：标题/加粗/斜体/列表/水平线/代码块/引用/链接/乘号/蛇形命名/DSML 泄漏。

### 边界

- 清洗只管**发出去**的文本；输入侧（对方发来的 markdown）不动。
- `---` 变空行后可能出现"连续空行"，收尾统一压成最多一个空行。
- 星号删完可能留双空格，已压成单空格。
