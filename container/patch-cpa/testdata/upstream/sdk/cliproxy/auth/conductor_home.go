package auth

import (
	"context"
	"net/http"
	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type Manager struct{}
type Auth struct{}
type ProviderExecutor interface{}
type Error struct { Code, Message string; HTTPStatus int }
type HomeDispatchSelection struct{}
func (m *Manager) HomeEnabled() bool { return true }

func (m *Manager) pickHomeDispatchSelection(ctx context.Context, model string, opts cliproxyexecutor.Options) (*HomeDispatchSelection, error) {
	if m == nil {
		return nil, &Error{Code: "auth_not_found", Message: "no auth available"}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return nil, nil
}

var _, _ = internalconfig.Config{}, http.StatusServiceUnavailable
