/**
 * dsh-float-panel — host half.
 *
 * The floating window itself is a tiny AppKit app (native/main.swift,
 * built by native/build.sh) because an Electron renderer cannot create an
 * always-on-top window. That window has no access to DSH state, so this module
 * is the single source of truth: it folds every session's committed event log
 * into one small snapshot of "what is this task doing right now", exposes it
 * over loopback, and relays the two things only the page can do — settling an
 * approval/question and switching to a conversation.
 *
 * Routes (all exact, on the host web server; no new port):
 *   GET  /float-panel/panel?t=<token>   the panel page
 *   GET  /float-panel/state?t=<token>   snapshot (the panel polls this)
 *   POST /float-panel/action?t=<token>  approval / question answer / open
 *   GET  /float-panel/events            SSE feed for the page half (state + commands)
 *   POST /float-panel/current           page tells the host which session is on screen
 *   POST /float-panel/panel/open        start the floating window
 *   POST /float-panel/panel/close       stop it
 *
 * The token is a capability for the panel routes only. `/events` and the
 * panel open/close routes are reachable from the DSH page itself (same origin
 * in the desktop shell), so they are guarded by a loopback Host check instead.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PREFIX = "/float-panel";
const PANEL_FILE = join(ROOT, "panel.html");
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
// One package ships one shell per platform. The host picks the one this system
// can actually run, so a single install serves macOS and Windows; anywhere else
// the routes still work and the page reports the platform as unsupported.
const APP_PATH = join(ROOT, "native", "DSH Float Panel.app");
const WINDOWS_SHELL = join(ROOT, "native", "windows", "DSHFloatPanel.exe");
const BIN_PATH = IS_MAC
  ? join(APP_PATH, "Contents", "MacOS", "dsh-float-panel")
  : IS_WIN
    ? WINDOWS_SHELL
    : "";
// Only the token, the shell pid and the window anchor live here.
const STATE_DIR = IS_MAC
  ? join(homedir(), "Library", "Application Support", "dsh-float-panel")
  : IS_WIN
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "dsh-float-panel")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "dsh-float-panel");
const TOKEN_FILE = join(STATE_DIR, "token");
const PID_FILE = join(STATE_DIR, "panel.pid");
const DONE_TTL_MS = 30 * 60 * 1000;
const DONE_GRACE_MS = 800;
const MAX_ROWS = 6;
const MAX_QUEUE = 20;
const CMD_REPLAY_MS = 20_000;

const TOOL_LABELS = {
  bash: "Bash",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  glob: "查找文件",
  grep: "搜索内容",
  todo_write: "更新任务列表",
  ask_user_question: "询问你",
  run_code: "运行代码",
  web_search: "搜索网页",
  web_fetch: "抓取网页",
  skill: "加载技能",
  subagent: "启动子任务",
  subagent_fork: "启动子任务",
  workflow: "运行工作流",
  present: "整理交付物",
  job_output: "查看后台任务",
  job_kill: "停止后台任务",
  job_list: "查看后台任务",
};

function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out.trim();
}

function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function parseArgs(raw) {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? raw : null;
}

function toolSummary(name, args) {
  const a = args || {};
  switch (name) {
    case "bash":
      return clip(a.command, 72);
    case "read":
    case "write":
    case "edit":
      return clip(a.file_path, 72);
    case "glob":
      return clip(a.pattern, 72);
    case "grep":
      return clip(a.pattern, 72);
    case "web_search":
      return clip(Array.isArray(a.queries) ? a.queries[0] : a.query, 72);
    case "web_fetch":
      return clip(a.url, 72);
    case "skill":
      return clip(a.name, 72);
    case "subagent":
    case "subagent_fork":
      return clip(a.description, 72);
    case "todo_write":
      return "更新任务列表";
    case "ask_user_question":
      return "等待你的回答";
    default:
      return "";
  }
}

/** Questions in the exact shape the panel can render inline (or fall back to "打开"). */
function parseQuestions(args) {
  const a = parseArgs(args);
  if (!a || !Array.isArray(a.questions) || a.questions.length === 0) return null;
  return a.questions.slice(0, 3).map((q) => {
    if (!q || typeof q !== "object") return null;
    const options = Array.isArray(q.options)
      ? q.options
          .filter((o) => o && typeof o.label === "string")
          .slice(0, 6)
          .map((o) => ({ label: o.label, description: clip(o.description, 100) }))
      : [];
    const multiSelect = q.multi_select === true || q.multiSelect === true;
    const intent = q.intent && typeof q.intent === "object" ? q.intent : null;
    const plan = intent?.kind === "plan-review";
    return {
      id: typeof q.id === "string" ? q.id : "",
      question: clip(q.question, 240),
      header: clip(q.header, 40),
      multiSelect,
      plan,
      options,
      approve: typeof intent?.approve === "string" ? intent.approve : "",
      // Inline buttons need one question, a known single answer, and a short list.
      inline: !multiSelect && options.length > 0 && options.length <= 5,
    };
  }).filter(Boolean);
}

function foldTodos(todos) {
  if (!Array.isArray(todos)) return null;
  const total = todos.length;
  let done = 0;
  let current = "";
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    if (t.status === "completed") done += 1;
    else if (t.status === "in_progress" && !current) current = clip(t.content, 60);
  }
  if (total === 0) return null;
  return { done, total, current };
}

export function apply(ctx, config) {
  const autoOpen = config?.autoOpen !== false;
  // An explicit token is only for local debugging (and tests); normally it is
  // generated once and reused across restarts.
  const token = (process.env.DSH_FLOAT_PANEL_TOKEN || '').trim() || loadToken();
  const sessions = new Map();
  const clients = new Set();
  const queue = [];
  let currentSessionId = null;
  let panel = null;
  let autoOpenFailed = false;
  let webRef = null;
  let publishTimer = null;

  const port = () => {
    try {
      return webRef?.webServer?.port ?? 0;
    } catch {
      return 0;
    }
  };

  // ───────────────────────── state folding ─────────────────────────

  function ensure(session) {
    let rec = sessions.get(session.id);
    if (rec) return rec;
    rec = {
      id: session.id,
      title: "",
      titleLocked: false,
      running: false,
      phase: "thinking",
      turn: 0,
      step: 0,
      turnStartedAt: 0,
      doneAt: 0,
      doneTimer: null,
      pending: null,
      pendingSince: 0,
      progress: null,
      preview: "",
      lastUser: "",
      activeTool: null,
      toolCalls: new Map(),
    };
    sessions.set(session.id, rec);
    return rec;
  }

  function touch(rec, eventTime) {
    rec.updatedAt = typeof eventTime === "number" ? eventTime : Date.now();
  }

  function clearDone(rec) {
    if (rec.doneTimer) {
      clearTimeout(rec.doneTimer);
      rec.doneTimer = null;
    }
    rec.doneAt = 0;
  }

  /**
   * Any live activity means the turn is running, even when the turn/start that
   * would have said so happened before this process started watching (plugin
   * reload, app restart mid-turn). turn/end still clears it.
   */
  function markRunning(rec, time) {
    if (!rec.running) {
      rec.running = true;
      if (!rec.turnStartedAt) rec.turnStartedAt = typeof time === "number" ? time : Date.now();
    }
    if (rec.doneAt || rec.doneTimer) clearDone(rec);
  }

  function onSessionEvent(session, event) {
    if (!session || !event) return;
    const header = session.header;
    // Subagent children are steps of the parent's turn, not separate tasks.
    if (header && (header.origin === "subagent" || header.parentSession !== undefined)) return;
    const data = event.data;
    const rec = ensure(session);
    touch(rec, event.time);
    switch (event.type) {
      case "session/title":
        if (data && typeof data.title === "string" && data.title.trim()) {
          rec.title = data.title.trim();
          rec.titleLocked = true;
        }
        break;
      case "user/message": {
        if (data && data.source && data.source.kind && data.source.kind !== "user") break;
        const text = textOfContent(data?.content);
        if (text) {
          rec.lastUser = clip(text, 160);
          if (!rec.titleLocked) rec.title = clip(text, 40);
        }
        markRunning(rec, event.time);
        rec.phase = "thinking";
        break;
      }
      case "turn/start":
        clearDone(rec);
        rec.running = true;
        rec.phase = "thinking";
        rec.turn = typeof data?.turn === "number" ? data.turn : rec.turn;
        rec.step = 0;
        rec.turnStartedAt = typeof event.time === "number" ? event.time : Date.now();
        rec.progress = null;
        rec.activeTool = null;
        rec.pending = null;
        rec.pendingSince = 0;
        maybeAutoOpen();
        break;
      case "step/start":
        markRunning(rec, event.time);
        rec.step = typeof data?.step === "number" ? data.step : rec.step;
        // A pending question or approval can only live inside the step that
        // asked for it; a newer step means it was answered without a matching
        // tool/result reaching us.
        if (rec.pending && typeof rec.pending.step === "number" && rec.pending.step < rec.step) {
          rec.pending = null;
          rec.pendingSince = 0;
        }
        if (!rec.activeTool) rec.phase = "thinking";
        break;
      case "tool/call": {
        const name = typeof data?.name === "string" ? data.name : "";
        const callId = typeof data?.callId === "string" ? data.callId : "";
        const args = parseArgs(data?.arguments);
        markRunning(rec, event.time);
        rec.phase = "tool";
        rec.turn = typeof data?.turn === "number" ? data.turn : rec.turn;
        rec.step = typeof data?.step === "number" ? data.step : rec.step;
        rec.activeTool = { callId, name, summary: toolSummary(name, args) };
        if (callId) {
          rec.toolCalls.set(callId, { name, summary: toolSummary(name, args) });
          if (rec.toolCalls.size > 80) {
            const first = rec.toolCalls.keys().next().value;
            rec.toolCalls.delete(first);
          }
        }
        if (name === "ask_user_question") {
          const questions = parseQuestions(data?.arguments);
          if (questions) {
            rec.pending = {
              kind: "question",
              callId,
              questions,
              turn: typeof data?.turn === "number" ? data.turn : rec.turn,
              step: typeof data?.step === "number" ? data.step : rec.step,
            };
            rec.pendingSince = typeof event.time === "number" ? event.time : Date.now();
          }
        }
        if (name === "todo_write") {
          const todos = parseArgs(data?.arguments)?.todos;
          const progress = foldTodos(todos);
          if (progress) rec.progress = progress;
        }
        break;
      }
      case "tool/result": {
        // The harness puts the id on `toolCallId` (and mirrors it on
        // `source.callId`); `message.callId` never exists, so read it last.
        const message = data?.message;
        const callId =
          typeof message?.toolCallId === "string" && message.toolCallId
            ? message.toolCallId
            : typeof message?.callId === "string" && message.callId
              ? message.callId
              : typeof message?.source?.callId === "string"
                ? message.source.callId
                : "";
        if (callId && rec.activeTool?.callId === callId) rec.activeTool = null;
        if (callId && rec.pending?.callId === callId) {
          rec.pending = null;
          rec.pendingSince = 0;
        }
        if (!rec.activeTool) rec.phase = rec.running ? "analyzing" : rec.phase;
        break;
      }
      case "assistant/message": {
        const message = data?.message;
        const text = textOfContent(message?.content);
        if (text) rec.preview = clip(text, 220);
        markRunning(rec, event.time);
        rec.activeTool = null;
        rec.phase = "replying";
        break;
      }
      case "todo/write": {
        const progress = foldTodos(data?.todos);
        if (progress) rec.progress = progress;
        break;
      }
      case "approval/asked": {
        if (!data || typeof data !== "object") break;
        const callId = typeof data.callId === "string" ? data.callId : "";
        const known = callId ? rec.toolCalls.get(callId) : null;
        markRunning(rec, event.time);
        rec.pending = {
          kind: "approval",
          id: typeof data.id === "string" ? data.id : "",
          callId,
          toolName: typeof data.toolName === "string" ? data.toolName : "",
          toolLabel: TOOL_LABELS[data.toolName] ?? (typeof data.toolName === "string" ? data.toolName : ""),
          reason: clip(data.reason, 300),
          detail: known ? { tool: TOOL_LABELS[known.name] ?? known.name, summary: known.summary } : null,
          turn: typeof data.turn === "number" ? data.turn : rec.turn,
          step: typeof data.step === "number" ? data.step : rec.step,
        };
        rec.pendingSince = typeof event.time === "number" ? event.time : Date.now();
        break;
      }
      case "approval/decided":
        if (rec.pending?.kind === "approval") {
          rec.pending = null;
          rec.pendingSince = 0;
        }
        break;
      case "turn/end":
        rec.running = false;
        rec.activeTool = null;
        rec.phase = "done";
        clearDone(rec);
        rec.doneTimer = setTimeout(() => {
          rec.doneTimer = null;
          rec.doneAt = Date.now();
          publish();
        }, DONE_GRACE_MS);
        break;
      default:
        return;
    }
    publish();
  }

  const offEvent = ctx.on("session/event", onSessionEvent);
  const offDisposed = ctx.on("session/disposed", (session) => {
    if (!session) return;
    const rec = sessions.get(session.id);
    if (rec?.doneTimer) clearTimeout(rec.doneTimer);
    sessions.delete(session.id);
    publish();
  });

  // ───────────────────────── snapshot ─────────────────────────

  function statusOf(rec) {
    if (rec.pending) return rec.pending.kind;
    if (rec.running) return "running";
    if (rec.doneAt || rec.doneTimer) return "done";
    return "idle";
  }

  function activityOf(rec) {
    if (!rec.running || rec.pending) return null;
    if (rec.activeTool) {
      const label = TOOL_LABELS[rec.activeTool.name] ?? rec.activeTool.name;
      return { kind: "tool", tool: label, summary: rec.activeTool.summary };
    }
    if (rec.phase === "replying") return { kind: "replying" };
    if (rec.phase === "analyzing") return { kind: "analyzing" };
    return { kind: "thinking" };
  }

  function pendingOf(rec) {
    if (!rec.pending) return null;
    if (rec.pending.kind === "approval") {
      const p = rec.pending;
      return {
        kind: "approval",
        toolName: p.toolName,
        toolLabel: p.toolLabel,
        reason: p.reason,
        detail: p.detail,
      };
    }
    return { kind: "question", questions: rec.pending.questions };
  }

  function snapshot() {
    const now = Date.now();
    const rows = [];
    for (const rec of sessions.values()) {
      const status = statusOf(rec);
      if (status === "idle") continue;
      if (status === "done" && now - rec.doneAt > DONE_TTL_MS) continue;
      rows.push({
        id: rec.id,
        title: rec.title || "未命名任务",
        status,
        since: status === "running" ? rec.turnStartedAt : status === "done" ? rec.doneAt : rec.pendingSince,
        doneAt: rec.doneAt || 0,
        turn: rec.turn,
        step: rec.step,
        activity: activityOf(rec),
        progress: rec.progress,
        preview: rec.preview,
        pending: pendingOf(rec),
        current: rec.id === currentSessionId,
      });
    }
    const weight = (row) => (row.status === "approval" ? 0 : row.status === "question" ? 1 : row.status === "running" ? 2 : 3);
    rows.sort((a, b) => weight(a) - weight(b) || (a.since || 0) - (b.since || 0));
    return {
      ok: true,
      serverTime: now,
      panelRunning: panel !== null,
      current: currentSessionId,
      // How many pages are attached to the event feed. The panel itself is one,
      // so a closed panel plus a non-zero count means the DSH page is live.
      sse: clients.size,
      sessions: rows.slice(0, MAX_ROWS),
      total: rows.length,
    };
  }

  function publish() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      const state = snapshot();
      for (const res of clients) send(res, "state", state);
    }, 120);
  }

  function broadcast(event, data) {
    for (const res of clients) send(res, event, data);
  }

  function send(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  function enqueue(cmd) {
    const item = { ...cmd, cmdId: randomBytes(6).toString("hex"), at: Date.now() };
    queue.push(item);
    while (queue.length > MAX_QUEUE) queue.shift();
    broadcast("cmd", item);
    return item;
  }

  // ───────────────────────── panel process ─────────────────────────

  function stopPanel() {
    const proc = panel;
    panel = null;
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    try {
      if (existsSync(PID_FILE)) writeFileSync(PID_FILE, "");
    } catch {
      // best effort
    }
    return proc !== null;
  }

  function startPanel() {
    if (panel) return { ok: true, running: true };
    if (!BIN_PATH) return { ok: false, reason: "unsupported-platform" };
    if (!existsSync(BIN_PATH)) return { ok: false, reason: "binary-missing" };
    const listenPort = port();
    if (!listenPort) return { ok: false, reason: "server-not-ready" };
    try {
      mkdirSync(STATE_DIR, { recursive: true });
    } catch {
      // the app will fall back to its own default location
    }
    const url = `http://127.0.0.1:${listenPort}${PREFIX}/panel?t=${token}`;
    let proc;
    try {
      proc = spawn(BIN_PATH, [url, STATE_DIR], { stdio: "ignore", windowsHide: true });
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-float-panel] cannot start the floating window: ${String(error)}`);
      return { ok: false, reason: "spawn-failed" };
    }
    panel = proc;
    proc.on("exit", (code) => {
      if (panel !== proc) return;
      panel = null;
      // The Windows shell exits with 2 when it cannot start the page, which in
      // practice means the WebView2 runtime is missing; the page shows a hint.
      if (code === 2) {
        ctx.logger?.warn?.("[dsh-float-panel] WebView2 runtime is missing");
        broadcast("panel", { running: false, reason: "webview2-missing" });
      } else {
        broadcast("panel", { running: false });
      }
      publish();
    });
    proc.on("error", () => {
      if (panel !== proc) return;
      panel = null;
      broadcast("panel", { running: false });
    });
    try {
      writeFileSync(PID_FILE, String(proc.pid));
    } catch {
      // pid file is only a convenience
    }
    broadcast("panel", { running: true });
    return { ok: true, running: true };
  }

  function maybeAutoOpen() {
    if (!autoOpen || panel || autoOpenFailed) return;
    if (!BIN_PATH) return;
    const result = startPanel();
    if (!result.ok) autoOpenFailed = true;
  }

  killStalePanel();

  // ───────────────────────── HTTP ─────────────────────────

  function originAllowed(origin) {
    if (!origin) return true;
    if (origin === "dsh-app://app" || origin === "null") return true;
    const listenPort = port();
    return (
      origin === `http://127.0.0.1:${listenPort}` ||
      origin === `http://localhost:${listenPort}` ||
      origin === `http://[::1]:${listenPort}`
    );
  }

  function loopbackHost(req) {
    const host = String(req.headers.host || "");
    const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
    return name === "127.0.0.1" || name === "localhost" || name === "::1";
  }

  function setCors(req, res) {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    if (req.headers["access-control-request-private-network"]) {
      res.setHeader("access-control-allow-private-network", "true");
    }
  }

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req, limit = 32 * 1024) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let done = false;
      const settle = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          chunks.length = 0;
          settle({ ok: false, reason: "too-large" });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => settle({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
      req.on("error", () => settle({ ok: false, reason: "read-error" }));
      req.on("close", () => settle({ ok: false, reason: "read-error" }));
    });
  }

  function tokenOk(url) {
    const supplied = url.searchParams.get("t") || "";
    return supplied.length === token.length && supplied === token;
  }

  function servePanel(req, res, url) {
    if (!tokenOk(url)) {
      json(res, 403, { ok: false, reason: "bad-token" });
      return;
    }
    let html;
    try {
      html = readFileSync(PANEL_FILE, "utf8");
    } catch {
      json(res, 500, { ok: false, reason: "panel-page-missing" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  }

  async function handleAction(req, res, url) {
    if (!tokenOk(url)) {
      json(res, 403, { ok: false, reason: "bad-token" });
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      json(res, 400, { ok: false, reason: body.reason });
      return;
    }
    let payload;
    try {
      payload = body.text.trim() ? JSON.parse(body.text) : {};
    } catch {
      json(res, 400, { ok: false, reason: "invalid-json" });
      return;
    }
    const type = payload?.type;
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const rec = sessionId ? sessions.get(sessionId) : null;
    if (!rec) {
      json(res, 404, { ok: false, reason: "unknown-session" });
      return;
    }
    if (type === "approval") {
      const outcome = payload.outcome === "rejected" ? "rejected" : "allowed-once";
      if (rec.pending?.kind !== "approval") {
        json(res, 409, { ok: false, reason: "not-waiting-approval" });
        return;
      }
      const item = enqueue({ type: "approval", sessionId, outcome });
      json(res, 200, { ok: true, cmdId: item.cmdId });
      return;
    }
    if (type === "answer") {
      const questionId = typeof payload?.questionId === "string" ? payload.questionId : "";
      const label = typeof payload?.label === "string" ? payload.label : "";
      const question = rec.pending?.kind === "question" ? rec.pending.questions.find((q) => q.id === questionId) : null;
      if (!question) {
        json(res, 409, { ok: false, reason: "not-waiting-question" });
        return;
      }
      if (!question.options.some((o) => o.label === label)) {
        json(res, 400, { ok: false, reason: "unknown-option" });
        return;
      }
      const item = enqueue({ type: "answer", sessionId, questionId, label });
      json(res, 200, { ok: true, cmdId: item.cmdId });
      return;
    }
    if (type === "open") {
      clearDone(rec);
      enqueue({ type: "open", sessionId });
      publish();
      json(res, 200, { ok: true });
      return;
    }
    json(res, 400, { ok: false, reason: "unknown-action" });
  }

  async function handleCurrent(req, res) {
    const body = await readBody(req, 8 * 1024);
    let payload = null;
    if (body.ok && body.text.trim()) {
      try {
        payload = JSON.parse(body.text);
      } catch {
        payload = null;
      }
    }
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;
    if (sessionId !== null && sessionId !== currentSessionId) {
      currentSessionId = sessionId;
      publish();
    }
    json(res, 200, { ok: true });
  }

  function serveEvents(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    clients.add(res);
    send(res, "hello", { running: panel !== null, serverTime: Date.now() });
    send(res, "state", snapshot());
    const cutoff = Date.now() - CMD_REPLAY_MS;
    for (const cmd of queue) if (cmd.at >= cutoff) send(res, "cmd", cmd);
    const heartbeat = setInterval(() => {
      try {
        res.write(": hb\n\n");
      } catch {
        // dropped below
      }
    }, 15_000);
    const drop = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on("close", drop);
    req.on("error", drop);
  }

  async function dispatch(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    if (!loopbackHost(req)) {
      json(res, 403, { ok: false, reason: "untrusted-host" });
      return;
    }
    if (req.method === "POST" && req.headers.origin && !originAllowed(req.headers.origin)) {
      json(res, 403, { ok: false, reason: "untrusted-origin" });
      return;
    }
    switch (path) {
      case `${PREFIX}/panel`:
        if (req.method !== "GET") return json(res, 405, { ok: false, reason: "method" });
        return servePanel(req, res, url);
      case `${PREFIX}/state`:
        if (req.method !== "GET") return json(res, 405, { ok: false, reason: "method" });
        if (!tokenOk(url)) return json(res, 403, { ok: false, reason: "bad-token" });
        return json(res, 200, snapshot());
      case `${PREFIX}/action`:
        if (req.method !== "POST") return json(res, 405, { ok: false, reason: "method" });
        return handleAction(req, res, url);
      case `${PREFIX}/events`:
        if (req.method !== "GET") return json(res, 405, { ok: false, reason: "method" });
        return serveEvents(req, res);
      case `${PREFIX}/current`:
        if (req.method !== "POST") return json(res, 405, { ok: false, reason: "method" });
        return handleCurrent(req, res);
      case `${PREFIX}/panel/open`:
        if (req.method !== "POST") return json(res, 405, { ok: false, reason: "method" });
        return json(res, 200, startPanel());
      case `${PREFIX}/panel/close`:
        if (req.method !== "POST") return json(res, 405, { ok: false, reason: "method" });
        stopPanel();
        broadcast("panel", { running: false });
        return json(res, 200, { ok: true, running: false });
      default:
        return json(res, 404, { ok: false, reason: "not-found" });
    }
  }

  ctx.inject(["webServer"], (webCtx) => {
    webRef = webCtx;
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: `${PREFIX}/state`,
          handler: (req, res) => void dispatch(req, res).catch(() => {
            try {
              res.destroy();
            } catch {
              // nothing left to answer
            }
          }),
        }),
      "dsh-float-panel: state route",
    );
    // One handler owns every other /float-panel path, so the prefix cannot
    // collide with the three exact routes above.
    const extra = ["panel", "action", "events", "current", "panel/open", "panel/close"];
    for (const leaf of extra) {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: "exact",
            path: `${PREFIX}/${leaf}`,
            handler: (req, res) => void dispatch(req, res).catch(() => {
              try {
                res.destroy();
              } catch {
                // nothing left to answer
              }
            }),
          }),
        `dsh-float-panel: ${leaf} route`,
      );
    }
    webCtx.effect(
      () => () => {
        for (const res of clients) {
          try {
            res.end();
          } catch {
            // already closed
          }
        }
        clients.clear();
        stopPanel();
        if (publishTimer) clearTimeout(publishTimer);
      },
      "dsh-float-panel: shutdown",
    );
  });

  // Disposers from ctx.on are handled by the plugin context, but keep the
  // event feed from outliving this instance during an HMR reload.
  ctx.effect(() => () => {
    try {
      offEvent();
    } catch {
      // already disposed
    }
    try {
      offDisposed();
    } catch {
      // already disposed
    }
    for (const rec of sessions.values()) if (rec.doneTimer) clearTimeout(rec.doneTimer);
    sessions.clear();
  }, "dsh-float-panel: session feed");
}

// ───────────────────────── helpers ─────────────────────────

function loadToken() {
  try {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
    // first run
  }
  const token = randomBytes(16).toString("hex");
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch {
    // the token still works for this process
  }
  return token;
}

/** The command line of one process, or "" when it cannot be read. */
function processCommandLine(pid) {
  try {
    if (IS_WIN) {
      // tasklist prints one CSV row: "DSHFloatPanel.exe","1234","Console","1","12,345 K"
      return execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 });
  } catch {
    return "";
  }
}

/** Kill a panel left over from a previous host process (same binary only). */
function killStalePanel() {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const command = processCommandLine(pid).toLowerCase();
    if (!command.includes(IS_WIN ? "dshfloatpanel" : "dsh-float-panel")) return;
    process.kill(pid, "SIGTERM");
  } catch {
    // no stale panel
  }
}
