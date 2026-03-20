; MediaVault NSIS installer customisation
; Adds file association and registry entries

!macro customInstall
  ; Register .mkv, .mp4, .avi association (optional, non-destructive)
  WriteRegStr HKCU "Software\MediaVault" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "Software\MediaVault" "Version" "1.0.0"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\MediaVault"
!macroend
