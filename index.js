/**
 * dsh-restart-center — Host half.
 *
 * One loopback-only pair of endpoints for the Desktop window chrome's restart
 * control, plus a live picture of what a restart would interrupt:
 *
 * - `GET  /dsh-restart-center/api/status`  — how many sessions are mid-turn and
 *   whether the plugin manager is installing or waiting for the profile lock;
 * - `POST /dsh-restart-center/api/restart` — restart the whole Desktop
 *   application (Electron shell + this Host process).
 *
 * Why the restart runs as a Windows scheduled task: every process this Host
 * starts — `detached` children, WMI-created processes, and the Host's own
 * helpers — is torn down together with the application's process tree. Task
 * Scheduler starts its process outside that tree, which is the only launch path
 * that survives the kill it is about to perform. The launcher is written to a
 * temp `.ps1` and started with `-File`: passing the same body inline through
 * `/TR` does not survive the task engine's quote re-parsing.
 *
 * Install awareness has two independent sources, because neither is sufficient
 * on its own:
 *
 * - the plugin manager's events — `plugin-manager/install-state` names each
 *   request id, phase and registry attempt, and `plugin-manager/install-log`
 *   streams pnpm output (the final chunk of a run carries `exitCode`). These
 *   cover installs started from the Plugins page and the market;
 * - the profile's own on-disk state — `package.json.lock` exists exactly while
 *   a package operation holds the profile write lock, and the manager writes
 *   `.plugin-manager/run.json` when it starts pnpm and removes it when pnpm
 *   exits. These cover a `dsh plugin install` in a terminal, which emits no
 *   request id at all, and they are what makes "queued behind another
 *   operation" visible before pnpm has printed anything.
 *
 * A restart during an install is not silently allowed: the endpoint answers 409
 * unless the caller repeats the request with `force: true`, which the Client
 * sends only after its second confirmation dialog.
 *
 * Safety:
 * - only loopback peers are answered;
 * - POST only, so a prefetch or a link cannot trigger a restart;
 * - the kill is scoped to executables under this installation root, never by
 *   image name, so a second unrelated copy of the app is untouched.
 *
 * @module dsh-restart-center
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Route prefix for this plugin's API. */
const API_PREFIX = '/dsh-restart-center/api';

/** Deterministic task name: a retry replaces its own leftovers. */
const TASK_NAME = 'DshRestartCenter';

/** An install entry older than this is treated as abandoned, not active. */
const INSTALL_STALE_MS = 30 * 60 * 1000;

/** How long after the last pnpm line a run still counts as writing. */
const PNPM_ACTIVE_MS = 25 * 1000;

/**
 * A run record older than this is an orphan left by a writer whose process died
 * mid-run, not a live pnpm.
 */
const RUN_ACTIVE_MS = INSTALL_STALE_MS;

/** Whether a request came from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/** Escape a value for a single-quoted PowerShell literal. */
function psLiteral(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * Turn the observed install facts into one answer for the Client.
 *
 * `active` means pnpm is very likely writing the profile right now; `queued`
 * means an operation holds the profile lock without having produced output yet,
 * i.e. it is waiting for that lock or still preparing the run. Both postpone a
 * restart, and both stay separate so the dialog can say which one it is.
 *
 * @param input - Observed facts, all optional.
 * @param input.installs - Live manager events: phase, registry and attempt.
 * @param input.lockHeld - Whether `package.json.lock` exists in the profile.
 * @param input.runRecordAt - Epoch milliseconds of the manager's run record.
 * @param input.now - Reference time in epoch milliseconds.
 * @returns The install picture the Client renders.
 */
export function describeInstall(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const installs = Array.isArray(input.installs) ? input.installs : [];
  const live = installs.filter(
    (entry) => entry.phase === 'installing' || entry.phase === 'cancelling',
  );
  const runRecordAt = Number.isFinite(input.runRecordAt) ? input.runRecordAt : 0;
  const lockHeld = input.lockHeld === true;
  const running = runRecordAt > 0 && now - runRecordAt < RUN_ACTIVE_MS;
  const active = live.length > 0 || running;
  const queued = !active && lockHeld;
  const withAttempt = live.find((entry) => (Number(entry.total) || 0) > 0);
  const withRegistry = live.find((entry) => typeof entry.registry === 'string');
  return {
    active,
    queued,
    lockHeld,
    // Where the signal came from, for the dialog's detail line.
    source: live.length > 0 ? 'manager' : running || queued ? 'profile' : null,
    count: live.length,
    cancelling: live.filter((entry) => entry.phase === 'cancelling').length,
    registry: withRegistry?.registry ?? null,
    attempt:
      withAttempt === undefined
        ? null
        : { index: Number(withAttempt.index) || 1, total: Number(withAttempt.total) || 1 },
  };
}

/**
 * The launcher body. Runs outside the app's process tree, so it can outlive the
 * kill it performs.
 * @param exePath - Absolute path of the running Electron executable.
 * @param taskName - Task name to delete before relaunching.
 * @returns PowerShell source that stops this installation and relaunches it.
 */
function launcherScript(exePath, taskName) {
  const installRoot = `${dirname(exePath)}\\`;
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    // Give the HTTP response time to reach the page before the tree dies.
    'Start-Sleep -Milliseconds 1200',
    `$exe = ${psLiteral(exePath)}`,
    `$root = ${psLiteral(installRoot)}`,
    // Delete the task first: a stale entry must never outlive a restart.
    `Unregister-ScheduledTask -TaskName ${psLiteral(taskName)} -Confirm:$false`,
    'for ($i = 0; $i -lt 60; $i++) {',
    '  $left = @(Get-CimInstance Win32_Process | Where-Object {',
    '    $_.ExecutablePath -and',
    '    ($_.ExecutablePath -eq $exe -or $_.ExecutablePath.StartsWith($root))',
    '  })',
    '  if ($left.Count -eq 0) { break }',
    '  $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    'Start-Sleep -Milliseconds 600',
    // --updated makes the fresh window raise and take focus on Windows.
    'Start-Process -FilePath $exe -ArgumentList @("--updated")',
  ].join('\r\n');
}

export const name = 'dsh-restart-center';

export const inject = ['webServer'];

/**
 * Register the restart endpoints on the harness web server.
 * @param ctx - Host context carrying `webServer`, `agents`, `profileContext` and
 * the plugin manager's events.
 */
export function apply(ctx) {
  /** Live install requests, keyed by the manager's request id. */
  const installs = new Map();

  /** Last pnpm line seen for this profile, whichever caller produced it. */
  let lastPnpm = { at: 0, active: false };

  ctx.on('plugin-manager/install-state', (progress) => {
    const id = String(progress?.requestId ?? '');
    if (id === '') return;
    if (progress.phase === 'applying') {
      // pnpm is done; the bundle is being activated, which is not an install.
      installs.delete(id);
      return;
    }
    const attempt = progress.attempt;
    installs.set(id, {
      phase: progress.phase,
      since: installs.get(id)?.since ?? Date.now(),
      registry: typeof attempt?.registry === 'string' ? attempt.registry : null,
      index: Number(attempt?.index) || 0,
      total: Number(attempt?.total) || 0,
    });
  });

  ctx.on('plugin-manager/install-log', (chunk) => {
    const finished = typeof chunk?.exitCode === 'number' || chunk?.exitCode === null;
    lastPnpm = { at: Date.now(), active: !finished };
  });

  ctx.on('plugin-manager/changed', () => {
    // A completed operation drained the queue it owned; nothing it started can
    // still be installing.
    installs.clear();
    lastPnpm = { at: 0, active: false };
  });

  /** The profile directory this Host serves, from the service or the launch env. */
  const profileDir = () => {
    const candidates = [
      ctx.get('pluginManager')?.profile?.dir,
      ctx.get('profileContext')?.dir,
      process.env.DSH_PROFILE_DIR,
      join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop'),
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate === '') continue;
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
    return typeof candidates[2] === 'string' && candidates[2] !== '' ? candidates[2] : candidates[3];
  };

  /** Whether a package operation currently holds the profile write lock. */
  const lockHeld = () => existsSync(join(profileDir(), 'package.json.lock'));

  /**
   * The run record the manager writes when it starts pnpm and removes when it
   * exits, whatever started that run — the Plugins page, the market, or a `dsh
   * plugin install` in a terminal, which emits no request id at all.
   * @returns Epoch milliseconds of the record, or 0 when no run is recorded.
   */
  const lastManagerLogAt = () => {
    try {
      return statSync(join(profileDir(), '.plugin-manager', 'run.json')).mtimeMs;
    } catch {
      return 0;
    }
  };

  /** Drop entries whose owner vanished mid-operation. */
  const pruneInstalls = () => {
    const now = Date.now();
    for (const [id, entry] of installs) {
      if (now - entry.since > INSTALL_STALE_MS) installs.delete(id);
    }
  };

  /** Describe install activity for the Client. */
  const installState = () => {
    pruneInstalls();
    const now = Date.now();
    if (lastPnpm.active && now - lastPnpm.at > PNPM_ACTIVE_MS) lastPnpm.active = false;
    return describeInstall({
      installs: [...installs.values()],
      lockHeld: lockHeld(),
      runRecordAt: Math.max(lastManagerLogAt(), lastPnpm.active ? lastPnpm.at : 0),
      now,
    });
  };

  /** Live sessions that are mid-turn, as short ids for display. */
  const runningSessions = () => {
    const agents = ctx.get('agents');
    if (agents === undefined) return [];
    return agents
      .list()
      .filter((agent) => agent.status === 'running')
      .map((agent) => String(agent.id).replace(/^session-/u, '').slice(0, 8));
  };

  /**
   * Restart the whole application through Task Scheduler, which is the only
   * launch path that survives this process being killed.
   */
  const restart = async (res) => {
    const exe = process.execPath;
    if (!exe) {
      sendJson(res, 500, { error: '无法确定当前应用的可执行文件路径' });
      return;
    }
    const scriptPath = join(tmpdir(), 'dsh-restart-center-launch.ps1');
    try {
      writeFileSync(scriptPath, launcherScript(exe, TASK_NAME), 'utf8');
    } catch (error) {
      sendJson(res, 500, { error: `无法写入重启脚本：${String(error?.message ?? error)}` });
      return;
    }
    const command = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;
    try {
      await run(
        'schtasks.exe',
        ['/Create', '/TN', TASK_NAME, '/TR', command, '/SC', 'ONCE', '/ST', '00:00', '/F'],
        { windowsHide: true, timeout: 15000 },
      );
      await run('schtasks.exe', ['/Run', '/TN', TASK_NAME], { windowsHide: true, timeout: 15000 });
    } catch (error) {
      sendJson(res, 500, { error: `无法安排重启：${String(error?.message ?? error)}` });
      return;
    }
    sendJson(res, 200, { restarting: true, executable: exe });
  };

  /** Read whether the caller already confirmed an interruption. */
  const readForce = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        // A confirmation body is tiny; anything larger is not ours.
        if (body.length > 4096) resolve(false);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body === '' ? '{}' : body).force === true);
        } catch {
          resolve(false);
        }
      });
      req.on('error', () => resolve(false));
    });

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: '仅允许本机访问' });
      return;
    }
    const route = url.pathname.slice(API_PREFIX.length);
    if (route === '/status') {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const running = runningSessions();
      sendJson(res, 200, {
        ok: true,
        running: running.length,
        runningSessions: running,
        install: installState(),
        now: Date.now(),
      });
      return;
    }
    if (route !== '/restart') {
      sendJson(res, 404, { error: 'unknown route' });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }
    // A confirmed interruption is deliberate; an unconfirmed one is not, so a
    // direct API call can never discard a turn or break an install by accident.
    const force = await readForce(req);
    const running = runningSessions();
    const install = installState();
    if (!force && (running.length > 0 || install.active || install.queued)) {
      sendJson(res, 409, {
        error:
          running.length > 0
            ? `${String(running.length)} 个会话正在生成中，重启会中断它们`
            : '插件正在安装或排队，重启会打断安装',
        running: running.length,
        install,
      });
      return;
    }
    try {
      await restart(res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler,
      }),
    'dsh-restart-center: restart API',
  );
}

export default { name, inject, apply };