# procs-windows.ps1 <root-pid> [seconds]
# Windows counterpart of procs.py (same JSON): CPU%, memory and disk writes of
# the app and its descendants (WebView2's msedgewebview2.exe processes are
# children of the app). footprint_mb is the private working set;
# disk_written_mb is the process's write transfer count, which also counts
# writes to pipes and devices, so it is an upper bound for disk.
# Written for WP-16; not yet run on a Windows machine.
param([int]$Root, [double]$Seconds = 20)

function Get-Family([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime, WriteTransferCount
  $fam = @{}
  if ($all | Where-Object ProcessId -eq $root) { $fam[$root] = $true }
  do {
    $changed = $false
    foreach ($p in $all) {
      if (-not $fam.ContainsKey([int]$p.ProcessId) -and $fam.ContainsKey([int]$p.ParentProcessId)) { $fam[[int]$p.ProcessId] = $true; $changed = $true }
    }
  } while ($changed)
  $rows = @{}
  foreach ($p in $all) {
    if ($fam.ContainsKey([int]$p.ProcessId)) {
      $rows[[int]$p.ProcessId] = @{ comm = $p.Name; cpu = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 1e7; rss = [double]$p.WorkingSetSize; priv = [double]$p.PrivatePageCount; written = [double]$p.WriteTransferCount }
    }
  }
  return $rows
}

$a = Get-Family $Root
$t0 = Get-Date
$peak = ($a.Values | Measure-Object -Property rss -Sum).Sum
while (((Get-Date) - $t0).TotalSeconds -lt $Seconds) {
  Start-Sleep -Milliseconds 1000
  $s = Get-Family $Root
  $peak = [math]::Max($peak, ($s.Values | ForEach-Object { $_.rss } | Measure-Object -Sum).Sum)
}
$b = Get-Family $Root
$wall = ((Get-Date) - $t0).TotalSeconds
$procs = @()
foreach ($k in $b.Keys) {
  $r = $b[$k]
  $before = if ($a.ContainsKey($k)) { $a[$k] } else { @{ cpu = 0; written = 0 } }
  $procs += [ordered]@{ pid = $k; comm = $r.comm; rss_mb = [math]::Round($r.rss / 1MB, 1); footprint_mb = [math]::Round($r.priv / 1MB, 1)
    cpu_pct = [math]::Round(($r.cpu - $before.cpu) / $wall * 100, 2); disk_written_mb = [math]::Round(($r.written - $before.written) / 1MB, 3)
    disk_written_total_mb = [math]::Round($r.written / 1MB, 3) }
}
$sum = { param($key) [math]::Round((($procs | ForEach-Object { $_[$key] }) | Measure-Object -Sum).Sum, 3) }
[ordered]@{ seconds = [math]::Round($wall, 1); processes = $procs.Count; cpu_pct = (& $sum 'cpu_pct'); rss_mb_end = (& $sum 'rss_mb')
  rss_mb_peak = [math]::Round($peak / 1MB, 1); footprint_mb_end = (& $sum 'footprint_mb'); disk_written_mb = (& $sum 'disk_written_mb')
  disk_written_total_mb = (& $sum 'disk_written_total_mb'); unreadable = @(); by_process = $procs } | ConvertTo-Json -Depth 4
