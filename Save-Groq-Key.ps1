$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '.env'
$secureKey = Read-Host 'Paste Groq API key (input hidden)' -AsSecureString
if ($secureKey.Length -lt 20) { throw 'Key is too short. Create a new key in the Groq Console and try again.' }
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $lines = [System.Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $envFile) { foreach ($line in Get-Content -LiteralPath $envFile) { $lines.Add($line) } }
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*GROQ_API_KEY\s*=') { $lines[$i] = "GROQ_API_KEY=$plainKey"; $found = $true; break }
  }
  if (-not $found) { $lines.Add("GROQ_API_KEY=$plainKey") }
  [System.IO.File]::WriteAllLines($envFile, $lines, [System.Text.UTF8Encoding]::new($false))
  Write-Output 'Groq key saved to the Nexa-AI .env file. The key itself was not displayed.'
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $plainKey = $null
}
