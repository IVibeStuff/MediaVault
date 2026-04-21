; MediaVault NSIS installer script
; Writes a version registry key on install and removes it on uninstall.

!macro customInstall
  WriteRegStr HKCU "Software\MediaVault" "Version" "${VERSION}"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\MediaVault"
!macroend
