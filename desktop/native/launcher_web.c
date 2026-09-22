/* Pure native launcher — no Node.js, no bundled server, no downloads.
 * The app stays a web app (running wherever it already runs: Render,
 * a PC on the LAN via `npm start`, etc.) — this .exe is just a shortcut
 * that opens one panel of it in the browser.
 *
 * The server's address comes from a "davrbank-server.txt" file kept next
 * to the .exe (created with a localhost default on first run) — edit it
 * once per PC to point at wherever the server actually is.
 *
 * TARGET_PATH (e.g. "/staff") and, for the TV, KIOSK are set at compile
 * time — see build-windows.sh.
 */
#include <windows.h>
#include <shellapi.h>
#include <string.h>
#include <stdio.h>

#ifndef TARGET_PATH
#define TARGET_PATH "/staff"
#endif

#define CONFIG_NAME "davrbank-server.txt"
#define DEFAULT_SERVER "http://localhost:4123"

static void exeDir(char *out, size_t outSize) {
    GetModuleFileNameA(NULL, out, (DWORD)outSize);
    char *lastSlash = strrchr(out, '\\');
    if (lastSlash) *lastSlash = '\0';
}

/* Reads the first line of the config file next to the exe; creates it
 * with the default (plus an explanatory comment) if it doesn't exist. */
static void readServerUrl(char *out, size_t outSize) {
    char dir[MAX_PATH];
    exeDir(dir, sizeof(dir));

    char configPath[MAX_PATH];
    snprintf(configPath, sizeof(configPath), "%s\\%s", dir, CONFIG_NAME);

    FILE *f = fopen(configPath, "r");
    if (f) {
        if (fgets(out, (int)outSize, f)) {
            size_t len = strlen(out);
            while (len > 0 && (out[len - 1] == '\r' || out[len - 1] == '\n' ||
                                out[len - 1] == ' ')) {
                out[--len] = '\0';
            }
            while (len > 0 && out[len - 1] == '/') out[--len] = '\0';
            fclose(f);
            if (len > 0) return;
        } else {
            fclose(f);
        }
    }

    FILE *w = fopen(configPath, "w");
    if (w) {
        fprintf(w, "%s\r\n\r\n", DEFAULT_SERVER);
        fprintf(w, "# Davr Bank navbat tizimi qaysi manzilda ishlayotgan boʻlsa,\r\n");
        fprintf(w, "# shu yerga yozing (masalan: https://sizning-manzil.onrender.com\r\n");
        fprintf(w, "# yoki http://192.168.1.10:4123).\r\n");
        fprintf(w, "# Birinchi qatordan boshqa hammasi izoh, oʻqilmaydi.\r\n");
        fclose(w);
    }
    snprintf(out, outSize, "%s", DEFAULT_SERVER);
}

static BOOL tryKiosk(const char *browser, const char *url) {
    char cmdLine[2048];
    snprintf(cmdLine, sizeof(cmdLine),
             "\"%s\" --kiosk \"%s\" --edge-kiosk-type=fullscreen --no-first-run",
             browser, url);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (CreateProcessA(NULL, cmdLine, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return TRUE;
    }
    return FALSE;
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmdLine, int nShow) {
    char server[1024];
    readServerUrl(server, sizeof(server));

    char url[1200];
    snprintf(url, sizeof(url), "%s%s", server, TARGET_PATH);

#ifdef KIOSK
    /* Try common browser install paths in kiosk (fullscreen, chrome-less)
     * mode first — this is what an unattended TV should run. Fall back to
     * the default browser in a normal window if neither is found. */
    const char *candidates[] = {
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    };
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
        if (tryKiosk(candidates[i], url)) return 0;
    }
#endif

    ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
    return 0;
}
