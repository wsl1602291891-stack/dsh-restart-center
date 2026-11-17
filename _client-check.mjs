/**
 * Offline render check for the dsh-restart-center Client half.
 *
 * There is no browser control here, so instead of a screenshot the module is
 * loaded the way the page loads it (`window.__ModuleLoader__`) with a minimal
 * React stand-in: createElement returns plain nodes, useState/useRef are
 * array-backed, and effects are skipped because the DOM probes they read do not
 * exist here. The component is then rendered for each state and the produced
 * tree is asserted — text, classes and dialog buttons — which catches a broken
 * render path, not the pixels.
 *
 * Run with: node restart-control/_client-check.mjs
 */

import { readFileSync } from 'node:fs';

let hooks = [];
let cursor = 0;
const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children
        .flat()
        .filter((child) => child !== null && child !== undefined && child !== false),
    };
  },
  useState(initial) {
    const index = cursor++;
    if (hooks[index] === undefined) {
      hooks[index] = typeof initial === 'function' ? initial() : initial;
    }
    return [
      hooks[index],
      (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    if (hooks[index] === undefined) hooks[index] = { current: initial ?? null };
    return hooks[index];
  },
  useEffect() {
    cursor++;
  },
};

const registered = [];
const stubs = {
  window: {
    __ModuleLoader__: { load: (entry) => registered.push(entry) },
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  },
  document: {
    querySelector: () => ({ getBoundingClientRect: () => ({ right: 120, width: 120, height: 40 }) }),
    body: { append() {} },
  },
};
globalThis.window = stubs.window;
globalThis.document = stubs.document;
globalThis.fetch = async () => {
  throw new Error('fetch is stubbed');
};

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const load = new Function(
  'window',
  'document',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'fetch',
  source,
);
load(
  stubs.window,
  stubs.document,
  stubs.window.requestAnimationFrame,
  stubs.window.cancelAnimationFrame,
  stubs.window.MutationObserver,
  globalThis.fetch,
);

const entry = registered[0];
const mod = entry.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
};

check('module id is the package name', entry.id === 'dsh-restart-center', entry.id);
check('declares slots and locale', mod.inject.includes('slots') && mod.inject.includes('locale'));

function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  for (const child of node.children ?? []) texts(child, out);
  return out;
}

function byClass(node, fragment, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) byClass(child, fragment, out);
    return out;
  }
  if (String(node.props?.className ?? '').includes(fragment)) out.push(node);
  for (const child of node.children ?? []) byClass(child, fragment, out);
  return out;
}

const ctx = {
  locale: {
    getSnapshot: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  },
};

let overlay;
// `apply` receives the same Client context the shell gives the module, and the
// component reads `ctx.locale` from the closure apply created.
mod.apply({
  locale: ctx.locale,
  effect: (callback) => callback(),
  slots: {
    inject: (_slot, callback) => {
      callback();
      return () => {};
    },
    register: (options, component) => {
      overlay = { options, component };
      return () => {};
    },
  },
});

check('registers into shell.overlay', overlay?.options?.name === 'shell.overlay', overlay?.options?.name);
check('uses its own cell id', overlay?.options?.id === 'dsh-restart-center');

/**
 * Render the control at one state. Hook slots match the component's order:
 * copy, left, phase, status, step, error, cancelRef.
 */
function render(status, step) {
  hooks = [undefined, 120, 'idle', status, step, '', undefined];
  cursor = 0;
  // The slot renders a wrapper element; the real component is its element type.
  const element = overlay.component({ ctx });
  return typeof element.type === 'function' ? element.type(element.props) : element;
}

const idleStatus = { ok: true, running: 0, runningSessions: [], install: { active: false, queued: false } };
const busyStatus = {
  ok: true,
  running: 2,
  runningSessions: ['acc52b2f', '226c114f'],
  install: { active: false, queued: false },
};
const installStatus = {
  ok: true,
  running: 0,
  runningSessions: [],
  install: {
    active: true,
    queued: false,
    registry: 'https://registry.npmmirror.com/',
    attempt: { index: 2, total: 2 },
  },
};

const idle = render(idleStatus, 0);
const idleText = texts(idle).join(' ');
check('button label', idleText.includes('重启'), idleText.slice(0, 40));
check('no pill when idle', byClass(idle, 'dsh-rc-pill').length === 0);
check('no dialog at rest', byClass(idle, 'dsh-rc-scrim').length === 0);

const running = render(busyStatus, 0);
check('running pill', texts(running).join(' ').includes('2 个会话运行中'));
check('running pill tone', byClass(running, 'is-running').length === 1);

const installing = render(installStatus, 0);
check('installing pill', texts(installing).join(' ').includes('插件安装中'));
check('installing pill tone', byClass(installing, 'is-installing').length === 1);

const queued = render({ ok: true, running: 0, runningSessions: [], install: { active: false, queued: true } }, 0);
check('queued pill', texts(queued).join(' ').includes('安装排队中'));

const step1Idle = render(idleStatus, 1);
const step1IdleText = texts(step1Idle).join(' ');
check('idle dialog title', step1IdleText.includes('确认重启应用？'));
check('idle dialog says it is safe', step1IdleText.includes('当前没有会话在运行，可以安心重启'));
check('idle dialog keeps a note', step1IdleText.includes('已保存的会话不受影响'));
check('idle dialog has no warning tone', byClass(step1Idle, 'is-warn').length === 0);

const step1Busy = render(busyStatus, 1);
const step1BusyText = texts(step1Busy).join(' ');
check('busy dialog names the count', step1BusyText.includes('有 2 个会话正在运行'));
check('busy dialog lists the ids', step1BusyText.includes('acc52b2f、226c114f'), step1BusyText.slice(0, 150));
check('busy dialog uses the warning tone', byClass(step1Busy, 'is-warn').length >= 1);

const step1Install = render(installStatus, 1);
const step1InstallText = texts(step1Install).join(' ');
check('install dialog says installing', step1InstallText.includes('插件正在安装中'));
check('install dialog shows the source attempt', step1InstallText.includes('第 2/2 个源'), step1InstallText.slice(0, 200));
check('install dialog uses the danger tone', byClass(step1Install, 'is-danger').length >= 1);
check('install dialog advises waiting', step1InstallText.includes('建议等安装结束'));

const step1Queued = render({ ok: true, running: 0, runningSessions: [], install: { active: false, queued: true } }, 1);
check('queued dialog explains the cancel', texts(step1Queued).join(' ').includes('排队或准备中'));

const unknown = render({ ok: false }, 1);
const unknownText = texts(unknown).join(' ');
check('unknown status is not called safe', !unknownText.includes('可以安心重启'));
check('unknown status warns instead', unknownText.includes('没能读到当前运行状态'));

const step2 = render({ ...busyStatus, running: 1, runningSessions: ['acc52b2f'] }, 2);
const step2Text = texts(step2).join(' ');
check('step 2 title', step2Text.includes('最后确认：立即重启？'));
check('step 2 states the reopen delay', step2Text.includes('约 10 秒后自动重新打开'));
check('step 2 warns about the interrupted turn', step2Text.includes('不会自动续上'));
check('step 2 offers back and restart', step2Text.includes('返回') && step2Text.includes('立即重启'));
check('step 2 keeps the danger action', byClass(step2, 'is-danger').length >= 1);

check(
  'only one dialog per step',
  byClass(step1Busy, 'dsh-rc-scrim').length === 1 && byClass(step2, 'dsh-rc-scrim').length === 1,
);

ctx.locale.getSnapshot = () => ({ active: 'en' });
const english = render(busyStatus, 1);
const englishText = texts(english).join(' ');
check('english dialog title', englishText.includes('Restart the app?'));
check('english lists ids with commas', englishText.includes('acc52b2f, 226c114f'), englishText.slice(0, 170));

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`);
if (failed.length > 0) process.exitCode = 1;