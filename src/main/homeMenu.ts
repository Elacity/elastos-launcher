import type { MenuItemConstructorOptions } from 'electron';
import type { TargetStatus, UpdateCheck } from './targets/types';

export type HomeState = TargetStatus | 'updating';
export interface MenuState {
  status: HomeState;
  platform: string;
  login?: boolean;
  pc2?: boolean;
  update?: Pick<UpdateCheck, 'latest' | 'updateAvailable'> | null;
  error?: string;
  busy?: boolean;
}
export interface MenuActions {
  open(): void; start(): void; stop(): void; update(): void; login(enabled: boolean): void;
  diagnostics(): void; logs(): void; removePc2(): void; reset(): void; uninstall(): void; about(): void; quit(): void;
}
const statusText: Record<HomeState, string> = {
  running: 'Home is running', stopped: 'Home is stopped', starting: 'Starting Home…',
  stopping: 'Stopping Home…', updating: 'Updating ElastOS…', error: 'Home needs attention',
  'not-installed': 'Home is not installed', 'other-home': 'Another Home is running',
};
export function trayPresentation(status: HomeState) {
  return {
    image: status === 'running' ? 'running' : ['starting', 'stopping', 'updating'].includes(status) ? 'busy'
      : ['error', 'other-home'].includes(status) ? 'attention' : 'stopped',
    tooltip: `ElastOS: ${statusText[status]}`,
  };
}

/** This template is the menu on every platform, and the source of the review artifacts. */
export function buildHomeMenu(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  const idle = !state.busy && !['starting', 'stopping', 'updating', 'other-home'].includes(state.status);
  return [
    { label: state.status === 'error' && state.error ? state.error : statusText[state.status], enabled: false },
    separator,
    { label: 'Open Home', accelerator: 'CommandOrControl+O',
      ...(state.platform === 'darwin' ? { sublabel: 'localhost:8090' } : {}),
      enabled: idle, click: actions.open },
    { label: state.status === 'running' ? 'Stop Home' : 'Start Home',
      enabled: idle && ['running', 'stopped', 'error'].includes(state.status),
      click: state.status === 'running' ? actions.stop : actions.start },
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
