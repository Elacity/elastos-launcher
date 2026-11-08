const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Ported from SashaMIT's v1.4.0 fix, commit 6e28656 (PR #5).
// Keep the Apple password in the child's environment and secure prompt. Never
// interpolate it into a command, process argument, exception, or saved file.
const submit = `
set timeout 1800
log_user 0
spawn -noecho xcrun notarytool submit $env(ELASTOS_NOTARY_ARTIFACT) --apple-id $env(APPLE_ID) --team-id $env(APPLE_TEAM_ID) --wait --timeout 25m --output-format json
expect {
  -nocase -re {password[^:]*:} { send -- "$env(APPLE_APP_SPECIFIC_PASSWORD)\\r" }
  timeout { puts "Timed out waiting for the password prompt"; exit 124 }
  eof { puts $expect_out(buffer); exit 1 }
}
expect {
  -re {\\{.*\\}} { puts $expect_out(0,string); exp_continue }
  timeout { exit 124 }
  eof { puts $expect_out(buffer); set result [wait]; exit [lindex $result 3] }
}
`;

async function notarize(context) {
  const artifacts = context.artifactPaths.filter((file) => /\.(dmg|zip)$/.test(file));
  if (!artifacts.length) throw new Error('No macOS artifact was produced.');
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) throw new Error(`Missing required notarization credential ${name}.`);
  }
  for (const artifact of artifacts) {
    const name = path.basename(artifact);
    console.log(`[notarize] Submitting ${name} and waiting for Apple.`);
    let result;
    try {
      const output = execFileSync('/usr/bin/expect', ['-c', submit], {
        env: { ...process.env, ELASTOS_NOTARY_ARTIFACT: artifact },
        encoding: 'utf8', timeout: 30 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      result = JSON.parse(output.trim());
    } catch (error) {
      let diagnostic = [error.stdout, error.stderr].filter(Boolean).map(String).join('\n');
      for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
        const secret = process.env[key];
        if (secret) diagnostic = diagnostic.split(secret).join('[redacted]');
      }
      throw new Error(`[notarize] Submission failed for ${name} (exit ${error.status ?? 'unknown'}). ${diagnostic.slice(-8000)}`);
    }
    console.log(`[notarize] ${name} status=${result.status} id=${result.id}`);
    if (result.status !== 'Accepted') throw new Error(`[notarize] ${name} was not Accepted.`);
    if (artifact.endsWith('.dmg')) {
      execFileSync('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit', timeout: 120000 });
      execFileSync('xcrun', ['stapler', 'validate', artifact], { stdio: 'inherit', timeout: 120000 });
    }
  }
  return artifacts;
}

module.exports = async function (context) {
  if (process.platform !== 'darwin') return [];
  const strict = process.env.MAC_RELEASE_STRICT === 'true';
  if (process.env.NOTARIZE_MAC !== 'true') {
    console.log('[notarize] Skipped because notarization was not requested.');
    return [];
  }
  try {
    return await notarize(context);
  } catch (error) {
    if (strict) throw error;
    console.warn(`[notarize] Test build continues without notarization: ${error.message}`);
    return [];
  }
};
