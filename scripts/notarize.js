const { execSync } = require("child_process");
const path = require("path");

/**
 * electron-builder afterAllArtifactBuild hook.
 *
 * Submits macOS DMG/ZIP artifacts to Apple's notary service.
 * Does NOT block on --wait (Apple's in-depth analysis for new accounts
 * can exceed CI timeouts). Prints submission UUIDs for manual follow-up.
 *
 * To check status later:
 *   xcrun notarytool info <UUID> --apple-id ... --team-id ... --password ...
 *
 * To staple after acceptance:
 *   xcrun stapler staple <artifact>
 *
 * Requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID env vars.
 */
module.exports = async function (context) {
  if (process.platform !== "darwin") return [];

  const notarizableExts = [".dmg", ".zip"];
  const artifacts = context.artifactPaths.filter((p) =>
    notarizableExts.some((ext) => p.endsWith(ext))
  );

  if (artifacts.length === 0) return [];

  const appleId = process.env.APPLE_ID;
  const appPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appPassword || !teamId) {
    console.log("[notarize] Apple credentials not set, skipping notarization");
    console.log("[notarize] Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID to enable");
    return artifacts;
  }

  const submissionIds = [];

  for (const artifactPath of artifacts) {
    try {
      console.log(`[notarize] Submitting ${path.basename(artifactPath)} for notarization...`);

      const result = execSync(
        `xcrun notarytool submit "${artifactPath}" ` +
          `--apple-id "${appleId}" --team-id "${teamId}" --password "${appPassword}"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5 * 60 * 1000 }
      );

      const idMatch = result.match(/id:\s*([0-9a-f-]{36})/);
      if (idMatch) {
        submissionIds.push({ file: path.basename(artifactPath), id: idMatch[1] });
        console.log(`[notarize] Submitted ${path.basename(artifactPath)} → UUID: ${idMatch[1]}`);
      }
      console.log(result);
    } catch (err) {
      console.error(`[notarize] Submission failed for ${path.basename(artifactPath)}: ${err.message}`);
      if (err.stdout) console.error(err.stdout);
      if (err.stderr) console.error(err.stderr);
    }
  }

  if (submissionIds.length > 0) {
    console.log("\n[notarize] ═══════════════════════════════════════════════");
    console.log("[notarize] Submissions sent (check status manually):");
    for (const s of submissionIds) {
      console.log(`[notarize]   ${s.file} → ${s.id}`);
    }
    console.log("[notarize] Check:  xcrun notarytool info <UUID> --keychain-profile <profile>");
    console.log("[notarize] Staple: xcrun stapler staple <artifact>");
    console.log("[notarize] ═══════════════════════════════════════════════\n");
  }

  return artifacts;
};
