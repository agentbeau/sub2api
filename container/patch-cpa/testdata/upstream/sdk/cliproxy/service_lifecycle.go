package cliproxy

import (
	"context"
	"fmt"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	"time"
)

// Relevant source anchors from v8.0.67, parsed but never linked.
func (s *Service) Run(ctx context.Context) error {
	if s == nil {
		return fmt.Errorf("cliproxy: service is nil")
	}
	defer func() {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutdownCancel()
		s.Shutdown(shutdownCtx)
	}()
	s.server.AttachWebsocketRoute(s.wsGateway.Path(), s.wsGateway.Handler())
	s.registerModelRefreshCallback()
	if !homeEnabled {
		go s.runAntigravityModelRefresh(ctx)
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	}
}
