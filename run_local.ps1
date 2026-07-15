# run_local.ps1 - Run NextSpot locally.
#
#   .\run_local.ps1                Install backend deps, then start backend (8000) and frontend (3000) in new windows.
#   .\run_local.ps1 -Train         Also (re)train the local prediction model (apps/api/model.pkl) from Supabase first.
#   .\run_local.ps1 -BackendOnly   Start only the FastAPI backend.
#   .\run_local.ps1 -FrontendOnly  Start only the Next.js frontend.
#
# Prerequisites:
#   - Python 3.11 and Node 20+ on PATH. CI and apps/api/Dockerfile pin 3.11; httpx breaks on 3.14+,
#     so this script resolves 3.11 explicitly (see Resolve-BackendPython) instead of trusting 'python'.
#   - apps/api/.env       (copy apps/api/.env.example and fill Supabase creds + JWT_SECRET).
#   - apps/web/.env.local (Supabase + Kakao keys + NEXT_PUBLIC_FASTAPI_URL).
# Messages are intentionally English (PowerShell 5.1 console is cp949 and garbles Hangul).

param(
  [switch]$Train,
  [switch]$BackendOnly,
  [switch]$FrontendOnly
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$api  = Join-Path $root "apps\api"
$web  = Join-Path $root "apps\web"

# Backend imports fail on non-UTF8 consoles; matches the documented PYTHONUTF8=1 convention.
# Child processes (Start-Process, &) inherit this.
$env:PYTHONUTF8 = "1"

# Resolve the backend interpreter: in-repo venv -> 'py -3.11' launcher -> 'python' on PATH.
# Plain 'python' is last because it is often a newer version (3.14 on this machine), which
# installs deps and then dies at import time inside a detached window - the failure this avoids.
function Resolve-BackendPython {
  param([string]$ApiDir)

  $venvPy = Join-Path $ApiDir ".venv\Scripts\python.exe"
  if (Test-Path $venvPy) { return $venvPy }

  if (Get-Command py -ErrorAction SilentlyContinue) {
    try {
      $exe = & py -3.11 -c "import sys; print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
    } catch { }
  }

  if (Get-Command python -ErrorAction SilentlyContinue) { return "python" }

  throw "[backend] No Python found. Install Python 3.11, or create the in-repo venv: py -3.11 -m venv apps\api\.venv"
}

if (-not $FrontendOnly) {
  $py = Resolve-BackendPython -ApiDir $api

  # A venv whose base install is gone passes Test-Path but cannot run. PS 5.1 returns null there,
  # while pwsh 7.4+ throws NativeCommandExitException - catch both so the message below wins.
  $pyVer = $null
  try { $pyVer = & $py -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null } catch { }
  if ($LASTEXITCODE -ne 0 -or -not $pyVer) {
    throw ("[backend] Could not run the resolved Python: $py`n" +
           "          Fix: py -3.11 -m venv apps\api\.venv    (then re-run this script)")
  }
  $pyVer = $pyVer.Trim()
  $minor = [int]$pyVer.Split('.')[1]

  if ($pyVer -notlike "3.*" -or $minor -ge 14) {
    throw ("[backend] Python $pyVer is unsupported (httpx is incompatible with 3.14+).`n" +
           "          Resolved: $py`n" +
           "          Fix: py -3.11 -m venv apps\api\.venv    (then re-run this script)")
  }
  if ($minor -ne 11) {
    Write-Host "[backend] WARNING: Python $pyVer - CI and Dockerfile pin 3.11. Consider: py -3.11 -m venv apps\api\.venv" -ForegroundColor Yellow
  }
  Write-Host "[backend] Python $pyVer ($py)" -ForegroundColor DarkGray

  Write-Host "[backend] Installing dependencies..." -ForegroundColor Cyan
  & $py -m pip install -r (Join-Path $api "requirements.txt")

  if (-not (Test-Path (Join-Path $api ".env"))) {
    Write-Host "[backend] WARNING: apps/api/.env not found. Copy apps/api/.env.example -> .env and fill Supabase creds." -ForegroundColor Yellow
  }

  if ($Train) {
    Write-Host "[backend] Training local model (scripts/train.py)..." -ForegroundColor Cyan
    Push-Location $api
    & $py "scripts\train.py"
    Pop-Location
  }

  Write-Host "[backend] Starting uvicorn on http://localhost:8000 (new window)..." -ForegroundColor Green
  Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoExit", "-Command", "cd `"$api`"; & `"$py`" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
  )
}

if (-not $BackendOnly) {
  Write-Host "[frontend] Installing dependencies (npm install)..." -ForegroundColor Cyan
  Push-Location $web
  npm install
  Pop-Location

  Write-Host "[frontend] Starting Next.js dev on http://localhost:3000 (new window)..." -ForegroundColor Green
  Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoExit", "-Command", "cd `"$web`"; npm run dev"
  )
}

Write-Host "Done. Backend: http://localhost:8000   Frontend: http://localhost:3000" -ForegroundColor Green
