# Writes UST LLM gateway settings into .env without the key ever appearing
# on screen, in shell history, or in a chat transcript.
#
# The API key is the VALUE of the Key Vault secret 'codon-kvs' — not its name
# and not its version. Fetch it from the Azure Portal (Key Vault ->
# ustdev-az-is-ai-app-kv -> Secrets -> codon-kvs -> version -> Show Secret Value)
# or with:
#   az keyvault secret show --vault-name ustdev-az-is-ai-app-kv `
#       --name codon-kvs --version <version> --query value -o tsv
#
#   .\tools\set-gateway-env.ps1

param(
    [string] $EnvPath   = (Join-Path $PSScriptRoot '..\.env'),
    [string] $BaseUrl   = 'https://llmproxy.ustdev.com',
    [string] $Model     = 'claude-opus-4-8-Codon',
    [string] $ModelChoices = 'claude-opus-4-8-Codon'
)

$EnvPath = [System.IO.Path]::GetFullPath($EnvPath)

Write-Host "Paste the VALUE of Key Vault secret 'codon-kvs' (input is hidden)." -ForegroundColor Cyan
$secure = Read-Host -AsSecureString 'ANTHROPIC_API_KEY'
$key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

if (-not $key) { Write-Warning 'No value entered. Nothing written.'; return }

# Trailing slashes on baseURL produce '//v1/messages' against some gateways.
$BaseUrl = $BaseUrl.TrimEnd('/')

$wanted = [ordered]@{
    ANTHROPIC_API_KEY    = $key
    ANTHROPIC_BASE_URL   = $BaseUrl
    CLAUDE_MODEL         = $Model
    CLAUDE_MODEL_CHOICES = $ModelChoices
}

# Preserve every line we are not responsible for (the SN_* and gate settings).
$kept = @()
if (Test-Path $EnvPath) {
    foreach ($line in (Get-Content -Path $EnvPath)) {
        if ($line -match '^\s*(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|CLAUDE_MODEL|CLAUDE_MODEL_CHOICES)\s*=') { continue }
        $kept += $line
    }
}

$out = @('# UST LLM gateway - written by set-gateway-env.ps1 on ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
foreach ($k in $wanted.Keys) { $out += "$k=$($wanted[$k])" }
if ($kept.Count -gt 0) { $out += ''; $out += $kept }

$out | Out-File -FilePath $EnvPath -Encoding utf8
$key = $null

Write-Host "Wrote gateway settings to $EnvPath" -ForegroundColor Green
Write-Host ("  ANTHROPIC_API_KEY    {0} chars (not shown)" -f $wanted.ANTHROPIC_API_KEY.Length)
Write-Host ("  ANTHROPIC_BASE_URL   {0}" -f $BaseUrl)
Write-Host ("  CLAUDE_MODEL         {0}" -f $Model)
Write-Host ("  preserved {0} existing line(s)" -f $kept.Count)
Write-Warning 'This file holds live secrets. It is gitignored - keep it that way.'
