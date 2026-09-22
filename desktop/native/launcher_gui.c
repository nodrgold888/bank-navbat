/* Tiny native launcher: finds node.exe next to itself and runs the given
 * desktop/*.js script hidden (no console flash), then exits immediately.
 * TARGET_SCRIPT is set at compile time per exe (see build script). */
#include <windows.h>
#include <string.h>
#include <stdio.h>

#ifndef TARGET_SCRIPT
#define TARGET_SCRIPT "desktop\\staff.js"
#endif

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmdLine, int nShow) {
    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    char *lastSlash = strrchr(exePath, '\\');
    if (lastSlash) *lastSlash = '\0';

    char nodePath[MAX_PATH];
    snprintf(nodePath, sizeof(nodePath), "%s\\node.exe", exePath);
    char scriptPath[MAX_PATH];
    snprintf(scriptPath, sizeof(scriptPath), "%s\\%s", exePath, TARGET_SCRIPT);

    char cmdLine[2048];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\" \"%s\"", nodePath, scriptPath);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    BOOL ok = CreateProcessA(NULL, cmdLine, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                              NULL, exePath, &si, &pi);
    if (ok) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    } else {
        MessageBoxA(
            NULL,
            "node.exe topilmadi yoki ishga tushmadi.\n"
            "DavrBank papkasi to'liq nusxalanganiga ishonch hosil qiling.",
            "Xatolik", MB_ICONERROR);
    }
    return 0;
}
