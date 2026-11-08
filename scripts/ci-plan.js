const fs = require('node:fs');

const allPlatforms = ['mac', 'linux', 'windows'];
const runtimeRows = [
  { os: 'macos-latest', platform: 'darwin-arm64', lane: 'mac', packages: '' },
  {
    os: 'ubuntu-24.04', platform: 'linux-x64', lane: 'linux',
    packages: 'xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libgtk-3-0t64 libxss1',
  },
  {
    os: 'ubuntu-22.04-arm', platform: 'linux-arm64', lane: 'linux',
    packages: 'xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libgtk-3-0 libxss1 libayatana-appindicator3-1',
  },
];
const buildRows = [
  { os: 'macos-latest', platform: 'mac', lane: 'mac' },
  { os: 'ubuntu-latest', platform: 'linux', lane: 'linux' },
  { os: 'windows-latest', platform: 'win', lane: 'windows' },
];

function plan({ eventName, ref = '', headRef = '', baseRef = '', requested = '' }) {
  let platforms = [];
  if (requested || eventName === 'workflow_dispatch') {
    if (!['', 'none', 'all', ...allPlatforms].includes(requested)) {
      throw new Error(`Invalid platforms: ${requested}`);
    }
    platforms = requested === 'all' ? allPlatforms : allPlatforms.filter((platform) => platform === requested);
  } else if ((eventName === 'pull_request' && baseRef === 'main') ||
             (eventName === 'push' && (ref === 'refs/heads/main' || ref.startsWith('refs/tags/v')))) {
    platforms = allPlatforms;
  } else {
    const branch = eventName === 'pull_request' ? headRef : ref.replace(/^refs\/heads\//, '');
    if (branch.startsWith('test/launcher-mac')) platforms = ['mac'];
    if (branch.startsWith('test/launcher-jetson') || branch.startsWith('test/launcher-linux')) platforms = ['linux'];
    if (branch.startsWith('test/launcher-windows')) platforms = ['windows'];
  }
  return {
    platforms,
    runtime: runtimeRows.filter((row) => platforms.includes(row.lane)),
    build: buildRows.filter((row) => platforms.includes(row.lane)),
  };
}

module.exports = { plan };

if (require.main === module) {
  const result = plan({
    eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    headRef: process.env.GITHUB_HEAD_REF, baseRef: process.env.GITHUB_BASE_REF,
    requested: process.env.INPUT_PLATFORMS,
  });
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join(''));
  }
}
