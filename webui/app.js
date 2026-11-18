/* 爱弥斯控制台前端 —— 零依赖，原生 ES 模块之外的普通脚本 */
"use strict";

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

const S = {
  route: "overview",
  state: null,
  presets: [],
  persona: { file: "", content: "", dirty: false },
  logs: [],
  logFilter: "all",
  logSearch: "",
  logPaused: false,
  sessions: [],
  actionOut: "",
  busy: false
};

const ROUTES = {
  overview: "概览",
  persona: "人设",
  reply: "回复节奏",
  models: "模型供应",
  plugins: "插件",
  logs: "日志",
  sessions: "会话记忆"
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, kind = "ok", ms = 2600) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="dot ${kind === "err" ? "err" : "ok"}"></span><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "all .2s";
    setTimeout(() => el.remove(), 220);
  }, ms);
}

async function api(path, opts = {}) {
  const headers = { "content-type": "application/json" };
  const tk = localStorage.getItem("wb_token");
  if (tk) headers["x-token"] = tk;
  let res;
  try {
    res = await fetch("/api" + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch {
    throw new Error("连不上后端，确认 bot 进程在运行");
  }
  if (res.status === 401) {
    const t = prompt("这个控制台设置了访问令牌，请输入：");
    if (t) {
      localStorage.setItem("wb_token", t);
      return api(path, opts);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 格式化 ---------------- */
const pad = (n) => String(n).padStart(2, "0");
const clock = (t) => {
  const d = new Date(t || Date.now());
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dateTime = (t) => {
  const d = new Date(t || Date.now());
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function fmtDur(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}天${h}小时`;
  if (h) return `${h}小时${m}分`;
  if (m) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

const DIR_META = {
  in: { cls: "in", label: "收到" },
  out: { cls: "out", label: "回复" },
  "skip-rate": { cls: "skip", label: "限流" },
  "skip-plugin": { cls: "skip", label: "插件" },
  "skip-empty": { cls: "skip", label: "空回复" },
  "llm-error": { cls: "err", label: "模型错" },
  "send-error": { cls: "err", label: "发送错" },
  "engine-error": { cls: "err", label: "引擎错" }
};

function logLine(r) {
  if (r.raw) return { t: Date.now(), dir: "err", text: r.raw };
  const meta = DIR_META[r.dir] || { cls: "skip", label: r.dir || "?" };
  let text = "";
  if (r.dir === "in") text = `${r.kind === "group" ? "群 " + (r.groupName || r.groupId) : "私聊"} · ${r.senderName || r.peerUin}: ${r.text || ""}`;
  else if (r.dir === "out") text = `→ ${r.target}: ${r.reply || ""}${r.segments > 1 ? ` (${r.segments}条)` : ""}`;
  else if (r.dir === "llm-error") text = r.error || "";
  else if (r.dir === "send-error") text = `${r.target || ""} ${r.error || ""}`;
  else if (r.dir === "skip-rate") text = `间隔不足，跳过 ${r.id || ""}`;
  else if (r.dir === "skip-plugin") text = `被插件拦截 (${r.by || ""})`;
  else text = r.error || JSON.stringify(r);
  return { t: r.t || Date.now(), dir: meta.cls, label: meta.label, text: text.slice(0, 400) };
}

/* ---------------- 路由 ---------------- */
function go(route) {
  S.route = route;
  location.hash = "#/" + route;
  render();
}

function render() {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.route === S.route));
  $("#crumb").textContent = ROUTES[S.route] || "";
  const view = $("#view");
  const scroll = view.scrollTop;
  view.innerHTML = "";
  const fn = {
    overview: viewOverview,
    persona: viewPersona,
    reply: viewReply,
    models: viewModels,
    plugins: viewPlugins,
    logs: viewLogs,
    sessions: viewSessions
  }[S.route];
  if (fn) fn(view);
  view.scrollTop = S.route === "overview" ? scroll : 0;
  paintPills();
}

/* ---------------- 顶部状态 ---------------- */
function paintPills() {
  const st = S.state;
  if (!st) return;
  const b = st.bot;
  const c = st.config;
  const online = b.pid > 0;
  const dot = $("#rail-dot");
  dot.className = "dot " + (online ? "ok pulse" : "err");
  $("#rail-text").textContent = online ? "运行中 · PID " + b.pid : "未连接";

  const keyReady = c.providers.some((p) => p.hasKey || /127\.0\.0\.1|localhost/.test(p.baseURL));
  const model = c.models.default || "未配置";
  $("#pills").innerHTML = [
    `<span class="pill"><span class="dot ${online ? "ok" : "err"}"></span>${online ? "在线" : "离线"} ${fmtDur(b.uptimeMs)}</span>`,
    `<span class="pill">接收 <b>${c.receive === "db" ? "DB 解密" : "通知中心"}</b></span>`,
    `<span class="pill">模型 <b>${esc(model.length > 26 ? model.slice(0, 26) + "…" : model)}</b></span>`,
    `<span class="pill"><span class="dot ${keyReady ? "ok" : "warn"}"></span>${keyReady ? "Key 就绪" : "缺 API Key"}</span>`
  ].join("");
}

/* ---------------- 概览 ---------------- */
function viewOverview(view) {
  const st = S.state;
  if (!st) {
    view.innerHTML = `<div class="empty">正在连接 bot 进程…</div>`;
    return;
  }
  const b = st.bot;
  const c = st.config;
  const cts = b.counters;
  const healthOk = st.health.filter((h) => h.ok).length;
  const enabledProviders = c.providers.filter((p) => p.enabled).length;

  // 告警横幅：这些状态进程还活着，但功能已经失效，必须显眼
  const alerts = Array.isArray(b.alerts) ? b.alerts : [];
  const alertsHtml = alerts.length
    ? `<section class="alerts">${alerts
        .slice(0, 6)
        .map(
          (a) => `<div class="alert ${a.level === "warn" ? "warn" : "err"}">
            <span class="alert-dot"></span>
            <div class="alert-body">
              <div class="alert-head"><span class="alert-code">${esc(a.code)}</span>${a.count > 1 ? `<span class="alert-count">×${a.count}</span>` : ""}<span class="alert-time">${clock(a.at)}</span></div>
              <div class="alert-msg">${esc(a.message || "")}</div>
            </div>
          </div>`
        )
        .join("")}<button class="btn sm ghost right" id="ov-clear-alerts">清除</button></section>`
    : "";

  const feed = S.logs.slice(-14).reverse();
  const feedHtml = feed.length
    ? feed
        .map((r) => {
          const l = logLine(r);
          return `<div class="feed-row"><span class="feed-time">${clock(l.t)}</span><span class="badge ${l.dir}">${esc(l.label || "")}</span><span class="feed-text" title="${esc(l.text)}">${esc(l.text)}</span></div>`;
        })
        .join("")
    : `<div class="empty">还没有消息流过。等一条 QQ 消息，或点右上角「测试对话」。</div>`;

  const healthHtml = st.health.length
    ? st.health
        .map(
          (h) => `<div class="chain-row">
            <span class="dot ${h.ok ? "ok" : "err"}"></span>
            <span class="mono">${esc(h.id)}</span>
            <span class="tiny dim">${h.ok ? (h.latencyMs || 0) + "ms" : esc((h.error || "失败").slice(0, 40))}</span>
          </div>`
        )
        .join("")
    : `<div class="empty tiny">还没有模型调用记录</div>`;

  view.innerHTML = `
    ${alertsHtml}
    <section class="hero card">
      <div class="hero-main">
        <div class="hero-title">
          <span class="dot ${b.pid ? "ok pulse" : "err"}"></span>
          <h2>${esc(c.botName || "Bot")} ${b.pid ? "正在运行" : "未运行"}</h2>
          <span class="muted">PID ${b.pid} · 已运行 ${fmtDur(b.uptimeMs)}</span>
        </div>
        <div class="hero-sub">
          <span>接收 <b>${c.receive === "db" ? "nt_msg 解密" : "通知中心 R3"}</b> 每 <b>${c.receiveIntervalMs}ms</b></span>
          <span>接收健康 <b>${(b.receiverHealth?.snapshotFailStreak || 0) > 0 ? `异常 ${b.receiverHealth.snapshotFailStreak}` : "正常"}</b></span>
          <span>默认模型 <b>${esc(c.models.default || "未配置")}</b></span>
          <span>厂商 <b>${enabledProviders}/${c.providers.length}</b></span>
          <span>插件 <b>${st.plugins.filter((p) => p.enabled).length}</b></span>
        </div>
        <div class="hero-actions">
          <button class="btn" data-act="restart-receiver">重启接收器</button>
          <button class="btn" data-act="doctor">运行体检</button>
          <button class="btn" data-act="restore-window">恢复窗口</button>
          <button class="btn" data-act="rescan-pid">重扫窗口绑定</button>
        </div>
        <div id="action-out">${S.actionOut ? `<pre class="output">${esc(S.actionOut)}</pre>` : ""}</div>
      </div>
      <div class="hero-side">
        <div class="gauge"><span class="n">${healthOk}</span><span class="l">通道健康</span></div>
        <div class="gauge"><span class="n">${b.lastLlm ? b.lastLlm.ms + "ms" : "—"}</span><span class="l">上次延迟</span></div>
        <div class="gauge"><span class="n">${c.reply.minIntervalMs}ms</span><span class="l">最小间隔</span></div>
      </div>
    </section>

    <div class="stats">
      <div class="stat"><div class="k">收到消息</div><div class="v">${cts.in}</div></div>
      <div class="stat ok"><div class="k">已回复</div><div class="v">${cts.out}</div></div>
      <div class="stat"><div class="k">跳过</div><div class="v">${cts.skipped}</div></div>
      <div class="stat err"><div class="k">错误</div><div class="v">${cts.errors}</div></div>
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-hd"><h3>最近动态</h3><span class="sub">实时</span></div>
        <div class="feed">${feedHtml}</div>
      </div>
      <div class="card">
        <div class="card-hd"><h3>模型通道</h3><span class="sub">失败 3 次进入 60s 熔断</span></div>
        <div class="chain">${healthHtml}</div>
        <div style="margin-top:14px" class="row">
          <button class="btn sm" data-route="models">管理厂商</button>
          <button class="btn sm ghost" id="ov-test">测试当前模型</button>
        </div>
      </div>
    </div>
  `;

  $$("[data-act]", view).forEach((btn) => btn.addEventListener("click", () => runAction(btn.dataset.act, btn)));
  $$("[data-route]", view).forEach((btn) => btn.addEventListener("click", () => go(btn.dataset.route)));
  const ca = $("#ov-clear-alerts");
  if (ca)
    ca.addEventListener("click", async () => {
      try {
        await api("/api/alerts", { method: "DELETE" });
        toast("告警已清除");
        await refreshState();
      } catch (e) {
        toast(e.message, "err");
      }
    });
  const t = $("#ov-test");
  if (t) t.addEventListener("click", () => openTestChat());
}

async function runAction(name, btn) {
  const old = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> 执行中`;
  }
  try {
    const r = await api(`/actions/${name}`, { method: "POST" });
    S.actionOut = r.output || (r.started ? "已开始扫描，约 1-3 分钟，进度见下方。完成后 bot-pid 会自动更新。" : "完成");
    if (name === "rescan-pid") S.actionOut = "扫描已启动，约 1-3 分钟。期间可继续操作。";
    toast(name + " 完成");
  } catch (e) {
    S.actionOut = "失败：" + e.message;
    toast(e.message, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
    const out = $("#action-out");
    if (out) out.innerHTML = S.actionOut ? `<pre class="output">${esc(S.actionOut)}</pre>` : "";
    refreshState();
  }
}

/* ---------------- 人设 ---------------- */
async function viewPersona(view) {
  view.innerHTML = `<div class="empty"><span class="spinner"></span> 读取人设文件…</div>`;
  try {
    if (!S.persona.file) {
      const st = S.state;
      const active = (st.personas.find((p) => p.active) || st.personas[0] || {}).file || st.config.personaFile;
      const r = await api("/persona?file=" + encodeURIComponent(active));
      S.persona = { file: r.file, content: r.content, dirty: false };
    }
  } catch (e) {
    view.innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
    return;
  }

  const st = S.state;
  const files = st.personas;
  view.innerHTML = `
    <div class="persona-wrap">
      <div class="card">
        <div class="card-hd"><h3>人设文件</h3><button class="btn sm right" id="p-new">新建</button></div>
        <div class="file-list" id="p-files">
          ${files
            .map(
              (f) => `<div class="file-item ${f.file === S.persona.file ? "active" : ""}" data-file="${esc(f.file)}">
                <span>${esc(f.file.replace("personas/", ""))}</span>
                ${f.active ? `<span class="badge out">启用</span>` : ""}
              </div>`
            )
            .join("")}
        </div>
        <p class="tiny dim" style="margin:12px 0 0">人设每轮对话都会作为 system prompt 注入，改完保存即生效，无需重启。</p>
      </div>

      <div class="card editor">
        <div class="editor-bar">
          <b id="p-file" class="mono small">${esc(S.persona.file)}</b>
          <span class="dot warn ${S.persona.dirty ? "" : "hide"}" id="p-dirty"></span>
          <span class="meta" id="p-meta">${S.persona.content.length} 字</span>
          <div class="right row">
            <button class="btn sm ghost" id="p-preview">预览</button>
            <button class="btn sm ghost" id="p-activate">设为当前</button>
            <button class="btn sm primary" id="p-save">保存</button>
          </div>
        </div>
        <textarea id="p-text" class="input" spellcheck="false">${esc(S.persona.content)}</textarea>
        <div class="card hide" id="p-preview-box" style="min-height:200px"></div>
      </div>
    </div>
  `;

  const ta = $("#p-text");
  ta.addEventListener("input", () => {
    S.persona.content = ta.value;
    S.persona.dirty = true;
    $("#p-dirty").classList.remove("hide");
    $("#p-meta").textContent = ta.value.length + " 字";
  });

  $$(".file-item", view).forEach((el) =>
    el.addEventListener("click", async () => {
      if (S.persona.dirty && !confirm("当前修改还没保存，确定切换？")) return;
      const f = el.dataset.file;
      try {
        const r = await api("/persona?file=" + encodeURIComponent(f));
        S.persona = { file: r.file, content: r.content, dirty: false };
        render();
      } catch (e) {
        toast(e.message, "err");
      }
    })
  );

  $("#p-save").addEventListener("click", async () => {
    try {
      await api("/persona", { method: "PUT", body: { file: S.persona.file, content: ta.value } });
      S.persona.dirty = false;
      $("#p-dirty").classList.add("hide");
      toast("人设已保存，下一条消息生效");
      refreshState();
    } catch (e) {
      toast(e.message, "err");
    }
  });

  $("#p-activate").addEventListener("click", async () => {
    try {
      await api("/persona", { method: "PUT", body: { file: S.persona.file, content: ta.value, activate: true } });
      S.persona.dirty = false;
      toast("已设为当前人设");
      refreshState();
      render();
    } catch (e) {
      toast(e.message, "err");
    }
  });

  $("#p-preview").addEventListener("click", () => {
    const box = $("#p-preview-box");
    box.classList.toggle("hide");
    box.innerHTML = miniMarkdown(ta.value);
  });

  $("#p-new").addEventListener("click", () => {
    openDrawer("新建人设", `
      <div class="field"><label>文件名</label>
        <input class="input" id="np-name" placeholder="例如：persona-cool" value="persona-${Date.now().toString(36).slice(-4)}" />
        <div class="hint">会保存到 personas/ 目录，自动补 .md</div>
      </div>
      <div class="field"><label>初始内容</label>
        <textarea class="input" id="np-body" style="min-height:220px"># 人设

你是……（写清楚说话风格、回复长度、边界）

- 说话自然，不要客服腔
- 回复简短，1-3 句
- 不知道就说不知道</textarea>
      </div>
      <div class="row"><button class="btn primary" id="np-ok">创建</button></div>
    `);
    $("#np-ok").addEventListener("click", async () => {
      const name = $("#np-name").value.trim();
      try {
        const r = await api("/persona", { method: "POST", body: { name, content: $("#np-body").value, activate: false } });
        S.persona = { file: r.file, content: $("#np-body").value, dirty: false };
        closeDrawer();
        toast("已创建 " + r.file);
        await refreshState();
        render();
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });

  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      $("#p-save").click();
    }
  });
}

function miniMarkdown(src) {
  const lines = String(src || "").split(/\r?\n/);
  let html = "";
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    if (!line) html += "<p></p>";
    else if (/^#{1,3}\s+/.test(line)) {
      const lvl = line.match(/^#+/)[0].length;
      html += `<h${lvl + 1}>${inline(line.replace(/^#+\s+/, ""))}</h${lvl + 1}>`;
    } else html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`(.+?)`/g, `<code style="font-family:var(--mono);font-size:12px;background:var(--panel-3);padding:1px 5px;border-radius:4px">$1</code>`);
}

/* ---------------- 回复节奏 ---------------- */
function viewReply(view) {
  const c = S.state.config;
  const r = c.reply;
  const q = r.quietHours || { enabled: false, start: "23:30", end: "08:00" };
  view.innerHTML = `
    <div class="card">
      <div class="card-hd"><h3>触发条件</h3><span class="sub">决定哪些消息会回</span></div>
      <div class="panel-grid">
        <div class="field">
          <label>私聊</label>
          <div class="row"><label class="switch"><input type="checkbox" id="f-private" ${r.private ? "checked" : ""}/><span class="track"></span></label>
          <span class="small muted">${r.private ? "有问必答" : "完全不理私聊"}</span></div>
        </div>
        <div class="field">
          <label>群白名单</label>
          <input class="input" id="f-groups" value="${esc((r.groups || []).join(", "))}" placeholder="测试用群, 另一个群（* = 所有群）" />
          <div class="hint">逗号分隔；群消息还需要 @bot 或提到名字（名字在下面）</div>
        </div>
        <div class="field">
          <label>Bot 名字（群里被点名才接话）</label>
          <input class="input" id="f-botname" value="${esc(c.botName || "")}" placeholder="爱弥斯" />
        </div>
        <div class="field">
          <label>接收方式</label>
          <select class="select" id="f-receive">
            <option value="notify" ${c.receive === "notify" ? "selected" : ""}>通知中心（推荐，零注入）</option>
            <option value="db" ${c.receive === "db" ? "selected" : ""}>nt_msg.db 解密（需密钥）</option>
          </select>
          <div class="hint">切换后接收器会自动重建</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd"><h3>回复节奏</h3><span class="sub">让回复看起来像人在打字</span></div>
      <div class="panel-grid">
        <div class="field">
          <label>最小回复间隔 <span class="dim tiny">（两条回复之间至少隔这么久）</span></label>
          <div class="slider-row">
            <input type="range" class="range" id="f-minint" min="0" max="10000" step="100" value="${r.minIntervalMs}" data-out="f-minint-v" />
            <span class="num" id="f-minint-v">${r.minIntervalMs} ms</span>
          </div>
        </div>
        <div class="field">
          <label>每分钟最多回复</label>
          <div class="slider-row">
            <input type="range" class="range" id="f-maxpm" min="1" max="30" step="1" value="${r.maxPerMinute}" data-out="f-maxpm-v" />
            <span class="num" id="f-maxpm-v">${r.maxPerMinute} 条</span>
          </div>
        </div>
        <div class="field">
          <label>"看消息"停顿 <span class="dim tiny">（收到后先等一会再生成）</span></label>
          <div class="row">
            <input class="input" type="number" id="f-read-min" value="${r.readDelayMs[0]}" min="0" max="60000" step="100" />
            <span class="muted">~</span>
            <input class="input" type="number" id="f-read-max" value="${r.readDelayMs[1]}" min="0" max="60000" step="100" />
            <span class="muted small">ms</span>
          </div>
        </div>
        <div class="field">
          <label>打字速度 <span class="dim tiny">（每秒字数，决定发送前的等待）</span></label>
          <div class="slider-row">
            <input type="range" class="range" id="f-cps" min="2" max="60" step="1" value="${r.typingSpeedCps}" data-out="f-cps-v" />
            <span class="num" id="f-cps-v">${r.typingSpeedCps} 字/秒</span>
          </div>
        </div>
        <div class="field">
          <label>打字停顿上限</label>
          <div class="slider-row">
            <input type="range" class="range" id="f-maxtype" min="0" max="8000" step="100" value="${r.maxTypingMs}" data-out="f-maxtype-v" />
            <span class="num" id="f-maxtype-v">${r.maxTypingMs} ms</span>
          </div>
        </div>
        <div class="field">
          <label>长回复分几条发</label>
          <div class="slider-row">
            <input type="range" class="range" id="f-split" min="1" max="4" step="1" value="${r.splitSegments}" data-out="f-split-v" />
            <span class="num" id="f-split-v">${r.splitSegments === 1 ? "不拆" : r.splitSegments + " 条"}</span>
          </div>
          <div class="hint">由「分段发送」插件执行，超过 40 字才拆</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd"><h3>发送可靠性</h3><span class="sub">防止"以为发出去了，其实没有"</span></div>
      <div class="panel-grid">
        <div class="field">
          <label>发送回执校验</label>
          <div class="row"><label class="switch"><input type="checkbox" id="f-verify" ${r.verifySend !== false ? "checked" : ""}/><span class="track"></span></label>
          <span class="small muted">${r.verifySend !== false ? "点完发送会核对输入框是否已清空" : "不校验（更快，但失败不会告警）"}</span></div>
          <div class="hint">校验失败会自动重点一次；仍失败则记 send-error 并在概览页告警</div>
        </div>
        <div class="field">
          <label>多旧的消息不再回复 <span class="dim tiny">（睡眠/休眠醒来后的积压）</span></label>
          <div class="slider-row">
            <input type="range" class="range" id="f-stale" min="0" max="120" step="5" value="${Math.round((r.staleAfterMs || 0) / 60000)}" data-out="f-stale-v" />
            <span class="num" id="f-stale-v">${(r.staleAfterMs || 0) === 0 ? "不限" : Math.round((r.staleAfterMs || 0) / 60000) + " 分钟"}</span>
          </div>
          <div class="hint">超过这个时长的消息只归档、不回复，避免一睁眼刷屏</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd"><h3>发送时机</h3><span class="sub">别在你打字的时候把窗口抢走</span></div>
      <div class="panel-grid">
        <div class="field">
          <label>你空闲多久后 bot 才发</label>
          <div class="slider-row">
            <input type="range" class="range" id="f-idle" min="0" max="300" step="15" value="${Math.round((r.sendIdleMs || 0) / 1000)}" data-out="f-idle-v" />
            <span class="num" id="f-idle-v">${(r.sendIdleMs || 0) === 0 ? "立即发" : Math.round((r.sendIdleMs || 0) / 1000) + " 秒"}</span>
          </div>
          <div class="hint">UI 自动化必须抢前台才能打字。设 45 秒 = 你停手 45 秒它才发；设 0 = 收到就发（会打断你）</div>
        </div>
        <div class="field">
          <label>最长等多久就强行发</label>
          <div class="slider-row">
            <input type="range" class="range" id="f-maxwait" min="0" max="60" step="5" value="${Math.round((r.sendMaxWaitMs || 0) / 60000)}" data-out="f-maxwait-v" />
            <span class="num" id="f-maxwait-v">${(r.sendMaxWaitMs || 0) === 0 ? "不限" : Math.round((r.sendMaxWaitMs || 0) / 60000) + " 分钟"}</span>
          </div>
          <div class="hint">你一直在用电脑的话，超过这个时间也会发出去，并在概览页记一条 warning</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd"><h3>免打扰时段</h3><span class="sub">这段时间完全不回复</span></div>
      <div class="panel-grid">
        <div class="field">
          <label>启用</label>
          <div class="row"><label class="switch"><input type="checkbox" id="f-quiet" ${q.enabled ? "checked" : ""}/><span class="track"></span></label>
          <span class="small muted" id="f-quiet-label">${q.enabled ? "生效中" : "关闭"}</span></div>
        </div>
        <div class="field">
          <label>时间段</label>
          <div class="row">
            <input class="input" type="time" id="f-quiet-start" value="${q.start}" />
            <span class="muted">至</span>
            <input class="input" type="time" id="f-quiet-end" value="${q.end}" />
          </div>
          <div class="hint">支持跨零点，例如 23:30 至 08:00</div>
        </div>
      </div>
    </div>

    <div class="row" style="margin-top:16px">
      <button class="btn primary" id="f-save">保存全部设置</button>
      <span class="small dim">保存后立即生效，不用重启</span>
    </div>
  `;

  $$(".range", view).forEach((el) =>
    el.addEventListener("input", () => {
      const out = $("#" + el.dataset.out);
      const v = Number(el.value);
      if (el.id === "f-split") out.textContent = v === 1 ? "不拆" : v + " 条";
      else if (el.id === "f-cps") out.textContent = v + " 字/秒";
      else if (el.id === "f-maxpm") out.textContent = v + " 条";
      else if (el.id === "f-stale") out.textContent = v === 0 ? "不限" : v + " 分钟";
      else if (el.id === "f-idle") out.textContent = v === 0 ? "立即发" : v + " 秒";
      else if (el.id === "f-maxwait") out.textContent = v === 0 ? "不限" : v + " 分钟";
      else out.textContent = v + " ms";
    })
  );

  $("#f-quiet").addEventListener("change", (e) => {
    $("#f-quiet-label").textContent = e.target.checked ? "生效中" : "关闭";
  });

  $("#f-save").addEventListener("click", async () => {
    const body = {
      botName: $("#f-botname").value.trim(),
      receive: $("#f-receive").value,
      reply: {
        private: $("#f-private").checked,
        groups: $("#f-groups")
          .value.split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        minIntervalMs: Number($("#f-minint").value),
        maxPerMinute: Number($("#f-maxpm").value),
        readDelayMs: [Number($("#f-read-min").value), Number($("#f-read-max").value)],
        typingSpeedCps: Number($("#f-cps").value),
        maxTypingMs: Number($("#f-maxtype").value),
        splitSegments: Number($("#f-split").value),
        verifySend: $("#f-verify").checked,
        staleAfterMs: Number($("#f-stale").value) * 60000,
        sendIdleMs: Number($("#f-idle").value) * 1000,
        sendMaxWaitMs: Number($("#f-maxwait").value) * 60000,
        quietHours: {
          enabled: $("#f-quiet").checked,
          start: $("#f-quiet-start").value || "23:30",
          end: $("#f-quiet-end").value || "08:00"
        }
      }
    };
    try {
      await api("/config", { method: "PUT", body });
      toast("设置已保存并生效");
      await refreshState();
      paintPills();
    } catch (e) {
      toast(e.message, "err");
    }
  });
}

/* ---------------- 模型 ---------------- */
function modelOptions(providers, selected) {
  const opts = [`<option value="">跟随默认</option>`];
  for (const p of providers) {
    for (const m of p.models) {
      const ref = `${p.id}/${m}`;
      opts.push(`<option value="${esc(ref)}" ${ref === selected ? "selected" : ""}>${esc(p.name)} · ${esc(m)}</option>`);
    }
  }
  if (selected && !opts.some((o) => o.includes(`value="${esc(selected)}"`))) {
    opts.push(`<option value="${esc(selected)}" selected>${esc(selected)}（当前值，厂商已移除）</option>`);
  }
  return opts.join("");
}

function viewModels(view) {
  const c = S.state.config;
  const m = c.models;
  const providers = c.providers;
  const health = new Map(S.state.health.map((h) => [h.id, h]));

  const chain = m.fallbackChain || [];
  const allRefs = providers.flatMap((p) => p.models.map((x) => `${p.id}/${x}`));

  view.innerHTML = `
    <div class="card">
      <div class="card-hd"><h3>路由</h3><span class="sub">主模型 + 故障转移链</span>
        <div class="grow"></div><button class="btn sm primary" id="m-save">保存路由</button></div>
      <div class="panel-grid">
        <div class="field">
          <label>默认模型</label>
          <select class="select" id="m-default">${modelOptions(providers, m.default)}</select>
        </div>
        <div class="field">
          <label>私聊专用（可留空）</label>
          <select class="select" id="m-private">${modelOptions(providers, m.private)}</select>
        </div>
        <div class="field">
          <label>群聊专用（可留空）</label>
          <select class="select" id="m-group">${modelOptions(providers, m.group)}</select>
        </div>
        <div class="field">
          <label>温度</label>
          <div class="slider-row">
            <input type="range" class="range" id="m-temp" min="0" max="2" step="0.05" value="${m.temperature}" data-out="m-temp-v" />
            <span class="num" id="m-temp-v">${m.temperature}</span>
          </div>
          <div class="hint">越高越活泼，聊天建议 0.7-1.0</div>
        </div>
        <div class="field">
          <label>最大输出 tokens</label>
          <input class="input" type="number" id="m-maxtok" value="${m.maxTokens}" min="0" max="32000" step="64" />
          <div class="hint">0 = 不限制（部分厂商要求必填）</div>
        </div>
        <div class="field">
          <label>超时 / 重试</label>
          <div class="row">
            <input class="input" type="number" id="m-timeout" value="${m.timeoutMs}" min="3000" step="1000" />
            <span class="muted small">ms</span>
            <input class="input" type="number" id="m-retries" value="${m.retries}" min="0" max="5" />
            <span class="muted small">次</span>
          </div>
        </div>
        <div class="field">
          <label>故障转移</label>
          <div class="row"><label class="switch"><input type="checkbox" id="m-fallback" ${m.fallback ? "checked" : ""}/><span class="track"></span></label>
          <span class="small muted">主模型挂了自动换下一个</span></div>
        </div>
      </div>

      <div class="section-title">故障转移链（按顺序尝试）</div>
      <div class="chain" id="m-chain">
        ${
          chain.length
            ? chain
                .map(
                  (ref, i) => `<div class="chain-row" data-idx="${i}">
                    <span class="idx">${i + 1}</span>
                    <span class="mono">${esc(ref)}</span>
                    <button class="btn sm ghost" data-chain="up">↑</button>
                    <button class="btn sm ghost" data-chain="down">↓</button>
                    <button class="btn sm danger" data-chain="del">删除</button>
                  </div>`
                )
                .join("")
            : `<div class="tiny dim">还没有备用通道。建议至少加一个，主模型限流/超时时能顶上。</div>`
        }
      </div>
      <div class="row wrap" style="margin-top:10px">
        <select class="select" id="m-chain-add" style="max-width:320px">
          ${allRefs.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}
        </select>
        <button class="btn sm" id="m-chain-add-btn">加入链尾</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-hd"><h3>厂商</h3><span class="sub">除 Key 外全部预填，选一个填 Key 即可</span>
        <div class="grow"></div><button class="btn sm primary" id="p-add">添加厂商</button></div>
      <div class="provider-grid">
        ${
          providers.length
            ? providers
                .map((p) => {
                  const h = health.get(p.id);
                  const meta = S.presets.find((x) => x.id === p.id);
                  const short = (meta && meta.short) || p.name.slice(0, 2).toUpperCase();
                  const isDefault = (m.default || "").startsWith(p.id + "/");
                  const stateDot = !p.enabled ? "warn" : h ? (h.ok ? "ok" : "err") : p.hasKey || p.kind === "openai" && /127\.0\.0\.1/.test(p.baseURL) ? "ok" : "warn";
                  return `<div class="provider ${isDefault ? "default" : ""}" data-id="${esc(p.id)}">
                    <div class="p-hd">
                      <div class="avatar">${esc(short)}</div>
                      <div class="p-name"><b>${esc(p.name)}</b><span>${esc(p.baseURL || "未填 baseURL")}</span></div>
                      <label class="switch" title="启用/停用">
                        <input type="checkbox" data-p="enable" ${p.enabled ? "checked" : ""}/><span class="track"></span>
                      </label>
                    </div>
                    <div class="p-meta">
                      <span><span class="dot ${stateDot}" data-health="${esc(p.id)}"></span> ${p.hasKey ? "Key 已保存" : "未填 Key"}${p.apiKeyMasked ? " · " + esc(p.apiKeyMasked) : ""}</span>
                      <span>${p.models.length} 个模型</span>
                      <span>优先 ${p.priority}</span>
                      <span>${p.rpm ? p.rpm + " rpm" : "不限速"}</span>
                    </div>
                    <div class="p-key">
                      <input class="input" type="password" data-p="key" placeholder="${p.hasKey ? "已保存，留空不修改" : "填 API Key"}" />
                      <button class="btn sm" data-p="savekey">保存</button>
                    </div>
                    <div class="chips">
                      ${p.models
                        .slice(0, 8)
                        .map(
                          (mm) =>
                            `<span class="chip click ${isDefault && (m.default || "").endsWith("/" + mm) ? "active" : ""}" data-model="${esc(p.id)}/${esc(mm)}" title="点击设为默认模型">${esc(mm)}</span>`
                        )
                        .join("")}
                      ${p.models.length > 8 ? `<span class="chip">+${p.models.length - 8}</span>` : ""}
                    </div>
                    <div class="p-actions">
                      <button class="btn sm" data-p="test">测试</button>
                      <button class="btn sm ghost" data-p="fetch">拉取模型</button>
                      <button class="btn sm ghost" data-p="up" title="提高优先级">↑</button>
                      <button class="btn sm ghost" data-p="down" title="降低优先级">↓</button>
                      <button class="btn sm danger right" data-p="del">删除</button>
                    </div>
                    ${h && !h.ok && h.error ? `<div class="err tiny" style="color:var(--err);font-family:var(--mono)">${esc(h.error.slice(0, 90))}</div>` : ""}
                  </div>`;
                })
                .join("")
            : `<div class="empty" style="grid-column:1/-1">还没有任何厂商。点右上角「添加厂商」，从 20+ 个预置里挑一个，只填 Key。</div>`
        }
      </div>
    </div>
  `;

  const tempRange = $("#m-temp", view);
  tempRange.addEventListener("input", () => ($("#m-temp-v", view).textContent = Number(tempRange.value).toFixed(2)));

  let chainDraft = chain.slice();

  function paintChain() {
    $("#m-chain", view).innerHTML = chainDraft.length
      ? chainDraft
          .map(
            (ref, i) => `<div class="chain-row" data-idx="${i}">
              <span class="idx">${i + 1}</span><span class="mono">${esc(ref)}</span>
              <button class="btn sm ghost" data-chain="up">↑</button>
              <button class="btn sm ghost" data-chain="down">↓</button>
              <button class="btn sm danger" data-chain="del">删除</button>
            </div>`
          )
          .join("")
      : `<div class="tiny dim">还没有备用通道</div>`;
    bindChain();
  }

  function bindChain() {
    $$("[data-chain]", $("#m-chain", view)).forEach((b) =>
      b.addEventListener("click", () => {
        const row = b.closest(".chain-row");
        const i = Number(row.dataset.idx);
        const act = b.dataset.chain;
        if (act === "del") chainDraft.splice(i, 1);
        if (act === "up" && i > 0) [chainDraft[i - 1], chainDraft[i]] = [chainDraft[i], chainDraft[i - 1]];
        if (act === "down" && i < chainDraft.length - 1) [chainDraft[i + 1], chainDraft[i]] = [chainDraft[i], chainDraft[i + 1]];
        paintChain();
      })
    );
  }
  bindChain();

  $("#m-chain-add-btn", view).addEventListener("click", () => {
    const v = $("#m-chain-add", view).value;
    if (!v) return;
    if (chainDraft.includes(v)) return toast("已经在链里了", "err");
    chainDraft.push(v);
    paintChain();
  });

  $("#m-save", view).addEventListener("click", async () => {
    try {
      await api("/config", {
        method: "PUT",
        body: {
          models: {
            default: $("#m-default", view).value,
            private: $("#m-private", view).value,
            group: $("#m-group", view).value,
            temperature: Number($("#m-temp", view).value),
            maxTokens: Number($("#m-maxtok", view).value),
            timeoutMs: Number($("#m-timeout", view).value),
            retries: Number($("#m-retries", view).value),
            fallback: $("#m-fallback", view).checked,
            fallbackChain: chainDraft
          }
        }
      });
      toast("路由已保存");
      await refreshState();
      render();
    } catch (e) {
      toast(e.message, "err");
    }
  });

  $$("[data-model]", view).forEach((chip) =>
    chip.addEventListener("click", async () => {
      try {
        await api("/config", { method: "PUT", body: { models: { default: chip.dataset.model } } });
        toast("默认模型已切换为 " + chip.dataset.model);
        await refreshState();
        render();
      } catch (e) {
        toast(e.message, "err");
      }
    })
  );

  $$(".provider", view).forEach((card) => {
    const id = card.dataset.id;
    const p = providers.find((x) => x.id === id);

    card.querySelector('[data-p="enable"]').addEventListener("change", async (e) => {
      try {
        await api("/providers/" + id, { method: "PATCH", body: { enabled: e.target.checked } });
        toast(e.target.checked ? "已启用 " + p.name : "已停用 " + p.name);
        await refreshState();
        render();
      } catch (err) {
        toast(err.message, "err");
      }
    });

    card.querySelector('[data-p="savekey"]').addEventListener("click", async () => {
      const input = card.querySelector('[data-p="key"]');
      const val = input.value.trim();
      if (!val) return toast("请先填入 Key", "err");
      try {
        await api("/providers/" + id, { method: "PATCH", body: { apiKey: val } });
        input.value = "";
        toast("Key 已保存，建议点一次「测试」");
        await refreshState();
        render();
      } catch (err) {
        toast(err.message, "err");
      }
    });

    // 输入框里刚填、还没点保存的 Key：测试/拉模型之前先落盘。
    // 后端测试用的是"已保存的 provider"，不先存就会测到旧 Key，
    // 表现就是"我明明填了 Key，测试还是 401"。
    const flushKey = async () => {
      const input = card.querySelector('[data-p="key"]');
      const val = (input?.value || "").trim();
      if (!val || val.includes("••••")) return false;
      await api("/providers/" + id, { method: "PATCH", body: { apiKey: val } });
      input.value = "";
      await refreshState();
      return true;
    };

    card.querySelector('[data-p="test"]').addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>`;
      try {
        if (await flushKey()) toast("已先保存 Key，正在测试…");
        const r = await api("/providers/" + id + "/test", { method: "POST", body: {} });
        if (r.ok) toast(`${p.name} 通了 ${r.ms}ms：${r.text}`);
        else toast(`${p.name} 失败：${r.error}`, "err", 8000);
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = "测试";
        await refreshState();
        render();
      }
    });

    card.querySelector('[data-p="fetch"]').addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>`;
      try {
        if (await flushKey()) toast("已先保存 Key，正在拉取模型…");
        const r = await api("/providers/" + id + "/models?save=1");
        if (r.ok) toast(`拉到 ${r.count} 个模型`);
        else toast("拉取失败：" + r.error, "err", 8000);
        await refreshState();
        render();
      } catch (err) {
        toast(err.message, "err");
      }
    });

    const move = async (dir) => {
      const sorted = [...providers].sort((a, b) => a.priority - b.priority);
      const i = sorted.findIndex((x) => x.id === id);
      const j = dir === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= sorted.length) return;
      const a = sorted[i];
      const b = sorted[j];
      try {
        await api("/providers/" + a.id, { method: "PATCH", body: { priority: b.priority } });
        await api("/providers/" + b.id, { method: "PATCH", body: { priority: a.priority } });
        await refreshState();
        render();
      } catch (err) {
        toast(err.message, "err");
      }
    };
    card.querySelector('[data-p="up"]').addEventListener("click", () => move("up"));
    card.querySelector('[data-p="down"]').addEventListener("click", () => move("down"));

    card.querySelector('[data-p="del"]').addEventListener("click", async () => {
      if (!confirm(`删除厂商「${p.name}」？已保存的 Key 也会一起删除。`)) return;
      try {
        await api("/providers/" + id, { method: "DELETE" });
        toast("已删除");
        await refreshState();
        render();
      } catch (err) {
        toast(err.message, "err");
      }
    });
  });

  $("#p-add", view).addEventListener("click", openAddProvider);
}

async function openAddProvider() {
  const presets = S.presets;
  const regionName = { cn: "国内厂商", global: "海外厂商", local: "本地 / 自建" };
  const groups = ["cn", "global", "local"];
  const body = `
    ${groups
      .map((g) => {
        const list = presets.filter((p) => p.region === g);
        if (!list.length) return "";
        return `<div class="section-title">${regionName[g]}</div>
          <div class="preset-grid">
            ${list
              .map(
                (p) => `<button class="preset ${p.configured ? "done" : ""}" data-preset="${p.id}" ${p.configured ? "disabled" : ""}>
                  <div class="avatar">${esc(p.short)}</div>
                  <div class="preset-info"><b>${esc(p.name)}</b><span>${esc(p.baseURL)}</span></div>
                </button>`
              )
              .join("")}
          </div>`;
      })
      .join("")}
    <div class="section-title">自定义</div>
    <div class="field"><label>名称</label><input class="input" id="cp-name" placeholder="我的中转站" /></div>
    <div class="field"><label>Base URL</label><input class="input" id="cp-url" placeholder="https://api.example.com/v1" /></div>
    <div class="field"><label>协议</label>
      <select class="select" id="cp-kind">
        <option value="openai">OpenAI 兼容（最常见）</option>
        <option value="anthropic">Anthropic 原生</option>
        <option value="azure">Azure OpenAI</option>
      </select>
    </div>
    <div class="field"><label>模型名（逗号分隔）</label><input class="input" id="cp-models" placeholder="gpt-4o-mini, gpt-4o" /></div>
    <button class="btn primary" id="cp-add">添加自定义端点</button>
  `;
  openDrawer("添加厂商", body);

  $$("[data-preset]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await api("/providers", { method: "POST", body: { presetId: b.dataset.preset } });
        closeDrawer();
        toast("已添加，填入 API Key 即可使用");
        await refreshState();
        render();
        setTimeout(() => {
          const el = document.querySelector(`.provider[data-id="${r.provider.id}"] [data-p="key"]`);
          if (el) el.focus();
        }, 120);
      } catch (e) {
        toast(e.message, "err");
      }
    })
  );

  $("#cp-add").addEventListener("click", async () => {
    const name = $("#cp-name").value.trim();
    const baseURL = $("#cp-url").value.trim();
    if (!baseURL) return toast("Base URL 必填", "err");
    try {
      await api("/providers", {
        method: "POST",
        body: {
          name: name || "自定义端点",
          baseURL,
          kind: $("#cp-kind").value,
          models: $("#cp-models")
            .value.split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        }
      });
      closeDrawer();
      toast("已添加自定义端点");
      await refreshState();
      render();
    } catch (e) {
      toast(e.message, "err");
    }
  });
}

/* ---------------- 插件 ---------------- */
function viewPlugins(view) {
  const list = S.state.plugins;
  view.innerHTML = `
    <div class="card">
      <div class="card-hd"><h3>插件</h3><span class="sub">保存即热重载，不用重启进程</span>
        <div class="grow"></div>
        <button class="btn sm" id="pl-reload">全部重载</button>
        <button class="btn sm primary" id="pl-new">新建插件</button>
      </div>
      <div class="plugin-grid">
        ${
          list.length
            ? list
                .map(
                  (p) => `<div class="plugin ${p.enabled ? "" : "off"}" data-name="${esc(p.name)}">
                    <div class="plugin-hd">
                      <b>${esc(p.title)}</b>
                      <span class="mono">${esc(p.name)}</span>
                      <span class="badge ${p.enabled ? "out" : "skip"}">${p.enabled ? "启用" : "停用"}</span>
                      <label class="switch" style="margin-left:auto">
                        <input type="checkbox" data-pl="toggle" ${p.enabled ? "checked" : ""}/><span class="track"></span>
                      </label>
                    </div>
                    <p>${esc(p.description || "（没有填写描述）")}</p>
                    ${p.error ? `<div class="err">${esc(p.error.slice(0, 160))}</div>` : ""}
                    <div class="p-meta">
                      <span>v${esc(p.version)}</span>
                      <span>${p.hooks.length ? "钩子 " + p.hooks.join(" / ") : "无钩子"}</span>
                      ${p.failCount ? `<span style="color:var(--err)">报错 ${p.failCount} 次</span>` : ""}
                    </div>
                    <div class="p-actions">
                      <button class="btn sm" data-pl="edit">查看/编辑</button>
                      <button class="btn sm danger right" data-pl="del">删除</button>
                    </div>
                  </div>`
                )
                .join("")
            : `<div class="empty" style="grid-column:1/-1">plugins/ 目录里还没有插件</div>`
        }
        <div class="plugin" style="border-style:dashed;justify-content:center;align-items:center;min-height:170px;cursor:pointer" id="pl-new-card">
          <div class="avatar" style="width:42px;height:42px;font-size:18px">+</div>
          <p style="text-align:center;min-height:0">新建插件<br/><span class="tiny dim">从模板开始，几行代码就能改行为</span></p>
        </div>
      </div>
      <p class="tiny dim" style="margin:14px 0 0">
        插件可用的钩子：<span class="mono">onMessage / beforeReply / afterReply / afterSend / onStartup</span>。
        单个插件连续报错 5 次会自动停用，改好后点「全部重载」恢复。
      </p>
    </div>
  `;

  $("#pl-reload", view).addEventListener("click", async () => {
    try {
      await api("/plugins/reload", { method: "POST" });
      toast("已重载");
      await refreshState();
      render();
    } catch (e) {
      toast(e.message, "err");
    }
  });

  const newPlugin = () => openPluginEditor("", "");
  $("#pl-new", view).addEventListener("click", newPlugin);
  $("#pl-new-card").addEventListener("click", newPlugin);

  $$(".plugin[data-name]", view).forEach((card) => {
    const name = card.dataset.name;
    card.querySelector('[data-pl="toggle"]').addEventListener("change", async (e) => {
      try {
        await api(`/plugins/${name}/toggle`, { method: "POST", body: { enabled: e.target.checked } });
        toast(e.target.checked ? "已启用" : "已停用");
        await refreshState();
        render();
      } catch (err) {
        toast(err.message, "err");
      }
    });
    card.querySelector('[data-pl="edit"]').addEventListener("click", async () => {
      try {
        const r = await api(`/plugins/${name}/source`);
        openPluginEditor(name, r.content);
      } catch (e) {
        toast(e.message, "err");
      }
    });
    card.querySelector('[data-pl="del"]').addEventListener("click", async () => {
      if (!confirm(`删除插件 ${name}？文件会被移除。`)) return;
      try {
        await api(`/plugins/${name}`, { method: "DELETE" });
        toast("已删除");
        await refreshState();
        render();
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });
}

function openPluginEditor(name, content) {
  const isNew = !name;
  openDrawer(isNew ? "新建插件" : "编辑插件 · " + name, `
    ${isNew ? `<div class="field"><label>插件名（文件名）</label><input class="input" id="pe-name" placeholder="my-plugin" /></div>` : ""}
    <div class="field">
      <label>源码</label>
      <textarea class="input" id="pe-src" style="min-height:60vh;font-size:12.5px">${esc(content || "")}</textarea>
      <div class="hint">保存后立即加载；语法错误会显示在插件卡片上，不会影响其他插件。</div>
    </div>
    <div class="row">
      <button class="btn primary" id="pe-save">保存</button>
      <button class="btn ghost" id="pe-template">插入模板</button>
    </div>
  `);
  $("#pe-template").addEventListener("click", async () => {
    const r = await api("/plugins/template");
    $("#pe-src").value = r.template;
  });
  $("#pe-save").addEventListener("click", async () => {
    const nm = isNew ? $("#pe-name").value.trim() : name;
    if (!nm) return toast("先填插件名", "err");
    try {
      await api(`/plugins/${nm}/source`, { method: "PUT", body: { content: $("#pe-src").value } });
      toast("已保存并加载");
      closeDrawer();
      await refreshState();
      render();
    } catch (e) {
      toast(e.message, "err");
    }
  });
}

/* ---------------- 日志 ---------------- */
function viewLogs(view) {
  const filters = [
    ["all", "全部"],
    ["in", "收到"],
    ["out", "回复"],
    ["llm-error", "模型错误"],
    ["send-error", "发送错误"],
    ["skip-rate", "限流"]
  ];
  view.innerHTML = `
    <div class="card" style="padding:14px 16px">
      <div class="log-toolbar">
        <div class="chips">
          ${filters.map(([k, l]) => `<span class="chip click ${S.logFilter === k ? "active" : ""}" data-filter="${k}">${l}</span>`).join("")}
        </div>
        <input class="input" id="log-search" placeholder="搜索内容…" value="${esc(S.logSearch)}" style="max-width:220px" />
        <div class="grow"></div>
        <button class="btn sm ghost" id="log-pause">${S.logPaused ? "继续" : "暂停"}</button>
        <button class="btn sm ghost" id="log-clear">清空</button>
      </div>
      <div class="log-list" id="log-list"></div>
    </div>
  `;

  const paint = () => {
    const list = $("#log-list");
    if (!list) return;
    const rows = S.logs
      .map(logLine)
      .filter((l) => S.logFilter === "all" || l.dir === S.logFilter || (S.logFilter === "llm-error" && l.dir === "err"))
      .filter((l) => !S.logSearch || l.text.toLowerCase().includes(S.logSearch.toLowerCase()));
    list.innerHTML = rows.length
      ? rows
          .map(
            (l) => `<div class="log-line ${l.dir}"><span class="log-time">${clock(l.t)}</span><span class="badge ${l.dir}">${esc(l.label || "")}</span><span class="log-text">${esc(l.text)}</span></div>`
          )
          .join("")
      : `<div class="empty">没有匹配的日志</div>`;
    if (!S.logPaused) list.scrollTop = list.scrollHeight;
  };
  S.paintLogs = paint;
  paint();

  $$("[data-filter]", view).forEach((c) =>
    c.addEventListener("click", () => {
      S.logFilter = c.dataset.filter;
      viewLogs($("#view"));
    })
  );
  $("#log-search", view).addEventListener("input", (e) => {
    S.logSearch = e.target.value;
    paint();
  });
  $("#log-pause", view).addEventListener("click", () => {
    S.logPaused = !S.logPaused;
    $("#log-pause").textContent = S.logPaused ? "继续" : "暂停";
    if (!S.logPaused) paint();
  });
  $("#log-clear", view).addEventListener("click", async () => {
    if (!confirm("清空日志文件？")) return;
    try {
      await api("/logs", { method: "DELETE" });
      S.logs = [];
      paint();
      toast("已清空");
    } catch (e) {
      toast(e.message, "err");
    }
  });
}

/* ---------------- 会话 ---------------- */
async function viewSessions(view) {
  view.innerHTML = `<div class="empty"><span class="spinner"></span> 读取会话…</div>`;
  try {
    const r = await api("/sessions");
    S.sessions = r.sessions;
  } catch (e) {
    view.innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
    return;
  }
  view.innerHTML = `
    <div class="card">
      <div class="card-hd"><h3>会话记忆</h3><span class="sub">每个会话保留最近 40 条</span>
        <div class="grow"></div><button class="btn sm ghost" id="s-refresh">刷新</button></div>
      ${
        S.sessions.length
          ? `<div class="session-list">${S.sessions
              .map(
                (s) => `<div class="session-row" data-key="${esc(s.key)}">
                  <span class="k">${esc(s.key)}</span>
                  <span class="prev">${esc(s.preview || "（空）")}</span>
                  <span class="tiny dim">${s.count} 条</span>
                  <span class="tiny dim">${dateTime(s.updated)}</span>
                  <button class="btn sm danger" data-del="${esc(s.key)}">删除</button>
                </div>`
              )
              .join("")}</div>`
          : `<div class="empty">还没有会话记录。收到一条消息并回复后就会出现。</div>`
      }
    </div>
  `;
  $("#s-refresh", view).addEventListener("click", () => viewSessions($("#view")));
  $$("[data-key]", view).forEach((row) => {
    row.addEventListener("click", async (e) => {
      if (e.target.dataset.del) return;
      try {
        const r = await api("/sessions/" + encodeURIComponent(row.dataset.key));
        openDrawer("会话 " + row.dataset.key, `<div class="chat-view">${r.items
          .map((m) => `<div class="msg ${esc(m.role)}">${esc(m.content)}</div>`)
          .join("")}</div>`);
      } catch (err) {
        toast(err.message, "err");
      }
    });
  });
  $$("[data-del]", view).forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("删除这个会话的记忆？")) return;
      try {
        await api("/sessions/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
        toast("已删除");
        viewSessions($("#view"));
      } catch (err) {
        toast(err.message, "err");
      }
    })
  );
}

/* ---------------- 测试对话 ---------------- */
function openTestChat() {
  const c = S.state.config;
  const opts = c.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
  openDrawer("测试对话", `
    <div class="field">
      <label>使用的模型</label>
      <select class="select" id="tc-model">
        <option value="">跟随默认（${esc(c.models.default || "未配置")}）</option>
        ${opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}
      </select>
    </div>
    <div class="chat-view" id="tc-log" style="min-height:200px;max-height:50vh;overflow:auto;background:var(--panel-2);border:1px solid var(--line);border-radius:12px;padding:14px">
      <div class="msg system">这是一次性测试，不写入会话记忆、不影响 bot。</div>
    </div>
    <div class="row" style="margin-top:12px">
      <input class="input" id="tc-input" placeholder="输入一句话，回车发送" />
      <button class="btn primary" id="tc-send">发送</button>
    </div>
  `);
  const send = async () => {
    const input = $("#tc-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const log = $("#tc-log");
    log.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(text)}</div>`);
    log.scrollTop = log.scrollHeight;
    const pending = document.createElement("div");
    pending.className = "msg assistant";
    pending.innerHTML = `<span class="spinner"></span>`;
    log.appendChild(pending);
    log.scrollTop = log.scrollHeight;
    try {
      const r = await api("/chat-test", { method: "POST", body: { text, model: $("#tc-model").value || undefined } });
      if (r.ok) {
        pending.innerHTML = esc(r.text) + `<div class="tiny dim" style="margin-top:6px">${esc(r.providerId)}/${esc(r.model)} · ${r.ms}ms</div>`;
      } else {
        pending.className = "msg assistant";
        pending.innerHTML = `<span style="color:var(--err)">${esc(r.error)}</span>`;
      }
    } catch (e) {
      pending.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`;
    }
    log.scrollTop = log.scrollHeight;
  };
  $("#tc-send").addEventListener("click", send);
  $("#tc-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
  setTimeout(() => $("#tc-input")?.focus(), 200);
}

/* ---------------- 抽屉 ---------------- */
function openDrawer(title, html) {
  $("#drawer-title").textContent = title;
  $("#drawer-body").innerHTML = html;
  $("#drawer").classList.add("show");
  $("#mask").classList.add("show");
}
function closeDrawer() {
  $("#drawer").classList.remove("show");
  $("#mask").classList.remove("show");
}

/* ---------------- 数据同步 ---------------- */
async function refreshState() {
  try {
    S.state = await api("/state");
    paintPills();
    if (S.route === "overview") {
      const view = $("#view");
      const scroll = view.scrollTop;
      viewOverview(view);
      view.scrollTop = scroll;
    }
  } catch (e) {
    console.error(e);
  }
}

async function boot() {
  try {
    const [state, presets] = await Promise.all([api("/state"), api("/presets")]);
    S.state = state;
    S.presets = presets;
    paintPills();
    const route = (location.hash || "").replace(/^#\/?/, "") || "overview";
    S.route = ROUTES[route] ? route : "overview";
    render();
    if (!new URLSearchParams(location.search).has("nosse")) connectStream();
  } catch (e) {
    $("#view").innerHTML = `<div class="card"><h3>连不上控制台</h3>
      <p class="muted">${esc(e.message)}</p>
      <p class="small dim">确认 bot 在运行：<span class="mono">npm run bot</span>，然后访问 <span class="mono">http://127.0.0.1:8787</span></p></div>`;
  }
}

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "state") {
      const prev = S.state?.bot?.counters;
      S.state = msg.state;
      paintPills();
      if (S.route === "overview") {
        const view = $("#view");
        const scroll = view.scrollTop;
        viewOverview(view);
        view.scrollTop = scroll;
      }
      // 模型页的健康点局部刷新
      if (S.route === "models") {
        for (const h of msg.state.health) {
          const dot = document.querySelector(`[data-health="${h.id}"]`);
          if (dot) dot.className = `dot ${h.ok ? "ok" : "err"}`;
        }
      }
      if (prev && S.route === "overview" && prev.in !== S.state.bot.counters.in) {
        // 有新消息，概览已重绘
      }
    } else if (msg.type === "log") {
      const lines = msg.chunk.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          S.logs.push(JSON.parse(line));
        } catch {
          S.logs.push({ raw: line });
        }
      }
      S.logs = S.logs.slice(-800);
      if (S.route === "logs" && S.paintLogs) S.paintLogs();
    }
  };
  es.onerror = () => {
    $("#rail-text").textContent = "重连中…";
    $("#rail-dot").className = "dot warn pulse";
  };
}

/* ---------------- 事件绑定 ---------------- */
$("#nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (btn) go(btn.dataset.route);
});
$("#mask").addEventListener("click", closeDrawer);
$("#drawer-close").addEventListener("click", closeDrawer);
$("#btn-test").addEventListener("click", openTestChat);
$("#btn-theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || localStorage.getItem("theme") || "dark";
window.addEventListener("hashchange", () => {
  const route = (location.hash || "").replace(/^#\/?/, "") || "overview";
  if (ROUTES[route] && route !== S.route) {
    S.route = route;
    render();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

boot();
setInterval(() => {
  // SSE 万一断了，兜底轮询
  if (!$("#rail-text") || $("#rail-text").textContent.includes("重连")) refreshState();
}, 8000);
