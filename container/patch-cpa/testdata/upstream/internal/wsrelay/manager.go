package wsrelay
func NewManager(opts Options) *Manager {
	path := strings.TrimSpace(opts.Path)
	if path == "" {
		path = "/v1/ws"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	mgr := &Manager{
		path:     path,
		sessions: make(map[string]*session),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
		providerFactory: opts.ProviderFactory,
		onConnected:     opts.OnConnected,
		onDisconnected:  opts.OnDisconnected,
		logDebugf:       opts.LogDebugf,
		logInfof:        opts.LogInfof,
		logWarnf:        opts.LogWarnf,
	}
	if mgr.logDebugf == nil {
		mgr.logDebugf = func(string, ...any) {}
	}
	if mgr.logInfof == nil {
		mgr.logInfof = func(string, ...any) {}
	}
	if mgr.logWarnf == nil {
		mgr.logWarnf = func(s string, args ...any) { fmt.Printf(s+"\n", args...) }
	}
	return mgr
}

func (m *Manager) Path() string {
	if m == nil {
		return "/v1/ws"
	}
	return m.path
}
