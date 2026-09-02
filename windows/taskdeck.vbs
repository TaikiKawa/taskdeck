' Launches taskdeck.ps1 without a console window (for the desktop shortcut).
' Any arguments are passed through to taskdeck.ps1 (e.g. -Stop, -NoOpen).
'
' Usage:  wscript.exe taskdeck.vbs [-Stop] [-NoOpen]
'
' NOTE: keep this file ASCII-only. wscript reads .vbs as the ANSI code page,
' so non-ASCII text here would be garbled (the .ps1 files carry a UTF-8 BOM instead).
Option Explicit

Dim fso, shell, scriptDir, ps1, args, i, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "taskdeck.ps1")

args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

' -ExecutionPolicy Bypass: the shortcut works without changing the user's execution policy.
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """" & args

' 0 = hidden window, False = do not wait for exit
shell.Run cmd, 0, False
