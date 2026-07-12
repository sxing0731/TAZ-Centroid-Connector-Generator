$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
& ".\.venv\Scripts\python.exe" "qaqc_web.py" --run-folder "output" --port 8765
