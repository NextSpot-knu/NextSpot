[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Task,

    [string]$Model = 'gemini-2.5-flash'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot 'apps\api\.env'

if (-not (Get-Command gemini -ErrorAction SilentlyContinue)) {
    throw 'Gemini CLI를 찾을 수 없습니다. gemini 명령을 설치한 뒤 다시 실행하세요.'
}

if (-not $env:GEMINI_API_KEY) {
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw "GEMINI_API_KEY가 없고 환경 파일도 찾을 수 없습니다: $envFile"
    }

    $keyLine = Get-Content -LiteralPath $envFile |
        Where-Object { $_ -match '^\s*GEMINI_API_KEY\s*=' } |
        Select-Object -First 1

    if (-not $keyLine) {
        throw "GEMINI_API_KEY가 $envFile 에 없습니다."
    }

    $env:GEMINI_API_KEY = ($keyLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

if ([string]::IsNullOrWhiteSpace($env:GEMINI_API_KEY)) {
    throw 'GEMINI_API_KEY가 비어 있습니다.'
}

$reviewPrompt = @"
당신은 NextSpot 저장소의 읽기 전용 교차 검토자입니다.
루트 AGENTS.md와 관련 하위 지침을 먼저 따르세요.

검토 과제:
$Task

규칙:
- 파일을 수정하거나 명령으로 상태를 변경하지 마세요.
- 실제 파일을 확인한 발견만 보고하세요.
- 각 발견은 severity(P0/P1/P2), file:line, 근거, 최소 수정 제안을 포함하세요.
- 발견이 없으면 '발견 없음'이라고 명확히 쓰고 남은 검증 한계를 적으세요.
- 추측과 확인된 사실을 구분하고, 시크릿 값은 절대 출력하지 마세요.
"@

$arguments = @(
    '--skip-trust',
    '--approval-mode', 'plan',
    '--output-format', 'text',
    '--prompt', $reviewPrompt
)

$arguments = @('--model', $Model) + $arguments

Push-Location $repoRoot
try {
    & gemini @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Gemini CLI 검토가 종료 코드 $LASTEXITCODE 로 실패했습니다."
    }
}
finally {
    Pop-Location
}
