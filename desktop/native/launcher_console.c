/* Server.exe — runs server.js as a child with inherited console (so logs
 * are visible, matching start.bat's behavior) and waits for it to exit. */
#include <windows.h>
#include <string.h>
#include <stdio.h>

int main(void) {
    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    char *lastSlash = strrchr(exePath, '\\');
    if (lastSlash) *lastSlash = '\0';

    char nodePath[MAX_PATH];
    snprintf(nodePath, sizeof(nodePath), "%s\\node.exe", exePath);
    char scriptPath[MAX_PATH];
    snprintf(scriptPath, sizeof(scriptPath), "%s\\server.js", exePath);

    char cmdLine[2048];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\" \"%s\"", nodePath, scriptPath);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    printf("Davr Bank navbat tizimi serveri ishga tushmoqda...\n\n");
    fflush(stdout);

    BOOL ok = CreateProcessA(NULL, cmdLine, NULL, NULL, TRUE, 0, NULL, exePath,
                              &si, &pi);
    if (!ok) {
        printf("XATOLIK: node.exe yoki server.js topilmadi.\n");
        printf("Chiqish uchun istalgan tugmani bosing...\n");
        getchar();
        return 1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    printf("\nServer to'xtadi. Chiqish uchun istalgan tugmani bosing...\n");
    getchar();
    return 0;
}
