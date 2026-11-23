/**
 * dsh-float-panel — page half.
 *
 * The floating window is native and the host half owns all state, so this
 * module only closes the loop between them:
 *
 *   1. tell the host which conversation is on screen (the panel marks it),
 *   2. carry out what the user clicked in the panel — settle an approval or a
 *      question through the very PendingApproval/PendingQuestion instance the
 *      page already holds (the host never answers on the user's behalf), or
 *      open a session,
 *   3. offer a small "浮窗" affordance while the window is closed, so it can be
 *      reopened without hunting for a menu.
 *
 * Everything here is defensive: the client APIs it touches are internal to a
 * DSH version, so each one is looked up lazily and every failure degrades to
 * "the button does nothing" instead of breaking the app.
 */
(function (root) {
  'use strict';

  root.__ModuleLoader__.load({
    id: 'dsh-float-panel',
    factory: function (require) {
      var module = { exports: {} };
      var React = require('react');

      var inject = ['slots'];
      var PREFIX = '/float-panel';

      function baseUrl() {
        try {
          var transport = window.__DSH_TRANSPORT__;
          if (transport && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl) {
            return transport.streamBaseUrl.replace(/\/$/, '');
          }
        } catch (error) { /* browser mode */ }
        return location.origin;
      }

      function lookupService(ctx, name) {
        var service = null;
        try {
          if (typeof ctx.get === 'function') service = ctx.get(name) || null;
        } catch (error) { service = null; }
        if (service) return service;
        try {
          if (ctx.reflect && typeof ctx.reflect.get === 'function') service = ctx.reflect.get(name) || null;
        } catch (error) { service = null; }
        if (service) return service;
        try {
          if (name in ctx) service = ctx[name] || null;
        } catch (error) { service = null; }
        return service;
      }

      function isStore(value) {
        return !!value && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function';
      }

      /** The pending interaction of one session, whichever store the host has. */
      function pendingFor(uiSession, sessionId) {
        if (!uiSession) return null;
        if (isStore(uiSession.sessionStatus)) {
          var status = uiSession.sessionStatus.getSnapshot();
          var entry = status && typeof status.get === 'function' ? status.get(sessionId) : null;
          return entry && entry.pendingInteraction ? entry.pendingInteraction : null;
        }
        if (isStore(uiSession.pendingInteractions)) {
          var legacy = uiSession.pendingInteractions.getSnapshot();
          if (!legacy) return null;
          return (typeof legacy.get === 'function' ? legacy.get(sessionId) : null) || null;
        }
        return null;
      }

      function apply(ctx, config) {
        var base = baseUrl();
        var seen = {};
        var running = false;
        var listeners = new Set();
        var openedOnce = false;
        var source = null;
        var currentId = null;
        var disposed = false;

        function emit() {
          for (var listener of Array.from(listeners)) {
            try { listener(); } catch (error) { /* a listener must not break the shell */ }
          }
        }

        function setRunning(next) {
          if (running === next) return;
          running = next;
          emit();
        }

        function post(path, body) {
          return fetch(base + PREFIX + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
            credentials: 'omit',
          }).then(function (res) { return res.json().catch(function () { return {}; }); });
        }

        // ── 1. which conversation is on screen ──

        function reportCurrent(sessionId) {
          if (sessionId === currentId) return;
          currentId = sessionId;
          post('/current', { sessionId: sessionId || null }).catch(function () { /* the panel simply shows no "当前" chip */ });
        }

        // uiSession may arrive after this bundle applies, so keep trying for a
        // while instead of silently never reporting the visible conversation.
        var watchTimer = null;
        var watchTries = 0;
        function watchCurrent() {
          if (disposed) return;
          var uiSession = lookupService(ctx, 'uiSession');
          if (!uiSession || !uiSession.current || typeof uiSession.current.subscribe !== 'function') {
            watchTries += 1;
            if (watchTries < 40) watchTimer = setTimeout(watchCurrent, 1500);
            return;
          }
          var readCurrent = function () {
            try {
              var value = uiSession.current.getSnapshot();
              reportCurrent(value && typeof value.key === 'string' ? value.key : null);
            } catch (error) { /* binding not materialized yet */ }
          };
          ctx.effect(function () {
            var off = uiSession.current.subscribe(readCurrent);
            return function () {
              try { off(); } catch (error) { /* already gone */ }
              reportCurrent(null);
            };
          }, 'dsh-float-panel: current session');
          readCurrent();
        }
        watchCurrent();

        // ── 2. commands from the floating window ──

        function handleCommand(command) {
          if (!command || typeof command !== 'object') return;
          if (typeof command.cmdId === 'string') {
            if (seen[command.cmdId]) return;
            seen[command.cmdId] = true;
            var keys = Object.keys(seen);
            if (keys.length > 200) for (var i = 0; i < keys.length - 120; i += 1) delete seen[keys[i]];
          }
          var sessionId = typeof command.sessionId === 'string' ? command.sessionId : '';
          if (!sessionId) return;
          var live = lookupService(ctx, 'uiSession');

          if (command.type === 'approval') {
            var approval = pendingFor(live, sessionId);
            if (!approval || approval.kind !== 'approval') return;
            if (approval.answerable === false) return;
            var outcome = command.outcome === 'rejected' ? 'rejected' : 'allowed-once';
            try {
              Promise.resolve(approval.answer(outcome)).catch(function () { /* already settled */ });
            } catch (error) { /* already settled */ }
            return;
          }

          if (command.type === 'answer') {
            var pending = pendingFor(live, sessionId);
            if (!pending || typeof pending.answer !== 'function' || !Array.isArray(pending.questions)) return;
            var questionId = typeof command.questionId === 'string' ? command.questionId : '';
            var label = typeof command.label === 'string' ? command.label : '';
            var target = null;
            for (var q of pending.questions) {
              if (q && q.id === questionId) { target = q; break; }
            }
            if (!target) return;
            try {
              Promise.resolve(pending.answer({ answers: [{ id: questionId, selected: [label] }] }))
                .catch(function () { /* no channel accepts it yet: the user answers in the page */ });
            } catch (error) { /* the page keeps the question */ }
            return;
          }

          if (command.type === 'open') {
            var workspace = lookupService(ctx, 'uiWorkspace');
            if (workspace && typeof workspace.openSession === 'function') {
              try {
                Promise.resolve(workspace.openSession(sessionId)).catch(function () { /* the user clicks the card in the list */ });
              } catch (error) { /* the user clicks the card in the list */ }
            }
          }
        }

        // ── 3. live link to the host ──

        function connect() {
          if (disposed || typeof EventSource === 'undefined') return;
          try {
            source = new EventSource(base + PREFIX + '/events');
          } catch (error) {
            return;
          }
          source.addEventListener('hello', function (event) {
            try {
              var data = JSON.parse(event.data);
              if (data && typeof data.running === 'boolean') setRunning(data.running);
            } catch (error) { /* keep the last known value */ }
          });
          source.addEventListener('panel', function (event) {
            try {
              var data = JSON.parse(event.data);
              if (data && typeof data.running === 'boolean') setRunning(data.running);
            } catch (error) { /* keep the last known value */ }
          });
          source.addEventListener('cmd', function (event) {
            try {
              handleCommand(JSON.parse(event.data));
            } catch (error) { /* one malformed command must not kill the feed */ }
          });
          source.onerror = function () {
            if (source) { try { source.close(); } catch (error) { /* closed */ } source = null; }
            if (disposed) return;
            // The host may be restarting; retry gently, forever.
            setTimeout(connect, 2000);
          };
        }

        ctx.effect(function () {
          connect();
          return function () {
            disposed = true;
            if (watchTimer) clearTimeout(watchTimer);
            if (source) { try { source.close(); } catch (error) { /* closed */ } source = null; }
            listeners.clear();
          };
        }, 'dsh-float-panel: host feed');

        // ── 4. the in-app "浮窗" affordance ──

        function openPanel() {
          if (openedOnce) return;
          openedOnce = true;
          post('/panel/open', {}).then(function (res) {
            if (res && res.ok) {
              setRunning(true);
              return;
            }
            openedOnce = false;
            flashReason(res && res.reason);
          }).catch(function () {
            openedOnce = false;
          });
        }

        function flashReason(reason) {
          try {
            console.warn('[dsh-float-panel] cannot open the floating window:', reason);
          } catch (error) { /* no console */ }
        }

        function FloatButton() {
          var pair = React.useState(running);
          var visible = pair[0];
          var setVisible = pair[1];
          React.useEffect(function () {
            setVisible(running);
            return subscribe(function () { setVisible(running); });
          }, []);
          if (visible) return null;
          return React.createElement(
            'button',
            {
              type: 'button',
              onClick: openPanel,
              title: '打开任务浮窗，在其他应用上方查看进度与审批',
              style: {
                position: 'fixed',
                right: '18px',
                bottom: '18px',
                zIndex: 2147483000,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                height: '30px',
                padding: '0 12px',
                border: '1px solid var(--dsw-alias-border-default, rgba(255,255,255,0.14))',
                borderRadius: '999px',
                background: 'var(--dsw-alias-bg-elevated, #1c1c20)',
                color: 'var(--dsw-alias-text-primary, #f2f2f4)',
                font: '12px/1 -apple-system, "PingFang SC", sans-serif',
                cursor: 'pointer',
                boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
                pointerEvents: 'auto',
              },
            },
            React.createElement('span', { style: { fontSize: '11px' } }, '◍'),
            '任务浮窗',
          );
        }

        function subscribe(listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        }

        if (ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
          try {
            ctx.slots.inject('shell.overlay', function () {
              return ctx.slots.register(
                { name: 'shell.overlay', id: 'dsh-float-panel-button', order: 60 },
                function () { return React.createElement(FloatButton); },
              );
            });
          } catch (error) {
            console.warn('[dsh-float-panel] shell.overlay slot unavailable', error);
          }
        }
      }

      module.exports = { inject: inject, apply: apply };
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
