import type { HomeStartResult } from './targets/types';

/** Coalesce Finder, second-instance and menu opens while Home is starting. */
export function createOpenHome(launch: {
  getStatus(): Promise<string>;
  start(): Promise<HomeStartResult>;
  openInBrowser(): void;
}, install: () => void, startOpensBrowser = false): () => Promise<void> {
  let opening: Promise<void> | null = null;
  return () => {
    if (opening) return opening;
    opening = (async () => {
      const status = await launch.getStatus();
      if (status === 'not-installed') { install(); return; }
      if (status === 'other-home') throw new Error('Another Home is running on this computer.');
      if (status !== 'running') {
        const result = await launch.start();
        if (result === 'stopped') return;
        if (startOpensBrowser && (result === 'started' || result === 'already-running')) return;
        // Start can reuse the controller after an earlier status probe saw it
        // starting. That call did not run home --browser again.
        const deadline = Date.now() + 150_000;
        while (await launch.getStatus() !== 'running') {
          if (Date.now() >= deadline) throw new Error('Home did not become ready in time. Try Open Home again.');
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      launch.openInBrowser();
    })().finally(() => { opening = null; });
    return opening;
  };
}
