<#
.SYNOPSIS
  taskdeck の Windows セットアップ。

.DESCRIPTION
  1. Node.js 20 以上と npm があるか確認する (git は無くても警告のみ)
  2. リポジトリ直下で npm install を実行する
  3. デスクトップとスタートメニューに「TaskDeck」ショートカットを作る
     (wscript.exe windows\taskdeck.vbs を起動、アイコンは windows\taskdeck.ico)

.PARAMETER Uninstall
  作成したショートカットを削除する (node_modules やデータは消さない)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File windows\install.ps1
  powershell -ExecutionPolicy Bypass -File windows\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Vbs      = Join-Path $PSScriptRoot 'taskdeck.vbs'
$Ico      = Join-Path $PSScriptRoot 'taskdeck.ico'
$Wscript  = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Desktop  = [Environment]::GetFolderPath('Desktop')
$Programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'TaskDeck'

$DesktopLnk = Join-Path $Desktop 'TaskDeck.lnk'
$StartLnk   = Join-Path $Programs 'TaskDeck.lnk'
$StopLnk    = Join-Path $Programs 'TaskDeck を停止.lnk'

function Write-Info([string]$msg) { Write-Host "[taskdeck] $msg" }

function New-Shortcut([string]$path, [string]$target, [string]$arguments, [string]$icon, [string]$desc) {
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $target
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $RepoRoot
  $lnk.IconLocation = $icon
  $lnk.Description = $desc
  $lnk.Save()
  Write-Info "ショートカット作成: $path"
}

if ($Uninstall) {
  foreach ($f in @($DesktopLnk, $StartLnk, $StopLnk)) {
    if (Test-Path -LiteralPath $f) {
      Remove-Item -LiteralPath $f
      Write-Info "削除: $f"
    }
  }
  if ((Test-Path -LiteralPath $Programs) -and -not (Get-ChildItem -LiteralPath $Programs)) {
    Remove-Item -LiteralPath $Programs
  }
  Write-Info "ショートカットを削除しました (node_modules と ~/.taskdeck は残しています)"
  exit 0
}

# ---- 1. 前提ツールの確認 ----
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  throw "node.exe が PATH にありません。https://nodejs.org/ から Node.js 20 以上 (LTS) をインストールし、新しい PowerShell でこのスクリプトを再実行してください。"
}
$nodeVersion = ((& $node.Source --version) | Out-String).Trim().TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  throw "Node.js v$nodeVersion は古すぎます。20 以上が必要です ($($node.Source))。"
}
Write-Info "Node.js v$nodeVersion ($($node.Source))"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  throw "npm.cmd が PATH にありません。Node.js を公式インストーラで入れ直してください。"
}

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) {
  Write-Info "git: $($git.Source)"
} else {
  Write-Warning "git が見つかりません。起動には不要ですが、更新 (git pull) には https://git-scm.com/ が必要です。"
}

# ---- 2. npm install ----
Write-Info "npm install を実行します ($RepoRoot)"
Push-Location $RepoRoot
try {
  # npm は警告を stderr に出すので、その間だけ Stop を解除する
  $ErrorActionPreference = 'Continue'
  & $npm.Source install --no-audit --no-fund
  $npmExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}

$native = Join-Path $RepoRoot 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
if ($npmExit -ne 0 -or -not (Test-Path -LiteralPath $native)) {
  Write-Host @"

npm install に失敗しました (exit $npmExit)。

better-sqlite3 は通常 prebuild-install がビルド済みバイナリをダウンロードして使います。
ダウンロードできない場合 (プロキシ環境、Node のメジャーバージョンが新しすぎて
prebuild が無い等) はソースからのビルドになり、次のものが必要です:

  - Python 3
  - Visual Studio Build Tools (「C++ によるデスクトップ開発」ワークロード)
      winget install Microsoft.VisualStudio.2022.BuildTools
      または https://visualstudio.microsoft.com/visual-cpp-build-tools/

インストール後、新しい PowerShell でこのスクリプトを再実行してください。
Node の LTS 版 (20 / 22) に切り替えると prebuild が見つかることも多いです。
"@ -ForegroundColor Yellow
  exit 1
}
Write-Info "npm install 完了"

# ---- 3. ショートカット ----
if (-not (Test-Path -LiteralPath $Wscript)) {
  throw "wscript.exe が見つかりません: $Wscript"
}
$iconLocation = if (Test-Path -LiteralPath $Ico) { "$Ico,0" } else { "$($node.Source),0" }
if (-not (Test-Path -LiteralPath $Ico)) {
  Write-Warning "windows\taskdeck.ico が無いため node.exe のアイコンを使います"
}

New-Shortcut $DesktopLnk $Wscript "`"$Vbs`"" $iconLocation 'taskdeck を起動'
New-Shortcut $StartLnk   $Wscript "`"$Vbs`"" $iconLocation 'taskdeck を起動'
New-Shortcut $StopLnk    $Wscript "`"$Vbs`" -Stop" $iconLocation 'taskdeck のサーバーを停止'

Write-Host ""
Write-Info "セットアップ完了。デスクトップの「TaskDeck」をダブルクリックで起動できます。"
Write-Info "停止: スタートメニューの「TaskDeck を停止」、または windows\taskdeck.ps1 -Stop"
Write-Info "Claude Code に MCP を登録するには: npm run mcp:register"
