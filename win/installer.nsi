; ForgeAI installer — per-user, no administrator rights needed.
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!ifndef ARCH
  !define ARCH x64
!endif
!define APPNAME "ForgeAI"
!define VERSION "2.10.0"
Name "${APPNAME}"
OutFile "..\out\Install ForgeAI ${VERSION} (${ARCH}).exe"
InstallDir "$LOCALAPPDATA\Programs\ForgeAI"
InstallDirRegKey HKCU "Software\ForgeAI" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "ForgeAI ${VERSION}"
VIProductVersion "2.9.1.0"
VIAddVersionKey "ProductName" "ForgeAI"
VIAddVersionKey "FileDescription" "ForgeAI Installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "ForgeAI"
!define MUI_ICON "..\ForgeAI.ico"
!define MUI_UNICON "..\ForgeAI.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install ForgeAI"
!define MUI_WELCOMEPAGE_TEXT "Your private AI platform for all your organisations.$\r$\n$\r$\nForgeAI installs just for you — no administrator password needed. Your data is kept if you update later."
!define MUI_FINISHPAGE_RUN "$INSTDIR\ForgeAI.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open ForgeAI now"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ---- Command-line / silent install
;   "Install ForgeAI (x64).exe" /S [/ALLUSERS] [/HUB=host:port /KEY=FGE-...] [/PRIORITY=low|lowest|normal] [/NOYIELD]
;                                 [/LEND=idle|always|never] [/HIDEICON] [/AUTOSTART] [/START] [/NAME=Office PC 3] [/D=C:\path]
;   /S          silent: no windows, no questions (standard NSIS switch)
;   /ALLUSERS   install for every user under Program Files (needs admin; use from management tools running as SYSTEM)
;   /START      start ForgeAI hidden in the background when the install finishes
;   The other switches are written to setup.json next to ForgeAI.exe and applied once on first start.
Var AllUsers
Var Service
Var DataDir
Var Setup
!macro OPT NAME VAR
  ClearErrors
  ${GetOptions} $R0 "${NAME}" ${VAR}
!macroend

Function .onInit
  System::Call 'kernel32::SetPriorityClass(i -1, i 0x4000)'  ; the installer itself runs below normal priority
  ${GetParameters} $R0
  StrCpy $AllUsers 0
  StrCpy $Service 0
  ClearErrors
  ${GetOptions} $R0 "/SERVICE" $R1
  ${IfNot} ${Errors}
    UserInfo::GetAccountType
    Pop $R2
    ${If} $R2 != "Admin"
      IfSilent 0 +2
      SetErrorLevel 740
      MessageBox MB_ICONSTOP "Installing ForgeAI as a background service needs administrator rights." /SD IDOK
      Abort
    ${EndIf}
    StrCpy $Service 1
    StrCpy $AllUsers 1
    SetShellVarContext all
    StrCpy $INSTDIR "$PROGRAMFILES64\ForgeAI"
    StrCpy $DataDir "$APPDATA\ForgeAI\data"   ; $APPDATA is C:\ProgramData under 'all' context — matches the service
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/ALLUSERS" $R1
  ${IfNot} ${Errors}
    UserInfo::GetAccountType
    Pop $R2
    ${If} $R2 != "Admin"
      IfSilent 0 +2
      SetErrorLevel 740
      MessageBox MB_ICONSTOP "/ALLUSERS needs administrator rights." /SD IDOK
      Abort
    ${EndIf}
    StrCpy $AllUsers 1
    SetShellVarContext all
    StrCpy $INSTDIR "$PROGRAMFILES64\ForgeAI"
  ${EndIf}
FunctionEnd

Function WriteSetup
  ${GetParameters} $R0
  StrCpy $Setup ""
  !insertmacro OPT "/JOIN=" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"join": "$R1", '
  ${EndIf}
  !insertmacro OPT "/HUB=" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"hub": "$R1", "worker": true, '
  ${EndIf}
  !insertmacro OPT "/KEY=" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"key": "$R1", '
  ${EndIf}
  !insertmacro OPT "/PRIORITY=" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"priority": "$R1", '
  ${EndIf}
  !insertmacro OPT "/LEND=" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"lend": "$R1", '
  ${EndIf}
  !insertmacro OPT "/NAME=" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"name": "$R1", '
  ${EndIf}
  !insertmacro OPT "/NOYIELD" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"yield": false, '
  ${EndIf}
  !insertmacro OPT "/HIDEICON" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"showIcon": false, '
  ${EndIf}
  !insertmacro OPT "/AUTOSTART" $R1
  ${IfNot} ${Errors}
    StrCpy $Setup '$Setup"startAtLogin": true, "startHidden": true, '
  ${EndIf}
  ${If} $Service == 1
    StrCpy $Setup '$Setup"worker": true, '
  ${EndIf}
  ${If} $Setup != ""
    IfSilent 0 +2
    StrCpy $Setup '$Setup"silent": true, '
    ${If} $Service == 1
      CreateDirectory "$DataDir"
      FileOpen $R2 "$DataDir\setup.json" w
    ${Else}
      FileOpen $R2 "$INSTDIR\setup.json" w
    ${EndIf}
    FileWrite $R2 '{ $Setup"from": "installer" }'
    FileClose $R2
  ${EndIf}
FunctionEnd


!define ENV_HKLM 'HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"'
!define ENV_HKCU 'HKCU "Environment"'
Function AddToPath
  Exch $0
  Push $1
  Push $2
  ${If} $AllUsers == 1
    ReadRegStr $1 ${ENV_HKLM} "Path"
  ${Else}
    ReadRegStr $1 ${ENV_HKCU} "Path"
  ${EndIf}
  StrCpy $2 ";$1;"
  Push $2
  Push ";$0;"
  Call StrContains
  Pop $2
  ${If} $2 == ""
    ${If} $1 == ""
      StrCpy $1 "$0"
    ${Else}
      StrCpy $1 "$1;$0"
    ${EndIf}
    ${If} $AllUsers == 1
      WriteRegExpandStr ${ENV_HKLM} "Path" "$1"
    ${Else}
      WriteRegExpandStr ${ENV_HKCU} "Path" "$1"
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
; StrContains: Push haystack, Push needle -> Pop match ("" if not found)
Function StrContains
  Exch $R1 ; needle
  Exch
  Exch $R2 ; haystack
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R4 0
  StrCpy $R5 ""
  loop:
    StrCpy $R5 $R2 $R3 $R4
    StrCmp $R5 $R1 found
    StrCmp $R5 "" notfound
    IntOp $R4 $R4 + 1
    Goto loop
  found:
    StrCpy $R5 $R1
    Goto done
  notfound:
    StrCpy $R5 ""
  done:
  StrCpy $R1 $R5
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Exch $R1
FunctionEnd

Section "Install"
  nsExec::Exec 'taskkill /IM "ForgeAI.exe" /F'
  Sleep 800
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  File /r "..\dist\ForgeAI-win32-${ARCH}\*.*"
  Call WriteSetup
  WriteUninstaller "$INSTDIR\Uninstall ForgeAI.exe"
  ; forgeai CLI shim + PATH entry (install scope)
  FileOpen $9 "$INSTDIR\forgeai.cmd" w
  FileWrite $9 "@echo off$\r$\n"
  FileWrite $9 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\app\deploy\forgeai.ps1" %*$\r$\n'
  FileClose $9
  Push "$INSTDIR"
  Call AddToPath
  ${If} $Service == 0
    CreateShortcut "$SMPROGRAMS\ForgeAI.lnk" "$INSTDIR\ForgeAI.exe"
    IfSilent +2 0
    CreateShortcut "$DESKTOP\ForgeAI.lnk" "$INSTDIR\ForgeAI.exe"
  ${EndIf}
  WriteRegStr SHCTX "Software\ForgeAI" "InstallDir" "$INSTDIR"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "DisplayName" "ForgeAI"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "Publisher" "ForgeAI"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "DisplayIcon" "$INSTDIR\ForgeAI.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "UninstallString" '"$INSTDIR\Uninstall ForgeAI.exe"'
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "QuietUninstallString" '"$INSTDIR\Uninstall ForgeAI.exe" /S'
  WriteRegDWORD SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "NoModify" 1
  WriteRegDWORD SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI" "NoRepair" 1
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/AUTOSTART" $R1
  ${IfNot} ${Errors}
  ${AndIf} $AllUsers == 1
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ForgeAI" '"$INSTDIR\ForgeAI.exe" --hidden'
  ${EndIf}
  ${If} $Service == 1
    ; Register ForgeAI as a Windows service running as LocalSystem, started at boot. One copy per computer.
    DetailPrint "Installing the ForgeAI background service..."
    nsExec::Exec '"$SYSDIR\sc.exe" stop ForgeAI'
    nsExec::Exec '"$SYSDIR\sc.exe" delete ForgeAI'
    Sleep 800
    nsExec::ExecToLog '"$SYSDIR\sc.exe" create ForgeAI binPath= "\"$INSTDIR\ForgeAIService.exe\"" start= auto DisplayName= "ForgeAI"'
    Pop $R3
    ${If} $R3 != 0
      IfSilent +2 0
      MessageBox MB_ICONSTOP "Could not create the ForgeAI service (sc.exe returned $R3). Run the installer as administrator."
      SetErrorLevel 1603
    ${Else}
      nsExec::Exec '"$SYSDIR\sc.exe" description ForgeAI "ForgeAI private AI platform (background worker). Managed from your ForgeAI hub."'
      nsExec::Exec '"$SYSDIR\sc.exe" failure ForgeAI reset= 86400 actions= restart/5000/restart/10000/restart/30000'
      nsExec::Exec '"$SYSDIR\sc.exe" start ForgeAI'
    ${EndIf}
    Goto done
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/START" $R1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\ForgeAI.exe" --hidden'
  ${EndIf}
  done:
SectionEnd

Function un.onInit
  ReadRegStr $R0 HKLM "Software\ForgeAI" "InstallDir"
  ${If} $R0 != ""
  ${AndIf} $R0 == $INSTDIR
    SetShellVarContext all
  ${EndIf}
FunctionEnd

Section "Uninstall"
  nsExec::Exec '"$SYSDIR\sc.exe" stop ForgeAI'
  Sleep 1200
  nsExec::Exec '"$SYSDIR\sc.exe" delete ForgeAI'
  nsExec::Exec 'taskkill /IM "ForgeAIService.exe" /F'
  nsExec::Exec 'taskkill /IM "ForgeAI.exe" /F'
  Sleep 800
  Delete "$SMPROGRAMS\ForgeAI.lnk"
  Delete "$DESKTOP\ForgeAI.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeAI"
  DeleteRegKey SHCTX "Software\ForgeAI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ForgeAI"
  ; Your ForgeAI data (in %APPDATA%\ForgeAI) is kept. Delete that folder yourself to remove it.
SectionEnd
