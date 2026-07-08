; Proxima — custom NSIS installer/uninstaller behavior.
;
; On uninstall, give the user a choice: also remove ALL Proxima data
; (preferences, the managed Python venv, the auto-downloaded Python runtime,
; local AI memory/embedding models, saved API keys, and the CLI shim) — or keep
; everything for a future reinstall. The SILENT/unattended default is to KEEP
; data (safer — never destroys data without an explicit choice).
;
; Wired via package.json -> build.nsis.include.

!macro customUnInstall
  ; Ask once. /SD IDNO => silent uninstall keeps data by default.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also remove all Proxima data and settings?$\r$\n$\r$\nThis deletes local AI memory, the downloaded Python runtime, saved API keys and preferences. Choose No to keep them for a future reinstall.$\r$\n$\r$\n(Files the agent created in your home 'Proxima' folder are NOT touched.)" \
    /SD IDNO IDYES proxima_purge IDNO proxima_keep

  proxima_purge:
    DetailPrint "Removing Proxima data..."
    ; Electron userData (Roaming): settings, py-env, py-runtime, byok keys,
    ; brain models, CLI bin — everything Proxima writes lives under here.
    RMDir /r "$APPDATA\Proxima"
    ; Any local-appdata footprint (defensive; normally unused).
    RMDir /r "$LOCALAPPDATA\Proxima"
    ; Defensive: cover a lowercase app-name folder (dev/name variance).
    RMDir /r "$APPDATA\proxima"
    RMDir /r "$LOCALAPPDATA\proxima"
    DetailPrint "Proxima data removed."
    Goto proxima_done

  proxima_keep:
    DetailPrint "Proxima data preserved for a future reinstall."

  proxima_done:
!macroend
