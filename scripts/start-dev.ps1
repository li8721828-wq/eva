$ErrorActionPreference = 'Stop'

# Keep the launcher path-independent so it remains valid when the workspace
# sits under a directory whose name contains non-ASCII characters.
Set-Location (Join-Path $PSScriptRoot '..')
npm.cmd run dev
