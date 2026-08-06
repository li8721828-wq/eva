; Eva installs the desktop app regardless of Local Search availability. The
; optional bootstrap exits non-zero when Docker Desktop is absent or not
; running, which is intentionally non-fatal for the main installer.
; A closed window can leave an Electron main process behind briefly. Release
; that process before NSIS replaces Eva.exe, so an upgrade does not require
; the user to open Task Manager and retry manually.
!macro customInit
  DetailPrint "Closing a previous Eva session, if one is still running..."
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM Eva.exe'
  Pop $0
  Pop $1
  Sleep 700
!macroend

!macro customInstall
  DetailPrint "Preparing optional Eva Local Search (SearXNG)..."
  ExecWait '"$INSTDIR\Eva.exe" --install-local-search' $0
  DetailPrint "Eva Local Search setup completed or can be retried from Settings > Plugins."
!macroend
