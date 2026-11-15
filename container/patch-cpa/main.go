// Command patch-cpa checks public route compatibility and adds narrow lifecycle
// and frontend-authentication hooks. Every source anchor must match exactly once
// before any file is written. Upstream drift stops the image build for review.
package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
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
			path: "sdk/access/manager.go",
			edits: []replacement{
				{`\tproviders := m.Providers()
\tif len(providers) == 0 {
\t\treturn nil, nil
\t}`, `\tproviders := m.Providers()
\tif len(providers) == 0 {
\t\t// An empty effective provider set must not admit stale keys during
\t\t// config persistence or a failed frontend-auth plugin startup.
\t\treturn nil, NewNoCredentialsError()
\t}`},
			},
		},
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
			path: "sdk/cliproxy/service_lifecycle.go",
			edits: []replacement{
				{`"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"`, `"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"` + "\n\t" + helperImport},
				{`func (s *Service) Run(ctx context.Context) error {
\tif s == nil {
\t\treturn fmt.Errorf("cliproxy: service is nil")
\t}`, `func (s *Service) Run(ctx context.Context) error {
\tif s == nil {
\t\treturn fmt.Errorf("cliproxy: service is nil")
\t}
\tinitializationGeneration := sub2apiactivity.BeginInitialization()
\tdefer sub2apiactivity.EndInitialization(initializationGeneration)`},
				{`\tdefer func() {
\t\tshutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)`, `\tdefer func() {
\t\tsub2apiactivity.EndInitialization(initializationGeneration)
\t\tshutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)`},
				{`\ts.registerModelRefreshCallback()
\tif !homeEnabled {
\t\tgo s.runAntigravityModelRefresh(ctx)
\t}

\tselect {`, `\ts.registerModelRefreshCallback()
\tif !homeEnabled {
\t\tgo s.runAntigravityModelRefresh(ctx)
\t}

\t// HTTP liveness precedes watcher startup and OAuth model registration.
\t// Never admit inference until bootstrap completes; an empty configured
\t// model set is still a completed initialization, not an endless wait.
\tif errContext := ctx.Err(); errContext != nil {
\t\treturn errContext
\t}
\tsub2apiactivity.MarkInitialized(initializationGeneration)

\tselect {`},
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
\t\tc.JSON(http.StatusOK, gin.H{"activity_protocol": 1, "frontend_auth_protocol": 1, "initialization_protocol": 1, "initialization_ready": sub2apiactivity.Initialized()})
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
	if errPatch := patchUpstream(os.Args[1], plans()); errPatch != nil {
		fmt.Fprintln(os.Stderr, errPatch)
		os.Exit(1)
	}
	fmt.Println("Verified public API compatibility and applied sub2api lifecycle/authentication hooks")
}

// This is the registration surface implemented by src/api-routes.ts for CPA
// v8.0.67. Check methods/paths, not whole source files or handler implementations.
// New upstream releases may build automatically only while this contract holds.
const reviewedRoutes = `GET /v1/live/:call_id
GET /v1/models
GET /v1/models/*model
GET /v1/realtime
GET /v1/realtime/calls/:call_id
GET /v1/realtime/translations
GET /v1/responses
GET /v1/videos/:request_id
GET /v1/ws
GET /v1beta/models
GET /v1beta/models/*action
POST /v1/alpha/search
POST /v1/audio/speech
POST /v1/chat/completions
POST /v1/completions
POST /v1/images/edits
POST /v1/images/generations
POST /v1/live
POST /v1/messages
POST /v1/messages/count_tokens
POST /v1/realtime
POST /v1/realtime/calls
POST /v1/realtime/calls/:call_id/accept
POST /v1/realtime/calls/:call_id/hangup
POST /v1/realtime/calls/:call_id/refer
POST /v1/realtime/calls/:call_id/reject
POST /v1/realtime/client_secrets
POST /v1/realtime/sessions
POST /v1/realtime/transcription_sessions
POST /v1/realtime/translations
POST /v1/realtime/translations/client_secrets
POST /v1/responses
POST /v1/responses/compact
POST /v1/tts
POST /v1/videos
POST /v1/videos/edits
POST /v1/videos/extensions
POST /v1/videos/generations
POST /v1beta/interactions
POST /v1beta/models/*action`

func publicAPIPath(value string) bool {
	return value == "/v1" || strings.HasPrefix(value, "/v1/") || value == "/v1beta" || strings.HasPrefix(value, "/v1beta/")
}

func parsedSource(root, name string) (*ast.File, error) {
	file, err := parser.ParseFile(token.NewFileSet(), filepath.Join(root, name), nil, 0)
	if err != nil {
		return nil, fmt.Errorf("API compatibility: parse %s: %w", name, err)
	}
	return file, nil
}

func namedFunction(file *ast.File, name string) (*ast.FuncDecl, error) {
	var found *ast.FuncDecl
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Name.Name == name {
			if found != nil {
				return nil, fmt.Errorf("API compatibility: ambiguous function %s", name)
			}
			found = function
		}
	}
	if found == nil || found.Body == nil {
		return nil, fmt.Errorf("API compatibility: missing function %s", name)
	}
	return found, nil
}

type expressionBindings map[*ast.Object]ast.Expr

func functionBindings(function *ast.FuncDecl) expressionBindings {
	bindings := expressionBindings{}
	ast.Inspect(function.Body, func(node ast.Node) bool {
		assignment, ok := node.(*ast.AssignStmt)
		if ok && len(assignment.Lhs) == len(assignment.Rhs) {
			for i, left := range assignment.Lhs {
				if identifier, ok := left.(*ast.Ident); ok && identifier.Obj != nil {
					bindings[identifier.Obj] = assignment.Rhs[i]
				}
			}
		}
		return true
	})
	return bindings
}

func boundExpression(identifier *ast.Ident, bindings expressionBindings) ast.Expr {
	if identifier.Obj == nil {
		return nil
	}
	if value := bindings[identifier.Obj]; value != nil {
		return value
	}
	if declaration, ok := identifier.Obj.Decl.(*ast.ValueSpec); ok {
		for i, name := range declaration.Names {
			if name.Obj == identifier.Obj && i < len(declaration.Values) {
				return declaration.Values[i]
			}
		}
	}
	return nil
}

func literalString(expression ast.Expr, bindings expressionBindings, depth int) (string, bool) {
	if depth > 20 {
		return "", false
	}
	switch value := expression.(type) {
	case *ast.BasicLit:
		if value.Kind == token.STRING {
			text, err := strconv.Unquote(value.Value)
			return text, err == nil
		}
	case *ast.Ident:
		return literalString(boundExpression(value, bindings), bindings, depth+1)
	case *ast.BinaryExpr:
		if value.Op == token.ADD {
			left, leftOK := literalString(value.X, bindings, depth+1)
			right, rightOK := literalString(value.Y, bindings, depth+1)
			return left + right, leftOK && rightOK
		}
	}
	return "", false
}

func routerPrefix(expression ast.Expr, bindings expressionBindings, depth int) (string, bool) {
	if depth > 20 {
		return "", false
	}
	switch value := expression.(type) {
	case *ast.SelectorExpr:
		if value.Sel.Name == "engine" {
			return "", true
		}
	case *ast.Ident:
		return routerPrefix(boundExpression(value, bindings), bindings, depth+1)
	case *ast.CallExpr:
		selector, ok := value.Fun.(*ast.SelectorExpr)
		if !ok {
			break
		}
		if owner, ok := selector.X.(*ast.Ident); ok && owner.Name == "gin" && (selector.Sel.Name == "New" || selector.Sel.Name == "Default") {
			return "", true
		}
		if selector.Sel.Name == "Group" && len(value.Args) > 0 {
			base, baseOK := routerPrefix(selector.X, bindings, depth+1)
			suffix, suffixOK := literalString(value.Args[0], bindings, depth+1)
			if baseOK && suffixOK {
				return path.Join(base, suffix), true
			}
		}
	}
	return "", false
}

func isHTTPMethod(name string) bool {
	switch name {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE":
		return true
	}
	return false
}

func collectAPIRoutes(file *ast.File, routes map[string]bool) error {
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil || function.Name.Name == "AttachWebsocketRoute" {
			continue
		}
		bindings := functionBindings(function)
		var failure error
		ast.Inspect(function.Body, func(node ast.Node) bool {
			if failure != nil {
				return false
			}
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			method := selector.Sel.Name
			if method == "Group" && len(call.Args) > 0 {
				base, knownRouter := routerPrefix(selector.X, bindings, 0)
				_, knownPath := literalString(call.Args[0], bindings, 0)
				if knownRouter && (base == "" || publicAPIPath(base)) && !knownPath {
					failure = fmt.Errorf("API compatibility: unresolved router group in %s", function.Name.Name)
					return false
				}
			}
			if !isHTTPMethod(method) && method != "Any" && method != "Handle" && method != "Match" && !strings.HasPrefix(method, "Static") {
				return true
			}
			argument := 0
			if method == "Handle" || method == "Match" {
				argument = 1
			}
			if len(call.Args) <= argument {
				return true
			}
			base, knownRouter := routerPrefix(selector.X, bindings, 0)
			suffix, knownPath := literalString(call.Args[argument], bindings, 0)
			if !knownRouter {
				if knownPath && publicAPIPath(suffix) {
					failure = fmt.Errorf("API compatibility: unknown router for %s %s", method, suffix)
				}
				return true
			}
			if base != "" && !publicAPIPath(base) {
				return true
			}
			if !knownPath {
				failure = fmt.Errorf("API compatibility: unresolved %s route path in %s", method, function.Name.Name)
				return false
			}
			fullPath := path.Join(base, suffix)
			if !publicAPIPath(fullPath) {
				return true
			}
			if !isHTTPMethod(method) {
				failure = fmt.Errorf("API compatibility: review %s registration for %s", method, fullPath)
				return false
			}
			key := method + " " + fullPath
			if routes[key] {
				failure = fmt.Errorf("API compatibility: duplicate registration %s", key)
				return false
			}
			routes[key] = true
			return true
		})
		if failure != nil {
			return failure
		}
	}
	return nil
}

func compareSurface(label string, actual map[string]bool, expected []string) error {
	wanted := make(map[string]bool, len(expected))
	for _, entry := range expected {
		wanted[entry] = true
	}
	var differences []string
	for entry := range actual {
		if !wanted[entry] {
			differences = append(differences, "added "+entry)
		}
	}
	for entry := range wanted {
		if !actual[entry] {
			differences = append(differences, "removed "+entry)
		}
	}
	if len(differences) == 0 {
		return nil
	}
	sort.Strings(differences)
	return fmt.Errorf("API compatibility: %s changed (%s); review src/api-routes.ts and container/patch-cpa together", label, strings.Join(differences, "; "))
}

func checkGeminiActions(root string) error {
	file, err := parsedSource(root, "sdk/api/handlers/gemini/gemini_handlers.go")
	if err != nil {
		return err
	}
	function, err := namedFunction(file, "GeminiHandler")
	if err != nil {
		return err
	}
	actions := map[string]bool{}
	dispatchers := 0
	var failure error
	ast.Inspect(function.Body, func(node ast.Node) bool {
		statement, ok := node.(*ast.SwitchStmt)
		if !ok {
			return true
		}
		tag, ok := statement.Tag.(*ast.Ident)
		if !ok || tag.Name != "method" {
			return true
		}
		dispatchers++
		for _, branch := range statement.Body.List {
			clause := branch.(*ast.CaseClause)
			if len(clause.List) == 0 {
				failure = fmt.Errorf("API compatibility: review Gemini default action dispatch")
				continue
			}
			for _, expression := range clause.List {
				action, ok := literalString(expression, nil, 0)
				if !ok {
					failure = fmt.Errorf("API compatibility: unresolved Gemini action")
					continue
				}
				actions[action] = true
			}
		}
		return false
	})
	if failure != nil {
		return failure
	}
	if dispatchers != 1 {
		return fmt.Errorf("API compatibility: expected one Gemini method dispatcher, found %d", dispatchers)
	}
	return compareSurface("Gemini actions", actions, []string{"generateContent", "streamGenerateContent", "countTokens"})
}

func formattedNode(node ast.Node) string {
	var output bytes.Buffer
	if err := format.Node(&output, token.NewFileSet(), node); err != nil {
		return ""
	}
	return output.String()
}

func checkRelaySurface(root string) error {
	// The compiled binary has one SDK dynamic attachment. Reject additional or
	// unrecognized attachment/configurator calls instead of guessing their paths.
	attachments := 0
	for _, directory := range []string{"sdk/cliproxy", "cmd/server", "internal/cmd"} {
		files, err := filepath.Glob(filepath.Join(root, directory, "*.go"))
		if err != nil {
			return err
		}
		for _, name := range files {
			if strings.HasSuffix(name, "_test.go") {
				continue
			}
			file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
			if err != nil {
				return err
			}
			var failure error
			ast.Inspect(file, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				switch selector.Sel.Name {
				case "AttachWebsocketRoute":
					attachments++
					if formattedNode(call) != "s.server.AttachWebsocketRoute(s.wsGateway.Path(), s.wsGateway.Handler())" {
						failure = fmt.Errorf("API compatibility: unknown dynamic websocket attachment")
					}
				case "WithRouterConfigurator", "WithEngineConfigurator":
					failure = fmt.Errorf("API compatibility: review new router extension %s", selector.Sel.Name)
				}
				return true
			})
			if failure != nil {
				return failure
			}
		}
	}
	if attachments != 1 {
		return fmt.Errorf("API compatibility: expected one relay attachment, found %d", attachments)
	}
	for _, requirement := range []struct{ file, function, expression string }{
		{"sdk/cliproxy/service_auth.go", "ensureWebsocketGateway", `Path: "/v1/ws"`},
		{"internal/wsrelay/manager.go", "NewManager", `path = "/v1/ws"`},
		{"internal/wsrelay/manager.go", "Path", `return "/v1/ws"`},
		{"internal/api/server_routes.go", "AttachWebsocketRoute", `trimmed = "/v1/ws"`},
	} {
		file, err := parsedSource(root, requirement.file)
		if err != nil {
			return err
		}
		function, err := namedFunction(file, requirement.function)
		if err != nil {
			return err
		}
		matches := 0
		ast.Inspect(function.Body, func(node ast.Node) bool {
			if node != nil && formattedNode(node) == requirement.expression {
				matches++
			}
			return true
		})
		if matches != 1 {
			return fmt.Errorf("API compatibility: changed relay path in %s.%s", requirement.file, requirement.function)
		}
	}
	file, err := parsedSource(root, "internal/api/server_routes.go")
	if err != nil {
		return err
	}
	function, err := namedFunction(file, "AttachWebsocketRoute")
	if err != nil {
		return err
	}
	registrations := 0
	valid := true
	ast.Inspect(function.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || formattedNode(selector.X) != "s.engine" {
			return true
		}
		if isHTTPMethod(selector.Sel.Name) || selector.Sel.Name == "Handle" || selector.Sel.Name == "Any" || selector.Sel.Name == "Match" {
			registrations++
			valid = valid && formattedNode(call) == "s.engine.GET(trimmed, conditionalAuth, finalHandler)"
		}
		return true
	})
	if !valid || registrations != 1 {
		return fmt.Errorf("API compatibility: changed relay registration")
	}
	return nil
}

func validateAPISurface(root string) error {
	routes := map[string]bool{}
	files, err := filepath.Glob(filepath.Join(root, "internal/api", "*.go"))
	if err != nil {
		return err
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			return err
		}
		if err := collectAPIRoutes(file, routes); err != nil {
			return err
		}
	}
	if err := checkRelaySurface(root); err != nil {
		return err
	}
	routes["GET /v1/ws"] = true
	if err := compareSurface("registered routes", routes, strings.Split(reviewedRoutes, "\n")); err != nil {
		return err
	}
	return checkGeminiActions(root)
}

func patchUpstream(root string, patches []filePatch) error {
	if err := validateAPISurface(root); err != nil {
		return err
	}
	return applyPlan(root, patches)
}
