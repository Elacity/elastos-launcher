/** Coalesce Finder, second-instance and menu opens while Home is starting. */
export function createOpenHome(launch: {
  getStatus(): Promise<string>;
  start(): Promise<void>;
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
        await launch.start();
        if (startOpensBrowser) return;
      }
      launch.openInBrowser();
    })().finally(() => { opening = null; });
    return opening;
  };
}
