// Command patch-cpa adds the narrow container lifecycle hooks to the upstream
// provider. Every source anchor must match exactly once before any file is written.
// Upstream changes therefore stop the image build for review instead of silently
// shipping a partial lifecycle protocol.
package main

import (
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"strings"
)

type replacement struct{ old, next string }
type filePatch struct {
	path  string
	edits []replacement
}

const helperImport = `"github.com/router-for-me/CLIProxyAPI/v8/internal/sub2apiactivity"`

func plans() []filePatch {
	return []filePatch{
		{
			path: "sdk/cliproxy/auth/auto_refresh_loop.go",
			edits: []replacement{
				{`log "github.com/sirupsen/logrus"`, helperImport + "\n\tlog \"github.com/sirupsen/logrus\""},
				{`\t\t\tif l.manager.beginRefreshJob(ctx, job) {
\t\t\t\t_, _ = l.manager.refreshAuthForRequestAtEpoch(ctx, job.id, "", job.registrationEpoch)
\t\t\t}
\t\t\tl.manager.finishRefreshJob(job, time.Time{}, false)`, `\t\t\tretryAt := time.Time{}
\t\t\tif l.manager.beginRefreshJob(ctx, job) {
\t\t\t\terrActivity := sub2apiactivity.Run(ctx, func(activityCtx context.Context) error {
\t\t\t\t\t// Upstream already handles and sanitizes provider refresh errors.
\t\t\t\t\t_, _ = l.manager.refreshAuthForRequestAtEpoch(activityCtx, job.id, "", job.registrationEpoch)
\t\t\t\t\treturn nil
\t\t\t\t})
\t\t\t\tif errActivity != nil {
\t\t\t\t\t// A rejected lease must retain the normal finish/retry bookkeeping.
\t\t\t\t\tretryAt = time.Now().Add(l.interval)
\t\t\t\t\tlog.WithError(errActivity).Warn("sub2api: background refresh did not complete")
\t\t\t\t}
\t\t\t}
\t\t\tl.manager.finishRefreshJob(job, retryAt, false)`},
			},
		},
		{
			path: "internal/api/handlers/management/handler.go",
			edits: []replacement{
				{`"github.com/router-for-me/CLIProxyAPI/v8/internal/pluginstore"`, `"github.com/router-for-me/CLIProxyAPI/v8/internal/pluginstore"` + "\n\t" + helperImport},
				{`\tgo func() {
\t\tdefer func() {
\t\t\tif recovered := recover(); recovered != nil {
\t\t\t\tlog.WithField("panic", recovered).Error("management: async config reload panicked")
\t\t\t}
\t\t}()
\t\th.reloadConfigAfterManagementSave(reloadCtx, snapshot)
\t}()`, `\terrActivity := sub2apiactivity.Start(reloadCtx, func(activityCtx context.Context) error {
\t\tdefer func() {
\t\t\tif recovered := recover(); recovered != nil {
\t\t\t\tlog.WithField("panic", recovered).Error("management: async config reload panicked")
\t\t\t}
\t\t}()
\t\th.reloadConfigAfterManagementSave(activityCtx, snapshot)
\t\treturn activityCtx.Err()
\t})
\tif errActivity != nil {
\t\tlog.WithError(errActivity).Error("sub2api: could not protect management config reload")
\t}`},
			},
		},
		{
			path: "internal/watcher/config_reload.go",
			edits: []replacement{
				{`"crypto/sha256"`, `"context"` + "\n\t\"crypto/sha256\""},
				{`"github.com/router-for-me/CLIProxyAPI/v8/internal/config"`, `"github.com/router-for-me/CLIProxyAPI/v8/internal/config"` + "\n\t" + helperImport},
				{`func (w *Watcher) reloadConfigIfChanged() {
\t// File events and post-save reloads may arrive together; an older read must`, `func (w *Watcher) reloadConfigIfChanged() {
\terrActivity := sub2apiactivity.Run(context.Background(), func(activityCtx context.Context) error {
\t\tw.reloadConfigIfChangedWithActivity(activityCtx)
\t\treturn activityCtx.Err()
\t})
\tif errActivity != nil {
\t\tlog.WithError(errActivity).Error("sub2api: could not complete protected watcher reload")
\t}
}

func (w *Watcher) reloadConfigIfChangedWithActivity(ctx context.Context) {
\t// File events and post-save reloads may arrive together; an older read must`},
				{`\tw.configApplyMu.Lock()
\tdefer w.configApplyMu.Unlock()

\tdata, err := os.ReadFile(w.configPath)`, `\tw.configApplyMu.Lock()
\tdefer w.configApplyMu.Unlock()
\tif ctx.Err() != nil {
\t\treturn
\t}

\tdata, err := os.ReadFile(w.configPath)`},
			},
		},
		{
			path: "internal/watcher/clients.go",
			edits: []replacement{
				{`"github.com/router-for-me/CLIProxyAPI/v8/internal/redisqueue"`, `"github.com/router-for-me/CLIProxyAPI/v8/internal/redisqueue"` + "\n\t" + helperImport},
				{`\tgo func() {
\t\tctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
\t\tdefer cancel()
\t\tif err := w.storePersister.PersistConfig(ctx); err != nil {
\t\t\tlog.Errorf("failed to persist config change: %v", err)
\t\t}
\t}()`, `\t// Acquire before the reload callback releases its parent activity lease.
\terrActivity := sub2apiactivity.Start(context.Background(), func(activityCtx context.Context) error {
\t\tctx, cancel := context.WithTimeout(activityCtx, 30*time.Second)
\t\tdefer cancel()
\t\tif errPersist := w.storePersister.PersistConfig(ctx); errPersist != nil {
\t\t\treturn fmt.Errorf("failed to persist config change: %w", errPersist)
\t\t}
\t\treturn nil
\t})
\tif errActivity != nil {
\t\tlog.WithError(errActivity).Error("sub2api: could not protect config persistence")
\t}`},
				{`\tgo func() {
\t\tctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
\t\tdefer cancel()
\t\tif err := w.storePersister.PersistAuthFiles(ctx, message, filtered...); err != nil {
\t\t\tlog.Errorf("failed to persist auth changes: %v", err)
\t\t}
\t}()`, `\terrActivity := sub2apiactivity.Start(context.Background(), func(activityCtx context.Context) error {
\t\tctx, cancel := context.WithTimeout(activityCtx, 30*time.Second)
\t\tdefer cancel()
\t\tif errPersist := w.storePersister.PersistAuthFiles(ctx, message, filtered...); errPersist != nil {
\t\t\treturn fmt.Errorf("failed to persist auth changes: %w", errPersist)
\t\t}
\t\treturn nil
\t})
\tif errActivity != nil {
\t\tlog.WithError(errActivity).Error("sub2api: could not protect auth persistence")
\t}`},
			},
		},
		{
			path: "sdk/cliproxy/service_config.go",
			edits: []replacement{
				{`"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"`, `"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"` + "\n\t" + helperImport},
				{`func (s *Service) applyWatcherConfigUpdate(newCfg *config.Config) {
\ts.applyConfigUpdateWithAuthSynthesis(context.Background(), newCfg, false)
}`, `func (s *Service) applyWatcherConfigUpdate(newCfg *config.Config) {
\t// The watcher's callback API has no context. Give runtime application its
\t// own bounded context instead of discarding cancellation during reload.
\terrActivity := sub2apiactivity.Run(context.Background(), func(activityCtx context.Context) error {
\t\ts.applyConfigUpdateWithAuthSynthesis(activityCtx, newCfg, false)
\t\treturn activityCtx.Err()
\t})
\tif errActivity != nil {
\t\tlog.WithError(errActivity).Error("sub2api: could not complete protected runtime reload")
\t}
}`},
			},
		},
		{
			path: "internal/api/server_routes.go",
			edits: []replacement{
				{`"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"`, `"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"` + "\n\t" + helperImport},
				{`\ts.engine.HEAD("/healthz", healthzHandler)

\ts.engine.GET("/management.html", s.serveManagementControlPanel)`, `\ts.engine.HEAD("/healthz", healthzHandler)

\t// Native-container capability probe only; the public gateway blocks this path.
\ts.engine.GET("/__sub2api/lifecycle", func(c *gin.Context) {
\t\tc.Header("Cache-Control", "no-store")
\t\tif !sub2apiactivity.Enabled() {
\t\t\tc.Status(http.StatusServiceUnavailable)
\t\t\treturn
\t\t}
\t\tc.JSON(http.StatusOK, gin.H{"activity_protocol": 1})
\t})

\ts.engine.GET("/management.html", s.serveManagementControlPanel)`},
			},
		},
	}
}

// Snippets use visible tab escapes to make exact source whitespace reviewable.
func literal(source string) string { return strings.ReplaceAll(source, `\t`, "\t") }

func replaceExact(source string, edit replacement) (string, error) {
	old := literal(edit.old)
	if count := strings.Count(source, old); count != 1 {
		return "", fmt.Errorf("expected exactly one source anchor, found %d: %.100q", count, old)
	}
	return strings.Replace(source, old, literal(edit.next), 1), nil
}

func applyPlan(root string, patches []filePatch) error {
	type prepared struct {
		path string
		data []byte
		mode os.FileMode
	}
	ready := make([]prepared, 0, len(patches))
	for _, patch := range patches {
		path := filepath.Join(root, patch.path)
		data, errRead := os.ReadFile(path)
		if errRead != nil {
			return fmt.Errorf("read %s: %w", patch.path, errRead)
		}
		info, errStat := os.Stat(path)
		if errStat != nil {
			return errStat
		}
		source := string(data)
		for _, edit := range patch.edits {
			var errReplace error
			source, errReplace = replaceExact(source, edit)
			if errReplace != nil {
				return fmt.Errorf("patch %s: %w", patch.path, errReplace)
			}
		}
		formatted, errFormat := format.Source([]byte(source))
		if errFormat != nil {
			return fmt.Errorf("format %s: %w", patch.path, errFormat)
		}
		ready = append(ready, prepared{path, formatted, info.Mode()})
	}
	// Validate every file before writing any: an upstream drift fails closed.
	for _, file := range ready {
		if errWrite := os.WriteFile(file.path, file.data, file.mode); errWrite != nil {
			return errWrite
		}
	}
	return nil
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: patch-cpa UPSTREAM_ROOT")
		os.Exit(64)
	}
	if errPatch := applyPlan(os.Args[1], plans()); errPatch != nil {
		fmt.Fprintln(os.Stderr, errPatch)
		os.Exit(1)
	}
	fmt.Println("Applied all sub2api background activity hooks and capability marker")
}
