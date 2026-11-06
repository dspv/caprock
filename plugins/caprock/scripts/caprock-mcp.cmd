@echo off
rem Starts `caprock mcp` for the Caprock plugin on Windows.
rem
rem The desktop app puts no caprock.exe on PATH, so after PATH this tries the
rem places Caprock is installed: the app's own copy in its data directory,
rem then Scoop, WinGet and Go's bin. Nothing is downloaded and nothing is
rem sent; when no caprock.exe is found it says where to get one, on stderr,
rem and exits 1. On macOS and Linux, caprock-mcp does the same.
setlocal
set "CAPROCK_EXE="
for %%I in (caprock.exe) do set "CAPROCK_EXE=%%~$PATH:I"
if not defined CAPROCK_EXE if defined CAPROCK_DATA_DIR if exist "%CAPROCK_DATA_DIR%\bin\caprock.exe" set "CAPROCK_EXE=%CAPROCK_DATA_DIR%\bin\caprock.exe"
if not defined CAPROCK_EXE if exist "%APPDATA%\caprock\bin\caprock.exe" set "CAPROCK_EXE=%APPDATA%\caprock\bin\caprock.exe"
if not defined CAPROCK_EXE if defined SCOOP if exist "%SCOOP%\shims\caprock.exe" set "CAPROCK_EXE=%SCOOP%\shims\caprock.exe"
if not defined CAPROCK_EXE if exist "%USERPROFILE%\scoop\shims\caprock.exe" set "CAPROCK_EXE=%USERPROFILE%\scoop\shims\caprock.exe"
if not defined CAPROCK_EXE if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\caprock.exe" set "CAPROCK_EXE=%LOCALAPPDATA%\Microsoft\WinGet\Links\caprock.exe"
if not defined CAPROCK_EXE if defined GOBIN if exist "%GOBIN%\caprock.exe" set "CAPROCK_EXE=%GOBIN%\caprock.exe"
if not defined CAPROCK_EXE if exist "%USERPROFILE%\go\bin\caprock.exe" set "CAPROCK_EXE=%USERPROFILE%\go\bin\caprock.exe"
if not defined CAPROCK_EXE goto missing
"%CAPROCK_EXE%" mcp %*
exit /b %ERRORLEVEL%

:missing
>&2 echo caprock: Caprock is not installed on this computer (or not where the plugin looks).
>&2 echo Install it from https://caprock.dev/install and open it once, then restart Claude Code.
>&2 echo Installed somewhere else? Add the server by hand with the full path: https://github.com/dspv/caprock/blob/master/docs/mcp.md
exit /b 1
