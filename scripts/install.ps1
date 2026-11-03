#Requires -Version 7
# The Windows version of install.sh. Copies the themes, mods, sounds and layout into the Herdr app, merges the keys and
# settings, and picks the themes for the layout on show. Safe to re-run.
#
#   pwsh -File scripts/install.ps1                      # every mod that runs on Windows
#   pwsh -File scripts/install.ps1 -Mods space-agents   # only the mods named
#
# Every run first backs up keys.json, settings.json, view.json, layouts and mods to a dated folder next to the app's.
# The Linear panel lists legwork projects on Windows, from -Legwork when given. Orchi's scripts are this checkout's bin/.
# A mod left out with -Mods has its block taken out of the layout, so it doesn't show as an error.
param(
  [string[]]$Mods = @("claude-chat", "herd", "linear", "linear-agent", "orch-pane", "orchi", "orchi-chrome", "pane-header", "panel-buttons", "plan-view", "space-agents", "windows-tabs"),
  [string]$Legwork = "",
  [switch]$NoTheme
)
$ErrorActionPreference = "Stop"
$Mods = @($Mods | ForEach-Object { $_ -split "," } | Where-Object { $_ })
$R = Split-Path -Parent $PSScriptRoot
$Orchi = $R
$H = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config/herdr-app" }
if (-not (Test-Path $H)) { throw "No Herdr app folder at $H" }
if ($Mods -contains "orchi" -and -not (Test-Path (Join-Path $Orchi "bin/herdr-adapter"))) {
  throw "Orchi needs bin/herdr-adapter, and there's none in $Orchi. Leave orchi out with -Mods."
}

function Read-Json($path) { Get-Content -Raw -LiteralPath $path | ConvertFrom-Json -AsHashtable }
function Write-Json($path, $value) {
  $text = $value | ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText($path, $text + "`n", [Text.UTF8Encoding]::new($false))
}

# Backup.
$B = Join-Path (Split-Path -Parent $H) ("herdr-app-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force $B | Out-Null
foreach ($f in "keys.json", "settings.json", "view.json") {
  if (Test-Path (Join-Path $H $f)) { Copy-Item -LiteralPath (Join-Path $H $f) -Destination $B }
}
foreach ($d in "layouts", "mods") {
  if (Test-Path (Join-Path $H $d)) { Copy-Item -LiteralPath (Join-Path $H $d) -Destination $B -Recurse }
}
Write-Output "backed up to $B"

# Themes are copied: Windows symlinks need admin or developer mode, and a copy is what the app reloads.
New-Item -ItemType Directory -Force (Join-Path $H "themes") | Out-Null
foreach ($t in "orchi-dark", "orchi-light") {
  Copy-Item -LiteralPath (Join-Path $R "themes/$t.json") -Destination (Join-Path $H "themes/$t.json") -Force
  Write-Output "copied $H\themes\$t.json"
}

# Mods are copied, mod.json first: a new folder with no "place": "none" yet joins the shown layout as a block.
# Then the folder is made to match the repo's, as rsync --delete does, keeping the app's own files.
$keep = @("gpui-kit.d.ts", "jsconfig.json")
foreach ($m in $Mods) {
  $src = Join-Path $R "mods/$m"
  if (-not (Test-Path (Join-Path $src "mod.json"))) { throw "No mod $m in $R\mods" }
  $dst = Join-Path $H "mods/$m"
  $item = Get-Item -LiteralPath $dst -ErrorAction SilentlyContinue
  if ($item -and $item.LinkType) { $item.Delete() }
  New-Item -ItemType Directory -Force $dst | Out-Null
  Copy-Item -LiteralPath (Join-Path $src "mod.json") -Destination (Join-Path $dst "mod.json") -Force
  $want = @{}
  Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
    $rel = [IO.Path]::GetRelativePath($src, $_.FullName)
    if ($keep -contains $_.Name -or $_.Name -like "*.error") { return }
    $want[$rel] = $true
    $to = Join-Path $dst $rel
    New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $to -Force
  }
  Get-ChildItem -LiteralPath $dst -Recurse -File | ForEach-Object {
    $rel = [IO.Path]::GetRelativePath($dst, $_.FullName)
    if ($keep -contains $_.Name -or $_.Name -like "*.error") { return }
    if (-not $want.ContainsKey($rel)) { Remove-Item -LiteralPath $_.FullName -Force }
  }
  Get-ChildItem -LiteralPath $dst -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending |
    Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } | Remove-Item -Force
  Write-Output "copied $dst"
}

New-Item -ItemType Directory -Force (Join-Path $H "sounds") | Out-Null
Copy-Item -Path (Join-Path $R "sounds/*.mp3") -Destination (Join-Path $H "sounds") -Force

# The layout, without the blocks of panels that aren't installed.
$installed = { param($name) Test-Path (Join-Path $H "mods/$name/mod.json") }
$layout = Read-Json (Join-Path $R "layouts/main-linear.json")
function Remove-Missing($node) {
  if ($node.children) {
    $node.children = @($node.children | Where-Object {
      -not ($_.type -eq "block" -and $_.content.mod -and -not (& $installed $_.content.mod))
    })
    foreach ($c in $node.children) { Remove-Missing $c }
    if ($node.type -eq "stack" -and $node.active -and -not ($node.children | Where-Object { $_.id -eq $node.active })) {
      $node.active = $node.children[0].id
    }
  }
}
Remove-Missing $layout
# The shipped tab bar draws the window buttons left of the panel buttons, so windows-tabs leaves them out and
# panel-buttons draws them at the edge.
function Use-WindowsTabs($node) {
  if ($node.type -eq "block" -and $node.content.mod -eq "tabs") { $node.content.mod = "windows-tabs" }
  foreach ($c in @($node.children)) { if ($c) { Use-WindowsTabs $c } }
}
# The panel buttons then hold the window buttons too, and sit against the right edge, so the block is made wide enough
# for every button at once: Legwork, Orchi, Herd, the chat toggle, the progress button and the window buttons.
function Set-BlockWidth($node, $id, $px) {
  if ($node.id -eq $id) { $node.size = [ordered]@{ px = $px } }
  foreach ($c in @($node.children)) { if ($c) { Set-BlockWidth $c $id $px } }
}
if (& $installed "windows-tabs") { Use-WindowsTabs $layout; Set-BlockWidth $layout "panel-buttons" 500 }
$target = Join-Path $H "layouts/main-linear.json"
$item = Get-Item -LiteralPath $target -ErrorAction SilentlyContinue
if ($item -and $item.LinkType) { $item.Delete() }
Write-Json $target $layout
Write-Output "wrote $target"

# The launcher sessions the panels start find first on PATH: `herdr` there reaches Orchi's herdr-adapter, which runs
# herdr's calls on the app's core. `herdr` is for Git Bash, the shell Claude Code's Bash tool uses here, and
# `herdr.cmd` for anything else. Nothing else in the app gets them, so the old terminal Herdr stays as it was.
if ($Mods -contains "orchi") {
  $A = Join-Path $HOME ".local/libexec/orchi-app"
  New-Item -ItemType Directory -Force $A | Out-Null
  $adapter = (Join-Path $Orchi "bin/herdr-adapter").Replace("\", "/")
  $utf8 = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText((Join-Path $A "herdr"), "#!/bin/sh`nexec python `"$adapter`" `"`$@`"`n", $utf8)
  [IO.File]::WriteAllText((Join-Path $A "herdr.cmd"), "@python `"$($adapter.Replace('/', '\'))`" %*`r`n", $utf8)
  Write-Output "wrote $A\herdr and herdr.cmd"
}

# linear.json: the legwork folder the Legwork and Orchi panels read, when -Legwork names one. `legwork_dir` in Orchi's
# settings wins over it. A key or any other setting already there stays.
if ($Legwork -and ($Mods -contains "linear" -or $Mods -contains "orchi")) {
  $linearPath = Join-Path $H "linear.json"
  $linear = if (Test-Path $linearPath) { Read-Json $linearPath } else { [ordered]@{} }
  if (-not $linear.Contains("legwork") -or -not $linear["legwork"]) { $linear["legwork"] = [ordered]@{} }
  if (-not $linear["legwork"].Contains("dir")) { $linear["legwork"]["dir"] = $Legwork }
  Write-Json $linearPath $linear
  Write-Output "updated $linearPath"
}

# Keys: the repo's files merged in by scope. linear.json's key opens the Linear panel, so it's skipped without it.
$keysPath = Join-Path $H "keys.json"
$keys = if (Test-Path $keysPath) { Read-Json $keysPath } else { [ordered]@{} }
$keys.Remove("layout:main-linear")
foreach ($f in Get-ChildItem (Join-Path $R "keys/*.json")) {
  if ($f.BaseName -eq "linear" -and -not (& $installed "linear")) { continue }
  $extra = Read-Json $f.FullName
  foreach ($scope in $extra.Keys) {
    if (-not $keys.Contains($scope)) { $keys[$scope] = [ordered]@{} }
    foreach ($k in $extra[$scope].Keys) { $keys[$scope][$k] = $extra[$scope][$k] }
  }
}
Write-Json $keysPath $keys
Write-Output "updated $keysPath"

# Settings: only what's missing is added, at any depth, as install.sh does, so a mute in Settings or a picked sound stays.
$settingsPath = Join-Path $H "settings.json"
$settings = if (Test-Path $settingsPath) { Read-Json $settingsPath } else { [ordered]@{} }
function Add-Missing($have, $want) {
  foreach ($k in $want.Keys) {
    if (-not $have.Contains($k)) { $have[$k] = $want[$k] }
    elseif ($have[$k] -is [System.Collections.IDictionary] -and $want[$k] -is [System.Collections.IDictionary]) { Add-Missing $have[$k] $want[$k] }
  }
}
Add-Missing $settings (Read-Json (Join-Path $R "config/settings.json"))
Write-Json $settingsPath $settings
Write-Output "updated $settingsPath"

if (-not $NoTheme) {
  herdr-app do app.theme --name orchi-light | Out-Null
  herdr-app do app.theme --name orchi-dark | Out-Null
}
herdr-app status | Select-String '"errors"'
