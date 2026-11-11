package sub2apiactivity

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
)

type manualTicker struct {
	channel chan time.Time
	stopped chan struct{}
	once    sync.Once
}

func (t *manualTicker) C() <-chan time.Time { return t.channel }
func (t *manualTicker) Stop()               { t.once.Do(func() { close(t.stopped) }) }

type event struct{ id, action string }

func fixture(t *testing.T, status func(event) int) (*runner, <-chan event, *manualTicker) {
	t.Helper()
	events := make(chan event, 32)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost || req.URL.Path != "/__sub2api/activity" || req.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected activity request: %s %s %s", req.Method, req.URL.Path, req.Header.Get("Content-Type"))
		}
		if !req.Close {
			t.Error("activity control requests must close their idle connection")
		}
		body, errRead := io.ReadAll(req.Body)
		if errRead != nil {
			t.Errorf("read notification: %v", errRead)
		}
		e := event{ojson.GetBytes(body, "id").String(), ojson.GetBytes(body, "action").String()}
		if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(e.id) {
			t.Errorf("invalid activity id: %q", e.id)
		}
		events <- e
		code := http.StatusNoContent
		if status != nil {
			code = status(e)
		}
		w.WriteHeader(code)
	}))
	t.Cleanup(server.Close)
	r, errRunner := newRunner(server.URL + "/__sub2api/activity")
	if errRunner != nil {
		t.Fatal(errRunner)
	}
	tick := &manualTicker{channel: make(chan time.Time, 8), stopped: make(chan struct{})}
	r.ticker = func() activityTicker { return tick }
	return r, events, tick
}

func receive[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for synchronized test result")
		var zero T
		return zero
	}
}

func TestGrantPrecedesWorkAndReleaseFollowsSynchronousSave(t *testing.T) {
	r, events, tick := fixture(t, nil)
	started := make(chan struct{})
	saveComplete := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- r.run(context.Background(), func(ctx context.Context) error {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 10*time.Minute {
				t.Error("work must have a maximum ten-minute context")
			}
			close(started)
			<-saveComplete
			return nil
		})
	}()
	begin := receive(t, events)
	if begin.action != "begin" {
		t.Fatalf("first action = %q", begin.action)
	}
	receive(t, started)
	tick.channel <- time.Now()
	if renewal := receive(t, events); renewal.action != "renew" || renewal.id != begin.id {
		t.Fatalf("unexpected renewal: %#v", renewal)
	}
	select {
	case e := <-events:
		t.Fatalf("released before synchronous save completed: %#v", e)
	default:
	}
	close(saveComplete)
	if errRun := receive(t, result); errRun != nil {
		t.Fatal(errRun)
	}
	if end := receive(t, events); end.action != "end" || end.id != begin.id {
		t.Fatalf("unexpected release: %#v", end)
	}
	receive(t, tick.stopped)
	tick.channel <- time.Now()
	select {
	case e := <-events:
		t.Fatalf("notification after work finished: %#v", e)
	default:
	}
}

func TestRejectedGrantNeverStartsWork(t *testing.T) {
	r, events, _ := fixture(t, func(event) int { return http.StatusConflict })
	called := false
	errRun := r.run(context.Background(), func(context.Context) error { called = true; return nil })
	if errRun == nil || called {
		t.Fatalf("grant failure: error=%v, work called=%t", errRun, called)
	}
	if e := receive(t, events); e.action != "begin" {
		t.Fatalf("unexpected action: %#v", e)
	}
	select {
	case e := <-events:
		t.Fatalf("unexpected action after rejected grant: %#v", e)
	default:
	}
}

func TestRenewFailureCancelsWorkButWaitsForCleanupBeforeRelease(t *testing.T) {
	r, events, tick := fixture(t, func(e event) int {
		if e.action == "renew" {
			return http.StatusConflict
		}
		return http.StatusNoContent
	})
	cancelled := make(chan struct{})
	cleanup := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- r.run(context.Background(), func(ctx context.Context) error {
			<-ctx.Done()
			close(cancelled)
			<-cleanup
			return ctx.Err()
		})
	}()
	receive(t, events)
	tick.channel <- time.Now()
	if e := receive(t, events); e.action != "renew" {
		t.Fatalf("unexpected %#v", e)
	}
	receive(t, cancelled)
	select {
	case e := <-events:
		t.Fatalf("released before cleanup: %#v", e)
	default:
	}
	close(cleanup)
	if errRun := receive(t, result); errRun == nil || !errors.Is(errRun, context.Canceled) || !strings.Contains(errRun.Error(), "renew") {
		t.Fatalf("renew failure not reported: %v", errRun)
	}
	if e := receive(t, events); e.action != "end" {
		t.Fatalf("unexpected %#v", e)
	}
}

func TestParentCancellationStillProtectsActualCleanup(t *testing.T) {
	r, events, tick := fixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	cleaning := make(chan struct{})
	done := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- r.run(ctx, func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			close(cleaning)
			<-done
			return ctx.Err()
		})
	}()
	receive(t, events)
	receive(t, started)
	cancel()
	receive(t, cleaning)
	tick.channel <- time.Now()
	if e := receive(t, events); e.action != "renew" {
		t.Fatalf("cleanup was not protected: %#v", e)
	}
	close(done)
	if errRun := receive(t, result); !errors.Is(errRun, context.Canceled) {
		t.Fatalf("missing cancellation: %v", errRun)
	}
	if e := receive(t, events); e.action != "end" {
		t.Fatalf("unexpected %#v", e)
	}
}

func TestAsyncChildAcquiresBeforeParentCanRelease(t *testing.T) {
	r, events, _ := fixture(t, nil)
	childSave := make(chan struct{})
	childFinished := make(chan struct{})
	errRun := r.run(context.Background(), func(context.Context) error {
		return r.start(context.Background(), func(context.Context) error {
			defer close(childFinished)
			<-childSave
			return nil
		})
	})
	if errRun != nil {
		t.Fatal(errRun)
	}
	parentBegin, childBegin, parentEnd := receive(t, events), receive(t, events), receive(t, events)
	if parentBegin.action != "begin" || childBegin.action != "begin" || parentEnd.action != "end" || parentBegin.id != parentEnd.id || childBegin.id == parentBegin.id {
		t.Fatalf("unsafe parent/child handoff: %#v %#v %#v", parentBegin, childBegin, parentEnd)
	}
	close(childSave)
	receive(t, childFinished)
	if childEnd := receive(t, events); childEnd.action != "end" || childEnd.id != childBegin.id {
		t.Fatalf("unexpected child release: %#v", childEnd)
	}
}

func TestAsyncRejectedChildDoesNotStart(t *testing.T) {
	var begins int
	r, events, _ := fixture(t, func(e event) int {
		if e.action == "begin" {
			begins++
			if begins == 2 {
				return http.StatusConflict
			}
		}
		return http.StatusNoContent
	})
	called := make(chan struct{}, 1)
	errRun := r.run(context.Background(), func(context.Context) error {
		return r.start(context.Background(), func(context.Context) error { called <- struct{}{}; return nil })
	})
	if errRun == nil {
		t.Fatal("expected child grant failure")
	}
	for _, want := range []string{"begin", "begin", "end"} {
		if e := receive(t, events); e.action != want {
			t.Fatalf("action=%q, want %q", e.action, want)
		}
	}
	select {
	case <-called:
		t.Fatal("unprotected child started")
	default:
	}
}

func TestWorkErrorAndReleaseErrorRemainVisible(t *testing.T) {
	r, _, _ := fixture(t, func(e event) int {
		if e.action == "end" {
			return http.StatusServiceUnavailable
		}
		return http.StatusNoContent
	})
	failure := errors.New("store save failed")
	errRun := r.run(context.Background(), func(context.Context) error { return failure })
	if !errors.Is(errRun, failure) || !strings.Contains(errRun.Error(), "end") {
		t.Fatalf("lost errors: %v", errRun)
	}
}

func TestCancelledGrantDoesNotStart(t *testing.T) {
	r, _, _ := fixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	if errRun := r.run(ctx, func(context.Context) error { called = true; return nil }); !errors.Is(errRun, context.Canceled) || called {
		t.Fatalf("error=%v, called=%t", errRun, called)
	}
}

func TestPanicStillReleasesLease(t *testing.T) {
	r, events, _ := fixture(t, nil)
	func() {
		defer func() {
			if recover() != "test panic" {
				t.Error("work panic was not preserved")
			}
		}()
		_ = r.run(context.Background(), func(context.Context) error { panic("test panic") })
	}()
	for _, want := range []string{"begin", "end"} {
		if e := receive(t, events); e.action != want {
			t.Fatalf("action=%q, want %q", e.action, want)
		}
	}
}

func TestCapabilityRequiresValidConfiguration(t *testing.T) {
	for _, endpoint := range []string{"", "https://r2.internal/__sub2api/activity", "http://name:secret@r2.internal/__sub2api/activity", "http://r2.internal/other", "http://r2.internal/__sub2api/activity?x=1", "http://r2.internal/__sub2api/activity#fragment"} {
		t.Run(endpoint, func(t *testing.T) {
			t.Setenv("SUB2API_ACTIVITY_ENDPOINT", endpoint)
			if Enabled() {
				t.Fatal("unsupported configuration advertises protocol")
			}
			called := false
			if errRun := Run(context.Background(), func(context.Context) error { called = true; return nil }); errRun == nil || called {
				t.Fatalf("error=%v, called=%t", errRun, called)
			}
		})
	}
	t.Setenv("SUB2API_ACTIVITY_ENDPOINT", "http://r2.internal/__sub2api/activity")
	if !Enabled() {
		t.Fatal("valid production configuration not enabled")
	}
}
