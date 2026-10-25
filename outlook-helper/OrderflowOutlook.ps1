# Orderflow - Outlook helper
# Opens an Orderflow email (To, CC, subject, text, Excel attachment) as a new
# message in classic Outlook for Windows. Started by the browser through the
# "orderflow-mail:" link type that the one-time setup registers for this
# Windows user. It never sends anything - you review and click Send yourself.
param([string]$Link)

$ErrorActionPreference = 'Stop'
$AllowedOrigin = '__ORIGIN__'

Add-Type -AssemblyName System.Windows.Forms

function Show-Problem([string]$Message) {
  [void][System.Windows.Forms.MessageBox]::Show($Message, 'Orderflow - Outlook',
    [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
}

try {
  # Link looks like: orderflow-mail://open/?url=<url-encoded address of the email>
  $url = $null
  $query = [string]$Link
  $qi = $query.IndexOf('?')
  if ($qi -ge 0) { $query = $query.Substring($qi + 1) }
  foreach ($pair in ($query -split '&')) {
    $kv = $pair -split '=', 2
    if ($kv.Count -eq 2 -and $kv[0] -eq 'url') { $url = [Uri]::UnescapeDataString($kv[1]) }
  }
  if (-not $url -or -not $url.StartsWith($AllowedOrigin + '/api/mail-draft/', [StringComparison]::OrdinalIgnoreCase)) {
    Show-Problem 'This link did not come from your Orderflow app, so it was ignored.'
    exit 1
  }

  # Download the email from Orderflow (uses the PC's normal proxy settings)
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
  $wc.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
  $d = ConvertFrom-Json -InputObject ($wc.DownloadString($url))

  $dir = Join-Path $env:TEMP 'Orderflow'
  [void](New-Item -ItemType Directory -Force -Path $dir)
  $attachment = Join-Path $dir ([System.IO.Path]::GetFileName([string]$d.attachmentName))
  [System.IO.File]::WriteAllBytes($attachment, [Convert]::FromBase64String([string]$d.attachmentBase64))

  try {
    # Same method the original local app used: Outlook automation (COM)
    $outlook = New-Object -ComObject Outlook.Application
    $mail = $outlook.CreateItem(0)
    $mail.To      = [string]$d.to
    $mail.CC      = [string]$d.cc
    $mail.Subject = [string]$d.subject
    $mail.Body    = ([string]$d.body) -replace "`r?`n", "`r`n"
    [void]$mail.Attachments.Add($attachment)
    $mail.Display($false)
    try { $mail.GetInspector.Activate() } catch { }
  } catch {
    # Outlook automation unavailable (e.g. "new Outlook"): open the draft file instead
    $eml = Join-Path $dir ([System.IO.Path]::GetFileName([string]$d.emlName))
    [System.IO.File]::WriteAllBytes($eml, [Convert]::FromBase64String([string]$d.emlBase64))
    Start-Process -FilePath $eml
  }
} catch {
  $web = $_.Exception
  while ($web -and -not ($web -is [System.Net.WebException])) { $web = $web.InnerException }
  $msg = $_.Exception.Message
  if ($web -and $web.Response -and [int]$web.Response.StatusCode -eq 404) {
    $msg = 'This email link has expired. Click the email button in Orderflow again.'
  } elseif ($web) {
    $msg = 'Could not reach Orderflow: ' + $web.Message
  }
  Show-Problem ("Could not create the Outlook email.`r`n`r`n" + $msg)
  exit 1
}
