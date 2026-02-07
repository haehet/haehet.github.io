param(
  [string]$msg = ""
)

$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot


$tracked = git ls-files public resources/_gen 2>$null
if ($tracked) {
  Write-Host "[!] ERROR: build artifacts are tracked (public/ or resources/_gen). Fix .gitignore + git rm --cached first." -ForegroundColor Red
  exit 1
}

$porcelain = git status --porcelain
if (-not $porcelain) {
  Write-Host "[*] No changes to commit." -ForegroundColor Yellow
  exit 0
}

if ([string]::IsNullOrWhiteSpace($msg)) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm"
  $msg = "update: $ts"
}

git add -A
git commit -m $msg
git push

Write-Host "[+] Pushed: $msg" -ForegroundColor Green