package auth

import (
	"context"
	"time"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	cliproxysession "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/session"
)

type Selector interface{}
type Auth struct{ ID string }
type Error struct{}
type weightedReservation struct{}
func (*weightedReservation) finish(bool) {}
type sessionCache struct{}
func (*sessionCache) Get(string) (string, bool) { return "", false }
func (*sessionCache) Set(string, string) {}
func (*sessionCache) GetAndRefresh(string) (string, bool) { return "", false }
func (*sessionCache) SetAliases(string, ...string) {}
func (*sessionCache) setSessionAliases(string, string, string, ...string) {}
func (*sessionCache) Touch(string, string) bool { return false }
func (*sessionCache) CompareAndDelete(string, string) bool { return false }

type SessionAffinitySelector struct {
	fallback          Selector
	cache             *sessionCache
	subagentAffinity  bool
	rebindOnQuotaOnly bool
	rebindOnNever     bool
}

type SessionAffinityConfig struct {
	Fallback Selector
	TTL time.Duration
}

func NewSessionAffinitySelectorWithConfig(cfg SessionAffinityConfig) *SessionAffinitySelector {
	rebindMode := ""
	return &SessionAffinitySelector{
		fallback: cfg.Fallback,
		cache: new(sessionCache),
		subagentAffinity: true,
		rebindOnQuotaOnly: rebindMode == SessionAffinityRebindOnQuota,
		rebindOnNever:     rebindMode == SessionAffinityRebindOnNever,
	}
}

const (
	SessionAffinityRebindOnQuota = "quota"
	SessionAffinityRebindOnNever = "never"
)

func (s *SessionAffinitySelector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*Auth) (selected *Auth, errPick error) {
	var reservation *weightedReservation
	// Local bindings complete inside Pick; failed selections release speculative credit.
	defer func() { reservation.finish(selected != nil && errPick == nil) }()
	primaryID := "session"
	fallbackID := ""
	modelKey := model
	cacheKey := provider + "::" + primaryID + "::" + modelKey
	isFork := false
	isSubagent := false
	fallbackKey := ""
	if fallbackID != "" && fallbackID != primaryID {
		fallbackKey = provider + "::" + fallbackID + "::" + modelKey
	}
	bind := func(authID string, recordSelection bool) {
		keys := []string{cacheKey}
		s.cache.SetAliases(authID, keys...)
	}
	_, _, _, _, _ = ctx, opts, auths, isFork, isSubagent
	_ = cliproxysession.BoundSessionIdentity
	_ = fallbackKey
	return nil, nil
}

type Result struct {
	Success bool
	AuthID, Provider, Model string
	Options cliproxyexecutor.Options
}

func (s *SessionAffinitySelector) OnResult(res Result) {
	cacheKey := res.Provider + "::session::" + res.Model
	if res.Success {
		s.cache.Touch(cacheKey, res.AuthID)
		return
	}
	s.cache.CompareAndDelete(cacheKey, res.AuthID)
}
