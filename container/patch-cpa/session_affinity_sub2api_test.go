package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	sub2apiaffinity "github.com/router-for-me/CLIProxyAPI/v8/internal/sub2apiaffinity"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type durableAffinityTestTransport struct {
	mu       sync.Mutex
	records  map[string]sub2apiaffinity.Record
	ops      []string
	failBind bool
}

func (t *durableAffinityTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Host != "r2.internal" || request.URL.Path != "/__sub2api/session-affinity" {
		return nil, io.ErrUnexpectedEOF
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Op              string `json:"op"`
		Key             string `json:"key"`
		ExpectedVersion uint64 `json:"expectedVersion"`
		AuthID          string `json:"authId"`
		TTLMillis       int64  `json:"ttlMs"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if strings.Contains(string(body), "session-private") {
		return nil, io.ErrUnexpectedEOF
	}
	t.mu.Lock()
	t.ops = append(t.ops, payload.Op)
	if t.records == nil {
		t.records = make(map[string]sub2apiaffinity.Record)
	}
	status := http.StatusOK
	var output any
	current := t.records[payload.Key]
	switch payload.Op {
	case "read":
		output = current
	case "bind":
		if t.failBind {
			status = http.StatusServiceUnavailable
			output = map[string]any{"error": "unavailable"}
			break
		}
		if current.Version != payload.ExpectedVersion {
			status = http.StatusConflict
			output = map[string]any{"ok": false, "record": current}
			break
		}
		current = sub2apiaffinity.Record{AuthID: payload.AuthID, Version: current.Version + 1, ExpiresAt: time.Now().Add(time.Duration(payload.TTLMillis) * time.Millisecond).UnixMilli()}
		t.records[payload.Key] = current
		output = map[string]any{"ok": true, "record": current}
	case "delete":
		if current.Version != payload.ExpectedVersion || current.AuthID != payload.AuthID {
			status = http.StatusConflict
			output = map[string]any{"deleted": false}
			break
		}
		current = sub2apiaffinity.Record{Version: current.Version + 1, ExpiresAt: time.Now().Add(time.Duration(payload.TTLMillis) * time.Millisecond).UnixMilli()}
		t.records[payload.Key] = current
		output = map[string]any{"deleted": true}
	default:
		status = http.StatusBadRequest
	}
	t.mu.Unlock()
	encoded, err := json.Marshal(output)
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(encoded)), Request: request}, nil
}

func TestSub2APIDurableSessionAffinityRestoresAndFencesSelection(t *testing.T) {
	t.Setenv("SUB2API_SESSION_AFFINITY", "true")
	priorTransport := http.DefaultTransport
	bridge := &durableAffinityTestTransport{}
	http.DefaultTransport = bridge
	t.Cleanup(func() { http.DefaultTransport = priorTransport })
	options1 := cliproxyexecutor.Options{Headers: http.Header{"x-claude-code-session-id": []string{"session-private"}}, Metadata: map[string]any{}}
	auths := []*Auth{{ID: "credential-a"}, {ID: "credential-b"}}
	first := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &RoundRobinSelector{}, TTL: time.Hour})
	selected, err := first.Pick(context.Background(), "provider-x", "model-y", options1, auths)
	if err != nil || selected == nil {
		t.Fatalf("initial Pick() selected=%v err=%v", selected, err)
	}
	firstVersion, ok := options1.Metadata["sub2api.session-affinity.version"].(uint64)
	if !ok || firstVersion != 1 {
		t.Fatalf("first request fencing version=%v", options1.Metadata["sub2api.session-affinity.version"])
	}
	bridge.mu.Lock()
	var key string
	var saved sub2apiaffinity.Record
	for candidateKey, record := range bridge.records {
		key, saved = candidateKey, record
	}
	firstOps := append([]string(nil), bridge.ops...)
	bridge.mu.Unlock()
	if len(key) != 64 || saved.AuthID != selected.ID || saved.Version != 1 {
		t.Fatalf("durable record key=%q record=%+v selected=%q", key, saved, selected.ID)
	}
	if strings.Contains(key, "session-private") {
		t.Fatal("raw session ID crossed the affinity bridge")
	}
	if len(firstOps) != 2 || firstOps[0] != "read" || firstOps[1] != "bind" {
		t.Fatalf("ops before Pick returned=%v, want read+bind", firstOps)
	}

	// A new selector represents a new CPA process with an empty SessionCache.
	// It must restore the durable credential before the request can be sent.
	options2 := cliproxyexecutor.Options{Headers: http.Header{"x-claude-code-session-id": []string{"session-private"}}, Metadata: map[string]any{}}
	restarted := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &RoundRobinSelector{}, TTL: time.Hour})
	restored, err := restarted.Pick(context.Background(), "provider-x", "model-y", options2, auths)
	if err != nil || restored == nil || restored.ID != selected.ID {
		t.Fatalf("restart Pick() selected=%v want=%q err=%v", restored, selected.ID, err)
	}
	secondVersion, ok := options2.Metadata["sub2api.session-affinity.version"].(uint64)
	if !ok || secondVersion != 2 {
		t.Fatalf("restarted request fencing version=%v", options2.Metadata["sub2api.session-affinity.version"])
	}
	bridge.mu.Lock()
	bridge.ops = nil
	bridge.mu.Unlock()
	// A late result from request 1 cannot invalidate the binding advanced by
	// request 2, even though both requests selected the same credential.
	first.OnResult(Result{AuthID: selected.ID, Provider: "provider-x", Model: "model-y", Success: false, Options: options1})
	bridge.mu.Lock()
	if got := bridge.records[key]; got.AuthID != restored.ID || got.Version != secondVersion {
		bridge.mu.Unlock()
		t.Fatalf("late result changed current binding: %+v", got)
	}
	bridge.mu.Unlock()
	bridge.mu.Lock()
	bridge.ops = nil
	bridge.mu.Unlock()
	restarted.OnResult(Result{AuthID: restored.ID, Provider: "provider-x", Model: "model-y", Success: false, Options: options2})
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	if len(bridge.ops) == 0 || bridge.ops[len(bridge.ops)-1] != "delete" {
		t.Fatalf("failure did not persist result invalidation: %v", bridge.ops)
	}
	if got := bridge.records[key]; got.AuthID != "" || got.Version != secondVersion+1 {
		t.Fatalf("result tombstone=%+v", got)
	}
}

func TestSub2APIDurableAffinityFailurePreventsSelectionReturn(t *testing.T) {
	t.Setenv("SUB2API_SESSION_AFFINITY", "true")
	priorTransport := http.DefaultTransport
	bridge := &durableAffinityTestTransport{failBind: true}
	http.DefaultTransport = bridge
	t.Cleanup(func() { http.DefaultTransport = priorTransport })
	options := cliproxyexecutor.Options{Headers: http.Header{"x-claude-code-session-id": []string{"session-private"}}, Metadata: map[string]any{}}
	selector := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &RoundRobinSelector{}, TTL: time.Hour})
	selected, err := selector.Pick(context.Background(), "provider-x", "model-y", options, []*Auth{{ID: "credential-a"}})
	if err == nil || selected != nil {
		t.Fatalf("durable bind failure returned selected=%v err=%v", selected, err)
	}
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	if len(bridge.ops) != 2 || bridge.ops[0] != "read" || bridge.ops[1] != "bind" {
		t.Fatalf("durable operation retried or skipped: %v", bridge.ops)
	}
}

func TestSub2APIDurableAffinityFailsClosedInHomeDispatch(t *testing.T) {
	t.Setenv("SUB2API_SESSION_AFFINITY", "true")
	manager := NewManager(nil, NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{TTL: time.Hour}), nil)
	manager.SetConfig(&internalconfig.Config{Home: internalconfig.HomeConfig{Enabled: true}})
	selection, err := manager.pickHomeDispatchSelection(context.Background(), "model-y", cliproxyexecutor.Options{})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "home_session_affinity_unsupported" || authErr.HTTPStatus != http.StatusServiceUnavailable {
		t.Fatalf("Home selection error = %#v, want explicit durable-affinity compatibility failure", err)
	}
	if selection != nil {
		t.Fatalf("Home dispatch returned a selected credential despite the compatibility gate: %#v", selection)
	}
}
