@echo off
cd /d "%~dp0"
if exist runtime\node\node.exe (runtime\node\node.exe server.js %*) else (node server.js %*)
