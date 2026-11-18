# QQ-bot 故障恢复手册

> 适用：电脑重启 / QQ 被关到后台或退出 / 断网之后如何把机器人拉回可用状态。
> 全部命令在项目根目录（`启动bot.bat` 所在目录）下执行，脚本路径已自适应，换机器/换盘符不用改。
>
> **要搬到另一台电脑或虚拟机**：看 [`VM-SETUP.md`](VM-SETUP.md)，本手册只管「已经在跑，出问题了怎么救」。

---

## 0. 三种故障到底坏了什么

| 场景 | 具体后果 | 能不能自动恢复 |
|---|---|---|
| **电脑重启** | QQ 的 pid 全变 → `data/bot-pid.txt` 失效；bot 的 node 进程没了；窗口状态回到默认 | pid 可自动重绑，进程可自动拉起；**QQ 登录需要你手动确认一次**（除非开了自动登录） |
| **QQ 被关到后台/退出** | 收不到 toast（通知只在 QQ 运行时产生）；发送会 `ERR_BOT_WINDOW_MISSING` | 窗口/进程可脚本恢复；**QQ 退出且需要扫码/密码，只能你来** |
| **断网** | LLM 调用失败（现在会退避重试 3 次）；接收侧不受影响（通知库是本地文件） | 完全自动，网络回来即恢复；已经失败的消息只记日志，不会补发 |

关键点：**这三件事的公共依赖是「bot 那个 QQ 账号正在运行、已登录、主窗口可见」**。脚本能做的是把能自动的部分做完，并把不能自动的部分明确告诉你。

---

## 1. 一条命令恢复（推荐）

**最省事的方式：双击项目根目录下的 `启动bot.bat`。**
它会跑下面这条同样的命令，然后把控制台 `http://127.0.0.1:8787` 打开。
想停掉就双击 `停止bot.bat`（只停 bot 进程，QQ 不退出，下次启动不用重新扫码）。

命令行等价写法：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\recover.ps1
```

它按安全顺序做四件事，**绝不杀 QQ、绝不碰登录存储**：

1. 检查 QQ 是否在跑（不在就提示你登录，绝不代你登录）；
2. 校验 `bot-pid.txt` —— pid 失效就重新绑定。绑定走"进程树 + 本地账号目录"的确定性判定
   （秒级，不读内存）；只有同机开了两个 QQ 实例时才退化到 `mem-allsalt-scan.ps1` 兜底；
3. 验证 bot 窗口可用（`ui-rect` 必须输出 4 个数字）；
4. 拉起 bot 进程（已在跑就不重复启动，多于一个会警告重复回复）；
5. 最后跑一遍 `doctor.ps1`，用退出码告诉你结果：`0` 健康 / `1` 降级 / `2` 致命。

可选开关：

```powershell
# 窗口被收进托盘时，尝试自动恢复（会把 bot 窗口弹到前台）
powershell -File tools\recover.ps1 -RestoreWindow

# QQ 完全没启动时，帮你启动 QQ（登录仍需你操作）
powershell -File tools\recover.ps1 -StartQQ

# 只体检不启动 bot
powershell -File tools\recover.ps1 -NoStartBot
```

---

## 2. 先体检：`tools\doctor.ps1`

```powershell
powershell -File tools\doctor.ps1
```

只读，不改任何东西。输出每项 `OK / WARN / FAIL`：

| 检查项 | FAIL 说明 | 手动怎么修 |
|---|---|---|
| `qq-process` | 没有 QQ.exe | 启动 QQ 并登录 bot 账号 1000000000 |
| `bot-pid` | pid 失效/不是 QQ | `tools\recover.ps1` 重绑（或双击启动器） |
| `bot-window` | 窗口在托盘里 | 托盘单击 bot 图标；或 `tools\ui-restore.ps1 -Yes` |
| `receive` | 很久没有新事件 | 查 QQ 通知开关 + 系统勿扰/专注助手 |
| `notif-db` | 通知库不存在 | 系统通知服务异常，重启 Windows 通知服务 |
| `bot-process` | bot 没在跑 / 跑了多个 | `npm run bot`；多个则杀掉多余的 node |
| `llm-config` | 没有任何厂商填了 API Key，或默认模型为空 | 打开 `http://127.0.0.1:8787` 的「模型供应」，填 Key 并选默认模型 |
| `receive-mode` | 不是 notify | 把 `config.json` 的 `receive` 改回 `notify` |

`-Deep` 会额外重跑一次内存扫描，确认 `bot-pid.txt` 里那个 pid **确实是持有 bot 数据库指纹的进程**
（约 30 秒，需要 `data\dbcopy\nt_msg.db`；缺这个文件会直接跳过并给 WARN，不再空转扫内存）。

---

## 3. 分场景操作

### 3.1 电脑重启后

```powershell
# 1) 登录 QQ（bot 账号 1000000000）——这一步必须你来
# 2) 确认 bot 窗口是打开的（不要关到托盘）
powershell -File tools\recover.ps1 -RestoreWindow
```

重启后 pid 一定变了，`recover` 会自动重扫绑定。**不要手工删 `bot-pid.txt`** —— 删掉等于放弃绑定，`ui-rect` 会直接拒绝发送，但那不是恢复，是把问题藏起来。

### 3.2 QQ 被关到后台 / 退了

```powershell
powershell -File tools\recover.ps1 -StartQQ -RestoreWindow
```

如果 QQ 是**退出**（不是最小化），需要重新登录；脚本只能帮你把 QQ 拉起来。

恢复后建议验证一次：

```powershell
powershell -File tools\ui-rect.ps1     # 必须输出 4 个数字，形如 245 236 1178 914
```

### 3.3 断网后

不需要操作。现在的行为：

- `src/llm.ts` 会对网络错误 / 429 / 5xx **退避重试 3 次**（1s、2s、4s），仍失败则这条消息只记 `data/bot.jsonl` 的 `llm-error`，不回复；
- 接收侧照常工作（读的是本地通知库），但断网期间 QQ 本身也收不到消息；
- 网络回来后**下一条消息就能正常回复**，没有"卡死"状态需要清理。

想确认是不是网络问题：`ping` 一下 LLM 端点，或看 `data/bot.jsonl` 里有没有连续的 `llm-error`。

---

## 4. 窗口恢复的边界（重要）

本机实测的窗口事实，先记住这三条，能省掉大量试错：

| hwnd | 尺寸 | 是什么 |
|---|---|---|
| `724632` | **1178×914** | **QQ 主面板**（左侧图标栏 + 会话列表 + 聊天区），发送要用这个 |
| `921934` | 800×600 | 窄面板，**不是**主面板，别拿它当基准 |
| `724632` | 160×28 | 主面板被收进托盘后会缩成这条小浮条（同一个 hwnd） |

所以"面积最大"这个判据是错的：主面板收起时反而最小。`ui-restore.ps1` 现在的顺序是：

1. `data/ui-state.json` 里记录的 hwnd（`ui-rect` 每次成功都会写，来自上一次真正可用的窗口）；
2. 可见但很小的窗口（≤300 宽或 ≤60 高）——**大概率就是被收起的主面板**；
3. 其余按面积从大到小。

```powershell
powershell -File tools\ui-restore.ps1        # 干跑，只看候选顺序
powershell -File tools\ui-restore.ps1 -Yes   # 真的拉起来
powershell -File tools\ui-restore.ps1 -Hwnd 724632 -Yes    # 定向恢复某个窗口
powershell -File tools\ui-restore.ps1 -Hwnd 921934 -Hide   # 把误开的窗口收回去
```

拉起后仍会校验「可见 且 ≥480×360」，不合格就隐藏回去试下一个，全部失败返回 `ERR_RESTORE_FAILED`。

**判断是否真的能发**，唯一标准是 `ui-rect.ps1` 的输出等于 `245 236 1178 914` 附近的值（窗口移动过属正常，尺寸应接近 1178×914）。如果输出的是 800×600，说明恢复错了窗口，先 `-Hide` 掉再用 `-Hwnd 724632` 定向恢复。

---

## 5. 开机自启 + 自动重启（已实现）

不要手敲 `schtasks`（路径要写死、参数容易错），用项目里的脚本：

```powershell
cd C:\Users\<you>\Desktop\QQ-bot
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1           # 安装并立即启动
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Status   # 看两个任务的状态
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove   # 卸载
```

注册两个「登录时」任务：

| 任务 | 动作 | 解决什么 |
|---|---|---|
| `QQBot-Start` | `recover.ps1 -RestoreWindow -StartQQ` | 重启后不用手动跑恢复；QQ 没开也一起拉起 |
| `QQBot-Watchdog` | `watchdog.ps1 -Loop -IntervalSec 60 -RestoreWindow -RescanPid` | bot 被杀/卡死/心跳过期，60 秒内自动重启 |

实测：手动杀掉 bot 进程，50 秒后自动恢复，`http://127.0.0.1:8787` 同时恢复 200。

注意两点：

- 自启解决"进程没起来"，**解决不了 QQ 未登录**。没设自动登录的话，开机后仍需你登录一次 bot 账号
  （`-StartQQ` 只负责把 QQ.exe 拉起来，登录界面还得人点）。
- 任务必须是**交互会话**（当前用户、登录时触发）。注册成服务会在 session 0，没有桌面，
  粘贴和点击落不到 QQ 窗口，发送全废。

---

## 6. 出问题时先看这三个文件

| 文件 | 内容 |
|---|---|
| `data/bot.jsonl` | 每条事件/回复/错误的 JSONL 流水（`dir` 字段：`in` / `out` / `llm-error` / `send-error` / `skip-rate`） |
| `data/notify-archive.jsonl` | 收到的每条 QQ 通知（即使原 toast 被清掉，这里还留着） |
| `data/bot-stdout.log` / `bot-stderr.log` | `recover.ps1` 拉起进程时的标准输出 |

---

## 7. 已知红线（不要为了"恢复"去碰）

- **不要杀单个 QQ 进程**：会白屏另一个实例。要重启就全部关掉、等 4 秒、只起一个。
- **不要删 `bot-pid.txt` 绕过报错**：那只是让 `ui-rect` 换一种方式失败。
- **不要清 QQ 的登录存储**（Local Storage / Session Storage / auth）：白屏补救只清 GPUCache / Code Cache / Cache。
- **不要为了让通知出现去改 QQ 的 asar / package.json**：会触发"文件已损坏"完整性弹窗（已验证）。
- **改 `.ps1` 时一律纯 ASCII**：PowerShell 5.1 按 ANSI 读取无 BOM 脚本，中文注释会变乱码并直接把脚本解析搞崩（本次就这么踩过一次，`ui-restore.ps1` / `ui-rect.ps1` 报"意外的标记 }"）。
- **不要在 `.ps1` 里用 `Start-Process` 起 bot**：此环境有 `HTTPS_PROXY`/`https_proxy` 大小写重复键，PS 5.1 会抛 "字典中的关键字重复"；`recover.ps1` 已改用 .NET `ProcessStartInfo`。

---

## 8. 当前状态（2026-11-17 14:01 实测）

`recover.ps1` 全流程跑通，`doctor.ps1` 结果：

```
[OK  ] qq-process    18 QQ.exe, 2 with a visible window
[OK  ] bot-pid       pid 34260 alive (QQ)
[OK  ] bot-window    visible 1178x914
[OK  ] receive       last event 12min ago
[OK  ] notif-db      present
[OK  ] bot-process   pid 40328
[FAIL] llm-config         no provider has an apiKey -> fill one in WebUI deepseek/deepseek-chat
[OK  ] receive-mode  notify (1500ms)
VERDICT: FATAL (1 fail)
```

**唯一剩下的失败项就是模型配置**：打开控制台 `http://127.0.0.1:8787` →「模型供应」→ 选厂商、填 API Key、点「测试」→ 点模型胶囊设为默认，即可 `VERDICT: HEALTHY`。

启动 bot 的那一步会打印 `STARTED pid=xxxxx`。注意：`start-bot.ps1` / `recover.ps1` 用 `WScript.Shell` 脱离父进程启动，**在自己的 PowerShell 窗口里跑会正常常驻**；如果在某些受限环境（沙箱、被杀进程树回收的宿主）里跑，进程可能随父进程一起结束——此时改用计划任务（第 5 节）或直接在终端里 `npm run bot`。

---

## 9. 附：`tools/start-bot.ps1`

只负责"把 bot 拉起来"，不开窗口、不抢焦点：

```powershell
powershell -File tools\start-bot.ps1
# 已在跑 -> ALREADY_RUNNING pid=...
# 启动成功 -> STARTED pid=... log=data\bot-stdout.log
```

`recover.ps1` 内部也调它，不需要你单独跑。

---

## 10. 控制台（v0.2 新增）

`npm run bot` 会连同 WebUI 一起启动，**恢复流程不变**，只是"填模型"这一步从改文件变成了点界面：

```
http://127.0.0.1:8787  →  模型供应  →  添加厂商（预置） →  填 Key  →  测试  →  设为默认
```

- 只想改配置、不收消息：`npm run webui`（独立进程，不占 QQ 窗口）。
- 端口被占：改 `config.json` 的 `webui.port`（需重启进程）。
- 概览页有四个应急按钮，分别对应本手册里的 `doctor` / `ui-restore` / `mem-allsalt-scan` / 重启接收器，不用再开终端。
- 详细说明见 **`WEBUI.md`**。

> 注意：v0.2 起 `config.json` 的结构变了（`llm` → `providers[]` + `models{}`）。老文件首次加载会自动迁移，`doctor.ps1` 也已同步改为校验新结构，不需要手工改。
