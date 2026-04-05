Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fso.BuildPath(baseDir, "launcher\Launcher.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & launcherPath & """"

shell.Run command, 0, False
