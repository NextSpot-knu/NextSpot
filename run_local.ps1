# run_local.ps1 - Run NextSpot locally.
#
#   .\run_local.ps1                Install backend deps, then start backend (8000) and frontend (3000) in new windows.
#   .\run_local.ps1 -Train         Also (re)train the local prediction model (apps/api/model.pkl) from Supabase first.
#   .\run_local.ps1 -BackendOnly   Start only the FastAPI backend.
#   .\run_local.ps1 -FrontendOnly  Start only the Next.js frontend.
#
# Prerequisites:
#   - Python 3.11+ and Node 18+ on PATH.
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

# Prefer the in-repo virtualenv if present, else 'python' on PATH.
$venvPy = Join-Path $api ".venv\Scripts\python.exe"
if (Test-Path $venvPy) { $py = $venvPy } else { $py = "python" }

if (-not $FrontendOnly) {
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
