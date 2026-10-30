Set s = CreateObject("Wscript.Shell")
scriptdir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(Wscript.ScriptFullName)
s.CurrentDirectory = scriptdir
s.Run "pythonw """ & scriptdir & "\pc_scanner.py"" --serve", 0, False
