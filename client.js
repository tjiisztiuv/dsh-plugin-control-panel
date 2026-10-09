/**
 * Client half of dsh-plugin-control-panel.
 *
 * Registers two sidebar entries, each with its own main panel. The Control
 * Panel is a cross-session command desk: it lists recent sessions from every
 * workspace with their live state, dispatches a typed task into a new session of
 * a chosen workspace, and shows the inbox that scripts push messages into. The
 * Today page shows today's exercise plan and diet suggestion, which the Host
 * half has an agent write once a day; the desk keeps one line about it that
 * opens the page.
 *
 * Sessions and workspaces come from the Web client's own services
 * (`ctx.sessions`, `ctx.workspaces`, `ctx.uiWorkspace`) and the global selector
 * hooks every slot component receives. The inbox, memos, and daily advice come
 * from this bundle's Host half over `/api` routes. No Harness client package is imported as a module;
 * React comes from the host's module table.
 *
 * Host surface this file depends on (keep this list in sync when the host moves):
 *   slots   : 'main' (keyed, root)  ·  'sidebar.panellist' (list, root), two entries in each
 *   props   : useSessions · useSessionStatus · useWorkspaces · t
 *   services: ctx.locale.register/bind
 *             ctx.layout.selectPanel(panelId)
 *             ctx.workspaces.list.getSnapshot()
 *             ctx.uiWorkspace.connectWorkspace(workspaceId) / openSession(sessionId)
 *             ctx.sessions.using(sessionId, { source }, ref => ref.binding.session.prompt(content, 'queue'))
 *   http    : same-origin fetch of the document-relative `api/control-panel.*` routes, authenticated by
 *             the page's session cookie the way the host's own download and review routes are
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-control-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'control-panel';
    /** The Today page's panel and sidebar entry; prefixed, since panel ids share one namespace with other plugins. */
    const TODAY_ID = 'control-panel-today';
    const NS = 'controlPanel';
    /** Reference-count label for the sessions this plugin retains while prompting. */
    const RETAIN_SOURCE = 'controlPanel';
    const DAY_MS = 24 * 60 * 60 * 1000;
    const MAX_ROWS = 30;
    /** Document-relative, like the host's own routes, so a mounted or proxied page still resolves it. */
    const API_BASE = 'api/control-panel.';
    const INBOX_POLL_MS = 30000;
    const INBOX_LIMIT = { active: 50, archived: 100 };
    /** While an advice run is going, the panel checks this often instead of on the 30-second poll. */
    const ADVICE_FOLLOW_MS = 5000;

    const zh = {
      'panel': '控制面板',
      'title': '控制面板',
      'stat.running': '运行中',
      'stat.waiting': '等待处理',
      'stat.recent': '近 24 小时任务',
      'stat.unread': '未读消息',
      'dispatch.title': '指挥台',
      'dispatch.placeholder': '描述要做的事，回车下发（Shift+回车换行）。以 @工作区名 开头可以直接指定工作区。',
      'dispatch.workspace': '目标工作区',
      'dispatch.send': '下发',
      'dispatch.sending': '下发中…',
      'dispatch.noWorkspace': '还没有工作区，先在左侧添加一个。',
      'dispatch.sent': '已下发到「{workspace}」，会话在下面的任务列表里。',
      'dispatch.open': '打开会话',
      'dispatch.failed': '下发失败：{reason}',
      'dispatch.unknownWorkspace': '找不到名为「{name}」的工作区。',
      'dispatch.ambiguousWorkspace': '「{name}」匹配到多个工作区，请写全名或用下拉框选择。',
      'tasks.title': '任务',
      'tasks.loading': '正在读取会话…',
      'tasks.empty': '近 24 小时没有任务。在上面下发一个，或者直接在会话里开始。',
      'state.running': '运行中',
      'state.approval': '等待审批',
      'state.planReview': '计划待审',
      'state.question': '等待回答',
      'state.waiting': '等待处理',
      'state.unread': '已完成，未查看',
      'state.idle': '空闲',
      'workspace.unknown': '未归属工作区',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'inbox.title': '消息',
      'inbox.view.active': '当前',
      'inbox.view.archived': '归档',
      'inbox.markAllRead': '全部已读',
      'inbox.loading': '正在读取消息…',
      'inbox.empty.active': '没有消息。往 {file} 追加一行 JSON 就能投递，格式见插件 README。',
      'inbox.empty.archived': '归档里还没有消息。',
      'inbox.unavailable': '读不到消息：{reason}',
      'inbox.hostMissing': '插件的 Host 半没有响应。更新插件后要重启 dsh',
      'inbox.retry': '重试',
      'inbox.hint': '点开过的消息 {minutes} 分钟后自动归档。',
      'inbox.unread': '未读',
      'level.info': '信息',
      'level.success': '成功',
      'level.warn': '警告',
      'level.error': '错误',
      'detail.loading': '正在读取全文…',
      'detail.empty': '（没有正文）',
      'detail.failed': '读不到这条消息：{reason}',
      'detail.simpleagentSession': '这条消息指向 SimpleAgent 里的一个会话，在这里打不开。',
      'detail.copy': '复制',
      'detail.copied': '已复制',
      'detail.openLink': '打开链接',
      'detail.archive': '归档',
      'detail.close': '关闭',
      'detail.memo': '+备忘',
      'detail.memoAdded': '已加入备忘',
      'stat.todo': '待办',
      'memo.title': '备忘',
      'memo.placeholder': '写点什么，回车保存',
      'memo.add': '添加',
      'memo.loading': '正在读取备忘…',
      'memo.empty': '还没有备忘。',
      'memo.unavailable': '读不到备忘：{reason}',
      'memo.failed': '没保存成功：{reason}',
      'memo.goto': '跳到会话',
      'memo.sessionGone': '这个会话已经不在了。',
      'memo.delete': '删除',
      'memo.markDone': '标记为完成',
      'memo.markUndone': '标记为未完成',
      'memo.fromTask': '+备忘',
      'memo.fromTaskLabel': '把「{title}」记到备忘',
      'today': '今日',
      'today.title': '今日',
      'today.line': '今日',
      'today.sport': '运动',
      'today.diet': '饮食',
      'today.lineReady': '今天的建议写好了',
      'today.lineRunning': '正在生成今天的建议…',
      'today.lineFailed': '今天的建议还没生成出来',
      'today.open': '查看',
      'intl': 'zh-CN',
      'advice.sport': '运动计划',
      'advice.diet': '饮食建议',
      'advice.loading': '正在读取…',
      'advice.off': '未配置',
      'advice.offHint': '还没配置建议目录：在 cordis.patch.yml 里给本插件加上 advice.cwd，见插件 README。',
      'advice.running': '正在生成…',
      'advice.runningHint': '{agent} 正在读项目资料，通常要一两分钟。',
      'advice.waiting': '今天 {at} 自动生成',
      'advice.pending': '几分钟内自动生成',
      'advice.failed': '今天的还没生成出来',
      'advice.failedHint': '生成失败：{reason}',
      'advice.unavailable': '读不到今日建议：{reason}',
      'advice.generate': '现在生成',
      'advice.regenerate': '重新生成',
      'advice.regenerating': '正在重新生成…',
      'advice.retry': '重试',
      'advice.meta': '{agent} 生成于 {time}',
      'advice.skipped': '{agents} 没跑成，改用了 {agent}',
      'advice.lastFailed': '刚才重新生成没成功：{reason}',
      'advice.log': '日志在 {path}',
      'advice.schedule': '每天 {at} 自动生成（{agents}）',
      'advice.then': '，写好后{actions}',
      'advice.thenJoin': '、',
      'advice.thenFile': '写入 {file}',
      'advice.thenMail': '发邮件',
      'advice.fileWritten': '{time} 已写入 {file}',
      'advice.fileFailed': '没写进 {file}：{reason}',
      'advice.mailed': '{time} 已发邮件',
      'advice.mailFailed': '邮件没发出去：{reason}',
      'crash': '控制面板渲染出错，多半是宿主接口变了：{reason}',
    };

    const en = {
      'panel': 'Control Panel',
      'title': 'Control Panel',
      'stat.running': 'Running',
      'stat.waiting': 'Needs you',
      'stat.recent': 'Tasks in 24h',
      'stat.unread': 'Unread messages',
      'dispatch.title': 'Command desk',
      'dispatch.placeholder': 'Describe the task and press Enter to dispatch (Shift+Enter for a new line). Start with @workspace to pick the workspace.',
      'dispatch.workspace': 'Target workspace',
      'dispatch.send': 'Dispatch',
      'dispatch.sending': 'Dispatching…',
      'dispatch.noWorkspace': 'No workspace yet. Add one in the sidebar first.',
      'dispatch.sent': 'Dispatched to "{workspace}". The session is in the task list below.',
      'dispatch.open': 'Open session',
      'dispatch.failed': 'Dispatch failed: {reason}',
      'dispatch.unknownWorkspace': 'No workspace is named "{name}".',
      'dispatch.ambiguousWorkspace': '"{name}" matches several workspaces. Type the full name or use the selector.',
      'tasks.title': 'Tasks',
      'tasks.loading': 'Loading sessions…',
      'tasks.empty': 'No task in the last 24 hours. Dispatch one above, or start in a session.',
      'state.running': 'Running',
      'state.approval': 'Awaiting approval',
      'state.planReview': 'Plan to review',
      'state.question': 'Awaiting answer',
      'state.waiting': 'Needs you',
      'state.unread': 'Finished, not viewed',
      'state.idle': 'Idle',
      'workspace.unknown': 'No workspace',
      'time.now': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',
      'inbox.title': 'Inbox',
      'inbox.view.active': 'Current',
      'inbox.view.archived': 'Archived',
      'inbox.markAllRead': 'Mark all read',
      'inbox.loading': 'Loading messages…',
      'inbox.empty.active': 'No messages. Append one JSON line to {file} to push one; the plugin README has the format.',
      'inbox.empty.archived': 'Nothing archived yet.',
      'inbox.unavailable': 'Cannot read messages: {reason}',
      'inbox.hostMissing': 'the Host half of the plugin did not answer; restart dsh after updating the plugin',
      'inbox.retry': 'Retry',
      'inbox.hint': 'An opened message archives itself after {minutes} minutes.',
      'inbox.unread': 'Unread',
      'level.info': 'Info',
      'level.success': 'Success',
      'level.warn': 'Warning',
      'level.error': 'Error',
      'detail.loading': 'Loading the full text…',
      'detail.empty': '(no body)',
      'detail.failed': 'Cannot read this message: {reason}',
      'detail.simpleagentSession': 'This message points at a SimpleAgent session, which cannot be opened here.',
      'detail.copy': 'Copy',
      'detail.copied': 'Copied',
      'detail.openLink': 'Open link',
      'detail.archive': 'Archive',
      'detail.close': 'Close',
      'detail.memo': '+ Memo',
      'detail.memoAdded': 'Added to memos',
      'stat.todo': 'To do',
      'memo.title': 'Memos',
      'memo.placeholder': 'Write a note and press Enter',
      'memo.add': 'Add',
      'memo.loading': 'Loading memos…',
      'memo.empty': 'No memos yet.',
      'memo.unavailable': 'Cannot read memos: {reason}',
      'memo.failed': 'Not saved: {reason}',
      'memo.goto': 'Open session',
      'memo.sessionGone': 'That session no longer exists.',
      'memo.delete': 'Delete',
      'memo.markDone': 'Mark as done',
      'memo.markUndone': 'Mark as not done',
      'memo.fromTask': '+ Memo',
      'memo.fromTaskLabel': 'Add "{title}" to memos',
      'today': 'Today',
      'today.title': 'Today',
      'today.line': 'Today',
      'today.sport': 'Exercise',
      'today.diet': 'Diet',
      'today.lineReady': "Today's advice is ready",
      'today.lineRunning': "Writing today's advice…",
      'today.lineFailed': "Today's advice is not written yet",
      'today.open': 'View',
      'intl': 'en-US',
      'advice.sport': 'Exercise plan',
      'advice.diet': 'Diet',
      'advice.loading': 'Loading…',
      'advice.off': 'Not configured',
      'advice.offHint': 'No project is configured for the advice. Set advice.cwd for this plugin in cordis.patch.yml; see the plugin README.',
      'advice.running': 'Writing…',
      'advice.runningHint': '{agent} is reading the project; this usually takes a minute or two.',
      'advice.waiting': 'Written automatically at {at}',
      'advice.pending': 'Written within a few minutes',
      'advice.failed': "Today's advice is not written yet",
      'advice.failedHint': 'The run failed: {reason}',
      'advice.unavailable': "Cannot read today's advice: {reason}",
      'advice.generate': 'Write now',
      'advice.regenerate': 'Write again',
      'advice.regenerating': 'Writing again…',
      'advice.retry': 'Retry',
      'advice.meta': 'Written by {agent} at {time}',
      'advice.skipped': '{agents} failed, so {agent} wrote it',
      'advice.lastFailed': 'Writing it again failed: {reason}',
      'advice.log': 'Log: {path}',
      'advice.schedule': 'Written daily at {at} ({agents})',
      'advice.then': ', then {actions}',
      'advice.thenJoin': ' and ',
      'advice.thenFile': 'written to {file}',
      'advice.thenMail': 'mailed',
      'advice.fileWritten': 'Written to {file} at {time}',
      'advice.fileFailed': 'Could not write {file}: {reason}',
      'advice.mailed': 'Mailed at {time}',
      'advice.mailFailed': 'The mail did not go out: {reason}',
      'crash': 'The control panel failed to render, most likely because a host interface changed: {reason}',
    };

    /* Colors come from host theme tokens only; sizes follow the host's own
       first-level pages (Plugins, Automations) so the three read as siblings. */
    const CSS = `
.dshcp-page { position: relative; display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 14px; line-height: 1.6; }
.dshcp-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.dshcp-content { max-width: 960px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
.dshcp-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 24px;
  padding-top: 28px; margin-bottom: 20px; }
[data-platform='darwin'] .dshcp-heading { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dshcp-heading h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.dshcp-band { display: flex; flex-wrap: wrap; gap: 2px 20px; }
.dshcp-stat { display: flex; align-items: baseline; gap: 6px; }
.dshcp-stat-value { font-size: 15px; line-height: 22px; font-weight: 500; font-variant-numeric: tabular-nums; }
.dshcp-stat-label { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dshcp-stat[data-tone='warn'] .dshcp-stat-value { color: var(--dsw-alias-state-warn-primary); }
.dshcp-stat[data-tone='active'] .dshcp-stat-value { color: var(--dsw-alias-state-business-primary); }
.dshcp-cols { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 24px; }
.dshcp-main { flex: 3 1 360px; min-width: 0; }
.dshcp-side { flex: 2 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 24px; }
.dshcp-section h2 { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; font-weight: 500; }
.dshcp-composer { margin-bottom: 8px; padding: 8px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); }
.dshcp-composer:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.dshcp-input { display: block; width: 100%; min-height: 44px; padding: 4px; border: none; outline: none; resize: none;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; line-height: 22px; box-sizing: border-box; }
.dshcp-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshcp-composer-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
.dshcp-select { height: 28px; min-width: 0; max-width: 240px; padding: 0 6px; border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; }
.dshcp-send { flex: none; height: 28px; padding: 0 14px; border: none; border-radius: 14px; cursor: pointer;
  background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font: inherit; font-size: 13px; }
.dshcp-send:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dshcp-send:disabled { opacity: 0.4; cursor: default; }
.dshcp-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 0 0 16px; padding: 0 4px;
  color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 21px; }
.dshcp-notice[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.dshcp-link { padding: 0; border: none; background: none; cursor: pointer; color: var(--dsw-alias-link); font: inherit; }
.dshcp-link:hover { text-decoration: underline; }
.dshcp-tasks { margin-top: 16px; }
.dshcp-rows { display: flex; flex-direction: column; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
.dshcp-row { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 8px; border: none; border-radius: 12px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dshcp-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshcp-row:focus-visible, .dshcp-send:focus-visible, .dshcp-link:focus-visible, .dshcp-select:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dshcp-dot { flex: none; width: 8px; height: 8px; margin-top: 8px; border-radius: 50%; background: var(--dsw-alias-label-dimmed); }
.dshcp-dot[data-state='running'] { background: var(--dsw-alias-state-business-primary); }
.dshcp-dot[data-state='waiting'] { background: var(--dsw-alias-state-warn-primary); }
.dshcp-dot[data-state='unread'] { background: var(--dsw-alias-state-success-primary); }
.dshcp-row-body { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.dshcp-row-title { overflow: hidden; font-weight: 500; line-height: 23px; text-overflow: ellipsis; white-space: nowrap; }
.dshcp-row-meta { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 21px; overflow-wrap: anywhere; }
.dshcp-row-meta span + span::before { content: ' · '; padding: 0 2px; }
.dshcp-row-meta [data-state='waiting'] { color: var(--dsw-alias-state-warn-primary); }
.dshcp-row-meta [data-state='running'] { color: var(--dsw-alias-state-business-primary); }
.dshcp-empty { padding: 16px; border: 0.5px dashed var(--dsw-alias-border-l3); border-radius: 12px;
  color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 21px; overflow-wrap: anywhere; }
.dshcp-section-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-bottom: 8px; }
.dshcp-section-head h2 { flex: 1; margin: 0; }
.dshcp-badge { margin-left: 6px; padding: 0 6px; border-radius: 9px; background: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary-foreground); font-size: 12px; line-height: 18px; font-weight: 500;
  font-variant-numeric: tabular-nums; }
.dshcp-tabs { display: flex; gap: 2px; }
.dshcp-tab { height: 24px; padding: 0 8px; border: none; border-radius: 8px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; }
.dshcp-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshcp-tab[aria-pressed='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshcp-tab:focus-visible, .dshcp-button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dshcp-link { font-size: 13px; }
.dshcp-row[data-read='true'] .dshcp-row-title { color: var(--dsw-alias-label-secondary); font-weight: 400; }
.dshcp-dot[data-level='success'] { background: var(--dsw-alias-state-success-primary); }
.dshcp-dot[data-level='warn'] { background: var(--dsw-alias-state-warn-primary); }
.dshcp-dot[data-level='error'] { background: var(--dsw-alias-state-error-primary); }
.dshcp-dot[data-level='info'] { background: var(--dsw-alias-state-business-primary); }
.dshcp-row[data-read='true'] .dshcp-dot { opacity: 0.35; }
.dshcp-row-preview { display: -webkit-box; margin-top: 2px; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 21px; overflow-wrap: anywhere; }
.dshcp-caption { margin: 8px 0 0; color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 18px; }
.dshcp-overlay { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent); }
.dshcp-dialog { display: flex; flex-direction: column; width: min(640px, 100%); max-height: 100%; min-height: 0;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 16px; background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 12px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dshcp-dialog-head { padding: 20px 24px 12px; }
.dshcp-dialog-head h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; overflow-wrap: anywhere; }
.dshcp-dialog-meta { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 21px; }
.dshcp-dialog-meta span + span::before { content: ' · '; padding: 0 2px; }
.dshcp-dialog-body { flex: 1; min-height: 0; overflow: auto; padding: 0 24px; }
.dshcp-dialog-text { margin: 0; color: var(--dsw-alias-label-primary); font: inherit; line-height: 22px;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.dshcp-dialog-note { margin: 0 0 12px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 21px; }
.dshcp-dialog-note[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.dshcp-dialog-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 16px 24px 20px; }
.dshcp-button { display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-primary); font: inherit;
  font-size: 13px; text-decoration: none; box-sizing: border-box; }
.dshcp-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshcp-button:disabled { opacity: 0.4; cursor: default; }
.dshcp-rows li { display: flex; align-items: flex-start; }
.dshcp-rows li > .dshcp-row { flex: 1; min-width: 0; }
.dshcp-row-action { flex: none; height: 24px; margin: 8px 4px 0; padding: 0 8px; border: none; border-radius: 8px;
  background: transparent; cursor: pointer; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; opacity: 0; }
.dshcp-rows li:hover .dshcp-row-action, .dshcp-row-action:focus-visible { opacity: 1; }
.dshcp-row-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshcp-memo-add { display: flex; gap: 8px; margin-bottom: 8px; }
.dshcp-memo-input { flex: 1; min-width: 0; height: 32px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px; outline: none; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; box-sizing: border-box; }
.dshcp-memo-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.dshcp-memo-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshcp-memos { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.dshcp-memo { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0; }
.dshcp-check { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px;
  margin-top: 3px; padding: 0; border: 1px solid var(--dsw-alias-border-l4); border-radius: 4px; background: transparent;
  cursor: pointer; color: var(--dsw-alias-label-primary-foreground); font-size: 11px; line-height: 1; }
.dshcp-check[aria-checked='true'] { border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-primary); }
.dshcp-memo-text { flex: 1; min-width: 0; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dshcp-memo[data-done='true'] .dshcp-memo-text { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
.dshcp-memo .dshcp-link { flex: none; line-height: 22px; }
.dshcp-icon-button { flex: none; width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px; background: transparent;
  cursor: pointer; color: var(--dsw-alias-label-tertiary); font: inherit; line-height: 1; }
.dshcp-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshcp-check:focus-visible, .dshcp-icon-button:focus-visible, .dshcp-memo-input:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dshcp-advice { container-type: inline-size; }
.dshcp-advice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
@container (max-width: 560px) {
  .dshcp-advice-grid { grid-template-columns: minmax(0, 1fr); }
}
.dshcp-advice-card { min-width: 0; padding: 16px 20px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); }
.dshcp-advice-card h2 { margin: 0 0 4px; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; font-weight: 500; }
.dshcp-advice-headline { margin: 0 0 8px; font-size: 16px; line-height: 24px; font-weight: 500; overflow-wrap: anywhere; }
.dshcp-advice-items { margin: 0; padding: 0 0 0 18px; font-size: 14px; line-height: 22px; }
.dshcp-advice-items li { overflow-wrap: anywhere; }
.dshcp-advice-items li + li { margin-top: 4px; }
.dshcp-advice-placeholder { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 21px; }
.dshcp-advice-note { margin: 12px 0 0; padding: 0 4px; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px;
  overflow-wrap: anywhere; }
.dshcp-advice-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; margin: 8px 0 0; padding: 0 4px;
  color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dshcp-advice-foot[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.dshcp-advice-foot .dshcp-link { font-size: 12px; }
.dshcp-link:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; text-decoration: none; }
.dshcp-today-date { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dshcp-today-line { display: flex; align-items: baseline; gap: 12px; width: 100%; margin: 0 0 24px; padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); cursor: pointer;
  color: inherit; font: inherit; font-size: 13px; line-height: 21px; text-align: left; box-sizing: border-box; }
.dshcp-today-line:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshcp-today-line:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dshcp-today-label { flex: none; font-weight: 500; }
.dshcp-today-text { flex: 1; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; }
.dshcp-today-part + .dshcp-today-part { margin-left: 16px; }
.dshcp-today-kind { margin-right: 6px; color: var(--dsw-alias-label-tertiary); }
.dshcp-today-line[data-kind='error'] .dshcp-today-text { color: var(--dsw-alias-state-error-primary); }
.dshcp-today-go { flex: none; color: var(--dsw-alias-link); }
`;

    const identity = value => value;
    const selectUnread = inbox => inbox.counts.unread;

    /** True while today's advice is written but the Today page has not been open on it since. */
    function unseenOf(advice) {
      const data = advice.data;
      const record = data ? data.record : null;
      return Boolean(record && record.status === 'ready' && typeof record.generated_at === 'string'
        && record.generated_at !== data.seen);
    }
    const INITIAL_INBOX = {
      view: 'active',
      items: [],
      counts: { unread: 0, active: 0, archived: 0 },
      archiveAfterMinutes: 30,
      /** Host directory the inbox is read from; empty until the first list read. */
      dir: '',
      /** idle before the first read · loading · ready · error */
      phase: 'idle',
      error: null,
      /** The open message: { id, item, loading, error, copied }, or null. */
      detail: null,
    };

    const INITIAL_ADVICE = {
      /** The Host's `advice.today` answer: { enabled, date, at, agents, mail, todayFile, project, running, record, seen, logPath }, or null. */
      data: null,
      /** idle before the first read · loading · ready · error */
      phase: 'idle',
      error: null,
      /** True while a run request is in flight, so a second click cannot send another. */
      starting: false,
      /** Why the last run request was refused, or null. */
      notice: null,
    };

    const INITIAL_MEMOS = {
      items: [],
      /** idle before the first read · loading · ready · error */
      phase: 'idle',
      error: null,
      draft: '',
      /** True while the draft is being saved, so a second Enter cannot add it twice. */
      saving: false,
      /** The last change that failed, as { key, params }, or null. */
      notice: null,
    };

    /** Call one of this bundle's Host routes; a body makes it a POST. Rejects with the Host's reason. */
    async function api(name, options) {
      const query = options && options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
      const init = options && options.body !== undefined
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }
        : { method: 'GET' };
      const response = await globalThis.fetch(`${API_BASE}${name}${query}`, init);
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        const reason = payload && typeof payload.error === 'string' ? payload.error : undefined;
        const error = new Error(reason !== undefined ? reason : `HTTP ${response.status}`);
        // A 404 the Host half did not write means the route is not registered at all.
        error.routeMissing = response.status === 404 && reason === undefined;
        throw error;
      }
      return payload;
    }

    function httpUrlOf(ref) {
      const url = ref && typeof ref.url === 'string' ? ref.url : '';
      return /^https?:\/\//i.test(url) ? url : undefined;
    }

    const EMPTY_SESSIONS = { ids: [], byId: {}, phase: 'pending', projectionsBySession: {} };
    const EMPTY_WORKSPACES = { items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'pending' };
    const EMPTY_STATUS = new Map();

    /** Minimal external store in the shape the slot renderer binds to a `use<Name>` hook. */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          if (next === state) return;
          state = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /** Session timestamps are epoch milliseconds; tolerate seconds in case the host ever changes. */
    function toMillis(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
      return value < 1e12 ? value * 1000 : value;
    }

    function pendingStateKey(kind) {
      if (kind === 'approval') return 'state.approval';
      if (kind === 'plan-review') return 'state.planReview';
      if (kind === 'question') return 'state.question';
      return 'state.waiting';
    }

    /**
     * Fold the host's session list, per-session UI status, and workspace registry into the panel's view:
     * top-level, non-blank, non-archived sessions that are active now or were touched within 24 hours.
     */
    function buildModel(sessions, statuses, workspaces, now) {
      const archived = new Set(workspaces.archivedSessionIds || []);
      const workspaceOf = new Map();
      for (const workspace of workspaces.items || []) {
        for (const id of workspace.sessionIds || []) workspaceOf.set(id, workspace);
      }
      const rank = { waiting: 0, running: 1, unread: 2, idle: 3 };
      const rows = [];
      let running = 0;
      let waiting = 0;
      for (const id of sessions.ids || []) {
        const summary = sessions.byId ? sessions.byId[id] : undefined;
        if (summary === undefined || summary.blank || summary.origin === 'subagent'
          || summary.parentId !== undefined || archived.has(id)) continue;
        const status = statuses.get ? statuses.get(id) : undefined;
        const isRunning = (status && status.running !== undefined) ? status.running : summary.running === true;
        const pending = status ? status.pendingInteraction : undefined;
        const state = pending !== undefined ? 'waiting'
          : isRunning ? 'running'
            : (status && status.completionUnread) ? 'unread' : 'idle';
        const updatedAt = toMillis(summary.updatedAt);
        if (state === 'idle' && now - updatedAt > DAY_MS) continue;
        if (state === 'running') running += 1;
        if (state === 'waiting') waiting += 1;
        const workspace = workspaceOf.get(id);
        rows.push({
          id,
          title: summary.displayTitle || summary.title || String(id),
          state,
          stateKey: state === 'waiting' ? pendingStateKey(pending.kind) : `state.${state}`,
          workspaceTitle: workspace ? workspace.title : undefined,
          updatedAt,
        });
      }
      rows.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.updatedAt - a.updatedAt));
      return { rows: rows.slice(0, MAX_ROWS), total: rows.length, running, waiting };
    }

    /** The workspace a dispatch goes to when the user has not chosen one: the most recently active one. */
    function defaultWorkspaceId(workspaces, sessions) {
      const items = workspaces.items || [];
      if (items.length === 0) return undefined;
      let best;
      let bestAt = -1;
      for (const workspace of items) {
        for (const id of workspace.sessionIds || []) {
          const summary = sessions.byId ? sessions.byId[id] : undefined;
          const at = summary ? toMillis(summary.updatedAt) : 0;
          if (at > bestAt) { bestAt = at; best = workspace.workspaceId; }
        }
      }
      return best !== undefined ? best : items[0].workspaceId;
    }

    function effectiveWorkspaceId(selected, workspaces, sessions) {
      const items = workspaces.items || [];
      if (selected !== undefined && items.some(item => item.workspaceId === selected)) return selected;
      return defaultWorkspaceId(workspaces, sessions);
    }

    /**
     * Split a draft into its target workspace and task text. A leading `@name` picks the workspace whose
     * title equals `name`, or the only one whose title starts with it (case-insensitive).
     */
    function resolveTarget(draft, items, fallbackId) {
      const text = draft.trim();
      const mention = /^@(\S+)\s*([\s\S]*)$/.exec(text);
      if (mention === null) return { workspaceId: fallbackId, text };
      const name = mention[1].toLowerCase();
      const exact = items.filter(item => String(item.title).toLowerCase() === name);
      const matches = exact.length > 0 ? exact : items.filter(item => String(item.title).toLowerCase().startsWith(name));
      if (matches.length === 0) return { error: 'dispatch.unknownWorkspace', params: { name: mention[1] } };
      if (matches.length > 1) return { error: 'dispatch.ambiguousWorkspace', params: { name: mention[1] } };
      return { workspaceId: matches[0].workspaceId, text: mention[2].trim() };
    }

    function relativeTime(t, now, at) {
      const elapsed = Math.max(0, now - at);
      const minutes = Math.floor(elapsed / 60000);
      if (minutes < 1) return t('time.now');
      if (minutes < 60) return t('time.minutes', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('time.hours', { n: hours });
      return t('time.days', { n: Math.floor(hours / 24) });
    }

    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()); }, intervalMs);
        return () => { clearInterval(timer); };
      }, [intervalMs]);
      return now;
    }

    /** A sidebar glyph's frame: drawn in the row's current color at the size the sidebar asks for. */
    function glyph(size, ...children) {
      const edge = typeof size === 'number' ? size : 16;
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2, 'aria-hidden': true, style: { overflow: 'visible' },
      }, ...children);
    }

    const cornerDot = () => h('circle', { cx: 14, cy: 2, r: 2.6, style: { fill: 'var(--dsw-alias-state-error-primary)', stroke: 'none' } });

    /** The Control Panel's glyph: four tiles, with a dot while the inbox holds unread messages. */
    function PanelIcon({ size, useInbox }) {
      const unread = typeof useInbox === 'function' ? useInbox(selectUnread) : 0;
      const tile = (x, y, width, height) => h('rect', { x, y, width, height, rx: 1.2 });
      return glyph(size, tile(2, 2, 5, 7), tile(9, 2, 5, 4), tile(9, 8, 5, 6), tile(2, 11, 5, 3),
        unread > 0 ? cornerDot() : null);
    }

    /** The Today page's glyph: a calendar leaf, with a dot while today's advice is written but not yet looked at. */
    function TodayIcon({ size, useAdvice }) {
      const unseen = typeof useAdvice === 'function' ? useAdvice(unseenOf) : false;
      return glyph(size,
        h('rect', { x: 2, y: 3, width: 12, height: 11, rx: 1.6 }),
        h('path', { d: 'M2 6.5h12M5.5 1.5v3M10.5 1.5v3' }),
        h('rect', { x: 5, y: 9, width: 2.6, height: 2.6, rx: 0.6, style: { fill: 'currentColor', stroke: 'none' } }),
        unseen ? cornerDot() : null);
    }

    function Stat({ value, label, tone }) {
      return h('div', { className: 'dshcp-stat', 'data-tone': tone },
        h('span', { className: 'dshcp-stat-value' }, String(value)),
        h('span', { className: 'dshcp-stat-label' }, label));
    }

    function TaskRow({ row, now, t, onOpen, onMemo }) {
      return h('li', null,
        h('button', { type: 'button', className: 'dshcp-row', onClick: () => { onOpen(row.id); } },
          h('span', { className: 'dshcp-dot', 'data-state': row.state, 'aria-hidden': true }),
          h('span', { className: 'dshcp-row-body' },
            h('span', { className: 'dshcp-row-title' }, row.title),
            h('span', { className: 'dshcp-row-meta' },
              h('span', null, row.workspaceTitle !== undefined ? row.workspaceTitle : t('workspace.unknown')),
              h('span', { 'data-state': row.state }, t(row.stateKey)),
              h('span', null, relativeTime(t, now, row.updatedAt))))),
        // A sibling of the row, not a child: a button cannot contain another button.
        h('button', {
          type: 'button', className: 'dshcp-row-action', 'aria-label': t('memo.fromTaskLabel', { title: row.title }),
          onClick: () => { onMemo(row); },
        }, t('memo.fromTask')));
    }

    function MemoRow({ item, t, onToggle, onRemove, onGoto }) {
      return h('li', { className: 'dshcp-memo', 'data-done': item.done ? 'true' : 'false' },
        h('button', {
          type: 'button', className: 'dshcp-check', role: 'checkbox', 'aria-checked': item.done ? 'true' : 'false',
          'aria-label': item.done ? t('memo.markUndone') : t('memo.markDone'),
          onClick: () => { onToggle(item); },
        }, item.done ? '✓' : null),
        h('span', { className: 'dshcp-memo-text' }, item.text),
        item.action === 'dsh-session'
          ? h('button', { type: 'button', className: 'dshcp-link', onClick: () => { onGoto(item); } }, t('memo.goto'))
          : null,
        h('button', {
          type: 'button', className: 'dshcp-icon-button', 'aria-label': t('memo.delete'), title: t('memo.delete'),
          onClick: () => { onRemove(item.id); },
        }, '×'));
    }

    function MemoSection({ t, memos, onDraft, onSubmit, onToggle, onRemove, onGoto, onRetry }) {
      const open = memos.items.filter(item => !item.done).length;
      let body;
      if (memos.phase === 'error') {
        body = h('div', { className: 'dshcp-empty', role: 'alert' },
          t('memo.unavailable', { reason: memos.error }), ' ',
          h('button', { type: 'button', className: 'dshcp-link', onClick: () => { onRetry(); } }, t('inbox.retry')));
      } else if (memos.items.length > 0) {
        body = h('ul', { className: 'dshcp-memos' },
          memos.items.map(item => h(MemoRow, { key: item.id, item, t, onToggle, onRemove, onGoto })));
      } else {
        body = h('div', { className: 'dshcp-empty' }, memos.phase === 'ready' ? t('memo.empty') : t('memo.loading'));
      }
      return h('div', { className: 'dshcp-section' },
        h('div', { className: 'dshcp-section-head' },
          h('h2', null, t('memo.title'), open > 0 ? h('span', { className: 'dshcp-badge' }, String(open)) : null)),
        memos.phase === 'error' ? null : h('div', { className: 'dshcp-memo-add' },
          h('input', {
            className: 'dshcp-memo-input', type: 'text', value: memos.draft, placeholder: t('memo.placeholder'),
            'aria-label': t('memo.title'), disabled: memos.saving,
            onChange: (event) => { onDraft(event.target.value); },
            onKeyDown: (event) => {
              // An Enter that confirms an IME candidate must not save.
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              onSubmit();
            },
          }),
          h('button', {
            type: 'button', className: 'dshcp-button', disabled: memos.saving || memos.draft.trim() === '',
            onClick: () => { onSubmit(); },
          }, t('memo.add'))),
        memos.notice !== null
          ? h('p', { className: 'dshcp-notice', 'data-kind': 'error', role: 'alert' }, t(memos.notice.key, memos.notice.params))
          : null,
        body);
    }

    /** `HH:MM` of a stored local timestamp, or an empty string. */
    function clockOf(value) {
      const at = Date.parse(value);
      if (Number.isNaN(at)) return '';
      const date = new Date(at);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    /** One advice column: the headline and every item; the page has room for all of them. */
    function AdviceCard({ title, section, placeholder }) {
      if (!section) {
        return h('div', { className: 'dshcp-advice-card' },
          h('h2', null, title), h('p', { className: 'dshcp-advice-placeholder' }, placeholder));
      }
      return h('div', { className: 'dshcp-advice-card' },
        h('h2', null, title),
        section.headline ? h('p', { className: 'dshcp-advice-headline' }, section.headline) : null,
        section.items.length > 0
          ? h('ul', { className: 'dshcp-advice-items' }, section.items.map((item, index) => h('li', { key: index }, item)))
          : null);
    }

    /**
     * Today's exercise plan and diet suggestion, side by side. The cards say
     * what state the day's run is in until there is something to show; the line below holds the actions.
     */
    function AdviceStrip({ t, advice, onRun, onRetry }) {
      const data = advice.data;
      const record = data && data.record && data.record.status === 'ready' ? data.record : null;
      const running = data ? data.running : null;
      const busy = advice.starting || running !== null;
      const action = (key, onClick) => h('button', {
        type: 'button', className: 'dshcp-link', disabled: busy, onClick: () => { onClick(); },
      }, t(key));
      // Only the file's name: the Today page has no room for a full path, and the log line names it in full.
      const file = data !== null && typeof data.todayFile === 'string' && data.todayFile !== '' ? data.todayFile.split('/').pop() : '';
      const then = [file !== '' ? t('advice.thenFile', { file }) : null, data !== null && data.mail ? t('advice.thenMail') : null]
        .filter(part => part !== null);
      const schedule = data !== null && data.enabled
        ? t('advice.schedule', { at: data.at, agents: (Array.isArray(data.agents) ? data.agents : []).join(' → ') })
          + (then.length > 0 ? t('advice.then', { actions: then.join(t('advice.thenJoin')) }) : '')
        : null;
      let placeholder = t('advice.loading');
      const foot = [];
      if (advice.phase === 'error') {
        placeholder = '—';
        foot.push({ kind: 'error', parts: [t('advice.unavailable', { reason: advice.error }), action('advice.retry', onRetry)] });
      } else if (data !== null && !data.enabled) {
        placeholder = t('advice.off');
        foot.push({ parts: [t('advice.offHint')] });
      } else if (data !== null && record === null) {
        const failed = data.record && data.record.status === 'failed' ? data.record : null;
        if (running !== null) {
          placeholder = t('advice.running');
          foot.push({ parts: [t('advice.runningHint', { agent: running.agent || '' })] });
        } else if (failed !== null) {
          placeholder = t('advice.failed');
          foot.push({ kind: 'error', parts: [t('advice.failedHint', { reason: failed.error || '' }), action('advice.retry', onRun)] });
          foot.push({ parts: [t('advice.log', { path: data.logPath })] });
        } else {
          const before = Date.now() < dueTimeOf(data.at);
          placeholder = before ? t('advice.waiting', { at: data.at }) : t('advice.pending');
          foot.push({ parts: [data.project, schedule, action('advice.generate', onRun)] });
        }
      } else if (record !== null) {
        const skipped = Array.isArray(record.skipped) ? record.skipped.map(item => item.agent) : [];
        const mail = record.mail && typeof record.mail === 'object' ? record.mail : null;
        const written = record.today_file && typeof record.today_file === 'object' ? record.today_file : null;
        foot.push({
          parts: [
            data.project,
            t('advice.meta', { agent: record.model ? `${record.agent} · ${record.model}` : record.agent, time: clockOf(record.generated_at) }),
            skipped.length > 0 ? t('advice.skipped', { agents: skipped.join('、'), agent: record.agent }) : null,
            written && written.written_at ? t('advice.fileWritten', { time: clockOf(written.written_at), file: file || 'file' }) : null,
            mail && mail.sent_at ? t('advice.mailed', { time: clockOf(mail.sent_at) }) : null,
            schedule,
            running !== null ? t('advice.regenerating') : action('advice.regenerate', onRun),
          ],
        });
        if (record.error && running === null) foot.push({ kind: 'error', parts: [t('advice.lastFailed', { reason: record.error })] });
        if (written && written.error) foot.push({ kind: 'error', parts: [t('advice.fileFailed', { file: file || 'file', reason: written.error })] });
        if (mail && mail.error) foot.push({ kind: 'error', parts: [t('advice.mailFailed', { reason: mail.error })] });
      }
      if (advice.notice !== null) foot.push({ kind: 'error', parts: [advice.notice] });
      return h('div', { className: 'dshcp-advice', 'data-testid': 'control-panel-advice' },
        h('div', { className: 'dshcp-advice-grid' },
          h(AdviceCard, { title: t('advice.sport'), section: record ? record.sport : null, placeholder }),
          h(AdviceCard, { title: t('advice.diet'), section: record ? record.diet : null, placeholder })),
        record && record.note ? h('p', { className: 'dshcp-advice-note' }, record.note) : null,
        foot.map((line, index) => h('p', {
          key: index, className: 'dshcp-advice-foot', 'data-kind': line.kind, role: line.kind === 'error' ? 'alert' : undefined,
        }, line.parts.filter(part => part !== null && part !== '').map((part, at) => h('span', { key: at }, part)))));
    }

    /**
     * The desk's one line about today: the two headlines once they are written, or that the run is going or
     * failed. Nothing while there is nothing to say, so an unconfigured plugin costs the desk no room.
     */
    function TodayLine({ t, advice, onOpen }) {
      const data = advice.data;
      if (data === null || !data.enabled) return null;
      const record = data.record;
      let kind;
      let parts;
      if (record && record.status === 'ready') {
        parts = [['today.sport', record.sport], ['today.diet', record.diet]]
          .filter(([, section]) => section && section.headline)
          .map(([key, section]) => h('span', { key, className: 'dshcp-today-part' },
            h('span', { className: 'dshcp-today-kind' }, t(key)), section.headline));
        if (parts.length === 0) parts = [t('today.lineReady')];
      } else if (data.running !== null) {
        parts = [t('today.lineRunning')];
      } else if (record && record.status === 'failed') {
        kind = 'error';
        parts = [t('today.lineFailed')];
      } else {
        return null;
      }
      return h('button', {
        type: 'button', className: 'dshcp-today-line', 'data-kind': kind, 'data-testid': 'control-panel-today-line',
        onClick: () => { onOpen(); },
      },
      h('span', { className: 'dshcp-today-label' }, t('today.line')),
      h('span', { className: 'dshcp-today-text' }, parts),
      h('span', { className: 'dshcp-today-go' }, `${t('today.open')} →`));
    }

    /** "10月8日星期四" for the Host's `YYYY-MM-DD`, or for this browser's today until the Host has answered. */
    function dateLabel(t, date) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === 'string' ? date : '');
      const day = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date();
      try {
        return new Intl.DateTimeFormat(t('intl'), { month: 'long', day: 'numeric', weekday: 'long' }).format(day);
      } catch (error) {
        return match ? match[0] : '';
      }
    }

    /** Epoch milliseconds of today's `HH:MM` in local time. */
    function dueTimeOf(at) {
      const [hours, minutes] = String(at).split(':').map(Number);
      const due = new Date();
      due.setHours(hours || 0, minutes || 0, 0, 0);
      return due.getTime();
    }

    function Composer({ t, desk, workspaces, workspaceId, onDraft, onWorkspace, onDispatch }) {
      const items = workspaces.items || [];
      if (items.length === 0) return h('div', { className: 'dshcp-empty' }, t('dispatch.noWorkspace'));
      const blocked = desk.sending || desk.draft.trim() === '';
      return h('div', { className: 'dshcp-composer' },
        h('textarea', {
          className: 'dshcp-input',
          rows: 2,
          value: desk.draft,
          placeholder: t('dispatch.placeholder'),
          'aria-label': t('dispatch.title'),
          disabled: desk.sending,
          onChange: (event) => { onDraft(event.target.value); },
          onKeyDown: (event) => {
            // An Enter that confirms an IME candidate must not dispatch.
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            onDispatch();
          },
        }),
        h('div', { className: 'dshcp-composer-row' },
          h('select', {
            className: 'dshcp-select',
            value: workspaceId !== undefined ? workspaceId : '',
            'aria-label': t('dispatch.workspace'),
            disabled: desk.sending,
            onChange: (event) => { onWorkspace(event.target.value); },
          }, items.map(item => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title))),
          h('button', {
            type: 'button', className: 'dshcp-send', disabled: blocked, onClick: () => { onDispatch(); },
          }, desk.sending ? t('dispatch.sending') : t('dispatch.send'))));
    }

    function Notice({ t, notice, workspaces, onOpen }) {
      if (notice === null) return null;
      if (notice.kind === 'error') {
        return h('p', { className: 'dshcp-notice', 'data-kind': 'error', role: 'alert' }, t(notice.key, notice.params));
      }
      const workspace = (workspaces.items || []).find(item => item.workspaceId === notice.workspaceId);
      return h('p', { className: 'dshcp-notice', 'data-kind': 'sent', role: 'status' },
        h('span', null, t('dispatch.sent', { workspace: workspace ? workspace.title : '' })),
        h('button', { type: 'button', className: 'dshcp-link', onClick: () => { onOpen(notice.sessionId); } }, t('dispatch.open')));
    }

    function MessageRow({ item, now, t, onOpen }) {
      const level = ['info', 'success', 'warn', 'error'].includes(item.level) ? item.level : 'info';
      const at = Date.parse(item.ts);
      return h('li', null,
        h('button', {
          type: 'button', className: 'dshcp-row', 'data-read': item.read ? 'true' : 'false', onClick: () => { onOpen(item); },
        },
        h('span', {
          className: 'dshcp-dot', 'data-level': level, role: 'img',
          'aria-label': item.read ? t(`level.${level}`) : `${t('inbox.unread')} · ${t(`level.${level}`)}`,
        }),
        h('span', { className: 'dshcp-row-body' },
          h('span', { className: 'dshcp-row-title' }, item.title || item.id),
          h('span', { className: 'dshcp-row-meta' },
            h('span', null, item.source),
            Number.isNaN(at) ? null : h('span', null, relativeTime(t, now, at))),
          item.preview ? h('span', { className: 'dshcp-row-preview' }, item.preview) : null)));
    }

    function InboxSection({ t, inbox, now, onView, onOpen, onMarkAllRead, onRetry }) {
      const tab = view => h('button', {
        type: 'button', className: 'dshcp-tab', 'aria-pressed': inbox.view === view ? 'true' : 'false',
        onClick: () => { onView(view); },
      }, t(`inbox.view.${view}`));
      let body;
      if (inbox.phase === 'error') {
        body = h('div', { className: 'dshcp-empty', role: 'alert' },
          t('inbox.unavailable', { reason: inbox.error }), ' ',
          h('button', { type: 'button', className: 'dshcp-link', onClick: () => { onRetry(); } }, t('inbox.retry')));
      } else if (inbox.items.length > 0) {
        body = h('ul', { className: 'dshcp-rows' },
          inbox.items.map(item => h(MessageRow, { key: item.id, item, now, t, onOpen })));
      } else {
        body = h('div', { className: 'dshcp-empty' },
          inbox.phase === 'ready'
            ? t(`inbox.empty.${inbox.view}`, { file: inbox.dir === '' ? 'inbox.jsonl' : `${inbox.dir}/inbox.jsonl` })
            : t('inbox.loading'));
      }
      return h('div', { className: 'dshcp-section' },
        h('div', { className: 'dshcp-section-head' },
          h('h2', null, t('inbox.title'),
            inbox.counts.unread > 0 ? h('span', { className: 'dshcp-badge' }, String(inbox.counts.unread)) : null),
          inbox.view === 'active' && inbox.counts.unread > 0
            ? h('button', { type: 'button', className: 'dshcp-link', onClick: () => { onMarkAllRead(); } }, t('inbox.markAllRead'))
            : null,
          h('div', { className: 'dshcp-tabs' }, tab('active'), tab('archived'))),
        body,
        inbox.view === 'active' && inbox.phase === 'ready'
          ? h('p', { className: 'dshcp-caption' }, t('inbox.hint', { minutes: inbox.archiveAfterMinutes }))
          : null);
    }

    /** One message in full, over the panel. Escape and a click on the backdrop close it. */
    function DetailDialog({ t, detail, now, onClose, onArchive, onCopy, onMemo }) {
      const closeButton = React.useRef(null);
      const id = detail === null ? undefined : detail.id;
      React.useEffect(() => {
        if (id === undefined) return undefined;
        if (closeButton.current !== null) closeButton.current.focus();
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); };
      }, [id, onClose]);
      if (detail === null) return null;
      const item = detail.item;
      const level = ['info', 'success', 'warn', 'error'].includes(item.level) ? item.level : 'info';
      const at = Date.parse(item.ts);
      const link = httpUrlOf(item.ref);
      const body = typeof item.body === 'string' ? item.body : undefined;
      return h('div', { className: 'dshcp-overlay', onClick: () => { onClose(); } },
        h('div', {
          className: 'dshcp-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': item.title,
          onClick: (event) => { event.stopPropagation(); },
        },
        h('div', { className: 'dshcp-dialog-head' },
          h('h3', null, item.title || item.id),
          h('p', { className: 'dshcp-dialog-meta' },
            h('span', null, item.source),
            h('span', null, t(`level.${level}`)),
            Number.isNaN(at) ? null : h('span', null, relativeTime(t, now, at)))),
        h('div', { className: 'dshcp-dialog-body' },
          item.action === 'simpleagent-session'
            ? h('p', { className: 'dshcp-dialog-note' }, t('detail.simpleagentSession'))
            : null,
          detail.error !== null
            ? h('p', { className: 'dshcp-dialog-note', 'data-kind': 'error', role: 'alert' }, t('detail.failed', { reason: detail.error }))
            : null,
          body === undefined
            ? (detail.loading ? h('p', { className: 'dshcp-dialog-note' }, t('detail.loading')) : null)
            : h('pre', { className: 'dshcp-dialog-text' }, body === '' ? t('detail.empty') : body)),
        h('div', { className: 'dshcp-dialog-foot' },
          body
            ? h('button', { type: 'button', className: 'dshcp-button', onClick: () => { onCopy(); } },
              detail.copied ? t('detail.copied') : t('detail.copy'))
            : null,
          link !== undefined
            ? h('a', { className: 'dshcp-button', href: link, target: '_blank', rel: 'noopener noreferrer' }, t('detail.openLink'))
            : null,
          h('button', { type: 'button', className: 'dshcp-button', disabled: detail.memoAdded === true, onClick: () => { onMemo(); } },
            detail.memoAdded === true ? t('detail.memoAdded') : t('detail.memo')),
          item.archived
            ? null
            : h('button', { type: 'button', className: 'dshcp-button', onClick: () => { onArchive(item.id); } }, t('detail.archive')),
          h('button', { type: 'button', className: 'dshcp-button', ref: closeButton, onClick: () => { onClose(); } }, t('detail.close')))));
    }

    function PanelBody(props) {
      const { t, useSessions, useSessionStatus, useWorkspaces, useDesk, onDraft, onWorkspace, onDispatch, onOpenSession } = props;
      const {
        useInbox, onPanelMount, onInboxView, onMessageOpen, onMarkAllRead, onInboxRetry,
        onDetailClose, onDetailArchive, onDetailCopy, onDetailMemo,
        useMemos, onMemoDraft, onMemoSubmit, onMemoToggle, onMemoRemove, onMemoGoto, onMemoRetry, onTaskMemo,
        useAdvice, onOpenToday,
      } = props;
      // The three host hooks are global slot props; a missing one degrades to an empty view instead of a crash.
      const sessions = (typeof useSessions === 'function' ? useSessions(identity) : undefined) || EMPTY_SESSIONS;
      const statuses = (typeof useSessionStatus === 'function' ? useSessionStatus(identity) : undefined) || EMPTY_STATUS;
      const workspaces = (typeof useWorkspaces === 'function' ? useWorkspaces(identity) : undefined) || EMPTY_WORKSPACES;
      const desk = useDesk(identity);
      const inbox = useInbox(identity);
      const memos = useMemos(identity);
      const advice = useAdvice(identity);
      const todo = memos.items.filter(item => !item.done).length;
      const now = useNow(30000);
      // Tells the plugin the panel is on screen, so the 30-second poll reads the list instead of only the counts.
      React.useEffect(() => onPanelMount(), [onPanelMount]);
      const model = React.useMemo(
        () => buildModel(sessions, statuses, workspaces, now), [sessions, statuses, workspaces, now]);
      const workspaceId = effectiveWorkspaceId(desk.workspaceId, workspaces, sessions);
      const loading = sessions.phase !== 'ready' && model.rows.length === 0;

      return h('section', { className: 'dshcp-page', 'aria-label': t('title'), 'data-testid': 'control-panel-page' },
        h('style', null, CSS),
        h('div', { className: 'dshcp-scroll' },
          h('div', { className: 'dshcp-content' },
            // The counts sit on the title line rather than in a band of their own, to leave room for the desk.
            h('div', { className: 'dshcp-heading' },
              h('h1', null, t('title')),
              h('div', { className: 'dshcp-band' },
                h(Stat, { value: model.running, label: t('stat.running'), tone: model.running > 0 ? 'active' : undefined }),
                h(Stat, { value: model.waiting, label: t('stat.waiting'), tone: model.waiting > 0 ? 'warn' : undefined }),
                h(Stat, { value: inbox.counts.unread, label: t('stat.unread'), tone: inbox.counts.unread > 0 ? 'active' : undefined }),
                h(Stat, { value: todo, label: t('stat.todo') }),
                h(Stat, { value: model.total, label: t('stat.recent') }))),
            h(TodayLine, { t, advice, onOpen: onOpenToday }),
            h('div', { className: 'dshcp-cols' },
              h('div', { className: 'dshcp-main' },
                h('div', { className: 'dshcp-section' },
                  h('h2', null, t('dispatch.title')),
                  h(Composer, { t, desk, workspaces, workspaceId, onDraft, onWorkspace, onDispatch }),
                  h(Notice, { t, notice: desk.notice, workspaces, onOpen: onOpenSession })),
                h('div', { className: 'dshcp-section dshcp-tasks' },
                  h('h2', null, t('tasks.title')),
                  model.rows.length === 0
                    ? h('div', { className: 'dshcp-empty' }, loading ? t('tasks.loading') : t('tasks.empty'))
                    : h('ul', { className: 'dshcp-rows' },
                      model.rows.map(row => h(TaskRow, { key: row.id, row, now, t, onOpen: onOpenSession, onMemo: onTaskMemo }))))),
              h('div', { className: 'dshcp-side' },
                h(InboxSection, {
                  t, inbox, now, onView: onInboxView, onOpen: onMessageOpen, onMarkAllRead, onRetry: onInboxRetry,
                }),
                h(MemoSection, {
                  t, memos, onDraft: onMemoDraft, onSubmit: onMemoSubmit, onToggle: onMemoToggle,
                  onRemove: onMemoRemove, onGoto: onMemoGoto, onRetry: onMemoRetry,
                }))))),
        h(DetailDialog, {
          t, detail: inbox.detail, now, onClose: onDetailClose, onArchive: onDetailArchive, onCopy: onDetailCopy,
          onMemo: onDetailMemo,
        }));
    }

    /** Today's exercise plan and diet suggestion with all their items, and what state the day's run is in. */
    function TodayBody(props) {
      const { t, useAdvice, onTodayMount, onAdviceRun, onAdviceRetry } = props;
      const advice = useAdvice(identity);
      // While this page is on screen the advice it shows counts as seen, and a run is followed every few seconds.
      React.useEffect(() => onTodayMount(), [onTodayMount]);
      return h('section', { className: 'dshcp-page', 'aria-label': t('today.title'), 'data-testid': 'control-panel-today-page' },
        h('style', null, CSS),
        h('div', { className: 'dshcp-scroll' },
          h('div', { className: 'dshcp-content' },
            h('div', { className: 'dshcp-heading' },
              h('h1', null, t('today.title')),
              h('span', { className: 'dshcp-today-date' }, dateLabel(t, advice.data ? advice.data.date : undefined))),
            h(AdviceStrip, { t, advice, onRun: onAdviceRun, onRetry: onAdviceRetry }))));
    }

    /**
     * A plain-JS plugin has no type check against the host, and a throwing slot entry renders as a blank
     * panel. The boundary turns that into a visible message naming the error.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        console.error('dsh-plugin-control-panel: render failed', error);
      }

      render() {
        if (this.state.error === null) return this.props.children;
        const reason = String((this.state.error && this.state.error.message) || this.state.error);
        const t = typeof this.props.t === 'function' ? this.props.t : (key => key);
        return h('section', { className: 'dshcp-page', role: 'alert' },
          h('style', null, CSS),
          h('div', { className: 'dshcp-scroll' },
            h('div', { className: 'dshcp-content' },
              h('div', { className: 'dshcp-heading' }, h('h1', null, t(this.props.title))),
              h('div', { className: 'dshcp-empty' }, t('crash', { reason })))));
      }
    }

    function ControlPanelPage(props) {
      return h(Boundary, { t: props.t, title: 'title' }, h(PanelBody, props));
    }

    function TodayPage(props) {
      return h(Boundary, { t: props.t, title: 'today.title' }, h(TodayBody, props));
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'control-panel: dictionaries');
        const t = ctx.locale.bind(NS);

        // Lives outside the component: the frame unmounts a main panel when another is selected, and the
        // draft, the chosen workspace, and the last dispatch result must survive that.
        const desk = createStore({ workspaceId: undefined, draft: '', sending: false, notice: null });
        const patch = (change) => { desk.set({ ...desk.getSnapshot(), ...change }); };

        const dispatch = async () => {
          const state = desk.getSnapshot();
          if (state.sending) return;
          const workspaces = ctx.workspaces.list.getSnapshot();
          const sessions = ctx.sessions.list.getSnapshot();
          const target = resolveTarget(
            state.draft, workspaces.items || [], effectiveWorkspaceId(state.workspaceId, workspaces, sessions));
          if (target.error !== undefined) {
            patch({ notice: { kind: 'error', key: target.error, params: target.params } });
            return;
          }
          if (target.workspaceId === undefined) {
            patch({ notice: { kind: 'error', key: 'dispatch.noWorkspace' } });
            return;
          }
          if (target.text === '') {
            // A bare `@name` only switches the target workspace.
            if (state.draft.trim() !== '') patch({ workspaceId: target.workspaceId, draft: '', notice: null });
            return;
          }
          patch({ sending: true, notice: null });
          try {
            // Reuses the workspace's blank session when it has one, otherwise creates a session there.
            const sessionId = await ctx.uiWorkspace.connectWorkspace(target.workspaceId);
            const result = await ctx.sessions.using(sessionId, { source: RETAIN_SOURCE }, reference =>
              reference.binding.session.prompt([{ type: 'text', text: target.text }], 'queue'));
            if (!result || result.ok !== true) {
              const failure = result ? result.error : undefined;
              throw new Error((failure && (failure.message || failure.code)) || 'prompt was not accepted');
            }
            patch({
              workspaceId: target.workspaceId,
              draft: '',
              sending: false,
              notice: { kind: 'sent', sessionId, workspaceId: target.workspaceId },
            });
          } catch (error) {
            const reason = String((error && error.message) || error);
            patch({ sending: false, notice: { kind: 'error', key: 'dispatch.failed', params: { reason } } });
          }
        };

        // ---- inbox -------------------------------------------------------------------------------------
        const inbox = createStore(INITIAL_INBOX);
        const patchInbox = (change) => { inbox.set({ ...inbox.getSnapshot(), ...change }); };
        const reasonOf = error => String((error && error.message) || error);
        /** Only the newest list read may publish: a slow response for a view the user already left is dropped. */
        let listRead = 0;
        /** How many Control Panel instances are on screen; the poll reads the lists only while one is. */
        let mounted = 0;
        /** How many Today pages are on screen; only they follow a run closely and mark the advice seen. */
        let todayMounted = 0;

        const refreshInbox = async () => {
          const read = ++listRead;
          const view = inbox.getSnapshot().view;
          if (inbox.getSnapshot().phase === 'idle') patchInbox({ phase: 'loading' });
          try {
            const value = await api('inbox.list', { query: { view, limit: String(INBOX_LIMIT[view]) } });
            if (read !== listRead) return;
            patchInbox({
              items: value.items, counts: value.counts, archiveAfterMinutes: value.archiveAfterMinutes,
              dir: typeof value.dir === 'string' ? value.dir : '',
              phase: 'ready', error: null,
            });
          } catch (error) {
            if (read !== listRead) return;
            patchInbox({
              items: [], phase: 'error', error: error && error.routeMissing ? t('inbox.hostMissing') : reasonOf(error),
            });
          }
        };

        /** The sidebar dot's read while the panel is closed. A failure keeps the last known counts. */
        const refreshCounts = async () => {
          try {
            patchInbox({ counts: await api('inbox.count') });
          } catch (error) {
            console.debug('dsh-plugin-control-panel: inbox count unavailable', error);
          }
        };

        // ---- memos -------------------------------------------------------------------------------------
        const memos = createStore(INITIAL_MEMOS);
        const patchMemos = (change) => { memos.set({ ...memos.getSnapshot(), ...change }); };
        /** Raised by every read and every change, so a read that started before a change cannot undo it. */
        let memoRead = 0;

        const refreshMemos = async () => {
          const read = ++memoRead;
          if (memos.getSnapshot().phase === 'idle') patchMemos({ phase: 'loading' });
          try {
            const value = await api('memo.list');
            if (read !== memoRead) return;
            patchMemos({ items: value.items, phase: 'ready', error: null });
          } catch (error) {
            if (read !== memoRead) return;
            patchMemos({
              items: [], phase: 'error', error: error && error.routeMissing ? t('inbox.hostMissing') : reasonOf(error),
            });
          }
        };

        /** Send one change; the Host answers with the whole list. @returns whether it was saved. */
        const changeMemos = async (name, body) => {
          try {
            const value = await api(name, { body });
            memoRead += 1;
            patchMemos({ items: value.items, phase: 'ready', error: null, notice: null });
            return true;
          } catch (error) {
            patchMemos({ notice: { key: 'memo.failed', params: { reason: reasonOf(error) } } });
            return false;
          }
        };

        const submitMemo = async () => {
          const state = memos.getSnapshot();
          const text = state.draft.trim();
          if (state.saving || text === '') return;
          patchMemos({ saving: true });
          const saved = await changeMemos('memo.add', { text });
          // A failed save keeps the draft for another try.
          patchMemos(saved ? { saving: false, draft: '' } : { saving: false });
        };

        // ---- daily advice ------------------------------------------------------------------------------
        const advice = createStore(INITIAL_ADVICE);
        const patchAdvice = (change) => { advice.set({ ...advice.getSnapshot(), ...change }); };
        /** Raised by every read and every run request, so an older read cannot overwrite a newer answer. */
        let adviceRead = 0;
        /** The pending quick re-read while a run is going, or null. */
        let adviceFollow = null;

        /** While a run is going and the Today page is on screen, read again in a few seconds instead of 30. */
        const followAdvice = () => {
          const data = advice.getSnapshot().data;
          if (adviceFollow !== null || todayMounted === 0 || data === null || data.running === null) return;
          adviceFollow = setTimeout(() => {
            adviceFollow = null;
            void refreshAdvice();
          }, ADVICE_FOLLOW_MS);
          if (typeof adviceFollow === 'object' && typeof adviceFollow.unref === 'function') adviceFollow.unref();
        };

        /**
         * Advice shown on a visible Today page counts as seen. The page's copy changes at once so the sidebar
         * dot goes out now; the Host records the `generated_at` the page showed.
         */
        const markSeen = async () => {
          const state = advice.getSnapshot();
          if (todayMounted === 0 || (typeof document !== 'undefined' && document.hidden) || !unseenOf(state)) return;
          const generatedAt = state.data.record.generated_at;
          const read = ++adviceRead;
          patchAdvice({ data: { ...state.data, seen: generatedAt } });
          try {
            const value = await api('advice.seen', { body: { generated_at: generatedAt } });
            if (read === adviceRead) patchAdvice({ data: value });
          } catch (error) {
            console.debug('dsh-plugin-control-panel: could not record the advice as seen', error);
          }
        };

        const refreshAdvice = async () => {
          const read = ++adviceRead;
          if (advice.getSnapshot().phase === 'idle') patchAdvice({ phase: 'loading' });
          try {
            const value = await api('advice.today');
            if (read !== adviceRead) return;
            patchAdvice({ data: value, phase: 'ready', error: null });
            followAdvice();
            void markSeen();
          } catch (error) {
            if (read !== adviceRead) return;
            patchAdvice({ phase: 'error', error: error && error.routeMissing ? t('inbox.hostMissing') : reasonOf(error) });
          }
        };

        const runAdvice = async () => {
          if (advice.getSnapshot().starting) return;
          patchAdvice({ starting: true, notice: null });
          try {
            const value = await api('advice.run', { body: {} });
            adviceRead += 1;
            patchAdvice({ data: value, phase: 'ready', error: null, starting: false });
            followAdvice();
          } catch (error) {
            patchAdvice({ starting: false, notice: reasonOf(error) });
          }
        };

        /** Show a session only if the host still lists it; opening an unknown id would throw inside the host. */
        const openListedSession = (sessionId) => {
          const listed = ctx.sessions.list.getSnapshot();
          if (!listed.byId || listed.byId[sessionId] === undefined) return false;
          ctx.uiWorkspace.openSession(sessionId);
          return true;
        };

        const poll = () => {
          if (typeof document !== 'undefined' && document.hidden) return;
          // Read even with both pages closed: the Today entry's dot and the desk's line depend on it.
          void refreshAdvice();
          if (mounted > 0) {
            void refreshInbox();
            void refreshMemos();
          } else {
            void refreshCounts();
          }
        };

        ctx.effect(() => {
          const timer = setInterval(poll, INBOX_POLL_MS);
          // Node timers (tests) must not hold the process open; a browser timer id has no unref.
          if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
          const onVisibility = () => { poll(); };
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
          void refreshCounts();
          void refreshAdvice();
          return () => {
            clearInterval(timer);
            if (adviceFollow !== null) clearTimeout(adviceFollow);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
          };
        }, 'control-panel: inbox polling');

        const closeDetail = () => { patchInbox({ detail: null }); };

        /**
         * Opening is what starts a message's archive countdown, so every open records the read first.
         * A message about a DSH session jumps there; if that session is gone, it opens as text instead.
         */
        const openMessage = async (item) => {
          const ref = item.ref || {};
          if (item.action === 'dsh-session' && openListedSession(ref.dsh_session_id)) {
            try {
              await api('inbox.read', { body: { id: item.id } });
            } catch (error) {
              console.debug('dsh-plugin-control-panel: could not mark the message read', error);
            }
            void refreshInbox();
            return;
          }
          patchInbox({ detail: { id: item.id, item, loading: true, error: null, copied: false } });
          const stillOpen = () => {
            const detail = inbox.getSnapshot().detail;
            return detail !== null && detail.id === item.id ? detail : undefined;
          };
          try {
            await api('inbox.read', { body: { id: item.id } });
            const full = await api('inbox.item', { query: { id: item.id } });
            const detail = stillOpen();
            if (detail !== undefined) patchInbox({ detail: { ...detail, item: full, loading: false } });
          } catch (error) {
            const detail = stillOpen();
            if (detail !== undefined) patchInbox({ detail: { ...detail, loading: false, error: reasonOf(error) } });
          }
          void refreshInbox();
        };

        const archiveMessage = async (id) => {
          try {
            await api('inbox.archive', { body: { id } });
            closeDetail();
          } catch (error) {
            const detail = inbox.getSnapshot().detail;
            if (detail !== null && detail.id === id) patchInbox({ detail: { ...detail, error: reasonOf(error) } });
          }
          void refreshInbox();
        };

        const markAllRead = async () => {
          try {
            await api('inbox.read', { body: { id: 'all' } });
          } catch (error) {
            patchInbox({ phase: 'error', error: reasonOf(error) });
            return;
          }
          void refreshInbox();
        };

        const copyDetail = async () => {
          const detail = inbox.getSnapshot().detail;
          if (detail === null || typeof detail.item.body !== 'string') return;
          try {
            await navigator.clipboard.writeText(detail.item.body);
          } catch (error) {
            console.debug('dsh-plugin-control-panel: clipboard unavailable', error);
            return;
          }
          const current = inbox.getSnapshot().detail;
          if (current !== null && current.id === detail.id) patchInbox({ detail: { ...current, copied: true } });
        };

        /** Turn the open message into a memo that keeps the message's jump target. */
        const memoFromDetail = async () => {
          const detail = inbox.getSnapshot().detail;
          if (detail === null || detail.memoAdded === true) return;
          const item = detail.item;
          const ref = item.ref || {};
          const target = item.action === 'dsh-session' ? { ref: { dsh_session_id: ref.dsh_session_id } }
            : item.action === 'simpleagent-session' ? { kind: 'session', ref: { space_id: ref.space_id, session_id: ref.session_id } }
              : {};
          const saved = await changeMemos('memo.add', { text: item.title || item.id, ...target });
          const current = inbox.getSnapshot().detail;
          if (current === null || current.id !== detail.id) return;
          patchInbox({
            detail: saved ? { ...current, memoAdded: true } : { ...current, error: memos.getSnapshot().notice.params.reason },
          });
        };

        // One object per page for the plugin's lifetime: effects in the pages depend on these callbacks' identities.
        const todayFace = {
          hooks: { advice },
          onTodayMount: () => {
            todayMounted += 1;
            void refreshAdvice();
            return () => { todayMounted -= 1; };
          },
          onAdviceRun: () => { void runAdvice(); },
          onAdviceRetry: () => {
            patchAdvice({ phase: 'loading', error: null });
            void refreshAdvice();
          },
        };
        const panelFace = {
          hooks: { desk, inbox, memos, advice },
          onOpenToday: () => {
            try {
              ctx.layout.selectPanel(TODAY_ID);
            } catch (error) {
              console.debug('dsh-plugin-control-panel: could not open the Today page', error);
            }
          },
          onMemoDraft: (draft) => { patchMemos({ draft }); },
          onMemoSubmit: () => { void submitMemo(); },
          onMemoToggle: (item) => { void changeMemos('memo.update', { id: item.id, done: !item.done }); },
          onMemoRemove: (id) => { void changeMemos('memo.remove', { id }); },
          onMemoGoto: (item) => {
            if (openListedSession(item.ref.dsh_session_id)) patchMemos({ notice: null });
            else patchMemos({ notice: { key: 'memo.sessionGone' } });
          },
          onMemoRetry: () => {
            patchMemos({ phase: 'loading', error: null });
            void refreshMemos();
          },
          onTaskMemo: (row) => { void changeMemos('memo.add', { text: row.title, ref: { dsh_session_id: row.id } }); },
          onDetailMemo: () => { void memoFromDetail(); },
          onDraft: (draft) => { patch({ draft }); },
          onWorkspace: (workspaceId) => { patch({ workspaceId }); },
          onDispatch: () => { void dispatch(); },
          onOpenSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId); },
          onPanelMount: () => {
            mounted += 1;
            void refreshInbox();
            void refreshMemos();
            void refreshAdvice();
            return () => { mounted -= 1; };
          },
          onInboxView: (view) => {
            if (view === inbox.getSnapshot().view) return;
            patchInbox({ view, items: [], phase: 'loading', error: null });
            void refreshInbox();
          },
          onInboxRetry: () => {
            patchInbox({ phase: 'loading', error: null });
            void refreshInbox();
          },
          onMessageOpen: (item) => { void openMessage(item); },
          onMarkAllRead: () => { void markAllRead(); },
          onDetailClose: closeDetail,
          onDetailArchive: (id) => { void archiveMessage(id); },
          onDetailCopy: () => { void copyDetail(); },
        };
        const iconFace = { hooks: { inbox } };
        const todayIconFace = { hooks: { advice } };

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => panelFace,
        }, ControlPanelPage));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: TODAY_ID,
          locale: NS,
          inject: () => todayFace,
        }, TodayPage));

        // Order 0 is Plugins and 10 is Automations; 20 and 21 put these two entries after both, side by side.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel'),
          inject: () => iconFace,
        }, PanelIcon));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: TODAY_ID,
          order: 21,
          locale: NS,
          label: () => t('today'),
          inject: () => todayIconFace,
        }, TodayIcon));
      },
    };
  },
});
