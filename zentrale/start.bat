@echo off
cd /d "%~dp0"
set NODE=node
if exist runtime\node\node.exe set NODE=runtime\node\node.exe
if not exist node_modules (echo Erster Start: installiere Pakete ... & call npm install --omit=dev)
%NODE% server.js %*
