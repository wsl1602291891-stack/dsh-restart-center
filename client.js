window.__ModuleLoader__.load({
  id: 'dsh-restart-center',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-restart-center/api'
    const STATUS = `${API}/status`
    const RESTART = `${API}/restart`
    const GAP = 2

    /** Copy for both shipped locales. */
    const COPY = {
      zh: {
        label: '重启',
        busy: '重启中…',
        title: '重启应用与 Host（装完插件用它代替关掉再打开）',
        // 第一段：现状
        step1Title: '确认重启应用？',
        idle: '当前没有会话在运行，可以安心重启。',
        idleNote: '应用和 Host 会关闭后重新启动，已保存的会话不受影响。',
        running: (n, ids) =>
          `有 ${n} 个会话正在运行（${ids}），重启会中断正在生成的回复。`,
        runningNote: '其它已保存的会话不受影响；被中断的这一轮需要重新发送。',
        installActive: (detail) =>
          `插件正在安装中${detail}。现在重启会打断安装，并可能留下装了一半的依赖。`,
        installQueued: '有插件安装任务正在排队或准备中，现在重启会取消它。',
        installHint: '建议等安装结束（按钮旁的提示消失）再重启。',
        unknown: '没能读到当前运行状态，重启前请自行确认没有在跑的任务。',
        cancel: '取消',
        cont: '继续',
        // 第二段：最后确认
        step2Title: '最后确认：立即重启？',
        step2Body: '点「立即重启」后窗口会关闭，约 10 秒后自动重新打开；端口、模型与插件设置都会保留。',
        step2Warn: '被中断的生成不会自动续上。',
        back: '返回',
        confirm: '立即重启',
        failed: (message) => `重启失败：${message}`,
        unreachable: '连不上重启接口，请确认应用仍在运行',
        // 状态提示
        badgeInstalling: '插件安装中',
        badgeQueued: '安装排队中',
        badgeRunning: (n) => `${n} 个会话运行中`,
        badgeHintInstalling: '插件正在安装，装完再重启',
        badgeHintQueued: '有安装任务在排队，装完再重启',
        badgeHintRunning: '有会话正在生成，重启会中断',
      },
      en: {
        label: 'Restart',
        busy: 'Restarting…',
        title: 'Restart the app and Host (use this instead of closing and reopening after installing a plugin)',
        step1Title: 'Restart the app?',
        idle: 'No session is running, so it is safe to restart.',
        idleNote: 'The app and its Host close and start again; saved sessions are unaffected.',
        running: (n, ids) => `${n} session(s) are running (${ids}); restarting interrupts their replies.`,
        runningNote: 'Other saved sessions are unaffected; an interrupted turn has to be sent again.',
        installActive: (detail) =>
          `A plugin is installing${detail}. Restarting now interrupts it and can leave half-installed dependencies.`,
        installQueued: 'A plugin install is queued or preparing; restarting now cancels it.',
        installHint: 'Wait until the badge next to the button disappears.',
        unknown: 'The running state could not be read; confirm nothing is in flight before restarting.',
        cancel: 'Cancel',
        cont: 'Continue',
        step2Title: 'Final check: restart now?',
        step2Body: 'The window closes and reopens automatically in about 10 seconds; ports, models and plugin settings are kept.',
        step2Warn: 'An interrupted generation is not resumed automatically.',
        back: 'Back',
        confirm: 'Restart now',
        failed: (message) => `Restart failed: ${message}`,
        unreachable: 'Cannot reach the restart endpoint; check that the app is still running',
        badgeInstalling: 'Installing plugin',
        badgeQueued: 'Install queued',
        badgeRunning: (n) => `${n} running`,
        badgeHintInstalling: 'A plugin is installing; restart after it finishes',
        badgeHintQueued: 'An install is queued; restart after it finishes',
        badgeHintRunning: 'A session is generating; restarting interrupts it',
      },
    }

    /**
     * The Desktop shell mounts its Application/Edit menubar as a fixed shadow
     * host with no plugin slot, so the control is placed from that row's live
     * box and re-measured whenever it can move. In a browser, and on builds
     * without the caption menubar, the control stays hidden.
     */
    function findMenuHost() {
      return document.querySelector('[data-windows-menu]')
    }

    function measureLeft() {
      const host = findMenuHost()
      if (host === null) return null
      const rect = host.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return Math.round(rect.right + GAP)
    }

    /** Read the Host's live picture; a failure reads as unknown, never as idle. */
    async function readStatus() {
      try {
        const response = await fetch(STATUS, { cache: 'no-store' })
        if (!response.ok) return { ok: false }
        const body = await response.json()
        return {
          ok: body.ok === true,
          running: Number(body.running) || 0,
          runningSessions: Array.isArray(body.runningSessions) ? body.runningSessions : [],
          install: {
            active: body.install?.active === true,
            queued: body.install?.queued === true,
            registry: typeof body.install?.registry === 'string' ? body.install.registry : null,
            attempt: body.install?.attempt ?? null,
          },
        }
      } catch {
        return { ok: false }
      }
    }

    /**
     * Human detail for an install attempt, e.g. "（第 2/2 个源 · registry.npmmirror.com）".
     * The Host reports the registry on the install itself and the position in
     * `attempt`; the trailing slash a registry URL carries is noise here.
     */
    function attemptDetail(copy, install) {
      const total = Number(install?.attempt?.total) || 0
      const registry = String(install?.registry ?? '')
        .replace(/^https?:\/\//u, '')
        .replace(/\/+$/u, '')
      const name = registry === '' ? '' : ` · ${registry}`
      if (total === 0) return registry === '' ? '' : copy === COPY.zh ? `（源：${registry}）` : ` (source ${registry})`
      const index = Number(install.attempt.index) || 1
      return copy === COPY.zh
        ? `（第 ${index}/${total} 个源${name}）`
        : ` (source ${index}/${total}${name})`
    }

    function RestartCenter({ ctx }) {
      // Start in the active locale, so the first paint is never the wrong language.
      const [copy, setCopy] = React.useState(() =>
        ctx.locale.getSnapshot().active === 'en' ? COPY.en : COPY.zh,
      )
      const [left, setLeft] = React.useState(null)
      const [phase, setPhase] = React.useState('idle')
      const [status, setStatus] = React.useState({ ok: false })
      const [step, setStep] = React.useState(0)
      const [error, setError] = React.useState('')
      const cancelRef = React.useRef(null)

      React.useEffect(() => {
        const read = () => {
          const snapshot = ctx.locale.getSnapshot()
          setCopy(snapshot.active === 'en' ? COPY.en : COPY.zh)
        }
        read()
        return ctx.locale.subscribe(read)
      }, [])

      // Follow the menubar's live position: window resize, sidebar collapse and
      // shell re-renders can all move it.
      React.useEffect(() => {
        let frame = 0
        const sync = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            setLeft((current) => {
              const next = measureLeft()
              return next === current ? current : next
            })
          })
        }
        sync()
        window.addEventListener('resize', sync)
        const timer = window.setInterval(sync, 1000)
        const observer = new MutationObserver(sync)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          window.clearInterval(timer)
          window.removeEventListener('resize', sync)
          observer.disconnect()
        }
      }, [])

      // Keep the ambient badge (install / running) current while the page lives.
      React.useEffect(() => {
        let cancelled = false
        const poll = async () => {
          const next = await readStatus()
          if (!cancelled) setStatus(next)
        }
        poll()
        const timer = window.setInterval(poll, 5000)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [])

      // Focus lands on the safe button, so a stray Enter cannot restart the app.
      React.useEffect(() => {
        if (step === 0) return
        cancelRef.current?.focus()
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setStep(0)
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [step])

      if (left === null) return null

      const busy = phase === 'busy'
      const install = status.install ?? { active: false, queued: false }
      const running = Number(status.running) || 0

      const open = async () => {
        if (busy) return
        setError('')
        const next = await readStatus()
        setStatus(next)
        setStep(1)
      }

      const close = () => {
        setStep(0)
      }

      const confirm = async () => {
        setStep(0)
        setPhase('busy')
        try {
          const response = await fetch(RESTART, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // The user has now passed both dialogs; the Host still refuses an
            // unconfirmed call, so this flag is what unlocks it.
            body: JSON.stringify({ force: true }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok || body.restarting !== true) {
            throw new Error(body.error ?? `HTTP ${response.status}`)
          }
          // The launcher kills this page shortly; stay busy so a second click
          // cannot stack another restart.
        } catch (cause) {
          setError(copy.failed(String(cause?.message ?? cause)))
          setPhase('idle')
        }
      }

      // 中文用顿号，英文用逗号 + 空格。
      const ids = (status.runningSessions ?? []).join(copy === COPY.zh ? '、' : ', ')

      const badge = install.active
        ? { text: copy.badgeInstalling, hint: copy.badgeHintInstalling, tone: 'installing' }
        : install.queued
          ? { text: copy.badgeQueued, hint: copy.badgeHintQueued, tone: 'queued' }
          : running > 0
            ? { text: copy.badgeRunning(running), hint: copy.badgeHintRunning, tone: 'running' }
            : null

      const button = h(
        'button',
        {
          type: 'button',
          className: 'dsh-rc-button',
          title: error === '' ? copy.title : error,
          'aria-label': copy.title,
          'aria-busy': busy ? 'true' : 'false',
          disabled: busy,
          onClick: open,
        },
        busy ? copy.busy : copy.label,
      )

      const pill =
        badge === null
          ? null
          : h(
              'span',
              {
                className: `dsh-rc-pill is-${badge.tone}`,
                title: badge.hint,
              },
              h('span', { className: 'dsh-rc-dot', 'aria-hidden': 'true' }),
              badge.text,
            )

      const line = (text, tone) =>
        h('p', { className: tone === undefined ? 'dsh-rc-body' : `dsh-rc-body is-${tone}` }, text)

      const dialogOne =
        step !== 1
          ? null
          : h(
              'div',
              {
                className: 'dsh-rc-scrim',
                onPointerDown: (event) => {
                  if (event.target === event.currentTarget) close()
                },
              },
              h(
                'div',
                {
                  className: 'dsh-rc-dialog',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-labelledby': 'dsh-rc-title-1',
                },
                h('h2', { id: 'dsh-rc-title-1', className: 'dsh-rc-title' }, copy.step1Title),
                status.ok === false
                  ? line(copy.unknown, 'warn')
                  : running > 0
                    ? line(copy.running(running, ids), 'warn')
                    : line(copy.idle, 'calm'),
                status.ok === false ? null : line(running > 0 ? copy.runningNote : copy.idleNote),
                install.active
                  ? line(copy.installActive(attemptDetail(copy, install)), 'danger')
                  : install.queued
                    ? line(copy.installQueued, 'danger')
                    : null,
                install.active || install.queued ? line(copy.installHint, 'muted') : null,
                h(
                  'div',
                  { className: 'dsh-rc-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-rc-action',
                      ref: cancelRef,
                      onClick: close,
                    },
                    copy.cancel,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-rc-action is-primary',
                      onClick: () => setStep(2),
                    },
                    copy.cont,
                  ),
                ),
              ),
            )

      const dialogTwo =
        step !== 2
          ? null
          : h(
              'div',
              {
                className: 'dsh-rc-scrim',
                onPointerDown: (event) => {
                  if (event.target === event.currentTarget) close()
                },
              },
              h(
                'div',
                {
                  className: 'dsh-rc-dialog',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-labelledby': 'dsh-rc-title-2',
                },
                h('h2', { id: 'dsh-rc-title-2', className: 'dsh-rc-title' }, copy.step2Title),
                line(copy.step2Body),
                running > 0 ? line(copy.step2Warn, 'warn') : null,
                install.active || install.queued ? line(copy.installHint, 'muted') : null,
                h(
                  'div',
                  { className: 'dsh-rc-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-rc-action',
                      ref: cancelRef,
                      onClick: close,
                    },
                    copy.back,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-rc-action is-danger',
                      onClick: confirm,
                    },
                    copy.confirm,
                  ),
                ),
              ),
            )

      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            style: {
              position: 'fixed',
              top: 0,
              left: `${left}px`,
              // The overlay layer is a stacking context at 20; the Desktop
              // menubar sits at 1100 and the control is placed past its right
              // edge, so 1100 keeps it level with the chrome row.
              zIndex: 1100,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              height: 'var(--dsh-windows-titlebar-height, 40px)',
              WebkitAppRegion: 'no-drag',
            },
          },
          button,
          pill,
        ),
        step === 0
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1200,
                  WebkitAppRegion: 'no-drag',
                },
              },
              dialogOne,
              dialogTwo,
            ),
        h('style', null, `
          .dsh-rc-button {
            height: 28px;
            padding: 0 10px;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: var(--dsw-alias-label-secondary);
            font: inherit;
            font-size: 13px;
            line-height: 1;
            cursor: default;
            white-space: nowrap;
            transition: background-color 120ms ease, color 120ms ease;
          }
          .dsh-rc-button:hover:not(:disabled),
          .dsh-rc-button:focus-visible {
            background: var(--dsw-alias-bg-layer-2);
            color: var(--dsw-alias-label-primary);
          }
          .dsh-rc-button:focus-visible {
            outline: 2px solid var(--dsw-alias-brand-primary);
            outline-offset: -2px;
          }
          .dsh-rc-button:disabled { opacity: 0.6; }

          .dsh-rc-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 22px;
            padding: 0 9px;
            border-radius: 999px;
            border: 0.5px solid var(--dsw-alias-border-l2);
            background: var(--dsw-alias-bg-layer-2);
            color: var(--dsw-alias-label-secondary);
            font-size: 12px;
            line-height: 1;
            white-space: nowrap;
            cursor: default;
          }
          .dsh-rc-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
            opacity: 0.9;
          }
          .dsh-rc-pill.is-installing { color: var(--dsw-alias-brand-primary); }
          .dsh-rc-pill.is-installing .dsh-rc-dot { animation: dsh-rc-pulse 1.1s ease-in-out infinite; }
          .dsh-rc-pill.is-queued { color: var(--dsw-alias-state-warn-primary); }
          .dsh-rc-pill.is-running { color: var(--dsw-alias-state-warn-primary); }
          @keyframes dsh-rc-pulse {
            0%, 100% { opacity: 0.35; transform: scale(0.85); }
            50% { opacity: 1; transform: scale(1.15); }
          }

          .dsh-rc-scrim {
            position: fixed;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.42);
          }
          .dsh-rc-dialog {
            width: min(440px, calc(100vw - 48px));
            box-sizing: border-box;
            padding: 20px;
            border-radius: 14px;
            border: 0.5px solid var(--dsw-alias-border-l1);
            background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
            color: var(--dsw-alias-label-primary);
          }
          .dsh-rc-title {
            margin: 0 0 10px;
            font-size: 16px;
            font-weight: 650;
            line-height: 24px;
          }
          .dsh-rc-body {
            margin: 0 0 8px;
            font-size: 14px;
            line-height: 22px;
            color: var(--dsw-alias-label-secondary);
            overflow-wrap: break-word;
          }
          .dsh-rc-body:last-of-type { margin-bottom: 0; }
          .dsh-rc-body.is-calm { color: var(--dsw-alias-state-success-primary); }
          .dsh-rc-body.is-warn { color: var(--dsw-alias-state-warn-primary); }
          .dsh-rc-body.is-danger { color: var(--dsw-alias-state-error-primary); }
          .dsh-rc-body.is-muted {
            font-size: 13px;
            line-height: 20px;
            color: var(--dsw-alias-label-secondary);
            opacity: 0.85;
          }
          .dsh-rc-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 18px;
          }
          .dsh-rc-action {
            height: 32px;
            padding: 0 14px;
            border-radius: 8px;
            border: 0.5px solid var(--dsw-alias-border-l2);
            background: transparent;
            color: var(--dsw-alias-label-primary);
            font: inherit;
            font-size: 13px;
            cursor: default;
            transition: background-color 120ms ease;
          }
          .dsh-rc-action:hover { background: var(--dsw-alias-bg-layer-2); }
          .dsh-rc-action:focus-visible {
            outline: 2px solid var(--dsw-alias-brand-primary);
            outline-offset: 2px;
          }
          .dsh-rc-action.is-primary {
            border-color: transparent;
            background: var(--dsw-alias-brand-primary);
            color: #fff;
          }
          .dsh-rc-action.is-primary:hover { filter: brightness(1.08); }
          .dsh-rc-action.is-danger {
            border-color: transparent;
            background: var(--dsw-alias-state-error-primary);
            color: #fff;
          }
          .dsh-rc-action.is-danger:hover { filter: brightness(1.08); }
          @media (prefers-reduced-motion: reduce) {
            .dsh-rc-button, .dsh-rc-action { transition: none; }
            .dsh-rc-pill.is-installing .dsh-rc-dot { animation: none; }
          }
        `),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register(
                { name: 'shell.overlay', id: 'dsh-restart-center', order: 100 },
                () => h(RestartCenter, { ctx }),
              ),
            ),
          'dsh-restart-center: chrome control',
        )
      },
    }
  },
})