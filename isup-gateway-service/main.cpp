#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <csignal>
#include <string>
#include <thread>
#include <mutex>
#include <curl/curl.h>

#include "HCISUPCMS.h"
#include "HCISUPAlarm.h"
#include "httplib.h"

static volatile sig_atomic_t g_running = 1;
static std::string g_isupKey = "ekhoneit1234";

// Active device mapping: Serial -> UserID
static std::mutex g_deviceMutex;
static LONG g_activeUserId = -1;
static std::string g_activeDeviceSerial = "";

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
    std::string primaryUrl = targetUrl ? targetUrl : "http://smart-hrm-software-server-th3fjn:7000/api/devices/webhook/push-log";
    std::string fallbackUrl = "https://secure-api.creativeboxbd.com/api/devices/webhook/push-log";

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, primaryUrl.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonPayload);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 3L);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK && primaryUrl != fallbackUrl) {
        printf("[ISUP Gateway] Primary webhook failed (%s). Retrying via public domain: %s\n", curl_easy_strerror(res), fallbackUrl.c_str());
        curl_easy_setopt(curl, CURLOPT_URL, fallbackUrl.c_str());
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
        res = curl_easy_perform(curl);
    }

    if (res == CURLE_OK) {
        printf("[ISUP Gateway] ✓ Forwarded punch to HRMS: Employee %s\n", employeeId);
    } else {
        printf("[ISUP Gateway] ⚠️ Failed forwarding punch to HRMS: %s\n", curl_easy_strerror(res));
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
}

// Device Registration & SessionKey Callback (CMS)
BOOL CALLBACK DeviceRegisterCB(LONG iUserID, DWORD dwDataType, void *pOutBuffer, DWORD dwOutLen, void *pInBuffer, DWORD dwInLen, void *pUser) {
    // dwDataType == ENUM_DEV_ON (0): Device successfully online
    if (dwDataType == ENUM_DEV_ON && pOutBuffer) {
        NET_EHOME_DEV_REG_INFO_V12 *pDevInfo = (NET_EHOME_DEV_REG_INFO_V12 *)pOutBuffer;
        char serial[128] = {0};
        strncpy(serial, (char*)pDevInfo->struRegInfo.sDeviceSerial, sizeof(serial) - 1);

        {
            std::lock_guard<std::mutex> lock(g_deviceMutex);
            g_activeUserId = iUserID;
            g_activeDeviceSerial = serial;
        }

        printf("\n======================================================\n");
        printf("🚀 [HIKVISION ISUP 5.0] DEVICE ONLINE SUCCESS!\n");
        printf("User ID: %ld\n", (long)iUserID);
        printf("Device ID: %s\n", (char*)pDevInfo->struRegInfo.byDeviceID);
        printf("Device Serial: %s\n", serial);
        printf("======================================================\n\n");
        fflush(stdout);

        if (pInBuffer != NULL && dwInLen >= sizeof(NET_EHOME_SERVER_INFO_V50)) {
            NET_EHOME_SERVER_INFO_V50 *pServerInfo = (NET_EHOME_SERVER_INFO_V50 *)pInBuffer;
            pServerInfo->dwKeepAliveSec = 15;
            pServerInfo->dwTimeOutCount = 6;
        }
    }
    // dwDataType == ENUM_DEV_AUTH (3): Device Auth Request
    else if (dwDataType == ENUM_DEV_AUTH) {
        if (pInBuffer != NULL && dwInLen > 0) {
            memset(pInBuffer, 0, dwInLen);
            strncpy((char*)pInBuffer, g_isupKey.c_str(), dwInLen - 1);
            printf("[ISUP SDK] 🔑 ENUM_DEV_AUTH Handled! Provided key '%s'\n", g_isupKey.c_str());
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
            printf("[ISUP SDK] ✓ Successfully set CMS SessionKey for Device %s\n", devSessionkey.sDeviceID);
            fflush(stdout);
        }
        if (NET_EALARM_SetDeviceSessionKey(&devSessionkey)) {
            printf("[ISUP SDK] ✓ Successfully set ALARM SessionKey for Device %s\n", devSessionkey.sDeviceID);
            fflush(stdout);
        }
    }
    // dwDataType == ENUM_DEV_DAS_REQ (5): Full Official DAS Info Format
    else if (dwDataType == ENUM_DEV_DAS_REQ) {
        if (pInBuffer != NULL && dwInLen > 0) {
            memset(pInBuffer, 0, dwInLen);
            snprintf((char*)pInBuffer, dwInLen, 
                "{\"Type\":\"DAS\",\"DasInfo\":{\"Address\":\"2.24.171.175\",\"Domain\":\"secure-api.creativeboxbd.com\",\"ServerID\":\"das_2.24.171.175_7660\",\"Port\":7660,\"UdpPort\":7660}}");
            printf("[ISUP SDK] 📍 ENUM_DEV_DAS_REQ Handled! Sent full DAS spec to device.\n");
            fflush(stdout);
        }
    }
    // dwDataType == ENUM_DEV_OFF (1)
    else if (dwDataType == ENUM_DEV_OFF) {
        printf("[ISUP SDK] ⚠️ Device Disconnected / Offline. UserID: %ld\n", (long)iUserID);
        fflush(stdout);
        {
            std::lock_guard<std::mutex> lock(g_deviceMutex);
            if (g_activeUserId == iUserID) {
                g_activeUserId = -1;
            }
        }
    }

    return TRUE;
}

// Alarm / Event Message Callback (Real-time Punches & Access Events)
BOOL CALLBACK AlarmMsgCallBack(LONG iHandle, NET_EHOME_ALARM_MSG *pAlarmMsg, void *pUser) {
    if (!pAlarmMsg) return TRUE;

    printf("[ISUP Alarm Event] Type: %u, Serial: %s\n", 
           (unsigned int)pAlarmMsg->dwAlarmType, 
           pAlarmMsg->sSerialNumber ? pAlarmMsg->sSerialNumber : "UNKNOWN");
    fflush(stdout);

    // EHOME_ISAPI_ALARM (13) or EHOME_ALARM (1) or XML Payload
    std::string xmlOrJson = "";
    if (pAlarmMsg->pXmlBuf && pAlarmMsg->dwXmlBufLen > 0) {
        xmlOrJson = std::string((char*)pAlarmMsg->pXmlBuf, pAlarmMsg->dwXmlBufLen);
    } else if (pAlarmMsg->dwAlarmType == 13 && pAlarmMsg->pAlarmInfo) {
        NET_EHOME_ALARM_ISAPI_INFO *pIsapi = (NET_EHOME_ALARM_ISAPI_INFO *)pAlarmMsg->pAlarmInfo;
        if (pIsapi->pAlarmData && pIsapi->dwAlarmDataLen > 0) {
            xmlOrJson = std::string(pIsapi->pAlarmData, pIsapi->dwAlarmDataLen);
        }
    }

    if (!xmlOrJson.empty()) {
        printf("[ISUP Event Payload]: %s\n", xmlOrJson.substr(0, 300).c_str());
        fflush(stdout);

        // Extract employeeNo / employeeId
        std::string empId = "";
        std::string eventTime = "";

        // Simple JSON / XML extraction
        size_t empPos = xmlOrJson.find("\"employeeNoString\":\"");
        if (empPos != std::string::npos) {
            size_t start = empPos + 20;
            size_t end = xmlOrJson.find("\"", start);
            if (end != std::string::npos) empId = xmlOrJson.substr(start, end - start);
        } else {
            empPos = xmlOrJson.find("<employeeNoString>");
            if (empPos != std::string::npos) {
                size_t start = empPos + 18;
                size_t end = xmlOrJson.find("</employeeNoString>", start);
                if (end != std::string::npos) empId = xmlOrJson.substr(start, end - start);
            }
        }

        size_t timePos = xmlOrJson.find("\"time\":\"");
        if (timePos != std::string::npos) {
            size_t start = timePos + 8;
            size_t end = xmlOrJson.find("\"", start);
            if (end != std::string::npos) eventTime = xmlOrJson.substr(start, end - start);
        } else {
            timePos = xmlOrJson.find("<dateTime>");
            if (timePos != std::string::npos) {
                size_t start = timePos + 10;
                size_t end = xmlOrJson.find("</dateTime>", start);
                if (end != std::string::npos) eventTime = xmlOrJson.substr(start, end - start);
            }
        }

        if (!empId.empty()) {
            forward_to_hrms(pAlarmMsg->sSerialNumber, empId.c_str(), eventTime.c_str());
        }
    }

    return TRUE;
}

// Pass-through ISAPI Command to device
std::string execute_isapi(LONG userId, const std::string& method, const std::string& url, const std::string& body) {
    if (userId < 0) {
        printf("[ISUP ISAPI] ⚠️ Rejected command: Device offline (userId < 0)\n");
        fflush(stdout);
        return "{\"error\":\"Device offline or not registered\"}";
    }

    // Clean URL: Strip any leading HTTP method if present
    std::string cleanUrl = url;
    if (cleanUrl.rfind("POST ", 0) == 0) cleanUrl = cleanUrl.substr(5);
    else if (cleanUrl.rfind("GET ", 0) == 0) cleanUrl = cleanUrl.substr(4);
    else if (cleanUrl.rfind("PUT ", 0) == 0) cleanUrl = cleanUrl.substr(4);
    else if (cleanUrl.rfind("DELETE ", 0) == 0) cleanUrl = cleanUrl.substr(7);

    NET_EHOME_PTXML_PARAM ptParam;
    memset(&ptParam, 0, sizeof(ptParam));

    ptParam.pRequestUrl = (void*)cleanUrl.c_str();
    ptParam.dwRequestUrlLen = cleanUrl.length();

    const DWORD OUT_BUF_SIZE = 1024 * 1024; // 1MB buffer
    char *outBuffer = (char*)malloc(OUT_BUF_SIZE);
    if (!outBuffer) return "{\"error\":\"Out of memory\"}";
    memset(outBuffer, 0, OUT_BUF_SIZE);

    ptParam.pOutBuffer = outBuffer;
    ptParam.dwOutSize = OUT_BUF_SIZE;
    ptParam.dwRecvTimeOut = 8000;

    printf("[ISUP ISAPI] 📡 Sending %s %s (body len: %zu) to UserID %ld...\n",
           method.c_str(), cleanUrl.c_str(), body.length(), (long)userId);
    fflush(stdout);

    BOOL ret = FALSE;
    if (method == "PUT") {
        if (!body.empty()) {
            ptParam.pInBuffer = (void*)body.c_str();
            ptParam.dwInSize = body.length();
        }
        ret = NET_ECMS_PutPTXMLConfig(userId, &ptParam);
    } else if (method == "POST") {
        // Attempt 1: body as input parameter (pInBuffer)
        if (!body.empty()) {
            ptParam.pInBuffer = (void*)body.c_str();
            ptParam.dwInSize = body.length();
        }
        ret = NET_ECMS_PostPTXMLConfig(userId, &ptParam);

        // Attempt 2: if error 17 (parameter error), retry with pCondBuffer
        if (!ret && NET_ECMS_GetLastError() == 17 && !body.empty()) {
            printf("[ISUP ISAPI] Retrying POST with pCondBuffer...\n");
            ptParam.pInBuffer = NULL;
            ptParam.dwInSize = 0;
            ptParam.pCondBuffer = (void*)body.c_str();
            ptParam.dwCondSize = body.length();
            ret = NET_ECMS_PostPTXMLConfig(userId, &ptParam);
        }

        // Attempt 3: General ISAPI PassThrough
        if (!ret) {
            ptParam.pInBuffer = (void*)body.c_str();
            ptParam.dwInSize = body.length();
            ptParam.pCondBuffer = NULL;
            ptParam.dwCondSize = 0;
            ret = NET_ECMS_ISAPIPassThrough(userId, &ptParam);
        }
    } else if (method == "DELETE") {
        ret = NET_ECMS_DeletePTXMLConfig(userId, &ptParam);
    } else {
        // GET
        if (!body.empty()) {
            ptParam.pCondBuffer = (void*)body.c_str();
            ptParam.dwCondSize = body.length();
        }
        ret = NET_ECMS_GetPTXMLConfig(userId, &ptParam);
        if (!ret) {
            ret = NET_ECMS_ISAPIPassThrough(userId, &ptParam);
        }
    }

    std::string responseStr = "";
    if (ret && ptParam.dwReturnedXMLLen > 0) {
        responseStr = std::string(outBuffer, ptParam.dwReturnedXMLLen);
        printf("[ISUP ISAPI] ✓ Command succeeded. ReturnedLen: %u bytes\n", (unsigned int)ptParam.dwReturnedXMLLen);
    } else if (ret && strlen(outBuffer) > 0) {
        responseStr = std::string(outBuffer);
        printf("[ISUP ISAPI] ✓ Command succeeded. Response: %s\n", responseStr.substr(0, 150).c_str());
    } else {
        DWORD err = NET_ECMS_GetLastError();
        printf("[ISUP ISAPI] ❌ Command failed. Error code: %u\n", (unsigned int)err);
        char errBuf[128];
        snprintf(errBuf, sizeof(errBuf), "{\"error\":\"NET_ECMS ISAPI call failed\",\"code\":%u}", (unsigned int)err);
        responseStr = errBuf;
    }
    fflush(stdout);

    free(outBuffer);
    return responseStr;
}

// Internal HTTP Server Thread (Listening on Port 7661 for HRMS-Server commands)
void start_internal_http_api() {
    httplib::Server svr;

    // Check device status
    svr.Get("/status", [](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(g_deviceMutex);
        char buf[256];
        snprintf(buf, sizeof(buf), "{\"online\":%s,\"userId\":%ld,\"deviceSerial\":\"%s\"}",
                 (g_activeUserId >= 0 ? "true" : "false"), (long)g_activeUserId, g_activeDeviceSerial.c_str());
        res.set_content(buf, "application/json");
    });

    // Execute arbitrary ISAPI PassThrough command on device
    svr.Post("/isapi", [](const httplib::Request& req, httplib::Response& res) {
        LONG uid = -1;
        {
            std::lock_guard<std::mutex> lock(g_deviceMutex);
            uid = g_activeUserId;
        }

        std::string method = req.has_param("method") ? req.get_param_value("method") : "GET";
        std::string path = req.has_param("path") ? req.get_param_value("path") : "";
        if (path.empty()) {
            res.status = 400;
            res.set_content("{\"error\":\"path param required\"}", "application/json");
            return;
        }

        std::string resp = execute_isapi(uid, method, path, req.body);
        res.set_content(resp, "application/json");
    });

    printf("✓ ISUP HTTP Control API listening on internal port 7661\n");
    fflush(stdout);
    svr.listen("0.0.0.0", 7661);
}

int main(int argc, char *argv[]) {
    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    const char* envKey = getenv("ISUP_KEY");
    if (envKey && strlen(envKey) > 0) {
        g_isupKey = envKey;
    }

    printf("======================================================\n");
    printf("Starting Complete Hikvision ISUP 5.0 Gateway Server...\n");
    printf("Configured Encryption Key: %s\n", g_isupKey.c_str());
    printf("======================================================\n");
    fflush(stdout);

    // 1. Initialize CMS
    if (!NET_ECMS_Init()) {
        printf("❌ NET_ECMS_Init failed. Error: %d\n", NET_ECMS_GetLastError());
        return 1;
    }
    printf("✓ NET_ECMS_Init succeeded.\n");

    // 2. Initialize ALARM
    if (!NET_EALARM_Init()) {
        printf("⚠️ NET_EALARM_Init failed: %d\n", NET_EALARM_GetLastError());
    } else {
        printf("✓ NET_EALARM_Init succeeded.\n");
    }

    // 3. Start CMS Listener
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
    printf("✓ ISUP CMS Listener active on port 7660.\n");

    // 4. Start ALARM Listener (reusing CMS port 7660)
    NET_EHOME_ALARM_LISTEN_PARAM struAlarmListen;
    memset(&struAlarmListen, 0, sizeof(struAlarmListen));
    strcpy(struAlarmListen.struAddress.szIP, "127.0.0.1");
    struAlarmListen.struAddress.wPort = 7660;
    struAlarmListen.byUseCmsPort = 1;
    struAlarmListen.fnMsgCb = AlarmMsgCallBack;

    LONG lAlarmHandle = NET_EALARM_StartListen(&struAlarmListen);
    if (lAlarmHandle < 0) {
        printf("⚠️ NET_EALARM_StartListen on CMS port failed: %d. Trying standalone port 7662...\n", NET_EALARM_GetLastError());
        struAlarmListen.byUseCmsPort = 0;
        strcpy(struAlarmListen.struAddress.szIP, "0.0.0.0");
        struAlarmListen.struAddress.wPort = 7662;
        lAlarmHandle = NET_EALARM_StartListen(&struAlarmListen);
        if (lAlarmHandle >= 0) {
            printf("✓ Standalone ALARM Listener active on port 7662.\n");
        }
    } else {
        printf("✓ ISUP ALARM Listener active (reusing port 7660) for real-time punches.\n");
    }
    fflush(stdout);

    // 5. Start internal HTTP server on port 7661 for HRMS commands
    std::thread httpThread(start_internal_http_api);
    httpThread.detach();

    while (g_running) {
        sleep(1);
    }

    if (lAlarmHandle >= 0) NET_EALARM_StopListen(lAlarmHandle);
    NET_EALARM_Fini();

    NET_ECMS_StopListen(lHandle);
    NET_ECMS_Fini();
    return 0;
}
