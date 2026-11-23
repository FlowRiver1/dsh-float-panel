# dsh-float-panel · always-on-top task window for DeepSeek Harness

*[中文说明](README.md)*

Once DSH starts a task, a small system-level floating window stays on top of whatever you are doing: whether the agent is still working, what it is doing right now, and which step it is on. Approvals and multiple-choice questions can be answered straight from the window. When the task finishes, the window turns into "done" — click once to jump back to that conversation in DSH.

| Running | Waiting for approval |
| --- | --- |
| ![running](docs/running.png) | ![approval](docs/approval.png) |

## Install

Requirements: **macOS 13+** (the window is a native AppKit panel) and DSH `>=0.2.0-rc.2`. The repo ships a prebuilt universal binary (Apple Silicon + Intel), so **no Xcode needed**.

```bash
dsh plugin --profile web add github:FlowRiver1/dsh-float-panel
```

Restart DSH afterwards and the plugin shows up in Settings → Plugins.

Local development uses a link install instead:

```bash
dsh plugin --profile web add link:/path/to/float-panel
```

## Usage

- The window appears in the top-right corner after you send a request; drag it anywhere, the position is remembered.
- Set `config.autoOpen: false` to stop it opening automatically; the "◍ 任务浮窗" button at the bottom-right of DSH brings it back.
- The **×** only closes the window, it never interrupts the task.
- One conversation at a time is shown (approval > question > running > done); the rest collapse into a `+N` counter.
- Finished tasks stay for 30 minutes; clicking "open" removes them.

## How it works

`index.js` is the host half: it folds the committed `session/event` log into a tiny snapshot of "what is this task doing right now" and serves it over `/float-panel/*` routes on DSH's existing web port. `client.js` is the page half: it reports which conversation is on screen and turns clicks in the window into real `answer()` calls. `panel.html` is the window UI, and `native/main.swift` is a ~200-line Swift shell (`NSPanel` + `WKWebView`) that the host spawns — an Electron renderer cannot create an always-on-top window.

Because the host is the single source of truth, the panel stays accurate even when the DSH page is in the background or not open at all.

## Limits

- The floating window is macOS-only; on Windows/Linux only the in-page wake-up button exists.
- Free-text answers are not editable in the panel — it offers a "go answer" shortcut instead.
- Approvals must be settled by the page, so the window needs the DSH page to have been opened at least once (always true on desktop).

## Privacy

The plugin reads local session state only. Nothing is sent anywhere: no telemetry, no analytics. Every route lives on DSH's own web port, and `panel` / `state` / `action` require a 32-character token stored at `~/Library/Application Support/dsh-float-panel/token` (mode 0600); the remaining routes accept loopback origins only and validate `Origin`.

## License

[MIT](LICENSE)
