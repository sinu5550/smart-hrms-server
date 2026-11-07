#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <curl/curl.h>

#include "HCISUPCMS.h"
#include "HCISUPAlarm.h"

static int g_running = 1;

void sig_handler(int sig) {
    g_running = 0;
}

// Forward raw event to HRMS Webhook
void forward_to_hrms(const char* deviceId, const char* employeeId, const char* eventTime) {
    CURL *curl = curl_easy_init();
    if (!curl) return;

    char jsonPayload[512];
    snprintf(jsonPayload, sizeof(jsonPayload),
        "{\"deviceSerialNumber\":\"%s\",\"employeeId\":\"%s\",\"punchTime\":\"%s\",\"verificationMode\":\"HIKVISION_ISUP\"}",
        deviceId ? deviceId : "UNKNOWN",
        employeeId ? employeeId : "",
        eventTime ? eventTime : "");

    const char* targetUrl = getenv("TARGET_WEBHOOK");
    if (!targetUrl) {
        targetUrl = "http://smart-hrm-software-server-th3fjn:7000/api/devices/webhook/push-log";
    }

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, targetUrl);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonPayload);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        printf("[ISUP Gateway] Failed to post to HRMS: %s\n", curl_easy_strerror(res));
    } else {
        printf("[ISUP Gateway] ✓ Successfully forwarded punch for %s to HRMS webhook\n", employeeId);
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
}

// Device Registration Callback
BOOL CALLBACK DeviceRegisterCB(LONG iUserID, DWORD dwDataType, void *pOutBuffer, DWORD dwOutLen, void *pInBuffer, DWORD dwInLen, void *pUser) {
    if (dwDataType == 1) { // ENUM_DEV_ON / Registration
        NET_EHOME_DEV_REG_INFO_V12 *pDevInfo = (NET_EHOME_DEV_REG_INFO_V12 *)pOutBuffer;
        if (pDevInfo) {
            printf("\n======================================================\n");
            printf("🚀 [ISUP 5.0 SDK] DEVICE ONLINE SUCCESS!\n");
            printf("Device ID: %s\n", pDevInfo->struRegInfo.byDeviceID);
            printf("Device Serial: %s\n", pDevInfo->struRegInfo.sDeviceSerial);
            printf("Firmware Version: %s\n", pDevInfo->struRegInfo.byFirmwareVersion);
            printf("======================================================\n\n");
            fflush(stdout);
        }
    }
    return TRUE;
}

int main(int argc, char *argv[]) {
    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    printf("======================================================\n");
    printf("Starting Official Hikvision ISUP 5.0 Gateway Server...\n");
    printf("======================================================\n");

    // Initialize CMS
    if (!NET_ECMS_Init()) {
        printf("❌ NET_ECMS_Init failed. Error: %d\n", NET_ECMS_GetLastError());
        return 1;
    }
    printf("✓ NET_ECMS_Init succeeded.\n");

    // Listen on Port 7660
    NET_EHOME_CMS_LISTEN_PARAM struListen = {0};
    struListen.dwSize = sizeof(struListen);
    strcpy(struListen.struAddress.szIP, "0.0.0.0");
    struListen.struAddress.wPort = 7660;
    struListen.fnCB = DeviceRegisterCB;

    LONG lHandle = NET_ECMS_StartListen(&struListen);
    if (lHandle < 0) {
        printf("❌ NET_ECMS_StartListen on 7660 failed. Error: %d\n", NET_ECMS_GetLastError());
        NET_ECMS_Fini();
        return 1;
    }

    printf("✓ ISUP CMS Listener running on port 7660. Waiting for Hikvision MinMoe...\n");
    fflush(stdout);

    while (g_running) {
        sleep(1);
    }

    printf("Shutting down ISUP Gateway...\n");
    NET_ECMS_StopListen(lHandle);
    NET_ECMS_Fini();
    printf("Goodbye!\n");
    return 0;
}
