package sub2apiactivity

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRunResourceCarriesWorkerFenceToSynchronousWrites(t *testing.T) {
	resourceName := "refresh:user@example.test"
	resource := ResourceID(resourceName)
	var actions []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			ID       string `json:"id"`
			Action   string `json:"action"`
			Resource string `json:"resource"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		actions = append(actions, body.Action)
		if body.Resource != resource || strings.Contains(body.Resource, "user@example") {
			t.Errorf("resource identity leaked or mismatched: %q", body.Resource)
		}
		if body.Action == "end" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_ = json.NewEncoder(w).Encode(Fence{
			Resource: body.Resource,
			Owner:    "a" + strings.Repeat("b", 63) + ":" + body.ID,
			Epoch:    3, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
		})
	}))
	defer server.Close()
	t.Setenv(endpointEnv, server.URL+"/__sub2api/activity")
	t.Setenv("SUB2API_POOL_FENCING", "true")

	err := RunResource(context.Background(), resourceName, func(ctx context.Context) error {
		fence, ok := FenceFromContext(ctx)
		if !ok || fence.Resource != resource || fence.Epoch != 3 {
			t.Fatalf("missing worker fence in synchronous save context: %+v, %t", fence, ok)
		}
		headers := FenceHeaders(ctx)
		if headers.Get("x-sub2api-owner") != fence.Owner || headers.Get("x-sub2api-epoch") != "3" {
			t.Fatalf("fence headers differ: %v", headers)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(actions, ",") != "begin,end" {
		t.Fatalf("activity sequence = %v", actions)
	}
}

func TestRunResourceFailsClosedOnMismatchedOwner(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		id := jsonField(body, "id")
		action := jsonField(body, "action")
		resource := jsonField(body, "resource")
		_ = id
		_ = action
		_ = json.NewEncoder(w).Encode(Fence{Resource: resource, Owner: "c" + strings.Repeat("d", 63) + ":" + strings.Repeat("e", 32), Epoch: 2, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()})
	}))
	defer server.Close()
	t.Setenv(endpointEnv, server.URL+"/__sub2api/activity")
	t.Setenv("SUB2API_POOL_FENCING", "true")
	called := false
	if err := RunResource(context.Background(), "mismatched-owner", func(context.Context) error { called = true; return nil }); err == nil || called {
		t.Fatalf("invalid owner grant: err=%v work called=%t", err, called)
	}
}

func jsonField(body []byte, key string) string {
	var fields map[string]string
	_ = json.Unmarshal(body, &fields)
	return fields[key]
}
