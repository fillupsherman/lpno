@echo off
rem Enable destructive deletion for Meetup-deleted events during scheduled runs
set "DELETE_ON_MEETUP=1"
rem Run visible (non-headless) so the browser window is shown during the scheduled run
set "HEADLESS=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\LPNO\fb-sync\run-sync.ps1"