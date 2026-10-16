# Records whether this windows-2025 runner already has WSL, then checks the
# Enable and reboot messages. It does not turn WSL off: that reboots the
# machine and cannot finish Install in the same job.
$ErrorActionPreference = 'Stop'

Write-Output 'Windows clean-machine check'
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if ($wsl) {
  Write-Output "wsl.exe is present at $($wsl.Source)"
} else {
  Write-Output 'wsl.exe is absent'
}

try {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
  Write-Output "WSL feature state: $($feature.State)"
} catch {
  Write-Output 'WSL feature state: not readable without an extra admin query'
}

Write-Output 'WSL_REBOOT_GAP: a windows-2025 runner cannot finish Install from WSL disabled, because turning Linux support on reboots the machine. Enable runs wsl --install --no-distribution. When that output says reboot or restart, ElastOS says: Restart Windows. When you open ElastOS again, Install continues. The next open continues Install only if Linux support is on.'

node --test test/windows-prompt.test.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
