# dsh-restart-center 重启中心

标题栏「应用 / 编辑」右侧同级放一个**重启**按钮。点一次分两段确认，确认后重启整个桌面应用（Electron + Host）。

装完插件不必再「右下角关掉 → 重新点开」。

## 位置

按钮不是普通槽位控件：「应用 / 编辑」是 Electron **preload 的 shadow DOM**（`lib/preload-app.cjs` 的 `installWindowsMenu`），`position: fixed; z-index: 1100`，没有任何插件槽位。

所以本插件注册进 `shell.overlay`，用 `[data-windows-menu]` 的实时 `getBoundingClientRect().right + 2px` 贴上去，窗口缩放、侧栏折叠都会重新测量。浏览器里和非 Windows 下没有这个菜单栏，按钮自动不渲染。

## 二次确认

**第一段：说清现状**

- 无会话运行 → 绿色「当前没有会话在运行，可以安心重启。」
- 有会话在跑 → 黄色「有 N 个会话正在运行（acc52b2f、226c114f），重启会中断正在生成的回复。」
- 插件正在安装 → 红色「插件正在安装中（第 2/2 个源 · registry.npmmirror.com）。现在重启会打断安装……」
- 有安装排队 → 红色「有插件安装任务正在排队或准备中，现在重启会取消它。」
- 读不到状态 → 黄色「没能读到当前运行状态，重启前请自行确认没有在跑的任务。」

焦点默认落在**取消**。Esc 关闭，点遮罩关闭。

**第二段：最后确认**

「点『立即重启』后窗口会关闭，约 10 秒后自动重新打开；端口、模型与插件设置都会保留。」有会话在跑时追加「被中断的生成不会自动续上。」

确认才 `POST /dsh-restart-center/api/restart {"force":true}`。

## 状态提示药丸

按钮右边跟一个小药丸，每 5 秒刷新，装插件时有呼吸点：

| 状态 | 文案 |
|---|---|
| 安装进行中 | 插件安装中 |
| 有安装排队 | 安装排队中 |
| 有会话在跑 | N 个会话运行中 |

这样即使不点按钮，也知道"现在不是重启的时候"。

## 安装感知：两条独立信号

只靠事件不够 —— 终端里跑 `dsh plugin install` 根本不发 request id。所以两路都读：

1. **插件管理器事件**（插件页 / 市场安装）
   - `plugin-manager/install-state`：每个 request id 的阶段与源尝试
   - `plugin-manager/install-log`：pnpm 输出流；一次运行的最后一帧带 `exitCode`
   - `plugin-manager/changed`：一次操作收尾，清空整张表
2. **profile 磁盘状态**（终端安装也覆盖）
   - `package.json.lock` 存在 = 有包操作握着 profile 写锁 → 判定为**排队**
   - `.plugin-manager/run.json` 存在 = 管理器正跑 pnpm（运行前写，`finally` 删）→ 判定为**安装中**

`run.json` 超过 30 分钟视为写入方已死留下的孤儿，自动不再计数。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-restart-center/api/status` | `{ok, running, runningSessions, install{active,queued,lockHeld,source,count,cancelling,registry,attempt}}` |
| POST | `/dsh-restart-center/api/restart` | 必须 body `{"force":true}` 才允许在忙碌时重启 |

仅回环地址（`127.0.0.1` / `::1`），其它来源 403；`status` 只接受 GET，`restart` 只接受 POST（405）；未知路由 404。

忙碌时**不带** `force` 一律 409 —— 直接调接口不会误杀正在生成的对话，也不会打断安装。

## 重启为什么走计划任务

**这台机器上实测**：由 Host 启动的子进程 —— `detached` 的、WMI `Win32_Process.Create` 创建的、Host 自己 `spawn` 的 —— 全部随应用进程树一起被杀。结果是应用关了、新的没起来，最坏的一种失败。

**Windows 计划任务是唯一能活下来再拉起应用的通道**。实现：Host 把启动脚本写到 `%TEMP%\dsh-restart-center-launch.ps1`，`schtasks /Create` 建一次性任务，`schtasks /Run` 触发。脚本自己先 `Unregister-ScheduledTask` 删任务，再按**安装根目录**（不是进程名）杀进程，最后 `Start-Process $exe --updated`。

`--updated` 是 Electron 主进程已有的分支（`raiseAfterUpdate`），让新窗口自动置顶抢焦点。

任务名固定 `DshRestartCenter`，重复点会覆盖；脚本执行时自己删掉，不残留。

## 验证

两套离线校验，都不碰浏览器也不碰真实重启：

```
node restart-control/_harness.mjs        # Host 侧：路由、状态判定
node restart-control/_client-check.mjs   # Client 侧：按状态渲染出的文案与色调
```

**Host（24/24）**：只统计 running 会话、短 id、GET/POST 方法守卫、未知路由、未确认 409、锁文件→排队、`run.json`→安装中、孤儿记录过期、事件安装中/取消中/`applying` 不算安装、操作完成清空、pnpm 输出与退出。

**Client（34/34）**：空态无药丸无弹窗、三种药丸与色调、两段弹窗的全部文案分支（安全/有会话/安装中带源位置/排队/读不到状态）、第三步按钮与危险色、同一时刻只有一个弹窗、中英文案与 id 分隔符。用 `__ModuleLoader__` 真实加载 `client.js`，React 用最小替身，所以查的是渲染路径而不是像素。

**未验证**：按钮在真实窗口里的像素位置、深浅色外观、以及真的点下去重启（计划任务会杀掉本进程树）。这几项需要你在窗口里目视确认。

**注意**：Host 模块不会热替换。装好后 Host 代码要等应用**重启一次**才换成新的；Client 侧代码随页面加载即生效。

## 回滚

```
dsh plugin --profile desktop remove dsh-restart-center
```

或在「插件」页把它停用。源码：`C:\asoftware\asession\dsh\restart-control`（以 link 方式装进 profile）。

## 许可

[MIT](LICENSE)
