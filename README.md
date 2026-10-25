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

`0.1.0` MVP，已在真实场景中验证（百度/小红书/GitHub 搜索、批量笔记正文提取、结构化数据收集）：

- Windows Node.js MCP 握手与工具发现；
- 自动发现 OpenCLIApp 内置与 npm 全局安装的 OpenCLI Node 入口；
- OpenCLI daemon 和 Chrome Extension 实时连通；
- 真实 Chrome 中打开任意网站；
- DOM snapshot、标题读取；
- 带 ref 标注的 PNG 截图，并作为 MCP image content 返回；
- Browser session 清理；
- 包含中文、引号、换行和 `&` 的文本保持为单个 argv，不经过 shell；
- 失败诊断、懒加载自动重试、零配置侦察、语义化压缩、get/read 拆分等通用优化。

## 前置条件

- Windows 10/11；
- Node.js 20+（当前实测 Node.js 24）；
- OpenCLI 1.8+；
- Windows Chrome 已安装并启用 OpenCLI Browser Bridge 扩展；
- `opencli doctor` 输出 daemon、extension、connectivity 均为 OK。

以下两种常见安装都会被自动发现，无需设置环境变量：

```text
%LOCALAPPDATA%\OpenCLIApp\node_modules\@jackwener\opencli\dist\src\main.js   # OpenCLIApp bundled
%APPDATA%\npm\node_modules\@jackwener\opencli                              # npm i -g
```

自动发现还覆盖 WSL 与 Windows fnm。npm 全局安装从包 `package.json` 声明的 `bin` 字段读取 CLI 入口，不再依赖固定
入口路径；OpenCLIApp 与 WSL 路径仍按各自的已知布局探测。

`OPENCLI_MCP_BIN` / `OPENCLI_MCP_PREFIX_ARGS` 现在只是纯粹的覆盖 / 逃生舱手段，仅在需要指向非标准安装时使用。
优先级、`.opencli-mcp.json` 项目配置、变量分类规则与按客户端配置方式见下文「OpenCLI 入口解析与配置」。

## OpenCLI 入口解析与配置

`resolveOpenCli()`（`src/opencli-runner.js`）按以下**优先级**决定如何启动 OpenCLI：

```text
OPENCLI_MCP_BIN（环境变量）
  > .opencli-mcp.json（项目配置文件）
    > 自动发现
```

**自动发现顺序**：OpenCLIApp bundled 布局（Windows）→ npm 全局安装 → WSL → Windows fnm。npm 全局探测依次检查：

```text
path.dirname(process.execPath)\node_modules\@jackwener\opencli
%APPDATA%\npm\node_modules\@jackwener\opencli
PATH 各目录下的 node_modules\@jackwener\opencli
```

命中后读取该包 `package.json` 声明的 `bin` 字段作为 CLI 入口（不再硬编码 `dist/src/main.js`）。

### 项目配置文件 `.opencli-mcp.json`

从 cwd 逐级向上查找，最后回退到用户主目录；可提交到仓库随版本化，例如：

```json
{ "bin": "node", "prefixArgs": ["C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@jackwener\\opencli\\dist\\src\\main.js"] }
```

### `OPENCLI_MCP_BIN` 分类规则

| 值 | 行为 |
|---|---|
| `.js` / `.mjs` / `.cjs` | 用当前 Node 运行时执行（`process.execPath`） |
| 原生可执行（Windows 下 `.exe`） | 直接执行 |
| 裸命令名（如 `node`） | Windows 上按 `PATH` + `PATHEXT` 解析 |
| `.ps1` / `.cmd` / `.bat` 或无扩展名 shim | **快速失败**并给出可操作提示，不再抛出裸 `spawn EFTYPE` |

`OPENCLI_MCP_PREFIX_ARGS`（可选，JSON 字符串数组）追加在 `.js` 入口之后：

```json
["C:\\path\\to\\opencli\\dist\\src\\main.js"]
```

### 按客户端配置环境（推荐）

| 客户端 | 配置位置 |
|---|---|
| stdio 客户端 | `mcp_servers` 定义中的 `env` 块（随客户端配置版本化，最精确） |
| Hermes HTTP | systemd unit 的 `Environment=` |
| 兜底 | 机器级 / 用户级环境变量，或 `$PROFILE`，仅在以上都不适用时使用 |

> 注意：环境变量由长驻进程在**启动时**继承。改动 `OPENCLI_MCP_BIN` / `OPENCLI_MCP_PREFIX_ARGS`（或 `$PROFILE`）后，
> 必须**重启长驻宿主**（例如 `tunnel-client run --profile opencli-mcp`），仅重连 MCP 客户端不够。

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
| `opencli_status` | 查看版本或执行 `opencli doctor`；同时报告 OpenCLI 入口解析来源（`resolution.command` / `prefixArgs` / `source`）、当前 MCP 进程实际生效的媒体缓存限制与站点闸门配置 |
| `opencli_adapter_list` | 按关键词搜索已安装站点 adapter；省略 `keywords` 返回全部，默认 `limit` 50 |
| `opencli_run` | 以结构化 argv 调用任意站点 adapter |

`opencli_adapter_list` 只收录 CLI adapter；`xiaohongshu/download` 是 OpenCLI 已有的 adapter，会出现在该列表中，但通过 `opencli_run` 调用时由 MCP 层接管并增加受管缓存与文件核验。`images` 是 MCP 层组合，CLI 侧没有对应命令，因此不会出现在 adapter 目录里。该工具的结果另外带有 `mcp_handled_subcommands` 字段，说明这两个入口在 MCP 层的语义，避免 agent 只在 adapter 数组里找。宿主（ChatGPT / Codex）在 App/连接器获批时会冻结一份 `tools/list` 快照：`tools/call` 始终执行本 Server 的实时代码，但新增工具、改名和描述变更只有在宿主侧刷新 App/连接器（ChatGPT 为 App/连接器设置里的 Refresh；仍不生效时删除并重新添加连接器）之后才会出现在工具列表里。本设计把小红书媒体收敛进 `opencli_run`，工具清单保持 26 个不变，因此不依赖这次刷新。重启本 MCP Server、tunnel 或客户端都不会刷新这份快照。

`opencli_run` 按站点限制跨调用并发：同一站点默认同时只执行 1 个调用（`OPENCLI_MCP_SITE_CONCURRENCY`），最多再排队 `OPENCLI_MCP_SITE_QUEUE_MAX` 个（默认 8），每个排队调用最多等待 `OPENCLI_MCP_SITE_QUEUE_WAIT_MS` 毫秒（默认 30000）。三个变量都必须是范围内的整数（并发 1–64、队列 1–256、等待 1–2147483647），非法值一律回退默认。超出即返回 `error.code=SITE_BUSY`（`reason` 为 `queue_full` 或 `queue_timeout`，并带 `site` 与 `hint`），而不是继续向站点堆请求；不同站点互不排队。这一层只限制并发，不额外添加间隔或抖动：小红书相关调用在 OpenCLI 侧自带节奏（risk-control 在每次读页面前等待抖动，风控命中后冷却再重试一次），串行化正是让这些进程内等待在多次调用之间继续有效。`opencli_status` 的 `site_gate` 字段报告生效配置与当前忙碌情况。闸门按 MCP 进程划分：stdio 与 HTTP 在同一进程内共用一个计数，多个 MCP 实例各自独立；它限制的是未完成的 `opencli_run` 调用数，进程终止未被证实时旧 CLI 进程可能仍未退出，此时新调用可能与之重叠。`browser_*` 工具不经这个闸门。

### 小红书下载与图片

小红书媒体只有一个入口：`opencli_run` 的 `xiaohongshu` 子命令 `download` 与 `images`。`download` 包装 OpenCLI 已有的 CLI 命令并管理目录、核验实际文件；`images` 复用同一次下载并返回图片。完整行为约定见下文各段。

两个子命令都通过 `opencli_run` 调用，参数以 argv 数组传入 `args`：

| 调用 | 职责 |
|---|---|
| `opencli_run(site="xiaohongshu", command="download", args=[note_url, "--output", dir?, "--timeout-ms", "60000"])` | 保存整篇笔记的图片/视频，返回真实绝对路径及元数据，供同机 OCR 等服务读取 |
| `opencli_run(site="xiaohongshu", command="images", args=[note_url, "--indexes", "1,3", "--timeout-ms", "60000"])` | 复用同一次下载到同一根目录下的图片缓存，读取后返回原生 MCP ImageContent（外加一段 JSON 元数据）；按图片数量清理 |

两个子命令都可用 `--timeout-ms` 指定单次 CLI 下载超时（默认 90 秒、上限 600 秒）。两者都支持 `args=["--help"]`：`download` 输出真实 CLI help 加一段包装层说明，`images` 输出该子命令的参数说明。`opencli_run` 的通用 `format` 参数对这两个子命令无效——包装层内部始终按 JSON 解析 CLI 输出，否则逐媒体失败行会退化成不可解析的文本并掩盖失败。

`download` 调用的是 OpenCLI 已有的 `xiaohongshu/download` adapter，只是被 MCP 层包装，因此它会出现在 `opencli_adapter_list` 中；`images` 是 MCP 层对同一次 download 的组合，CLI 侧不存在 `opencli xiaohongshu images`，不会注册进 adapter registry。

两个子命令共用同一 download_root：`download` 按显式 `--output` > `OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR` > OS 默认下载目录解析；`images` 不接受 `--output`（传入会报错），按 `OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR` > OS 默认下载目录解析；`images` 的成功结果不返回本地文件路径，但失败文本里可能出现服务端路径——路径是诊断信息，不是机密。

```text
<download_root>/
├── opencli-xhs-<unique>/<actual-note-id>/       # download 子命令的请求目录
└── opencli-xhs-images/opencli-xhs-<unique>/<actual-note-id>/   # images 子命令的图片缓存请求目录
```

例如，`images` 子命令的 `args`：

```json
{
  "site": "xiaohongshu",
  "command": "images",
  "args": ["https://www.xiaohongshu.com/explore/<id>?xsec_token=<token>", "--indexes", "1"]
}
```

下载保存到 `<download_root>/opencli-xhs-<unique>/<actual-note-id>/`，每调用独立，避免旧文件混入和并发覆盖。`OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB` 默认 100，是覆盖下载请求目录和图片缓存请求目录的统一软预算：超限时两类 taskdir 一起按创建顺序 FIFO 删除，固定的 `opencli-xhs-images` 容器本身保留，用户放在根目录的其他文件不受影响。预算按磁盘实际字节统计（含下载过程中的临时文件），未完成的下载同样占用预算；当前下载、活动任务和 quarantine 任务不会被淘汰，因此单个任务或并发任务可能暂时超过预算。返回的路径可能被后续清理回收，OCR 应及时读取。`opencli_status.media_cache` 报告 MCP 进程实际生效的值，不应使用 agent 自身环境变量推断。

`download` 子命令返回 `files`（`local_path` / `size_bytes` / `mime_type`，路径为服务端本地绝对路径）、`status`、`path_scope="server_local"`、`server_platform`、`managed_cache`、`download_root`、`output_directory`、`directory_source`、`cli_result`、`inventory_complete`（发生导航重试时还有 `retry`），以及 `status` 非 `success` 时的顶层 `error`；`cli_result` 返回前已脱敏（移除 `xsec_token`、cookie/authorization 等凭据及内部 stdout/stderr/invocation）。部分失败仍返回已核验文件，`status` 为 `partial` 或 `error`，失败原因不再只藏在 `cli_result` 里：顶层 `error` 直接携带 CLI 的真实原因——`error.code` 为 `CLI_ERROR`（CLI 进程失败、非零退出或超时）或 `MEDIA_DOWNLOAD_FAILED`（CLI 退出码为 0，但至少一个媒体行失败），`error.message` 是 CLI 自身的原因文本（诊断文本从尾部保留、截断到 600 字符并脱敏），`error.failed_indexes` 在能确定时列出失败的媒体序号；CLI 级失败还带 `cli_error_code`（CLI 自己的错误码：优先结构化错误码，否则是进程退出码或 `TIMEOUT` 这类语义码）、数字退出码 `exit_code`，以及必要时截断到 300 字符的 `stderr_tail`。`errors[]` 仍然只登记清理问题（`CLEANUP_PENDING`，每条都带 `message`），即使状态为 `partial` / `error` 也可能为空。原因来自 CLI `xiaohongshu download` 的逐媒体行（`{index, type, status, size}`，失败行的 `size` 即错误文本）以及类型化异常（如 `SECURITY_BLOCK`、`EmptyResultError`「No downloadable media found on this note.」、畸形 payload）；包装层转发这些真实原因，不再替换成通用句子。

这套失败摘要由 `src/cli-failure.js` 统一提供，所有 MCP 工具的 CLI 失败（`browser_*`、`opencli_run` 直通等）共用同一实现，统一给出 `code` / `message` / `hint` / `cli_error_code` / `stderr_tail`。脱敏只覆盖凭据与内部字段，**错误信息里的服务端路径保留**：`download` 本来就返回绝对路径，错误里的路径是诊断依据。

媒体子命令对 Chrome 的 `Navigation rejected.` 做一次自动重试。这条错误来自 Chrome 的 Tabs API（`chrome.tabs.update` 在自动化标签被关闭或替换的竞态下拒绝导航），不是风控、也不是登录问题；OpenCLI 全链路只有 Google Images 适配器认识它，小红书路径既不识别也不重试。包装层因此在首次命中时切换 `OPENCLI_SITE_SESSION` 的会话生命周期模式（默认 `ephemeral` 切到 `persistent`；若显式配置为 `persistent` 则反向切到 `ephemeral`）重跑一次，避免继续用那个不可导航的标签页，并在结果里加 `retry`（`reason` / `attempts` / `session` / `outcome`）说明发生过重试。第二次仍失败时按原样返回 CLI 错误（若仍命中该文案，再附上诊断 hint）。重试只覆盖这两个只读的媒体子命令——其它 adapter 命令与所有写类命令一律不重试，因为无法证明失败发生在副作用之前。诊断本身对所有工具生效：当 CLI 未自带 hint 而失败文案命中该错误时，包装层会补一句说明，提示这可能是标签竞态、可以直接重试。

清理与淘汰只针对**本服务拥有**的请求目录：每个 download_root 用一份根目录所有权记录 `.opencli-xhs-owned.json` 登记本服务创建的请求目录（名称形如 `opencli-xhs-<时间戳>-<uuid>`，`download` 位于根目录，`images` 位于 `opencli-xhs-images` 容器内），回收时只认这份记录；用户自建目录、用户文件与固定容器本身永不回收。该记录只是所有权清单，不登记笔记 ID、文件清单或媒体元数据——本功能没有内容注册表，笔记 ID 与图片序号只来自 CLI 实际下载到磁盘的文件。

请求目录创建时以 `quarantined=true` 记入所有权记录，确认写入结束（正常退出或已确认终止）后清除。停止无法证实或进程崩溃遗留的目录保持隔离：不盘点文件、不参与淘汰，但字节仍计入总配额；需人工确认下游停止写入后手动清理。超时或输出超限一律标记 `inventory_complete=false`；已确认终止时仍返回核验后的文件。活动任务与清理串行化只在单个 MCP 进程内生效，同一根目录应由一个 MCP 进程写入。

`images` 子命令与 `download` 子命令共享同一根目录和同一 100 MB 默认软预算；字节预算按 task 创建时间 FIFO 淘汰最旧的非保护目录。`OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES` 默认 10，只统计 `opencli-xhs-images` 图片子树，不限制 `download` 保存的图片数量；超过时按文件最早修改时间删除。没有 200 张硬上限。图片数量清理先于统一配额清理，两步由同一执行器完成。读取后不立即清空，也不增加 LRU、有效期或缓存命中逻辑。两种清理均避开仍在下载或读取的文件。

`--indexes`（逗号分隔；也可用可重复的 `--index`；两者都不传时返回全部图片）使用**原媒体序号**：序号取自 CLI 落盘文件名 `<note-id>_<n>` 中的 n，从 1 开始、覆盖整篇笔记下载到的全部媒体（含视频），既不依赖目录枚举顺序，也不按过滤后的纯图片列表重新编号；只有位于 `<note-id>/` 一级子目录、且文件名前缀与目录 ID 一致的文件参与映射，其余文件不参与，不做猜测式枚举。视频保留原序号但不作为图片返回。CLI 仍会先下载整篇媒体，`--indexes` 只限制读取与返回范围。`images` 子命令默认每次只返回 1 张图片块（ChatGPT connector 遇到多个 image 块时会丢弃整个结果，连文本一起消失；可用 `OPENCLI_XIAOHONGSHU_IMAGE_BLOCKS_PER_RESPONSE` 调到最多 20），其余请求到的索引放进 `skipped_indexes`，由调用方用 `--indexes` 分批取；单张最大 10 MiB、总计最大 20 MiB，字节超限项计入逐项错误。`images` 在 `status` 非 `success` 时也返回顶层 `error`（含 `code`、`message`，相关时带 `index` / `available_indexes` / `cli_error_code` / `exit_code` / `hint` / `stderr_tail`），并始终返回顶层 `available_indexes`（本次笔记磁盘上真实存在的 1 基媒体序号）；当下载产物只对应一个笔记 ID 时还返回顶层 `note_id`（公开笔记 ID，不是本地路径，xsec_token 与 cookies 仍不返回）。`errors[]` 每条都带人类可读的 `message`，相关时还带 `index`、`detail`（CLI 自己的逐项原因，如 "HTTP 403 Forbidden"）、`available_indexes`、`size_bytes`、`cli_error_code` 或 `exit_code`；错误码为 `IMAGE_DOWNLOAD_FAILED`（CLI 原因在 `detail` / `message`）、`IMAGE_NOT_FOUND`（`message` 列出可用序号）、`IMAGE_LIMIT`、`IMAGE_READ_FAILED`、`IMAGE_INDEX_UNMAPPABLE`、`IMAGE_INDEX_AMBIGUOUS`、`NO_IMAGES`、`CLI_ERROR`（`message` 为 CLI 的真实消息，如风控/安全拦截文本或 "No downloadable media found on this note."）、`TERMINATION_UNCONFIRMED` 与 `CLEANUP_PENDING`（清理类条目也带 `message`）。agent 应先读 `error.code` / `error.message` 定位原因，再按 `available_indexes` 用合法的 `--indexes` 值重试；某个失败项的自身原因在 `errors[].detail`。逐项错误码仍由 MCP 侧生成：CLI 把逐项原因打包在媒体行的 `size` 字符串里，没有输出结构化的逐项错误码，这是值得上游到 CLI 的限制。`images` 不另写站点媒体提取流程。两个子命令只增强小红书，不改变其他 adapter。

### 页面观察

| 工具 | 说明 |
|---|---|
| `browser_open` | 打开 URL，支持前台/后台窗口；失败时附带 DNS/timeout/unknown 诊断 |
| `browser_bind` | 绑定/解绑用户当前 Chrome 标签页 |
| `browser_snapshot` | 完整 DOM 或 AX 快照和 refs |
| `browser_snapshot_compact` | 未知/嘈杂网站的限长快照；语义化压缩优先保留内容行，省略导航/页脚等 chrome |
| `browser_find` | CSS/role/name/label/text/testid 查询；`nth` 在 MCP 层本地选择 |
| `browser_get` | 只读页面状态：title/url/value/attributes |
| `browser_read` | 内容提取：text/html；`target`（`browser_snapshot`/`browser_find` 的 ref 或 CSS selector）或 `selector` 别名，多匹配时用 `nth`（0 基）选择第 N 项；找不到元素时自动 scroll + retry 触发懒加载；多匹配且未传 `nth` 返回 `ambiguous_selector` / `matches_n` / `hint`；失败返回诊断；Markdown 长文请用 `browser_extract` |
| `browser_collect` | 用声明式 CSS 字段从重复卡片/表格/Feed 收集结构化记录；支持 discover 侦察、fallback_text、deduplicate_by、exclude 过滤；selector 匹配 0 时自动进入 discover |
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

`browser_fill_submit` 把“填值并提交”压成一次 MCP 调用：

- CSS target 默认在一次页面执行中设置原生 input/textarea value、派发 input/change、聚焦并派发 Enter 键事件；
- 数字 ref 现在会被解析为 `[data-opencli-ref="N"]` 并走同一条原子 DOM 路径（此前会静默退回 CLI 路径）；ref 已失效时记录 `atomic_skipped: true` + `atomic_error` 后回退；
- `submit_strategy` 支持三种模式：
  - `form`（默认）：派发事件后尝试 `requestSubmit()`，适合百度等传统表单；
  - `event`：只派发键盘事件，不触发表单提交，适合纯 JS 监听 Enter 的 SPA；
  - `both`：先派发事件再尝试 `requestSubmit()`；
- 回退为官方 CLI 的 `fill → focus → keys` 时（显式 `atomic=false` 或 ref 失效），结果显式返回 `atomic_skipped`、`focus_ok`、`submit_verified`、`url_before`、`url_after` 与 `warnings`（`focus_failed` / `submit_not_verified`），不再伪装成成功；
- 该工具保证提交事件被派发，后续仍应通过 `browser_wait_any` 验证导航或内容就绪。

`browser_wait_any` 的条件支持 `tier` 优先级：

- tier 0（默认）：内容就绪条件（如 selector、text）；
- tier 1+：兜底条件（如 URL、title）；
- 当多个条件同时匹配时，tier 值最小的获胜。
- 超时返回 `diagnosis`，报告最后页面状态、url、title，以及每个条件的具体修复建议。

### 失败诊断

所有可能失败的工具在失败时返回结构化 `diagnosis`：

```json
{
  "diagnosis": {
    "issue": "selector_no_match",
    "hint": "Selector \"#bad\" matched 0 elements.",
    "suggestions": [
      "Use browser_collect with discover:true to find candidate selectors.",
      "Or use browser_snapshot to inspect the page structure."
    ]
  }
}
```

覆盖范围：

- `browser_collect` 返回 0 条：区分 `selector_no_match` / `all_filtered`；
- `browser_wait_any` 超时：报告最后的 url/title 和每个条件的修复建议；
- `browser_fill_submit` 失败：区分 `target_not_found` / `invalid_selector` / `event_only_no_submit`；
- `browser_open` 失败：区分 `navigation_timeout` / `dns_error` / `unknown_error`；
- `browser_read` 返回空：提示"可能需要滚动触发懒加载"。

### 懒加载自动处理

`browser_read` 默认开启 `auto_scroll_retry: true`：

```
读不到目标元素
→ 自动 scroll down
→ 等待元素出现（最多 5 秒）
→ 重试读取
```

适用于 turbo-frame、Intersection Observer 等 SPA 常见懒加载场景，模型不需要知道底层机制。

### 有界批量流程

`browser_flow` 在一次 MCP 调用内顺序执行短流程，支持 `open/find/action/fill_submit/wait/wait_any/snapshot/get/collect/back`。它仍通过官方 OpenCLI CLI 执行每一步，但减少 Agent↔MCP 往返。

关键安全边界：

- 默认最多 8 步，硬上限 20；
- 默认总预算 30 秒，硬上限 120 秒；
- 每步独立超时；
- 不支持循环或 goto；
- `retry` 只能为 0 或 1；
- 必需步骤失败立即停止并返回 partial trace；
- `optional=true` 的步骤失败后标记 skipped；
- `find + save_as` 可保存唯一 ref，后续用 `$变量名` 引用；
- 当前 OpenCLI `find` 不接受 `--nth`，MCP 会先获取候选，再在本地选择第 N 项；
- 必需步骤失败时默认并行捕获 URL、title 和最多 6,000 字符的 compact snapshot；可用 `on_error_capture=false` 关闭；
- `collect` 步骤支持 `discover`、`fallback_text`、`deduplicate_by`、`exclude`，与独立工具一致；
- `get` 步骤使用 `browser_read` 语义，自动支持懒加载重试和诊断。

示例（GitHub 搜索 → 提取前 3 条结果）：

```json
{
  "session": "github-research",
  "max_steps": 5,
  "max_total_ms": 30000,
  "steps": [
    {"operation":"open","url":"https://github.com/search?q=agent+browser&type=repositories"},
    {"operation":"wait_any","conditions":[{"type":"selector","value":"[data-testid=results-list]"}]},
    {"operation":"collect","selector":"[data-testid=results-list] > div","limit":3,"fields":[{"name":"repo","selector":"h3 a","property":"text"},{"name":"href","selector":"h3 a","property":"href"}],"save_as":"results"}
  ]
}
```

### 探索与调试

| 工具 | 说明 |
|---|---|
| `browser_network` | 请求 shape、失败请求、过滤、response body detail；列表默认 50 条，支持 `limit/offset` 分页 |
| `browser_console` | Console/JS errors |
| `browser_eval` | 页面或跨域 frame 中执行只读 JS |
| `browser_wait` | 单个 selector/text/time/xhr/download 条件 |
| `browser_wait_any` | URL/title/selector/文本条件任一满足即返回，并报告获胜条件；超时返回诊断 |
| `browser_dialog` | accept/dismiss JS dialog |
| `browser_tabs` | list/new/select/close |
| `browser_back` | 后退 |
| `browser_close` | 释放 session tab lease |

## 推荐工作流

### 优先使用 Adapter

```text
opencli_adapter_list
  ├─ 已有命令 → opencli_run
  └─ 没有命令 → browser_open
```

### 探索未知网站

```text
browser_open
→ browser_collect(discover=true)         REM 一次性侦察候选 selector
→ browser_collect(selector=..., fields=...)  REM 精确采集
→ browser_snapshot_compact               REM 内容未知时才做完整快照
→ browser_read(selector=..., auto_scroll_retry=true)  REM 提取正文
```

失败时不需要额外调用诊断工具——相关工具会直接返回 `diagnosis` 字段，说明问题（如 `selector_no_match`）和修复建议（如 `discover:true`）。

### 已知站点批量采集

```text
browser_fill_submit(target=#search, value=query, submit_strategy=form)
→ browser_wait_any(conditions=[{selector:#results, tier:0}, {text:..., tier:1}])
→ browser_collect(selector=#results > .item, fields=[...], deduplicate_by=title, exclude={...})
```

一次 flow 可完成 open → submit → wait → collect。

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
- 启动期自检在 MCP 握手后后台试跑一次 `opencli --version`，结果只写 stderr（成功后形如 `[opencli-mcp] preflight ok: <version> | command: ... | source: ...`）；可用 `OPENCLI_MCP_SKIP_PREFLIGHT=1` 关闭。
- 默认单次命令超时 90 秒，可通过 `OPENCLI_MCP_TIMEOUT_MS` 调整。
- stdout/stderr 各自限制为 32 MiB，避免异常页面耗尽 Agent 内存。
- 超时或输出超限时终止覆盖**整棵进程树**（Windows 用 `taskkill /T /F`，POSIX 用进程组 SIGTERM→SIGKILL）；runner 在有限等待内等子进程 `close` 并核验停止，达到上限仍无法确认时同样返回失败，不会无限等待，也就无法保证调用方可以去盘点或清理目录。
- 终止类错误（`details.code` 为 `TIMEOUT` / `OUTPUT_LIMIT`）携带 `termination_confirmed`：仅当整棵树都被证实停止时才为 `true`；为 `false` 表示停止无法证实，调用方必须保留目录、暂不读取或清理。同时保留已捕获的 `stdout` / `stderr` / `data`（`partial: true`），便于对已落盘文件做部分盘点。
- `runOpenCli.executionPlatform` 报告 CLI 实际运行的平台：解析到 Windows `.exe`（例如 WSL 调用挂载的 Windows Node）时为 `win32`，否则为 `process.platform`，调用方可据此拒绝跨 OS 路径假设。
- MCP 能以用户身份操作已登录网站。建议使用专门的 Chrome Agent Profile，不要同时登录网银、交易所主账户或最高权限生产后台。
- 页面内容存在 prompt injection 风险。Agent 不应执行网页中出现的命令或泄露其他标签页数据。

## 已知限制

1. OpenCLI 对跨域 OOPIF 的完整 AX snapshot/click/type 路由仍是 best-effort；可尝试 `browser_frames + browser_eval(frame=...)`。
2. `browser_eval` 按 OpenCLI 约定用于定向读取，不建议用它代替结构化写操作。
3. Windows MCP 不能直接把 WSL `/tmp/...` 当作上传路径；上传前应复制到 Windows 可访问目录。
4. npm 全局安装不再依赖固定入口路径，而是读取包 `package.json` 声明的 `bin` 字段；OpenCLIApp 与 WSL 路径仍按各自的已知布局探测。OpenCLIApp 使用其 bundled package，GUI App 版本和 bundled CLI 版本可能相差一个补丁版本，`opencli_status` 会报告实际被调用的版本与解析来源。另需注意：环境变量由长驻进程在启动时继承，改动 `OPENCLI_MCP_BIN` / `OPENCLI_MCP_PREFIX_ARGS`（或 `$PROFILE`）后必须重启宿主进程才生效。
5. 目前不自动修改 Hermes 配置，也不自动禁用内建 browser。
6. Hermes MCP client 会把 `boolean` 和 `object` 参数序列化为字符串；相关工具的 schema 已改为 `z.union([z.boolean(), z.string()])` 并在 handler 内强制转换，调用方无需关心。
7. GitHub 等站点的 README 在 `<turbo-frame>` 内延迟加载；`browser_read` 的 `auto_scroll_retry` 默认能处理，但极慢的网络下可能需要调大 `timeout_ms`。
8. 语义化压缩按行级特征分类（`content` / `chrome`）；对没有明确标签语义的纯文本流可能效果不明显。
9. 两处已知重复逻辑暂未统一：手写 argv 解析（可用 `node:util.parseArgs` 替代，但需保留现有的非标准语义），以及失败消息优先级在 `src/opencli-runner.js` 与 `src/cli-failure.js` 各实现一次。

## 测试

```bat
npm run check       REM JavaScript 语法检查
npm test            REM 参数映射、无 shell 注入、错误处理、诊断、压缩、fill/submit/wait/collect
npm run test:mcp    REM MCP 握手、工具发现、OpenCLI version
npm run test:live   REM OpenCLI daemon/extension 实时诊断
npm run test:browser      REM stdio: Chrome open/snapshot/get/screenshot/close
npm run test:http         REM Streamable HTTP 握手、工具发现、OpenCLI version
npm run test:http-browser REM HTTP: Chrome open/snapshot/get/screenshot/close
npm run test:http-flow    REM HTTP: 6-step bounded flow + action(wait/snapshot)
npm run test:http-advanced REM 小红书: atomic submit + wait_any + collect + failure capture
npm run test:xhs-live     REM 小红书: 真实笔记 download + images 端到端（签名 URL 从 stdin 读入）
```

`test:browser` 会短暂创建一个后台 OpenCLI session，访问 `https://example.com`，验证后释放 session。

## License

MIT
