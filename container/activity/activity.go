// Package sub2apiactivity keeps the Cloudflare container alive only while actual
// background work is running. This package is copied into the provider at build time.
package sub2apiactivity

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/MoeForge/moego/ojson"
	log "github.com/sirupsen/logrus"
)

const (
	endpointEnv = "SUB2API_ACTIVITY_ENDPOINT"
	jobLimit    = 10 * time.Minute
	leaseLimit  = 15 * time.Minute
	requestWait = 5 * time.Second
)

// This internal plain-HTTP client has no environment proxy, redirects, provider
// transport settings, or credentials. Provider HTTPS transports are unchanged.
var activityClient = &http.Client{
	Timeout: requestWait,
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: requestWait}).DialContext,
		DisableKeepAlives:     true, // Do not leave an idle control socket holding the container awake.
		ResponseHeaderTimeout: requestWait,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

type activityTicker interface {
	C() <-chan time.Time
	Stop()
}

type clockTicker struct{ *time.Ticker }

func (t clockTicker) C() <-chan time.Time { return t.Ticker.C }

type runner struct {
	endpoint string
	client   *http.Client
	ticker   func() activityTicker
}

func newRunner(endpoint string) (*runner, error) {
	u, errParse := url.Parse(endpoint)
	if errParse != nil || u.Scheme != "http" || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.Path != "/__sub2api/activity" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.TrimSpace(endpoint) != endpoint {
		return nil, errors.New("sub2api activity endpoint is missing or invalid")
	}
	return &runner{
		endpoint: endpoint,
		client:   activityClient,
		ticker:   func() activityTicker { return clockTicker{time.NewTicker(30 * time.Second)} },
	}, nil
}

// Enabled reports whether the lifecycle protocol is configured. A failed grant
// still refuses work; configuration alone never substitutes for a live grant.
func Enabled() bool {
	_, errRunner := newRunner(os.Getenv(endpointEnv))
	return errRunner == nil
}

// Run obtains a lease before invoking work and releases it after work (including
// synchronous Store.Save) returns. Cancellation requests cleanup; it does not
// prematurely drop protection while that cleanup is still executing.
func Run(ctx context.Context, work func(context.Context) error) error {
	r, errRunner := newRunner(os.Getenv(endpointEnv))
	if errRunner != nil {
		return errRunner
	}
	return r.run(ctx, work)
}

// Start acquires synchronously before starting an asynchronous child. A caller
// can release its own lease immediately after Start returns without leaving an
// unprotected gap before the child begins persistence.
func Start(ctx context.Context, work func(context.Context) error) error {
	r, errRunner := newRunner(os.Getenv(endpointEnv))
	if errRunner != nil {
		return errRunner
	}
	return r.start(ctx, work)
}

func (r *runner) begin(ctx context.Context) (string, error) {
	if errContext := ctx.Err(); errContext != nil {
		return "", errContext
	}
	var random [16]byte
	if _, errRandom := rand.Read(random[:]); errRandom != nil {
		return "", fmt.Errorf("sub2api activity id: %w", errRandom)
	}
	id := hex.EncodeToString(random[:])
	if errBegin := r.send(ctx, id, "begin"); errBegin != nil {
		return "", errBegin
	}
	return id, nil
}

func (r *runner) run(ctx context.Context, work func(context.Context) error) error {
	id, errBegin := r.begin(ctx)
	if errBegin != nil {
		return errBegin
	}
	return r.execute(ctx, id, work)
}

func (r *runner) start(ctx context.Context, work func(context.Context) error) error {
	id, errBegin := r.begin(ctx)
	if errBegin != nil {
		return errBegin
	}
	go func() {
		if errWork := r.execute(ctx, id, work); errWork != nil {
			log.WithError(errWork).Error("sub2api: protected background work failed")
		}
	}()
	return nil
}

func (r *runner) execute(parent context.Context, id string, work func(context.Context) error) (errWork error) {
	ctx, cancelWork := context.WithTimeout(parent, jobLimit)
	// The independent renewal context leaves five minutes for cancellation cleanup.
	// The Worker also enforces the absolute fifteen-minute lease cap itself.
	renewCtx, cancelRenew := context.WithTimeout(context.Background(), leaseLimit)
	finished := make(chan struct{})
	renewResult := make(chan error, 1)
	go func() {
		tick := r.ticker()
		defer tick.Stop()
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
					renewResult <- fmt.Errorf("sub2api activity maximum lifetime: %w", renewCtx.Err())
				}
				return
			case <-tick.C():
				select {
				case <-finished:
					renewResult <- nil
					return
				default:
				}
				if errRenew := r.send(renewCtx, id, "renew"); errRenew != nil {
					select {
					case <-finished:
						renewResult <- nil
					default:
						cancelWork()
						renewResult <- errRenew
					}
					return
				}
			}
		}
	}()
	defer func() {
		close(finished)
		cancelRenew()
		errRenew := <-renewResult // No renewal can race after end.
		errContext := ctx.Err()
		cancelWork()
		endCtx, cancelEnd := context.WithTimeout(context.Background(), requestWait)
		defer cancelEnd()
		errEnd := r.send(endCtx, id, "end")
		errWork = errors.Join(errWork, errContext, errRenew, errEnd)
	}()
	if errContext := ctx.Err(); errContext != nil {
		return errContext
	}
	return work(ctx)
}

func (r *runner) send(ctx context.Context, id, action string) error {
	doc := ojson.NewDocString(`{}`)
	if errSet := doc.Set("id", id); errSet != nil {
		return fmt.Errorf("sub2api activity encode id: %w", errSet)
	}
	if errSet := doc.Set("action", action); errSet != nil {
		return fmt.Errorf("sub2api activity encode action: %w", errSet)
	}
	req, errRequest := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(doc.Bytes()))
	if errRequest != nil {
		return fmt.Errorf("sub2api activity %s request: %w", action, errRequest)
	}
	req.Header.Set("Content-Type", "application/json")
	response, errSend := r.client.Do(req)
	if errSend != nil {
		return fmt.Errorf("sub2api activity %s: %w", action, errSend)
	}
	defer func() {
		if errClose := response.Body.Close(); errClose != nil {
			log.WithError(errClose).Debug("sub2api: close activity response")
		}
	}()
	// Never surface response contents: no remote response may inject provider data
	// into logs. Drain only a bounded response before closing the control socket.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("sub2api activity %s returned HTTP %d", action, response.StatusCode)
	}
	return nil
}
