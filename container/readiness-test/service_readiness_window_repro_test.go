package cliproxy

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/sub2apiactivity"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

// Local only: pauses a documented lifecycle hook without changing production code.
// All credentials are synthetic; no provider inference is executed.
func TestReadinessWindowHealthIsNotModelReady(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	os.WriteFile(cfgPath, []byte("{}"), 0600)
	authJSON := `{"type":"codex","email":"local@example.invalid","access_token":"local-fake-token","expired":"2099-01-01T00:00:00Z","id_token":"eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ICJ1c2VyQGV4YW1wbGUuY29tIiwgImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6IHsiY2hhdGdwdF9wbGFuX3R5cGUiOiAidGVhbSIsICJjaGF0Z3B0X2FjY291bnRfaWQiOiAiYWNjLTEyMyJ9fQ.sig"}`
	if err := os.WriteFile(filepath.Join(dir, "codex-local-readiness.json"), []byte(authJSON), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SUB2API_ACTIVITY_ENDPOINT", "http://127.0.0.1:1/__sub2api/activity")
	cfg := &config.Config{Host: "127.0.0.1", Port: port, AuthDir: dir, SDKConfig: config.SDKConfig{APIKeys: []string{"local-front-key"}, ProxyURL: "http://127.0.0.1:1"}, Models: config.ModelCatalogs{Catalog: "/nonexistent-local-catalog", CodexCatalog: "/nonexistent-local-codex", DevinCatalog: "/nonexistent-local-devin"}}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	svc, err := NewBuilder().WithConfig(cfg).WithConfigPath(cfgPath).WithHooks(Hooks{OnAfterStart: func(*Service) { close(entered); <-release }}).WithWatcherFactory(func(string, string, func(*config.Config)) (*WatcherWrapper, error) {
		return &WatcherWrapper{start: func(context.Context) error { return nil }, stop: func() error { return nil }, setConfig: func(*config.Config) {}, setPluginAuthParser: func(PluginAuthParser) {}}, nil
	}).Build()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	t.Cleanup(func() {
		once.Do(func() { close(release) })
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("shutdown timeout")
		}
		for _, a := range svc.coreManager.List() {
			registry.GetGlobalRegistry().UnregisterClient(a.ID)
		}
	})
	go func() { done <- svc.Run(ctx) }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("server start timeout")
	}
	base := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	client := &http.Client{Timeout: 3 * time.Second}
	get := func(path string) (int, string) {
		req, _ := http.NewRequest("GET", base+path, nil)
		req.Header.Set("Authorization", "Bearer local-front-key")
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, string(b)
	}
	post := func() (int, string) {
		req, _ := http.NewRequest("POST", base+"/v1/chat/completions", strings.NewReader(`{"model":"gpt-6-luna","messages":[{"role":"user","content":"local only"}]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer local-front-key")
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, string(b)
	}
	status, body := get("/healthz")
	t.Logf("blocked startup health=%d %s", status, body)
	if status != 200 {
		t.Fatalf("health status %d", status)
	}
	_, stateBody := get("/__sub2api/lifecycle")
	var state map[string]any
	json.Unmarshal([]byte(stateBody), &state)
	if state["initialization_protocol"] != float64(1) || state["initialization_ready"] != false {
		t.Fatalf("expected pending signal: %s", stateBody)
	}
	t.Logf("pending lifecycle=%s", stateBody)
	status, body = post()
	t.Logf("blocked startup inference=%d %s", status, body)
	if status != 400 || !strings.Contains(body, "unknown provider for model gpt-6-luna") {
		t.Fatalf("expected pre-registry400, got %d %s", status, body)
	}
	once.Do(func() { close(release) })
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, body = get("/v1/models")
		if strings.Contains(body, "gpt-6-luna") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("registry never ready: %s", body)
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, stateBody = get("/__sub2api/lifecycle")
	json.Unmarshal([]byte(stateBody), &state)
	if state["initialization_ready"] != true {
		t.Fatalf("completed bootstrap not ready: %s", stateBody)
	}
	t.Logf("completed lifecycle=%s", stateBody)
	providers := registry.GetGlobalRegistry().GetModelProviders("gpt-6-luna")
	t.Logf("after registration providers=%v", providers)
	if len(providers) == 0 {
		t.Fatal("model never became routable")
	}
}

func TestInitializationReadinessEmptyAndFailedBootstrap(t *testing.T) {
	for _, fail := range []bool{false, true} {
		name := "empty-config-ready"
		if fail {
			name = "watcher-failure-not-ready"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			cfgPath := filepath.Join(dir, "config.yaml")
			os.WriteFile(cfgPath, []byte("{}"), 0600)
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := ln.Addr().(*net.TCPAddr).Port
			ln.Close()
			cfg := &config.Config{Host: "127.0.0.1", Port: port, AuthDir: dir, SDKConfig: config.SDKConfig{ProxyURL: "http://127.0.0.1:1"}, Models: config.ModelCatalogs{Catalog: "/nonexistent-local-catalog", CodexCatalog: "/nonexistent-local-codex", DevinCatalog: "/nonexistent-local-devin"}}
			svc, err := NewBuilder().WithConfig(cfg).WithConfigPath(cfgPath).WithWatcherFactory(func(string, string, func(*config.Config)) (*WatcherWrapper, error) {
				return &WatcherWrapper{start: func(context.Context) error {
					if fail {
						return errors.New("local injected watcher failure")
					}
					return nil
				}, stop: func() error { return nil }, setConfig: func(*config.Config) {}, setPluginAuthParser: func(PluginAuthParser) {}}, nil
			}).Build()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- svc.Run(ctx) }()
			if fail {
				select {
				case err := <-done:
					if err == nil {
						t.Fatal("expected startup failure")
					}
				case <-time.After(5 * time.Second):
					t.Fatal("startup did not fail")
				}
				if sub2apiactivity.Initialized() {
					t.Fatal("failed initialization marked ready")
				}
				return
			}
			until := time.Now().Add(5 * time.Second)
			for !sub2apiactivity.Initialized() {
				if time.Now().After(until) {
					t.Fatal("empty initialized configuration never ready")
				}
				time.Sleep(time.Millisecond * 10)
			}
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("shutdown timeout")
			}
			if sub2apiactivity.Initialized() {
				t.Fatal("shutdown remained ready")
			}
		})
	}
}
