# Baut den vollständig portablen Windows-Ordner. Läuft in GitHub Actions (windows-latest).
param([string]$Out = "dist\MrPG-Folder-Organizer")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Src = Split-Path -Parent $PSScriptRoot
$Dl = Join-Path ([IO.Path]::GetTempPath()) "fo-dl"
New-Item -ItemType Directory -Force $Dl, $Out | Out-Null
$Out = (Resolve-Path $Out).Path

function Get($url, $file) {
  $dst = Join-Path $Dl $file
  if (-not (Test-Path $dst)) {
    Write-Host "Lade $url"
    for ($i = 1; $i -le 4; $i++) {
      try { Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing; break }
      catch { if ($i -eq 4) { throw }; Start-Sleep -Seconds (2 * $i) }
    }
  }
  return $dst
}

# 1. Programm
Copy-Item -Recurse -Force "$Src\app", "$Src\tests" $Out
Copy-Item -Force "$Src\Start.bat", "$Src\LIESMICH.txt" $Out
Get-ChildItem $Out -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force

# 2. Python (embeddable) mit site-packages
$PyVer = "3.12.8"
$py = Get "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip" "python.zip"
Expand-Archive $py "$Out\runtime\python" -Force
$pth = Get-ChildItem "$Out\runtime\python\python*._pth" | Select-Object -First 1
(Get-Content $pth) -replace '^#\s*import site', 'import site' | Set-Content $pth -Encoding ascii
$gp = Get "https://bootstrap.pypa.io/get-pip.py" "get-pip.py"
& "$Out\runtime\python\python.exe" $gp --no-warn-script-location
& "$Out\runtime\python\python.exe" -m pip install --no-warn-script-location --no-cache-dir pypdf pypdfium2 Pillow
if ($LASTEXITCODE) { throw "pip fehlgeschlagen" }
& "$Out\runtime\python\python.exe" -m pip uninstall -y pip setuptools wheel | Out-Null
Remove-Item -Recurse -Force "$Out\runtime\python\Scripts" -ErrorAction SilentlyContinue

# 3. FFmpeg
$ff = Get "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip" "ffmpeg.zip"
Expand-Archive $ff "$Dl\ffmpeg" -Force
New-Item -ItemType Directory -Force "$Out\tools\ffmpeg" | Out-Null
Copy-Item (Get-ChildItem "$Dl\ffmpeg" -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName "$Out\tools\ffmpeg\"
Copy-Item (Get-ChildItem "$Dl\ffmpeg" -Recurse -Filter LICENSE* | Select-Object -First 1).FullName "$Out\tools\ffmpeg\LICENSE.txt"

# 4. Tesseract OCR (NSIS-Installer ohne Installation entpacken)
$ts = Get "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe" "tesseract.exe"
& 7z x $ts "-o$Out\tools\tesseract" -y | Out-Null
Remove-Item -Recurse -Force "$Out\tools\tesseract\`$PLUGINSDIR", "$Out\tools\tesseract\tesseract-uninstall.exe" -ErrorAction SilentlyContinue
if (-not (Test-Path "$Out\tools\tesseract\tesseract.exe")) { throw "tesseract.exe fehlt" }
New-Item -ItemType Directory -Force "$Out\tools\tesseract\tessdata" | Out-Null
Copy-Item (Get "https://github.com/tesseract-ocr/tessdata_fast/raw/main/deu.traineddata" "deu.traineddata") "$Out\tools\tesseract\tessdata\" -Force
Copy-Item (Get "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata" "eng.traineddata") "$Out\tools\tesseract\tessdata\" -Force

# 5. llama.cpp (CPU-Version, läuft auf jedem x64-PC)
gh release download --repo ggml-org/llama.cpp --pattern "llama-*-bin-win-cpu-x64.zip" -D $Dl --clobber
if ($LASTEXITCODE) { throw "llama.cpp-Download fehlgeschlagen" }
$lz = Get-ChildItem "$Dl\llama-*-bin-win-cpu-x64.zip" | Select-Object -First 1
Expand-Archive $lz.FullName "$Dl\llama" -Force
$srv = Get-ChildItem "$Dl\llama" -Recurse -Filter llama-server.exe | Select-Object -First 1
New-Item -ItemType Directory -Force "$Out\tools\llama" | Out-Null
Copy-Item $srv.FullName "$Out\tools\llama\"
Copy-Item "$($srv.DirectoryName)\*.dll" "$Out\tools\llama\"

# 6. Assistenten
New-Item -ItemType Directory -Force "$Out\assistenten\sortier", "$Out\assistenten\such" | Out-Null
Copy-Item (Get "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf" "sortier.gguf") "$Out\assistenten\sortier\sortierassistent.gguf"
Copy-Item (Get "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf" "such.gguf") "$Out\assistenten\such\suchassistent.gguf"

# 7. Demo-Ordner
& "$Out\runtime\python\python.exe" "$Src\build\make_demo.py" "$Out\Demo-Ordner"

$size = (Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("Portabler Ordner fertig: {0:N0} MB" -f $size)
