@echo off
rem Liga a ponte do Controle numa janela minimizada.
rem Para subir sozinho com o Windows: Win+R, digite shell:startup, Enter,
rem e coloque nessa pasta um atalho para este arquivo.
cd /d "%~dp0.."
start "Controle" /min node src\server.mjs
