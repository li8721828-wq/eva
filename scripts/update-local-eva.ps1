param(
  [Parameter(Mandatory = $true)]
  [string]$SourceResources,
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$targetApp = Join-Path $InstallRoot 'resources\app.asar'
$sourceApp = Join-Path $SourceResources 'app.asar'
$executable = Join-Path $InstallRoot 'Eva.exe'

if (!(Test-Path -LiteralPath $sourceApp) -or !(Test-Path -LiteralPath $executable)) {
  throw 'The Eva update source or installed client could not be found.'
}

# The running Electron process keeps app.asar open. Wait for a normal user close.
do {
  $runningEva = Get-Process -Name 'Eva' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $executable }
  if ($runningEva) { Start-Sleep -Seconds 1 }
} while ($runningEva)

Copy-Item -LiteralPath $targetApp -Destination "$targetApp.previous" -Force
Copy-Item -LiteralPath $sourceApp -Destination $targetApp -Force
Start-Process -FilePath $executable
