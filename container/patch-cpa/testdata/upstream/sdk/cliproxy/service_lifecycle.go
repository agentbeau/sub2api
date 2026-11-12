package cliproxy
func (s *Service) Run() {
 s.server.AttachWebsocketRoute(s.wsGateway.Path(), s.wsGateway.Handler())
}
