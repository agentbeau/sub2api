package sub2apiactivity

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/MoeForge/moego/ojson"
	"github.com/gin-gonic/gin"
)

const (
	resourceLeaseMS  = 90_000
	fenceResponseMax = 1024
)

func FencingEnabled() bool {
	return os.Getenv("SUB2API_POOL_FENCING") == "true"
}

type Fence struct {
	Resource  string `json:"resource"`
	Owner     string `json:"owner"`
	Epoch     int64  `json:"epoch"`
	ExpiresAt int64  `json:"expiresAt"`
}

type fenceContextKey struct{}
type fenceState struct {
	mu    sync.RWMutex
	fence Fence
}

var resourcePattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,160}$`)
var ownerPattern = regexp.MustCompile(`^[a-f0-9]{64}:[a-f0-9]{32}$`)

// WithFence attaches a worker-issued lease token to the context used for an R2 write.
func WithFence(ctx context.Context, fence Fence) context.Context {
	return context.WithValue(ctx, fenceContextKey{}, &fenceState{fence: fence})
}

func FenceFromContext(ctx context.Context) (Fence, bool) {
	if ctx == nil {
		return Fence{}, false
	}
	state, ok := ctx.Value(fenceContextKey{}).(*fenceState)
	if !ok || state == nil {
		return Fence{}, false
	}
	state.mu.RLock()
	fence := state.fence
	state.mu.RUnlock()
	if !validFence(fence) {
		return Fence{}, false
	}
	return fence, true
}

func replaceFence(ctx context.Context, fence Fence) {
	if ctx == nil {
		return
	}
	state, ok := ctx.Value(fenceContextKey{}).(*fenceState)
	if !ok || state == nil {
		return
	}
	state.mu.Lock()
	state.fence = fence
	state.mu.Unlock()
}

func FenceHeaders(ctx context.Context) http.Header {
	fence, ok := FenceFromContext(ctx)
	if !ok {
		return nil
	}
	headers := make(http.Header, 3)
	headers.Set("X-Sub2API-Resource", fence.Resource)
	headers.Set("X-Sub2API-Owner", fence.Owner)
	headers.Set("X-Sub2API-Epoch", strconv.FormatInt(fence.Epoch, 10))
	return headers
}

// ResourceID hashes local credential/config identifiers before they cross the
// container control channel. Raw account names and filenames are not sent.
func ResourceID(value string) string {
	digest := sha256.Sum256([]byte(value))
	return "r-" + hex.EncodeToString(digest[:])
}

func randomActivityID() (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("sub2api activity id: %w", err)
	}
	return hex.EncodeToString(nonce[:]), nil
}

func RunResource(ctx context.Context, resource string, work func(context.Context) error) error {
	return runFencedResource(ctx, resource, work, false)
}

func StartResource(ctx context.Context, resource string, work func(context.Context) error) error {
	return runFencedResource(ctx, resource, work, true)
}

func runFencedResource(ctx context.Context, resource string, work func(context.Context) error, async bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if os.Getenv("SUB2API_POOL_FENCING") != "true" {
		if Enabled() {
			if async {
				return Start(ctx, work)
			}
			return Run(ctx, work)
		}
		if async {
			go func() {
				if err := work(ctx); err != nil {
					log.WithError(err).Error("sub2api: local background work failed")
				}
			}()
			return nil
		}
		return work(ctx)
	}
	if work == nil {
		return errors.New("sub2api fenced work is nil")
	}
	r, errRunner := newRunner(os.Getenv(endpointEnv))
	if errRunner != nil {
		return errRunner
	}
	resource = ResourceID(resource)
	if !resourcePattern.MatchString(resource) {
		return errors.New("sub2api fenced resource is invalid")
	}
	id, errID := randomActivityID()
	if errID != nil {
		return errID
	}
	fence, errBegin := r.sendFence(ctx, id, resource, "begin", nil)
	if errBegin != nil {
		return errBegin
	}
	if async {
		go func() {
			if errWork := executeFenced(r, ctx, id, resource, fence, work); errWork != nil {
				log.WithError(errWork).Error("sub2api: fenced background work failed")
			}
		}()
		return nil
	}
	return executeFenced(r, ctx, id, resource, fence, work)
}

func executeFenced(r *runner, parent context.Context, id, resource string, initial Fence, work func(context.Context) error) (workErr error) {
	fencedParent := WithFence(parent, initial)
	ctx, cancelWork := context.WithTimeout(fencedParent, jobLimit)
	renewCtx, cancelRenew := context.WithTimeout(context.Background(), leaseLimit)
	finished := make(chan struct{})
	renewResult := make(chan error, 1)
	go func() {
		tick := r.ticker()
		defer tick.Stop()
		current := initial
		for {
			select {
			case <-finished:
				renewResult <- nil
				return
			case <-renewCtx.Done():
				select {
				case <-finished:
					renewResult <- nil
				default:
					cancelWork()
					renewResult <- fmt.Errorf("sub2api fenced work maximum lifetime: %w", renewCtx.Err())
				}
				return
			case <-tick.C():
				select {
				case <-finished:
					renewResult <- nil
					return
				default:
				}
				next, errRenew := r.sendFence(renewCtx, id, resource, "renew", &current)
				if errRenew != nil {
					select {
					case <-finished:
						renewResult <- nil
					default:
						cancelWork()
						renewResult <- errRenew
					}
					return
				}
				current = next
				replaceFence(ctx, current)
			}
		}
	}()
	defer func() {
		close(finished)
		cancelRenew()
		errRenew := <-renewResult
		errContext := ctx.Err()
		cancelWork()
		endCtx, cancelEnd := context.WithTimeout(context.Background(), requestWait)
		defer cancelEnd()
		_, errEnd := r.sendFence(endCtx, id, resource, "end", nil)
		workErr = errors.Join(workErr, errContext, errRenew, errEnd)
	}()
	if errContext := ctx.Err(); errContext != nil {
		return errContext
	}
	return work(ctx)
}

func (r *runner) sendFence(ctx context.Context, id, resource, action string, expected *Fence) (Fence, error) {
	if errContext := ctx.Err(); errContext != nil {
		return Fence{}, errContext
	}
	doc := ojson.NewDocString(`{}`)
	for key, value := range map[string]string{"id": id, "action": action, "resource": resource} {
		if errSet := doc.Set(key, value); errSet != nil {
			return Fence{}, fmt.Errorf("sub2api activity encode %s: %w", key, errSet)
		}
	}
	req, errRequest := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(doc.Bytes()))
	if errRequest != nil {
		return Fence{}, fmt.Errorf("sub2api activity %s request: %w", action, errRequest)
	}
	req.Header.Set("Content-Type", "application/json")
	response, errSend := r.client.Do(req)
	if errSend != nil {
		return Fence{}, fmt.Errorf("sub2api activity %s: %w", action, errSend)
	}
	defer response.Body.Close()
	if action == "end" {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, fenceResponseMax))
		if response.StatusCode != http.StatusNoContent {
			return Fence{}, fmt.Errorf("sub2api activity end returned HTTP %d", response.StatusCode)
		}
		return Fence{}, nil
	}
	body, errRead := io.ReadAll(io.LimitReader(response.Body, fenceResponseMax+1))
	if errRead != nil || len(body) > fenceResponseMax {
		return Fence{}, errors.New("sub2api activity lease response is invalid")
	}
	if response.StatusCode != http.StatusOK {
		return Fence{}, fmt.Errorf("sub2api activity %s returned HTTP %d", action, response.StatusCode)
	}
	fence := Fence{
		Resource:  ojson.GetBytes(body, "resource").String(),
		Owner:     ojson.GetBytes(body, "owner").String(),
		Epoch:     int64(ojson.GetBytes(body, "epoch").Int()),
		ExpiresAt: int64(ojson.GetBytes(body, "expiresAt").Int()),
	}
	if !validFence(fence) || fence.Resource != resource || !strings.HasSuffix(fence.Owner, ":"+id) {
		return Fence{}, errors.New("sub2api activity lease response did not match the request")
	}
	if expected != nil && (fence.Owner != expected.Owner || fence.Epoch != expected.Epoch || fence.Resource != expected.Resource) {
		return Fence{}, errors.New("sub2api activity lease changed during renewal")
	}
	return fence, nil
}

func validFence(fence Fence) bool {
	return resourcePattern.MatchString(fence.Resource) && ownerPattern.MatchString(fence.Owner) &&
		fence.Epoch > 0 && fence.ExpiresAt > time.Now().UnixMilli()
}

// RequestContextMiddleware accepts the private fence only after the Worker has
// replaced any client-supplied x-sub2api-* headers. Partial or malformed tokens
// are rejected before reaching handlers that might mutate shared state.
func RequestContextMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		fenced, err := requestWithFence(c.Request)
		if err != nil {
			c.AbortWithStatus(http.StatusConflict)
			return
		}
		c.Request = fenced
		c.Next()
	}
}

func requestWithFence(req *http.Request) (*http.Request, error) {
	resource := req.Header.Get("x-sub2api-resource")
	owner := req.Header.Get("x-sub2api-owner")
	epochText := req.Header.Get("x-sub2api-epoch")
	if resource == "" && owner == "" && epochText == "" {
		return req, nil
	}
	epoch, err := strconv.ParseInt(epochText, 10, 64)
	if err != nil {
		return nil, err
	}
	fence := Fence{Resource: resource, Owner: owner, Epoch: epoch, ExpiresAt: time.Now().Add(resourceLeaseMS * time.Millisecond).UnixMilli()}
	if !validFence(fence) {
		return nil, errors.New("invalid ownership fence")
	}
	ctx := WithFence(req.Context(), fence)
	return req.WithContext(ctx), nil
}
