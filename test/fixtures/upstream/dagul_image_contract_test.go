package executor
import (
 "context"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "net/http/httptest"
 "testing"
 "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
 cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)
func TestDagulImageContract(t *testing.T) {
 for _, model := range []string{"gpt-image-2.6", "gpt-image-2.6-sunburst", "gpt-image-2.6-flare"} {
  for _, format := range []string{"png", "gif"} {
   t.Run(model+"/"+format, func(t *testing.T){
    size:="1024x1024"; if format=="gif" {size="512x512"}
    input:=map[string]any{"model":model,"prompt":"A glass marble turns in place. Local contract test only.","size":size,"n":1,"output_format":format,"frame_count":9,"frame_duration_ms":200}
    raw,_:=json.Marshal(input)
    var got map[string]any
    server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
     if r.URL.Path!="/images/generations" {t.Errorf("path %s",r.URL.Path)}
     b,_:=io.ReadAll(r.Body); if err:=json.Unmarshal(b,&got);err!=nil {t.Error(err)}
     w.Header().Set("Content-Type","application/json");fmt.Fprint(w,`{"created":1,"data":[{"b64_json":"AA=="}],"usage":{"total_tokens":0}}`)
    }));defer server.Close()
    e:=NewCodexExecutor(&config.Config{})
    _,err:=e.Execute(context.Background(),newCodexOpenAIImageTestAuth(server.URL),cliproxyexecutor.Request{Model:model,Payload:raw},codexOpenAIImageTestOptions(codexImagesGenerationsPath,false))
    if err!=nil {t.Fatal(err)}
    for _,key:=range []string{"model","prompt","size","output_format","frame_count","frame_duration_ms","n"} {if fmt.Sprint(got[key])!=fmt.Sprint(input[key]) {t.Errorf("%s changed: got %v want %v",key,got[key],input[key])}}
   })
  }
 }
}
