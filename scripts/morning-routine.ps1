<#
  Morning bookmark routine — runs unattended via Windows Task Scheduler.

  Pipeline:
    1. skill:sync      pull new bookmarks from X (pure npm script, deterministic)
    2. claude headless qualify (enrich raw) + audit tags + daily digest

  Step 2 runs `claude -p` in non-interactive mode (acceptEdits). File edits
  (the digest note) are auto-approved; Bash commands run only if they match the
  targeted allowlist in .claude/settings.local.json (the skill tsx scripts +
  the digests mkdir). Nothing outside that scope can run unattended — no
  --dangerously-skip-permissions. Trade-off: if a skill ever calls a command
  not on the allowlist, that step is skipped rather than executed.

  Logs land in .\logs\morning-routine-YYYYMMDD.log
#>

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

# --- resolve tool paths (Task Scheduler PATH can be minimal) ---
$ClaudeCmd = Join-Path $env:APPDATA "npm\claude.cmd"
if (-not (Test-Path $ClaudeCmd)) { $ClaudeCmd = "claude" }
$PermissionFlag = @("--permission-mode", "acceptEdits")

# --- logging ---
$LogDir = Join-Path $ProjectDir "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$Stamp = Get-Date -Format "yyyyMMdd"
$LogFile = Join-Path $LogDir "morning-routine-$Stamp.log"
function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  $line | Tee-Object -FilePath $LogFile -Append
}

Log "=== Morning routine start ==="

# --- Step 1: sync (pure, no Claude) ---
Log "Step 1/2: sync new bookmarks"
try {
  $syncOut = & npm run skill:sync 2>&1 | Out-String
  $syncOut | Out-File -FilePath $LogFile -Append -Encoding utf8
  Log "sync done"
} catch {
  Log "sync FAILED: $_"
}

# --- Step 2: qualify + tags audit + digest (Claude headless) ---
Log "Step 2/2: enrich + tags audit + digest (claude headless)"

$Prompt = @'
You are running the unattended morning maintenance for the X bookmark vault. Do exactly this, in order, then stop:

1. Enrich: invoke the bookmark-enrich skill to process EVERY bookmark still at status:raw (generate Summary + canonical tags, flip to enriched). If there are none, say so and skip.
2. Tags audit (REPORT ONLY): invoke the bookmark-tags skill with the `audit` subcommand to detect duplicate/synonym tags. List the candidate merges but DO NOT merge anything — merges are destructive and need human review.
3. Digest: invoke the bookmark-digest skill for the current week (`week`). This routine runs daily, so the current week's digest file will usually already exist — OVERWRITE it with the refreshed version (the digest is a derived artifact, overwriting is expected here; do not ask). If the week window is empty, skip without writing.

Finish with a concise plain-text summary: how many enriched, any new canonical tags, tag-merge candidates found (for me to review later), and the digest file path. Do not ask questions — run autonomously.
'@

try {
  $claudeOut = & $ClaudeCmd -p $Prompt @PermissionFlag 2>&1 | Out-String
  $claudeOut | Out-File -FilePath $LogFile -Append -Encoding utf8
  Log "claude maintenance done"
} catch {
  Log "claude maintenance FAILED: $_"
}

Log "=== Morning routine end ==="
