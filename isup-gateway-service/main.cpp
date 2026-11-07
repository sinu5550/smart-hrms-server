#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <csignal>
#include <string>
#include <curl/curl.h>

#include "HCISUPCMS.h"
#include "HCISUPAlarm.h"

static volatile sig_atomic_t g_running = 1;
static std::string g_isupKey = "12345678"; // Default fallback key if none provided

void sig_handler(int sig) {
    g_running = 0;
}

// Forward to HRMS Webhook
void forward_to_hrms(const char* deviceId, const char* employeeId, const char* eventTime) {
    CURL *curl = curl_easy_init();
    if (!curl) return;

    char jsonPayload[512];
    snprintf(jsonPayload, sizeof(jsonPayload),
        "{\"deviceSerialNumber\":\"%s\",\"employeeId\":\"%s\",\"punchTime\":\"%s\",\"verificationMode\":\"HIKVISION_ISUP\"}",
        deviceId ? deviceId : "GS6443083",
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
    if (res == CURLE_OK) {
        printf("[ISUP Gateway] ✓ Forwarded punch to HRMS: %s\n", employeeId);
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
}

// Device Registration & SessionKey Callback
BOOL CALLBACK DeviceRegisterCB(LONG iUserID, DWORD dwDataType, void *pOutBuffer, DWORD dwOutLen, void *pInBuffer, DWORD dwInLen, void *pUser) {
    printf("[ISUP SDK Callback] UserID: %ld, DataType: %u (ENUM_DEV_%s)\n", 
        (long)iUserID, 
        (unsigned int)dwDataType,
        (dwDataType == 0 ? "ON" : (dwDataType == 3 ? "AUTH" : (dwDataType == 4 ? "SESSIONKEY" : "OTHER"))));
    fflush(stdout);

    // dwDataType == ENUM_DEV_ON (0): Device successfully online
    if (dwDataType == ENUM_DEV_ON && pOutBuffer) {
        NET_EHOME_DEV_REG_INFO_V12 *pDevInfo = (NET_EHOME_DEV_REG_INFO_V12 *)pOutBuffer;
        printf("\n======================================================\n");
        printf("🚀 [HIKVISION ISUP 5.0] DEVICE ONLINE SUCCESS!\n");
        printf("Device ID: %s\n", (char*)pDevInfo->struRegInfo.byDeviceID);
        printf("Device Serial: %s\n", (char*)pDevInfo->struRegInfo.sDeviceSerial);
        printf("Firmware: %s\n", (char*)pDevInfo->struRegInfo.byFirmwareVersion);
        printf("======================================================\n\n");
        fflush(stdout);

        // Populate server keep-alive config if requested in pInBuffer
        if (pInBuffer != NULL && dwInLen >= sizeof(NET_EHOME_SERVER_INFO_V50)) {
            NET_EHOME_SERVER_INFO_V50 *pServerInfo = (NET_EHOME_SERVER_INFO_V50 *)pInBuffer;
            pServerInfo->dwKeepAliveSec = 15;
            pServerInfo->dwTimeOutCount = 6;
        }
    }
    // dwDataType == ENUM_DEV_AUTH (3): Device Auth Request for ISUP 5.0!
    // The device sends its registration request and expects the server to provide the shared Encryption Key in pInBuffer
    else if (dwDataType == ENUM_DEV_AUTH) {
        if (pInBuffer != NULL && dwInLen > 0) {
            memset(pInBuffer, 0, dwInLen);
            strncpy((char*)pInBuffer, g_isupKey.c_str(), dwInLen - 1);
            printf("[ISUP SDK] 🔑 ENUM_DEV_AUTH Handled! Provided key '%s' to device.\n", g_isupKey.c_str());
            fflush(stdout);
        }
    }
    // dwDataType == ENUM_DEV_SESSIONKEY (4): Session Key Exchange
    else if (dwDataType == ENUM_DEV_SESSIONKEY && pOutBuffer) {
        NET_EHOME_DEV_REG_INFO_V12 *pDevInfo = (NET_EHOME_DEV_REG_INFO_V12 *)pOutBuffer;
        NET_EHOME_DEV_SESSIONKEY devSessionkey;
        memset(&devSessionkey, 0, sizeof(devSessionkey));

        memcpy(devSessionkey.sDeviceID, pDevInfo->struRegInfo.byDeviceID, sizeof(devSessionkey.sDeviceID));
        memcpy(devSessionkey.sSessionKey, pDevInfo->struRegInfo.bySessionKey, sizeof(devSessionkey.sSessionKey));

        if (NET_ECMS_SetDeviceSessionKey(&devSessionkey)) {
            printf("[ISUP SDK] ✓ Successfully set SessionKey for ISUP 5.0 Device %s\n", devSessionkey.sDeviceID);
            fflush(stdout);
        } else {
            printf("[ISUP SDK] ❌ NET_ECMS_SetDeviceSessionKey failed: %d\n", NET_ECMS_GetLastError());
            fflush(stdout);
        }
    }
    // dwDataType == ENUM_DEV_OFF (1)
    else if (dwDataType == ENUM_DEV_OFF) {
        printf("[ISUP SDK] ⚠️ Device Disconnected / Offline. UserID: %ld\n", (long)iUserID);
        fflush(stdout);
    }

    return TRUE;
}

int main(int argc, char *argv[]) {
    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    const char* envKey = getenv("ISUP_KEY");
    if (envKey && strlen(envKey) > 0) {
        g_isupKey = envKey;
    }

    printf("======================================================\n");
    printf("Starting Official Hikvision ISUP 5.0 Linux Gateway...\n");
    printf("Configured Encryption Key: %s\n", g_isupKey.c_str());
    printf("======================================================\n");
    fflush(stdout);

    if (!NET_ECMS_Init()) {
        printf("❌ NET_ECMS_Init failed. Error: %d\n", NET_ECMS_GetLastError());
        return 1;
    }
    printf("✓ NET_ECMS_Init succeeded.\n");

    NET_EHOME_CMS_LISTEN_PARAM struListen;
    memset(&struListen, 0, sizeof(struListen));
    strcpy(struListen.struAddress.szIP, "0.0.0.0");
    struListen.struAddress.wPort = 7660;
    struListen.fnCB = DeviceRegisterCB;

    LONG lHandle = NET_ECMS_StartListen(&struListen);
    if (lHandle < 0) {
        printf("❌ NET_ECMS_StartListen on 7660 failed. Error: %d\n", NET_ECMS_GetLastError());
        NET_ECMS_Fini();
        return 1;
    }

    printf("✓ ISUP CMS Listener active on port 7660. Listening for devices...\n");
    fflush(stdout);

    while (g_running) {
        sleep(1);
    }

    NET_ECMS_StopListen(lHandle);
    NET_ECMS_Fini();
    return 0;
}
