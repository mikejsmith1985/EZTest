' EZTest — AI Testing Companion
' Double-click this file to launch EZTest.
' The wizard opens automatically in your default browser.
' No terminal window is shown.

Dim objShell, objFSO, strDir, strNodeCheck
Set objShell = CreateObject("WScript.Shell")
Set objFSO   = CreateObject("Scripting.FileSystemObject")

' Resolve the folder where this .vbs file lives so paths are always correct
strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' ── Verify Node.js is available ──────────────────────────────────────────────
strNodeCheck = objShell.Run("cmd /c node --version", 0, True)
If strNodeCheck <> 0 Then
    MsgBox "Node.js is not installed or not on your PATH." & vbCrLf & vbCrLf & _
           "Download Node.js from https://nodejs.org (LTS version recommended)," & vbCrLf & _
           "then try launching EZTest again.", _
           vbCritical, "EZTest — Missing Requirement"
    WScript.Quit 1
End If

' ── Build dist/ on first run (takes ~10-15 seconds) ──────────────────────────
If Not objFSO.FileExists(strDir & "\dist\cli\index.js") Then
    MsgBox "Setting up EZTest for the first time." & vbCrLf & _
           "This takes about 10-15 seconds and only happens once.", _
           vbInformation, "EZTest — First-Time Setup"
    Dim buildResult
    buildResult = objShell.Run( _
        "cmd /c cd /d """ & strDir & """ && npm install && npm run build", _
        1, True)
    If buildResult <> 0 Then
        MsgBox "Build failed. Please check your internet connection and try again." & vbCrLf & _
               "You can also open a terminal in this folder and run: npm install", _
               vbCritical, "EZTest — Build Error"
        WScript.Quit 1
    End If
End If

' ── Launch EZTest — window style 0 hides the terminal completely ──────────────
' The browser wizard opens automatically via socket.io.
objShell.Run _
    "cmd /c cd /d """ & strDir & """ && node dist\cli\index.js ui", _
    0, False
