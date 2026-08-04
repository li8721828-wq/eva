; Eva installs the desktop app regardless of Local Search availability. The
; optional bootstrap exits non-zero when Docker Desktop is absent or not
; running, which is intentionally non-fatal for the main installer.
!macro customInstall
  DetailPrint "Preparing optional Eva Local Search (SearXNG)..."
  ExecWait '"$INSTDIR\Eva.exe" --install-local-search' $0
  DetailPrint "Eva Local Search setup completed or can be retried from Settings > Plugins."
!macroend
