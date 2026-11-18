package sub2apiaffinity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEnabledUsesOnlyTheExplicitRuntimeOptIn(t *testing.T) {
	t.Setenv("SUB2API_SESSION_AFFINITY", "")
	if Enabled() {
		t.Fatal("affinity unexpectedly enabled without exact opt-in")
	}
	t.Setenv("SUB2API_SESSION_AFFINITY", "TRUE")
	if Enabled() {
		t.Fatal("affinity accepted a noncanonical opt-in")
	}
	t.Setenv("SUB2API_SESSION_AFFINITY", "true")
	if !Enabled() {
		t.Fatal("affinity did not recognize exact opt-in")
	}
}

type fakeRecord struct {
	AuthID    string `json:"authId"`
	Version   uint64 `json:"version"`
	ExpiresAt int64  `json:"expiresAt"`
}

func TestStoreRestoresAffinityAfterProcessRestart(t *testing.T) {
	var mu sync.Mutex
	var saved fakeRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch request["op"] {
		case "read":
			_ = json.NewEncoder(w).Encode(saved)
		case "bind":
			if request["expectedVersion"].(float64) != float64(saved.Version) {
				w.WriteHeader(http.StatusConflict)
				return
			}
			saved.Version++
			saved.AuthID = request["authId"].(string)
			saved.ExpiresAt = time.Now().Add(time.Hour).UnixMilli()
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "record": saved})
		case "delete":
			if request["expectedVersion"].(float64) != float64(saved.Version) || saved.AuthID != request["authId"].(string) {
				w.WriteHeader(http.StatusConflict)
				return
			}
			saved.Version++
			saved.AuthID = ""
			_ = json.NewEncoder(w).Encode(map[string]any{"deleted": true})
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	first := &Store{client: server.Client(), states: map[string]localRecord{}, locks: map[string]*sync.Mutex{}}
	first.client.Transport = rewriteTransport{base: server.URL, next: first.client.Transport}
	observed, _, err := first.Lookup(context.Background(), "provider::session::model")
	if err != nil {
		t.Fatal(err)
	}
	firstRequest, err := first.BindAtVersion(context.Background(), "provider::session::model", "credential-a", observed.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	secondRequest, err := first.BindAtVersion(context.Background(), "provider::session::model", "credential-a", observed.Version, time.Hour)
	if err != nil || secondRequest.Version != firstRequest.Version+1 {
		t.Fatalf("same-credential request did not advance fence: record=%+v err=%v", secondRequest, err)
	}
	if err := first.DeleteAtVersion(context.Background(), "provider::session::model", "credential-a", firstRequest.Version, time.Hour); err == nil {
		t.Fatal("late first-request failure deleted the newer affinity")
	}

	second := &Store{client: server.Client(), states: map[string]localRecord{}, locks: map[string]*sync.Mutex{}}
	second.client.Transport = rewriteTransport{base: server.URL, next: second.client.Transport}
	record, found, err := second.Lookup(context.Background(), "provider::session::model")
	if err != nil || !found || record.AuthID != "credential-a" || record.Version != secondRequest.Version {
		t.Fatalf("record=%+v found=%v err=%v", record, found, err)
	}
}

func TestSameProcessStaleSelectionCannotRebindDifferentCredential(t *testing.T) {
	var mu sync.Mutex
	var saved fakeRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch request["op"] {
		case "read":
			_ = json.NewEncoder(w).Encode(saved)
		case "bind":
			if uint64(request["expectedVersion"].(float64)) != saved.Version {
				w.WriteHeader(http.StatusConflict)
				return
			}
			saved.Version++
			saved.AuthID = request["authId"].(string)
			saved.ExpiresAt = time.Now().Add(time.Hour).UnixMilli()
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "record": saved})
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	client := server.Client()
	client.Transport = rewriteTransport{base: server.URL, next: client.Transport}
	store := &Store{client: client, states: map[string]localRecord{}, locks: map[string]*sync.Mutex{}}
	observed, found, err := store.Lookup(context.Background(), "provider::session::model")
	if err != nil || found {
		t.Fatalf("cold lookup found=%v err=%v", found, err)
	}
	if _, err := store.BindAtVersion(context.Background(), "provider::session::model", "credential-a", observed.Version, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BindAtVersion(context.Background(), "provider::session::model", "credential-b", observed.Version, time.Hour); err == nil {
		t.Fatal("stale same-process selection rebound a different credential")
	}
	mu.Lock()
	defer mu.Unlock()
	if saved.AuthID != "credential-a" || saved.Version != 1 {
		t.Fatalf("stale selection changed durable record: %+v", saved)
	}
}

func TestStoreRejectsUnknownWriteOutcomeWithoutReplay(t *testing.T) {
	var reads, binds int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		switch request["op"] {
		case "read":
			reads++
			_, _ = w.Write([]byte(`{"authId":"","version":0,"expiresAt":0}`))
		case "bind":
			binds++
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	store := &Store{client: server.Client(), states: map[string]localRecord{}, locks: map[string]*sync.Mutex{}}
	store.client.Transport = rewriteTransport{base: server.URL, next: store.client.Transport}
	observed, _, err := store.Lookup(context.Background(), "provider::session::model")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BindAtVersion(context.Background(), "provider::session::model", "auth", observed.Version, time.Hour); err == nil {
		t.Fatal("expected unknown outcome error")
	}
	if reads != 1 || binds != 1 {
		t.Fatalf("reads=%d binds=%d, want one read and one non-retried bind", reads, binds)
	}
}

func TestConcurrentColdClaimsHaveOneWinnerAndStaleRebindIsFenced(t *testing.T) {
	var mu sync.Mutex
	var current fakeRecord
	var reads, binds int
	ready := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		switch request["op"] {
		case "read":
			mu.Lock()
			reads++
			count := reads
			saved := current
			mu.Unlock()
			if count == 2 {
				close(ready)
			}
			<-ready // Both owners observe the same cold version before either claim.
			_ = json.NewEncoder(w).Encode(saved)
		case "bind":
			mu.Lock()
			defer mu.Unlock()
			binds++
			if uint64(request["expectedVersion"].(float64)) != current.Version {
				w.WriteHeader(http.StatusConflict)
				return
			}
			current.Version++
			current.AuthID = request["authId"].(string)
			current.ExpiresAt = time.Now().Add(time.Hour).UnixMilli()
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "record": current})
		case "delete":
			mu.Lock()
			defer mu.Unlock()
			if uint64(request["expectedVersion"].(float64)) != current.Version || current.AuthID != request["authId"].(string) {
				w.WriteHeader(http.StatusConflict)
				return
			}
			current.Version++
			current.AuthID = ""
			_ = json.NewEncoder(w).Encode(map[string]any{"deleted": true})
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	newStore := func() *Store {
		client := server.Client()
		client.Transport = rewriteTransport{base: server.URL, next: client.Transport}
		return &Store{client: client, states: map[string]localRecord{}, locks: map[string]*sync.Mutex{}}
	}
	first, second := newStore(), newStore()
	type observation struct {
		store  *Store
		record Record
		err    error
	}
	observations := make(chan observation, 2)
	go func() {
		record, _, err := first.Lookup(context.Background(), "provider::session::model")
		observations <- observation{store: first, record: record, err: err}
	}()
	go func() {
		record, _, err := second.Lookup(context.Background(), "provider::session::model")
		observations <- observation{store: second, record: record, err: err}
	}()
	observed := make(map[*Store]Record, 2)
	for range 2 {
		got := <-observations
		if got.err != nil {
			t.Fatal(got.err)
		}
		observed[got.store] = got.record
	}
	errors := make(chan error, 2)
	go func() {
		_, err := first.BindAtVersion(context.Background(), "provider::session::model", "auth-a", observed[first].Version, time.Hour)
		errors <- err
	}()
	go func() {
		_, err := second.BindAtVersion(context.Background(), "provider::session::model", "auth-b", observed[second].Version, time.Hour)
		errors <- err
	}()
	errA, errB := <-errors, <-errors
	if (errA == nil) == (errB == nil) {
		t.Fatalf("want exactly one durable claim winner, errors=%v / %v", errA, errB)
	}
	mu.Lock()
	winner, committedBinds := current, binds
	mu.Unlock()
	if winner.Version != 1 || (winner.AuthID != "auth-a" && winner.AuthID != "auth-b") || committedBinds != 2 {
		t.Fatalf("winner=%+v binds=%d, want one commit and one CAS conflict", winner, committedBinds)
	}

	// Re-read on both runtimes. The old result uses its version after the new
	// owner has rebound; neither the write nor a late delete may erase it.
	old, newer := newStore(), newStore()
	oldRecord, found, err := old.Lookup(context.Background(), "provider::session::model")
	if err != nil || !found {
		t.Fatalf("old lookup found=%v err=%v", found, err)
	}
	newObserved, found, err := newer.Lookup(context.Background(), "provider::session::model")
	if err != nil || !found {
		t.Fatalf("new lookup found=%v err=%v", found, err)
	}
	newBound, err := newer.BindAtVersion(context.Background(), "provider::session::model", "auth-current", newObserved.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.BindAtVersion(context.Background(), "provider::session::model", "auth-stale", oldRecord.Version, time.Hour); err == nil {
		t.Fatal("stale rebind was accepted")
	}
	if err := old.DeleteAtVersion(context.Background(), "provider::session::model", oldRecord.AuthID, oldRecord.Version, time.Hour); err == nil {
		t.Fatal("stale result delete was accepted")
	}
	check := newStore()
	record, found, err := check.Lookup(context.Background(), "provider::session::model")
	if err != nil || !found || record.AuthID != "auth-current" || record.Version != newBound.Version {
		t.Fatalf("current mapping lost: record=%+v found=%v err=%v", record, found, err)
	}
}

func TestStoreDisabledUnlessExplicitlyEnabled(t *testing.T) {
	prior := os.Getenv("SUB2API_SESSION_AFFINITY")
	t.Cleanup(func() { _ = os.Setenv("SUB2API_SESSION_AFFINITY", prior) })
	_ = os.Unsetenv("SUB2API_SESSION_AFFINITY")
	if NewFromEnv() != nil {
		t.Fatal("store enabled without explicit environment flag")
	}
	_ = os.Setenv("SUB2API_SESSION_AFFINITY", "true")
	if NewFromEnv() == nil {
		t.Fatal("store was not enabled")
	}
}

type rewriteTransport struct {
	base string
	next http.RoundTripper
}

func (t rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = "r2.internal"
	if t.next == nil {
		return http.DefaultTransport.RoundTrip(clone)
	}
	// httptest has its own host, so rewrite the authority back to its local URL.
	return t.next.RoundTrip(cloneForTestHost(clone, t.base))
}
func cloneForTestHost(r *http.Request, base string) *http.Request {
	clone := r.Clone(r.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(strings.TrimPrefix(base, "http://"), "https://")
	return clone
}
