package api
func (s *Server) setupRoutes() {
	// OpenAI compatible API routes
	v1 := s.engine.Group("/v1")
	v1.Use(AuthMiddleware(s.accessManager))
	{
		v1.GET("/models", s.unifiedModelsHandler(openaiHandlers, claudeCodeHandlers))
		v1.GET("/models/*model", func(c *gin.Context) {
			c.Set(handlers.ModelDetailIDContextKey, strings.TrimPrefix(c.Param("model"), "/"))
			s.unifiedModelsHandler(openaiHandlers, claudeCodeHandlers)(c)
		})
		v1.POST("/chat/completions", openaiHandlers.ChatCompletions)
		v1.POST("/completions", openaiHandlers.Completions)
		v1.POST("/images/generations", openaiHandlers.ImagesGenerations)
		v1.POST("/images/edits", openaiHandlers.ImagesEdits)
		v1.POST("/videos", openaiHandlers.XAIVideosGenerations)
		v1.POST("/videos/generations", openaiHandlers.XAIVideosGenerations)
		v1.POST("/videos/edits", openaiHandlers.XAIVideosEdits)
		v1.POST("/videos/extensions", openaiHandlers.XAIVideosExtensions)
		v1.GET("/videos/:request_id", openaiHandlers.XAIVideosRetrieve)
		v1.POST("/audio/speech", openaiHandlers.AudioSpeech)
		v1.POST("/tts", openaiHandlers.XAITTS)
		v1.POST("/messages", claudeCodeHandlers.ClaudeMessages)
		v1.POST("/messages/count_tokens", claudeCodeHandlers.ClaudeCountTokens)
		v1.GET("/responses", openaiResponsesHandlers.ResponsesWebsocket)
		v1.POST("/responses", openaiResponsesHandlers.Responses)
		v1.POST("/responses/compact", openaiResponsesHandlers.Compact)
		v1.POST("/alpha/search", s.codexAlphaSearch)
		v1.POST("/live", s.codexLiveHandler.Handle)
		v1.GET("/live/:call_id", s.codexLiveHandler.HandleSideband)
	}

	realtimeAuth := realtimeAuthMiddleware(s.accessManager, s.codexLiveHandler)
	standardAuth := realtimeStandardAuthMiddleware(s.accessManager)
	s.engine.GET("/v1/realtime", realtimeAuth, s.codexLiveHandler.HandleRealtimeWebsocket)
	s.engine.POST("/v1/realtime", realtimeAuth, s.codexLiveHandler.Handle)
	s.engine.POST("/v1/realtime/calls", realtimeAuth, s.codexLiveHandler.Handle)
	s.engine.GET("/v1/realtime/calls/:call_id", realtimeAuth, s.codexLiveHandler.HandleSideband)
	s.engine.POST("/v1/realtime/client_secrets", standardAuth, s.codexLiveHandler.CreateClientSecret)
	s.engine.POST("/v1/realtime/sessions", standardAuth, s.codexLiveHandler.CreateLegacySession)
	s.engine.POST("/v1/realtime/transcription_sessions", standardAuth, s.codexLiveHandler.HandleTranscriptionSession)
	s.engine.GET("/v1/realtime/translations", realtimeAuth, s.codexLiveHandler.HandleTranslation)
	s.engine.POST("/v1/realtime/translations", realtimeAuth, s.codexLiveHandler.HandleTranslation)
	s.engine.POST("/v1/realtime/translations/client_secrets", standardAuth, s.codexLiveHandler.HandleTranslation)
	s.engine.POST("/v1/realtime/calls/:call_id/hangup", standardAuth, s.codexLiveHandler.HandleHangup)
	s.engine.POST("/v1/realtime/calls/:call_id/accept", standardAuth, s.codexLiveHandler.HandleSIPControl)
	s.engine.POST("/v1/realtime/calls/:call_id/reject", standardAuth, s.codexLiveHandler.HandleSIPControl)
	s.engine.POST("/v1/realtime/calls/:call_id/refer", standardAuth, s.codexLiveHandler.HandleSIPControl)

	openaiV1 := s.engine.Group("/openai/v1")
	openaiV1.Use(AuthMiddleware(s.accessManager))
	{
		openaiV1.POST("/videos", openaiHandlers.VideosCreate)
		openaiV1.GET("/videos/:video_id/content", openaiHandlers.VideosContent)
		openaiV1.GET("/videos/:video_id", openaiHandlers.VideosRetrieve)
	}

	// Codex CLI direct route aliases (chatgpt_base_url compatible)
	codexDirect := s.engine.Group("/backend-api/codex")
	codexDirect.Use(AuthMiddleware(s.accessManager))
	{
		codexDirect.GET("/responses", openaiResponsesHandlers.ResponsesWebsocket)
		codexDirect.POST("/responses", openaiResponsesHandlers.Responses)
		codexDirect.POST("/responses/compact", openaiResponsesHandlers.Compact)
		codexDirect.POST("/alpha/search", s.codexAlphaSearch)
	}

	// Gemini compatible API routes
	v1beta := s.engine.Group("/v1beta")
	v1beta.Use(AuthMiddleware(s.accessManager))
	{
		v1beta.GET("/models", s.geminiModelsHandler(geminiHandlers))
		v1beta.POST("/interactions", geminiHandlers.Interactions)
		v1beta.POST("/models/*action", geminiHandlers.GeminiHandler)
		v1beta.GET("/models/*action", s.geminiGetHandler(geminiHandlers))
	}

}

func (s *Server) AttachWebsocketRoute(path string, handler http.Handler) {
	if s == nil || s.engine == nil || handler == nil {
		return
	}
	if cfg := s.getConfig(); cfg != nil && cfg.Home.Enabled {
		return
	}
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		trimmed = "/v1/ws"
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/" + trimmed
	}
	s.wsRouteMu.Lock()
	if _, exists := s.wsRoutes[trimmed]; exists {
		s.wsRouteMu.Unlock()
		return
	}
	s.wsRoutes[trimmed] = struct{}{}
	s.wsRouteMu.Unlock()

	authMiddleware := AuthMiddleware(s.accessManager)
	conditionalAuth := func(c *gin.Context) {
		if !s.wsAuthEnabled.Load() {
			middleware.CaptureAuthenticatedRequestBody(c)
			if c.IsAborted() {
				return
			}
			c.Next()
			return
		}
		authMiddleware(c)
	}
	finalHandler := func(c *gin.Context) {
		handler.ServeHTTP(c.Writer, c.Request)
		c.Abort()
	}

	s.engine.GET(trimmed, conditionalAuth, finalHandler)
}
