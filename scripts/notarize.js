const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * electron-builder afterAllArtifactBuild hook.
 *
 * On macOS, electron-builder on Apple Silicon creates APFS DMGs by default.
 * Apple's notary service has a known bug (DTS r. 134264492) where APFS DMGs
 * get stuck "In Progress" permanently. This script re-creates the DMG as
 * HFS+ (UDZO) which notarizes reliably, then optionally notarizes + staples
 * when APPLE_ID credentials are available.
 */
module.exports = async function (context) {
  if (process.platform !== "darwin") return [];

  const dmgArtifacts = context.artifactPaths.filter((p) => p.endsWith(".dmg"));
  if (dmgArtifacts.length === 0) return [];

  const outDir = context.outDir;
  const productName = context.configuration.productName || "ElastOS";

  const appCandidates = [
    path.join(outDir, "mac-arm64", `${productName}.app`),
    path.join(outDir, "mac", `${productName}.app`),
  ];
  const actualApp = appCandidates.find((p) => fs.existsSync(p));

  if (!actualApp) {
    console.log("[notarize] No .app bundle found, skipping HFS+ DMG rebuild");
    return dmgArtifacts;
  }

  const rebuiltPaths = [];

  for (const dmgPath of dmgArtifacts) {
    try {
      const info = execSync(`hdiutil imageinfo "${dmgPath}" 2>&1`, { encoding: "utf8" });
      const isHFS = info.includes("HFS") || info.includes("UDZO");

      if (isHFS && !info.includes("APFS")) {
        console.log(`[notarize] ${path.basename(dmgPath)} is already HFS+, skipping rebuild`);
        rebuiltPaths.push(dmgPath);
        continue;
      }

      console.log(`[notarize] Rebuilding ${path.basename(dmgPath)} as HFS+ (avoiding APFS notarization bug)`);

      const ts = Date.now();
      const tmpRaw = `/tmp/elastos-hfs-raw-${ts}.dmg`;
      const mountPoint = `/tmp/elastos-mnt-${ts}`;

      execSync(`hdiutil create -size 300m -fs HFS+ -volname "${productName}" "${tmpRaw}"`, { stdio: "pipe" });
      execSync(`hdiutil attach "${tmpRaw}" -readwrite -mountpoint "${mountPoint}"`, { stdio: "pipe" });
      execSync(`cp -R "${actualApp}" "${mountPoint}/"`, { stdio: "pipe" });
      execSync(`ln -s /Applications "${mountPoint}/Applications"`, { stdio: "pipe" });
      execSync(`hdiutil detach "${mountPoint}"`, { stdio: "pipe" });

      fs.unlinkSync(dmgPath);
      execSync(`hdiutil convert "${tmpRaw}" -format UDZO -o "${dmgPath}"`, { stdio: "pipe" });
      fs.unlinkSync(tmpRaw);

      console.log(`[notarize] Rebuilt ${path.basename(dmgPath)} as HFS+/UDZO`);
      rebuiltPaths.push(dmgPath);
    } catch (err) {
      console.error(`[notarize] Failed to rebuild ${path.basename(dmgPath)}: ${err.message}`);
      rebuiltPaths.push(dmgPath);
    }
  }

  const appleId = process.env.APPLE_ID;
  const appPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appPassword || !teamId) {
    console.log("[notarize] Apple credentials not set, skipping notarization");
    return rebuiltPaths;
  }

  for (const artifactPath of rebuiltPaths) {
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
      }
    } catch (err) {
      console.error(`[notarize] Notarization failed for ${path.basename(artifactPath)}: ${err.message}`);
    }
  }

  return rebuiltPaths;
};
