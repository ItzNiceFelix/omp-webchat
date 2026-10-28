' Windowless entry point for the desktop shortcuts.
'
' A shortcut can point at a .cmd, but Windows always gives a console program a console, and a
' shortcut can only minimise it (WindowStyle 7), never hide it: two lit cmd icons in the
' taskbar. wscript is a GUI host, so the same launcher runs with no window at all.
'
' The argument is forwarded to webchat.sh (start / stop / restart / status), and a failure
' still has to reach a human, so it becomes a message box instead of a line of console output
' nobody would see.
Option Explicit

Dim fso, sh, root, bash, script, arg, cmd, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' scripts\webchat.vbs -> scripts -> the checkout
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
script = root & "\scripts\webchat.sh"

bash = "C:\Program Files\Git\bin\bash.exe"
If Not fso.FileExists(bash) Then bash = "bash"

arg = "start"
If WScript.Arguments.Count > 0 Then arg = WScript.Arguments(0)

cmd = """" & bash & """ """ & script & """ " & arg

On Error Resume Next
rc = sh.Run(cmd, 0, True)
If Err.Number <> 0 Then
	MsgBox "omp webchat: could not run bash." & vbCrLf & vbCrLf & Err.Description, 16, "omp webchat"
	WScript.Quit 1
End If
On Error GoTo 0

' status is a question, and "not running" is a normal answer to it, so it stays silent.
If rc <> 0 And arg <> "status" Then
	MsgBox "omp webchat: " & arg & " failed (exit " & rc & ")." & vbCrLf & vbCrLf & _
		"Log: " & root & "\.run\webchat.log", 16, "omp webchat"
End If

WScript.Quit rc
