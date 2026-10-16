# Import a dedicated ElastOS WSL2 distro and run the Linux runtime smoke inside it.
# Distro name is ElastOS. Every wsl.exe call names -d ElastOS.
# This is not the PC2 path (wsl bash -c against the default distro).
# A missing distro, a WSL1 import, or a failed /healthz exits non-zero.
$PSNativeCommandUseErrorActionPreference = $false
$env:WSL_UTF8 = '1'

$Distro = 'ElastOS'
$Root = 'C:\ElastOS'
$Rootfs = Join-Path $Root 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'
$Install = Join-Path $Root 'distro'
$RootfsUrl = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'

Write-Host 'This job does not skip. /healthz must be OK inside the ElastOS distro.'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  Write-Host 'wsl.exe is not installed.'
  exit 1
}

Write-Host '--- wsl --version ---'
& wsl.exe --version
Write-Host "wsl_version_exit=$LASTEXITCODE"
Write-Host '--- wsl --status ---'
& wsl.exe --status
Write-Host "wsl_status_exit=$LASTEXITCODE"

New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (Test-Path $Install) {
  Remove-Item -Recurse -Force $Install
}
New-Item -ItemType Directory -Force -Path $Install | Out-Null

Write-Host "Unregistering any previous $Distro distro"
& wsl.exe --unregister $Distro
Write-Host "unregister_exit=$LASTEXITCODE"

Write-Host 'Downloading Ubuntu 24.04 rootfs for the ElastOS distro'
& curl.exe --fail --location --retry 5 --retry-delay 2 --output $Rootfs $RootfsUrl
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$bytes = (Get-Item $Rootfs).Length
Write-Host "rootfs_bytes=$bytes"
if ($bytes -lt 50MB) {
  Write-Host 'Rootfs download is too small.'
  exit 1
}

Write-Host "Importing $Distro as WSL version 2"
& wsl.exe --import $Distro $Install $Rootfs --version 2
if ($LASTEXITCODE -ne 0) {
  Write-Host "import_exit=$LASTEXITCODE"
  & wsl.exe --list --verbose
  exit $LASTEXITCODE
}

$list = ((& wsl.exe --list --verbose | Out-String) -replace "`0", '')
Write-Host '--- wsl --list --verbose ---'
Write-Host $list
if ($list -notmatch 'ElastOS\s+\S+\s+2') {
  Write-Host 'ElastOS did not register as WSL version 2.'
  exit 1
}

Write-Host '--- /etc/os-release ---'
& wsl.exe -d $Distro -u root -- cat /etc/os-release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& wsl.exe -d $Distro -u root -- bash -lc 'if test -e /dev/kvm; then echo kvm=yes; else echo "kvm=no - the local Browser needs /dev/kvm. The gateway install continues."; fi'

& wsl.exe -d $Distro -u root -- bash -lc 'command -v python3 >/dev/null && command -v curl >/dev/null'
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Installing python3 and curl inside ElastOS'
  & wsl.exe -d $Distro -u root -- bash -lc 'printf "nameserver 8.8.8.8\n" > /etc/resolv.conf; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 curl ca-certificates'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$unix = (& wsl.exe -d $Distro -u root -- wslpath -a (Get-Location).Path).Trim()
Write-Host "repo=$unix"
if (-not $unix.StartsWith('/')) {
  Write-Host 'wslpath did not return a Linux path.'
  exit 1
}
$quoted = $unix.Replace("'", "'\''")

& wsl.exe -d $Distro -u root -- bash -lc "sed -i 's/\r$//' '$quoted/scripts/runtime-smoke.sh' && cd '$quoted' && bash scripts/runtime-smoke.sh"
$code = $LASTEXITCODE
Write-Host "smoke_exit=$code"
exit $code
