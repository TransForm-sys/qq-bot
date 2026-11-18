# 把这套 bot 搬到另一台机器 / 虚拟机

目标状态：**Windows 虚拟机里跑 QQ + bot，宿主机只负责用浏览器看控制台**。
搬完之后宿主机上不会被抢鼠标、不会被抢焦点，两边完全隔离。

以下步骤按顺序做，中间的「⚠️」都是踩过的坑，跳过会浪费时间。

---

## 0. 一句话版本

```
宿主机：tools\make-portable.ps1  ->  qq-bot-portable.zip（约 0.2MB）
VM    ：装 QQ(登录 bot 号) + 装 Node 22  ->  解压 zip  ->  双击 启动bot.bat
```

项目**零 npm 依赖**，不需要 `npm install`；真正要装的只有 Node 和 QQ 客户端。

---

## 1. 虚拟机本体设置（5 条，缺一条就跑不起来）

在 **VMConnect 窗口**里操作，不是宿主机。

### 1.1 用「基本会话」，不要「增强会话」

VMConnect 工具栏 → 「查看」→ 取消勾选 **增强会话模式**（或连接时选「基本会话」）。

> 增强会话本质是 RDP：你一关 VMConnect 窗口，VM 内就锁屏，`session-state.ps1` 报 `LOCKED`，
> `SendInput` 全部失效 —— 表现是「进程活着、日志正常、一条消息都发不出去」。
> 基本会话关掉窗口后 VM 继续跑，像一台没人碰的物理机。

### 1.2 开自动登录

不设的话，重启后停在锁屏，bot 起来也发不出消息。

```powershell
# 管理员 PowerShell
# Win11 默认隐藏了 netplwiz 的「必须输入密码」勾选项，先关掉这个开关
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" /v DevicePasswordLessBuildVersion /t REG_DWORD /d 0 /f
netplwiz
```

在弹出的窗口里取消勾选「要使用本计算机，用户必须输入用户名和密码」→ 应用 → 输入账号密码。
（或用 Sysinternals **Autologon**，一条命令搞定，更省事。）

### 1.3 禁止锁屏 / 睡眠 / 休眠

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /hibernate off
```

再手动关掉「离开后自动锁屏」：**设置 → 账户 → 登录选项 →**
「如果你离开，Windows 应在何时要求你重新登录」→ **从不**。

### 1.4 缩放必须是 100%，分辨率建议 1920×1080

**设置 → 系统 → 显示 → 缩放 100%**。

> 发送回执的判据是「输入框文字行有没有变脏」，用的是**窗口比例坐标**。
> DPI 125%/150% 会改变文字行在窗口里的高度占比，可能让 `delta` 掉到阈值以下。
> 100% 缩放 + QQ 窗口别拉得特别小，就不用重新标定。

### 1.5 通知必须真的能弹出来

这是**接收**链路的命门 —— 收消息靠轮询 Windows 通知库，通知被拦就什么都收不到。

- **设置 → 系统 → 通知**：「通知」总开关 **开**
- 列表里找到 **QQ**，确认允许通知
- 关闭「专注助手 / 勿扰」：**设置 → 系统 → 通知 → 专注助手** → 关闭
- **设置 → 隐私和安全性 → 通知** 里不要禁止应用访问通知

---

## 2. 装 QQ 并登录 bot 号

### ⚠️ 先退掉宿主机上的 bot 号

QQ 的 **PC 端 + PC 端同账号不能同时在线**（手机 + PC 可以）。
VM 一登录 bot 号，宿主机就被踢下线 —— 宿主机上那套 bot 会变成「能跑但收不到也发不出」。

正确顺序：

1. 宿主机 QQ 里退出 **1000000000**（左下角头像 → 退出登录）
2. VM 里安装 QQ NT（版本尽量和宿主机一致），登录 1000000000
3. 登录时勾上 **自动登录**，下次开机自己就上去了

登录完把主面板**留在桌面上**（别收进托盘）。收进托盘也能跑，只是第一条消息会慢 1 秒左右（会自动 `ui-restore` 拉出来）。

---

## 3. 装 Node 22

要求 **≥ 22.18**（项目直接运行 `.ts`，且用到 `node:sqlite`）。和宿主机一致最省事：**v22.22.2**。

```powershell
winget install OpenJS.NodeJS.LTS
# 或下载 node-v22.22.2-x64.msi 手动装
```

装完**新开一个** PowerShell 验证：

```powershell
node -v          # 期望 v22.18.0 或更高
```

---

## 4. 把项目拷进虚拟机

宿主机上先打包（**这一步已经在宿主机做完了**，产物在 `qq-bot\qq-bot-portable.zip`，0.2MB）：

```powershell
# 宿主机，需要时重新生成
cd D:\<you>\Documents\project\QQ-bridge\qq-bot
powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-portable.ps1
```

打包会**主动排除**：`data/` 里的内存转储（500MB）、旧 DB 副本、日志、截图、`bot-pid.txt`、
`ui-state.json`、`heartbeat.json`、`alerts.jsonl`。
**保留**：全部源码、`config.json`（含 API Key）、`persona.md`、记忆会话、插件数据。

传进 VM，三选一：

### 方法 A：Hyper-V 直接投递（一条命令）

```powershell
# 宿主机，管理员 PowerShell，VM 名换成你的
Enable-VMIntegrationService -VMName "Win11" -Name "Guest Service Interface"
Copy-VMFile -VMName "Win11" `
  -SourcePath "D:\<you>\Documents\project\QQ-bridge\qq-bot\qq-bot-portable.zip" `
  -DestinationPath "C:\Users\<VM里的用户名>\Desktop\qq-bot-portable.zip" `
  -CreateFullPath -FileSource Host
```

### 方法 B：宿主机起个临时 HTTP 服务（最不容易失败）

```powershell
# 宿主机
cd D:\<you>\Documents\project\QQ-bridge\qq-bot
python -m http.server 8000
# 若宿主机防火墙拦了，管理员 PowerShell 放行一次：
# New-NetFirewallRule -DisplayName "tmp-http-8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
```

VM 里用 Edge 打开 `http://<宿主机IP>:8000/qq-bot-portable.zip` 直接下载。
（宿主机 IP：`ipconfig` 看 vEthernet (Default Switch) 那块。）

### 方法 C：共享文件夹

宿主机 `New-SmbShare -Name qqbot -Path D:\<you>\Documents\project\QQ-bridge\qq-bot`，
VM 里资源管理器打开 `\\<宿主机IP>\qqbot` 复制。可能需要在 VM 里输宿主机账号密码。

---

## 5. 解压并首次启动

```powershell
# VM 里，普通 PowerShell 即可
Expand-Archive -Path "$env:USERPROFILE\Desktop\qq-bot-portable.zip" -DestinationPath C:\qq-bot -Force
cd C:\qq-bot
```

> 不要放 `C:\Program Files`（要管理员权限，路径还有空格）。`C:\qq-bot` 就很好。

确认 `config.json` 里 Key 还在（打包时是带着的）：

```powershell
node -e "const c=require('./config.json'); console.log(c.providers.map(p=>p.id+':'+(p.apiKey?'key ok':'NO KEY')).join(' '))"
```

首次启动，**双击 `启动bot.bat`**，或者：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\recover.ps1 -RestoreWindow
```

它会依次做：查 QQ → **重扫 pid 绑定**（约 20–30 秒，第一次必须跑）→ 把主面板从托盘拉出来 →
启动 bot → 体检 → 打开控制台。

看到 `VERDICT: HEALTHY` 就成功了。健康检查随时可以再跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\doctor.ps1
```

### 如果 `bot-pid` 报 `no binding`

现在的绑定不再依赖内存扫描：`recover.ps1` 先看**进程树**（几个 QQ 实例 = 几个已登录账号）
和**磁盘上的账号目录**（`<QQ 数据根>\<uin>`，最近写入的那个就是当前账号），两者都唯一才写
`bot-pid.txt`。所以这条报错通常意味着：bot 号没登录，或者登录的不是 1000000000。

只有"同一台机器开了两个 QQ 实例"时才会退化到内存扫描兜底，而兜底需要
`data\dbcopy\nt_msg.db`（打包时剔除了）。缺这个文件时脚本会直接退出，不会卡住 —— 这是
2026-11-17 修掉的坑（见 HANDOFF 第 18 节）。

---

## 6. 标定验证（换分辨率/DPI 后必做）

```powershell
cd C:\qq-bot
node tools\selftest-send.mjs          # 只粘贴 + 清空，绝不发送
```

打开当前已打开的那个聊天窗口（随便点一个会话），看输出：

```
[probe-only] noise=0 span=772（阈值 90）    <- 好：span 远大于阈值，判据有余量
```

判断标准：

| 输出 | 含义 | 怎么办 |
|---|---|---|
| `span` ≥ 90 且远大于 `noise` | 区域正确 | 不用管 |
| `span` 很小、`noise` 很大 | 采样瞬间窗口在重绘（搜索面板/会话切换中） | 再跑一次 |
| `span≈0` | 粘贴没进输入框 | 看 `data/ui/probe-*.bmp`，多半是会话没打开或焦点被抢 |
| `ERR_BOT_PID_GONE` | QQ 换了 pid | 重跑 `tools\recover.ps1`（或双击启动器） |

> 判据已从"墨迹量差值 ≥60"改成"前后两张截图的**像素差分**"。原因：QQ 的输入框占位符是
> 垂直居中的、输入文字是顶部对齐的，固定高度的条带在 960x640 的 VM 窗口上会落在两者之间
> 的空白里，导致 `delta` 恒为 0（"贴上了"被误判成"没贴上"）。

标定通过后可以真发一条：

```powershell
node tools\selftest-send.mjs --send 文件传输助手
```

---

## 7. 从宿主机看控制台

VM 里的 WebUI 默认只监听 `127.0.0.1`，宿主机访问不到。两种办法：

### 7.1 改成监听所有网卡（推荐）

VM 里改 `C:\qq-bot\config.json`：

```json
"webui": { "port": 8787, "host": "0.0.0.0", "token": "" }
```

放行防火墙 + 重启 bot：

```powershell
New-NetFirewallRule -DisplayName "qq-bot 8787" -Direction Inbound -LocalPort 8787 -Protocol TCP -Action Allow
# 重启 bot
powershell -NoProfile -ExecutionPolicy Bypass -File tools\stop-bot.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\recover.ps1
```

VM 里 `ipconfig` 拿到 IP（Default Switch 下一般是 `172.x.x.x`），宿主机浏览器打开
`http://<VM-IP>:8787`。

> `Default Switch` 的 IP 每次重启可能变。想固定就再挂一块「内部网络」虚拟交换机给静态 IP，
> 或者每次 `Get-VMNetworkAdapter -VMName "Win11" | Select IPAddresses` 查一下。

### 7.2 直接在 VMConnect 窗口里用浏览器

最省事，不用改任何配置，缺点是小窗口看长列表不舒服。

---

## 8. 搬家之后要记得的三件事

1. **宿主机上的 bot 别再启动**。同一个 QQ 号只会有一个 PC 端在线，两边同时跑必然有一边是废的。
   宿主机留着代码和文档就行，当备份和开发环境。
2. **VM 开机自启**：已实现，跑一次即可（幂等，重复跑只是覆盖注册）
   ```powershell
   cd C:\Users\<you>\Desktop\QQ-bot
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1
   ```
   会注册两个「登录时」任务，并立刻启动，注册完自动探测 8787：

   | 任务名 | 执行 | 作用 |
   |---|---|---|
   | `QQBot-Start` | `recover.ps1 -RestoreWindow -StartQQ` | 登录后重绑实例、取消托盘、拉起 bot；QQ 没运行就一起拉起 |
   | `QQBot-Watchdog` | `watchdog.ps1 -Loop -IntervalSec 60 -RestoreWindow` | 每 60 秒复查，进程消失或心跳过期就自动重启 |

   ```powershell
   powershell -File tools\install-autostart.ps1 -Status    # 看两个任务的状态
   powershell -File tools\install-autostart.ps1 -Remove    # 卸载
   ```

   > 必须用「登录时 + 交互会话」而不是注册成服务：session 0 没有桌面，粘贴和点击都落不到 QQ 窗口上。

3. **闸门会自动失效**：`reply.sendIdleMs` 靠检测键鼠空闲，VM 里没人操作，idle 一直是满的，
   所以消息会立即发出 —— 这是期望行为，不用去关。

---

## 9. 迁移后自检清单

```
[ ] 设置里缩放 100%，分辨率 1920x1080 左右
[ ] 关掉锁屏 / 睡眠 / 休眠
[ ] 自动登录已验证（重启一次，能自己进桌面）
[ ] 通知总开关 + QQ 通知权限 都开着，专注助手关着
[ ] QQ 登录的是 1000000000，且留在主面板
[ ] node -v  >= 22.18
[ ] tools\doctor.ps1  ->  VERDICT: HEALTHY
[ ] tools\selftest-send.mjs  ->  span>=90 且远大于 noise
[ ] 用另一个号给 bot 发一条消息，能收到回复
```

---

## 附：哪些文件是「每台机器独有」的，不要互相拷

| 文件 | 内容 | 换机器怎么办 |
|---|---|---|
| `data/bot-pid.txt` | bot QQ 实例的进程号 | 自动重扫，已从包里剔除 |
| `data/ui-state.json` | 窗口句柄 | 已剔除 |
| `data/heartbeat.json` | 心跳时间戳 | 已剔除（否则 watchdog 立刻判定卡死） |
| `data/alerts.jsonl` | 历史告警 | 已剔除（否则一进来就是红字） |
| `data/*.bin` | QQ 进程内存转储 | 已剔除，500MB，纯调试残留 |
| `data/sessions/*.json` | 和每个人的记忆 | **保留**，跟着走 |
| `config.json` | 人设/模型/Key/回复节奏 | **保留**，跟着走 |
