package store

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/sub2apiactivity"
)

type conditionalObjects struct {
	mu     sync.Mutex
	data   map[string][]byte
	etags  map[string]string
	writes int
}

func (o *conditionalObjects) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/state" || r.URL.Path == "/state/" {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<LocationConstraint>us-east-1</LocationConstraint>`)
		case http.MethodHead, http.MethodPut:
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/state/")
	o.mu.Lock()
	defer o.mu.Unlock()
	if r.Method == http.MethodHead {
		etag := o.etags[key]
		if etag == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("ETag", `"`+etag+`"`)
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPut {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("X-Sub2API-Resource") == "" || r.Header.Get("X-Sub2API-Owner") == "" || r.Header.Get("X-Sub2API-Epoch") == "" {
		w.WriteHeader(http.StatusConflict)
		return
	}
	current := o.etags[key]
	if match := strings.Trim(r.Header.Get("If-Match"), `"`); match != "" && match != current {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	if r.Header.Get("If-None-Match") == "*" && current != "" {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	body, _ := io.ReadAll(r.Body)
	o.writes++
	etag := "version-" + string(rune('0'+o.writes))
	o.data[key] = body
	o.etags[key] = etag
	w.Header().Set("ETag", `"`+etag+`"`)
	w.WriteHeader(http.StatusOK)
}

func fencedStore(t *testing.T, endpoint, key, etag string) (*ObjectTokenStore, context.Context) {
	t.Helper()
	client, err := minio.New(strings.TrimPrefix(endpoint, "http://"), &minio.Options{
		Creds:  credentials.NewStaticV4("synthetic", "synthetic", ""),
		Secure: false, BucketLookup: minio.BucketLookupPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	versions := map[string]string{}
	if etag != "" {
		versions[key] = etag
	}
	store := &ObjectTokenStore{client: client, cfg: ObjectStoreConfig{Bucket: "state"}, objectVersions: versions}
	fence := sub2apiactivity.Fence{
		Resource: "r-" + strings.Repeat("a", 64),
		Owner:    strings.Repeat("b", 64) + ":" + strings.Repeat("c", 32),
		Epoch:    7, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
	return store, sub2apiactivity.WithFence(context.Background(), fence)
}

func TestConditionalAuthAndConfigWritesRejectAStaleVersion(t *testing.T) {
	objects := &conditionalObjects{data: map[string][]byte{}, etags: map[string]string{
		"auths/team/credential.json": "v1", "config/config.yaml": "config-v1",
	}}
	server := httptest.NewServer(http.HandlerFunc(objects.serve))
	defer server.Close()

	owner, ctx := fencedStore(t, server.URL, "auths/team/credential.json", "v1")
	if err := owner.putFencedObject(ctx, "auths/team/credential.json", []byte(`{"access_token":"new"}`), "application/json"); err != nil {
		t.Fatalf("owner write: %v", err)
	}
	if version, ok := owner.objectVersion("auths/team/credential.json"); !ok || version != "version-1" {
		t.Fatal("successful auth write did not advance the local ETag")
	}
	stale, staleCtx := fencedStore(t, server.URL, "auths/team/credential.json", "v1")
	if err := stale.putFencedObject(staleCtx, "auths/team/credential.json", []byte(`{"access_token":"stale"}`), "application/json"); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Fatalf("stale auth write was not rejected: %v", err)
	}
	if string(objects.data["auths/team/credential.json"]) != `{"access_token":"new"}` {
		t.Fatal("stale auth write replaced the current credential")
	}

	config, configCtx := fencedStore(t, server.URL, "config/config.yaml", "config-v1")
	if err := config.putFencedObject(configCtx, "config/config.yaml", []byte("models: [safe]\n"), "application/x-yaml"); err != nil {
		t.Fatalf("config write: %v", err)
	}
	if string(objects.data["config/config.yaml"]) != "models: [safe]\n" {
		t.Fatal("configuration update was not committed")
	}
}

func TestConditionalWritesRequireFenceAndKnownBaseVersion(t *testing.T) {
	objects := &conditionalObjects{data: map[string][]byte{}, etags: map[string]string{"auths/existing.json": "v1"}}
	server := httptest.NewServer(http.HandlerFunc(objects.serve))
	defer server.Close()

	missingFence, _ := fencedStore(t, server.URL, "auths/existing.json", "v1")
	if err := missingFence.putFencedObject(context.Background(), "auths/existing.json", []byte("{}"), "application/json"); err == nil || !strings.Contains(err.Error(), "fence") {
		t.Fatalf("write without a fence was accepted: %v", err)
	}
	unknownBase, ctx := fencedStore(t, server.URL, "auths/existing.json", "")
	if err := unknownBase.putFencedObject(ctx, "auths/existing.json", []byte("{}"), "application/json"); err == nil || !strings.Contains(err.Error(), "base version") {
		t.Fatalf("write without loaded base version was accepted: %v", err)
	}
	if objects.writes != 0 {
		t.Fatalf("unfenced/conflicted write count = %d", objects.writes)
	}
}

func TestFencedDeleteUsesConditionalEmptyTombstoneAndCanBeRecreated(t *testing.T) {
	const key = "auths/team/removed.json"
	objects := &conditionalObjects{
		data:  map[string][]byte{key: []byte(`{"removed":true}`)},
		etags: map[string]string{key: "version-before-delete"},
	}
	server := httptest.NewServer(http.HandlerFunc(objects.serve))
	defer server.Close()
	store, ctx := fencedStore(t, server.URL, key, "version-before-delete")
	if err := store.deleteFencedObject(ctx, key); err != nil {
		t.Fatalf("fenced tombstone: %v", err)
	}
	if got := objects.data[key]; len(got) != 0 {
		t.Fatalf("fenced delete body = %q, want empty compatibility tombstone", got)
	}
	tombstoneETag, exists := store.objectVersion(key)
	if !exists || tombstoneETag != "version-1" {
		t.Fatalf("fenced delete version = %q, exists=%v", tombstoneETag, exists)
	}
	if err := store.putFencedObject(ctx, key, []byte(`{"restored":true}`), "application/json"); err != nil {
		t.Fatalf("recreate after tombstone: %v", err)
	}
	if got := string(objects.data[key]); got != `{"restored":true}` {
		t.Fatalf("recreated object = %s", got)
	}
}

func TestConcurrentConditionalCredentialWritesHaveOneWinner(t *testing.T) {
	objects := &conditionalObjects{data: map[string][]byte{}, etags: map[string]string{"auths/shared.json": "v1"}}
	server := httptest.NewServer(http.HandlerFunc(objects.serve))
	defer server.Close()
	first, firstCtx := fencedStore(t, server.URL, "auths/shared.json", "v1")
	second, secondCtx := fencedStore(t, server.URL, "auths/shared.json", "v1")
	results := make(chan error, 2)
	var start sync.WaitGroup
	start.Add(1)
	for _, item := range []struct {
		store *ObjectTokenStore
		ctx   context.Context
		body  string
	}{
		{first, firstCtx, `{"access_token":"a"}`}, {second, secondCtx, `{"access_token":"b"}`},
	} {
		go func(item struct {
			store *ObjectTokenStore
			ctx   context.Context
			body  string
		}) {
			start.Wait()
			results <- item.store.putFencedObject(item.ctx, "auths/shared.json", []byte(item.body), "application/json")
		}(item)
	}
	start.Done()
	successes, conflicts := 0, 0
	for range 2 {
		if err := <-results; err == nil {
			successes++
		} else if strings.Contains(err.Error(), "conflict") {
			conflicts++
		} else {
			t.Fatalf("unexpected write error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestConcurrentConditionalWritesForDifferentKeysProtectVersionCache(t *testing.T) {
	const firstKey = "auths/team/first.json"
	const secondKey = "auths/team/second.json"
	objects := &conditionalObjects{
		data:  map[string][]byte{},
		etags: map[string]string{firstKey: "first-v1", secondKey: "second-v1"},
	}
	server := httptest.NewServer(http.HandlerFunc(objects.serve))
	defer server.Close()
	store, ctx := fencedStore(t, server.URL, firstKey, "first-v1")
	if err := store.rememberObjectVersion(secondKey, "second-v1"); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	for _, item := range []struct{ key, body string }{
		{firstKey, `{"account":"first"}`},
		{secondKey, `{"account":"second"}`},
	} {
		go func(item struct{ key, body string }) {
			results <- store.putFencedObject(ctx, item.key, []byte(item.body), "application/json")
		}(item)
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("concurrent key-specific write: %v", err)
		}
	}
	if _, ok := store.objectVersion(firstKey); !ok {
		t.Fatal("first key lost its version after concurrent writes")
	}
	if _, ok := store.objectVersion(secondKey); !ok {
		t.Fatal("second key lost its version after concurrent writes")
	}
}

func TestUnknownConditionalWriteOutcomeIsNotReplayedOrRebased(t *testing.T) {
	const key = "auths/team/uncertain.json"
	var writes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__sub2api/activity" {
			var body struct {
				ID       string `json:"id"`
				Action   string `json:"action"`
				Resource string `json:"resource"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode activity: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if body.Action == "end" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			_ = json.NewEncoder(w).Encode(sub2apiactivity.Fence{
				Resource: body.Resource,
				Owner:    strings.Repeat("a", 64) + ":" + body.ID,
				Epoch:    9, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
			})
			return
		}
		if r.URL.Path == "/state" || r.URL.Path == "/state/" {
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<LocationConstraint>us-east-1</LocationConstraint>`)
			return
		}
		if r.Method != http.MethodPut || r.URL.Path != "/state/"+key {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Errorf("read ambiguous write: %v", err)
		}
		writes.Add(1) // Simulate R2 committing before the response connection is lost.
		connection, _, errHijack := w.(http.Hijacker).Hijack()
		if errHijack != nil {
			t.Errorf("hijack committed response: %v", errHijack)
			return
		}
		_ = connection.Close()
	}))
	defer server.Close()
	t.Setenv("SUB2API_ACTIVITY_ENDPOINT", server.URL+"/__sub2api/activity")
	t.Setenv("SUB2API_POOL_FENCING", "true")
	store, ctx := fencedStore(t, server.URL, key, "base-version")
	err := store.putFencedObject(ctx, key, []byte(`{"access_token":"synthetic"}`), "application/json")
	if err == nil || !strings.Contains(err.Error(), "outcome unknown") {
		t.Fatalf("ambiguous committed write returned %v", err)
	}
	if writes.Load() != 1 {
		t.Fatalf("ambiguous write was replayed %d times", writes.Load())
	}
	if version, ok := store.objectVersion(key); !ok || version != "base-version" {
		t.Fatalf("unknown outcome rebased local ETag to %q (exists=%t)", version, ok)
	}
}

func TestCredentialWriteAcquiresAKeySpecificWorkerFence(t *testing.T) {
	const key = "auths/team/private-account.json"
	wantResource := sub2apiactivity.ResourceID("object-write:" + key)
	actions := make([]string, 0, 2)
	var activityID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__sub2api/activity" {
			var body struct {
				ID       string `json:"id"`
				Action   string `json:"action"`
				Resource string `json:"resource"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode worker activity: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			actions = append(actions, body.Action)
			if body.Resource != wantResource || strings.Contains(body.Resource, "private-account") {
				t.Errorf("raw object name leaked or wrong activity resource: %q", body.Resource)
			}
			activityID = body.ID
			if body.Action == "end" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			_ = json.NewEncoder(w).Encode(sub2apiactivity.Fence{
				Resource: body.Resource,
				Owner:    strings.Repeat("a", 64) + ":" + body.ID,
				Epoch:    8, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
			})
			return
		}
		if r.URL.Path == "/state" || r.URL.Path == "/state/" {
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<LocationConstraint>us-east-1</LocationConstraint>`)
			return
		}
		if r.Method != http.MethodPut || r.URL.Path != "/state/"+key {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("X-Sub2API-Resource") != wantResource ||
			r.Header.Get("X-Sub2API-Owner") != strings.Repeat("a", 64)+":"+activityID ||
			r.Header.Get("X-Sub2API-Epoch") != "8" ||
			r.Header.Get("If-Match") != `"base-version"` {
			t.Errorf("R2 write did not use its key-specific active fence: headers=%v", r.Header)
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.Header().Set("ETag", `"next-version"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	t.Setenv("SUB2API_ACTIVITY_ENDPOINT", server.URL+"/__sub2api/activity")
	t.Setenv("SUB2API_POOL_FENCING", "true")

	store, parentCtx := fencedStore(t, server.URL, key, "base-version")
	if err := store.putFencedObject(parentCtx, key, []byte(`{"access_token":"synthetic"}`), "application/json"); err != nil {
		t.Fatalf("key-fenced credential write: %v", err)
	}
	if strings.Join(actions, ",") != "begin,end" {
		t.Fatalf("object fence activity sequence = %v", actions)
	}
	if version, ok := store.objectVersion(key); !ok || version != "next-version" {
		t.Fatalf("stored ETag = %q, want next-version", version)
	}
}
