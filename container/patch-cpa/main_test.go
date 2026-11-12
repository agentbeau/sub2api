package main

import (
	"embed"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Relevant source excerpts from CPA v8.0.67. These are parsed, never linked.
//
//go:embed testdata/upstream
var upstreamFixture embed.FS

func fixtureTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	err := fs.WalkDir(upstreamFixture, "testdata/upstream", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		body, readErr := upstreamFixture.ReadFile(name)
		if readErr != nil {
			return readErr
		}
		path := filepath.Join(root, strings.TrimPrefix(name, "testdata/upstream/"))
		if mkdirErr := os.MkdirAll(filepath.Dir(path), 0o700); mkdirErr != nil {
			return mkdirErr
		}
		return os.WriteFile(path, body, 0o600)
	})
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func changeFixture(t *testing.T, root, name, old, next string) {
	t.Helper()
	path := filepath.Join(root, name)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), old) {
		t.Fatalf("missing test source %q", old)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(body), old, next, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReviewedAPISurfaceAcceptsNativeRoutes(t *testing.T) {
	if err := validateAPISurface(fixtureTree(t)); err != nil {
		t.Fatal(err)
	}
}

func TestAPISurfaceRejectsRegistrationDrift(t *testing.T) {
	for _, tc := range []struct{ name, old, next string }{
		{"added route", `v1.GET("/models",`, `v1.POST("/embeddings", handler); v1.GET("/models",`},
		{"removed route", `v1.POST("/tts", openaiHandlers.XAITTS)`, ``},
		{"changed method", `v1.POST("/tts",`, `v1.PUT("/tts",`},
		{"changed path", `v1.POST("/tts",`, `v1.POST("/speech",`},
		{"nested group", `v1.GET("/models",`, `sub := v1.Group("/new"); sub.GET("/feature", handler); v1.GET("/models",`},
		{"closure registration", `v1.GET("/models",`, `func() { v1.GET("/future", handler) }(); v1.GET("/models",`},
		{"unknown group prefix", `v1.GET("/models",`, `future := s.engine.Group(configuredPrefix); future.GET("/feature", handler); v1.GET("/models",`},
		{"unknown dynamic path", `v1.GET("/models",`, `v1.GET(dynamicPath, handler); v1.GET("/models",`},
		{"new generic registration", `v1.GET("/models",`, `v1.Any("/future", handler); v1.GET("/models",`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := fixtureTree(t)
			changeFixture(t, root, "internal/api/server_routes.go", tc.old, tc.next)
			if err := validateAPISurface(root); err == nil {
				t.Fatal("accepted changed public API surface")
			}
		})
	}
}

func TestAPISurfaceChecksNewAPIFiles(t *testing.T) {
	root := fixtureTree(t)
	if err := os.WriteFile(filepath.Join(root, "internal/api/new_routes.go"), []byte(`package api
func (s *Server) moreRoutes() { s.engine.GET("/v1/new-feature", handler) }
`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateAPISurface(root); err == nil {
		t.Fatal("missed a public route in another source file")
	}
}

func TestAPISurfaceRejectsNewBinaryRouterExtensions(t *testing.T) {
	root := fixtureTree(t)
	path := filepath.Join(root, "internal/cmd")
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "run.go"), []byte(`package cmd
func run() { serverOptions = append(serverOptions, api.WithRouterConfigurator(configureCustomRoutes)) }
`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateAPISurface(root); err == nil {
		t.Fatal("missed a newly configured native router extension")
	}
}

func TestAPISurfaceIgnoresHandlerBodiesCommentsAndUnrelatedNamespaces(t *testing.T) {
	root := fixtureTree(t)
	changeFixture(t, root, "internal/api/server_routes.go", `v1.GET("/models", s.unifiedModelsHandler(openaiHandlers, claudeCodeHandlers))`, `
// v1.POST("/not-a-registration", anything)
s.engine.GET("/v8/management/new-feature", unrelated)
s.engine.POST("/openai/v1/new-feature", unrelated)
v1.GET("/models", func(c *gin.Context) { c.JSON(200, "changed body") })`)
	changeFixture(t, root, "sdk/api/handlers/gemini/gemini_handlers.go", `h.handleCountTokens(c, action[0], rawJSON)`, `h.changedHandler(c, "new implementation string")`)
	if err := validateAPISurface(root); err != nil {
		t.Fatal(err)
	}
}

func TestAPISurfaceDoesNotDependOnRegistrationOrderOrGroupVariableNames(t *testing.T) {
	root := fixtureTree(t)
	path := filepath.Join(root, "internal/api/server_routes.go")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(body), "\n")
	first, second := -1, -1
	for i, line := range lines {
		if strings.Contains(line, `v1.POST("/chat/completions",`) {
			first = i
		}
		if strings.Contains(line, `v1.POST("/completions",`) {
			second = i
		}
	}
	if first < 0 || second < 0 {
		t.Fatal("missing fixture routes")
	}
	lines[first], lines[second] = lines[second], lines[first]
	updated := strings.ReplaceAll(strings.ReplaceAll(strings.Join(lines, "\n"), "v1 :=", "public :="), "v1.", "public.")
	if err := os.WriteFile(path, []byte(updated), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateAPISurface(root); err != nil {
		t.Fatal(err)
	}
}

func TestGeminiDispatchCasesMustMatchTheEdgeCatalog(t *testing.T) {
	for _, tc := range []struct{ name, old, next string }{
		{"added action", `case "generateContent":`, `case "futureAction": h.future(c); case "generateContent":`},
		{"renamed action", `case "countTokens":`, `case "newCountTokens":`},
		{"dynamic case", `case "countTokens":`, `case dynamicAction:`},
		{"unknown default dispatch", `switch method {`, `switch method { default: h.future(c);`},
		{"dispatcher replaced", `switch method {`, `switch anotherValue {`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := fixtureTree(t)
			changeFixture(t, root, "sdk/api/handlers/gemini/gemini_handlers.go", tc.old, tc.next)
			if err := validateAPISurface(root); err == nil {
				t.Fatal("accepted unreviewed Gemini action dispatch")
			}
		})
	}
}

func TestDynamicRelayAttachmentMustRemainRecognized(t *testing.T) {
	for _, tc := range []struct{ name, path, old, next string }{
		{"relay configured path", "sdk/cliproxy/service_auth.go", `"/v1/ws"`, `"/v1/new-ws"`},
		{"relay default", "internal/wsrelay/manager.go", `"/v1/ws"`, `"/v1/new-ws"`},
		{"attachment default", "internal/api/server_routes.go", `trimmed = "/v1/ws"`, `trimmed = "/v1/new-ws"`},
		{"attachment method", "internal/api/server_routes.go", `s.engine.GET(trimmed,`, `s.engine.POST(trimmed,`},
		{"unknown attachment", "sdk/cliproxy/service_lifecycle.go", `s.wsGateway.Path()`, `otherPath`},
		{"extra attachment", "sdk/cliproxy/service_lifecycle.go", `s.server.AttachWebsocketRoute(s.wsGateway.Path(), s.wsGateway.Handler())`, `s.server.AttachWebsocketRoute(s.wsGateway.Path(), s.wsGateway.Handler()); s.server.AttachWebsocketRoute("/v1/extra", handler)`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := fixtureTree(t)
			changeFixture(t, root, tc.path, tc.old, tc.next)
			if err := validateAPISurface(root); err == nil {
				t.Fatal("accepted changed dynamic relay surface")
			}
		})
	}
}

func TestSurfaceDriftPreventsEverySourceWrite(t *testing.T) {
	root := fixtureTree(t)
	changeFixture(t, root, "internal/api/server_routes.go", `v1.POST("/tts",`, `v1.POST("/changed",`)
	path := filepath.Join(root, "first.go")
	original := []byte("package example\nconst value = 1\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := patchUpstream(root, []filePatch{{"first.go", []replacement{{"const value = 1", "const value = 2"}}}}); err == nil {
		t.Fatal("accepted route drift before patching")
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != string(original) {
		t.Fatalf("source changed before compatibility passed: %q, %v", actual, err)
	}
}

func TestPatchedManagerRejectsZeroProvidersAndPreservesPluginAuthentication(t *testing.T) {
	root := fixtureTree(t)
	for _, patch := range plans() {
		if patch.path == "sdk/access/manager.go" {
			if err := applyPlan(root, []filePatch{patch}); err != nil {
				t.Fatal(err)
			}
		}
	}
	path := filepath.Join(root, "sdk/access")
	// Compile the real upstream manager, with only its surrounding interfaces
	// supplied locally. Provider behavior below is the external boundary under test.
	files := map[string]string{
		"go.mod": "module accessregression\ngo 1.21\n",
		"types.go": `package access
import("context"; "net/http")
type Result struct{ Principal string }
type Provider interface{ Authenticate(context.Context,*http.Request)(*Result,*AuthError) }
type AuthError struct{ Code int }
const(AuthErrorCodeNotHandled=1; AuthErrorCodeNoCredentials=2; AuthErrorCodeInvalidCredential=3)
func IsAuthErrorCode(err *AuthError,code int)bool{return err!=nil&&err.Code==code}
func NewNoCredentialsError()*AuthError{return &AuthError{AuthErrorCodeNoCredentials}}
func NewInvalidCredentialError()*AuthError{return &AuthError{AuthErrorCodeInvalidCredential}}
`,
		"manager_test.go": `package access
import("context"; "net/http"; "net/http/httptest"; "testing")
type providerFunc func(context.Context,*http.Request)(*Result,*AuthError)
func(f providerFunc)Authenticate(c context.Context,r *http.Request)(*Result,*AuthError){return f(c,r)}
func TestEmptyEffectiveProvidersRejectStaleKeys(t *testing.T){
 m:=NewManager(); r:=httptest.NewRequest("POST","http://cpa/v1/messages",nil); r.Header.Set("Authorization","Bearer stale-or-arbitrary")
 if result,err:=m.Authenticate(context.Background(),r);result!=nil||!IsAuthErrorCode(err,AuthErrorCodeNoCredentials){t.Fatalf("empty provider list admitted request: result=%+v err=%+v",result,err)}
}
func TestRealPluginAndProviderPrecedenceRemainNative(t *testing.T){
 m:=NewManager(); calls:=0
 m.SetProviders([]Provider{providerFunc(func(context.Context,*http.Request)(*Result,*AuthError){calls++;return nil,&AuthError{AuthErrorCodeNotHandled}}),providerFunc(func(context.Context,*http.Request)(*Result,*AuthError){calls++;return &Result{Principal:"plugin-user"},nil})})
 result,err:=m.Authenticate(context.Background(),httptest.NewRequest("POST","http://cpa/v1/messages",nil))
 if err!=nil||result==nil||result.Principal!="plugin-user"||calls!=2{t.Fatalf("plugin auth changed: result=%+v err=%+v calls=%d",result,err,calls)}
 m.SetProviders(nil)
 if _,err=m.Authenticate(context.Background(),httptest.NewRequest("POST","http://cpa/v1/messages",nil));!IsAuthErrorCode(err,AuthErrorCodeNoCredentials){t.Fatal("removing final effective provider left open access")}
}
`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(path, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	command := exec.Command(filepath.Join(runtime.GOROOT(), "bin/go"), "test", "-count=1", "./...")
	command.Dir = path
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("provider-side regression: %v\n%s", err, output)
	}
}

func TestExactReplacementRejectsMissingAndDuplicateAnchors(t *testing.T) {
	for _, source := range []string{"changed", "hook hook"} {
		if _, errReplace := replaceExact(source, replacement{"hook", "guarded"}); errReplace == nil {
			t.Fatalf("accepted changed source %q", source)
		}
	}
	result, errReplace := replaceExact("before hook after", replacement{"hook", "guarded"})
	if errReplace != nil || result != "before guarded after" {
		t.Fatalf("result=%q, error=%v", result, errReplace)
	}
}

func TestFailedValidationDoesNotPartiallyPatchSource(t *testing.T) {
	for _, badSource := range []string{"package example\nconst other = 1\n", "package example\nconst value = 1\n// const value = 1\n"} {
		root := t.TempDir()
		original := "package example\nconst value = 1\n"
		for name, source := range map[string]string{"first.go": original, "second.go": badSource} {
			if errWrite := os.WriteFile(filepath.Join(root, name), []byte(source), 0o600); errWrite != nil {
				t.Fatal(errWrite)
			}
		}
		patches := []filePatch{
			{"first.go", []replacement{{"const value = 1", "const value = 2"}}},
			{"second.go", []replacement{{"const value = 1", "const value = 2"}}},
		}
		if errPatch := applyPlan(root, patches); errPatch == nil {
			t.Fatal("accepted drifted source")
		}
		data, errRead := os.ReadFile(filepath.Join(root, "first.go"))
		if errRead != nil || string(data) != original {
			t.Fatalf("partially patched first file: %q, %v", data, errRead)
		}
	}
}

func TestInvalidGeneratedGoDoesNotWriteAnyFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "source.go")
	original := "package example\nconst value = 1\n"
	if errWrite := os.WriteFile(path, []byte(original), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	if errPatch := applyPlan(root, []filePatch{{"source.go", []replacement{{"const value = 1", "invalid go {}"}}}}); errPatch == nil {
		t.Fatal("accepted invalid Go")
	}
	data, _ := os.ReadFile(path)
	if string(data) != original {
		t.Fatal("invalid Go overwrote original source")
	}
}
