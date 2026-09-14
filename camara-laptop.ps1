#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Controla la cámara de la laptop para el SmartPetFeeder.

.USO
  .\camara-laptop.ps1 iniciar   # Inicia el transmisor (http://TU_IP:5002/video)
  .\camara-laptop.ps1 apagar    # Detiene el transmisor
  .\camara-laptop.ps1 estado    # Muestra si está corriendo
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerScript = Join-Path $ScriptDir "laptop_camera_server.py"
$PidFile = Join-Path ([System.IO.Path]::GetTempPath()) "smartpetfeeder_cam.pid"
$LogFile = Join-Path ([System.IO.Path]::GetTempPath()) "smartpetfeeder_cam.log"

function Get-ServerPid {
  if (Test-Path $PidFile) {
    $id = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($id -match '^\d+$') { return [int]$id }
  }
  return $null
}

function Test-Server {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:5002/" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Start-Camera {
  if (Test-Server) {
    Write-Host "La cámara ya está transmitiendo en http://127.0.0.1:5002/"
    return
  }
  $oldPid = Get-ServerPid
  if ($oldPid) {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path $ServerScript)) {
    Write-Host "No se encontró: $ServerScript" -ForegroundColor Red
    return
  }
  $p = Start-Process -FilePath "python" `
    -ArgumentList "`"$ServerScript`"" `
    -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" `
    -WindowStyle Hidden -PassThru
  $p.Id | Out-File $PidFile -Encoding ascii -NoNewline
  Write-Host "Iniciando transmisor (PID $($p.Id))..."
  Start-Sleep -Seconds 8
  if (Test-Server) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -like '192.168.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
      Select-Object -First 1 -ExpandProperty IPAddress)
    if (-not $ip) { $ip = "TU_IP" }
    Write-Host ""
    Write-Host "  Cámara transmitiendo:" -ForegroundColor Green
    Write-Host "    http://${ip}:5002/video"
    Write-Host ""
    Write-Host "Pega esa URL en la interfaz (Pruebas > Cámara > fuente laptop)."
  } else {
    Write-Host "No responde. Revisa el log: $LogFile" -ForegroundColor Red
    Get-Content "$LogFile.err" -ErrorAction SilentlyContinue | Select-Object -Last 5
  }
}

function Stop-Camera {
  $id = Get-ServerPid
  if ($id) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Transmisor detenido (PID $id)."
  } else {
    # Fallback: buscar por nombre de script
    $found = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*laptop_camera_server*' }
    if ($found) {
      Stop-Process -Id $found.ProcessId -Force
      Write-Host "Transmisor detenido (PID $($found.ProcessId))."
    } else {
      Write-Host "No hay transmisor corriendo."
    }
  }
}

function Show-Status {
  if (Test-Server) {
    $id = Get-ServerPid
    Write-Host "Transmitiendo (PID $id) -> http://127.0.0.1:5002/video" -ForegroundColor Green
  } else {
    Write-Host "Apagado." -ForegroundColor Yellow
  }
}

switch ($args[0]) {
  "iniciar" { Start-Camera }
  "apagar"  { Stop-Camera }
  "estado"  { Show-Status }
  default {
    Write-Host "Uso: .\camara-laptop.ps1 [iniciar|apagar|estado]"
  }
}
