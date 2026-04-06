const { execSync } = require("child_process");
const path = require("path");

/**
 * electron-builder afterAllArtifactBuild hook.
 *
 * Submits macOS DMG/ZIP artifacts to Apple's notary service and staples
 * the ticket on success. Requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
 * and APPLE_TEAM_ID environment variables.
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

  for (const artifactPath of artifacts) {
    try {
      console.log(`[notarize] Submitting ${path.basename(artifactPath)} for notarization...`);
      const result = execSync(
        `xcrun notarytool submit "${artifactPath}" ` +
          `--apple-id "${appleId}" --team-id "${teamId}" --password "${appPassword}" ` +
          `--wait --timeout 30m`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 35 * 60 * 1000 }
      );
      console.log(result);

      if (result.includes("status: Accepted")) {
        console.log(`[notarize] Stapling ticket to ${path.basename(artifactPath)}`);
        execSync(`xcrun stapler staple "${artifactPath}"`, { stdio: "pipe" });
        console.log(`[notarize] Stapled successfully`);
      } else {
        console.warn(`[notarize] Notarization not accepted, skipping staple. Full output above.`);
      }
    } catch (err) {
      console.error(`[notarize] Notarization failed for ${path.basename(artifactPath)}: ${err.message}`);
      if (err.stdout) console.error(err.stdout);
      if (err.stderr) console.error(err.stderr);
    }
  }

  return artifacts;
};
