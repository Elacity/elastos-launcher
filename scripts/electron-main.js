// Inspector requests can arrive inside a macOS native menu/window callback.
// Run the observation on Node's event loop so its result settles there.
async function readMain(app, read, arg) {
  return app.evaluate((electron, { source, arg }) => new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve((0, eval)(`(${source})`)(electron, arg)); }
      catch (error) { reject(error); }
    });
  }), { source: String(read), arg });
}
module.exports = { readMain };
