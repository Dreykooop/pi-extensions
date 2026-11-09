package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);

static const cliproxy_host_api* stored_host;

static void store_host_api(const cliproxy_host_api* host) {
	stored_host = host;
}
*/
import "C"

import (
 "encoding/base64"
 "encoding/json"
 "crypto/subtle"
 "os"
 "strings"
 "unsafe"
 "time"
)

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
 if plugin == nil { return 1 }
 plugin.abi_version = 1
 plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
 plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
 plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
 return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, length C.size_t) { if ptr != nil { C.free(ptr) } }

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, size C.size_t, response *C.cliproxy_buffer) (rc C.int) {
 if response == nil { return 1 }
 response.ptr = nil; response.len = 0
 defer func() { if recover() != nil { rc = 1 } }()
 if method == nil || size > 1048576 { return 1 }
 result := handle(C.GoString(method), C.GoBytes(unsafe.Pointer(request), C.int(size)))
 raw, err := json.Marshal(map[string]any{"ok":true,"result":result})
 if err != nil { return 1 }
 response.ptr = C.CBytes(raw); response.len = C.size_t(len(raw))
 return 0
}

func handle(method string, raw []byte) any {
 switch method {
 case "plugin.register", "plugin.reconfigure":
  return map[string]any{"schema_version":6,"metadata":map[string]any{
   "Name":"account-quota","Version":"0.1.0","Description":"Authenticated read-only quota snapshot"},
   "capabilities":map[string]any{"management_api":true}}
 case "management.register":
  return map[string]any{"resources":[]any{map[string]any{"Path":"/snapshot","Menu":"","Description":"Quota snapshot"}},"routes":[]any{}}
 case "management.handle":
  var req struct { Method string; Path string; Headers map[string][]string; Query map[string][]string; Body []byte }
  if json.Unmarshal(raw, &req) != nil { return reply(400, []byte(`{"error":"invalid_request"}`)) }
  if req.Method != "GET" || !strings.HasSuffix(req.Path,"/snapshot") || len(req.Query) != 0 || len(req.Body) != 0 {
   return reply(405, []byte(`{"error":"read_only"}`))
  }
  directory := os.Getenv("CPA_QUOTA_DIR")
  if directory == "" { directory = "/CLIProxyAPI/plugins/quota-data" }
  key, err := os.ReadFile(directory+"/client-key")
  expected := strings.TrimSpace(string(key))
  var supplied string
  for k, v := range req.Headers { if strings.EqualFold(k,"Authorization") && len(v)==1 { supplied=v[0] } }
  if err != nil || expected == "" || subtle.ConstantTimeCompare([]byte(supplied),[]byte("Bearer "+expected)) != 1 {
   return reply(401, []byte(`{"error":"unauthorized"}`))
  }
  snapshot, err := os.ReadFile(directory+"/snapshot.json")
  if err != nil || len(snapshot)>1048576 || !json.Valid(snapshot) { return reply(503, []byte(`{"error":"snapshot_unavailable"}`)) }
  var cached struct { GeneratedAt int64 `json:"generatedAt"` }
  if json.Unmarshal(snapshot, &cached) != nil || time.Now().UnixMilli()-cached.GeneratedAt>600000 || cached.GeneratedAt>time.Now().UnixMilli()+60000 {
   return reply(503, []byte(`{"error":"snapshot_stale"}`))
  }
  return reply(200, snapshot)
 }
 return map[string]any{}
}

func reply(status int, body []byte) any {
 return map[string]any{"StatusCode":status,"Headers":map[string][]string{
  "Content-Type":{"application/json"},"Cache-Control":{"no-store"},"X-Content-Type-Options":{"nosniff"}},
  "Body":base64.StdEncoding.EncodeToString(body)}
}

func main() {}
