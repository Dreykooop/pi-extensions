package main

import (
 "encoding/base64"
 "encoding/json"
 "os"
 "testing"
 "time"
 "fmt"
)

func TestReadOnlyAuthorization(t *testing.T) {
 d:=t.TempDir();t.Setenv("CPA_QUOTA_DIR",d)
 os.WriteFile(d+"/client-key",[]byte("dummy-client"),0600)
 snapshot:=[]byte(fmt.Sprintf(`{"schema":"cpa.quota/v1","generatedAt":%d,"accounts":[]}`,time.Now().UnixMilli()))
 os.WriteFile(d+"/snapshot.json",snapshot,0600)
 for _, c:=range []struct{method,token string; status int}{
  {"GET","",401},{"GET","Bearer wrong",401},{"POST","Bearer dummy-client",405},{"GET","Bearer dummy-client",200},
 } {
  raw,_:=json.Marshal(map[string]any{"Method":c.method,"Path":"/snapshot","Headers":map[string][]string{"Authorization":{c.token}}})
  got:=handle("management.handle",raw).(map[string]any)
  if got["StatusCode"]!=c.status {t.Fatalf("status %v want %v",got["StatusCode"],c.status)}
  if c.status==200 {body,_:=base64.StdEncoding.DecodeString(got["Body"].(string));if string(body)!=string(snapshot){t.Fatal("snapshot changed")}}
 }
 os.WriteFile(d+"/snapshot.json",[]byte(`{"generatedAt":1}`),0600)
 staleRaw:=[]byte(`{"Method":"GET","Path":"/snapshot","Headers":{"Authorization":["Bearer dummy-client"]}}`)
 if handle("management.handle",staleRaw).(map[string]any)["StatusCode"]!=503{t.Fatal("stale snapshot must be refused")}
 os.Remove(d+"/client-key")
 raw:=[]byte(`{"Method":"GET","Path":"/snapshot","Headers":{"Authorization":["Bearer dummy-client"]}}`)
 if handle("management.handle",raw).(map[string]any)["StatusCode"]!=401{t.Fatal("missing key must fail closed")}
}
