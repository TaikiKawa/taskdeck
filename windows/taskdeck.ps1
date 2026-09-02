<#
.SYNOPSIS
  taskdeck を Windows で「アプリっぽく」起動する (macOS の taskdeck.app 相当)。

.DESCRIPTION
  1. node.exe を探す (TASKDECK_NODE > PATH > Program Files > nvm-windows > volta > fnm)
  2. ポート (TASKDECK_PORT, 既定 4747) にサーバーが居なければ src/server.js を
     バックグラウンドで起動し、PID を ~/.taskdeck/server.pid に記録する
  3. Edge / Chrome の --app モードでボードをウインドウ表示する
     (どちらも無ければ既定ブラウザで開く)

  サーバーはウインドウを閉じても動き続ける。止めるときは -Stop。

.PARAMETER Stop
  このスクリプトが起動したサーバー (server.pid のプロセス) を停止する。
.PARAMETER NoOpen
  サーバーだけ起動してウインドウは開かない。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File windows\taskdeck.ps1
  powershell -ExecutionPolicy Bypass -File windows\taskdeck.ps1 -Stop
#>
[CmdletBinding()]
param(
  [switch]$Stop,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest の進捗バーを抑止 (高速化)

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ServerJs = Join-Path $RepoRoot 'src\server.js'
$Port     = if ($env:TASKDECK_PORT) { [int]$env:TASKDECK_PORT } else { 4747 }
# 起動確認は IPv4 決め打ち (server.js は 127.0.0.1 にだけ bind する)
$PingUrl  = "http://127.0.0.1:$Port/api/projects"
$AppUrl   = "http://localhost:$Port/"
$DataDir  = if ($env:TASKDECK_DIR) { $env:TASKDECK_DIR } else { Join-Path $HOME '.taskdeck' }
$PidFile  = Join-Path $DataDir 'server.pid'
$LogFile  = Join-Path $DataDir 'server.log'
$ErrFile  = Join-Path $DataDir 'server.err.log'

function Write-Info([string]$msg) { Write-Host "[taskdeck] $msg" }

function Show-Error([string]$msg) {
  Write-Host "[taskdeck] ERROR: $msg" -ForegroundColor Red
  # taskdeck.vbs (隠しウインドウ) から起動された場合はコンソールが見えないので MessageBox も出す
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($msg, 'taskdeck', 'OK', 'Error')
  } catch {}
}

# $base が空 (環境変数未定義など) のとき Join-Path が例外を投げるのを避ける
function Join-IfSet($base, [string]$rel) {
  if ($base) { return (Join-Path $base $rel) }
  return $null
}

function Get-FirstExisting($paths) {
  foreach ($p in @($paths)) {
    if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $p }
  }
  return $null
}

# ---- node.exe の検出 (macOS 版 findNode と同じ優先順位) ----
function Find-Node {
  if ($env:TASKDECK_NODE) {
    if (Test-Path -LiteralPath $env:TASKDECK_NODE -PathType Leaf) { return $env:TASKDECK_NODE }
    Write-Info "TASKDECK_NODE=$($env:TASKDECK_NODE) が存在しないため自動検出します"
  }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $volta = if ($env:VOLTA_HOME) { $env:VOLTA_HOME } else { Join-IfSet $env:LOCALAPPDATA 'Volta' }
  $fnm   = if ($env:FNM_DIR)    { $env:FNM_DIR }    else { Join-IfSet $env:APPDATA 'fnm' }

  $found = Get-FirstExisting @(
    (Join-IfSet $env:ProgramFiles 'nodejs\node.exe'),
    (Join-IfSet ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-IfSet $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-IfSet $env:NVM_SYMLINK 'node.exe'),          # nvm-windows (nvm use 済み)
    (Join-IfSet $volta 'bin\node.exe'),                 # volta
    (Join-IfSet $fnm 'aliases\default\node.exe')        # fnm (fnm default 済み)
  )
  if ($found) { return $found }

  # nvm-windows / fnm でインストール済みだが切り替えられていない場合: 最新版を使う
  $versionDirs = @()
  if ($env:NVM_HOME -and (Test-Path -LiteralPath $env:NVM_HOME)) {
    $versionDirs += Get-ChildItem -LiteralPath $env:NVM_HOME -Directory -Filter 'v*'
  }
  $fnmVersions = Join-IfSet $fnm 'node-versions'
  if ($fnmVersions -and (Test-Path -LiteralPath $fnmVersions)) {
    $versionDirs += Get-ChildItem -LiteralPath $fnmVersions -Directory
  }
  $sorted = $versionDirs | Sort-Object -Descending -Property {
    try { [version]($_.Name -replace '^v', '') } catch { [version]'0.0' }
  }
  foreach ($d in @($sorted)) {
    if (-not $d) { continue }   # 候補ゼロのとき @($null) になるのを弾く
    $exe = Get-FirstExisting @(
      (Join-Path $d.FullName 'node.exe'),
      (Join-Path $d.FullName 'installation\node.exe')
    )
    if ($exe) { return $exe }
  }
  return $null
}

# ---- サーバー ----
function Test-Server {
  try {
    $r = Invoke-WebRequest -Uri $PingUrl -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Read-ServerPid {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $raw = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $n = 0
  if ([int]::TryParse("$raw".Trim(), [ref]$n) -and $n -gt 0) { return $n }
  return $null
}

function Start-Server {
  $node = Find-Node
  if (-not $node) {
    throw "node.exe が見つかりません。Node.js 20 以上をインストールするか、環境変数 TASKDECK_NODE にパスを設定してください。"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\better-sqlite3'))) {
    throw "依存パッケージが未インストールです。先に windows\install.ps1 を実行してください。"
  }
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Write-Info "サーバーを起動: `"$node`" `"$ServerJs`" (port $Port)"
  $env:TASKDECK_PORT = "$Port"   # Start-Process は現在の環境変数を引き継ぐ
  $p = Start-Process -FilePath $node -ArgumentList @("`"$ServerJs`"") `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
  Set-Content -LiteralPath $PidFile -Value $p.Id -Encoding ASCII
  return $p
}

function Wait-Server([int]$retries = 60) {
  for ($i = 0; $i -lt $retries; $i++) {
    if (Test-Server) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# ---- ブラウザ (アプリモード) ----
function Get-AppPath([string]$exe) {
  # インストーラが登録する正規の場所 (HKCU 優先)
  foreach ($hive in @('HKCU', 'HKLM')) {
    $key = "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
    try {
      $v = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'
      if ($v -and (Test-Path -LiteralPath $v -PathType Leaf)) { return $v }
    } catch {}
  }
  return $null
}

function Find-Browser {
  $edge = Get-AppPath 'msedge.exe'
  if (-not $edge) {
    $edge = Get-FirstExisting @(
      (Join-IfSet ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-IfSet $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    )
  }
  if ($edge) { return $edge }
  $chrome = Get-AppPath 'chrome.exe'
  if (-not $chrome) {
    $chrome = Get-FirstExisting @(
      (Join-IfSet $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-IfSet ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
      (Join-IfSet $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
  }
  return $chrome
}

function Open-Window {
  $browser = Find-Browser
  if ($browser) {
    Write-Info "アプリモードで開く: $browser"
    Start-Process -FilePath $browser -ArgumentList @("--app=$AppUrl", '--window-size=1280,860') | Out-Null
  } else {
    Write-Info "Edge / Chrome が見つからないため既定ブラウザで開く: $AppUrl"
    Start-Process $AppUrl | Out-Null
  }
}

# ---- main ----
if ($Stop) {
  $serverPid = Read-ServerPid
  if (-not $serverPid) {
    Write-Info "server.pid が無いため、このスクリプトが起動したサーバーはありません ($PidFile)"
    exit 0
  }
  $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -like 'node*') {
    Write-Info "サーバー (PID $serverPid) を停止します"
    # 実行中の claude -p (子プロセス) も一緒に止めるため /T でツリーごと
    & "$env:SystemRoot\System32\taskkill.exe" /PID $serverPid /T /F | Out-Null
  } else {
    Write-Info "PID $serverPid は動いていません (pid ファイルを削除します)"
  }
  Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  exit 0
}

try {
  if (Test-Server) {
    Write-Info "サーバーは既に起動済み ($AppUrl)"
  } else {
    $null = Start-Server
    if (-not (Wait-Server)) {
      $tail = ''
      if (Test-Path -LiteralPath $ErrFile) {
        $tail = (Get-Content -LiteralPath $ErrFile -Tail 20) -join "`n"
      }
      throw "サーバーが起動しませんでした。ログ: $ErrFile`n$tail"
    }
    Write-Info "起動完了: $AppUrl"
  }
  if (-not $NoOpen) { Open-Window }
} catch {
  Show-Error $_.Exception.Message
  exit 1
}
