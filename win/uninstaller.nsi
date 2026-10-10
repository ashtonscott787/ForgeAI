; ForgeAI Uninstaller — removes EVERY ForgeAI install on this Windows computer, whichever way it was installed:
;   per-user installs (every profile, including C:\Users\Default where some deployment tools put it),
;   all-users installs in Program Files, the background service (ProgramData), custom /D= folders,
;   shortcuts, start-at-login entries, Apps-list entries and firewall rules.
;
;   "Uninstall ForgeAI.exe"                interactive: asks first, shows what it removed
;   "Uninstall ForgeAI.exe" /S             silent (for deployment tools / remote removal); keeps your data
;   "Uninstall ForgeAI.exe" /S /PURGE      silent, and ALSO deletes data (chats, settings, models, saved keys) — cannot be undone
;
; Run as administrator (or SYSTEM, as deployment tools do) to clean every user; otherwise only the current user.
; A log is written to %TEMP%\ForgeAI-uninstall.log (as SYSTEM: C:\Windows\Temp\ForgeAI-uninstall.log).
; Exit code 0 = removed, or nothing to remove. 1 = cancelled. 2 = some files were in use and are removed at the next restart.
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!define VERSION "2.10.0"
Name "ForgeAI Uninstaller"
OutFile "..\out\Uninstall ForgeAI ${VERSION}.exe"
RequestExecutionLevel highest
SetCompressor /SOLID lzma
BrandingText "ForgeAI ${VERSION}"
VIProductVersion "2.9.1.0"
VIAddVersionKey "ProductName" "ForgeAI Uninstaller"
VIAddVersionKey "FileDescription" "Removes ForgeAI from this computer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "ForgeAI"
!define MUI_ICON "..\ForgeAI.ico"
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Finished"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "See the list above for what was removed."
ShowInstDetails show
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define APPROVED "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!define PROFILES "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList"

Var Purge
Var Admin
Var Found
Var Reboot
Var Log
Var Ps

!macro LOG MSG
  DetailPrint "${MSG}"
  FileWrite $Log "${MSG}$\r$\n"
!macroend
!define LOG "!insertmacro LOG"

; RMDIR_IF path — remove a folder (if it exists), noting it
!macro RMDIR_IF P
  Push "${P}"
  Call RmDirIf
!macroend
!define RMDIR_IF "!insertmacro RMDIR_IF"
Function RmDirIf
  Exch $0
  ${If} ${FileExists} "$0\*.*"
    StrCpy $Found 1
    ClearErrors
    RMDir /r /REBOOTOK "$0"
    ${If} ${Errors}
      StrCpy $Reboot 1
      ${LOG} "In use, removed at next restart: $0"
    ${Else}
      ${LOG} "Removed: $0"
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd
!macro DEL_IF P
  ${If} ${FileExists} "${P}"
    StrCpy $Found 1
    Delete /REBOOTOK "${P}"
    ${LOG} "Removed: ${P}"
  ${EndIf}
!macroend
!define DEL_IF "!insertmacro DEL_IF"

Function .onInit
  StrCpy $Purge 0
  StrCpy $Found 0
  StrCpy $Reboot 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/PURGE" $R1
  ${IfNot} ${Errors}
    StrCpy $Purge 1
  ${EndIf}
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  UserInfo::GetAccountType
  Pop $R2
  StrCpy $Admin 0
  ${If} $R2 == "Admin"
    StrCpy $Admin 1
  ${EndIf}
  IfSilent done
  StrCpy $R3 ""
  ${If} $Admin == 0
    StrCpy $R3 "$\r$\n$\r$\nYou are not running this as administrator, so only your own ForgeAI is removed. Right-click → Run as administrator to remove it for every user and the background service."
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove ForgeAI from this computer?$\r$\n$\r$\nThis stops ForgeAI and removes the app, the background service, shortcuts and start-up entries.$R3" /SD IDYES IDYES +2
  Abort
  ${If} $Purge == 0
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also DELETE your ForgeAI data?$\r$\n$\r$\nChats, settings, downloaded models and saved keys. This cannot be undone.$\r$\n$\r$\nChoose No to keep it (a later reinstall picks up where you left off)." /SD IDNO IDNO +2
    StrCpy $Purge 1
  ${EndIf}
  done:
FunctionEnd

; ---- registry clean-up for one user hive (HKU\<name>)
Function CleanHive
  Exch $0
  ${If} $0 != ""
    ClearErrors
    EnumRegValue $1 HKU "$0\${UNINST}" 0
    ${IfNot} ${Errors}
      StrCpy $Found 1
      ${LOG} "Removed Apps-list entry for user hive $0"
    ${EndIf}
    DeleteRegKey HKU "$0\${UNINST}"
    DeleteRegKey HKU "$0\Software\ForgeAI"
    DeleteRegValue HKU "$0\${RUNKEY}" "ForgeAI"
    DeleteRegValue HKU "$0\${RUNKEY}" "electron.app.ForgeAI"
    DeleteRegValue HKU "$0\${RUNKEY}" "local.forgeai.app"
    DeleteRegValue HKU "$0\${APPROVED}" "ForgeAI"
    DeleteRegValue HKU "$0\${APPROVED}" "electron.app.ForgeAI"
    DeleteRegValue HKU "$0\${APPROVED}" "local.forgeai.app"
  ${EndIf}
  Pop $0
FunctionEnd

; ---- files for one profile folder
Function CleanProfile
  Exch $0
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\*.*"
    ${RMDIR_IF} "$0\AppData\Local\Programs\ForgeAI"
    ${RMDIR_IF} "$0\AppData\Local\forgeai-updater"
    ${DEL_IF} "$0\Desktop\ForgeAI.lnk"
    ${DEL_IF} "$0\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\ForgeAI.lnk"
    ${DEL_IF} "$0\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\ForgeAI.lnk"
    ${DEL_IF} "$0\AppData\Roaming\ForgeAI\setup.json"
    ${If} $Purge == 1
      ${RMDIR_IF} "$0\AppData\Roaming\ForgeAI"
      ${RMDIR_IF} "$0\AppData\Local\ForgeAI"
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; ---- one install folder from the registry (custom /D= path). Only removed if it really is ForgeAI.
Function CleanInstallDir
  Exch $0
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\ForgeAI.exe"
    ${RMDIR_IF} "$0"
  ${EndIf}
  Pop $0
FunctionEnd

Section "Remove ForgeAI"
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  FileOpen $Log "$TEMP\ForgeAI-uninstall.log" w
  ${LOG} "ForgeAI Uninstaller ${VERSION}"
  ${If} $Purge == 1
    ${LOG} "Mode: remove ForgeAI AND its data"
  ${Else}
    ${LOG} "Mode: remove ForgeAI, keep data"
  ${EndIf}
  ${If} $Admin == 0
    ${LOG} "Not running as administrator: only this user's ForgeAI can be removed."
  ${EndIf}
  StrCpy $Ps '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command'

  ; 1. Stop the background service and scheduled task (2.8 service edition), then every ForgeAI process.
  ${LOG} "Stopping ForgeAI..."
  nsExec::Exec '"$SYSDIR\sc.exe" stop ForgeAI'
  Pop $1
  nsExec::Exec '"$SYSDIR\sc.exe" delete ForgeAI'
  Pop $1
  ${If} $1 == 0
    StrCpy $Found 1
    ${LOG} "Removed: Windows service ForgeAI"
  ${EndIf}
  nsExec::Exec '"$SYSDIR\schtasks.exe" /End /TN "\ForgeAI\ForgeAI"'
  Pop $1
  nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "\ForgeAI\ForgeAI" /F'
  Pop $1
  ${If} $1 == 0
    StrCpy $Found 1
    ${LOG} "Removed: scheduled task \ForgeAI\ForgeAI"
  ${EndIf}
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ForgeAIService.exe'
  Pop $1
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ForgeAI.exe'
  Pop $1
  ; ForgeAI's own engine only (by path) — a llama.cpp you run yourself is left alone.
  nsExec::Exec `$Ps "Get-Process llama-server,ggml-rpc-server,rpc-server -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '*ForgeAI*' } | Stop-Process -Force"`
  Pop $1
  Sleep 1500

  ; 2. Program folders: custom install folders from the registry first, then the standard places.
  ReadRegStr $2 HKLM "Software\ForgeAI" "InstallDir"
  Push $2
  Call CleanInstallDir
  ReadRegStr $2 HKCU "Software\ForgeAI" "InstallDir"
  Push $2
  Call CleanInstallDir
  ${RMDIR_IF} "$PROGRAMFILES64\ForgeAI"
  ${RMDIR_IF} "$PROGRAMFILES32\ForgeAI"
  ${RMDIR_IF} "$LOCALAPPDATA\Programs\ForgeAI"
  ; background-service edition
  ReadEnvStr $3 ProgramData
  ${If} $3 == ""
    StrCpy $3 "C:\ProgramData"
  ${EndIf}
  ${If} $Purge == 1
    ${RMDIR_IF} "$3\ForgeAI"
  ${Else}
    ${RMDIR_IF} "$3\ForgeAI\app"
    Delete "$3\ForgeAI\data\setup.json"
  ${EndIf}

  ; 3. Every user profile (needs administrator), including the Default profile new users are copied from,
  ;    and the SYSTEM profile used by deployment tools.
  SetShellVarContext current
  Push "$PROFILE"
  Call CleanProfile
  ${If} $Purge == 1
    ${RMDIR_IF} "$APPDATA\ForgeAI"
  ${EndIf}
  ${If} $Admin == 1
    ReadRegStr $4 HKLM "${PROFILES}" "Default"
    ExpandEnvStrings $4 $4
    Push $4
    Call CleanProfile
    ; Default profile's registry, so new users don't inherit a ForgeAI start-up entry
    ${If} ${FileExists} "$4\NTUSER.DAT"
      nsExec::Exec '"$SYSDIR\reg.exe" load HKU\ForgeAI_Default "$4\NTUSER.DAT"'
      Pop $1
      ${If} $1 == 0
        Push "ForgeAI_Default"
        Call CleanHive
        nsExec::Exec '"$SYSDIR\reg.exe" unload HKU\ForgeAI_Default'
        Pop $1
      ${EndIf}
    ${EndIf}
    StrCpy $5 0
    loop:
      EnumRegKey $6 HKLM "${PROFILES}" $5
      StrCmp $6 "" loopdone
      IntOp $5 $5 + 1
      ReadRegStr $7 HKLM "${PROFILES}\$6" "ProfileImagePath"
      ExpandEnvStrings $7 $7
      Push $7
      Call CleanProfile
      ; that user's registry: already loaded if they're signed in (or it's SYSTEM), otherwise load it briefly
      ClearErrors
      EnumRegKey $8 HKU "$6" 0
      ${IfNot} ${Errors}
        Push "$6"
        Call CleanHive
      ${ElseIf} ${FileExists} "$7\NTUSER.DAT"
        nsExec::Exec '"$SYSDIR\reg.exe" load HKU\ForgeAI_Tmp "$7\NTUSER.DAT"'
        Pop $1
        ${If} $1 == 0
          Push "ForgeAI_Tmp"
          Call CleanHive
          nsExec::Exec '"$SYSDIR\reg.exe" unload HKU\ForgeAI_Tmp'
          Pop $1
        ${EndIf}
      ${EndIf}
      Goto loop
    loopdone:
  ${EndIf}

  ; 4. Machine-wide shortcuts, start-up entries and Apps-list entry; this user's too.
  ClearErrors
  EnumRegValue $1 HKLM "${UNINST}" 0
  ${IfNot} ${Errors}
    StrCpy $Found 1
    ${LOG} "Removed: Apps-list entry (all users)"
  ${EndIf}
  ClearErrors
  EnumRegValue $1 HKCU "${UNINST}" 0
  ${IfNot} ${Errors}
    StrCpy $Found 1
    ${LOG} "Removed: Apps-list entry (this user)"
  ${EndIf}
  DeleteRegKey HKLM "${UNINST}"
  DeleteRegKey HKLM "Software\ForgeAI"
  DeleteRegValue HKLM "${RUNKEY}" "ForgeAI"
  DeleteRegValue HKLM "${APPROVED}" "ForgeAI"
  DeleteRegKey HKCU "${UNINST}"
  DeleteRegKey HKCU "Software\ForgeAI"
  DeleteRegValue HKCU "${RUNKEY}" "ForgeAI"
  DeleteRegValue HKCU "${RUNKEY}" "electron.app.ForgeAI"
  DeleteRegValue HKCU "${RUNKEY}" "local.forgeai.app"
  DeleteRegValue HKCU "${APPROVED}" "ForgeAI"
  DeleteRegValue HKCU "${APPROVED}" "electron.app.ForgeAI"
  ${DEL_IF} "$SMPROGRAMS\ForgeAI.lnk"
  ${DEL_IF} "$DESKTOP\ForgeAI.lnk"
  SetShellVarContext all
  ${DEL_IF} "$SMPROGRAMS\ForgeAI.lnk"
  ${DEL_IF} "$DESKTOP\ForgeAI.lnk"
  SetShellVarContext current

  ; 5. Firewall rules Windows made when ForgeAI was first allowed through.
  ${If} $Admin == 1
    nsExec::Exec `$Ps "Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $$_.Program -like '*\ForgeAI\*' -or $$_.Program -like '*ForgeAI.exe' } | Get-NetFirewallRule | Remove-NetFirewallRule"`
    Pop $1
  ${EndIf}

  ${If} $Found == 0
    ${LOG} "ForgeAI was not found on this computer - nothing to remove."
  ${ElseIf} $Purge == 1
    ${LOG} "Done. ForgeAI and its data have been removed."
  ${Else}
    ${LOG} "Done. ForgeAI has been removed. Your data was kept in %APPDATA%\ForgeAI (and C:\ProgramData\ForgeAI\data for the service)."
  ${EndIf}
  ${LOG} "If this computer was linked to a ForgeAI hub, also remove it there: Computers -> the computer -> Remove (revokes its access)."
  ${If} $Reboot == 1
    ${LOG} "Some files were in use; they are removed when the computer restarts."
    SetErrorLevel 2
  ${EndIf}
  FileClose $Log
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
SectionEnd
