import type { MenuItemConstructorOptions } from 'electron';
import type { TargetStatus, UpdateCheck } from './targets/types';

export type HomeActionKind = 'start' | 'stop' | 'update' | 'open' | 'maintenance';
export interface HomeModel {
  observed: TargetStatus;
  inFlight: { kind: HomeActionKind; generation: number } | null;
  failure: string | null;
  quitting: boolean;
}
export interface MenuState extends HomeModel {
  platform: string;
  login?: boolean;
  pc2?: boolean;
  update?: Pick<UpdateCheck, 'latest' | 'updateAvailable'> | null;
}
export interface MenuActions {
  open(): void; start(): void; stop(): void; update(): void; login(enabled: boolean): void;
  diagnostics(): void; logs(): void; removePc2(): void; reset(): void; uninstall(): void; about(): void; quit(): void;
}
const statusText: Record<TargetStatus, string> = {
  running: 'Home is running', stopped: 'Home is stopped', starting: 'Home is starting',
  stopping: 'Home is stopping', error: 'Home needs attention',
  'not-installed': 'Home is not installed', 'other-home': 'Another Home is running',
};
const actionText: Record<HomeActionKind, string> = {
  start: 'Starting Home…', stop: 'Stopping Home…', update: 'Updating ElastOS…',
  open: 'Opening Home…', maintenance: 'Working on ElastOS…',
};
function presentation(state: HomeModel) {
  const busy = state.quitting || state.inFlight !== null;
  const status = busy ? 'starting' : state.failure ? 'error' : state.observed;
  const label = state.quitting ? 'Stopping Home…' : state.inFlight ? actionText[state.inFlight.kind]
    : state.failure || statusText[state.observed];
  return { status, label, idle: !busy && status !== 'other-home', busy };
}
export function trayPresentation(state: HomeModel) {
  const { status, label, busy } = presentation(state);
  return {
    image: busy ? 'busy' : status === 'running' ? 'running'
      : ['error', 'other-home'].includes(status) ? 'attention' : 'stopped',
    tooltip: `ElastOS: ${label}`,
  };
}

/** This template is the menu on every platform, and the source of the review artifacts. */
export function buildHomeMenu(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  const { idle, status, label } = presentation(state);
  return [
    { label, enabled: false },
    separator,
    { label: 'Open Home', accelerator: 'CommandOrControl+O',
      ...(state.platform === 'darwin' ? { sublabel: 'localhost:8090' } : {}),
      enabled: idle, click: actions.open },
    { label: status === 'running' ? 'Stop Home' : 'Start Home',
      enabled: idle && ['running', 'stopped', 'starting', 'stopping', 'error'].includes(status),
      click: status === 'running' ? actions.stop : actions.start },
    ...(state.update?.updateAvailable && state.update.latest ? [separator,
      { label: `Update to ${state.update.latest}…`, enabled: idle, click: actions.update }] : []),
    separator,
    { label: 'Start Home at Login', type: 'checkbox', enabled: idle, checked: Boolean(state.login), click: item => actions.login(item.checked) },
    { label: 'Troubleshoot', submenu: [
      { label: 'Copy Diagnostics', click: actions.diagnostics },
      { label: 'Show Home Logs', click: actions.logs },
      ...(state.pc2 ? [{ label: 'Remove Old PC2 Files…', enabled: idle, click: actions.removePc2 }] : []),
      separator,
      { label: 'Reset ElastOS…', enabled: idle, click: actions.reset },
      { label: 'Uninstall ElastOS…', enabled: idle, click: actions.uninstall },
    ] },
    separator,
    { label: 'About ElastOS', click: actions.about },
    { label: 'Quit ElastOS', accelerator: 'CommandOrControl+Q', click: actions.quit },
  ];
}
