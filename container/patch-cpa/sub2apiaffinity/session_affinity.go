// Package sub2apiaffinity stores credential selection for explicit sessions in
// the Worker-owned Durable Object. It never persists session text or tokens.
package sub2apiaffinity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

const endpoint = "http://r2.internal/__sub2api/session-affinity"
const responseLimit = 4096

type Record struct {
	AuthID    string `json:"authId"`
	Version   uint64 `json:"version"`
	ExpiresAt int64  `json:"expiresAt"`
}

type localRecord struct {
	Record
	loaded   bool
	lastSave time.Time
}

type Store struct {
	client *http.Client
	mu     sync.Mutex
	states map[string]localRecord
	locks  map[string]*sync.Mutex
}

func NewFromEnv() *Store {
	if !Enabled() {
		return nil
	}
	return &Store{
		client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		states: make(map[string]localRecord),
		locks:  make(map[string]*sync.Mutex),
	}
}

// Enabled reports whether durable affinity integration is required by the
// container runtime. Home dispatch currently selects credentials remotely and
// bypasses the local selector, so callers must reject that mode rather than
// silently claiming durable per-session credential affinity.
func Enabled() bool {
	return os.Getenv("SUB2API_SESSION_AFFINITY") == "true"
}

// Lookup is called only on a local CPA cache miss. The durable record lets a
// cold process restore an explicit provider/model session binding.
func (s *Store) Lookup(ctx context.Context, rawKey string) (Record, bool, error) {
	if s == nil {
		return Record{}, false, nil
	}
	key := digest(rawKey)
	lock := s.lockFor(key)
	lock.Lock()
	defer lock.Unlock()
	return s.lookupLocked(ctx, key)
}

// BindAtVersion commits a selected auth before CPA submits the request upstream.
// The version must be the exact observation made before selection. Each request
// advances it, including same-credential requests, so late result callbacks
// cannot invalidate a newer in-flight request.
func (s *Store) BindAtVersion(ctx context.Context, rawKey, authID string, expectedVersion uint64, ttl time.Duration) (Record, error) {
	if s == nil {
		return Record{}, nil
	}
	if authID == "" || ttl <= 0 || expectedVersion == ^uint64(0) {
		return Record{}, errors.New("session affinity: invalid bind")
	}
	key := digest(rawKey)
	lock := s.lockFor(key)
	lock.Lock()
	defer lock.Unlock()
	state := s.getState(key)
	if !state.loaded {
		return Record{}, errors.New("session affinity: selector observation is stale")
	}
	writeVersion := expectedVersion
	if state.Version != expectedVersion {
		// Multiple requests in one process can observe the same version before
		// serializing their local writes. Rebase only when the intervening write
		// kept exactly the same credential; a changed credential remains stale.
		if state.AuthID != authID {
			return Record{}, errors.New("session affinity: selector observation is stale")
		}
		writeVersion = state.Version
	}
	request := struct {
		Op              string `json:"op"`
		Key             string `json:"key"`
		ExpectedVersion uint64 `json:"expectedVersion"`
		AuthID          string `json:"authId"`
		TTLMillis       int64  `json:"ttlMs"`
	}{Op: "bind", Key: key, ExpectedVersion: writeVersion, AuthID: authID, TTLMillis: ttl.Milliseconds()}
	var result struct {
		OK     bool   `json:"ok"`
		Record Record `json:"record"`
	}
	if err := s.post(ctx, request, &result); err != nil {
		return Record{}, err
	}
	if !result.OK || result.Record.AuthID != authID || result.Record.Version != writeVersion+1 || result.Record.ExpiresAt <= 0 {
		return Record{}, errors.New("session affinity: durable binding conflict")
	}
	s.setState(key, localRecord{Record: result.Record, loaded: true, lastSave: time.Now()})
	return result.Record, nil
}

// DeleteAtVersion removes a result-invalidated binding only if the auth and
// request version selected before upstream dispatch are still current. It does
// not read first or substitute a newer local version for the result's version.
func (s *Store) DeleteAtVersion(ctx context.Context, rawKey, expectedAuthID string, expectedVersion uint64, ttl time.Duration) error {
	if s == nil {
		return nil
	}
	if expectedAuthID == "" || ttl <= 0 || expectedVersion == ^uint64(0) {
		return errors.New("session affinity: invalid delete")
	}
	key := digest(rawKey)
	lock := s.lockFor(key)
	lock.Lock()
	defer lock.Unlock()
	request := struct {
		Op              string `json:"op"`
		Key             string `json:"key"`
		ExpectedVersion uint64 `json:"expectedVersion"`
		AuthID          string `json:"authId"`
		TTLMillis       int64  `json:"ttlMs"`
	}{Op: "delete", Key: key, ExpectedVersion: expectedVersion, AuthID: expectedAuthID, TTLMillis: ttl.Milliseconds()}
	var result struct {
		Deleted bool `json:"deleted"`
	}
	if err := s.post(ctx, request, &result); err != nil {
		return err
	}
	if !result.Deleted {
		return errors.New("session affinity: durable delete conflict")
	}
	if state := s.getState(key); state.loaded && state.Version == expectedVersion {
		s.setState(key, localRecord{Record: Record{Version: expectedVersion + 1}, loaded: true, lastSave: time.Now()})
	}
	return nil
}

func (s *Store) lookupLocked(ctx context.Context, key string) (Record, bool, error) {
	var result Record
	request := struct {
		Op  string `json:"op"`
		Key string `json:"key"`
	}{Op: "read", Key: key}
	if err := s.post(ctx, request, &result); err != nil {
		return Record{}, false, err
	}
	if result.Version == 0 && (result.AuthID != "" || result.ExpiresAt != 0) {
		return Record{}, false, errors.New("session affinity: malformed durable response")
	}
	if result.AuthID != "" && (len(result.AuthID) > 256 || result.Version == 0) {
		return Record{}, false, errors.New("session affinity: malformed durable response")
	}
	if result.AuthID == "" && result.Version > 0 && result.ExpiresAt < 0 {
		return Record{}, false, errors.New("session affinity: malformed durable response")
	}
	s.setState(key, localRecord{Record: result, loaded: true, lastSave: time.Now()})
	return result, result.AuthID != "", nil
}

func (s *Store) post(ctx context.Context, payload any, output any) error {
	body, errMarshal := json.Marshal(payload)
	if errMarshal != nil {
		return errors.New("session affinity: encode request")
	}
	request, errRequest := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if errRequest != nil {
		return errors.New("session affinity: create request")
	}
	request.Header.Set("Content-Type", "application/json")
	response, errDo := s.client.Do(request)
	if errDo != nil {
		// Outcome is unknown. Never retry a bind or provider call automatically.
		return fmt.Errorf("session affinity: durable request outcome unknown: %w", errDo)
	}
	defer response.Body.Close()
	data, errRead := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if errRead != nil || len(data) > responseLimit {
		return errors.New("session affinity: invalid durable response size")
	}
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusConflict {
			return errors.New("session affinity: durable compare-and-swap conflict")
		}
		return fmt.Errorf("session affinity: durable service returned HTTP %d", response.StatusCode)
	}
	if errDecode := json.Unmarshal(data, output); errDecode != nil {
		return errors.New("session affinity: malformed durable response")
	}
	return nil
}

func digest(rawKey string) string {
	sum := sha256.Sum256([]byte("sub2api-session-affinity-v1\x00" + rawKey))
	return hex.EncodeToString(sum[:])
}

func (s *Store) lockFor(key string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.locks == nil {
		s.locks = make(map[string]*sync.Mutex)
	}
	lock := s.locks[key]
	if lock == nil {
		lock = &sync.Mutex{}
		s.locks[key] = lock
	}
	return lock
}

func (s *Store) getState(key string) localRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.states[key]
}

func (s *Store) setState(key string, state localRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.states == nil {
		s.states = make(map[string]localRecord)
	}
	s.states[key] = state
}
