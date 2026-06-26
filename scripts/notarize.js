const { execSync } = require("child_process");
const path = require("path");

/**
 * electron-builder afterAllArtifactBuild hook.
 *
 * Submits macOS DMG/ZIP artifacts to Apple's notary service and BLOCKS on
 * --wait until Apple returns a verdict. A non-"Accepted" result (or any
 * submission error, e.g. the HTTP 403 "agreement missing/expired" gate)
 * throws and fails the build — we never want to silently publish an
 * un-notarized release again.
 *
 * The .dmg is stapled so Gatekeeper trusts it even offline. A .zip cannot be
 * stapled directly; the notarized .app inside it still passes Gatekeeper's
 * online check.
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

  const creds = `--apple-id "${appleId}" --team-id "${teamId}" --password "${appPassword}"`;

  for (const artifactPath of artifacts) {
    const name = path.basename(artifactPath);

    // --wait blocks until Apple finishes its analysis and reports the final
    // status. A genuine problem (expired agreement, signing fault, malware
    // heuristic) surfaces here as a hard failure rather than a quietly
    // un-notarized artifact. 30 min covers Apple's worst-case turnaround.
    console.log(`[notarize] Submitting ${name} and waiting for Apple's verdict...`);
    const out = execSync(
      `xcrun notarytool submit "${artifactPath}" ${creds} --wait --output-format json`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], timeout: 30 * 60 * 1000 }
    );

    let status = "";
    let submissionId = "";
    try {
      const parsed = JSON.parse(out);
      status = (parsed.status || "").trim();
      submissionId = parsed.id || "";
    } catch {
      // Fall through to the raw output for diagnostics.
    }
    console.log(`[notarize] ${name} → status: ${status || "unknown"}${submissionId ? ` (id: ${submissionId})` : ""}`);

    if (status !== "Accepted") {
      // Surface Apple's per-issue log so a rejection is debuggable from CI.
      if (submissionId) {
        try {
          console.error(execSync(`xcrun notarytool log "${submissionId}" ${creds}`, { encoding: "utf8" }));
        } catch {
          /* best-effort diagnostics only */
        }
      }
      throw new Error(`[notarize] ${name} was not Accepted (status: ${status || "unknown"}); see log above.`);
    }

    // Staple the ticket into the .dmg so offline first-launch is friction-free.
    if (artifactPath.endsWith(".dmg")) {
      console.log(`[notarize] Stapling ${name}...`);
      execSync(`xcrun stapler staple "${artifactPath}"`, { stdio: "inherit" });
    }
  }

  console.log("[notarize] ✅ All artifacts notarized by Apple; DMG stapled.");
  return artifacts;
};
