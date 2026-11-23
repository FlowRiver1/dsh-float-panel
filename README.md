# 任务浮窗 · dsh-float-panel

*[English](README.en.md)*

DSH 发起任务后，你切到任何软件都能看到一个系统级置顶小窗：现在在不在干活、在干什么、走到第几步；需要你审批或回答时直接在浮窗上点；任务完成后浮窗变「已完成」，点一下回到 DSH 对应会话看结果。

## 它解决什么

| 你原来的问题 | 浮窗里的表现 |
| --- | --- |
| 切走后不知道 AI 还在不在干活 | 顶部状态点 + 「正在执行 Bash：npm test」这类实时步骤 |
| 不知道整体进度 | 有任务清单时显示进度条和小标题（3/7 · 正在写修复补丁） |
| 审批弹窗在软件里，人在别的窗口 | 浮窗直接给「允许一次 / 拒绝」按钮，点完立即生效 |
| 需要你回答的选择题 | 单选题直接给选项按钮，点一下就提交 |
| 不知道是否已经完成 | 完成后状态变「已完成」，并显示结果前两行预览 |
| 完成后要自己找会话 | 「打开查看结果」一键激活 DSH 并跳到该会话 |

## 外观

320pt 宽、高度跟内容走，只占右上角一小块：

| 状态 | 样子 |
| --- | --- |
| 进行中 | ![进行中](docs/running.png) |
| 待审批 | ![待审批](docs/approval.png) |
| 待回答 | ![待回答](docs/question.png) |
| 已完成 | ![已完成](docs/done.png) |

## 安装

要求：**macOS 13+**（浮窗是原生 AppKit 窗口）、DSH `>=0.2.0-rc.2`。仓库里已经带构建好的通用二进制（Apple Silicon + Intel），安装时**不需要** Xcode。

```bash
dsh plugin --profile web add github:FlowRiver1/dsh-float-panel
```

装完重启 DSH，在 Settings → Plugins 里能看到 `dsh-float-panel`，配置项见下面的「配置」。

本地开发/试用时用链接安装，改代码即时生效：

```bash
dsh plugin --profile web add link:/path/to/float-panel
```

> 桌面版（dsh-desktop 等）的 profile 由 Electron 应用托管，同样用 `dsh plugin --profile <名字> add ...` 加包，重启应用后生效。

## 用法

- 发出一条请求后浮窗自动出现（右上角），可以拖动到任意位置，位置会记住。
- 不想自动出现时，把 `config.autoOpen` 设为 `false`；随时可以点 DSH 界面右下角的「◍ 任务浮窗」把它叫回来。
- 浮窗右上角 × 只关闭窗口，不打断任务；DSH 应用的右下角按钮仍在。
- 浮窗只显示「此刻最需要你看」的那一个会话（审批 > 提问 > 进行中 > 已完成），其余只留顶部 `+N` 计数，避免占屏幕。
- 窗口高度跟内容走：空着 57pt、进行中约 80pt、带审批按钮约 140pt，永远比一张卡片大不了多少。
- 已完成的任务保留 30 分钟，点「打开」后从浮窗移除。

## 结构

```
index.js          Host 半：把 session/event 折叠成面板状态，提供 /float-panel/* 路由
client.js         页面半：上报当前会话、执行浮窗发来的审批/回答/打开指令、右下角唤醒按钮
panel.html        浮窗页面（透明背景，深色卡片）
native/           Swift 原生壳：NSPanel + WKWebView，构建产物 DSH Float Panel.app
cordis.patch.yml  安装到 profile 时插入的 loader 条目
```

Host 是状态的唯一来源：它订阅 `session/event`（turn/start、tool/call、todo/write、approval/asked、turn/end…），所以即使 DSH 页面在后台、甚至没打开，浮窗照样准确。页面半只负责三件事：告诉 Host 当前看的是哪个会话、把浮窗上的点击换算成真正的 `answer()` 调用、以及收到「打开」指令后切会话。

## 路由

全部挂在 DSH 现有的 Web 端口上，不额外监听：

| 路由 | 作用 |
| --- | --- |
| `GET /float-panel/panel?t=` | 浮窗页面本身 |
| `GET /float-panel/state?t=` | 面板状态快照（轮询兜底用） |
| `POST /float-panel/action?t=` | 浮窗上的审批 / 回答 / 打开 |
| `GET /float-panel/events` | SSE：状态推送与指令下发 |
| `POST /float-panel/panel/open` · `/panel/close` | 启动 / 关闭原生浮窗 |
| `POST /float-panel/current` | 页面上报当前会话 |

`panel` / `state` / `action` 三条需要 32 位随机 token（存在 `~/Library/Application Support/dsh-float-panel/token`，权限 0600）；`events`、`current`、`panel/open` 只接受本机来源，并校验 Origin。

## 原生壳构建

仓库里已经带构建好的 `native/DSH Float Panel.app`（universal，arm64 + x86_64，ad-hoc 签名），普通安装不需要自己编译。只有改过 `native/main.swift` 才需要重建：

```bash
cd native && ./build.sh
```

需要 Xcode 命令行工具。产物是 `native/DSH Float Panel.app`（ad-hoc 签名、`LSUIElement` 无 Dock 图标）。窗口用 `NSPanel` + `.nonactivatingPanel`，所以点击浮窗不会把 DSH 提到前台；顶部 22px 是原生拖拽条，页面渲染完会把自己的高度告诉原生壳（`postMessage {type:'resize'}`），窗口朝下伸缩、顶边不动。

## 配置

```yaml
- insert:
    - id: float-panel
      name: 'dsh-float-panel'
      config:
        autoOpen: true   # 任务开始时自动显示浮窗
```

## 限制

- 浮窗是 macOS 原生窗口，Windows / Linux 上只有 DSH 页面内的唤醒按钮可用。
- 「需要你输入一段文字」这类回答不在浮窗里编辑，只给「去回答」入口跳回 DSH。
- 审批必须由页面结算，所以浮窗点击要求 DSH 页面至少打开过一次（桌面端默认总是满足）。

## 隐私

- 插件只读**本机** DSH 会话的状态事件，把结果画在浮窗里；不向任何外部服务发送数据，没有遥测、没有统计上报。
- 所有路由挂在 DSH 自己的 Web 端口上，不额外监听。`panel` / `state` / `action` 需要 32 位随机 token（`~/Library/Application Support/dsh-float-panel/token`，权限 0600）；`events`、`current`、`panel/open` 只接受本机来源并校验 Origin。
- token、`panel.pid` 等运行状态文件都在 `~/Library/Application Support/dsh-float-panel/` 下，不进仓库。

## License

[MIT](LICENSE)

