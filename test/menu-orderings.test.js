const assert = require('node:assert/strict');
const test = require('node:test');
const { mainFixture, tick } = require('./main-fixture');
const statuses = ['running', 'stopped', 'starting', 'stopping', 'error', 'not-installed', 'other-home'];
const labels = {
  running: 'Home is running', stopped: 'Home is stopped', starting: 'Home is starting',
  stopping: 'Home is stopping', error: 'Home needs attention',
  'not-installed': 'Home is not installed', 'other-home': 'Another Home is running',
};
const verbs = { start: 'Starting Home…', stop: 'Stopping Home…', update: 'Updating ElastOS…',
  open: 'Opening Home…', maintenance: 'Working on ElastOS…' };
const errorLabel = 'The download stopped.';
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const events = [...Object.keys(verbs), 'resolve', 'reject', ...statuses.map(s => `read:${s}`), 'read:reject', 'quit'];

// Explore legal event histories, including reads already pending when an action begins.
// The model contains facts only. Expectations do not call a production state helper.
function next(model, event) {
  const m = { ...model };
  if (event in verbs) {
    if (m.flight || m.quit) return null;
    const idle = m.failure || m.observed !== 'other-home';
    if (!idle || (event === 'update' && !m.offer)) return null;
    if (event === 'start' && !(m.failure || ['stopped', 'starting', 'stopping', 'error'].includes(m.observed))) return null;
    if (event === 'stop' && (m.failure || m.observed !== 'running')) return null;
    m.flight = event; m.failure = false; m.generation++;
  } else if (event === 'resolve' || event === 'reject') {
    if (!m.flight) return null;
    if (event === 'reject') m.failure = true;
    if (event === 'resolve' && m.flight === 'update') m.offer = false;
    m.flight = null;
  } else if (event.startsWith('read:')) {
    if (m.readGeneration === null) return null;
    const status = event.slice(5);
    if (status !== 'reject' && m.readGeneration === m.generation) m.observed = status;
    m.readGeneration = null;
  } else {
    if (m.quit) return null;
    m.quit = true; m.generation++;
  }
  if (!m.quit && !m.flight && m.readGeneration === null) m.readGeneration = m.generation;
  return m;
}
const initial = { observed: 'running', flight: null, failure: false, quit: false, offer: true, generation: 0, readGeneration: 0 };
function* histories(model = initial, path = []) {
  if (path.length === 4) { yield path; return; }
  let children = false;
  for (const event of events) {
    const after = next(model, event);
    if (after) { children = true; yield* histories(after, [...path, event]); }
  }
  if (!children) yield path;
}

test('real menu obeys the state table for every legal event ordering through depth 4', async t => {
  let sequences = 0, steps = 0;
  const failures = new Map();
  for (const history of histories()) {
    const f = await mainFixture({ status: 'running', ...(process.env.ELASTOS_MENU_ENTRY ? { entry: process.env.ELASTOS_MENU_ENTRY } : {}) });
    let model = initial, observed = 'running', action, read, pending;
    f.launch.getStatus = async () => observed;
    f.launch.shutdown = async () => {}; // No host processes, including Quit.
    async function armRead() {
      if (read || model.flight || model.quit) return;
      read = defer();
      const normal = f.launch.getStatus;
      f.launch.getStatus = () => read.promise;
      void f.timers[0]();
      f.launch.getStatus = normal;
    }
    await armRead();
    for (const [index, event] of history.entries()) {
      const before = model;
      const previousLabel = f.tray.menu[0].label;
      model = next(model, event);
      try {
        if (event in verbs) {
          action = defer();
          if (event === 'start' || event === 'stop') {
            f.launch[event] = () => action.promise;
            await f.click(event === 'start' ? 'Start Home' : 'Stop Home');
          } else if (event === 'update') {
            f.launch.update = () => action.promise;
            // The post-update health check should not introduce a second deferred action.
            f.launch.start = async () => {};
            await f.click('Update to 2.0.1…');
            pending = f.invoke('update');
          } else if (event === 'open') {
            const normal = f.launch.getStatus;
            f.launch.getStatus = () => action.promise.then(() => 'running');
            await f.click('Open Home');
            f.launch.getStatus = normal;
          } else {
            f.dialog.showMessageBox = () => action.promise.then(() => ({ response: 0 }));
            await f.click('Reset ElastOS…');
          }
        } else if (event === 'resolve' || event === 'reject') {
          if (event === 'reject') action.reject(new Error('raw failure'));
          else action.resolve();
          await tick(); await tick();
          if (pending) { await pending; pending = null; }
        } else if (event.startsWith('read:')) {
          const status = event.slice(5);
          if (status === 'reject') read.reject(new Error('read failed'));
          else read.resolve(status);
          observed = model.observed;
          read = null;
        } else f.app.emit('before-quit', { preventDefault() {} });
      } catch (error) {
        failures.set('event dispatch', `${history.slice(0, index + 1).join(' > ')}: ${error.message}`);
        break;
      }
      await tick(); await tick();
      const menu = f.tray.menu, label = menu[0].label;
      const expected = model.quit ? 'Stopping Home…' : model.flight ? verbs[model.flight]
        : model.failure ? errorLabel : labels[model.observed];
      const context = history.slice(0, index + 1).join(' > ');
      function check(name, fn) {
        try { fn(); } catch (error) { if (!failures.has(name)) failures.set(name, `${context}: ${error.message}`); }
      }
      check('derived label', () => assert.equal(label, expected));
      check('busy verb requires flight or Quit', () => {
        if (Object.values(verbs).includes(label)) assert.ok(model.flight || model.quit);
      });
      check('Quit dominates until exit', () => { if (model.quit) assert.equal(label, 'Stopping Home…'); });
      check('reads cannot hide action or failure', () => {
        if (event.startsWith('read:') && (before.flight || before.failure || before.quit)) assert.equal(label, previousLabel);
      });
      check('failed action permits retry', () => {
        if (model.failure && !model.quit && !model.flight) assert.equal(menu.find(i => i.label === 'Start Home')?.enabled, true);
      });
      check('successful action and read show observation', () => {
        if (!model.quit && !model.flight && !model.failure) assert.equal(label, labels[model.observed]);
      });
      steps++;
      await armRead();
    }
    // Release only this fixture's pending promises, without introducing a new action.
    read?.resolve(observed);
    action?.resolve();
    await tick(); await tick();
    if (pending) await pending;
    sequences++;
  }
  t.diagnostic(`${sequences} histories, ${steps} checked steps, depth 4, ${failures.size} failed invariants`);
  assert.deepEqual([...failures], []);
});
