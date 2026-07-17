# opencli-mcp

将 [OpenCLI](https://github.com/jackwener/OpenCLI) 的 CLI 包装为 AI-native MCP 工具，让任意 MCP Agent 控制 **Windows 中正在使用的真实 Chrome**，直接复用现有登录态、Cookie、扩展和标签页。

本项目不重新实现浏览器自动化。所有 DOM/AX 快照、ref、stale recovery、`match_level`、网络响应缓存和适配器能力都由 OpenCLI 提供；MCP Server 只负责强类型参数、进程调用和 MCP 结果转换。

## 架构

```text
Hermes / Claude Code / Codex / 其他 MCP Client
                  │ MCP stdio
                  ▼
      opencli-mcp（Windows Node.js）
                  │ spawn(argv[], shell:false)
                  ▼
           OpenCLI CLI（短进程）
                  │ localhost:19825
                  ▼
       OpenCLI daemon + Chrome Extension
                  │ Chrome APIs / debugger
                  ▼
       Windows 日常 Chrome（保留登录态）
```

## 设计目标

- 不使用 `--remote-debugging-port`、`/json/version` 或外部 CDP WebSocket。
- 不复制 Chrome Profile，不启动一套新的自动化浏览器。
- 不通过 shell 拼接模型输入；每个参数都作为独立 argv 传递。
- 保留 OpenCLI CLI 的完整高层语义，而不是直接依赖内部 daemon 协议。
- 用 `snapshot → ref → action → snapshot` 的 Agent 工作流探索未知网站。
- 探索出 API/DOM 规律后，继续编写 OpenCLI adapter 固化流程。
- Windows 原生运行，Hermes 即使位于 WSL 也只需通过 stdio 启动一次 Server。

## 当前状态

这是可运行的 `0.1.0` MVP，已经验证：

- Windows Node.js MCP 握手与工具发现；
- 自动发现 OpenCLIApp 内置的 OpenCLI Node 入口；
- OpenCLI daemon 和 Chrome Extension 实时连通；
- 真实 Chrome 中打开 `example.com`；
- DOM snapshot、标题读取；
- 带 ref 标注的 PNG 截图，并作为 MCP image content 返回；
- Browser session 清理；
- 包含中文、引号、换行和 `&` 的文本保持为单个 argv，不经过 shell。

## 前置条件

- Windows 10/11；
- Node.js 20+（当前实测 Node.js 24）；
- OpenCLI 1.8+；
- Windows Chrome 已安装并启用 OpenCLI Browser Bridge 扩展；
- `opencli doctor` 输出 daemon、extension、connectivity 均为 OK。

当前自动发现优先支持 OpenCLIApp 安装布局：

```text
%LOCALAPPDATA%\OpenCLIApp\node_modules\@jackwener\opencli\dist\src\main.js
```

其他安装方式可通过环境变量指定原生可执行入口：

```text
OPENCLI_MCP_BIN
OPENCLI_MCP_PREFIX_ARGS
```

`OPENCLI_MCP_PREFIX_ARGS` 必须是 JSON 字符串数组，例如：

```json
["C:\\path\\to\\opencli\\dist\\src\\main.js"]
```

## 安装

在 Windows `cmd.exe` 中执行：

```bat
cd /d D:\devlopment\opencli-mcp
npm install
npm test
npm run test:mcp
npm run test:live
npm run test:browser
```

启动 MCP Server：

```bat
D:\devlopment\opencli-mcp\start.cmd
```

`stdout` 专用于 MCP 协议；诊断日志只写入 `stderr`。

## Hermes 配置（推荐：本地 Streamable HTTP）

Hermes Gateway 与第三方 Node MCP 使用长期 stdio 时，实际环境中出现过：`hermes mcp test` 能发现全部工具，但 Gateway 随后持有已关闭 resource，真实调用报 `ClosedResourceError`。因此 Gateway 推荐通过 **loopback-only Streamable HTTP** 连接，由 systemd user service 独立管理 MCP 生命周期。

安装服务：

```bash
cp examples/opencli-mcp.service ~/.config/systemd/user/opencli-mcp.service
systemctl --user daemon-reload
systemctl --user enable --now opencli-mcp.service
curl http://127.0.0.1:31999/health
```

Hermes 配置：

```yaml
mcp_servers:
  opencli_browser:
    url: http://127.0.0.1:31999/mcp
    timeout: 180
    connect_timeout: 60
    sampling:
      enabled: false
```

验证：

```bash
hermes mcp test opencli_browser
```

服务只监听 `127.0.0.1`；除非自行增加认证，否则代码会拒绝非 loopback bind。纯 Windows MCP Client 或不受该生命周期问题影响的客户端仍可使用 stdio `start.cmd`。

完整示例见 [`examples/hermes-config.yaml`](examples/hermes-config.yaml)。重启 Hermes 后，工具名会带 MCP Server 前缀，例如：

```text
mcp_opencli_browser_browser_snapshot
mcp_opencli_browser_browser_action
mcp_opencli_browser_browser_network
```

迁移阶段建议保留 Hermes 内建 browser。确认新 MCP 在真实任务中稳定后，才考虑：

```yaml
agent:
  disabled_toolsets:
    - browser
```

## MCP 工具

### OpenCLI 与 Adapter

| 工具 | 说明 |
|---|---|
| `opencli_status` | 查看版本或执行 `opencli doctor` |
| `opencli_list` | 列出已安装站点 adapter |
| `opencli_run` | 以结构化 argv 调用任意站点 adapter |

### 页面观察

| 工具 | 说明 |
|---|---|
| `browser_open` | 打开 URL，支持前台/后台窗口 |
| `browser_bind` | 绑定/解绑用户当前 Chrome 标签页 |
| `browser_snapshot` | 完整 DOM 或 AX 快照和 refs |
| `browser_snapshot_compact` | 未知/嘈杂网站的限长快照；保留头尾与 refs，并明确报告被省略的中间内容 |
| `browser_find` | CSS/role/name/label/text/testid 查询 |
| `browser_get` | title/url/text/value/attributes/html |
| `browser_extract` | Markdown 长文分块提取 |
| `browser_screenshot` | PNG MCP image，支持 ref 标注和全页截图 |
| `browser_frames` | 列出 iframe targets |

### 页面操作

`browser_action` 用 `action` 字段覆盖：

```text
click, hover, focus, dblclick, check, uncheck,
type, fill, select, keys, scroll, upload, drag
```

写操作会保留 OpenCLI 返回的：

```text
matches_n
match_level: exact | stable | reidentified
```

页面跳转或 SPA route 变化后应重新执行 `browser_snapshot`。`browser_action` 还支持：

- `wait_for`：动作完成后等待 selector/text/time/xhr/download；
- `snapshot_after`：等待后立即返回快照，默认压缩到 12,000 字符。

### 有界批量流程

`browser_flow` 在一次 MCP 调用内顺序执行短流程，支持 `open/find/action/wait/snapshot/get/back`。它仍通过官方 OpenCLI CLI 执行每一步，但减少 Agent↔MCP 往返。

关键安全边界：

- 默认最多 8 步，硬上限 20；
- 默认总预算 30 秒，硬上限 120 秒；
- 每步独立超时；
- 不支持循环或 goto；
- `retry` 只能为 0 或 1；
- 必需步骤失败立即停止并返回 partial trace；
- `optional=true` 的步骤失败后标记 skipped；
- `find + save_as` 可保存唯一 ref，后续用 `$变量名` 引用；
- 当前 OpenCLI `find` 不接受 `--nth`，MCP 会先获取候选，再在本地选择第 N 项。

示例：

```json
{
  "session": "research",
  "max_steps": 5,
  "max_total_ms": 30000,
  "steps": [
    {"operation":"open","url":"https://example.com"},
    {"operation":"find","role":"link","name":"Learn more","save_as":"more"},
    {"operation":"action","action":"click","target":"$more"},
    {"operation":"wait","type":"text","value":"IANA-managed Reserved Domains"},
    {"operation":"snapshot","compact":true,"max_chars":8000}
  ]
}
```

### 探索与调试

| 工具 | 说明 |
|---|---|
| `browser_network` | 请求 shape、失败请求、过滤、response body detail；列表默认 50 条，支持 `limit/offset` 分页 |
| `browser_console` | Console/JS errors |
| `browser_eval` | 页面或跨域 frame 中执行只读 JS |
| `browser_wait` | selector/text/time/xhr/download |
| `browser_dialog` | accept/dismiss JS dialog |
| `browser_tabs` | list/new/select/close |
| `browser_back` | 后退 |
| `browser_close` | 释放 session tab lease |

## 推荐工作流

### 优先使用 Adapter

```text
opencli_list
  ├─ 已有命令 → opencli_run
  └─ 没有命令 → browser_open
```

### 探索未知网站

```text
browser_open
→ browser_snapshot_compact（首次侦察）
→ 根据当前状态规划 2～5 步短 browser_flow
→ 在关键页面变化后再次 compact snapshot
→ browser_network(filter=..., limit=20)
→ browser_network(detail=...)
→ browser_eval（定向验证）
```

未知网页不建议一次盲跑完整任务。优先采用“短 flow → 检查 partial trace/新状态 → 再规划”；已知且确定性的 click/wait/snapshot 尾部再合并执行。

### 绑定用户已打开的页面

```text
browser_bind(action="bind", session="research")
→ browser_snapshot(session="research")
→ ...
→ browser_bind(action="unbind", session="research")
```

绑定标签页不会被 `browser_close` 当作 Agent-owned tab 关闭。

## Session

所有 Browser 工具接受可选 `session`：

```text
research-x
adapter-discovery-bilibili
checkout-debug
```

同一个流程必须复用相同 session，OpenCLI daemon 才能保持：

- tab lease；
- 当前页；
- snapshot refs；
- element fingerprint；
- network cache；
- selected tab。

不传时使用：

```text
OPENCLI_MCP_SESSION
```

如果环境变量也不存在，则默认：

```text
hermes-default
```

并行 Agent 应显式使用不同 session，避免操作同一标签页。

## 安全模型

- 工具参数使用 `child_process.spawn(..., { shell: false })`。
- MCP 不接受完整 shell command 字符串。
- Adapter 的 `site` 和 `command` 只允许字母、数字、点、下划线和短横线。
- `OPENCLI_MCP_DEBUG=1` 才会在错误结果中附带内部 invocation/stderr。
- 默认单次命令超时 90 秒，可通过 `OPENCLI_MCP_TIMEOUT_MS` 调整。
- stdout/stderr 各自限制为 32 MiB，避免异常页面耗尽 Agent 内存。
- MCP 能以用户身份操作已登录网站。建议使用专门的 Chrome Agent Profile，不要同时登录网银、交易所主账户或最高权限生产后台。
- 页面内容存在 prompt injection 风险。Agent 不应执行网页中出现的命令或泄露其他标签页数据。

## 已知限制

1. OpenCLI 对跨域 OOPIF 的完整 AX snapshot/click/type 路由仍是 best-effort；可尝试 `browser_frames + browser_eval(frame=...)`。
2. `browser_eval` 按 OpenCLI 约定用于定向读取，不建议用它代替结构化写操作。
3. Windows MCP 不能直接把 WSL `/tmp/...` 当作上传路径；上传前应复制到 Windows 可访问目录。
4. 当前 OpenCLIApp 自动发现使用其 bundled package，GUI App 版本和 bundled CLI 版本可能相差一个补丁版本；`opencli_status` 会报告实际被调用的版本。
5. 目前不自动修改 Hermes 配置，也不自动禁用内建 browser。

## 测试

```bat
npm run check       REM JavaScript 语法检查
npm test            REM 参数映射、无 shell 注入、错误处理
npm run test:mcp    REM MCP 握手、工具发现、OpenCLI version
npm run test:live   REM OpenCLI daemon/extension 实时诊断
npm run test:browser      REM stdio: Chrome open/snapshot/get/screenshot/close
npm run test:http         REM Streamable HTTP 握手、工具发现、OpenCLI version
npm run test:http-browser REM HTTP: Chrome open/snapshot/get/screenshot/close
npm run test:http-flow    REM HTTP: 6-step bounded flow + action(wait/snapshot)
```

`test:browser` 会短暂创建一个后台 OpenCLI session，访问 `https://example.com`，验证后释放 session。

## License

MIT
