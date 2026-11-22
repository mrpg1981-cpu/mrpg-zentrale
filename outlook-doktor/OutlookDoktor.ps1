<#
.SYNOPSIS
    Outlook Doktor - Phase 1: Diagnose-Engine fuer Microsoft Outlook (klassisch, 2016/2019/2021/365).

.DESCRIPTION
    Fuehrt 10 Pruefungen aus und erstellt einen Bericht (JSON + HTML).
    Phase 1 aendert NICHTS am System - reine Analyse.

.PARAMETER OutputPath
    Ordner fuer die Berichte. Standard: Desktop\OutlookDoktor

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\OutlookDoktor.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'OutlookDoktor')
)

$ErrorActionPreference = 'Continue'
$Results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param(
        [string]$Modul, [ValidateSet('OK','Warnung','Fehler','Info')][string]$Status,
        [string]$Befund, [string]$Reparatur = ''
    )
    $Results.Add([pscustomobject]@{
        Modul = $Modul; Status = $Status; Befund = $Befund; Reparatur = $Reparatur
    })
    $color = @{ OK='Green'; Warnung='Yellow'; Fehler='Red'; Info='Cyan' }[$Status]
    Write-Host ("  [{0,-7}] {1}: {2}" -f $Status, $Modul, $Befund) -ForegroundColor $color
}

function Invoke-Check {
    param([string]$Name, [scriptblock]$Block)
    Write-Host "`n>> $Name" -ForegroundColor White
    try { & $Block } catch { Add-Result $Name 'Fehler' "Pruefung fehlgeschlagen: $($_.Exception.Message)" }
}

# ---------- Office-Version ermitteln ----------
$OfficeVer = $null
foreach ($v in '16.0','15.0') {
    if (Test-Path "HKCU:\Software\Microsoft\Office\$v\Outlook") { $OfficeVer = $v; break }
}
$OutlookKey = if ($OfficeVer) { "HKCU:\Software\Microsoft\Office\$OfficeVer\Outlook" } else { $null }

Write-Host "=== Outlook Doktor - Diagnose ===" -ForegroundColor Cyan
Write-Host "Computer: $env:COMPUTERNAME   Benutzer: $env:USERNAME   $(Get-Date -Format 'dd.MM.yyyy HH:mm')"

# 1. Prozess
Invoke-Check 'Outlook-Prozess' {
    $p = @(Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue)
    if ($p.Count -eq 0)      { Add-Result 'Outlook-Prozess' 'Info' 'Outlook laeuft derzeit nicht.' }
    elseif ($p.Count -gt 1)  { Add-Result 'Outlook-Prozess' 'Fehler' "$($p.Count) Outlook-Prozesse gleichzeitig." 'Prozesse beenden, Outlook neu starten' }
    elseif (-not $p[0].Responding) { Add-Result 'Outlook-Prozess' 'Fehler' 'Outlook reagiert nicht.' 'Prozess beenden, Start mit /safe testen' }
    else { Add-Result 'Outlook-Prozess' 'OK' ("Laeuft, RAM {0:N0} MB" -f ($p[0].WorkingSet64/1MB)) }
}

# 2. Add-ins
Invoke-Check 'Add-ins' {
    $paths = 'HKCU:\Software\Microsoft\Office\Outlook\Addins',
             'HKLM:\Software\Microsoft\Office\Outlook\Addins',
             'HKLM:\Software\WOW6432Node\Microsoft\Office\Outlook\Addins'
    $addins = foreach ($pth in $paths) {
        if (Test-Path $pth) { Get-ChildItem $pth | ForEach-Object {
            $pr = Get-ItemProperty $_.PSPath
            [pscustomobject]@{ Name = $_.PSChildName; LoadBehavior = $pr.LoadBehavior; Friendly = $pr.FriendlyName }
        } }
    }
    $active = @($addins | Where-Object { $_.LoadBehavior -eq 3 })
    Add-Result 'Add-ins' 'Info' "$(@($addins).Count) Add-ins gefunden, $($active.Count) aktiv beim Start."
    if ($OutlookKey -and (Test-Path "$OutlookKey\Resiliency\DisabledItems")) {
        $dis = (Get-Item "$OutlookKey\Resiliency\DisabledItems").ValueCount
        if ($dis -gt 0) { Add-Result 'Add-ins' 'Warnung' "$dis Add-in(s) von Outlook wegen Fehlern deaktiviert." 'Add-in pruefen/aktualisieren oder entfernen' }
    }
    if ($active.Count -gt 8) { Add-Result 'Add-ins' 'Warnung' 'Viele aktive Add-ins - Start kann langsam sein.' 'Unnoetige Add-ins deaktivieren' }
}

# 3. Datendateien
Invoke-Check 'Datendateien (PST/OST)' {
    $dirs = "$env:LOCALAPPDATA\Microsoft\Outlook", "$env:USERPROFILE\Documents\Outlook-Dateien", "$env:USERPROFILE\Documents\Outlook Files"
    $files = foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem $d -Include *.pst,*.ost -Recurse -ErrorAction SilentlyContinue } }
    if (-not $files) { Add-Result 'Datendateien' 'Info' 'Keine PST/OST-Dateien in Standardordnern gefunden.'; return }
    foreach ($f in $files) {
        $gb = [math]::Round($f.Length/1GB, 2)
        if ($f.IsReadOnly) { Add-Result 'Datendateien' 'Fehler' "$($f.Name) ist schreibgeschuetzt." 'Schreibschutz entfernen' }
        elseif ($gb -ge 50) { Add-Result 'Datendateien' 'Fehler' "$($f.Name): $gb GB (Grenze 50 GB)." 'Archivieren / Postfach verkleinern' }
        elseif ($gb -ge 40) { Add-Result 'Datendateien' 'Warnung' "$($f.Name): $gb GB - nahe am Limit." 'Archivieren empfohlen' }
        else { Add-Result 'Datendateien' 'OK' "$($f.Name): $gb GB" }
        try { $s = [IO.File]::Open($f.FullName,'Open','Read','ReadWrite'); $b = New-Object byte[] 4; [void]$s.Read($b,0,4); $s.Close()
              if ([Text.Encoding]::ASCII.GetString($b) -ne '!BDN') { Add-Result 'Datendateien' 'Fehler' "$($f.Name): Datei-Header ungueltig." 'SCANPST ausfuehren / OST neu aufbauen' } }
        catch { Add-Result 'Datendateien' 'Info' "$($f.Name) ist gesperrt (Outlook offen) - Header nicht geprueft." }
    }
}

# 4. Profil
Invoke-Check 'Profil' {
    if (-not $OutlookKey) { Add-Result 'Profil' 'Fehler' 'Keine Outlook-Konfiguration gefunden.' 'Outlook installieren/einrichten'; return }
    $profRoot = "$OutlookKey\Profiles"
    $profiles = if (Test-Path $profRoot) { @(Get-ChildItem $profRoot | Select-Object -Expand PSChildName) } else { @() }
    if ($profiles.Count -eq 0) { Add-Result 'Profil' 'Fehler' 'Kein Outlook-Profil vorhanden.' 'Neues Profil anlegen'; return }
    $def = (Get-ItemProperty $OutlookKey -ErrorAction SilentlyContinue).DefaultProfile
    if (-not $def -or $profiles -notcontains $def) { Add-Result 'Profil' 'Fehler' "Standardprofil '$def' fehlt/ungueltig." 'Standardprofil setzen' }
    else { Add-Result 'Profil' 'OK' "$($profiles.Count) Profil(e), Standard: $def" }
}

# 5. Navigationsbereich
Invoke-Check 'Navigationsbereich' {
    $xml = Get-ChildItem "$env:APPDATA\Microsoft\Outlook\*.xml" -ErrorAction SilentlyContinue
    foreach ($x in $xml) {
        if ($x.Length -eq 0) { Add-Result 'Navigationsbereich' 'Fehler' "$($x.Name) ist leer." 'outlook.exe /resetnavpane'; continue }
        try { [xml](Get-Content $x.FullName -Raw) | Out-Null; Add-Result 'Navigationsbereich' 'OK' "$($x.Name) gueltig." }
        catch { Add-Result 'Navigationsbereich' 'Fehler' "$($x.Name) beschaedigt." 'outlook.exe /resetnavpane' }
    }
    if (-not $xml) { Add-Result 'Navigationsbereich' 'Info' 'Keine Navigationsdatei gefunden.' }
}

# 6. Verbindung
Invoke-Check 'Verbindung' {
    foreach ($h in 'outlook.office365.com','autodiscover-s.outlook.com') {
        $t = Test-NetConnection $h -Port 443 -WarningAction SilentlyContinue
        if ($t.TcpTestSucceeded) { Add-Result 'Verbindung' 'OK' "${h}:443 erreichbar." }
        else { Add-Result 'Verbindung' 'Fehler' "${h}:443 nicht erreichbar." 'Netzwerk/Proxy/Firewall pruefen, DNS-Cache leeren' }
    }
    $proxy = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings').ProxyEnable
    if ($proxy -eq 1) { Add-Result 'Verbindung' 'Info' 'Proxy ist aktiv.' }
    $tls = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client' -ErrorAction SilentlyContinue
    if ($tls -and $tls.Enabled -eq 0) { Add-Result 'Verbindung' 'Fehler' 'TLS 1.2 ist deaktiviert.' 'TLS 1.2 aktivieren' }
}

# 7. Anmeldung
Invoke-Check 'Anmeldung' {
    $creds = @(cmdkey /list 2>$null | Select-String -Pattern 'MicrosoftOffice|msteams|outlook' )
    Add-Result 'Anmeldung' 'Info' "$($creds.Count) Office-Eintraege in der Anmeldeinformationsverwaltung."
    if ($creds.Count -gt 10) { Add-Result 'Anmeldung' 'Warnung' 'Viele gespeicherte Office-Anmeldungen - moegliche Ursache fuer Anmeldeschleifen.' 'Office-Anmeldedaten leeren' }
    $broker = "$env:LOCALAPPDATA\Packages\Microsoft.AAD.BrokerPlugin_cw5n1h2txyewy"
    if (-not (Test-Path $broker)) { Add-Result 'Anmeldung' 'Warnung' 'AAD BrokerPlugin fehlt.' 'BrokerPlugin neu registrieren' }
}

# 8. Office-Installation
Invoke-Check 'Office-Installation' {
    $c2r = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue
    if ($c2r) {
        Add-Result 'Office-Installation' 'Info' "Click-to-Run Version $($c2r.VersionToReport), Plattform $($c2r.Platform)"
        if ($c2r.UpdatesEnabled -eq 'False') { Add-Result 'Office-Installation' 'Warnung' 'Office-Updates deaktiviert.' 'Updates aktivieren' }
        $svc = Get-Service ClickToRunSvc -ErrorAction SilentlyContinue
        if ($svc.Status -ne 'Running') { Add-Result 'Office-Installation' 'Fehler' 'Dienst ClickToRunSvc laeuft nicht.' 'Dienst starten / Schnellreparatur' }
    } else { Add-Result 'Office-Installation' 'Info' 'Keine Click-to-Run-Installation (MSI oder nicht installiert).' }
    $exe = Get-ChildItem "${env:ProgramFiles}\Microsoft Office\root\Office*\OUTLOOK.EXE","${env:ProgramFiles(x86)}\Microsoft Office\root\Office*\OUTLOOK.EXE" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) { Add-Result 'Office-Installation' 'OK' "OUTLOOK.EXE $($exe.VersionInfo.FileVersion)" }
    else { Add-Result 'Office-Installation' 'Warnung' 'OUTLOOK.EXE nicht im Standardpfad gefunden.' }
}

# 9. Ereignisanzeige
Invoke-Check 'Abstuerze (30 Tage)' {
    $ev = @(Get-WinEvent -FilterHashtable @{ LogName='Application'; Id=1000,1001,1002; StartTime=(Get-Date).AddDays(-30) } -ErrorAction SilentlyContinue |
            Where-Object { $_.Message -match 'OUTLOOK\.EXE' })
    if ($ev.Count -eq 0) { Add-Result 'Abstuerze' 'OK' 'Keine Outlook-Abstuerze.' }
    else {
        $mod = ($ev | ForEach-Object { if ($_.Message -match '(?i)(?:Modul|module).*?:\s*(\S+\.dll)') { $Matches[1] } } | Group-Object | Sort-Object Count -Desc | Select-Object -First 1).Name
        $st = if ($ev.Count -ge 5) { 'Fehler' } else { 'Warnung' }
        Add-Result 'Abstuerze' $st "$($ev.Count) Absturz/Haenger-Ereignisse. Haeufigstes Modul: $mod" 'Add-ins pruefen, Office reparieren'
    }
}

# 10. Speicher & Rechte
Invoke-Check 'Speicherplatz & Rechte' {
    $drive = Get-PSDrive ($env:LOCALAPPDATA.Substring(0,1))
    $freeGB = [math]::Round($drive.Free/1GB,1)
    if ($freeGB -lt 5) { Add-Result 'Speicher' 'Fehler' "Nur $freeGB GB frei." 'Speicherplatz freigeben' }
    elseif ($freeGB -lt 15) { Add-Result 'Speicher' 'Warnung' "$freeGB GB frei." }
    else { Add-Result 'Speicher' 'OK' "$freeGB GB frei." }
    $dir = "$env:LOCALAPPDATA\Microsoft\Outlook"
    if (Test-Path $dir) {
        try { $tf = Join-Path $dir "od_test_$PID.tmp"; Set-Content $tf 'x'; Remove-Item $tf; Add-Result 'Rechte' 'OK' 'Outlook-Ordner beschreibbar.' }
        catch { Add-Result 'Rechte' 'Fehler' 'Keine Schreibrechte im Outlook-Ordner.' 'Ordnerrechte korrigieren' }
    }
}

# ---------- Bericht ----------
New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmm'
$report = [pscustomobject]@{
    Computer = $env:COMPUTERNAME; Benutzer = $env:USERNAME; Datum = (Get-Date).ToString('s')
    OfficeVersion = $OfficeVer; Ergebnisse = $Results
}
$jsonFile = Join-Path $OutputPath "Diagnose_$stamp.json"
$report | ConvertTo-Json -Depth 5 | Set-Content $jsonFile -Encoding UTF8

$rows = ($Results | ForEach-Object {
    $c = @{ OK='#2e7d32'; Warnung='#f9a825'; Fehler='#c62828'; Info='#1565c0' }[$_.Status]
    "<tr><td style='color:$c;font-weight:bold'>$($_.Status)</td><td>$($_.Modul)</td><td>$([Net.WebUtility]::HtmlEncode($_.Befund))</td><td>$($_.Reparatur)</td></tr>"
}) -join "`n"
$err = @($Results | Where-Object Status -eq 'Fehler').Count
$warn = @($Results | Where-Object Status -eq 'Warnung').Count
$html = @"
<!doctype html><html lang="de"><meta charset="utf-8"><title>Outlook Doktor - Bericht</title>
<style>body{font-family:Segoe UI,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}th{background:#eee}</style>
<h1>Outlook Doktor - Diagnosebericht</h1>
<p>$env:COMPUTERNAME / $env:USERNAME - $(Get-Date -Format 'dd.MM.yyyy HH:mm') - Office $OfficeVer</p>
<p><b>$err Fehler, $warn Warnungen</b></p>
<table><tr><th>Status</th><th>Modul</th><th>Befund</th><th>Empfohlene Reparatur</th></tr>
$rows
</table></html>
"@
$htmlFile = Join-Path $OutputPath "Diagnose_$stamp.html"
$html | Set-Content $htmlFile -Encoding UTF8

Write-Host "`n=== Ergebnis: $err Fehler, $warn Warnungen ===" -ForegroundColor Cyan
Write-Host "Bericht: $htmlFile"
Write-Host "Daten:   $jsonFile"
