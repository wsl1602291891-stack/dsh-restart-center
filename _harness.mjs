/**
 * Offline harness for the dsh-restart-center Host half.
 *
 * A Host module is not hot-replaced inside a running app, so the route
 * behaviour is exercised here against a fake Cordis context: `webServer.register`
 * captures the handler, `agents` reports live sessions, `pluginManager` carries
 * the profile directory, and `on` records the load-bearing event listeners.
 *
 * The launcher itself is deliberately not exercised: it kills this process tree.
 * Only the gates in front of it are asserted.
 *
 * Run with: node restart-control/_harness.mjs
 */

import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = join(tmpdir(), `dsh-rc-harness-${String(process.pid)}`);
mkdirSync(join(profile, '.plugin-manager'), { recursive: true });
writeFileSync(join(profile, 'package.json'), '{}\n');

const plugin = await import('file:///C:/asoftware/asession/dsh/restart-control/index.js');

let handler;
const listeners = new Map();
const emit = (name, payload) => {
  for (const listener of listeners.get(name) ?? []) listener(payload);
};

const sessions = [
  { id: 'session-acc52b2f-0000', status: 'running' },
  { id: 'session-9d1c7c10-1111', status: 'idle' },
];

const ctx = {
  webServer: {
    register(route) {
      handler = route.handler;
      return () => {
        handler = undefined;
      };
    },
  },
  effect(callback) {
    callback();
  },
  get(name) {
    if (name === 'pluginManager') return { profile: { dir: profile } };
    if (name === 'agents') return { list: () => sessions };
    return undefined;
  },
  on(name, listener) {
    const list = listeners.get(name) ?? [];
    list.push(listener);
    listeners.set(name, list);
    return () => {};
  },
};

plugin.apply(ctx);

function call(method, path, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: path,
      socket: { remoteAddress: '127.0.0.1' },
      on(event, callback) {
        if (event === 'data' && body !== undefined) callback(body);
        if (event === 'end') callback();
      },
    };
    const chunks = [];
    const res = {
      headersSent: false,
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers ?? {};
        this.headersSent = true;
      },
      end(text) {
        if (text !== undefined) chunks.push(text);
        const raw = chunks.join('');
        resolve({
          status: this.status,
          headers: this.headers,
          raw,
          body: raw === '' ? null : JSON.parse(raw),
        });
      },
    };
    handler(req, res);
  });
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
};

const status = () => call('GET', '/dsh-restart-center/api/status');
const restart = (payload) => call('POST', '/dsh-restart-center/api/restart', payload);

let r = await status();
check('status answers 200', r.status === 200, JSON.stringify(r.body));
check('only the running session is counted', r.body.running === 1, `running=${String(r.body.running)}`);
check('running session is shown by short id', r.body.runningSessions[0] === 'acc52b2f');
check('no install activity at rest', r.body.install.active === false && r.body.install.queued === false);

r = await call('POST', '/dsh-restart-center/api/status');
check('status rejects POST (405)', r.status === 405);

r = await call('GET', '/dsh-restart-center/api/nope');
check('unknown route answers 404', r.status === 404);

r = await restart('{}');
check('unconfirmed restart is refused (409)', r.status === 409, r.body?.error);
check('refusal names the running session count', r.body?.running === 1);

writeFileSync(join(profile, 'package.json.lock'), '');
r = await status();
check('profile lock reads as queued', r.body.install.queued === true, JSON.stringify(r.body.install));
r = await restart('{}');
check('queued install is refused (409)', r.status === 409);
rmSync(join(profile, 'package.json.lock'));

const runRecord = join(profile, '.plugin-manager', 'run.json');
writeFileSync(runRecord, '{"pid":4242,"grouped":true}\n');
r = await status();
check('run record reads as active', r.body.install.active === true, JSON.stringify(r.body.install));
check('active install is attributed to the profile', r.body.install.source === 'profile');
r = await restart('{}');
check('active install is refused (409)', r.status === 409, r.body?.error);
const old = (Date.now() - 40 * 60 * 1000) / 1000;
utimesSync(runRecord, old, old);
r = await status();
check('stale run record stops counting', r.body.install.active === false, JSON.stringify(r.body.install));
rmSync(runRecord);

emit('plugin-manager/install-state', {
  requestId: 'req-1',
  phase: 'installing',
  attempt: { registry: 'https://registry.npmmirror.com/', index: 2, total: 2 },
});
r = await status();
check('manager install reads as active', r.body.install.active === true, JSON.stringify(r.body.install));
check('registry is surfaced', r.body.install.registry === 'https://registry.npmmirror.com/');
check('registry attempt is surfaced', r.body.install.attempt?.index === 2 && r.body.install.attempt?.total === 2);
check('manager install is attributed to the manager', r.body.install.source === 'manager');

r = await restart('{}');
check('manager install is refused (409)', r.status === 409, r.body?.error);

emit('plugin-manager/install-state', { requestId: 'req-1', phase: 'applying' });
r = await status();
check('applying a bundle is not an install', r.body.install.active === false, JSON.stringify(r.body.install));

emit('plugin-manager/install-state', { requestId: 'req-2', phase: 'cancelling' });
r = await status();
check('a cancelling install still counts', r.body.install.active === true && r.body.install.cancelling === 1);

emit('plugin-manager/changed', { reason: 'install' });
r = await status();
check(
  'a completed operation clears the picture',
  r.body.install.active === false && r.body.install.queued === false,
);

emit('plugin-manager/install-log', { stream: 'stdout', text: 'Progress' });
r = await status();
check('pnpm output reads as active', r.body.install.active === true, JSON.stringify(r.body.install));
emit('plugin-manager/install-log', { stream: 'stdout', text: '', exitCode: 0 });
r = await status();
check('pnpm exit clears it', r.body.install.active === false, JSON.stringify(r.body.install));

rmSync(profile, { recursive: true, force: true });
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`);
if (failed.length > 0) process.exitCode = 1;
